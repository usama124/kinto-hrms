import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireSession, guard, ok, fail } from '@/lib/hrms/api-utils'
import { canApproveAttendanceAtStage } from '@/lib/hrms/rbac'
import { cleanText } from '@/lib/hrms/sanitize'
import { writeAudit } from '@/lib/hrms/audit'
import { clientIp } from '@/lib/hrms/rate-limit'

/** Reject — terminal at any stage (Admin fast-track applies; same authority rules as approval, see rbac.ts). */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return guard(async () => {
    const session = await requireSession()
    const { id } = await ctx.params
    const body = await req.json().catch(() => ({}))
    const comment = cleanText(body?.comment, 500) || null

    const request = await db.attendanceRequest.findUnique({ where: { id }, include: { user: true } })
    if (!request) return fail('Request not found.', 404)

    const gate = await canApproveAttendanceAtStage(session, request)
    if (!gate.allowed) return fail('Forbidden: you are not the approver at this stage.', 403)

    // compare-and-set so a concurrent approve/reject can't both win
    const claimed = await db.$transaction(async (tx) => {
      const c = await tx.attendanceRequest.updateMany({
        where: { id, status: request.status, currentStage: request.currentStage },
        data: { status: 'REJECTED', currentStage: 'DONE' },
      })
      if (c.count === 0) return false
      await tx.attendanceApproval.create({ data: { requestId: id, approverId: session.userId, level: gate.level!, action: 'REJECTED', comment } })
      return true
    })
    if (!claimed) return fail('This request was already actioned.', 409)

    const updated = await db.attendanceRequest.findUnique({ where: { id } })
    await db.notification.create({
      data: { userId: request.userId, title: 'Attendance request rejected', body: `Your regularization request for ${request.date} was rejected by ${session.fullName}.${comment ? ` Note: ${comment}` : ''}`, type: 'ALERT' },
    })
    await writeAudit({
      actorId: session.userId, actorName: session.fullName, actorRole: session.role,
      targetUserId: request.userId, targetName: request.user.fullName,
      entityType: 'ATTENDANCE_REQUEST', entityId: id,
      fieldName: 'status', oldValue: request.status, newValue: 'REJECTED',
      reason: comment ?? undefined, ipAddress: clientIp(req),
    })
    return ok({ request: updated, stage: 'REJECTED' })
  })
}

export const dynamic = 'force-dynamic'
