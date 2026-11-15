import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireSession, guard, ok, fail } from '@/lib/hrms/api-utils'
import { isOrgAdmin } from '@/lib/hrms/constants'
import { cleanText } from '@/lib/hrms/sanitize'
import { writeAudit } from '@/lib/hrms/audit'

/** GET — full org structure (departments → teams → members). Employees are excluded (403). */
export async function GET() {
  return guard(async () => {
    const session = await requireSession()
    if (session.role === 'EMPLOYEE') {
      return fail('Forbidden: the organization chart is not available for this role.', 403)
    }
    void session
    const personSelect = { id: true, fullName: true, designation: true, avatarColor: true, role: true, employeeCode: true, teamId: true } as const
    const departments = await db.department.findMany({
      include: {
        manager: { select: { id: true, fullName: true, designation: true, avatarColor: true } },
        teams: {
          orderBy: { name: 'asc' },
          include: {
            teamLead: { select: { id: true, fullName: true, designation: true, avatarColor: true } },
            users: { select: personSelect, orderBy: { fullName: 'asc' } },
          },
        },
        users: { select: personSelect, orderBy: { fullName: 'asc' } },
      },
      orderBy: { name: 'asc' },
    })
    const leads = await db.user.findMany({ where: { role: { in: ['MANAGER', 'TEAM_LEAD', 'HR_MANAGER', 'ACCOUNTANT'] }, isActive: true }, select: { id: true, fullName: true, role: true } })
    const unassigned = await db.user.findMany({
      where: { departmentId: null, isActive: true },
      select: personSelect,
      orderBy: { fullName: 'asc' },
    })
    return ok({ departments, leads, unassigned })
  })
}

/** POST — create a department or a team (Admin-configurable org). */
export async function POST(req: NextRequest) {
  return guard(async () => {
    const session = await requireSession()
    if (!isOrgAdmin(session.role)) return fail('Forbidden: only Admin / HR can modify the org structure.', 403)
    const body = await req.json().catch(() => null)
    const kind = String(body?.kind ?? '')
    const name = cleanText(body?.name, 60)

    if (kind === 'department') {
      const code = cleanText(body?.code, 10).toUpperCase()
      if (!name || !code) return fail('name and code are required.', 422)
      const exists = await db.department.findUnique({ where: { code } })
      if (exists) return fail('Department code already exists.', 409)
      const managerId = body?.managerId ? String(body.managerId) : null
      const dept = await db.department.create({ data: { name, code, managerId } })
      await writeAudit({
        actorId: session.userId, actorName: session.fullName, actorRole: session.role,
        entityType: 'RULE', entityId: dept.id, fieldName: 'department', newValue: `${name} (${code})`,
        reason: 'Department created', ipAddress: req.headers.get('x-forwarded-for') ?? null,
      })
      return ok({ department: dept }, { status: 201 })
    }

    if (kind === 'team') {
      const departmentId = String(body?.departmentId ?? '')
      const teamLeadId = body?.teamLeadId ? String(body.teamLeadId) : null
      if (!name || !departmentId) return fail('name and departmentId are required.', 422)
      const dept = await db.department.findUnique({ where: { id: departmentId } })
      if (!dept) return fail('Department not found.', 404)
      const team = await db.team.create({ data: { name, departmentId, teamLeadId } })
      // when a team lead is assigned, move them under this department & mark their lead membership
      if (teamLeadId) {
        const lead = await db.user.findUnique({ where: { id: teamLeadId } })
        if (lead) {
          await db.user.update({
            where: { id: teamLeadId },
            data: {
              teamId: team.id,
              departmentId: dept.id,
              managerId: dept.managerId ?? lead.managerId,
            },
          })
        }
      }
      await writeAudit({
        actorId: session.userId, actorName: session.fullName, actorRole: session.role,
        entityType: 'RULE', entityId: team.id, fieldName: 'team', newValue: `${name} @ ${dept.name}`,
        reason: 'Team created', ipAddress: req.headers.get('x-forwarded-for') ?? null,
      })
      return ok({ team }, { status: 201 })
    }

    return fail('kind must be "department" or "team".', 422)
  })
}

export const dynamic = 'force-dynamic'
