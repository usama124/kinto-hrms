import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireSession, guard, ok, fail } from '@/lib/hrms/api-utils'
import { ROLES } from '@/lib/hrms/constants'
import { cleanNumber, cleanText } from '@/lib/hrms/sanitize'
import { writeAudit } from '@/lib/hrms/audit'
import { clientIp } from '@/lib/hrms/rate-limit'

/**
 * Manual quota increment — SUPER_ADMIN only (logged in audit_logs).
 * Positive delta increments carryForward; negative deltas are capped so balances never go negative.
 */
export async function POST(req: NextRequest) {
  return guard(async () => {
    const session = await requireSession()
    if (session.role !== ROLES.SUPER_ADMIN) {
      return fail('Forbidden: only the System Admin may adjust leave quotas.', 403)
    }

    const body = await req.json().catch(() => null)
    const userId = String(body?.userId ?? '')
    const leaveTypeId = String(body?.leaveTypeId ?? '')
    const delta = Math.trunc(cleanNumber(body?.delta, 0))
    const reason = cleanText(body?.reason, 300)
    if (!userId || !leaveTypeId || !delta || !reason) return fail('userId, leaveTypeId, non-zero delta and reason are required.', 422)

    const target = await db.user.findUnique({ where: { id: userId } })
    const leaveType = await db.leaveType.findUnique({ where: { id: leaveTypeId } })
    if (!target || !leaveType) return fail('Employee or leave type not found.', 404)

    const year = Number(body?.year) || new Date().getFullYear()
    const bal = await db.leaveBalance.findUnique({
      where: { userId_leaveTypeId_year: { userId, leaveTypeId, year } },
    })
    if (!bal) return fail('Leave balance record not found for this year.', 404)

    const available = bal.carryForward + leaveType.annualQuota - bal.availed - bal.pending - bal.lapsed
    const applied = delta < 0 ? Math.max(delta, -Math.floor(available)) : delta
    const updated = await db.leaveBalance.update({
      where: { id: bal.id },
      data: { carryForward: { increment: applied } },
    })

    await writeAudit({
      actorId: session.userId, actorName: session.fullName, actorRole: session.role,
      targetUserId: target.id, targetName: target.fullName,
      entityType: 'LEAVE_QUOTA', entityId: bal.id,
      fieldName: `carryForward (${leaveType.name} ${year})`,
      oldValue: String(bal.carryForward), newValue: String(updated.carryForward),
      reason, ipAddress: clientIp(req),
    })
    await db.notification.create({
      data: { userId: target.id, title: 'Leave quota updated', body: `${leaveType.name} quota adjusted by ${applied > 0 ? '+' : ''}${applied} day(s) by the System Admin.`, type: 'INFO' },
    })

    return ok({ balance: updated, appliedDelta: applied })
  })
}

export const dynamic = 'force-dynamic'
