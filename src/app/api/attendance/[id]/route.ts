import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireSession, guard, ok, fail } from '@/lib/hrms/api-utils'
import { canAccessUser } from '@/lib/hrms/rbac'

/** Attendance detail drawer payload: expected vs actual, breaks, immutable audit trail. */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return guard(async () => {
    const session = await requireSession()
    const { id } = await ctx.params
    const log = await db.attendanceLog.findUnique({
      where: { id },
      include: {
        user: { select: { id: true, fullName: true, employeeCode: true, avatarColor: true, designation: true } },
        breaks: true,
        audits: { include: { admin: { select: { fullName: true } } }, orderBy: { createdAt: 'desc' } },
      },
    })
    if (!log) return fail('Attendance record not found.', 404)
    if (!(await canAccessUser(session, log.userId))) return fail('Forbidden: you cannot view this attendance record.', 403)
    return ok({ log })
  })
}
