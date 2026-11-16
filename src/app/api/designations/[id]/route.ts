import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireSession, guard, ok, fail } from '@/lib/hrms/api-utils'
import { isOrgAdmin } from '@/lib/hrms/constants'
import { cleanText } from '@/lib/hrms/sanitize'
import { writeAudit } from '@/lib/hrms/audit'
import { clientIp } from '@/lib/hrms/rate-limit'
import { designationDto } from '@/lib/hrms/designations'
import { exceedsMaxDepth, MAX_DESIGNATION_DEPTH, parseLevelRank, wouldCreateCycle } from '@/lib/hrms/designation-tree'

type Ctx = { params: Promise<{ id: string }> }

/**
 * Edit a designation: name, description, department, parent, level rank, active/inactive.
 * Rules: the parent must be in the same department and can never be the designation itself or one of its own
 * descendants (no loops); moving to another department needs the designation to be a free-standing leaf with nobody in it;
 * renaming updates the title shown for everyone who holds it.
 */
export async function PATCH(req: NextRequest, ctx: Ctx) {
  return guard(async () => {
    const session = await requireSession()
    if (!isOrgAdmin(session.role)) return fail('Forbidden: only System Admin / HR Manager can edit designations.', 403)
    const { id } = await ctx.params
    const cur = await db.designation.findUnique({ where: { id }, include: { _count: { select: { users: true, children: true } } } })
    if (!cur) return fail('Designation not found.', 404)
    const body = await req.json().catch(() => null)
    if (!body) return fail('Invalid JSON body.', 400)

    const data: { name?: string; description?: string | null; departmentId?: string; parentDesignationId?: string | null; levelRank?: number; isActive?: boolean } = {}

    // ── department move ────────────────────────────────────────────────────────
    let departmentId = cur.departmentId
    if (body.departmentId !== undefined && String(body.departmentId) !== cur.departmentId) {
      const dest = await db.department.findUnique({ where: { id: String(body.departmentId) } })
      if (!dest) return fail('Department not found.', 422)
      if (!dest.isActive) return fail(`${dest.name} is inactive.`, 422)
      if (cur._count.children) return fail('This designation has nested designations under it. Move or delete them before changing its department.', 409)
      if (cur._count.users) return fail(`${cur._count.users} employee(s) hold this designation, so it cannot move to another department.`, 409)
      departmentId = dest.id
      data.departmentId = dest.id
    }

    const all = await db.designation.findMany({ where: { departmentId }, select: { id: true, name: true, departmentId: true, parentDesignationId: true, levelRank: true } })

    // ── name ───────────────────────────────────────────────────────────────────
    const name = body.name !== undefined ? cleanText(body.name, 80) : cur.name
    if (name.length < 2) return fail('Designation name is required (at least 2 characters).', 422)
    if ((name !== cur.name || departmentId !== cur.departmentId) && all.some((d) => d.id !== id && d.name.toLowerCase() === name.toLowerCase())) {
      return fail('This department already has a designation with that name.', 409)
    }
    if (name !== cur.name) data.name = name

    // ── parent ─────────────────────────────────────────────────────────────────
    let parentId = cur.parentDesignationId
    if (body.parentDesignationId !== undefined) parentId = body.parentDesignationId ? String(body.parentDesignationId) : null
    if (data.departmentId) parentId = body.parentDesignationId ? String(body.parentDesignationId) : null // old parent belongs to the old department
    if (parentId !== cur.parentDesignationId) {
      if (parentId) {
        if (!all.some((d) => d.id === parentId)) return fail('The parent designation must belong to the same department.', 422)
        if (wouldCreateCycle(all, id, parentId)) return fail('A designation cannot be placed under itself or under one of its own sub-designations (that would create a loop).', 422)
        if (exceedsMaxDepth(all, id, parentId)) return fail(`Designations can be nested at most ${MAX_DESIGNATION_DEPTH} levels deep.`, 422)
      }
      data.parentDesignationId = parentId
    }

    // ── rank / description / status ────────────────────────────────────────────
    const rank = parseLevelRank(body.levelRank)
    if (rank === 'invalid') return fail('Level rank must be a whole number from 1 to 99.', 422)
    if (rank !== undefined && rank !== cur.levelRank) data.levelRank = rank
    if (body.description !== undefined) {
      const description = cleanText(body.description, 300) || null
      if (description !== cur.description) data.description = description
    }
    if (body.isActive !== undefined && Boolean(body.isActive) !== cur.isActive) data.isActive = Boolean(body.isActive)

    const changed = Object.keys(data) as (keyof typeof data)[]
    if (!changed.length) return fail('No changes provided.', 422)

    const updated = await db.$transaction(async (tx) => {
      const u = await tx.designation.update({
        where: { id }, data,
        include: { department: { select: { name: true } }, _count: { select: { users: true } } },
      })
      // keep the denormalised title on employees in step with a rename
      if (data.name) await tx.user.updateMany({ where: { designationId: id }, data: { designation: data.name } })
      return u
    })
    await writeAudit({
      actorId: session.userId, actorName: session.fullName, actorRole: session.role,
      entityType: 'RULE', entityId: id, fieldName: 'designation.updated',
      oldValue: changed.map((k) => `${k}=${cur[k] ?? ''}`).join('; '), newValue: changed.map((k) => `${k}=${updated[k] ?? ''}`).join('; '),
      reason: `Designation “${cur.name}” updated`, ipAddress: clientIp(req),
    })
    return ok({ designation: designationDto(updated) })
  })
}

/** Delete — only a designation with nobody in it and nothing nested under it (otherwise deactivate it). */
export async function DELETE(req: NextRequest, ctx: Ctx) {
  return guard(async () => {
    const session = await requireSession()
    if (!isOrgAdmin(session.role)) return fail('Forbidden: only System Admin / HR Manager can delete designations.', 403)
    const { id } = await ctx.params
    const cur = await db.designation.findUnique({ where: { id }, include: { department: { select: { name: true } }, _count: { select: { users: true, children: true } } } })
    if (!cur) return fail('Designation not found.', 404)
    if (cur._count.children) return fail(`“${cur.name}” has ${cur._count.children} designation(s) nested under it. Move or delete those first.`, 409)
    if (cur._count.users) return fail(`${cur._count.users} employee(s) currently hold “${cur.name}”. Reassign them first — or mark it inactive instead.`, 409)
    await db.designation.delete({ where: { id } })
    await writeAudit({
      actorId: session.userId, actorName: session.fullName, actorRole: session.role,
      entityType: 'RULE', entityId: id, fieldName: 'designation.deleted', oldValue: `${cur.name} @ ${cur.department.name}`,
      reason: 'Designation deleted', ipAddress: clientIp(req),
    })
    return ok({ ok: true })
  })
}

export const dynamic = 'force-dynamic'
