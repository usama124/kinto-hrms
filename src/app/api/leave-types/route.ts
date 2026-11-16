import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireSession, guard, ok, fail } from '@/lib/hrms/api-utils'
import { isOrgAdmin } from '@/lib/hrms/constants'
import { cleanText } from '@/lib/hrms/sanitize'
import { writeAudit } from '@/lib/hrms/audit'
import { clientIp } from '@/lib/hrms/rate-limit'
import { todayKey } from '@/lib/hrms/dates'

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
      if (users.length) await tx.leaveBalance.createMany({ data: users.map((u) => ({ userId: u.id, leaveTypeId: lt.id, year })), skipDuplicates: true })
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

export const dynamic = 'force-dynamic'
