import 'server-only'
import { db } from '@/lib/db'
import { ATT_STATUS } from '@/lib/hrms/constants'
import { dayKey, dateTimeFor, minutesSinceMidnightKarachi, weekdayOf, eachDayKey } from '@/lib/hrms/dates'

// ─── Shift resolution: user → team → department → global default ─────────────

export type ResolvedShift = {
  id: string
  name: string
  startTime: string
  endTime: string
  expectedMinutes: number
  graceMinutes: number
  workingDays: number[] // ISO weekdays 1=Mon..7=Sun
}

function parseWorkingDays(json: string | null | undefined, fallback: number[]): number[] {
  try {
    const arr = JSON.parse(json ?? '[]')
    return Array.isArray(arr) && arr.length ? arr.map(Number).filter((n) => n >= 1 && n <= 7) : fallback
  } catch {
    return fallback
  }
}

export const DEFAULT_SHIFT: ResolvedShift = {
  id: 'default', name: 'Default (9 AM – 6 PM)',
  startTime: '09:00', endTime: '18:00', expectedMinutes: 540, graceMinutes: 15,
  workingDays: [1, 2, 3, 4, 5],
}

export async function resolveShiftForUser(userId: string): Promise<ResolvedShift> {
  const user = await db.user.findUnique({
    where: { id: userId },
    include: { shift: true, team: { include: { shift: true } }, department: { include: { shift: true } } },
  })
  const shift = user?.shift ?? user?.team?.shift ?? user?.department?.shift
  if (!shift) return DEFAULT_SHIFT
  return {
    id: shift.id, name: shift.name,
    startTime: shift.startTime, endTime: shift.endTime,
    expectedMinutes: shift.expectedMinutes, graceMinutes: shift.graceMinutes,
    workingDays: parseWorkingDays(shift.workingDays, [1, 2, 3, 4, 5]),
  }
}

export function isoWeekdayOf(dateKey: string): number {
  const w = weekdayOf(dateKey)
  return w === 0 ? 7 : w
}

export async function holidayKeysFor(): Promise<Set<string>> {
  const rows = await db.holiday.findMany()
  return new Set(rows.map((h) => h.date))
}

export function isWorkingDay(dateKey: string, shift: ResolvedShift, holidays: Set<string>): boolean {
  return !holidays.has(dateKey) && shift.workingDays.includes(isoWeekdayOf(dateKey))
}

/** Expected minutes for a given calendar day (0 on rest days/holidays). */
export function expectedMinutesFor(dateKey: string, shift: ResolvedShift, holidays: Set<string>): number {
  return isWorkingDay(dateKey, shift, holidays) ? shift.expectedMinutes : 0
}

// ─── Punch → record computation ───────────────────────────────────────────────

export type ComputedAttendance = {
  checkIn: Date | null
  checkOut: Date | null
  workedMinutes: number
  shortMinutes: number
  lateMinutes: number
  earlyMinutes: number
  status: string
}

/**
 * Derive worked/short/late/early/status from a single day's punches.
 * First punch = Check-In, last punch = Check-Out (ZKTeco semantics).
 */
export function computeFromPunches(
  dateKey: string,
  punches: { ts: Date; status: number | null }[],
  shift: ResolvedShift,
  holidays: Set<string>,
): ComputedAttendance {
  const sorted = [...punches].sort((a, b) => a.ts.getTime() - b.ts.getTime())
  const expected = expectedMinutesFor(dateKey, shift, holidays)

  if (expected === 0) {
    return {
      checkIn: sorted[0]?.ts ?? null, checkOut: sorted.at(-1)?.ts ?? null,
      workedMinutes: 0, shortMinutes: 0, lateMinutes: 0, earlyMinutes: 0,
      status: holidays.has(dateKey) ? ATT_STATUS.HOLIDAY : ATT_STATUS.DAY_OFF,
    }
  }
  if (sorted.length === 0) {
    return { checkIn: null, checkOut: null, workedMinutes: 0, shortMinutes: 0, lateMinutes: 0, earlyMinutes: 0, status: ATT_STATUS.ABSENT }
  }

  const checkIn = sorted[0].ts
  const checkOut = sorted.length >= 2 ? sorted[sorted.length - 1].ts : null
  const startMin = timeToMinutes(shift.startTime)
  const endMin = timeToMinutes(shift.endTime)
  const inMin = minutesSinceMidnightKarachi(checkIn)
  const outMin = checkOut ? minutesSinceMidnightKarachi(checkOut) : null

  const lateMinutes = Math.max(0, inMin - startMin - shift.graceMinutes)
  const earlyMinutes = outMin != null ? Math.max(0, endMin - outMin - shift.graceMinutes) : 0
  // Arrival inside the grace window (or early) counts from shift start; a later arrival is
  // deducted in full so late check-ins now produce short minutes (was Math.min → never short).
  const arrival = inMin <= startMin + shift.graceMinutes ? Math.min(inMin, startMin) : inMin
  const workedMinutes = outMin != null ? Math.max(0, Math.min(outMin, endMin) - arrival) : 0
  const shortMinutes = Math.max(0, expected - workedMinutes)

  let status: string
  if (checkOut == null) status = ATT_STATUS.MISSING
  else if (shortMinutes === 0) status = ATT_STATUS.PRESENT
  else status = ATT_STATUS.SHORT_DURATION

  return { checkIn, checkOut, workedMinutes, shortMinutes, lateMinutes, earlyMinutes, status }
}

function timeToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

/** Upsert an AttendanceLog from computed values. */
export async function upsertLogFromComputed(
  userId: string,
  dateKey: string,
  computed: ComputedAttendance,
  shift: ResolvedShift,
  opts: { source?: string; isManuallyUpdated?: boolean; notes?: string | null; isWFH?: boolean } = {},
) {
  const data = {
    checkIn: computed.checkIn,
    checkOut: computed.checkOut,
    status: computed.status,
    expectedMinutes: expectedMinutesFor(dateKey, shift, await holidayKeysFor()),
    workedMinutes: computed.workedMinutes,
    shortMinutes: computed.shortMinutes,
    lateMinutes: computed.lateMinutes,
    earlyMinutes: computed.earlyMinutes,
    source: opts.source ?? 'BIOMETRIC',
    isManuallyUpdated: opts.isManuallyUpdated ?? false,
    notes: opts.notes ?? undefined,
    isWFH: opts.isWFH ?? false,
  }
  return db.attendanceLog.upsert({
    where: { userId_dateKey: { userId, dateKey } },
    create: { userId, dateKey, ...data },
    update: data,
  })
}

/** Group raw punches by (user, day) and rebuild each day's record. */
export async function applyPunches(punches: { pin: string; ts: Date; status: number | null }[], source = 'BIOMETRIC'): Promise<{ processed: number; skipped: number; days: number }> {
  const holidays = await holidayKeysFor()
  const usersByPin = new Map<string, { id: string }>()
  const byUserDay = new Map<string, typeof punches>()

  for (const p of punches) {
    if (!usersByPin.has(p.pin)) {
      const u = await db.user.findUnique({ where: { employeeCode: p.pin }, select: { id: true } })
      usersByPin.set(p.pin, u ?? { id: '' })
    }
    const user = usersByPin.get(p.pin)!
    if (!user.id) continue
    const dateKey = dayKey(p.ts)
    const key = `${user.id}|${dateKey}`
    if (!byUserDay.has(key)) byUserDay.set(key, [])
    byUserDay.get(key)!.push(p)
  }

  let days = 0
  for (const [key, group] of byUserDay) {
    const [userId, dateKey] = key.split('|')
    // never clobber an HR adjustment / approved regularization with raw device data
    const existing = await db.attendanceLog.findUnique({ where: { userId_dateKey: { userId, dateKey } }, select: { isManuallyUpdated: true } })
    if (existing?.isManuallyUpdated) continue
    // rebuild from EVERY stored punch of the day: a later batch may carry only the check-out
    const dayStart = dateTimeFor(dateKey, '00:00')
    const stored = await db.biometricPunch.findMany({
      where: { userId, ts: { gte: dayStart, lt: new Date(dayStart.getTime() + 86_400_000) } },
      select: { ts: true, status: true },
    })
    const dayPunches = stored.length ? stored : group
    const shift = await resolveShiftForUser(userId)
    const computed = computeFromPunches(dateKey, dayPunches.map((g) => ({ ts: g.ts, status: g.status })), shift, holidays)
    await upsertLogFromComputed(userId, dateKey, computed, shift, { source })
    days++
  }
  return { processed: punches.length, skipped: punches.length - days, days }
}

/** List working-day keys between two date keys (uses the user's shift). */
export function workingDayKeys(fromKey: string, toKey: string, shift: ResolvedShift, holidays: Set<string>): string[] {
  return eachDayKey(fromKey, toKey).filter((k) => isWorkingDay(k, shift, holidays))
}

export { dateTimeFor }
