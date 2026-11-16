import { NextRequest } from 'next/server'
import { guard, ok, fail } from '@/lib/hrms/api-utils'
import { getDeviceCreds, verifyDeviceAuth, ingestPunches, type ParsedPunch } from '@/lib/hrms/biometric'
import { guardRate, clientIp, RATE_LIMITS } from '@/lib/hrms/rate-limit'
import { getSession } from '@/lib/auth'
import { isOrgAdmin } from '@/lib/hrms/constants'
import { writeAudit } from '@/lib/hrms/audit'

/**
 * Batch JSON sync endpoint — for middleware integrations.
 * Accepts EITHER device HMAC headers OR an authenticated SUPER_ADMIN/HR session
 * (used by the in-app simulator). Payload: { punches: [{ pin, timestamp, status }] }
 * The HMAC covers the RAW request body exactly as sent (not a re-serialised copy).
 */
export async function POST(req: NextRequest) {
  return guard(async () => {
    const ip = clientIp(req)
    const rl = guardRate(req, 'biometric', RATE_LIMITS.BIOMETRIC.max, RATE_LIMITS.BIOMETRIC.windowMs)
    if (!rl.ok) return fail(`Rate limited. Retry after ${rl.retryAfterSec}s.`, 429)

    const raw = await req.text()
    if (raw.length > 2 * 1024 * 1024) return fail('Payload too large.', 413)

    // Device HMAC path — authenticate BEFORE parsing anything
    const creds = await getDeviceCreds()
    const deviceAuth = verifyDeviceAuth(creds, req.headers.get('x-device-key'), req.headers.get('x-device-ts'), req.headers.get('x-device-sig'), raw)

    // Session fallback (SUPER_ADMIN / HR only, MFA enrolled)
    if (!deviceAuth.ok) {
      const session = await getSession()
      const sessionAllowed = Boolean(session && !session.mfaPending && isOrgAdmin(session.role))
      if (!sessionAllowed) return fail(`Device rejected: ${deviceAuth.reason}`, 401)
    }

    let body: { punches?: { pin: string; timestamp: string; status?: number }[] } | null = null
    try { body = JSON.parse(raw) } catch { /* handled below */ }
    const rawPunches = body?.punches
    if (!Array.isArray(rawPunches) || rawPunches.length === 0) return fail('punches[] required.', 422)

    const parsed: ParsedPunch[] = []
    for (const p of rawPunches.slice(0, 2000)) {
      if (!p?.pin || !p?.timestamp) continue
      const ts = new Date(p.timestamp)
      if (Number.isNaN(ts.getTime())) continue
      parsed.push({ pin: String(p.pin).slice(0, 32), ts, status: typeof p.status === 'number' && Number.isInteger(p.status) ? p.status : null, raw: JSON.stringify(p) })
    }
    if (!parsed.length) return fail('No valid punches in payload.', 422)

    const result = await ingestPunches(parsed, creds.key ? 'CJ7T201660772' : null, ip)
    await writeAudit({
      entityType: 'SECURITY',
      reason: `Batch biometric sync: ${result.stored} stored, ${result.duplicates} duplicates, ${result.rejected} rejected, ${result.daysRebuilt} day(s) rebuilt, ${result.unknownPins} unknown PIN(s)`,
      ipAddress: ip,
    })
    return ok({ ...result })
  })
}

export const dynamic = 'force-dynamic'
