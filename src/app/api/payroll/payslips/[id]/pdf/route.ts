import { db } from '@/lib/db'
import { requireSession, guard, fail } from '@/lib/hrms/api-utils'
import { payslipSlipPDF } from '@/lib/hrms/pdf-payslip'
import { monthLabel, fmtDateKey } from '@/lib/hrms/dates'
import { isPayrollOperator, isOrgAdmin } from '@/lib/hrms/constants'

/** Detailed salary slip PDF — owner, Accountant or org Admin only. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return guard(async () => {
    const session = await requireSession()
    const { id } = await ctx.params
    const p = await db.payslip.findUnique({
      where: { id },
      include: { user: true, run: true },
    })
    if (!p) return fail('Payslip not found.', 404)

    // owner, payroll operators and HR/Admin only (no supervisor access); owners get finalized slips only
    const privileged = isPayrollOperator(session.role) || isOrgAdmin(session.role)
    if (!privileged && p.userId !== session.userId) return fail('Forbidden: you cannot download this payslip.', 403)
    if (!privileged && p.run.status !== 'FINALIZED') return fail('This payslip is not finalized yet.', 403)

    const companyRow = await db.setting.findUnique({ where: { key: 'company.profile' } })
    const company = companyRow ? JSON.parse(companyRow.value) : { name: 'KINTO HRMS', address: 'Karachi, Pakistan' }

    const buf = payslipSlipPDF({
      companyName: company.name,
      companyAddress: company.address,
      monthLabel: monthLabel(p.run.month),
      issueDate: fmtDateKey(new Date().toISOString().slice(0, 10)),
      slip: {
        employeeCode: p.employeeCode,
        fullName: p.fullName,
        fatherName: p.fatherName,
        designation: p.designation,
        departmentName: p.departmentName,
        employmentStatus: p.employmentStatus,
        joiningDate: p.joiningDate ? fmtDateKey(p.joiningDate.toISOString().slice(0, 10)) : '—',
        paymentMode: p.paymentMode,
        basicSalary: p.basicSalary,
        hrAllowance: p.hrAllowance,
        utilityAllowance: p.utilityAllowance,
        providentFundEarning: p.providentFundEarning,
        bonus: p.bonus,
        arrears: p.arrears,
        grossPay: p.grossPay,
        internalLoan: p.internalLoan,
        incomeTax: p.incomeTax,
        providentFund: p.providentFund,
        eoobi: p.eoobi,
        taxAdjustment: p.taxAdjustment,
        shortHourDeduction: p.shortHourDeduction,
        leaveDeduction: p.leaveDeduction,
        totalDeduction: p.totalDeduction,
        netPay: p.netPay,
        workingDays: p.workingDays,
        workedDays: p.workedDays,
        shortMinutes: p.shortMinutes,
        loanStatus: p.loanStatus ? JSON.parse(p.loanStatus) : null,
        taxStatus: p.taxStatus ? JSON.parse(p.taxStatus) : { taxableEarning: 0, taxLiability: 0, taxPaid: 0, balance: 0 },
      },
    })
    return new Response(new Uint8Array(buf), {
      headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="salary-slip-${p.employeeCode}-${p.run.month}.pdf"` },
    })
  })
}

export const dynamic = 'force-dynamic'
