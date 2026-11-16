import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireSession, guard, ok, fail } from '@/lib/hrms/api-utils'
import { isOrgAdmin } from '@/lib/hrms/constants'
import { cleanText } from '@/lib/hrms/sanitize'
import { writeAudit } from '@/lib/hrms/audit'
import { clientIp } from '@/lib/hrms/rate-limit'
import { nameLike, sameName } from '@/lib/hrms/db-compat'

type Ctx = { params: Promise<{ id: string }> }

/** Edit a department: name, code, description, active/inactive. */
export async function PATCH(req: NextRequest, ctx: Ctx) {
  return guard(async () => {
    const session = await requireSession()
    if (!isOrgAdmin(session.role)) return fail('Forbidden: only System Admin / HR Manager can manage departments.', 403)
    const { id } = await ctx.params
    const cur = await db.department.findUnique({ where: { id } })
    if (!cur) return fail('Department not found.', 404)
    const body = await req.json().catch(() => null)
    if (!body) return fail('Invalid JSON body.', 400)

    const data: { name?: string; code?: string; description?: string | null; isActive?: boolean } = {}
    if (body.name !== undefined) {
      const name = cleanText(body.name, 60)
      if (name.length < 2) return fail('Department name is required (at least 2 characters).', 422)
      if (name !== cur.name) {
        if ((await db.department.findMany({ where: { name: nameLike(name), NOT: { id } }, select: { name: true } })).some((d) => sameName(d.name, name))) return fail('A department with this name already exists.', 409)
        data.name = name
      }
    }
    if (body.code !== undefined) {
      const code = cleanText(body.code, 10).toUpperCase()
      if (!/^[A-Z0-9]{2,10}$/.test(code)) return fail('Code must be 2–10 letters or digits (e.g., ENG).', 422)
      if (code !== cur.code) {
        if (await db.department.findFirst({ where: { code, NOT: { id } }, select: { id: true } })) return fail('A department with this code already exists.', 409)
        data.code = code
      }
    }
    if (body.description !== undefined) {
      const description = cleanText(body.description, 300) || null
      if (description !== cur.description) data.description = description
    }
    if (body.isActive !== undefined && Boolean(body.isActive) !== cur.isActive) data.isActive = Boolean(body.isActive)

    const changed = Object.keys(data) as (keyof typeof data)[]
    if (!changed.length) return fail('No changes provided.', 422)
    const updated = await db.department.update({ where: { id }, data })
    await writeAudit({
      actorId: session.userId, actorName: session.fullName, actorRole: session.role,
      entityType: 'RULE', entityId: id, fieldName: 'department.updated',
      oldValue: changed.map((k) => `${k}=${cur[k] ?? ''}`).join('; '), newValue: changed.map((k) => `${k}=${updated[k] ?? ''}`).join('; '),
      reason: `Department “${cur.name}” updated`, ipAddress: clientIp(req),
    })
    return ok({ ok: true })
  })
}

/** Delete a department — only when nothing refers to it (people, teams, designations). Deactivate it instead otherwise. */
export async function DELETE(req: NextRequest, ctx: Ctx) {
  return guard(async () => {
    const session = await requireSession()
    if (!isOrgAdmin(session.role)) return fail('Forbidden: only System Admin / HR Manager can manage departments.', 403)
    const { id } = await ctx.params
    const cur = await db.department.findUnique({ where: { id }, include: { _count: { select: { users: true, teams: true, designations: true } } } })
    if (!cur) return fail('Department not found.', 404)
    const { users, teams, designations } = cur._count
    if (users || teams || designations) {
      const parts = [users && `${users} employee(s)`, teams && `${teams} team(s)`, designations && `${designations} designation(s)`].filter(Boolean).join(', ')
      return fail(`“${cur.name}” still has ${parts}. Move or delete them first — or mark the department inactive instead.`, 409)
    }
    await db.department.delete({ where: { id } })
    await writeAudit({
      actorId: session.userId, actorName: session.fullName, actorRole: session.role,
      entityType: 'RULE', entityId: id, fieldName: 'department.deleted', oldValue: `${cur.name} (${cur.code})`,
      reason: 'Department deleted', ipAddress: clientIp(req),
    })
    return ok({ ok: true })
  })
}

export const dynamic = 'force-dynamic'
