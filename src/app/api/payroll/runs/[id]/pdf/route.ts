import { db } from '@/lib/db'
import { requireSession, guard, fail } from '@/lib/hrms/api-utils'
import { payrollRegisterPDF } from '@/lib/hrms/pdf'
import { monthLabel } from '@/lib/hrms/dates'
import { isPayrollOperator, ROLES } from '@/lib/hrms/constants'

/** Payroll Register & Payslip Bundle PDF (Accountant + Admin). */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return guard(async () => {
    const session = await requireSession()
    if (!isPayrollOperator(session.role) && session.role !== ROLES.HR_MANAGER) {
      return fail('Forbidden: Payroll module is restricted to Accountant and System Admin.', 403)
    }
    const { id } = await ctx.params
    const run = await db.payrollRun.findUnique({
      where: { id },
      include: { payslips: { include: { user: { select: { fullName: true, employeeCode: true } } } } },
    })
    if (!run) return fail('Payroll run not found.', 404)

    const buf = payrollRegisterPDF({
      monthLabel: `${monthLabel(run.month)} — ${run.status}`,
      kpis: [
        { label: 'Employees', value: String(run.payslips.length) },
        { label: 'Total Gross', value: `PKR ${run.totalGross.toLocaleString()}`, accent: 'emerald' },
        { label: 'Deductions', value: `PKR ${run.totalDeductions.toLocaleString()}`, accent: 'amber' },
        { label: 'Net Paid', value: `PKR ${run.totalNet.toLocaleString()}`, accent: 'teal' },
      ],
      rows: run.payslips.map((p) => [
        `${p.user.fullName} (${p.user.employeeCode})`,
        p.grossPay.toFixed(0),
        p.shortMinutes,
        p.shortHourDeduction.toFixed(0),
        p.unpaidLeaveDays,
        p.leaveDeduction.toFixed(0),
        p.overtimeAmount.toFixed(0),
        p.netPay.toFixed(0),
      ]),
    })
    return new Response(new Uint8Array(buf), {
      headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="payroll-register-${run.month}.pdf"` },
    })
  })
}
