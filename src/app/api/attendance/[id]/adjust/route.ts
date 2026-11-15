import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireSession, guard, ok, fail } from '@/lib/hrms/api-utils'
import { isOrgAdmin } from '@/lib/hrms/constants'
import { cleanHhmm, cleanText } from '@/lib/hrms/sanitize'
import { resolveShiftForUser, computeFromPunches, holidayKeysFor } from '@/lib/hrms/attendance-engine'
import { dayKey, dateTimeFor } from '@/lib/hrms/dates'
import { writeAudit } from '@/lib/hrms/audit'

/**
 * Direct HR/Admin attendance correction (outside the 3-tier employee flow).
 * Recomputes all derived minutes via the shift engine; every changed field is
 * written to the immutable audit log with actor, reason and IP.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return guard(async () => {
    const session = await requireSession()
    if (!isOrgAdmin(session.role)) return fail('Forbidden: only HR / Admin can adjust attendance directly.', 403)

    const { id } = await ctx.params
    const log = await db.attendanceLog.findUnique({ where: { id }, include: { user: true } })
    if (!log) return fail('Attendance record not found.', 404)

    const body = await req.json().catch(() => null)
    const reason = cleanText(body?.reason, 300)
    if (!reason) return fail('An adjustment reason is required for the audit log.', 422)

    const dateKey = log.dateKey
    const shift = await resolveShiftForUser(log.userId)
    const holidays = await holidayKeysFor()

    const checkInHhmm = cleanHhmm(body?.checkIn) ?? (log.checkIn ? fmtHM(log.checkIn) : null)
    const checkOutHhmm = cleanHhmm(body?.checkOut) ?? (log.checkOut ? fmtHM(log.checkOut) : null)

    const punches: { ts: Date; status: number | null }[] = []
    if (checkInHhmm) punches.push({ ts: dateTimeFor(dateKey, checkInHhmm), status: 0 })
    if (checkOutHhmm) punches.push({ ts: dateTimeFor(dateKey, checkOutHhmm), status: 1 })
    if (punches.length === 0) return fail('At least one of checkIn/checkOut is required.', 422)

    const computed = computeFromPunches(dateKey, punches, shift, holidays)
    const overrideStatus = cleanText(body?.status, 30) || computed.status

    const updated = await db.attendanceLog.update({
      where: { id },
      data: {
        checkIn: computed.checkIn,
        checkOut: computed.checkOut,
        status: overrideStatus,
        workedMinutes: computed.workedMinutes,
        shortMinutes: computed.shortMinutes,
        lateMinutes: computed.lateMinutes,
        earlyMinutes: computed.earlyMinutes,
        isManuallyUpdated: true,
        source: 'MANUAL',
        notes: cleanText(body?.notes, 300) || log.notes,
      },
    })

    // field-level immutable audit
    const changes = [
      { fieldName: 'checkIn', oldValue: log.checkIn ? fmtHM(log.checkIn) : null, newValue: checkInHhmm },
      { fieldName: 'checkOut', oldValue: log.checkOut ? fmtHM(log.checkOut) : null, newValue: checkOutHhmm },
      { fieldName: 'status', oldValue: log.status, newValue: overrideStatus },
      { fieldName: 'workedMinutes', oldValue: log.workedMinutes, newValue: computed.workedMinutes },
      { fieldName: 'shortMinutes', oldValue: log.shortMinutes, newValue: computed.shortMinutes },
    ]
    for (const c of changes) {
      if (String(c.oldValue ?? '') === String(c.newValue ?? '')) continue
      await writeAudit({
        actorId: session.userId, actorName: session.fullName, actorRole: session.role,
        targetUserId: log.userId, targetName: log.user.fullName,
        entityType: 'ATTENDANCE', entityId: id,
        fieldName: c.fieldName, oldValue: c.oldValue, newValue: c.newValue,
        reason, ipAddress: req.headers.get('x-forwarded-for') ?? null,
      })
    }
    await db.attendanceAudit.create({
      data: {
        attendanceId: id, adminId: session.userId,
        field: 'manual_adjustment',
        oldValue: `${log.checkIn ? fmtHM(log.checkIn) : '—'} → ${log.checkOut ? fmtHM(log.checkOut) : '—'} (${log.status})`,
        newValue: `${checkInHhmm ?? '—'} → ${checkOutHhmm ?? '—'} (${overrideStatus})`,
        reason,
      },
    })

    return ok({ log: updated })
  })
}

function fmtHM(d: Date): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Karachi', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d)
  return `${parts.find((p) => p.type === 'hour')?.value}:${parts.find((p) => p.type === 'minute')?.value}`
}

export const dynamic = 'force-dynamic'
