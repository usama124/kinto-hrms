import { NextRequest } from 'next/server'
import { randomBytes, randomUUID } from 'crypto'
import { db } from '@/lib/db'
import { requireSession, guard, ok, fail } from '@/lib/hrms/api-utils'
import { isOrgAdmin } from '@/lib/hrms/constants'
import { cleanText } from '@/lib/hrms/sanitize'
import { writeAudit } from '@/lib/hrms/audit'
import { clientIp } from '@/lib/hrms/rate-limit'
import { getDevices, saveDevices, type BiometricDevice } from '@/lib/hrms/biometric'

const MAX_DEVICES = 20

/** What the browser may see. The secret is NEVER returned here — only at creation / rotation. */
async function publicList(devices: BiometricDevice[]) {
  const stats = await db.biometricPunch.groupBy({ by: ['deviceSn'], _max: { createdAt: true }, _count: { _all: true } })
  const bySn = new Map(stats.map((s) => [s.deviceSn ?? '', s]))
  return devices.map((d) => {
    const s = d.sn ? bySn.get(d.sn) : undefined
    return {
      id: d.id, name: d.name, model: d.model, sn: d.sn, enabled: d.enabled, createdAt: d.createdAt || null,
      keyPreview: `${d.key.slice(0, 6)}••••`,
      lastPunchAt: s?._max.createdAt ?? null, punchCount: s?._count._all ?? 0,
    }
  })
}

const genKey = () => `dk_${randomBytes(12).toString('hex')}`
const genSecret = () => randomBytes(32).toString('hex')

export async function GET() {
  return guard(async () => {
    const session = await requireSession()
    if (!isOrgAdmin(session.role)) return fail('Forbidden: device management is Admin / HR only.', 403)
    return ok({ devices: await publicList(await getDevices()) })
  })
}

/** Register a device. Key + secret are generated here and shown ONCE in the response. */
export async function POST(req: NextRequest) {
  return guard(async () => {
    const session = await requireSession()
    if (!isOrgAdmin(session.role)) return fail('Forbidden: only Admin / HR can add devices.', 403)
    const body = await req.json().catch(() => null)
    const name = cleanText(body?.name, 60)
    const model = cleanText(body?.model, 60) || 'ZKTeco K50'
    const sn = cleanText(body?.sn, 40)
    if (name.length < 2) return fail('Device name is required.', 422)

    const devices = await getDevices()
    if (devices.length >= MAX_DEVICES) return fail(`Device limit reached (${MAX_DEVICES}).`, 422)
    if (devices.some((d) => d.name.toLowerCase() === name.toLowerCase())) return fail('A device with this name already exists.', 409)
    if (sn && devices.some((d) => d.sn && d.sn.toLowerCase() === sn.toLowerCase())) return fail('A device with this serial number already exists.', 409)

    const device: BiometricDevice = { id: randomUUID(), name, model, sn, key: genKey(), secret: genSecret(), enabled: true, createdAt: new Date().toISOString() }
    await saveDevices([...devices, device])
    await writeAudit({
      actorId: session.userId, actorName: session.fullName, actorRole: session.role,
      entityType: 'SECURITY', entityId: device.id, fieldName: 'device.added', newValue: `${name} (${model}${sn ? ` · ${sn}` : ''})`,
      reason: 'Biometric device registered', ipAddress: clientIp(req),
    })
    return ok({ device: (await publicList([device]))[0], credentials: { key: device.key, secret: device.secret } }, { status: 201, headers: { 'Cache-Control': 'no-store' } })
  })
}

/** Update name / model / serial, enable or disable, or rotate the secret (new secret shown once). */
export async function PATCH(req: NextRequest) {
  return guard(async () => {
    const session = await requireSession()
    if (!isOrgAdmin(session.role)) return fail('Forbidden: only Admin / HR can edit devices.', 403)
    const body = await req.json().catch(() => null)
    const devices = await getDevices()
    const idx = devices.findIndex((d) => d.id === String(body?.id ?? ''))
    if (idx < 0) return fail('Device not found.', 404)
    const cur = devices[idx]
    const next: BiometricDevice = { ...cur }
    const changes: string[] = []

    if (body.name !== undefined) {
      const name = cleanText(body.name, 60)
      if (name.length < 2) return fail('Device name is required.', 422)
      if (devices.some((d, i) => i !== idx && d.name.toLowerCase() === name.toLowerCase())) return fail('A device with this name already exists.', 409)
      if (name !== cur.name) { next.name = name; changes.push(`name ${cur.name} → ${name}`) }
    }
    if (body.model !== undefined) { next.model = cleanText(body.model, 60) || cur.model; if (next.model !== cur.model) changes.push('model') }
    if (body.sn !== undefined) {
      const sn = cleanText(body.sn, 40)
      if (sn && devices.some((d, i) => i !== idx && d.sn && d.sn.toLowerCase() === sn.toLowerCase())) return fail('A device with this serial number already exists.', 409)
      if (sn !== cur.sn) { next.sn = sn; changes.push(`serial ${cur.sn || '—'} → ${sn || '—'}`) }
    }
    if (body.enabled !== undefined && Boolean(body.enabled) !== cur.enabled) { next.enabled = Boolean(body.enabled); changes.push(next.enabled ? 'enabled' : 'disabled') }
    let newSecret: string | undefined
    if (body.rotateSecret === true) { newSecret = genSecret(); next.secret = newSecret; changes.push('secret rotated') }
    if (!changes.length) return fail('No changes provided.', 422)

    devices[idx] = next
    await saveDevices(devices)
    await writeAudit({
      actorId: session.userId, actorName: session.fullName, actorRole: session.role,
      entityType: 'SECURITY', entityId: cur.id, fieldName: 'device.updated', newValue: `${cur.name}: ${changes.join('; ')}`,
      reason: 'Biometric device updated', ipAddress: clientIp(req),
    })
    return ok({ device: (await publicList([next]))[0], ...(newSecret ? { credentials: { key: next.key, secret: newSecret } } : {}) }, { headers: { 'Cache-Control': 'no-store' } })
  })
}

export async function DELETE(req: NextRequest) {
  return guard(async () => {
    const session = await requireSession()
    if (!isOrgAdmin(session.role)) return fail('Forbidden: only Admin / HR can remove devices.', 403)
    const body = await req.json().catch(() => null)
    const devices = await getDevices()
    const target = devices.find((d) => d.id === String(body?.id ?? ''))
    if (!target) return fail('Device not found.', 404)
    await saveDevices(devices.filter((d) => d.id !== target.id)) // its punches stay: they are attendance history
    await writeAudit({
      actorId: session.userId, actorName: session.fullName, actorRole: session.role,
      entityType: 'SECURITY', entityId: target.id, fieldName: 'device.removed', oldValue: `${target.name} (${target.model}${target.sn ? ` · ${target.sn}` : ''})`,
      reason: 'Biometric device removed', ipAddress: clientIp(req),
    })
    return ok({ ok: true })
  })
}

export const dynamic = 'force-dynamic'
