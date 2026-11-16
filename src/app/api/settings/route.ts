import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireSession, guard, ok, fail } from '@/lib/hrms/api-utils'
import { ROLES } from '@/lib/hrms/constants'
import { writeAudit } from '@/lib/hrms/audit'
import { cleanText } from '@/lib/hrms/sanitize'
import { clientIp } from '@/lib/hrms/rate-limit'

const MASK = '••••••••'
type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** Company / payroll / device settings. Read for admins+accountant (device credentials are never returned), write SUPER_ADMIN only. */
export async function GET() {
  return guard(async () => {
    const session = await requireSession()
    const rows = await db.setting.findMany()
    const map: Record<string, unknown> = {}
    for (const r of rows) {
      try { map[r.key] = JSON.parse(r.value) } catch { map[r.key] = r.value }
    }
    const privileged = ([ROLES.SUPER_ADMIN, ROLES.HR_MANAGER, ROLES.ACCOUNTANT, ROLES.ACCOUNTS_MANAGER] as string[]).includes(session.role)
    if (!privileged) {
      // employees only see company identity
      return ok({ settings: { 'company.profile': map['company.profile'] ?? null } })
    }
    // The device key + HMAC secret together let anyone forge attendance punches: never send them to the browser.
    // The System Admin sees that they are set (and can replace them via PATCH); everyone else sees status only.
    const dev = map['biometric.device']
    if (isObj(dev)) {
      map['biometric.device'] = {
        model: dev.model, sn: dev.sn, enabled: dev.enabled,
        key: session.role === ROLES.SUPER_ADMIN && typeof dev.key === 'string' ? dev.key : MASK,
        secret: MASK, secretSet: Boolean(dev.secret),
      }
    }
    return ok({ settings: map })
  })
}

/** Validate + normalise one setting. Returns the value to store, or an error string. */
function validate(key: string, raw: unknown, existing: Obj | null): { value: unknown } | { error: string } {
  if (!isObj(raw)) return { error: 'value must be an object.' }
  switch (key) {
    case 'company.profile': {
      const out: Obj = {}
      for (const [k, v] of Object.entries(raw).slice(0, 20)) {
        if (!/^[A-Za-z][A-Za-z0-9]{0,30}$/.test(k)) return { error: `Invalid field name "${k}".` }
        if (typeof v !== 'string') return { error: `${k} must be text.` }
        out[k] = cleanText(v, 200)
      }
      if (!out.name) return { error: 'Company name is required.' }
      return { value: out }
    }
    case 'payroll.config': {
      const pfRate = num(raw.pfRate), eoobiAmount = num(raw.eoobiAmount), eoobiThreshold = num(raw.eoobiThreshold)
      if (pfRate === null || pfRate < 0 || pfRate > 1) return { error: 'pfRate must be a fraction between 0 and 1.' }
      if (eoobiAmount === null || eoobiAmount < 0) return { error: 'eoobiAmount must be ≥ 0.' }
      if (eoobiThreshold === null || eoobiThreshold < 0) return { error: 'eoobiThreshold must be ≥ 0.' }
      if (!Array.isArray(raw.taxSlabs) || raw.taxSlabs.length < 1 || raw.taxSlabs.length > 20) return { error: 'taxSlabs must have 1–20 entries.' }
      let prev = 0
      const slabs: { upto: number | null; rate: number }[] = []
      for (let i = 0; i < raw.taxSlabs.length; i++) {
        const s = raw.taxSlabs[i] as Obj
        const rate = isObj(s) ? num(s.rate) : null
        const upto = isObj(s) ? (s.upto === null ? null : num(s.upto)) : undefined
        if (rate === null || rate < 0 || rate > 100) return { error: `taxSlabs[${i}].rate must be 0–100.` }
        if (upto === undefined || (upto !== null && upto <= prev)) return { error: `taxSlabs[${i}].upto must be a number greater than the previous slab.` }
        if (upto === null && i !== raw.taxSlabs.length - 1) return { error: 'Only the last slab may be open-ended (upto: null).' }
        if (upto !== null) prev = upto
        slabs.push({ upto, rate })
      }
      return { value: { pfRate, eoobiAmount, eoobiThreshold, taxSlabs: slabs } }
    }
    case 'biometric.device': {
      const k = typeof raw.key === 'string' ? raw.key.trim() : ''
      if (k.length < 8 || k.length > 100 || k === MASK) return { error: 'Device key must be 8–100 characters.' }
      // MASK / empty = keep the stored secret; a new secret must be strong enough to be an HMAC key
      const incoming = typeof raw.secret === 'string' ? raw.secret : ''
      const secret = incoming === '' || incoming === MASK ? String(existing?.secret ?? '') : incoming
      if (secret.length < 16 || secret.length > 200) return { error: 'Device secret must be 16–200 characters.' }
      return { value: { key: k, secret, enabled: raw.enabled === true, model: cleanText(raw.model, 60), sn: cleanText(raw.sn, 60) } }
    }
    case 'app.demo':
      return { value: { mode: raw.mode === true } }
    default:
      return { error: 'Unknown setting key.' }
  }
}

export async function PATCH(req: NextRequest) {
  return guard(async () => {
    const session = await requireSession()
    if (session.role !== ROLES.SUPER_ADMIN) return fail('Forbidden: only the System Admin can change global settings.', 403)
    const body = await req.json().catch(() => null)
    if (!body?.key) return fail('key required.', 422)
    const key = cleanText(body.key, 60)

    let parsed: unknown = body.value
    if (typeof parsed === 'string') { try { parsed = JSON.parse(parsed) } catch { return fail('value must be valid JSON.', 422) } }
    const row = await db.setting.findUnique({ where: { key } })
    let existing: Obj | null = null
    try { const p = row ? JSON.parse(row.value) : null; existing = isObj(p) ? p : null } catch { /* ignore */ }

    const checked = validate(key, parsed, existing)
    if ('error' in checked) return fail(checked.error, 422)
    const value = JSON.stringify(checked.value)
    await db.setting.upsert({ where: { key }, create: { key, value }, update: { value } })

    // never write credentials into the audit trail
    const auditValue = key === 'biometric.device' ? JSON.stringify({ ...(checked.value as Obj), secret: MASK, key: MASK }) : value
    await writeAudit({
      actorId: session.userId, actorName: session.fullName, actorRole: session.role,
      entityType: 'RULE', entityId: key, fieldName: 'setting', newValue: auditValue.slice(0, 500),
      reason: cleanText(body?.reason, 200) || 'Settings update', ipAddress: clientIp(req),
    })
    return ok({ ok: true })
  })
}

export const dynamic = 'force-dynamic'
