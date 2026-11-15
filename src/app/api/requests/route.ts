import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireSession, guard, ok, fail } from '@/lib/hrms/api-utils'
import { visibleUserIds, initialStageOf } from '@/lib/hrms/rbac'
import { validateRequest } from '@/lib/hrms/policy'
import { ROLES, REQUEST_TYPES, isOversightOnly, PENDING_STATUSES } from '@/lib/hrms/constants'
import { dateTimeFor } from '@/lib/hrms/dates'
import { cleanText, cleanEmail } from '@/lib/hrms/sanitize'
import { writeAudit } from '@/lib/hrms/audit'

/** Requests list — scoped by hierarchy, PENDING always on top (newest first), then APPROVED/REJECTED. */
export async function GET(req: NextRequest) {
  return guard(async () => {
    const session = await requireSession()
    if (session.role === ROLES.ACCOUNTANT) return fail('Forbidden: Accountants cannot access the requests module.', 403)

    const qp = req.nextUrl.searchParams
    const type = qp.get('type') // LEAVE | OFFICIAL_DUTY | TRAVEL | null=all
    const status = qp.get('status')
    const ids = await visibleUserIds(session)

    const rows = await db.request.findMany({
      where: {
        userId: { in: ids },
        ...(type ? { type } : {}),
        ...(status ? { status } : {}),
      },
      include: {
        user: { select: { id: true, fullName: true, employeeCode: true, avatarColor: true, designation: true } },
        leaveType: { select: { id: true, name: true, colorCode: true } },
        attachment: { select: { id: true, name: true, mime: true } },
        approvals: { include: { approver: { select: { fullName: true, role: true } } }, orderBy: { createdAt: 'asc' } },
      },
      orderBy: { createdAt: 'desc' },
    })

    // Pending requests ALWAYS sort to the top (newest first), then APPROVED, then REJECTED
    const rank = (r: { status: string }) => (PENDING_STATUSES.includes(r.status) ? 0 : r.status === 'APPROVED' ? 1 : 2)
    const stageRank = (r: { status: string; currentStage: string }) =>
      r.currentStage === 'TEAM_LEAD' ? 0 : r.currentStage === 'MANAGER' ? 1 : r.currentStage === 'HR' ? 2 : 3
    rows.sort((a, b) => rank(a) - rank(b) || stageRank(a) - stageRank(b) || b.createdAt.getTime() - a.createdAt.getTime())

    return ok({ requests: rows })
  })
}

/** Create request — rules engine gate (quota hard-block, monthly caps, attachments) + chain-aware staging. */
export async function POST(req: NextRequest) {
  return guard(async () => {
    const session = await requireSession()
    if (session.role === ROLES.ACCOUNTANT) return fail('Forbidden: Accountants cannot create requests.', 403)
    if (isOversightOnly(session.role)) {
      return fail('System Admin is an oversight role — personal leave requests are disabled.', 403)
    }

    const body = await req.json().catch(() => null)
    if (!body) return fail('Invalid payload.', 422)

    const targetUserId = body.userId && isOrgAdminRole(session.role) ? String(body.userId) : session.userId
    const type = String(body.type ?? '')
    if (!Object.values(REQUEST_TYPES).includes(type)) return fail('Invalid request type.', 422)

    const input = {
      type,
      leaveTypeId: body.leaveTypeId ? String(body.leaveTypeId) : null,
      startDate: String(body.startDate ?? ''),
      endDate: String(body.endDate ?? String(body.startDate ?? '')),
      isShortLeave: Boolean(body.isShortLeave),
      shortHours: Number(body.shortHours ?? 0),
      attachmentName: body.attachmentName ? cleanText(body.attachmentName, 200) : null,
      attachmentId: body.attachmentId ? String(body.attachmentId) : null,
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.startDate)) return fail('Valid start date required (YYYY-MM-DD).', 422)

    const result = await validateRequest(targetUserId, input)
    if (!result.ok) return fail(result.error, result.code)

    const requester = await db.user.findUnique({ where: { id: targetUserId } })
    if (!requester) return fail('Requester not found.', 404)
    if (isOversightOnly(requester.role)) return fail('System Admin cannot have personal leave requests.', 403)

    // Chain-aware initial stage: TL → Manager → HR fallback
    const first = initialStageOf('LEAVE', requester)

    const created = await db.request.create({
      data: {
        userId: targetUserId,
        type: input.type,
        leaveTypeId: input.leaveTypeId,
        startDate: dateTimeFor(input.startDate, '00:00'),
        endDate: dateTimeFor(input.endDate, '00:00'),
        isShortLeave: input.isShortLeave,
        shortHours: input.shortHours,
        dayCount: result.dayCount,
        reason: cleanText(body.reason, 500) || '—',
        attachmentId: input.attachmentId,
        status: first.status,
        currentStage: first.stage,
      },
      include: {
        user: { select: { id: true, fullName: true, employeeCode: true, avatarColor: true } },
        leaveType: { select: { id: true, name: true, colorCode: true } },
      },
    })

    // pending balance reservation for leave requests
    if (input.type === 'LEAVE' && input.leaveTypeId) {
      const year = Number(input.startDate.slice(0, 4))
      const bal = await db.leaveBalance.findUnique({
        where: { userId_leaveTypeId_year: { userId: targetUserId, leaveTypeId: input.leaveTypeId, year } },
      })
      if (bal) await db.leaveBalance.update({ where: { id: bal.id }, data: { pending: { increment: result.dayCount } } })
    }

    // notify the correct first approver
    const approverId = first.stage === 'TEAM_LEAD' ? requester.teamLeadId : first.stage === 'MANAGER' ? requester.managerId : null
    if (approverId) {
      await db.notification.create({
        data: { userId: approverId, title: `New ${input.isShortLeave ? 'short leave' : typeLabel(input.type)} request`, body: `${requester.fullName} · ${result.dayCount} day(s) — awaiting your approval.`, type: 'APPROVAL' },
      })
    } else {
      const hrs = await db.user.findFirst({ where: { role: ROLES.HR_MANAGER, isActive: true }, select: { id: true } })
      if (hrs) {
        await db.notification.create({
          data: { userId: hrs.id, title: `New ${typeLabel(input.type)} request routed to HR`, body: `${requester.fullName} · ${result.dayCount} day(s) — no reporting line assigned.`, type: 'APPROVAL' },
        })
      }
    }

    await writeAudit({
      actorId: session.userId, actorName: session.fullName, actorRole: session.role,
      targetUserId: requester.id, targetName: requester.fullName,
      entityType: 'REQUEST', entityId: created.id,
      reason: `${typeLabel(input.type)} request created (${result.dayCount} day(s))`,
      ipAddress: req.headers.get('x-forwarded-for') ?? null,
    })

    return ok({ request: created }, { status: 201 })
  })
}

function typeLabel(t: string): string {
  return t === 'LEAVE' ? 'leave' : t === 'TRAVEL' ? 'travel' : 'official duty'
}
function isOrgAdminRole(role: string): boolean {
  return role === ROLES.SUPER_ADMIN || role === ROLES.HR_MANAGER
}
