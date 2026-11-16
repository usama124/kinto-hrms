import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireSession, guard, ok, fail, HttpError } from '@/lib/hrms/api-utils'
import { visibleUserIds, initialStageOf, hrStageRole } from '@/lib/hrms/rbac'
import { validateRequest } from '@/lib/hrms/policy'
import { ROLES, REQUEST_TYPES, isOversightOnly, PENDING_STATUSES } from '@/lib/hrms/constants'
import { dateTimeFor } from '@/lib/hrms/dates'
import { cleanText, cleanDateKey } from '@/lib/hrms/sanitize'
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
      endDate: String(body.endDate || body.startDate || ''),
      isShortLeave: Boolean(body.isShortLeave),
      shortHours: Number(body.shortHours ?? 0),
      attachmentName: body.attachmentName ? cleanText(body.attachmentName, 200) : null,
      attachmentId: body.attachmentId ? String(body.attachmentId) : null,
    }
    if (!cleanDateKey(input.startDate)) return fail('Valid start date required (YYYY-MM-DD).', 422)
    if (!cleanDateKey(input.endDate)) return fail('Valid end date required (YYYY-MM-DD).', 422)
    if (!Number.isFinite(input.shortHours)) return fail('shortHours must be a number.', 422)

    const result = await validateRequest(targetUserId, input)
    if (!result.ok) return fail(result.error, result.code)

    const requester = await db.user.findUnique({ where: { id: targetUserId } })
    if (!requester) return fail('Requester not found.', 404)
    if (isOversightOnly(requester.role)) return fail('System Admin cannot have personal leave requests.', 403)

    // Chain-aware initial stage: TL → Manager → HR fallback
    const first = initialStageOf('LEAVE', requester)

    // an attachment must be the requester's own upload (can't attach somebody else's document by id)
    if (input.attachmentId) {
      const up = await db.upload.findUnique({ where: { id: input.attachmentId }, select: { uploadedById: true } })
      if (!up || (up.uploadedById !== targetUserId && up.uploadedById !== session.userId)) return fail('Attachment not found.', 422)
    }

    // create + reserve the balance atomically; the re-check inside the transaction closes the
    // "two simultaneous requests both pass validation" overdraw race (row lock serialises the increments)
    const created = await db.$transaction(async (tx) => {
      const c = await tx.request.create({
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
      if (input.type === 'LEAVE' && input.leaveTypeId) {
        const where = { userId: targetUserId, leaveTypeId: input.leaveTypeId, year: Number(input.startDate.slice(0, 4)) }
        const upd = await tx.leaveBalance.updateMany({ where, data: { pending: { increment: result.dayCount } } })
        if (upd.count) {
          const b = await tx.leaveBalance.findFirst({ where, include: { leaveType: true } })
          if (b && b.carryForward + b.leaveType.annualQuota - b.availed - b.pending - b.lapsed < -0.0001) {
            throw new HttpError(422, 'Insufficient leave balance for this request.')
          }
        }
      }
      return c
    })

    // notify the correct first approver
    const approverId = first.stage === 'TEAM_LEAD' ? requester.teamLeadId : first.stage === 'MANAGER' ? requester.managerId : null
    if (approverId) {
      await db.notification.create({
        data: { userId: approverId, title: `New ${input.isShortLeave ? 'short leave' : typeLabel(input.type)} request`, body: `${requester.fullName} · ${result.dayCount} day(s) — awaiting your approval.`, type: 'APPROVAL' },
      })
    } else {
      // HR stage: an HR Manager's own request is routed to the System Admin, never to HR
      const hrs = await db.user.findFirst({ where: { role: hrStageRole(requester), isActive: true }, select: { id: true } })
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
