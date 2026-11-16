import 'server-only'
import { db } from '@/lib/db'
import { ATT_STATUS } from '@/lib/hrms/constants'
import { dayKey, dateTimeFor, eachDayKey } from '@/lib/hrms/dates'
import { resolveShiftForUser, holidayKeysFor, isWorkingDay } from '@/lib/hrms/attendance-engine'
import { createManySkipDuplicates } from '@/lib/hrms/db-compat'

/**
 * Materialize attendance rows for scheduled working days that have no punches:
 *  - covered by an APPROVED full-day leave / official duty / travel request → that status
 *  - otherwise → ABSENT (feeds payroll's uninformed-absence deduction)
 * Existing rows are never touched, except an automatic ABSENT that a later-approved
 * request now covers. Idempotent; call for past days only (today may still be punched).
 */
const COVER_BY_TYPE: Record<string, string> = {
  LEAVE: ATT_STATUS.FULL_LEAVE,
  OFFICIAL_DUTY: ATT_STATUS.OFFICIAL_DUTY,
  TRAVEL: ATT_STATUS.TRAVEL,
}

export async function materializeAttendance(
  fromKey: string,
  toKey: string,
  onlyUserId?: string,
): Promise<{ created: number; updated: number }> {
  if (toKey < fromKey) return { created: 0, updated: 0 }
  const holidays = await holidayKeysFor()
  const users = await db.user.findMany({
    where: { isActive: true, role: { not: 'SUPER_ADMIN' }, ...(onlyUserId ? { id: onlyUserId } : {}) },
    select: { id: true, joiningDate: true },
  })
  const userFilter = { userId: { in: users.map((u) => u.id) } }
  const [logs, reqs] = await Promise.all([
    db.attendanceLog.findMany({
      where: { ...userFilter, dateKey: { gte: fromKey, lte: toKey } },
      select: { id: true, userId: true, dateKey: true, status: true, isManuallyUpdated: true },
    }),
    db.request.findMany({
      where: {
        ...userFilter, status: 'APPROVED', isShortLeave: false,
        startDate: { lte: dateTimeFor(toKey, '23:59') }, endDate: { gte: dateTimeFor(fromKey, '00:00') },
      },
      select: { userId: true, type: true, startDate: true, endDate: true },
    }),
  ])
  const logIdx = new Map(logs.map((l) => [`${l.userId}|${l.dateKey}`, l]))
  const reqsByUser = new Map<string, { type: string; from: string; to: string }[]>()
  for (const r of reqs) {
    const list = reqsByUser.get(r.userId) ?? []
    list.push({ type: r.type, from: dayKey(r.startDate), to: dayKey(r.endDate) })
    reqsByUser.set(r.userId, list)
  }

  const days = eachDayKey(fromKey, toKey)
  const toCreate: { userId: string; dateKey: string; status: string; expectedMinutes: number; source: string; notes: string }[] = []
  const toUpdate: { id: string; status: string; expectedMinutes: number }[] = []

  for (const u of users) {
    const shift = await resolveShiftForUser(u.id)
    const joined = dayKey(u.joiningDate)
    const mine = reqsByUser.get(u.id) ?? []
    for (const day of days) {
      if (day < joined || !isWorkingDay(day, shift, holidays)) continue
      const covering = mine.filter((r) => r.from <= day && day <= r.to).map((r) => COVER_BY_TYPE[r.type]).filter(Boolean)
      // leave wins over duty/travel if somehow both overlap
      const cover = covering.includes(ATT_STATUS.FULL_LEAVE) ? ATT_STATUS.FULL_LEAVE : covering[0]
      const existing = logIdx.get(`${u.id}|${day}`)
      if (!existing) {
        const status = cover ?? ATT_STATUS.ABSENT
        // full leave is not a scheduled shift → excluded from attendance-score denominators
        toCreate.push({ userId: u.id, dateKey: day, status, expectedMinutes: status === ATT_STATUS.FULL_LEAVE ? 0 : shift.expectedMinutes, source: 'SYSTEM', notes: cover ? 'Auto from approved request' : 'No punch recorded' })
      } else if (cover && existing.status === ATT_STATUS.ABSENT && !existing.isManuallyUpdated) {
        toUpdate.push({ id: existing.id, status: cover, expectedMinutes: cover === ATT_STATUS.FULL_LEAVE ? 0 : shift.expectedMinutes })
      }
    }
  }

  const created = toCreate.length ? (await createManySkipDuplicates(db.attendanceLog as never, toCreate)).count : 0
  for (const u of toUpdate) {
    await db.attendanceLog.update({ where: { id: u.id }, data: { status: u.status, expectedMinutes: u.expectedMinutes, notes: 'Auto from approved request' } })
  }
  return { created, updated: toUpdate.length }
}
