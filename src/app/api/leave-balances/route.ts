import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireSession, guard, ok, fail } from '@/lib/hrms/api-utils'
import { canAccessUser } from '@/lib/hrms/rbac'
import { todayKey } from '@/lib/hrms/dates'
import { ensureLeaveBalances } from '@/lib/hrms/leave-balances'

/** Real-time leave balance table (Carry Forward, Availed, Pending, Lapsed, Available). */
export async function GET(req: NextRequest) {
  return guard(async () => {
    const session = await requireSession()
    const qp = req.nextUrl.searchParams
    const userId = qp.get('userId') ?? session.userId
    if (!(await canAccessUser(session, userId))) return fail('Forbidden: you cannot view this employee’s balances.', 403)

    const year = Number(todayKey().slice(0, 4))
    await ensureLeaveBalances(userId, year) // provisions missing rows (System Admin, new year)
    const balances = await db.leaveBalance.findMany({
      where: { userId, year },
      include: { leaveType: true },
      orderBy: { leaveTypeId: 'asc' },
    })
    return ok({
      year,
      balances: balances.map((b) => {
        const total = b.carryForward + b.leaveType.annualQuota
        return {
          leaveTypeId: b.leaveTypeId, name: b.leaveType.name, code: b.leaveType.code, color: b.leaveType.colorCode,
          carryForward: b.carryForward, quota: b.leaveType.annualQuota, total,
          availed: Math.round(b.availed * 100) / 100, pending: b.pending, lapsed: b.lapsed,
          available: Math.round((total - b.availed - b.pending - b.lapsed) * 100) / 100,
        }
      }),
    })
  })
}
