import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireSession, guard, fail } from '@/lib/hrms/api-utils'
import { isPayrollOperator } from '@/lib/hrms/constants'
import { payrollMasterSheet } from '@/lib/hrms/excel'
import { monthLabel } from '@/lib/hrms/dates'
import { writeAudit } from '@/lib/hrms/audit'
import { cleanMonth } from '@/lib/hrms/sanitize'

/**
 * GET /api/payroll/excel?month=YYYY-MM — formatted .xlsx Payroll Master Sheet
 * with the exact column contract (21 columns + styled totals row).
 */
export async function GET(req: NextRequest) {
  return guard(async () => {
    const session = await requireSession()
    if (!isPayrollOperator(session.role)) {
      return fail('Forbidden: Excel export is restricted to Accountant and System Admin.', 403)
    }
    const month = req.nextUrl.searchParams.get('month') ?? ''
    if (!cleanMonth(month)) return fail('Valid month required (YYYY-MM).', 422)

    const run = await db.payrollRun.findUnique({
      where: { month },
      include: { payslips: { orderBy: { employeeCode: 'asc' } } },
    })
    if (!run) return fail('No payroll run exists for this month — run payroll first.', 404)

    const rows = run.payslips.map((p) => ({
      userId: p.userId, employeeCode: p.employeeCode, fullName: p.fullName, fatherName: p.fatherName,
      designation: p.designation, departmentName: p.departmentName, employmentStatus: p.employmentStatus,
      joiningDate: p.joiningDate, workingDays: p.workingDays, workedDays: p.workedDays,
      paidLeaves: p.paidLeaves, unpaidLeaveDays: p.unpaidLeaveDays, absentUninformed: 0,
      shortMinutes: p.shortMinutes, lateMinutes: p.lateMinutes, leaveDaysEquivalent: p.leaveDaysEquivalent,
      shortConvertedFromBalance: p.shortConvertedFromBalance,
      basicSalary: p.basicSalary, hrAllowance: p.hrAllowance, utilityAllowance: p.utilityAllowance,
      providentFundEarning: p.providentFundEarning, bonus: p.bonus, arrears: p.arrears,
      overtimeAmount: p.overtimeAmount, grossPay: p.grossPay,
      internalLoan: p.internalLoan, incomeTax: p.incomeTax, providentFund: p.providentFund,
      eoobi: p.eoobi, taxAdjustment: p.taxAdjustment, shortHourDeduction: p.shortHourDeduction,
      leaveDeduction: p.leaveDeduction, totalDeduction: p.totalDeduction, netPay: p.netPay,
      loanStatus: p.loanStatus ? JSON.parse(p.loanStatus) : null,
      taxStatus: p.taxStatus ? JSON.parse(p.taxStatus) : { taxableEarning: 0, taxLiability: 0, taxPaid: 0, balance: 0 },
    }))

    const companyRow = await db.setting.findUnique({ where: { key: 'company.profile' } })
    const company = companyRow ? JSON.parse(companyRow.value) : { name: 'KINTO HRMS' }

    const buf = await payrollMasterSheet(monthLabel(month), rows, company.name)
    await writeAudit({
      actorId: session.userId, actorName: session.fullName, actorRole: session.role,
      entityType: 'PAYROLL', entityId: run.id,
      reason: `Excel master sheet exported for ${monthLabel(month)}`,
      ipAddress: req.headers.get('x-forwarded-for') ?? null,
    })
    return new Response(new Uint8Array(buf), {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="payroll-master-${month}.xlsx"`,
      },
    })
  })
}

export const dynamic = 'force-dynamic'
