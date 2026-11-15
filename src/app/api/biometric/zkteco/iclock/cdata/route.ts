import { NextRequest } from 'next/server'
import { guard, ok, fail } from '@/lib/hrms/api-utils'
import { getDeviceCreds, verifyDeviceAuth, parsePunchPayload, ingestPunches } from '@/lib/hrms/biometric'
import { guardRate, RATE_LIMITS } from '@/lib/hrms/rate-limit'
import { writeAudit } from '@/lib/hrms/audit'

/**
 * ZKTeco ADMS endpoint — GET is the device handshake ("OK" + server options),
 * POST carries punch lines in the body (or query-string GET cdata).
 * Authenticated via device key + HMAC-SHA256 request signature.
 */
export async function GET(req: NextRequest) {
  const rl = guardRate(req, 'biometric', RATE_LIMITS.BIOMETRIC.max, RATE_LIMITS.BIOMETRIC.windowMs)
  if (!rl.ok) return new Response(`Rate limited`, { status: 429 })

  const creds = await getDeviceCreds()
  const qp = req.nextUrl.searchParams
  const key = qp.get('key') ?? req.headers.get('x-device-key')
  const ts = qp.get('ts') ?? req.headers.get('x-device-ts')
  const sig = qp.get('sig') ?? req.headers.get('x-device-sig')
  const body = req.nextUrl.search.slice(1)

  const auth = verifyDeviceAuth(creds, key, ts, sig, body)
  if (!auth.ok) return new Response('OK', { status: 200 }) // handshake ack; punches rejected below

  // Some devices push punches via GET query string
  const text = body
  if (text.includes('PIN=') || text.includes('pin=')) {
    const punches = parsePunchPayload(text)
    if (punches.length) {
      const result = await ingestPunches(punches, qp.get('SN'), req.headers.get('x-forwarded-for') ?? null)
      await writeAudit({ entityType: 'SECURITY', reason: `ZKTeco GET ingestion: ${result.stored} punches (${result.duplicates} dup, ${result.unknownPins} unknown pins)`, ipAddress: req.headers.get('x-forwarded-for') ?? null })
      return new Response(`OK:${result.stored}`, { status: 200 })
    }
  }
  return new Response('OK', { status: 200 })
}

export async function POST(req: NextRequest) {
  return guard(async () => {
    const rl = guardRate(req, 'biometric', RATE_LIMITS.BIOMETRIC.max, RATE_LIMITS.BIOMETRIC.windowMs)
    if (!rl.ok) return fail(`Rate limited. Retry after ${rl.retryAfterSec}s.`, 429)

    const raw = await req.text()
    const creds = await getDeviceCreds()
    const key = req.headers.get('x-device-key')
    const ts = req.headers.get('x-device-ts')
    const sig = req.headers.get('x-device-sig')

    const auth = verifyDeviceAuth(creds, key, ts, sig, raw)
    if (!auth.ok) {
      await writeAudit({ entityType: 'SECURITY', reason: `Rejected biometric push: ${auth.reason}`, ipAddress: req.headers.get('x-forwarded-for') ?? null })
      return fail(`Device rejected: ${auth.reason}`, 401)
    }

    const punches = parsePunchPayload(raw)
    if (!punches.length) return fail('No parsable punch lines found in payload.', 422)

    const result = await ingestPunches(punches, req.nextUrl.searchParams.get('SN'), req.headers.get('x-forwarded-for') ?? null)
    await writeAudit({
      entityType: 'SECURITY',
      reason: `ZKTeco K50 sync: ${result.stored} new punches, ${result.duplicates} duplicates, ${result.daysRebuilt} day(s) rebuilt, ${result.unknownPins} unknown PIN(s)`,
      ipAddress: req.headers.get('x-forwarded-for') ?? null,
    })
    return ok({ ...result })
  })
}

export const dynamic = 'force-dynamic'
