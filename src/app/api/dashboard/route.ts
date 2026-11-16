import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireSession, guard, ok } from '@/lib/hrms/api-utils'
import { visibleUserIds } from '@/lib/hrms/rbac'
import { addDaysKey, todayKey, fmtDateKey, monthRangeKeys } from '@/lib/hrms/dates'
import { ROLES, isOrgAdmin, isOversightOnly, WORKED_STATUS_SET, NON_WORKING_STATUSES } from '@/lib/hrms/constants'
import { departmentMatrix, rosterFor, computeStats } from '@/lib/hrms/org-stats'
import { resolveShiftForUser } from '@/lib/hrms/attendance-engine'

const SHORT_HOUR_SET: readonly string[] = ['PRESENT', 'SHORT_DURATION', 'WFH', 'SHORT_LEAVE']

/** Role-aware dashboard:
 *  SUPER_ADMIN / HR_MANAGER → org drill-down (L1 matrix) + org trend + pending queue size
 *  MANAGER / TEAM_LEAD      → personal stats + My Team Overview roster
 *  EMPLOYEE                 → personal stats only
 */
export async function GET(req: NextRequest) {
  return guard(async () => {
    const session = await requireSession()
    const qp = req.nextUrl.searchParams
    const month = qp.get('month') ?? todayKey().slice(0, 7)
    const to = qp.get('to') ?? todayKey()
    const from = qp.get('from') ?? monthRangeKeys(month).fromKey

    // ── Personal context (all roles; org dashboards reuse it for the admin's own row where applicable) ──
    const me = await db.user.findUnique({
      where: { id: session.userId },
      include: { shift: true, department: true, team: true, teamLead: { select: { id: true, fullName: true } }, manager: { select: { id: true, fullName: true } } },
    })

    const myLogs = await db.attendanceLog.findMany({
      where: { userId: session.userId, dateKey: { gte: from, lte: to } },
      orderBy: { dateKey: 'asc' },
    })
    const scheduled = myLogs.filter((l) => !NON_WORKING_STATUSES.includes(l.status as never) && l.expectedMinutes > 0)
    const expectedMinutes = scheduled.reduce((s, l) => s + l.expectedMinutes, 0)
    const workedMinutes = myLogs.reduce((s, l) => s + l.workedMinutes, 0)
    const shortMinutes = myLogs.reduce((s, l) => s + l.shortMinutes, 0)
    const leaves = myLogs.filter((l) => l.status === 'FULL_LEAVE' || l.status === 'SHORT_LEAVE').length
    const travels = myLogs.filter((l) => l.status === 'TRAVEL').length
    const absents = myLogs.filter((l) => l.status === 'ABSENT' || l.status === 'MISSING').length
    const attended = myLogs.filter((l) => (WORKED_STATUS_SET as readonly string[]).includes(l.status)).length
    const attendanceScore = scheduled.length > 0 ? Math.round((attended / scheduled.length) * 100) : null

    // 14-day check-in trend (personal late/short; org roles get org-wide aggregates below)
    const byDay = new Map<string, { late: number; n: number; short: number; inMin: number }>()
    for (const l of myLogs) {
      const cur = byDay.get(l.dateKey) ?? { late: 0, n: 0, short: 0, inMin: 0 }
      if (!NON_WORKING_STATUSES.includes(l.status as never) && l.status !== 'FULL_LEAVE' && l.status !== 'ABSENT') {
        cur.late += l.lateMinutes
        cur.n += 1
        if (l.checkIn) {
          const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Karachi', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(l.checkIn)
          cur.inMin = Number(parts.find((p) => p.type === 'hour')?.value ?? 0) * 60 + Number(parts.find((p) => p.type === 'minute')?.value ?? 0)
        }
      }
      cur.short += l.shortMinutes
      byDay.set(l.dateKey, cur)
    }
    const trend = buildTrend(from, to, byDay)

    // leave summary (personal; SUPER_ADMIN has none)
    const year = Number(todayKey().slice(0, 4))
    const balances = isOversightOnly(session.role)
      ? []
      : await db.leaveBalance.findMany({ where: { userId: session.userId, year }, include: { leaveType: true } })
    const leaveSummary = balances.map((b) => {
      const total = b.carryForward + b.leaveType.annualQuota
      return {
        leaveTypeId: b.leaveTypeId, name: b.leaveType.name, color: b.leaveType.colorCode,
        total, availed: Math.round(b.availed * 100) / 100, pending: b.pending,
        available: Math.round((total - b.availed - b.pending - b.lapsed) * 100) / 100,
        monthlyCap: b.leaveType.monthlyCap,
      }
    })

    // today punch state
    const todayLog = await db.attendanceLog.findUnique({ where: { userId_dateKey: { userId: session.userId, dateKey: todayKey() } } })
    const myShift = me ? await resolveShiftForUser(me.id) : null

    // ── Role-specific payloads ──
    if (isOrgAdmin(session.role)) {
      // org-wide trend across ALL active users (admins have no personal logs)
      const orgIdsAll = (await db.user.findMany({ where: { isActive: true, role: { not: 'SUPER_ADMIN' } }, select: { id: true } })).map((u) => u.id)
      const orgLogs = await db.attendanceLog.findMany({ where: { userId: { in: orgIdsAll }, dateKey: { gte: from, lte: to } } })
      const orgByDay = new Map<string, { late: number; n: number; short: number; inMin: number }>()
      for (const l of orgLogs) {
        const curD = orgByDay.get(l.dateKey) ?? { late: 0, n: 0, short: 0, inMin: 0 }
        if (!NON_WORKING_STATUSES.includes(l.status as never) && l.status !== 'FULL_LEAVE' && l.status !== 'ABSENT') {
          curD.late += l.lateMinutes
          curD.n += 1
          if (l.checkIn) {
            const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Karachi', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(l.checkIn)
            curD.inMin = Number(parts.find((p) => p.type === 'hour')?.value ?? 0) * 60 + Number(parts.find((p) => p.type === 'minute')?.value ?? 0)
          }
        }
        curD.short += l.shortMinutes
        orgByDay.set(l.dateKey, curD)
      }
      const orgTrend = buildTrend(from, to, orgByDay)
      const departments = await departmentMatrix(month)
      const orgIds = (await db.user.findMany({ where: { isActive: true, role: { not: 'SUPER_ADMIN' } }, select: { id: true } })).map((u) => u.id)
      const orgStats = await computeStats(month, orgIds)
      const pendingLeave = await db.request.count({ where: { status: { in: ['PENDING_TEAM_LEAD', 'PENDING_MANAGER', 'PENDING_HR'] } } })
      const pendingAtt = await db.attendanceRequest.count({ where: { status: { in: ['PENDING_TEAM_LEAD', 'PENDING_MANAGER', 'PENDING_HR'] } } })
      return ok({
        kind: 'org',
        month,
        departments,
        orgStats: { ...orgStats, pendingRequests: pendingLeave + pendingAtt, pendingLeave, pendingAttendance: pendingAtt },
        trend: orgTrend,
        pendingApprovals: pendingLeave + pendingAtt,
        personal: null,
        canCreateRequest: false,
      })
    }

    const ids = await visibleUserIds(session)
    let teamOverview: Awaited<ReturnType<typeof rosterFor>> = []
    if (session.role === ROLES.MANAGER || session.role === ROLES.TEAM_LEAD) {
      teamOverview = await rosterFor(ids.filter((id) => id !== session.userId), month)
    }
    let pendingApprovals = 0
    if (session.role === ROLES.TEAM_LEAD) {
      pendingApprovals = await db.request.count({ where: { status: 'PENDING_TEAM_LEAD', userId: { in: ids } } })
        + await db.attendanceRequest.count({ where: { status: 'PENDING_TEAM_LEAD', userId: { in: ids } } })
    } else if (session.role === ROLES.MANAGER) {
      pendingApprovals = await db.request.count({ where: { status: 'PENDING_MANAGER', userId: { in: ids } } })
        + await db.attendanceRequest.count({ where: { status: 'PENDING_MANAGER', userId: { in: ids } } })
    } else if (session.role === ROLES.HR_MANAGER) {
      pendingApprovals = await db.request.count({ where: { status: { in: ['PENDING_TEAM_LEAD', 'PENDING_MANAGER', 'PENDING_HR'] } } })
        + await db.attendanceRequest.count({ where: { status: { in: ['PENDING_TEAM_LEAD', 'PENDING_MANAGER', 'PENDING_HR'] } } })
    }

    return ok({
      kind: 'personal',
      month,
      kpis: { shifts: scheduled.length, expectedMinutes, workedMinutes, shortMinutes, leaves, travels, absents, attendanceScore },
      trend,
      leaveSummary,
      pendingApprovals,
      teamOverview,
      todayPunch: todayLog ? { checkIn: todayLog.checkIn, checkOut: todayLog.checkOut, status: todayLog.status } : null,
      shift: myShift,
      // shift resolves user → team → department (same order as resolveShiftForUser)
      canPunch: !isOversightOnly(session.role) && Boolean(me?.shiftId ?? me?.team?.shiftId ?? me?.department?.shiftId),
      canCreateRequest: !isOversightOnly(session.role) && session.role !== ROLES.ACCOUNTANT,
      supervisors: { teamLead: me?.teamLead ?? null, manager: me?.manager ?? null },
    })
  })
}

export const dynamic = 'force-dynamic'


function buildTrend(
  from: string,
  to: string,
  byDay: Map<string, { late: number; n: number; short: number; inMin: number }>,
): { day: string; label: string; late: number; short: number; checkInMin: number | null }[] {
  const trend: { day: string; label: string; late: number; short: number; checkInMin: number | null }[] = []
  let cur = from
  let guardLoop = 0
  while (cur <= to && guardLoop < 200) {
    const v = byDay.get(cur)
    trend.push({
      day: cur, label: fmtDateKey(cur).slice(0, 6),
      late: v && v.n > 0 ? Math.round(v.late / v.n) : 0,
      short: v?.short ?? 0,
      checkInMin: v && v.n > 0 ? v.inMin : null,
    })
    cur = addDaysKey(cur, 1)
    guardLoop++
  }
  return trend
}
