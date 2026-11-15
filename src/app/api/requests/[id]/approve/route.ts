import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireSession, guard, ok, fail } from '@/lib/hrms/api-utils'
import { canApproveLeaveAtStage, nextStageOf } from '@/lib/hrms/rbac'
import { REQUEST_STATUS } from '@/lib/hrms/constants'
import { dayKey } from '@/lib/hrms/dates'
import { cleanText } from '@/lib/hrms/sanitize'
import { writeAudit } from '@/lib/hrms/audit'

/**
 * Approval engine for leave/travel/duty requests.
 * - Assigned approver advances the chain: TEAM_LEAD → MANAGER (→ HR fallback) → APPROVED
 * - Admin Fast-Track: org admin finalizes in ONE step from ANY stage
 * - Final approval converts pending balance → availed; rejection releases it
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
    await db.approvalLog.create({
      data: { requestId: id, approverId: session.userId, level, action: 'APPROVED', comment },
    })

    const requesterLite = { teamLeadId: request.user.teamLeadId, managerId: request.user.managerId }

    // ADMIN FAST-TRACK → finalize immediately in a single step
    if (level === 'ADMIN') {
      const updated = await finalize(request, session, comment)
      return ok({ request: updated.updated, stage: 'APPROVED', fastTrack: true })
    }

    const next = nextStageOf('LEAVE', requesterLite, request.currentStage)
    if (!next) {
      const updated = await finalize(request, session, comment)
      return ok({ request: updated.updated, stage: 'APPROVED' })
    }

    const updated = await db.request.update({
      where: { id },
      data: { status: next.status, currentStage: next.stage },
      include: { user: true },
    })

    const approverId = next.stage === 'TEAM_LEAD' ? request.user.teamLeadId : next.stage === 'MANAGER' ? request.user.managerId : null
    if (approverId) {
      await db.notification.create({
        data: { userId: approverId, title: 'Request escalated for approval', body: `${request.user.fullName} · ${request.leaveType?.name ?? request.type} — awaiting your approval.`, type: 'APPROVAL' },
      })
    } else if (next.stage === 'HR') {
      const hrs = await db.user.findFirst({ where: { role: 'HR_MANAGER', isActive: true }, select: { id: true } })
      if (hrs) await db.notification.create({ data: { userId: hrs.id, title: 'Request routed to HR', body: `${request.user.fullName} — no manager assigned.`, type: 'APPROVAL' } })
    }
    await db.notification.create({
      data: { userId: request.userId, title: 'First-level approval received', body: `Your request has moved to the ${next.stage === 'MANAGER' ? 'Manager' : 'HR'} approval stage.`, type: 'INFO' },
    })

    await writeAudit({
      actorId: session.userId, actorName: session.fullName, actorRole: session.role,
      targetUserId: request.userId, targetName: request.user.fullName,
      entityType: 'REQUEST', entityId: request.id,
      fieldName: 'status', oldValue: request.status, newValue: next.status,
      reason: comment ?? undefined, ipAddress: req.headers.get('x-forwarded-for') ?? null,
    })

    return ok({ request: updated, stage: next.status })
  })
}

/** Finalize: mark APPROVED, move pending balance → availed, notify. */
async function finalize(request: NonNullable<Awaited<ReturnType<typeof db.request.findUnique>>>, session: { userId: string; fullName: string; role: string }, comment: string | null) {
  const updated = await db.request.update({
    where: { id: request.id },
    data: { status: REQUEST_STATUS.APPROVED, currentStage: 'DONE' },
    include: { user: true, leaveType: true },
  })
  if (request.type === 'LEAVE' && request.leaveTypeId) {
    const year = Number(dayKey(request.startDate).slice(0, 4))
    const bal = await db.leaveBalance.findUnique({
      where: { userId_leaveTypeId_year: { userId: request.userId, leaveTypeId: request.leaveTypeId, year } },
    })
    if (bal) {
      await db.leaveBalance.update({
        where: { id: bal.id },
        data: { pending: { decrement: request.dayCount }, availed: { increment: request.dayCount } },
      })
    }
  }
  await db.notification.create({
    data: { userId: request.userId, title: 'Request approved', body: `Your ${request.type === 'LEAVE' ? request.leaveType?.name ?? 'leave' : request.type === 'TRAVEL' ? 'travel' : 'official duty'} request was fully approved.${comment ? ` Note: ${comment}` : ''}`, type: 'APPROVAL' },
  })
  await writeAudit({
    actorId: session.userId, actorName: session.fullName, actorRole: session.role,
    targetUserId: request.userId, targetName: request.user.fullName,
    entityType: 'REQUEST', entityId: request.id,
    fieldName: 'status', oldValue: request.status, newValue: 'APPROVED',
    reason: comment ?? undefined, ipAddress: null,
  })
  return { updated }
}
