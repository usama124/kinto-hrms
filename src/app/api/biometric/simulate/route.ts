import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireSession, guard, ok, fail } from '@/lib/hrms/api-utils'
import { isOrgAdmin } from '@/lib/hrms/constants'
import { resolveShiftForUser, holidayKeysFor } from '@/lib/hrms/attendance-engine'
import { dayKey, dateTimeFor, addDaysKey } from '@/lib/hrms/dates'
import { isoWeekdayOf } from '@/lib/hrms/attendance-engine'
import { parsePunchPayload, ingestPunches } from '@/lib/hrms/biometric'
import { writeAudit } from '@/lib/hrms/audit'
import { clientIp } from '@/lib/hrms/rate-limit'

/**
 * Admin/HR simulator — generates a realistic punch batch for the last working day
 * the device missed (or an explicit dateKey) and pushes it through the full
 * ZKTeco ingestion pipeline (dedup → parse → rebuild records).
 */
export async function POST(req: NextRequest) {
  return guard(async () => {
    // demo-only: it fabricates attendance for every employee, so it is OFF in production unless explicitly enabled
    if (process.env.NODE_ENV === 'production' && process.env.ENABLE_BIOMETRIC_SIMULATOR !== 'true') {
      return fail('The biometric simulator is disabled in production.', 403)
    }
    const session = await requireSession()
    if (!isOrgAdmin(session.role)) return fail('Forbidden.', 403)

    const body = await req.json().catch(() => ({}))
    const holidays = await holidayKeysFor()

    // target date: provided, else most recent working day with missing punches
    let dateKey = body?.dateKey && /^\d{4}-\d{2}-\d{2}$/.test(body.dateKey) ? String(body.dateKey) : null
    const users = await db.user.findMany({
      where: { isActive: true, role: { not: 'SUPER_ADMIN' }, employeeCode: { not: 'NT-000' } },
      select: { id: true, employeeCode: true, fullName: true, shiftId: true },
    })

    if (!dateKey) {
      for (let i = 1; i <= 10; i++) {
        const candidate = addDaysKey(dayKey(new Date()), -i)
        if (!users.length) break
        const shift = await resolveShiftForUser(users[0].id)
        if (!shift.workingDays.includes(isoWeekdayOf(candidate)) || holidays.has(candidate)) continue
        const missing = await db.attendanceLog.findFirst({ where: { dateKey: candidate, status: 'MISSING' } })
        if (missing) { dateKey = candidate; break }
      }
      dateKey = dateKey ?? addDaysKey(dayKey(new Date()), -1)
    }

    const lines: string[] = []
    let linesBuilt = 0
    for (const u of users) {
      const shift = await resolveShiftForUser(u.id)
      if (!shift.workingDays.includes(isoWeekdayOf(dateKey!)) || holidays.has(dateKey!)) continue
      const log = await db.attendanceLog.findUnique({ where: { userId_dateKey: { userId: u.id, dateKey: dateKey! } } })
      const jitterIn = Math.floor(Math.random() * 10) - 5
      const jitterOut = Math.floor(Math.random() * 12) - 6
      if (!log || log.status === 'MISSING' || log.status === 'ABSENT') {
        lines.push(`PIN=${u.employeeCode}\tTIME=${dateKey} ${addMin(shift.startTime, jitterIn)}:00\tSTATUS=0`)
        lines.push(`PIN=${u.employeeCode}\tTIME=${dateKey} ${addMin(shift.endTime, jitterOut)}:00\tSTATUS=1`)
        linesBuilt += 2
      }
    }

    if (!linesBuilt) return ok({ dateKey, generated: 0, message: 'No missing punches found for the target date — device data already complete.' })

    const parsed = parsePunchPayload(lines.join('\n'))
    const result = await ingestPunches(parsed, 'CJ7T201660772', clientIp(req))
    await writeAudit({
      actorId: session.userId, actorName: session.fullName, actorRole: session.role,
      entityType: 'SECURITY', entityId: dateKey,
      reason: `Simulated ZKTeco K50 pull for ${dateKey}: ${result.stored} punches stored, ${result.daysRebuilt} day(s) rebuilt`,
      ipAddress: clientIp(req),
    })
    return ok({ dateKey, generated: linesBuilt, ...result })
  })
}

function addMin(hhmm: string, delta: number): string {
  const [h, m] = hhmm.split(':').map(Number)
  let t = h * 60 + m + delta
  t = ((t % 1440) + 1440) % 1440
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`
}

export const dynamic = 'force-dynamic'
