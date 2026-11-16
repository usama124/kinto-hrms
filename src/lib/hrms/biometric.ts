import 'server-only'
import { createHmac, timingSafeEqual, createHash } from 'crypto'
import { db } from '@/lib/db'
import { applyPunches } from '@/lib/hrms/attendance-engine'

/**
 * ZKTeco K50 / ADMS PUSH protocol ingestion.
 *
 * Auth model (device-side):
 *   Header X-Device-Key : provisioned device API key
 *   Header X-Device-Ts  : unix millis (±5 min tolerance)
 *   Header X-Device-Sig : hex HMAC-SHA256(secret, `${ts}.${rawBody}`)
 * The key/secret are provisioned in Settings → biometric.device.
 *
 * Punch line formats accepted (ADMS `cdata`):
 *   "PIN=101\tTIME=2026-11-14 11:02:33\tSTATUS=0"
 *   "101\t2026-11-14 11:02:33\t0"
 *   GET query: ?PIN=101&TIME=...&STATUS=...
 * STATUS: 0=check-in 1=check-out 2/255=unknown (first/last punch semantics still applied).
 */

export type DeviceCreds = { key: string; secret: string; enabled: boolean }

export async function getDeviceCreds(): Promise<DeviceCreds> {
  const row = await db.setting.findUnique({ where: { key: 'biometric.device' } })
  if (!row) return { key: '', secret: '', enabled: false }
  try {
    const parsed = JSON.parse(row.value) as DeviceCreds & { sn?: string; model?: string }
    return { key: parsed.key ?? '', secret: parsed.secret ?? '', enabled: parsed.enabled ?? false }
  } catch {
    return { key: '', secret: '', enabled: false } // malformed setting → ingestion off, not a 500
  }
}

/** Constant-time string compare (hashing first makes the lengths equal). */
const safeEqual = (a: string, b: string) =>
  timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest())

/** `body` MUST be the exact raw bytes the device signed (never a re-serialised copy). */
export function verifyDeviceAuth(creds: DeviceCreds, key: string | null, ts: string | null, sig: string | null, body: string): { ok: boolean; reason?: string } {
  if (!creds.enabled || !creds.key || !creds.secret) return { ok: false, reason: 'Biometric ingestion disabled' }
  if (!key || !safeEqual(key, creds.key)) return { ok: false, reason: 'Unknown device key' }
  if (!ts || !sig) return { ok: false, reason: 'Missing signature headers' }
  const tsNum = Number(ts)
  if (!Number.isFinite(tsNum) || Math.abs(Date.now() - tsNum) > 5 * 60_000) return { ok: false, reason: 'Stale timestamp' }
  const expected = createHmac('sha256', creds.secret).update(`${ts}.${body}`).digest('hex')
  if (!safeEqual(expected, sig)) return { ok: false, reason: 'Bad HMAC signature' }
  return { ok: true }
}

export type ParsedPunch = { pin: string; ts: Date; status: number | null; raw: string }

export function parsePunchPayload(text: string): ParsedPunch[] {
  const out: ParsedPunch[] = []
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 5000) // hard cap per request
  for (const line of lines) {
    let pin: string | null = null
    let timeStr: string | null = null
    let status: number | null = null

    if (line.includes('=')) {
      for (const part of line.split(/[\t&]/)) {
        const [k, v] = part.split('=', 2)
        if (!v) continue
        const key = k.trim().toUpperCase()
        if (key === 'PIN') pin = v.trim()
        else if (key === 'TIME') timeStr = v.trim()
        else if (key === 'STATUS') status = Number(v.trim())
      }
    } else {
      const parts = line.split('\t').map((p) => p.trim()).filter(Boolean)
      if (parts.length >= 2) {
        pin = parts[0]
        timeStr = parts[1]
        status = parts.length >= 3 ? Number(parts[2]) : null
      }
    }
    if (!pin || !timeStr) continue
    const ts = parseDeviceTimestamp(timeStr)
    if (!ts) continue
    out.push({ pin, ts, status: Number.isFinite(status as number) ? status : null, raw: line })
  }
  return out
}

function parseDeviceTimestamp(s: string): Date | null {
  // "YYYY-MM-DD HH:mm:ss" (device local, Karachi) or ISO
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/)
  if (m) {
    const [, y, mo, d, h, mi, se] = m
    return new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h) - 5, Number(mi), Number(se ?? 0)))
  }
  const iso = new Date(s)
  return Number.isNaN(iso.getTime()) ? null : iso
}

/** Dedup + persist punches, then rebuild attendance records for touched days. */
export async function ingestPunches(
  punches: ParsedPunch[],
  deviceSn: string | null,
  ip: string | null,
): Promise<{ stored: number; duplicates: number; daysRebuilt: number; unknownPins: number; rejected: number }> {
  // Device clocks drift a little, but a punch dated in the future is never legitimate — it would pre-fill attendance.
  const limit = Date.now() + 10 * 60_000
  const valid = punches.filter((p) => p.ts.getTime() <= limit)
  const rejected = punches.length - valid.length

  // 3 queries for the whole batch instead of 3 per punch; createMany(skipDuplicates) also makes a
  // concurrent identical push race-safe (the dedupHash unique index decides, no 500).
  const users = await db.user.findMany({
    where: { employeeCode: { in: Array.from(new Set(valid.map((p) => p.pin))) }, isActive: true },
    select: { id: true, employeeCode: true },
  })
  const idByPin = new Map(users.map((u) => [u.employeeCode, u.id]))

  let unknownPins = 0
  let duplicates = 0
  const seen = new Set<string>()
  const rows: { pin: string; userId: string; ts: Date; status: number | null; deviceSn: string | null; ip: string | null; raw: string; dedupHash: string; processed: boolean }[] = []
  for (const p of valid) {
    const userId = idByPin.get(p.pin)
    if (!userId) { unknownPins++; continue }
    const dedupHash = createHash('sha256').update(`${p.pin}|${p.ts.toISOString()}|${p.status ?? ''}`).digest('hex')
    if (seen.has(dedupHash)) { duplicates++; continue }
    seen.add(dedupHash)
    rows.push({ pin: p.pin, userId, ts: p.ts, status: p.status, deviceSn, ip, raw: p.raw.slice(0, 500), dedupHash, processed: true })
  }

  const known = rows.length
    ? new Set((await db.biometricPunch.findMany({ where: { dedupHash: { in: rows.map((r) => r.dedupHash) } }, select: { dedupHash: true } })).map((r) => r.dedupHash))
    : new Set<string>()
  const fresh = rows.filter((r) => !known.has(r.dedupHash))
  duplicates += rows.length - fresh.length
  const created = fresh.length ? await db.biometricPunch.createMany({ data: fresh, skipDuplicates: true }) : { count: 0 }
  duplicates += fresh.length - created.count

  const result = fresh.length ? await applyPunches(fresh.map((r) => ({ pin: r.pin, ts: r.ts, status: r.status })), 'BIOMETRIC') : { days: 0 }
  return { stored: created.count, duplicates, daysRebuilt: result.days, unknownPins, rejected }
}
