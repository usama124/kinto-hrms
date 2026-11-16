import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireSession, guard, ok, fail } from '@/lib/hrms/api-utils'
import { isOrgAdmin } from '@/lib/hrms/constants'
import { cleanText } from '@/lib/hrms/sanitize'
import { writeAudit } from '@/lib/hrms/audit'
import { clientIp } from '@/lib/hrms/rate-limit'
import { designationDto } from '@/lib/hrms/designations'
import { exceedsMaxDepth, MAX_DESIGNATION_DEPTH, parseLevelRank } from '@/lib/hrms/designation-tree'

const MAX_PER_DEPARTMENT = 200

/** All designations (optionally one department / active only). Readable by everyone signed in — the employee form needs them. */
export async function GET(req: NextRequest) {
  return guard(async () => {
    await requireSession()
    const qp = req.nextUrl.searchParams
    const departmentId = qp.get('departmentId')
    const rows = await db.designation.findMany({
      where: { ...(departmentId ? { departmentId } : {}), ...(qp.get('active') === '1' ? { isActive: true } : {}) },
      include: { department: { select: { name: true } }, _count: { select: { users: true } } },
      orderBy: [{ departmentId: 'asc' }, { levelRank: 'asc' }, { name: 'asc' }],
    })
    return ok({ designations: rows.map(designationDto) })
  })
}

/** Create a designation inside a department, optionally nested under another designation of the SAME department. */
export async function POST(req: NextRequest) {
  return guard(async () => {
    const session = await requireSession()
    if (!isOrgAdmin(session.role)) return fail('Forbidden: only System Admin / HR Manager can define designations.', 403)
    const body = await req.json().catch(() => null)
    if (!body) return fail('Invalid JSON body.', 400)

    const name = cleanText(body.name, 80)
    const description = cleanText(body.description, 300) || null
    const departmentId = String(body.departmentId ?? '')
    const parentId = body.parentDesignationId ? String(body.parentDesignationId) : null
    const rank = parseLevelRank(body.levelRank)
    if (name.length < 2) return fail('Designation name is required (at least 2 characters).', 422)
    if (rank === 'invalid') return fail('Level rank must be a whole number from 1 to 99.', 422)

    const dept = departmentId ? await db.department.findUnique({ where: { id: departmentId } }) : null
    if (!dept) return fail('Choose a department for this designation.', 422)
    if (!dept.isActive) return fail(`${dept.name} is inactive. Reactivate it before adding designations.`, 422)

    const siblings = await db.designation.findMany({ where: { departmentId }, select: { id: true, name: true, departmentId: true, parentDesignationId: true, levelRank: true } })
    if (siblings.length >= MAX_PER_DEPARTMENT) return fail(`A department can have at most ${MAX_PER_DEPARTMENT} designations.`, 422)
    if (siblings.some((d) => d.name.toLowerCase() === name.toLowerCase())) return fail(`${dept.name} already has a designation called “${name}”.`, 409)

    let parentRank = 0
    if (parentId) {
      const parent = siblings.find((d) => d.id === parentId)
      if (!parent) return fail('The parent designation must belong to the same department.', 422)
      if (exceedsMaxDepth(siblings, null, parentId)) return fail(`Designations can be nested at most ${MAX_DESIGNATION_DEPTH} levels deep.`, 422)
      parentRank = parent.levelRank
    }

    const created = await db.designation.create({
      data: { name, description, departmentId, parentDesignationId: parentId, levelRank: rank ?? Math.min(99, parentRank + 1), isActive: body.isActive !== false },
      include: { department: { select: { name: true } }, _count: { select: { users: true } } },
    })
    await writeAudit({
      actorId: session.userId, actorName: session.fullName, actorRole: session.role,
      entityType: 'RULE', entityId: created.id, fieldName: 'designation.created', newValue: `${name} @ ${dept.name}${parentId ? ' (nested)' : ''}`,
      reason: 'Designation created', ipAddress: clientIp(req),
    })
    return ok({ designation: designationDto(created) }, { status: 201 })
  })
}

export const dynamic = 'force-dynamic'
