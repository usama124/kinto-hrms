import 'server-only'
import { db } from '@/lib/db'
import { dayKey, dateTimeFor } from '@/lib/hrms/dates'
import { resolveShiftForUser, computeFromPunches, holidayKeysFor, upsertLogFromComputed } from '@/lib/hrms/attendance-engine'

/**
 * Apply an approved regularization to the immutable attendance record:
 * recompute worked/short/late from the requested times, mark is_manually_updated,
 * and write the field-level audit trail.
 */
export async function applyRegularizationToLog(
  userId: string,
  dateKey: string,
  checkInHhmm: string,
  checkOutHhmm: string,
  actor?: { userId: string; fullName: string; role: string },
): Promise<{ before: string; after: string }> {
  const shift = await resolveShiftForUser(userId)
  const holidays = await holidayKeysFor()
  const punches = [
    { ts: dateTimeFor(dateKey, checkInHhmm), status: 0 },
    { ts: dateTimeFor(dateKey, checkOutHhmm), status: 1 },
  ]
  const computed = computeFromPunches(dateKey, punches, shift, holidays)
  const before = await db.attendanceLog.findUnique({ where: { userId_dateKey: { userId, dateKey } } })
  const beforeLabel = before ? `${before.status} ${before.checkIn ? dayKey(before.checkIn) + ' ' + hhmm(before.checkIn) : '—'}–${before.checkOut ? hhmm(before.checkOut) : '—'}` : 'no record'

  await upsertLogFromComputed(userId, dateKey, computed, shift, {
    source: 'MANUAL',
    isManuallyUpdated: true,
    notes: actor ? `Regularized by ${actor.fullName}` : 'Regularized after multi-tier approval',
  })

  const afterLabel = `${computed.status} ${checkInHhmm}–${checkOutHhmm}`
  return { before: beforeLabel, after: afterLabel }
}

function hhmm(d: Date): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Karachi', hour: '2-digit', minute: '2-digit', hour12: false }).format(d)
}
