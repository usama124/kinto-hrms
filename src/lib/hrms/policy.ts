import 'server-only'
import { db } from '@/lib/db'
import { DEFAULT_RULES, POLICY_KEYS, REQUEST_STATUS } from '@/lib/hrms/constants'
import { workingDaysBetween, parseKey, weekdayOf, daysBetweenInclusive, dayKey } from '@/lib/hrms/dates'
import { availableDaysOf } from '@/lib/hrms/payroll'

export type Rules = {
  shiftDurationMinutes: number
  graceMinutes: number
  weeklyOffDay: number
  conversionMinutes: number
  deductionMode: 'LEAVE_FIRST' | 'PRORATED'
  shortLeaveMaxHours: number
  overtimeRate: number
  raw: { key: string; value: string; label: string; category: string; updatedAt: Date }[]
}

/** Load policy rules (service layer). Falls back to defaults for missing keys. */
export async function getRules(): Promise<Rules> {
  const rows = await db.policyRule.findMany()
  const map = new Map(rows.map((r) => [r.key, r.value]))
  const num = (k: string, dflt: number) => {
    const v = Number(map.get(DEFAULT_RULES[k]?.key ?? k) ?? DEFAULT_RULES[k]?.value)
    return Number.isFinite(v) ? v : dflt
  }
  const modeRaw = map.get(POLICY_KEYS.SHORT_DEDUCTION_MODE) ?? DEFAULT_RULES[POLICY_KEYS.SHORT_DEDUCTION_MODE].value
  return {
    shiftDurationMinutes: num(POLICY_KEYS.SHIFT_DURATION, 540),
    graceMinutes: num(POLICY_KEYS.GRACE_MINUTES, 15),
    weeklyOffDay: num(POLICY_KEYS.WEEKLY_OFF_DAY, 0),
    conversionMinutes: num(POLICY_KEYS.SHORT_CONVERSION_MINUTES, 480),
    deductionMode: modeRaw === 'PRORATED' ? 'PRORATED' : 'LEAVE_FIRST',
    shortLeaveMaxHours: num(POLICY_KEYS.SHORT_LEAVE_MAX_HOURS, 3),
    overtimeRate: num(POLICY_KEYS.OVERTIME_RATE, 250),
    raw: rows.map((r) => ({ key: r.key, value: r.value, label: r.label, category: r.category, updatedAt: r.updatedAt })),
  }
}

export async function getHolidayKeys(year?: number): Promise<Set<string>> {
  const rows = await db.holiday.findMany()
  return new Set(rows.map((h) => h.date))
}

/** Working days (excluding weekly off & holidays) for a request's inclusive range. */
export function computeDayCount(fromKey: string, toKey: string, rules: Rules, holidayKeys: Set<string>): number {
  const days = workingDaysBetween(fromKey, toKey, rules.weeklyOffDay, holidayKeys)
  return Math.max(1, days.length)
}

export type ValidationResult = { ok: true; dayCount: number } | { ok: false; code: number; error: string }

type RequestInput = {
  type: string
  leaveTypeId?: string | null
  startDate: string // YYYY-MM-DD
  endDate: string
  isShortLeave: boolean
  shortHours: number
  attachmentName?: string | null
}

/**
 * Karachi-TZ-safe month overlap: fetch the user's non-rejected leaves of a type
 * and count days of requests whose [startKey,endKey] range intersects the month.
 */
async function usedDaysInMonth(userId: string, leaveTypeId: string, month: string, includeShort: boolean): Promise<number> {
  const rows = await db.request.findMany({
    where: {
      userId,
      type: 'LEAVE',
      leaveTypeId,
      status: { in: [REQUEST_STATUS.APPROVED, REQUEST_STATUS.PENDING_TEAM_LEAD, REQUEST_STATUS.PENDING_MANAGER] },
    },
    select: { startDate: true, endDate: true, dayCount: true, isShortLeave: true },
  })
  let used = 0
  for (const r of rows) {
    if (r.isShortLeave && !includeShort) continue
    const startK = dayKey(r.startDate)
    const endK = dayKey(r.endDate)
    if (startK.slice(0, 7) === month || endK.slice(0, 7) === month || (startK.slice(0, 7) < month && endK.slice(0, 7) > month)) {
      used += r.dayCount
    }
  }
  return used
}

/**
 * Dynamic HR rules engine — enforces monthly caps, conditional attachments,
 * short-leave constraints and non-working day counting. Runs BEFORE a request
 * is persisted (repository write gate).
 */
export async function validateRequest(userId: string, input: RequestInput): Promise<ValidationResult> {
  const rules = await getRules()
  const holidayKeys = await getHolidayKeys()

  if (input.endDate < input.startDate) return { ok: false, code: 422, error: 'End date cannot be before start date.' }

  const monthOfStart = input.startDate.slice(0, 7)

  if (input.type === 'LEAVE') {
    if (!input.leaveTypeId) return { ok: false, code: 422, error: 'Leave type is required.' }
    const leaveType = await db.leaveType.findUnique({ where: { id: input.leaveTypeId } })
    if (!leaveType) return { ok: false, code: 422, error: 'Invalid leave type.' }

    // Short-leave constraints
    if (input.isShortLeave) {
      if (input.shortHours <= 0) return { ok: false, code: 422, error: 'Short leave requires hours.' }
      if (input.shortHours > rules.shortLeaveMaxHours)
        return { ok: false, code: 422, error: `Short leave cannot exceed ${rules.shortLeaveMaxHours} hours.` }
      const dayCount = Math.round((input.shortHours / (rules.shiftDurationMinutes / 60)) * 100) / 100
      return { ok: true, dayCount }
    }

    const dayCount = computeDayCount(input.startDate, input.endDate, rules, holidayKeys)

    // HARD annual-quota gate — no negative balances allowed
    if (input.leaveTypeId) {
      const year = Number(input.startDate.slice(0, 4))
      const available = await availableDaysOf(userId, input.leaveTypeId, year)
      if (dayCount > available) {
        return {
          ok: false,
          code: 422,
          error: `Insufficient leave balance: requesting ${dayCount} day(s) but only ${available} day(s) available. Quota increments require Admin approval.`,
        }
      }
    }

    // Monthly cap rule: availed (approved) + pending days of this type in the calendar month
    if (leaveType.monthlyCap != null) {
      const usedDays = await usedDaysInMonth(userId, leaveType.id, monthOfStart, false)
      if (usedDays + dayCount > leaveType.monthlyCap) {
        return {
          ok: false,
          code: 422,
          error: `Monthly cap exceeded: ${leaveType.name} allows max ${leaveType.monthlyCap} day(s) in this month. Already used ${usedDays}, requested ${dayCount}.`,
        }
      }
    }

    // Conditional attachment rule (e.g., medical certificate for sick leave)
    if (leaveType.attachmentThreshold != null) {
      const usedDays = await usedDaysInMonth(userId, leaveType.id, monthOfStart, true)
      if (usedDays >= leaveType.attachmentThreshold && !input.attachmentName) {
        return {
          ok: false,
          code: 422,
          error: `${leaveType.name} leave beyond ${leaveType.attachmentThreshold} day(s) this month requires a supporting document (e.g., medical certificate). Please attach a file.`,
        }
      }
    }

    return { ok: true, dayCount }
  }

  // OFFICIAL_DUTY / TRAVEL
  const dayCount = computeDayCount(input.startDate, input.endDate, rules, holidayKeys)
  return { ok: true, dayCount }
}

/** Shift preview for the create-request modal: working-day breakdown of a range. */
export function previewRange(fromKey: string, toKey: string, rules: Rules, holidayKeys: Set<string>) {
  const days = workingDaysBetween(fromKey, toKey, rules.weeklyOffDay, holidayKeys)
  const all = daysBetweenInclusive(fromKey, toKey)
  const excluded = all - days.length
  return {
    calendarDays: all,
    workingDays: days.length,
    excludedDays: excluded,
    days: Array.from({ length: Math.min(all, 14) }, (_, i) => {
      const d = new Date(parseKey(fromKey).getTime() + i * 86400000)
      const key = d.toISOString().slice(0, 10)
      const isWeeklyOff = weekdayOf(key) === rules.weeklyOffDay
      const isHoliday = holidayKeys.has(key)
      return { key, isWeeklyOff, isHoliday, isWorking: !isWeeklyOff && !isHoliday }
    }),
  }
}
