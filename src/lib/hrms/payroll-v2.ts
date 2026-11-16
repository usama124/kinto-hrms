import 'server-only'
import type { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { SHORT_HOUR_STATUSES, WORKED_STATUS_SET } from '@/lib/hrms/constants'
import { getRules } from '@/lib/hrms/policy'
import { resolveShiftForUser, holidayKeysFor } from '@/lib/hrms/attendance-engine'
import { monthStart, monthEnd, monthRangeKeys } from '@/lib/hrms/dates'

export type PayrollConfig = {
  pfRate: number
  eoobiAmount: number
  eoobiThreshold: number
  taxSlabs: { upto: number | null; rate: number }[]
}

export async function getPayrollConfig(): Promise<PayrollConfig> {
  const row = await db.setting.findUnique({ where: { key: 'payroll.config' } })
  if (!row) return { pfRate: 0.05, eoobiAmount: 500, eoobiThreshold: 26000, taxSlabs: [{ upto: null, rate: 0 }] }
  return JSON.parse(row.value) as PayrollConfig
}

export function monthlyTaxFromSlabs(taxable: number, slabs: PayrollConfig['taxSlabs']): number {
  let tax = 0
  let prev = 0
  for (const slab of slabs) {
    const upper = slab.upto == null ? Infinity : slab.upto
    if (taxable > prev) {
      tax += ((Math.min(taxable, upper) - prev) * slab.rate) / 100
      prev = upper
    }
  }
  return Math.round(tax)
}

export type DetailedCalc = {
  userId: string
  // snapshot
  employeeCode: string
  fullName: string
  fatherName: string | null
  designation: string
  departmentName: string
  employmentStatus: string
  joiningDate: Date | null
  // aggregates
  workingDays: number
  workedDays: number
  paidLeaves: number
  unpaidLeaveDays: number
  absentUninformed: number
  shortMinutes: number
  lateMinutes: number
  leaveDaysEquivalent: number
  shortConvertedFromBalance: number
  // earnings
  basicSalary: number
  hrAllowance: number
  utilityAllowance: number
  providentFundEarning: number
  bonus: number
  arrears: number
  overtimeAmount: number
  grossPay: number
  // deductions
  internalLoan: number
  incomeTax: number
  providentFund: number
  eoobi: number
  taxAdjustment: number
  shortHourDeduction: number
  leaveDeduction: number
  totalDeduction: number
  netPay: number
  // statuses
  loanStatus: { loanId?: string; loanAmount: number; instNo: number; instAmount: number; paid: number; balance: number } | null
  taxStatus: { taxableEarning: number; taxLiability: number; taxPaid: number; balance: number }
}

/** Balance that absorbs short-hour leave conversions: Casual first, else Annual. Shared by calculation and finalize. */
export async function pickShortConversionBalance(client: Prisma.TransactionClient, userId: string, year: number) {
  const balances = await client.leaveBalance.findMany({
    where: { userId, year, leaveType: { code: { in: ['CASUAL', 'ANNUAL'] } } },
    include: { leaveType: true },
  })
  return balances.find((b) => b.leaveType.code === 'CASUAL') ?? balances.find((b) => b.leaveType.code === 'ANNUAL') ?? null
}

/** Available days = carryForward + quota - availed - pending - lapsed. */
export async function availableDaysOf(userId: string, leaveTypeId: string, year: number): Promise<number> {
  const b = await db.leaveBalance.findUnique({
    where: { userId_leaveTypeId_year: { userId, leaveTypeId, year } },
    include: { leaveType: true },
  })
  if (!b) return 0
  return Math.max(0, b.carryForward + b.leaveType.annualQuota - b.availed - b.pending - b.lapsed)
}

/**
 * Detailed payroll calculator — builds the complete ledger per employee:
 * working/worked days (shift-aware), paid & unpaid leaves, uninformed absences,
 * short-hours → leave-day conversion (Casual → Annual → prorated salary),
 * bonus/arrears, loan installments, EOBI/PF contributions and progressive income tax.
 */
export async function calculateMonthDetailed(month: string): Promise<{ calc: DetailedCalc[]; config: PayrollConfig }> {
  const config = await getPayrollConfig()
  const rules = await getRules()
  const holidays = await holidayKeysFor()
  const { fromKey, toKey } = monthRangeKeys(month)
  const ms = monthStart(month)
  const me = monthEnd(month)
  const year = Number(month.slice(0, 4))
  void toKey

  const users = await db.user.findMany({
    where: { isActive: true, role: { notIn: ['SUPER_ADMIN'] } },
    include: { department: true, team: true },
    orderBy: { employeeCode: 'asc' },
  })

  const calc: DetailedCalc[] = []

  for (const u of users) {
    const shift = await resolveShiftForUser(u.id)

    // shift-aware scheduled working days for this month
    const workingDays = countWorkingDays(month, shift.workingDays, holidays)
    const dayRate = workingDays > 0 ? (u.baseSalary + u.hrAllowance + u.utilityAllowance) / workingDays : 0
    const hourlyRate = workingDays > 0 ? dayRate / (shift.expectedMinutes / 60) : 0

    const logs = await db.attendanceLog.findMany({ where: { userId: u.id, dateKey: { gte: fromKey, lte: toKey } } })
    const shortMinutes = logs
      .filter((l) => (SHORT_HOUR_STATUSES as readonly string[]).includes(l.status))
      .reduce((s, l) => s + l.shortMinutes, 0)
    const lateMinutes = logs.reduce((s, l) => s + l.lateMinutes, 0)
    const workedDays = logs.filter((l) => (WORKED_STATUS_SET as readonly string[]).includes(l.status)).length
    const absentUninformed = logs.filter((l) => l.status === 'ABSENT').length

    // paid / unpaid approved leaves overlapping the month
    const leaves = await db.request.findMany({
      where: {
        userId: u.id, type: 'LEAVE', status: 'APPROVED', isShortLeave: false,
        startDate: { lte: me }, endDate: { gte: ms },
      },
      include: { leaveType: true },
    })
    let paidLeaves = 0
    let unpaidLeaveDays = 0
    for (const r of leaves) {
      if (r.leaveType?.isPaid) paidLeaves += r.dayCount
      else unpaidLeaveDays += r.dayCount
    }
    const leaveDeduction = round2((absentUninformed + unpaidLeaveDays) * dayRate)

    // short-hours → leave-day conversion (LEAVE_FIRST: Casual then Annual, else prorated)
    const leaveDaysEquivalent = rules.conversionMinutes > 0 ? Math.floor(shortMinutes / rules.conversionMinutes) : 0
    let shortConvertedFromBalance = 0
    if (rules.deductionMode === 'LEAVE_FIRST' && leaveDaysEquivalent > 0) {
      // Pure calculation — the balance is debited once, at finalize (see finalize route)
      const preferred = await pickShortConversionBalance(db, u.id, year)
      if (preferred) {
        const available = await availableDaysOf(u.id, preferred.leaveTypeId, year)
        shortConvertedFromBalance = Math.min(leaveDaysEquivalent, Math.floor(available))
      }
    }
    const remainingEquivalent = Math.max(0, leaveDaysEquivalent - shortConvertedFromBalance)
    const shortHourDeduction = rules.deductionMode === 'PRORATED'
      ? round2(leaveDaysEquivalent * dayRate)
      : round2(remainingEquivalent * dayRate)

    // bonus / arrears
    const adj = await db.monthlyAdjustment.findUnique({ where: { userId_month: { userId: u.id, month } } })
    const bonus = adj?.bonus ?? 0
    const arrears = adj?.arrears ?? 0

    // earnings
    const pf = Math.round(u.baseSalary * config.pfRate)
    const overtimeMinutes = logs.reduce((s, l) => s + Math.max(0, l.workedMinutes - l.expectedMinutes), 0)
    const overtimeAmount = round2((overtimeMinutes / 60) * rules.overtimeRate)
    const baseGross = u.baseSalary + u.hrAllowance + u.utilityAllowance + bonus + arrears
    const grossPay = baseGross + pf

    // loan installment (first active loan with remaining installments)
    const activeLoans = await db.loan.findMany({ where: { userId: u.id, isActive: true }, orderBy: { createdAt: 'asc' } })
    const loan = activeLoans.find((l) => l.paidInstallments < l.installments) ?? null
    let internalLoan = 0
    let loanStatus: DetailedCalc['loanStatus'] = null
    if (loan) {
      const balance = Math.max(0, loan.loanAmount - loan.paidInstallments * loan.installmentAmount)
      internalLoan = Math.min(loan.installmentAmount, balance)
      loanStatus = {
        loanId: loan.id, // lets finalize advance exactly this loan
        loanAmount: loan.loanAmount,
        instNo: loan.paidInstallments + 1,
        instAmount: internalLoan,
        paid: loan.paidInstallments * loan.installmentAmount,
        balance: Math.max(0, balance - internalLoan),
      }
    }

    // contributions & tax
    const eoobi = u.baseSalary >= config.eoobiThreshold ? config.eoobiAmount : 0
    const taxableEarning = Math.max(0, grossPay - pf - eoobi)
    const incomeTax = monthlyTaxFromSlabs(taxableEarning, config.taxSlabs)
    const taxStatus = { taxableEarning, taxLiability: incomeTax, taxPaid: incomeTax, balance: 0 }

    const totalDeduction = round2(internalLoan + incomeTax + pf + eoobi + shortHourDeduction + leaveDeduction)
    const netPay = round2(grossPay - totalDeduction + overtimeAmount)

    calc.push({
      userId: u.id,
      employeeCode: u.employeeCode,
      fullName: u.fullName,
      fatherName: u.fatherName,
      designation: u.designation,
      departmentName: u.department?.name ?? '—',
      employmentStatus: u.employmentStatus,
      joiningDate: u.joiningDate,
      workingDays,
      workedDays,
      paidLeaves: round2(paidLeaves),
      unpaidLeaveDays: round2(unpaidLeaveDays + absentUninformed),
      absentUninformed,
      shortMinutes,
      lateMinutes,
      leaveDaysEquivalent,
      shortConvertedFromBalance,
      basicSalary: u.baseSalary,
      hrAllowance: u.hrAllowance,
      utilityAllowance: u.utilityAllowance,
      providentFundEarning: pf,
      bonus,
      arrears,
      overtimeAmount,
      grossPay: round2(grossPay),
      internalLoan: round2(internalLoan),
      incomeTax,
      providentFund: pf,
      eoobi,
      taxAdjustment: 0,
      shortHourDeduction,
      leaveDeduction,
      totalDeduction,
      netPay,
      loanStatus,
      taxStatus,
    })
  }

  return { calc, config }
}

function countWorkingDays(month: string, workingDaysIso: number[], holidays: Set<string>): number {
  const { fromKey, toKey } = monthRangeKeys(month)
  const [y, m] = month.split('-').map(Number)
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  let count = 0
  for (let d = 1; d <= last; d++) {
    const key = `${month}-${String(d).padStart(2, '0')}`
    if (holidays.has(key)) continue
    const wd = weekdayOfKey(key)
    if (workingDaysIso.includes(wd)) count++
  }
  return count
}

function weekdayOfKey(key: string): number {
  const [y, m, d] = key.split('-').map(Number)
  const w = new Date(Date.UTC(y, m - 1, d)).getUTCDay()
  return w === 0 ? 7 : w
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
