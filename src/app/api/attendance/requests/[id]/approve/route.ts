import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireSession, guard, ok, fail } from '@/lib/hrms/api-utils'
import { canApproveAttendanceAtStage, nextStageOf } from '@/lib/hrms/rbac'
import { applyRegularizationToLog } from '@/lib/hrms/regularization'
import { cleanText } from '@/lib/hrms/sanitize'
import { writeAudit } from '@/lib/hrms/audit'

/**
 * Approve a regularization request. Chain: TEAM_LEAD → MANAGER → HR; org admins fast-track.
 * Final approval rewrites the day's attendance record from the requested times.
 * The stage is claimed atomically, so a double-click / concurrent approver can't apply it twice.
 */
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
    const level = gate.level!

    const next = level === 'ADMIN' ? null : nextStageOf('ATTENDANCE', request.user, request.currentStage)
    const claim = await db.attendanceRequest.updateMany({
      where: { id, status: request.status, currentStage: request.currentStage },
      data: next ? { status: next.status, currentStage: next.stage } : { status: 'APPROVED', currentStage: 'DONE' },
    })
    if (claim.count === 0) return fail('This request was already actioned.', 409)

    await db.attendanceApproval.create({ data: { requestId: id, approverId: session.userId, level, action: 'APPROVED', comment } })
    const ip = req.headers.get('x-forwarded-for') ?? null
    const actor = { userId: session.userId, fullName: session.fullName, role: session.role }

    if (next) {
      const approverId = next.stage === 'MANAGER' ? request.user.managerId : null
      const notifyId = approverId ?? (await db.user.findFirst({ where: { role: 'HR_MANAGER', isActive: true }, select: { id: true } }))?.id
      if (notifyId) {
        await db.notification.create({ data: { userId: notifyId, title: 'Attendance regularization escalated', body: `${request.user.fullName} · ${request.date} — awaiting your approval.`, type: 'APPROVAL' } })
      }
      await db.notification.create({ data: { userId: request.userId, title: 'Attendance request advanced', body: `Your regularization for ${request.date} moved to the ${next.stage === 'MANAGER' ? 'Manager' : 'HR'} stage.`, type: 'INFO' } })
      await writeAudit({
        actorId: session.userId, actorName: session.fullName, actorRole: session.role,
        targetUserId: request.userId, targetName: request.user.fullName,
        entityType: 'ATTENDANCE_REQUEST', entityId: id, fieldName: 'status', oldValue: request.status, newValue: next.status,
        reason: comment ?? undefined, ipAddress: ip,
      })
      return ok({ request: await db.attendanceRequest.findUnique({ where: { id } }), stage: next.status })
    }

    // final approval → apply to the attendance record; undo the claim if that fails so it can be retried
    let applied: { before: string; after: string }
    try {
      applied = await applyRegularizationToLog(request.userId, request.date, request.requestedCheckIn, request.requestedCheckOut, actor)
    } catch (e) {
      await db.attendanceRequest.update({ where: { id }, data: { status: request.status, currentStage: request.currentStage } })
      await db.attendanceApproval.deleteMany({ where: { requestId: id, approverId: session.userId, action: 'APPROVED', level } })
      throw e
    }

    const log = await db.attendanceLog.findUnique({ where: { userId_dateKey: { userId: request.userId, dateKey: request.date } } })
    if (log) {
      await db.attendanceAudit.create({
        data: { attendanceId: log.id, adminId: session.userId, field: 'regularization', oldValue: applied.before, newValue: applied.after, reason: `Approved regularization request${comment ? `: ${comment}` : ''}` },
      })
    }
    await db.notification.create({ data: { userId: request.userId, title: 'Attendance request approved', body: `Your regularization for ${request.date} was approved (${applied.after}).`, type: 'APPROVAL' } })
    await writeAudit({
      actorId: session.userId, actorName: session.fullName, actorRole: session.role,
      targetUserId: request.userId, targetName: request.user.fullName,
      entityType: 'ATTENDANCE_REQUEST', entityId: id, fieldName: 'status', oldValue: request.status, newValue: 'APPROVED',
      reason: `${applied.before} → ${applied.after}${comment ? ` · ${comment}` : ''}`, ipAddress: ip,
    })
    return ok({ request: await db.attendanceRequest.findUnique({ where: { id } }), stage: 'APPROVED' })
  })
}

export const dynamic = 'force-dynamic'
