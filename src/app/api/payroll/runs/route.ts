import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireSession, guard, ok, fail, HttpError } from '@/lib/hrms/api-utils'
import { isPayrollOperator, ROLES } from '@/lib/hrms/constants'
import { calculateMonthDetailed } from '@/lib/hrms/payroll-v2'
import { monthLabel, monthRangeKeys, todayKey, addDaysKey } from '@/lib/hrms/dates'
import { materializeAttendance } from '@/lib/hrms/attendance-sync'
import { writeAudit } from '@/lib/hrms/audit'

/** Payroll runs list (Accountant + System Admin; HR Manager read-only). */
export async function GET() {
  return guard(async () => {
    const session = await requireSession()
    if (!isPayrollOperator(session.role) && session.role !== ROLES.HR_MANAGER) {
      return fail('Forbidden: Payroll module is restricted to Accountant and System Admin.', 403)
    }
    const runs = await db.payrollRun.findMany({
      include: { createdBy: { select: { fullName: true } }, _count: { select: { payslips: true } } },
      orderBy: { month: 'desc' },
    })
    return ok({ runs })
  })
}

/** One-click monthly payroll run — detailed ledger (loans, tax, EOBI/PF, short-hours, unpaid leaves). */
export async function POST(req: NextRequest) {
  return guard(async () => {
    const session = await requireSession()
    if (!isPayrollOperator(session.role)) {
      return fail('Forbidden: only the Accountant or System Admin can trigger payroll runs.', 403)
    }
    const body = await req.json().catch(() => null)
    const month = String(body?.month ?? '').trim()
    if (!/^\d{4}-\d{2}$/.test(month)) return fail('Valid month required (YYYY-MM).', 422)

    const existing = await db.payrollRun.findUnique({ where: { month } })
    if (existing) return fail(`A payroll run for ${monthLabel(month)} already exists (${existing.status}).`, 409)

    // make sure punch-less working days exist as ABSENT / leave rows before deductions are computed
    const { fromKey, toKey } = monthRangeKeys(month)
    await materializeAttendance(fromKey, toKey < todayKey() ? toKey : addDaysKey(todayKey(), -1))

    const { calc } = await calculateMonthDetailed(month)
    // Atomic: run + all payslips commit together (no orphan runs on failure)
    const totals = calc.reduce((acc, c) => ({ gross: acc.gross + c.grossPay, ded: acc.ded + c.totalDeduction, net: acc.net + c.netPay }), { gross: 0, ded: 0, net: 0 })
    const run = await db.$transaction(async (tx) => {
      const r = await tx.payrollRun.create({
        data: { month, status: 'DRAFT', createdById: session.userId },
      })
      for (const c of calc) {
        await tx.payslip.create({
          data: {
          runId: r.id, userId: c.userId,
          employeeCode: c.employeeCode, fullName: c.fullName, fatherName: c.fatherName,
          designation: c.designation, departmentName: c.departmentName,
          employmentStatus: c.employmentStatus, joiningDate: c.joiningDate,
          workingDays: c.workingDays, workedDays: c.workedDays,
          paidLeaves: c.paidLeaves, unpaidLeaveDays: c.unpaidLeaveDays,
          shortMinutes: c.shortMinutes, lateMinutes: c.lateMinutes,
          leaveDaysEquivalent: c.leaveDaysEquivalent, shortConvertedFromBalance: c.shortConvertedFromBalance,
          basicSalary: c.basicSalary, hrAllowance: c.hrAllowance, utilityAllowance: c.utilityAllowance,
          providentFundEarning: c.providentFundEarning, bonus: c.bonus, arrears: c.arrears,
          overtimeAmount: c.overtimeAmount, grossPay: c.grossPay,
          internalLoan: c.internalLoan, incomeTax: c.incomeTax, providentFund: c.providentFund,
          eoobi: c.eoobi, taxAdjustment: c.taxAdjustment,
          shortHourDeduction: c.shortHourDeduction, leaveDeduction: c.leaveDeduction,
          totalDeduction: c.totalDeduction, netPay: c.netPay,
            loanStatus: c.loanStatus ? JSON.stringify(c.loanStatus) : null,
            taxStatus: JSON.stringify(c.taxStatus),
          },
        })
      }
      await tx.payrollRun.update({
        where: { id: r.id },
        data: { totalGross: Math.round(totals.gross * 100) / 100, totalDeductions: Math.round(totals.ded * 100) / 100, totalNet: Math.round(totals.net * 100) / 100 },
      })
      return r
    }, { timeout: 30_000 }).catch((e) => {
      // month is unique: a concurrent run for the same month loses cleanly instead of a 500
      if ((e as { code?: string })?.code === 'P2002') throw new HttpError(409, `A payroll run for ${monthLabel(month)} already exists.`)
      throw e
    })

    await writeAudit({
      actorId: session.userId, actorName: session.fullName, actorRole: session.role,
      entityType: 'PAYROLL', entityId: run.id,
      reason: `Payroll run created for ${monthLabel(month)} (${calc.length} employees)`,
      ipAddress: req.headers.get('x-forwarded-for') ?? null,
      meta: JSON.stringify({ month, employees: calc.length, gross: totals.gross, net: totals.net }),
    })

    return ok({
      run: { id: run.id, month, status: 'DRAFT', totalGross: totals.gross, totalDeductions: totals.ded, totalNet: totals.net },
      payslips: calc.length,
    }, { status: 201 })
  })
}

export const dynamic = 'force-dynamic'
