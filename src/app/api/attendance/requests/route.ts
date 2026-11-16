import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireSession, guard, ok, fail } from '@/lib/hrms/api-utils'
import { visibleUserIds, nextStageOf, hrStageRole } from '@/lib/hrms/rbac'
import { ROLES, isOversightOnly, PENDING_STATUSES, isAccountsRole } from '@/lib/hrms/constants'
import { dayKey, parseKey } from '@/lib/hrms/dates'
import { cleanText, cleanDateKey, cleanHhmm } from '@/lib/hrms/sanitize'
import { writeAudit } from '@/lib/hrms/audit'
import { notifyRole } from '@/lib/hrms/notify'

/** GET — regularization queue scoped by hierarchy; PENDING always on top. */
export async function GET(req: NextRequest) {
  return guard(async () => {
    const session = await requireSession()
    if (isAccountsRole(session.role)) return fail('Forbidden.', 403)
    const ids = await visibleUserIds(session)
    const rows = await db.attendanceRequest.findMany({
      where: { userId: { in: ids } },
      include: {
        user: { select: { id: true, fullName: true, employeeCode: true, avatarColor: true, designation: true, role: true, avatarUploadId: true } },
        approvals: { include: { approver: { select: { fullName: true, role: true } } }, orderBy: { createdAt: 'asc' } },
      },
      orderBy: { createdAt: 'desc' },
    })
    const rank = (r: { status: string }) => (PENDING_STATUSES.includes(r.status) ? 0 : r.status === 'APPROVED' ? 1 : 2)
    const stageRank = (r: { currentStage: string }) => (r.currentStage === 'TEAM_LEAD' ? 0 : r.currentStage === 'MANAGER' ? 1 : r.currentStage === 'HR' ? 2 : 3)
    rows.sort((a, b) => rank(a) - rank(b) || stageRank(a) - stageRank(b) || b.createdAt.getTime() - a.createdAt.getTime())
    return ok({ requests: rows })
  })
}

/** POST — submit a Manual Attendance Update Request (Missing Punch / biometric discrepancy). */
export async function POST(req: NextRequest) {
  return guard(async () => {
    const session = await requireSession()
    if (isAccountsRole(session.role)) return fail('Forbidden: the accounts team cannot submit attendance requests.', 403)
    if (isOversightOnly(session.role)) return fail('System Admin is an oversight role — attendance regularization is disabled.', 403)

    const body = await req.json().catch(() => null)
    const date = cleanDateKey(body?.date)
    const checkIn = cleanHhmm(body?.requestedCheckIn)
    const checkOut = cleanHhmm(body?.requestedCheckOut)
    const reason = cleanText(body?.reason, 500)
    if (!date || !checkIn || !checkOut || !reason) {
      return fail('date (YYYY-MM-DD), requestedCheckIn, requestedCheckOut and reason are required.', 422)
    }
    if (parseKey(date) > parseKey(dayKey(new Date()))) return fail('Cannot regularize a future date.', 422)
    if (checkOut <= checkIn) return fail('Check-out must be after check-in.', 422)

    const requester = await db.user.findUnique({ where: { id: session.userId } })
    if (!requester) return fail('Account not found.', 404)

    // one open request per user per day
    const existing = await db.attendanceRequest.findFirst({
      where: { userId: session.userId, date, status: { in: PENDING_STATUSES } },
    })
    if (existing) return fail('A regularization request for this date is already pending.', 409)

    const first = nextStageOf('ATTENDANCE', requester, null) ?? { status: 'PENDING_HR', stage: 'HR' }
    const created = await db.attendanceRequest.create({
      data: {
        userId: session.userId, date, requestedCheckIn: checkIn, requestedCheckOut: checkOut,
        reason, status: first.status, currentStage: first.stage,
      },
      include: { user: { select: { id: true, fullName: true, employeeCode: true, avatarColor: true } } },
    })

    const approverId = first.stage === 'TEAM_LEAD' ? requester.teamLeadId : first.stage === 'MANAGER' ? requester.managerId : null
    if (approverId) {
      await db.notification.create({
        data: { userId: approverId, title: 'Attendance regularization request', body: `${requester.fullName} · ${date} — awaiting your approval.`, type: 'APPROVAL' },
      })
    } else {
      // an HR Manager's own request is routed to the System Admin, never to HR
      await notifyRole(hrStageRole(requester), { title: 'Attendance regularization routed to HR', body: `${requester.fullName} · ${date}.` })
    }

    await writeAudit({
      actorId: session.userId, actorName: session.fullName, actorRole: session.role,
      targetUserId: session.userId, targetName: requester.fullName,
      entityType: 'ATTENDANCE_REQUEST', entityId: created.id,
      reason: `Regularization requested for ${date} (${checkIn}–${checkOut})`,
      ipAddress: req.headers.get('x-forwarded-for') ?? null,
    })

    return ok({ request: created }, { status: 201 })
  })
}

export const dynamic = 'force-dynamic'
