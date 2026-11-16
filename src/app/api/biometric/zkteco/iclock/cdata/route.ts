import { NextRequest } from 'next/server'
import { guard, ok, fail } from '@/lib/hrms/api-utils'
import { getDevices, verifyDeviceAuth, parsePunchPayload, ingestPunches } from '@/lib/hrms/biometric'
import { guardRate, clientIp, RATE_LIMITS } from '@/lib/hrms/rate-limit'
import { writeAudit } from '@/lib/hrms/audit'

/**
 * ZKTeco ADMS endpoint — GET is the device handshake ("OK" + server options),
 * POST carries punch lines in the body (or query-string GET cdata).
 * Authenticated via device key + HMAC-SHA256 request signature.
 */
export async function GET(req: NextRequest) {
  const rl = guardRate(req, 'biometric', RATE_LIMITS.BIOMETRIC.max, RATE_LIMITS.BIOMETRIC.windowMs)
  if (!rl.ok) return new Response(`Rate limited`, { status: 429 })

  const devices = await getDevices()
  const qp = req.nextUrl.searchParams
  const key = qp.get('key') ?? req.headers.get('x-device-key')
  const ts = qp.get('ts') ?? req.headers.get('x-device-ts')
  const sig = qp.get('sig') ?? req.headers.get('x-device-sig')
  // The signature can't cover itself: sign the query string WITHOUT key/ts/sig, i.e. just the punch data.
  const body = req.nextUrl.search.slice(1).split('&').filter((p) => !/^(key|ts|sig)=/.test(p)).join('&')

  const auth = verifyDeviceAuth(devices, key, ts, sig, body)
  if (!auth.ok) return new Response('OK', { status: 200 }) // handshake ack; punches rejected below

  // Some devices push punches via GET query string
  const text = body
  if (text.includes('PIN=') || text.includes('pin=')) {
    const punches = parsePunchPayload(text)
    if (punches.length) {
      const result = await ingestPunches(punches, auth.device?.sn || qp.get('SN'), clientIp(req))
      await writeAudit({ entityType: 'SECURITY', reason: `ZKTeco GET ingestion: ${result.stored} punches (${result.duplicates} dup, ${result.unknownPins} unknown pins)`, ipAddress: clientIp(req) })
      return new Response(`OK:${result.stored}`, { status: 200 })
    }
  }
  return new Response('OK', { status: 200 })
}

export async function POST(req: NextRequest) {
  return guard(async () => {
    const ip = clientIp(req)
    const rl = guardRate(req, 'biometric', RATE_LIMITS.BIOMETRIC.max, RATE_LIMITS.BIOMETRIC.windowMs)
    if (!rl.ok) return fail(`Rate limited. Retry after ${rl.retryAfterSec}s.`, 429)

    const raw = await req.text()
    if (raw.length > 2 * 1024 * 1024) return fail('Payload too large.', 413)
    const devices = await getDevices()
    const key = req.headers.get('x-device-key')
    const ts = req.headers.get('x-device-ts')
    const sig = req.headers.get('x-device-sig')

    const auth = verifyDeviceAuth(devices, key, ts, sig, raw)
    if (!auth.ok) {
      await writeAudit({ entityType: 'SECURITY', reason: `Rejected biometric push: ${auth.reason}`, ipAddress: ip })
      return fail(`Device rejected: ${auth.reason}`, 401)
    }

    const punches = parsePunchPayload(raw)
    if (!punches.length) return fail('No parsable punch lines found in payload.', 422)

    const result = await ingestPunches(punches, auth.device?.sn || req.nextUrl.searchParams.get('SN'), ip)
    await writeAudit({
      entityType: 'SECURITY',
      reason: `ZKTeco K50 sync: ${result.stored} new punches, ${result.duplicates} duplicates, ${result.rejected} rejected, ${result.daysRebuilt} day(s) rebuilt, ${result.unknownPins} unknown PIN(s)`,
      ipAddress: ip,
    })
    return ok({ ...result })
  })
}

export const dynamic = 'force-dynamic'
