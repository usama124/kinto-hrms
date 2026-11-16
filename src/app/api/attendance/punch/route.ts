import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireSession, guard, ok, fail } from '@/lib/hrms/api-utils'
import { isOversightOnly } from '@/lib/hrms/constants'
import { resolveShiftForUser, computeFromPunches, holidayKeysFor, upsertLogFromComputed } from '@/lib/hrms/attendance-engine'
import { dayKey } from '@/lib/hrms/dates'
import { writeAudit } from '@/lib/hrms/audit'
import { clientIp } from '@/lib/hrms/rate-limit'

/**
 * Self-service punch (Check-In / Check-Out).
 * SUPER_ADMIN is oversight-only — personal punching disabled.
 */
export async function POST(req: NextRequest) {
  return guard(async () => {
    const session = await requireSession()
    if (isOversightOnly(session.role)) return fail('System Admin is an oversight role — attendance punching is disabled.', 403)

    const body = await req.json().catch(() => ({}))
    const type = String(body?.type ?? '').toUpperCase()
    if (type !== 'IN' && type !== 'OUT') return fail('type must be IN or OUT.', 422)

    const user = await db.user.findUnique({ where: { id: session.userId } })
    if (!user) return fail('Account not found.', 404)

    const dateKey = dayKey(new Date())
    const shift = await resolveShiftForUser(user.id)
    const holidays = await holidayKeysFor()
    const now = new Date()

    const log = await db.attendanceLog.findUnique({ where: { userId_dateKey: { userId: user.id, dateKey } } })

    if (type === 'IN') {
      if (log?.checkIn) return fail('You have already checked in today.', 409)
      const punches = [{ ts: now, status: 0 }, ...(log?.checkOut ? [{ ts: log.checkOut, status: 1 }] : [])]
      const computed = computeFromPunches(dateKey, punches, shift, holidays)
      const updated = await upsertLogFromComputed(user.id, dateKey, computed, shift, {
        source: 'MANUAL', notes: 'Self punch (web)',
      })
      await db.biometricPunch.create({
        data: {
          pin: user.employeeCode, userId: user.id, ts: now, status: 0,
          deviceSn: 'WEB', ip: clientIp(req),
          raw: `WEB punch IN`, dedupHash: `web-${user.id}-${now.toISOString()}`,
          processed: true,
        },
      }).catch(() => {})
      await writeAudit({
        actorId: user.id, actorName: user.fullName, actorRole: user.role,
        targetUserId: user.id, targetName: user.fullName,
        entityType: 'ATTENDANCE', entityId: updated.id,
        fieldName: 'checkIn', oldValue: null, newValue: fmtHM(now),
        reason: 'Self check-in', ipAddress: clientIp(req),
      })
      return ok({ log: updated, checkedInAt: now })
    }

    // OUT
    if (!log?.checkIn) return fail('No check-in found for today — check in first.', 409)
    if (log.checkOut) return fail('You have already checked out today.', 409)
    const punches = [{ ts: log.checkIn, status: 0 }, { ts: now, status: 1 }]
    const computed = computeFromPunches(dateKey, punches, shift, holidays)
    const updated = await db.attendanceLog.update({
      where: { id: log.id },
      data: {
        checkOut: now,
        workedMinutes: computed.workedMinutes,
        shortMinutes: computed.shortMinutes,
        earlyMinutes: computed.earlyMinutes,
        status: computed.status,
        source: 'MANUAL',
      },
    })
    await writeAudit({
      actorId: user.id, actorName: user.fullName, actorRole: user.role,
      targetUserId: user.id, targetName: user.fullName,
      entityType: 'ATTENDANCE', entityId: log.id,
      fieldName: 'checkOut', oldValue: null, newValue: fmtHM(now),
      reason: 'Self check-out', ipAddress: clientIp(req),
    })
    return ok({ log: updated, checkedOutAt: now })
  })
}

function fmtHM(d: Date): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Karachi', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d)
  return `${parts.find((p) => p.type === 'hour')?.value}:${parts.find((p) => p.type === 'minute')?.value}`
}

export const dynamic = 'force-dynamic'
