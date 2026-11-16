import { NextRequest } from 'next/server'
import { requireSession, guard, ok, fail } from '@/lib/hrms/api-utils'
import { isOrgAdmin } from '@/lib/hrms/constants'
import { cleanDateKey } from '@/lib/hrms/sanitize'
import { addDaysKey, daysBetweenInclusive, todayKey } from '@/lib/hrms/dates'
import { materializeAttendance } from '@/lib/hrms/attendance-sync'
import { writeAudit } from '@/lib/hrms/audit'
import { clientIp } from '@/lib/hrms/rate-limit'

const MAX_DAYS = 93

/** POST /api/attendance/sync { from?, to? } — Admin/HR: create ABSENT / leave / duty rows for punch-less working days (past days only). */
export async function POST(req: NextRequest) {
  return guard(async () => {
    const session = await requireSession()
    if (!isOrgAdmin(session.role)) return fail('Forbidden: only HR / Admin can sync attendance.', 403)

    const body = await req.json().catch(() => ({}))
    const yesterday = addDaysKey(todayKey(), -1)
    const to = body?.to ? cleanDateKey(body.to) : yesterday
    const from = body?.from ? cleanDateKey(body.from) : `${yesterday.slice(0, 7)}-01`
    if (!from || !to) return fail('from / to must be valid YYYY-MM-DD dates.', 422)
    if (to > yesterday) return fail('Only past days can be synced (today may still be punched).', 422)
    if (to < from) return fail('to cannot be before from.', 422)
    if (daysBetweenInclusive(from, to) > MAX_DAYS) return fail(`Range too large (max ${MAX_DAYS} days).`, 422)

    const result = await materializeAttendance(from, to)
    await writeAudit({
      actorId: session.userId, actorName: session.fullName, actorRole: session.role,
      entityType: 'ATTENDANCE', reason: `Attendance sync ${from} → ${to}: ${result.created} created, ${result.updated} updated`,
      ipAddress: clientIp(req),
    })
    return ok({ from, to, ...result })
  })
}

export const dynamic = 'force-dynamic'
