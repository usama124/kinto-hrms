import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireSession, guard, ok, fail } from '@/lib/hrms/api-utils'
import { isOrgAdmin } from '@/lib/hrms/constants'
import { cleanText, cleanNumber, cleanHhmm } from '@/lib/hrms/sanitize'
import { writeAudit } from '@/lib/hrms/audit'
import { clientIp } from '@/lib/hrms/rate-limit'

/** Shift templates — list for all, create/assign for Admin/HR. */
export async function GET() {
  return guard(async () => {
    const session = await requireSession()
    void session
    const shifts = await db.shift.findMany({
      include: { _count: { select: { users: true, departments: true, teams: true } } },
      orderBy: { name: 'asc' },
    })
    return ok({ shifts })
  })
}

/** Create a shift template. */
export async function POST(req: NextRequest) {
  return guard(async () => {
    const session = await requireSession()
    if (!isOrgAdmin(session.role)) return fail('Forbidden: only Admin / HR can create shifts.', 403)
    const body = await req.json().catch(() => null)
    const name = cleanText(body?.name, 80)
    const startTime = cleanHhmm(body?.startTime) // strict 00:00–23:59 (25:00 / 99:99 used to be stored)
    const endTime = cleanHhmm(body?.endTime)
    if (!name || !startTime || !endTime) {
      return fail('name, startTime (HH:mm, 00:00–23:59) and endTime (HH:mm, 00:00–23:59) are required.', 422)
    }
    // the attendance engine works within one calendar day; an end before the start used to be clamped silently
    if (endTime <= startTime) return fail('A shift must end after it starts (overnight shifts are not supported).', 422)
    const graceMinutes = Math.max(0, Math.trunc(cleanNumber(body?.graceMinutes, 15)))
    const breakMinutes = Math.max(0, Math.trunc(cleanNumber(body?.breakMinutes, 60)))
    const workingDays: number[] = Array.isArray(body?.workingDays) && body.workingDays.length
      ? body.workingDays.map((n: unknown) => Number(n)).filter((n: number) => n >= 1 && n <= 7)
      : [1, 2, 3, 4, 5]
    // expected minutes = end - start - break
    const [sh, sm] = startTime.split(':').map(Number)
    const [eh, em] = endTime.split(':').map(Number)
    const expectedMinutes = Math.max(60, (eh * 60 + em) - (sh * 60 + sm) - breakMinutes)

    const shift = await db.shift.create({
      data: { name, startTime, endTime, graceMinutes, breakMinutes, expectedMinutes, workingDays: JSON.stringify(workingDays) },
    })
    await writeAudit({
      actorId: session.userId, actorName: session.fullName, actorRole: session.role,
      entityType: 'SHIFT', entityId: shift.id,
      fieldName: 'shift', newValue: `${name} ${startTime}-${endTime}`,
      reason: 'Shift template created', ipAddress: clientIp(req),
    })
    return ok({ shift }, { status: 201 })
  })
}

/** Assign a shift to a user, team, or department. */
export async function PATCH(req: NextRequest) {
  return guard(async () => {
    const session = await requireSession()
    if (!isOrgAdmin(session.role)) return fail('Forbidden: only Admin / HR can assign shifts.', 403)
    const body = await req.json().catch(() => null)
    const shiftId = String(body?.shiftId ?? '')
    if (!shiftId) return fail('shiftId required.', 422)
    const shift = await db.shift.findUnique({ where: { id: shiftId } })
    if (!shift) return fail('Shift not found.', 404)

    const targetUser = body?.userId ? String(body.userId) : null
    const targetTeam = body?.teamId ? String(body.teamId) : null
    const targetDept = body?.departmentId ? String(body.departmentId) : null
    const targets = [targetUser, targetTeam, targetDept].filter(Boolean).length
    if (targets !== 1) return fail('Exactly one of userId / teamId / departmentId is required.', 422)

    if (targetUser) {
      const u = await db.user.findUnique({ where: { id: targetUser } })
      if (!u) return fail('Employee not found.', 404)
      await db.user.update({ where: { id: targetUser }, data: { shiftId } })
      await writeAudit({
        actorId: session.userId, actorName: session.fullName, actorRole: session.role,
        targetUserId: u.id, targetName: u.fullName,
        entityType: 'SHIFT', entityId: shiftId,
        fieldName: 'shiftId', oldValue: u.shiftId ?? 'none', newValue: shift.name,
        reason: cleanText(body?.reason, 200) || 'Shift assignment', ipAddress: clientIp(req),
      })
      return ok({ assigned: 'user' })
    }
    if (targetTeam) {
      await db.team.update({ where: { id: targetTeam }, data: { shiftId } })
    } else {
      await db.department.update({ where: { id: targetDept! }, data: { shiftId } })
    }
    await writeAudit({
      actorId: session.userId, actorName: session.fullName, actorRole: session.role,
      entityType: 'SHIFT', entityId: shiftId,
      fieldName: targetTeam ? 'team.shiftId' : 'department.shiftId',
      newValue: shift.name, reason: 'Shift assignment',
      ipAddress: clientIp(req),
    })
    return ok({ assigned: targetTeam ? 'team' : 'department' })
  })
}

export const dynamic = 'force-dynamic'
