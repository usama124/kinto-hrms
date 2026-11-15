import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireSession, guard, ok, fail } from '@/lib/hrms/api-utils'
import { canAccessUser } from '@/lib/hrms/rbac'
import { ROLES } from '@/lib/hrms/constants'
import { addDaysKey, todayKey } from '@/lib/hrms/dates'

const NON_WORKING = ['WEEKEND', 'HOLIDAY', 'DAY_OFF']
const ATTENDED_STATUSES = ['PRESENT', 'WFH', 'OFFICIAL_DUTY', 'TRAVEL', 'SHORT_LEAVE', 'SHORT_DURATION']

/** Individual Employee 360° dossier (scoped: employee→self, TL/Manager→hierarchy, Admin→any). */
export async function GET(req: NextRequest) {
  return guard(async () => {
    const session = await requireSession()
    const qp = req.nextUrl.searchParams
    const userId = qp.get('userId') ?? session.userId
    const to = qp.get('to') ?? todayKey()
    const from = qp.get('from') ?? addDaysKey(to, -89)

    if (!(await canAccessUser(session, userId))) return fail('Forbidden: you cannot view this employee’s report.', 403)

    const accountant = session.role === ROLES.ACCOUNTANT
    const sections = accountant ? ['payroll'] : ['attendance', 'leaves', 'payroll']

    const u = await db.user.findUnique({
      where: { id: userId },
      include: {
        department: { select: { name: true } },
        teamLead: { select: { fullName: true } },
        manager: { select: { fullName: true } },
        shift: { select: { name: true, startTime: true, endTime: true } },
      },
    })
    if (!u) return fail('Employee not found.', 404)

    const year = Number(todayKey().slice(0, 4))

    // ── attendance ─────────────────────────────────────────────────────────────
    let attendanceScore: number | null = null
    let totals = { expected: 0, worked: 0, short: 0, lateDays: 0 }
    let lateFrequency: { dateKey: string; lateMinutes: number; checkIn: string | null }[] = []
    if (sections.includes('attendance')) {
      const logs = await db.attendanceLog.findMany({
        where: { userId, dateKey: { gte: from, lte: to } },
        orderBy: { dateKey: 'asc' },
      })
      const sched = logs.filter((l) => !NON_WORKING.includes(l.status) && l.expectedMinutes > 0)
      const attended = sched.filter((l) => ATTENDED_STATUSES.includes(l.status))
      attendanceScore = sched.length ? Math.round((attended.length / sched.length) * 100) : null
      totals = {
        expected: sched.reduce((s, l) => s + l.expectedMinutes, 0),
        worked: logs.reduce((s, l) => s + l.workedMinutes, 0),
        short: logs.reduce((s, l) => s + l.shortMinutes, 0),
        lateDays: logs.filter((l) => l.lateMinutes > 0).length,
      }
      lateFrequency = logs
        .filter((l) => l.lateMinutes > 0)
        .sort((a, b) => b.lateMinutes - a.lateMinutes)
        .slice(0, 12)
        .map((l) => ({ dateKey: l.dateKey, lateMinutes: l.lateMinutes, checkIn: l.checkIn?.toISOString() ?? null }))
    }

    // ── leave ledger ───────────────────────────────────────────────────────────
    let ledger: { leaveTypeId: string; name: string; color: string; carryForward: number; quota: number; availed: number; pending: number; lapsed: number; available: number }[] = []
    let leaveHistory: { id: string; type: string; color: string; startDate: Date; endDate: Date; dayCount: number; isShortLeave: boolean; shortHours: number; status: string; reason: string }[] = []
    if (sections.includes('leaves')) {
      const balances = await db.leaveBalance.findMany({ where: { userId, year }, include: { leaveType: true }, orderBy: { leaveTypeId: 'asc' } })
      ledger = balances.map((b) => {
        const total = b.carryForward + b.leaveType.annualQuota
        return {
          leaveTypeId: b.leaveTypeId,
          name: b.leaveType.name, color: b.leaveType.colorCode, carryForward: b.carryForward, quota: b.leaveType.annualQuota,
          availed: Math.round(b.availed * 100) / 100, pending: b.pending, lapsed: b.lapsed,
          available: Math.round((total - b.availed - b.pending - b.lapsed) * 100) / 100,
        }
      })
      const reqs = await db.request.findMany({
        where: { userId, type: 'LEAVE', startDate: { gte: new Date(from + 'T00:00:00Z'), lte: new Date(to + 'T23:59:59Z') } },
        include: { leaveType: true },
        orderBy: { startDate: 'desc' },
      })
      leaveHistory = reqs.map((r) => ({
        id: r.id, type: r.leaveType?.name ?? 'Leave', color: r.leaveType?.colorCode ?? '#64748B',
        startDate: r.startDate, endDate: r.endDate, dayCount: r.dayCount,
        isShortLeave: r.isShortLeave, shortHours: r.shortHours, status: r.status, reason: r.reason,
      }))
    }

    // ── payroll history ────────────────────────────────────────────────────────
    const payslips = await db.payslip.findMany({
      where: { userId, run: { status: 'FINALIZED', month: { gte: from.slice(0, 7), lte: to.slice(0, 7) } } },
      include: { run: { select: { month: true } } },
      orderBy: { run: { month: 'desc' } },
    })
    const payroll = payslips.map((p) => ({
      id: p.id, month: p.run.month, grossPay: p.grossPay, shortMinutes: p.shortMinutes,
      leaveDaysEquivalent: p.leaveDaysEquivalent, shortConvertedFromBalance: p.shortConvertedFromBalance,
      shortHourDeduction: p.shortHourDeduction, unpaidLeaveDays: p.unpaidLeaveDays,
      leaveDeduction: p.leaveDeduction, overtimeAmount: p.overtimeAmount, netPay: p.netPay,
    }))

    return ok({
      employee: {
        id: u.id, fullName: u.fullName, employeeCode: u.employeeCode, designation: u.designation,
        departmentName: u.department?.name ?? '—', role: u.role,
        joiningDate: u.joiningDate, teamLeadName: u.teamLead?.fullName ?? '—', managerName: u.manager?.fullName ?? '—',
        shiftName: u.shift ? `${u.shift.name} (${u.shift.startTime}–${u.shift.endTime})` : '—',
        avatarColor: u.avatarColor,
      },
      sections,
      range: { from, to },
      attendance: { score: attendanceScore, totals, lateFrequency },
      leaves: { ledger, history: leaveHistory },
      payroll,
    })
  })
}
