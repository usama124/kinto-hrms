import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireSession, guard, ok, fail } from '@/lib/hrms/api-utils'
import { visibleUserIds } from '@/lib/hrms/rbac'
import { cleanDateKey } from '@/lib/hrms/sanitize'
import { ROLES, isOrgAdmin, isAccountsRole } from '@/lib/hrms/constants'
import { addDaysKey, todayKey, monthsBetween, monthRangeKeys } from '@/lib/hrms/dates'

const NON_WORKING = ['WEEKEND', 'HOLIDAY', 'DAY_OFF']

/**
 * Organization-wide analytics (Admin: full; Accountant: payroll section only;
 * Manager: hierarchy-scoped when they pass ?scoped=1? — per spec Admin-only for org-wide;
 * Managers use /reports/individual for their scope).
 */
export async function GET(req: NextRequest) {
  return guard(async () => {
    const session = await requireSession()
    const qp = req.nextUrl.searchParams
    const to = qp.get('to') ? cleanDateKey(qp.get('to')) : todayKey()
    const from = qp.get('from') ? cleanDateKey(qp.get('from')) : (to ? addDaysKey(to, -90) : null)
    if (!from || !to) return fail('from / to must be valid YYYY-MM-DD dates.', 422)
    const departmentId = qp.get('departmentId')

    const accountant = isAccountsRole(session.role)
    if (!isOrgAdmin(session.role) && !accountant) {
      return fail('Forbidden: organization-wide analytics is restricted to Admin / HR.', 403)
    }

    const fromMonth = from.slice(0, 7)
    const toMonth = to.slice(0, 7)
    const months = monthsBetween(fromMonth, toMonth).slice(-12)

    const ids = await visibleUserIds(session)
    const users = await db.user.findMany({
      where: { id: { in: ids }, role: { notIn: [ROLES.ACCOUNTANT, ROLES.ACCOUNTS_MANAGER] } },
      select: { id: true, departmentId: true, department: { select: { name: true } } },
    })
    const userDept = new Map(users.map((u) => [u.id, u.department?.name ?? '—']))
    const userIds = users.map((u) => u.id)
    let deptFilterName: string | null = null
    if (departmentId) {
      const dept = await db.department.findUnique({ where: { id: departmentId } })
      deptFilterName = dept?.name ?? null
    }

    let sections: string[] = ['attendance', 'departments', 'leaves', 'payroll']
    if (accountant) sections = ['payroll']

    // ── attendance & punctuality trend + dept comparison ────────────────────────
    let attendanceTrend: { month: string; attendanceRate: number; punctualityRate: number; shortMinutes: number; absentDays: number }[] = []
    let deptComparison: { department: string; employees: number; shortHours: number; absentDays: number; punctuality: number }[] = []
    if (sections.includes('attendance')) {
      const logs = await db.attendanceLog.findMany({
        where: { userId: { in: userIds }, dateKey: { gte: from, lte: to } },
        select: { userId: true, dateKey: true, status: true, shortMinutes: true, lateMinutes: true, expectedMinutes: true, workedMinutes: true },
      })
      const filtered = deptFilterName ? logs.filter((l) => userDept.get(l.userId) === deptFilterName) : logs

      for (const m of months) {
        const { fromKey, toKey } = monthRangeKeys(m)
        const ml = filtered.filter((l) => l.dateKey >= fromKey && l.dateKey <= toKey)
        const sched = ml.filter((l) => !NON_WORKING.includes(l.status) && l.expectedMinutes > 0)
        const attended = sched.filter((l) => ['PRESENT', 'WFH', 'OFFICIAL_DUTY', 'TRAVEL', 'SHORT_LEAVE', 'SHORT_DURATION'].includes(l.status))
        const onTime = attended.filter((l) => l.lateMinutes === 0)
        attendanceTrend.push({
          month: m,
          attendanceRate: sched.length ? Math.round((attended.length / sched.length) * 1000) / 10 : 0,
          punctualityRate: attended.length ? Math.round((onTime.length / attended.length) * 1000) / 10 : 0,
          shortMinutes: ml.reduce((s, l) => s + l.shortMinutes, 0),
          absentDays: ml.filter((l) => l.status === 'ABSENT' || l.status === 'MISSING').length,
        })
      }

      const deptNames = Array.from(new Set(users.map((u) => u.department?.name ?? '—')))
      deptComparison = deptNames.map((dn) => {
        const empIds = users.filter((u) => (u.department?.name ?? '—') === dn).map((u) => u.id)
        const dl = filtered.filter((l) => empIds.includes(l.userId))
        const sched = dl.filter((l) => !NON_WORKING.includes(l.status) && l.expectedMinutes > 0)
        const attended = sched.filter((l) => ['PRESENT', 'WFH', 'OFFICIAL_DUTY', 'TRAVEL', 'SHORT_LEAVE', 'SHORT_DURATION'].includes(l.status))
        const onTime = attended.filter((l) => l.lateMinutes === 0)
        return {
          department: dn,
          employees: empIds.length,
          shortHours: Math.round((dl.reduce((s, l) => s + l.shortMinutes, 0) / 60) * 10) / 10,
          absentDays: dl.filter((l) => l.status === 'ABSENT' || l.status === 'MISSING').length,
          punctuality: attended.length ? Math.round((onTime.length / attended.length) * 1000) / 10 : 0,
        }
      })
    }

    // ── leave utilization ───────────────────────────────────────────────────────
    let leaveUtilization: { type: string; color: string; requests: number; availed: number; pending: number; rejected: number }[] = []
    if (sections.includes('leaves')) {
      const reqs = await db.request.findMany({
        where: { userId: { in: userIds }, type: 'LEAVE', startDate: { gte: new Date(from + 'T00:00:00Z'), lte: new Date(to + 'T23:59:59Z') } },
        include: { leaveType: true },
      })
      const byType = new Map<string, { type: string; color: string; requests: number; availed: number; pending: number; rejected: number }>()
      for (const r of reqs) {
        const key = r.leaveTypeId ?? 'none'
        const cur = byType.get(key) ?? { type: r.leaveType?.name ?? 'Leave', color: r.leaveType?.colorCode ?? '#64748B', requests: 0, availed: 0, pending: 0, rejected: 0 }
        cur.requests += 1
        if (r.status === 'APPROVED') cur.availed += r.dayCount
        else if (r.status === 'REJECTED') cur.rejected += 1
        else cur.pending += r.dayCount
        byType.set(key, cur)
      }
      leaveUtilization = Array.from(byType.values())
    }

    // ── payroll trend ───────────────────────────────────────────────────────────
    const runs = await db.payrollRun.findMany({
      where: { month: { in: months }, status: 'FINALIZED' },
      orderBy: { month: 'asc' },
    })
    const payrollTrend = runs.map((r) => ({
      month: r.month, gross: Math.round(r.totalGross), deductions: Math.round(r.totalDeductions), net: Math.round(r.totalNet),
    }))

    const allLogsKpi = sections.includes('attendance')
      ? await db.attendanceLog.findMany({ where: { userId: { in: userIds }, dateKey: { gte: from, lte: to } }, select: { status: true, expectedMinutes: true, shortMinutes: true, lateMinutes: true } })
      : []
    const sched = allLogsKpi.filter((l) => !NON_WORKING.includes(l.status) && l.expectedMinutes > 0)
    const attended = sched.filter((l) => ['PRESENT', 'WFH', 'OFFICIAL_DUTY', 'TRAVEL', 'SHORT_LEAVE', 'SHORT_DURATION'].includes(l.status))

    return ok({
      sections,
      range: { from, to },
      attendanceTrend,
      deptComparison,
      leaveUtilization,
      payrollTrend,
      kpis: {
        headcount: userIds.length,
        attendanceRate: sched.length ? Math.round((attended.length / sched.length) * 1000) / 10 : 0,
        shortHours: Math.round((allLogsKpi.reduce((s, l) => s + l.shortMinutes, 0) / 60) * 10) / 10,
        absentDays: allLogsKpi.filter((l) => l.status === 'ABSENT' || l.status === 'MISSING').length,
      },
    })
  })
}
