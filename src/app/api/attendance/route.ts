import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireSession, guard, ok, fail } from '@/lib/hrms/api-utils'
import { visibleUserIds } from '@/lib/hrms/rbac'
import { monthRangeKeys } from '@/lib/hrms/dates'

const NON_WORKING = ['WEEKEND', 'HOLIDAY', 'DAY_OFF']

/** Monthly timesheet for visible users (or a specific accessible user). */
export async function GET(req: NextRequest) {
  return guard(async () => {
    const session = await requireSession()
    const qp = req.nextUrl.searchParams
    const month = qp.get('month') ?? new Date().toISOString().slice(0, 7)
    const userId = qp.get('userId')

    const ids = await visibleUserIds(session)
    let target: string[] = ids
    if (userId) {
      if (!ids.includes(userId)) return fail('Forbidden: you cannot view this employee’s attendance.', 403)
      target = [userId]
    }

    const { fromKey, toKey } = monthRangeKeys(month)
    const logs = await db.attendanceLog.findMany({
      where: { userId: { in: target }, dateKey: { gte: fromKey, lte: toKey } },
      include: { user: { select: { id: true, fullName: true, employeeCode: true, avatarColor: true, avatarUploadId: true } } },
      orderBy: [{ userId: 'asc' }, { dateKey: 'asc' }],
    })

    // attendance score per user = attended / scheduled
    const scoreByUser = new Map<string, { attended: number; scheduled: number }>()
    for (const l of logs) {
      const cur = scoreByUser.get(l.userId) ?? { attended: 0, scheduled: 0 }
      if (!NON_WORKING.includes(l.status) && l.expectedMinutes > 0) {
        cur.scheduled += 1
        if (['PRESENT', 'WFH', 'OFFICIAL_DUTY', 'TRAVEL', 'SHORT_LEAVE', 'SHORT_DURATION'].includes(l.status)) cur.attended += 1
      }
      scoreByUser.set(l.userId, cur)
    }
    const score = userId
      ? (() => {
          const s = scoreByUser.get(userId)
          return s && s.scheduled > 0 ? Math.round((s.attended / s.scheduled) * 100) : null
        })()
      : null

    return ok({
      month,
      logs: logs.map((l) => ({
        id: l.id, dateKey: l.dateKey, status: l.status, checkIn: l.checkIn, checkOut: l.checkOut,
        expectedMinutes: l.expectedMinutes, workedMinutes: l.workedMinutes, shortMinutes: l.shortMinutes,
        lateMinutes: l.lateMinutes, breakMinutes: l.breakMinutes, isWFH: l.isWFH,
        source: l.source, notes: l.notes,
        user: l.user,
      })),
      score,
    })
  })
}
