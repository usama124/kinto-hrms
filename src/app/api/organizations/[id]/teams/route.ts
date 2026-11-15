import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireSession, guard, ok, fail } from '@/lib/hrms/api-utils'
import { isOrgAdmin } from '@/lib/hrms/constants'
import { computeStats, teamBreakdown } from '@/lib/hrms/org-stats'
import { todayKey } from '@/lib/hrms/dates'

/** Level 2 — Team breakdown inside a department (Admin/HR only). */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return guard(async () => {
    const session = await requireSession()
    if (!isOrgAdmin(session.role)) return fail('Forbidden.', 403)
    const { id } = await ctx.params
    const month = req.nextUrl.searchParams.get('month') ?? todayKey().slice(0, 7)
    const dept = await db.department.findUnique({ where: { id } })
    if (!dept) return fail('Department not found.', 404)
    const teams = await teamBreakdown(id, month)
    const unassigned = await db.user.findMany({ where: { departmentId: id, isActive: true, role: { not: 'SUPER_ADMIN' }, teamId: null }, select: { id: true } })
    const unassignedStats = await computeStats(month, unassigned.map((u) => u.id))
    return ok({
      department: { id: dept.id, name: dept.name, code: dept.code },
      month, teams, unassigned: { count: unassigned.length, stats: unassignedStats },
    })
  })
}

export const dynamic = 'force-dynamic'
