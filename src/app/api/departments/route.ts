import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireSession, guard, ok, fail } from '@/lib/hrms/api-utils'
import { isOrgAdmin } from '@/lib/hrms/constants'
import { cleanText } from '@/lib/hrms/sanitize'
import { writeAudit } from '@/lib/hrms/audit'
import { clientIp } from '@/lib/hrms/rate-limit'
import { departmentDto } from '@/lib/hrms/departments'

/** Departments with usage counts. Readable by everyone signed in (pickers need them). */
export async function GET() {
  return guard(async () => {
    await requireSession()
    const rows = await db.department.findMany({
      orderBy: { name: 'asc' },
      include: { manager: { select: { fullName: true } }, _count: { select: { users: true, teams: true, designations: true } } },
    })
    return ok({ departments: rows.map(departmentDto) })
  })
}

/** Create a department (System Admin / HR Manager). Starts empty — no seed data. */
export async function POST(req: NextRequest) {
  return guard(async () => {
    const session = await requireSession()
    if (!isOrgAdmin(session.role)) return fail('Forbidden: only System Admin / HR Manager can manage departments.', 403)
    const body = await req.json().catch(() => null)
    const name = cleanText(body?.name, 60)
    const code = cleanText(body?.code, 10).toUpperCase()
    const description = cleanText(body?.description, 300) || null
    if (name.length < 2) return fail('Department name is required (at least 2 characters).', 422)
    if (!/^[A-Z0-9]{2,10}$/.test(code)) return fail('Code must be 2–10 letters or digits (e.g., ENG).', 422)
    if (await db.department.findFirst({ where: { name: { equals: name, mode: 'insensitive' } }, select: { id: true } })) return fail('A department with this name already exists.', 409)
    if (await db.department.findUnique({ where: { code }, select: { id: true } })) return fail('A department with this code already exists.', 409)

    const created = await db.department.create({ data: { name, code, description, isActive: body?.isActive !== false } })
    await writeAudit({
      actorId: session.userId, actorName: session.fullName, actorRole: session.role,
      entityType: 'RULE', entityId: created.id, fieldName: 'department.created', newValue: `${name} (${code})`,
      reason: 'Department created', ipAddress: clientIp(req),
    })
    return ok({ department: departmentDto({ ...created, _count: { users: 0, teams: 0, designations: 0 } }) }, { status: 201 })
  })
}

export const dynamic = 'force-dynamic'
