import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireSession, guard, ok, fail } from '@/lib/hrms/api-utils'
import { isOrgAdmin } from '@/lib/hrms/constants'
import { rosterFor } from '@/lib/hrms/org-stats'
import { todayKey } from '@/lib/hrms/dates'

/** Level 3 — Employee roster for a team with status pills (Admin/HR only). */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return guard(async () => {
    const session = await requireSession()
    if (!isOrgAdmin(session.role)) return fail('Forbidden.', 403)
    const { id } = await ctx.params
    const month = req.nextUrl.searchParams.get('month') ?? todayKey().slice(0, 7)
    const team = await db.team.findUnique({
      where: { id },
      include: { department: { select: { name: true } }, teamLead: { select: { fullName: true } }, users: { where: { isActive: true }, select: { id: true } } },
    })
    if (!team) return fail('Team not found.', 404)
    const members = await rosterFor(team.users.map((u) => u.id), month)
    return ok({
      team: { id: team.id, name: team.name, departmentName: team.department?.name ?? '—', teamLeadName: team.teamLead?.fullName ?? null },
      month, members,
    })
  })
}

export const dynamic = 'force-dynamic'
