// ─── Date helpers anchored to Asia/Karachi timezone ───────────────────────────

export const KARACHI_TZ = 'Asia/Karachi'
const EN_CA = 'en-CA' // yields YYYY-MM-DD

/** Format a Date into "YYYY-MM-DD" as observed in Karachi. */
export function dayKey(d: Date): string {
  return new Intl.DateTimeFormat(EN_CA, { timeZone: KARACHI_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
}

export function todayKey(): string {
  return dayKey(new Date())
}

export function monthKeyOf(dateKeyStr: string): string {
  return dateKeyStr.slice(0, 7)
}

/** "2025-03" -> first day Date (UTC midnight) */
export function monthStart(month: string): Date {
  const [y, m] = month.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, 1))
}

export function monthEnd(month: string): Date {
  const [y, m] = month.split('-').map(Number)
  return new Date(Date.UTC(y, m, 1))
}

/** Parse "YYYY-MM-DD" to a UTC-anchored Date (no TZ drift for day math). */
export function parseKey(key: string): Date {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d))
}

export function keyOf(date: Date): string {
  return dayKey(date)
}

export function addDaysKey(key: string, n: number): string {
  const d = parseKey(key)
  d.setUTCDate(d.getUTCDate() + n)
  return dayKey(d)
}

/** Weekday number (0=Sunday..6=Saturday) of a date key, in Karachi. */
export function weekdayOf(key: string): number {
  // parseKey anchors at UTC midnight; Karachi is +5 so same calendar day.
  return parseKey(key).getUTCDay()
}

/** List every date key in the inclusive range [fromKey, toKey]. */
export function eachDayKey(fromKey: string, toKey: string): string[] {
  const out: string[] = []
  let cur = fromKey
  let guard = 0
  while (cur <= toKey && guard < 1500) {
    out.push(cur)
    cur = addDaysKey(cur, 1)
    guard++
  }
  return out
}

export function daysBetweenInclusive(fromKey: string, toKey: string): number {
  return Math.floor((parseKey(toKey).getTime() - parseKey(fromKey).getTime()) / 86400000) + 1
}

/** Working days between two keys excluding weekly-off weekday and holiday keys. */
export function workingDaysBetween(fromKey: string, toKey: string, weeklyOffDay: number, holidayKeys: Set<string>): string[] {
  return eachDayKey(fromKey, toKey).filter((k) => {
    if (holidayKeys.has(k)) return false
    if (weekdayOf(k) === weeklyOffDay) return false
    return true
  })
}

/** Number of working days in a month (weekly off + holidays excluded). */
export function monthWorkingDays(month: string, weeklyOffDay: number, holidayKeys: Set<string>): number {
  const [y, m] = month.split('-').map(Number)
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return workingDaysBetween(`${month}-01`, `${month}-${String(last).padStart(2, '0')}`, weeklyOffDay, holidayKeys).length
}

/** First & last key of month as date keys. */
export function monthRangeKeys(month: string): { fromKey: string; toKey: string } {
  const [y, m] = month.split('-').map(Number)
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return { fromKey: `${month}-01`, toKey: `${month}-${String(last).padStart(2, '0')}` }
}

export function monthsBetween(fromMonth: string, toMonth: string): string[] {
  const [fy, fm] = fromMonth.split('-').map(Number)
  const [ty, tm] = toMonth.split('-').map(Number)
  const out: string[] = []
  let y = fy, m = fm
  let guard = 0
  while ((y < ty || (y === ty && m <= tm)) && guard < 36) {
    out.push(`${y}-${String(m).padStart(2, '0')}`)
    m++
    if (m > 12) { m = 1; y++ }
    guard++
  }
  return out
}

/** Build a Date for a date key + "HH:mm" time in Karachi (returns real Date). */
export function dateTimeFor(key: string, hhmm: string): Date {
  const [y, mo, d] = key.split('-').map(Number)
  const [h, mi] = hhmm.split(':').map(Number)
  // Karachi is UTC+5 with no DST
  return new Date(Date.UTC(y, mo - 1, d, h - 5, mi))
}

export function minutesSinceMidnightKarachi(d: Date): number {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: KARACHI_TZ, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d)
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? '0')
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? '0')
  return h * 60 + m
}

export function fmtMinutes(total: number): string {
  const sign = total < 0 ? '-' : ''
  const t = Math.abs(Math.round(total))
  const h = Math.floor(t / 60)
  const m = t % 60
  return `${sign}${h}h ${String(m).padStart(2, '0')}m`
}

export function fmtDateKey(key: string): string {
  const d = parseKey(key)
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: '2-digit', month: 'short', year: 'numeric' }).format(d)
}

export function fmtDateTime(d: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: KARACHI_TZ, day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true,
  }).format(d)
}

export function monthLabel(month: string): string {
  const d = monthStart(month)
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', month: 'long', year: 'numeric' }).format(d)
}
