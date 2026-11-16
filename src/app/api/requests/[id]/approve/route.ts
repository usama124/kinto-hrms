import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireSession, guard, ok, fail } from '@/lib/hrms/api-utils'
import { canApproveLeaveAtStage, nextStageOf, hrStageRole } from '@/lib/hrms/rbac'
import { REQUEST_STATUS } from '@/lib/hrms/constants'
import { dayKey, addDaysKey, todayKey } from '@/lib/hrms/dates'
import { cleanText } from '@/lib/hrms/sanitize'
import { writeAudit } from '@/lib/hrms/audit'
import { clientIp } from '@/lib/hrms/rate-limit'
import { materializeAttendance } from '@/lib/hrms/attendance-sync'
import { notifyRole } from '@/lib/hrms/notify'

/**
 * Approval engine for leave/travel/duty requests.
 * - Assigned approver advances the chain: TEAM_LEAD → MANAGER (→ HR fallback) → APPROVED
 * - Admin Fast-Track: org admin finalizes in ONE step from ANY stage
 *   (HR Manager requests are decided by the System Admin only; nobody approves their own — see rbac.ts)
 * - Final approval converts pending balance → availed
 * The stage change, approval log and balance move commit in ONE transaction guarded by a
 * compare-and-set on (status, stage): a double click or two approvers can never apply it twice.
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
    const level = gate.level!

    const next = level === 'ADMIN' ? null : nextStageOf('LEAVE', request.user, request.currentStage)
    const claimed = await db.$transaction(async (tx) => {
      const c = await tx.request.updateMany({
        where: { id, status: request.status, currentStage: request.currentStage },
        data: next ? { status: next.status, currentStage: next.stage } : { status: REQUEST_STATUS.APPROVED, currentStage: 'DONE' },
      })
      if (c.count === 0) return false
      await tx.approvalLog.create({ data: { requestId: id, approverId: session.userId, level, action: 'APPROVED', comment } })
      if (!next && request.type === 'LEAVE' && request.leaveTypeId) {
        await tx.leaveBalance.updateMany({
          where: { userId: request.userId, leaveTypeId: request.leaveTypeId, year: Number(dayKey(request.startDate).slice(0, 4)) },
          data: { pending: { decrement: request.dayCount }, availed: { increment: request.dayCount } },
        })
      }
      return true
    })
    if (!claimed) return fail('This request was already actioned.', 409)

    const ip = clientIp(req)
    const updated = await db.request.findUnique({ where: { id }, include: { user: true, leaveType: true } })

    if (next) {
      const approverId = next.stage === 'TEAM_LEAD' ? request.user.teamLeadId : next.stage === 'MANAGER' ? request.user.managerId : null
      const escalation = { title: 'Request escalated for approval', body: `${request.user.fullName} · ${request.leaveType?.name ?? request.type} — awaiting your approval.` }
      if (approverId) await db.notification.create({ data: { userId: approverId, ...escalation, type: 'APPROVAL' } })
      else if (next.stage === 'HR') await notifyRole(hrStageRole(request.user), escalation) // every HR Manager (or every System Admin for an HR Manager's own request)
      await db.notification.create({
        data: { userId: request.userId, title: 'First-level approval received', body: `Your request has moved to the ${next.stage === 'MANAGER' ? 'Manager' : 'HR'} approval stage.`, type: 'INFO' },
      })
      await writeAudit({
        actorId: session.userId, actorName: session.fullName, actorRole: session.role,
        targetUserId: request.userId, targetName: request.user.fullName,
        entityType: 'REQUEST', entityId: request.id,
        fieldName: 'status', oldValue: request.status, newValue: next.status,
        reason: comment ?? undefined, ipAddress: ip,
      })
      return ok({ request: updated, stage: next.status })
    }

    // final approval: reflect the approved days in attendance right away (past days only; the rest is picked up by the sync / payroll run)
    if (!request.isShortLeave) {
      const lastPast = addDaysKey(todayKey(), -1)
      const end = dayKey(request.endDate) < lastPast ? dayKey(request.endDate) : lastPast
      await materializeAttendance(dayKey(request.startDate), end, request.userId).catch((e) => console.error('[api] attendance sync after approval failed', e))
    }
    await db.notification.create({
      data: { userId: request.userId, title: 'Request approved', body: `Your ${request.type === 'LEAVE' ? request.leaveType?.name ?? 'leave' : request.type === 'TRAVEL' ? 'travel' : 'official duty'} request was fully approved.${comment ? ` Note: ${comment}` : ''}`, type: 'APPROVAL' },
    })
    await writeAudit({
      actorId: session.userId, actorName: session.fullName, actorRole: session.role,
      targetUserId: request.userId, targetName: request.user.fullName,
      entityType: 'REQUEST', entityId: request.id,
      fieldName: 'status', oldValue: request.status, newValue: 'APPROVED',
      reason: comment ?? undefined, ipAddress: ip,
    })
    return ok({ request: updated, stage: 'APPROVED', fastTrack: level === 'ADMIN' })
  })
}
