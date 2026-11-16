import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireSession, guard, ok, fail } from '@/lib/hrms/api-utils'
import { isOrgAdmin } from '@/lib/hrms/constants'
import { cleanText } from '@/lib/hrms/sanitize'
import { writeAudit } from '@/lib/hrms/audit'
import { clientIp } from '@/lib/hrms/rate-limit'
import { todayKey } from '@/lib/hrms/dates'
import { createManySkipDuplicates } from '@/lib/hrms/db-compat'

/** Add a leave type (Admin / HR). Every active employee immediately gets this year's balance row for it. */
export async function POST(req: NextRequest) {
  return guard(async () => {
    const session = await requireSession()
    if (!isOrgAdmin(session.role)) return fail('Forbidden: only Admin / HR can add leave types.', 403)
    const body = await req.json().catch(() => null)
    const name = cleanText(body?.name, 40)
    const code = String(body?.code ?? '').trim().toUpperCase()
    const annualQuota = Number(body?.annualQuota)
    const colorCode = /^#[0-9a-fA-F]{6}$/.test(String(body?.colorCode ?? '')) ? String(body.colorCode) : '#64748B'
    const cap = (v: unknown) => (v == null || v === '' ? null : Math.floor(Number(v)))
    const monthlyCap = cap(body?.monthlyCap), attachmentThreshold = cap(body?.attachmentThreshold)

    if (name.length < 2) return fail('Leave type name is required.', 422)
    if (!/^[A-Z0-9_]{2,12}$/.test(code)) return fail('Code must be 2–12 characters: letters, digits or underscore.', 422)
    if (!Number.isFinite(annualQuota) || annualQuota < 0 || annualQuota > 365) return fail('Annual quota must be between 0 and 365.', 422)
    for (const c of [monthlyCap, attachmentThreshold]) {
      if (c !== null && (!Number.isFinite(c) || c < 1 || c > 31)) return fail('Monthly cap / certificate threshold must be 1–31 days (or empty).', 422)
    }
    if (await db.leaveType.findFirst({ where: { OR: [{ name }, { code }] }, select: { id: true } })) return fail('A leave type with this name or code already exists.', 409)

    const year = Number(todayKey().slice(0, 4))
    const created = await db.$transaction(async (tx) => {
      const lt = await tx.leaveType.create({ data: { name, code, annualQuota, colorCode, isPaid: body?.isPaid !== false, monthlyCap, attachmentThreshold } })
      const users = await tx.user.findMany({ where: { isActive: true }, select: { id: true } })
      if (users.length) await createManySkipDuplicates(tx.leaveBalance as never, users.map((u) => ({ userId: u.id, leaveTypeId: lt.id, year })))
      return lt
    }, { timeout: 30_000 })

    await writeAudit({
      actorId: session.userId, actorName: session.fullName, actorRole: session.role,
      entityType: 'RULE', entityId: created.id, fieldName: 'leaveType.added', newValue: `${name} (${code}) · ${annualQuota} days/yr${created.isPaid ? '' : ' · unpaid'}`,
      reason: 'Leave type added', ipAddress: clientIp(req),
    })
    return ok({ leaveType: created }, { status: 201 })
  })
}

/**
 * Edit a leave type (Admin / HR): name, colour, paid/unpaid, annual quota, monthly cap, certificate threshold.
 * The CODE is deliberately immutable — payroll finds CASUAL / ANNUAL by code to convert short hours into leave days.
 * A paid/unpaid change applies to payroll runs created afterwards; finalized payslips are snapshots and stay as they were.
 */
export async function PATCH(req: NextRequest) {
  return guard(async () => {
    const session = await requireSession()
    if (!isOrgAdmin(session.role)) return fail('Forbidden: only Admin / HR can edit leave types.', 403)
    const body = await req.json().catch(() => null)
    const cur = await db.leaveType.findUnique({ where: { id: String(body?.id ?? '') } })
    if (!cur) return fail('Leave type not found.', 404)

    const data: { name?: string; colorCode?: string; isPaid?: boolean; annualQuota?: number; monthlyCap?: number | null; attachmentThreshold?: number | null } = {}
    if (body.name !== undefined) {
      const name = cleanText(body.name, 40)
      if (name.length < 2) return fail('Leave type name is required.', 422)
      if (name !== cur.name) {
        if (await db.leaveType.findFirst({ where: { name, NOT: { id: cur.id } }, select: { id: true } })) return fail('Another leave type already has this name.', 409)
        data.name = name
      }
    }
    if (body.colorCode !== undefined) {
      if (!/^#[0-9a-fA-F]{6}$/.test(String(body.colorCode))) return fail('Colour must be a hex value like #0D9488.', 422)
      data.colorCode = String(body.colorCode)
    }
    if (body.isPaid !== undefined) data.isPaid = Boolean(body.isPaid)
    if (body.annualQuota !== undefined) {
      const q = Number(body.annualQuota)
      if (!Number.isFinite(q) || q < 0 || q > 365) return fail('Annual quota must be between 0 and 365.', 422)
      data.annualQuota = q
    }
    for (const f of ['monthlyCap', 'attachmentThreshold'] as const) {
      if (body[f] === undefined) continue
      const v = body[f] === null || body[f] === '' ? null : Math.floor(Number(body[f]))
      if (v !== null && (!Number.isFinite(v) || v < 1 || v > 31)) return fail('Monthly cap / certificate threshold must be 1–31 days (or empty).', 422)
      data[f] = v
    }

    const changes = (Object.keys(data) as (keyof typeof data)[]).filter((k) => data[k] !== cur[k])
    if (!changes.length) return fail('No changes provided.', 422)
    const updated = await db.leaveType.update({ where: { id: cur.id }, data })
    await writeAudit({
      actorId: session.userId, actorName: session.fullName, actorRole: session.role,
      entityType: 'RULE', entityId: cur.id, fieldName: 'leaveType.updated',
      oldValue: changes.map((k) => `${k}=${cur[k]}`).join('; '), newValue: changes.map((k) => `${k}=${updated[k]}`).join('; '),
      reason: `Leave type “${cur.name}” updated`, ipAddress: clientIp(req),
    })
    return ok({ leaveType: updated })
  })
}

export const dynamic = 'force-dynamic'
