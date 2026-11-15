import { NextRequest } from 'next/server'
import { guard, ok, fail } from '@/lib/hrms/api-utils'
import { getDeviceCreds, verifyDeviceAuth, parsePunchPayload, ingestPunches, type ParsedPunch } from '@/lib/hrms/biometric'
import { guardRate, RATE_LIMITS } from '@/lib/hrms/rate-limit'
import { getSession } from '@/lib/auth'
import { writeAudit } from '@/lib/hrms/audit'

/**
 * Batch JSON sync endpoint — for middleware integrations.
 * Accepts EITHER device HMAC headers OR an authenticated SUPER_ADMIN/HR session
 * (used by the in-app simulator). Payload: { punches: [{ pin, timestamp, status }] }
 */
export async function POST(req: NextRequest) {
  return guard(async () => {
    const rl = guardRate(req, 'biometric', RATE_LIMITS.BIOMETRIC.max, RATE_LIMITS.BIOMETRIC.windowMs)
    if (!rl.ok) return fail(`Rate limited. Retry after ${rl.retryAfterSec}s.`, 429)

    const body = await req.json().catch(() => null)
    const rawPunches: { pin: string; timestamp: string; status?: number }[] = body?.punches
    if (!Array.isArray(rawPunches) || rawPunches.length === 0) return fail('punches[] required.', 422)

    // Device HMAC path
    const creds = await getDeviceCreds()
    const bodyText = JSON.stringify(body)
    const deviceAuth = verifyDeviceAuth(creds, req.headers.get('x-device-key'), req.headers.get('x-device-ts'), req.headers.get('x-device-sig'), bodyText)

    // Session fallback (SUPER_ADMIN / HR only)
    let sessionAllowed = false
    if (!deviceAuth.ok) {
      const session = await getSession()
      sessionAllowed = Boolean(session && (session.role === 'SUPER_ADMIN' || session.role === 'HR_MANAGER'))
      if (!sessionAllowed) return fail(`Device rejected: ${deviceAuth.reason}`, 401)
    }

    const parsed: ParsedPunch[] = []
    for (const p of rawPunches.slice(0, 2000)) {
      if (!p?.pin || !p?.timestamp) continue
      const ts = new Date(p.timestamp)
      if (Number.isNaN(ts.getTime())) continue
      parsed.push({ pin: String(p.pin), ts, status: typeof p.status === 'number' ? p.status : null, raw: JSON.stringify(p) })
    }
    if (!parsed.length) return fail('No valid punches in payload.', 422)

    const result = await ingestPunches(parsed, creds.key ? 'CJ7T201660772' : null, req.headers.get('x-forwarded-for') ?? null)
    await writeAudit({
      entityType: 'SECURITY',
      reason: `Batch biometric sync: ${result.stored} stored, ${result.duplicates} duplicates, ${result.daysRebuilt} day(s) rebuilt, ${result.unknownPins} unknown PIN(s)`,
      ipAddress: req.headers.get('x-forwarded-for') ?? null,
    })
    return ok({ ...result })
  })
}

export const dynamic = 'force-dynamic'
