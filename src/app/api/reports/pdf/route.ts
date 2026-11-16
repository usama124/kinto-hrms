import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireSession, guard, fail } from '@/lib/hrms/api-utils'
import { canAccessUser, canSeeCompensation, visibleUserIds } from '@/lib/hrms/rbac'
import { cleanDateKey } from '@/lib/hrms/sanitize'
import { ROLES, isOrgAdmin } from '@/lib/hrms/constants'
import { addDaysKey, todayKey, monthRangeKeys, monthsBetween, fmtDateKey, fmtMinutes } from '@/lib/hrms/dates'
import { individualReportPDF, orgAttendancePDF, leaveAuditPDF } from '@/lib/hrms/pdf'
import { ROLE_LABELS } from '@/lib/hrms/constants'

const NON_WORKING = ['WEEKEND', 'HOLIDAY', 'DAY_OFF']
const ATTENDED = ['PRESENT', 'WFH', 'OFFICIAL_DUTY', 'TRAVEL', 'SHORT_LEAVE', 'SHORT_DURATION']

/**
 * One-click PDF report generator.
 *  type=individual      → Individual Employee Performance, Attendance & Leave Report
 *  type=org-attendance  → Monthly Organization Attendance & Short-Hours Summary
 *  type=leave-audit     → Monthly Leave Utilization & Balance Audit
 */
export async function GET(req: NextRequest) {
  return guard(async () => {
    const session = await requireSession()
    const qp = req.nextUrl.searchParams
    const type = qp.get('type') ?? 'individual'
    // validated: these go into SQL filters AND the Content-Disposition filename
    const to = qp.get('to') ? cleanDateKey(qp.get('to')) : todayKey()
    const from = qp.get('from') ? cleanDateKey(qp.get('from')) : (to ? addDaysKey(to, -89) : null)
    if (!from || !to) return fail('from / to must be valid YYYY-MM-DD dates.', 422)
    const rangeLabel = `${fmtDateKey(from)} → ${fmtDateKey(to)}`

    if (type === 'individual') {
      const userId = qp.get('userId') ?? session.userId
      if (!(await canAccessUser(session, userId))) return fail('Forbidden: you cannot export this employee’s report.', 403)

      const u = await db.user.findUnique({
        where: { id: userId },
        include: { department: true, teamLead: true, manager: true, shift: true },
      })
      if (!u) return fail('Employee not found.', 404)

      const year = Number(todayKey().slice(0, 4))
      const logs = await db.attendanceLog.findMany({ where: { userId, dateKey: { gte: from, lte: to } }, orderBy: { dateKey: 'asc' } })
      const sched = logs.filter((l) => !NON_WORKING.includes(l.status) && l.expectedMinutes > 0)
      const attended = sched.filter((l) => ATTENDED.includes(l.status))
      const score = sched.length ? Math.round((attended.length / sched.length) * 100) : 0

      const balances = await db.leaveBalance.findMany({ where: { userId, year }, include: { leaveType: true }, orderBy: { leaveTypeId: 'asc' } })
      // compensation is not part of a supervisor's view of someone else's report
      const payslips = canSeeCompensation(session, userId) ? await db.payslip.findMany({
        where: { userId, run: { status: 'FINALIZED', month: { gte: from.slice(0, 7), lte: to.slice(0, 7) } } },
        include: { run: true }, orderBy: { run: { month: 'desc' } },
      }) : []

      const buf = individualReportPDF({
        employee: {
          fullName: u.fullName, employeeCode: u.employeeCode, designation: u.designation,
          department: u.department?.name ?? '—', roleLabel: ROLE_LABELS[u.role] ?? u.role,
          joiningDate: fmtDateKey(u.joiningDate.toISOString().slice(0, 10)),
          teamLead: u.teamLead?.fullName ?? '—', manager: u.manager?.fullName ?? '—',
        },
        rangeLabel,
        attendanceScore: score,
        kpis: [
          { label: 'Attendance Score', value: `${score}%`, accent: score >= 90 ? 'emerald' : 'amber' },
          { label: 'Expected Hours', value: fmtMinutes(sched.reduce((s, l) => s + l.expectedMinutes, 0)) },
          { label: 'Worked Hours', value: fmtMinutes(logs.reduce((s, l) => s + l.workedMinutes, 0)), accent: 'emerald' },
          { label: 'Short Hours', value: fmtMinutes(logs.reduce((s, l) => s + l.shortMinutes, 0)), accent: 'orange' },
          { label: 'Late Arrivals', value: String(logs.filter((l) => l.lateMinutes > 0).length), accent: 'rose' },
          { label: 'Leave Days Availed', value: String(balances.reduce((s, b) => s + b.availed, 0)) },
          { label: 'Pending Days', value: String(balances.reduce((s, b) => s + b.pending, 0)), accent: 'amber' },
          { label: 'Net Pay (latest)', value: payslips[0] ? `PKR ${payslips[0].netPay.toFixed(0)}` : '—', accent: 'teal' },
        ],
        lateFrequency: logs.filter((l) => l.lateMinutes > 0).sort((a, b) => b.lateMinutes - a.lateMinutes).slice(0, 10)
          .map((l) => ({ label: fmtDateKey(l.dateKey), value: `${l.lateMinutes} min` })),
        leaveLedger: balances.map((b) => {
          const total = b.carryForward + b.leaveType.annualQuota
          return [
            b.leaveType.name, b.carryForward, Math.round(b.availed * 100) / 100, b.pending, b.lapsed,
            Math.round((total - b.availed - b.pending - b.lapsed) * 100) / 100,
          ]
        }),
        payrollRows: payslips.map((p) => [
          p.run.month, `PKR ${p.grossPay.toFixed(0)}`, p.shortMinutes, `PKR ${p.shortHourDeduction.toFixed(0)}`,
          `PKR ${p.leaveDeduction.toFixed(0)}`, `PKR ${p.overtimeAmount.toFixed(0)}`, `PKR ${p.netPay.toFixed(0)}`,
        ]),
      })
      return new Response(new Uint8Array(buf), {
        headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="individual-${u.employeeCode}-${from}-${to}.pdf"` },
      })
    }

    if (type === 'org-attendance') {
      if (!isOrgAdmin(session.role)) return fail('Forbidden: org-wide reports are Admin / HR only.', 403)
      const ids = await visibleUserIds(session)
      const users = await db.user.findMany({ where: { id: { in: ids }, role: { notIn: [ROLES.ACCOUNTANT, ROLES.ACCOUNTS_MANAGER] } }, include: { department: true } })
      const logs = await db.attendanceLog.findMany({ where: { userId: { in: users.map((u) => u.id) }, dateKey: { gte: from, lte: to } } })
      const sched = logs.filter((l) => !NON_WORKING.includes(l.status) && l.expectedMinutes > 0)
      const attended = sched.filter((l) => ATTENDED.includes(l.status))
      const score = sched.length ? Math.round((attended.length / sched.length) * 100) : 0

      const deptNames = Array.from(new Set(users.map((u) => u.department?.name ?? '—')))
      const deptRows = deptNames.map((dn) => {
        const empIds = users.filter((u) => (u.department?.name ?? '—') === dn).map((u) => u.id)
        const dl = logs.filter((l) => empIds.includes(l.userId))
        const dsched = dl.filter((l) => !NON_WORKING.includes(l.status) && l.expectedMinutes > 0)
        const datt = dsched.filter((l) => ATTENDED.includes(l.status))
        const onTime = datt.filter((l) => l.lateMinutes === 0)
        return [dn, empIds.length, fmtMinutes(dl.reduce((s, l) => s + l.shortMinutes, 0)),
          dl.filter((l) => l.status === 'ABSENT' || l.status === 'MISSING').length,
          datt.length ? `${Math.round((onTime.length / datt.length) * 100)}%` : '—']
      })

      const months = monthsBetween(from.slice(0, 7), to.slice(0, 7)).slice(-6)
      const monthRows = months.map((m) => {
        const { fromKey, toKey } = monthRangeKeys(m)
        const ml = logs.filter((l) => l.dateKey >= fromKey && l.dateKey <= toKey)
        const msched = ml.filter((l) => !NON_WORKING.includes(l.status) && l.expectedMinutes > 0)
        const matt = msched.filter((l) => ATTENDED.includes(l.status))
        const onTime = matt.filter((l) => l.lateMinutes === 0)
        return [m,
          msched.length ? `${Math.round((matt.length / msched.length) * 100)}%` : '—',
          matt.length ? `${Math.round((onTime.length / matt.length) * 100)}%` : '—',
          ml.reduce((s, l) => s + l.shortMinutes, 0),
          ml.filter((l) => l.status === 'ABSENT' || l.status === 'MISSING').length]
      })

      const buf = orgAttendancePDF({
        rangeLabel,
        kpis: [
          { label: 'Headcount', value: String(users.length) },
          { label: 'Attendance Score', value: `${score}%`, accent: score >= 90 ? 'emerald' : 'amber' },
          { label: 'Total Short Hours', value: fmtMinutes(logs.reduce((s, l) => s + l.shortMinutes, 0)), accent: 'orange' },
          { label: 'Absent Days', value: String(logs.filter((l) => l.status === 'ABSENT' || l.status === 'MISSING').length), accent: 'rose' },
        ],
        deptRows,
        monthRows,
      })
      return new Response(new Uint8Array(buf), {
        headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="org-attendance-${from}-${to}.pdf"` },
      })
    }

    if (type === 'leave-audit') {
      if (!isOrgAdmin(session.role)) return fail('Forbidden: org-wide reports are Admin / HR only.', 403)
      const ids = await visibleUserIds(session)
      const year = Number(todayKey().slice(0, 4))
      const balances = await db.leaveBalance.findMany({
        where: { userId: { in: ids }, year },
        include: { leaveType: true, user: { select: { fullName: true, employeeCode: true } } },
        orderBy: [{ userId: 'asc' }, { leaveTypeId: 'asc' }],
      })
      const reqs = await db.request.findMany({
        where: { userId: { in: ids }, type: 'LEAVE', startDate: { gte: new Date(from + 'T00:00:00Z'), lte: new Date(to + 'T23:59:59Z') } },
        include: { leaveType: true },
      })
      const byType = new Map<string, { name: string; requests: number; availed: number; pending: number; rejected: number }>()
      for (const r of reqs) {
        const k = r.leaveTypeId ?? 'none'
        const cur = byType.get(k) ?? { name: r.leaveType?.name ?? 'Leave', requests: 0, availed: 0, pending: 0, rejected: 0 }
        cur.requests++
        if (r.status === 'APPROVED') cur.availed += r.dayCount
        else if (r.status === 'REJECTED') cur.rejected++
        else cur.pending += r.dayCount
        byType.set(k, cur)
      }

      const buf = leaveAuditPDF({
        rangeLabel,
        kpis: [
          { label: 'Leave Requests', value: String(reqs.length) },
          { label: 'Days Availed', value: String(reqs.filter((r) => r.status === 'APPROVED').reduce((s, r) => s + r.dayCount, 0)), accent: 'emerald' },
          { label: 'Pending Days', value: String(reqs.filter((r) => r.status !== 'APPROVED' && r.status !== 'REJECTED').reduce((s, r) => s + r.dayCount, 0)), accent: 'amber' },
          { label: 'Rejected', value: String(reqs.filter((r) => r.status === 'REJECTED').length), accent: 'rose' },
        ],
        utilRows: Array.from(byType.values()).map((v) => [v.name, v.requests, v.availed, v.pending, v.rejected]),
        balanceRows: balances.map((b) => {
          const total = b.carryForward + b.leaveType.annualQuota
          return [`${b.user.fullName} (${b.user.employeeCode})`, b.leaveType.name, b.carryForward,
            Math.round(b.availed * 100) / 100, b.pending, b.lapsed,
            Math.round((total - b.availed - b.pending - b.lapsed) * 100) / 100]
        }),
      })
      return new Response(new Uint8Array(buf), {
        headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="leave-audit-${from}-${to}.pdf"` },
      })
    }

    return fail('Unknown report type. Use individual | org-attendance | leave-audit.', 422)
  })
}
