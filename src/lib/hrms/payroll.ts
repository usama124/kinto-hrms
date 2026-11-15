import 'server-only'
import { db } from '@/lib/db'
import { SHORT_HOUR_STATUSES, ROLES } from '@/lib/hrms/constants'
import { getRules, getHolidayKeys } from '@/lib/hrms/policy'
import { monthStart, monthEnd, monthWorkingDays, monthRangeKeys } from '@/lib/hrms/dates'

export type PayslipCalc = {
  userId: string
  baseSalary: number
  allowances: number
  grossPay: number
  shortMinutes: number
  leaveDaysEquivalent: number
  shortConvertedFromBalance: number
  shortHourDeduction: number
  unpaidLeaveDays: number
  leaveDeduction: number
  overtimeAmount: number
  netPay: number
}

/**
 * Payroll calculator (service layer).
 *
 * Pulls per-employee, for the target month:
 *  - short minutes accrued on working days (PRESENT / SHORT_DURATION / WFH / SHORT_LEAVE)
 *  - converts every `conversionMinutes` into 1 leave-day equivalent
 *  - deducts equivalents from Casual (or Annual) leave balance when available (LEAVE_FIRST mode),
 *    otherwise prorated salary deduction at dayRate = gross / workingDays
 *  - unpaid leave days (leave types flagged isPaid=false) prorated deduction
 *  - approved overtime (worked beyond expected minutes) at configured hourly rate
 */
export async function calculateMonth(month: string): Promise<{ calc: PayslipCalc[]; workingDays: number }> {
  const rules = await getRules()
  const holidayKeys = await getHolidayKeys()
  const workingDays = monthWorkingDays(month, rules.weeklyOffDay, holidayKeys)
  const ms = monthStart(month)
  const me = monthEnd(month)

  const users = await db.user.findMany({
    where: { isActive: true, role: { notIn: [ROLES.ACCOUNTANT] } },
    include: { shift: true },
  })
  const year = Number(month.slice(0, 4))

  const calc: PayslipCalc[] = []
  for (const u of users) {
    const logs = await db.attendanceLog.findMany({
      where: { userId: u.id, dateKey: { startsWith: month } },
    })
    const shortMinutes = logs
      .filter((l) => (SHORT_HOUR_STATUSES as readonly string[]).includes(l.status))
      .reduce((s, l) => s + l.shortMinutes, 0)
    const overtimeMinutes = logs.reduce((s, l) => s + Math.max(0, l.workedMinutes - l.expectedMinutes), 0)

    const leaveDaysEquivalent = rules.conversionMinutes > 0 ? Math.floor(shortMinutes / rules.conversionMinutes) : 0

    // Casual balance first, then Annual, then prorated salary deduction
    const gross = u.baseSalary + u.allowances
    const dayRate = workingDays > 0 ? gross / workingDays : 0
    let shortConvertedFromBalance = 0
    if (rules.deductionMode === 'LEAVE_FIRST' && leaveDaysEquivalent > 0) {
      const balances = await db.leaveBalance.findMany({
        where: { userId: u.id, year, leaveType: { code: { in: ['CASUAL', 'ANNUAL'] } } },
        include: { leaveType: true },
        orderBy: { leaveTypeId: 'asc' },
      })
      const preferred = balances.find((b) => b.leaveType.code === 'CASUAL') ?? balances[0]
      if (preferred) {
        const availableDays = await availableDaysOf(u.id, preferred.leaveTypeId, year)
        shortConvertedFromBalance = Math.max(0, Math.min(leaveDaysEquivalent, availableDays))
      }
    }
    const remainingEquivalent = Math.max(0, leaveDaysEquivalent - shortConvertedFromBalance)
    const shortHourDeduction = rules.deductionMode === 'PRORATED'
      ? leaveDaysEquivalent * dayRate
      : remainingEquivalent * dayRate

    // Unpaid leave days overlapping the month
    const unpaidLeaves = await db.request.findMany({
      where: {
        userId: u.id,
        type: 'LEAVE',
        status: 'APPROVED',
        isShortLeave: false,
        startDate: { lte: me },
        endDate: { gte: ms },
        leaveType: { isPaid: false },
      },
    })
    const unpaidLeaveDays = unpaidLeaves.reduce((s, r) => s + r.dayCount, 0)
    const leaveDeduction = unpaidLeaveDays * dayRate
    const overtimeAmount = Math.round((overtimeMinutes / 60) * rules.overtimeRate * 100) / 100

    calc.push({
      userId: u.id,
      baseSalary: u.baseSalary,
      allowances: u.allowances,
      grossPay: gross,
      shortMinutes,
      leaveDaysEquivalent,
      shortConvertedFromBalance,
      shortHourDeduction: Math.round(shortHourDeduction * 100) / 100,
      unpaidLeaveDays,
      leaveDeduction: Math.round(leaveDeduction * 100) / 100,
      overtimeAmount,
      netPay: Math.round((gross - shortHourDeduction - leaveDeduction + overtimeAmount) * 100) / 100,
    })
  }
  return { calc, workingDays }
}

/** Available days for a user's leave balance = carryForward + annualQuota - availed - pending - lapsed */
export async function availableDaysOf(userId: string, leaveTypeId: string, year: number): Promise<number> {
  const b = await db.leaveBalance.findUnique({
    where: { userId_leaveTypeId_year: { userId, leaveTypeId, year } },
    include: { leaveType: true },
  })
  if (!b) return 0
  return Math.max(0, b.carryForward + b.leaveType.annualQuota - b.availed - b.pending - b.lapsed)
}

export { monthRangeKeys }
