import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireSession, guard, fail } from '@/lib/hrms/api-utils'
import { isPayrollOperator } from '@/lib/hrms/constants'
import { payslipCollectionPDF, type SalarySlipInput } from '@/lib/hrms/pdf-payslip'
import { monthLabel, fmtDateKey } from '@/lib/hrms/dates'
import { writeAudit } from '@/lib/hrms/audit'
import { cleanMonth } from '@/lib/hrms/sanitize'

/** Bulk salary slip collection — one page per employee for a month. */
export async function GET(req: NextRequest) {
  return guard(async () => {
    const session = await requireSession()
    if (!isPayrollOperator(session.role)) return fail('Forbidden.', 403)

    const month = req.nextUrl.searchParams.get('month') ?? ''
    if (!cleanMonth(month)) return fail('Valid month required (YYYY-MM).', 422)

    const run = await db.payrollRun.findUnique({
      where: { month },
      include: { payslips: { orderBy: { employeeCode: 'asc' } } },
    })
    if (!run || !run.payslips.length) return fail('No payroll run for this month.', 404)

    const companyRow = await db.setting.findUnique({ where: { key: 'company.profile' } })
    const company = companyRow ? JSON.parse(companyRow.value) : { name: 'KINTO HRMS', address: 'Karachi, Pakistan' }

    const inputs: SalarySlipInput[] = run.payslips.map((p) => ({
      companyName: company.name,
      companyAddress: company.address,
      monthLabel: monthLabel(run.month),
      issueDate: fmtDateKey(new Date().toISOString().slice(0, 10)),
      slip: {
        employeeCode: p.employeeCode, fullName: p.fullName, fatherName: p.fatherName,
        designation: p.designation, departmentName: p.departmentName,
        employmentStatus: p.employmentStatus,
        joiningDate: p.joiningDate ? fmtDateKey(p.joiningDate.toISOString().slice(0, 10)) : '—',
        paymentMode: p.paymentMode,
        basicSalary: p.basicSalary, hrAllowance: p.hrAllowance, utilityAllowance: p.utilityAllowance,
        providentFundEarning: p.providentFundEarning, bonus: p.bonus, arrears: p.arrears,
        grossPay: p.grossPay, internalLoan: p.internalLoan, incomeTax: p.incomeTax,
        providentFund: p.providentFund, eoobi: p.eoobi, taxAdjustment: p.taxAdjustment,
        shortHourDeduction: p.shortHourDeduction, leaveDeduction: p.leaveDeduction,
        totalDeduction: p.totalDeduction, netPay: p.netPay,
        workingDays: p.workingDays, workedDays: p.workedDays, shortMinutes: p.shortMinutes,
        loanStatus: p.loanStatus ? JSON.parse(p.loanStatus) : null,
        taxStatus: p.taxStatus ? JSON.parse(p.taxStatus) : { taxableEarning: 0, taxLiability: 0, taxPaid: 0, balance: 0 },
      },
    }))

    const buf = payslipCollectionPDF(inputs)
    await writeAudit({
      actorId: session.userId, actorName: session.fullName, actorRole: session.role,
      entityType: 'PAYROLL', entityId: run.id,
      reason: `Bulk salary slip collection exported for ${monthLabel(month)} (${inputs.length} slips)`,
    })
    return new Response(new Uint8Array(buf), {
      headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="salary-slips-${month}.pdf"` },
    })
  })
}

export const dynamic = 'force-dynamic'
