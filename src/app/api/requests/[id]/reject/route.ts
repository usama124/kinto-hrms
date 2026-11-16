import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireSession, guard, ok, fail } from '@/lib/hrms/api-utils'
import { canApproveLeaveAtStage } from '@/lib/hrms/rbac'
import { REQUEST_STATUS } from '@/lib/hrms/constants'
import { dayKey } from '@/lib/hrms/dates'
import { cleanText } from '@/lib/hrms/sanitize'
import { writeAudit } from '@/lib/hrms/audit'
import { clientIp } from '@/lib/hrms/rate-limit'

/**
 * Rejection — immediately terminal at ANY stage (single rejection stops the chain),
 * releases the pending balance reservation, notifies the requester.
 * Same authority rules as approval (rbac.ts). Status change, log and balance release are one
 * compare-and-set transaction, so a concurrent approve/reject can't both win or double-release.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return guard(async () => {
    const session = await requireSession()
    const { id } = await ctx.params
    const body = await req.json().catch(() => ({}))
    const comment = cleanText(body?.comment, 500) || null

    const request = await db.request.findUnique({ where: { id }, include: { user: true, leaveType: true } })
    if (!request) return fail('Request not found.', 404)

    const gate = await canApproveLeaveAtStage(session, request)
    if (!gate.allowed) return fail('Forbidden: you are not the approver at this stage.', 403)

    const claimed = await db.$transaction(async (tx) => {
      const c = await tx.request.updateMany({
        where: { id, status: request.status, currentStage: request.currentStage },
        data: { status: REQUEST_STATUS.REJECTED, currentStage: 'DONE' },
      })
      if (c.count === 0) return false
      await tx.approvalLog.create({ data: { requestId: id, approverId: session.userId, level: gate.level!, action: 'REJECTED', comment } })
      if (request.type === 'LEAVE' && request.leaveTypeId) {
        await tx.leaveBalance.updateMany({
          where: { userId: request.userId, leaveTypeId: request.leaveTypeId, year: Number(dayKey(request.startDate).slice(0, 4)) },
          data: { pending: { decrement: request.dayCount } },
        })
      }
      return true
    })
    if (!claimed) return fail('This request was already actioned.', 409)

    const updated = await db.request.findUnique({ where: { id }, include: { user: true, leaveType: true } })
    await db.notification.create({
      data: { userId: request.userId, title: 'Request rejected', body: `Your ${request.leaveType?.name ?? request.type} request was rejected by ${session.fullName}.${comment ? ` Note: ${comment}` : ''}`, type: 'ALERT' },
    })
    await writeAudit({
      actorId: session.userId, actorName: session.fullName, actorRole: session.role,
      targetUserId: request.userId, targetName: request.user.fullName,
      entityType: 'REQUEST', entityId: request.id,
      fieldName: 'status', oldValue: request.status, newValue: 'REJECTED',
      reason: comment ?? undefined, ipAddress: clientIp(req),
    })

    return ok({ request: updated, stage: 'REJECTED' })
  })
}

export const dynamic = 'force-dynamic'
