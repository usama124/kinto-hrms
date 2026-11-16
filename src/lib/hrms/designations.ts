import 'server-only'
import { db } from '@/lib/db'
import { nameLike, sameName } from '@/lib/hrms/db-compat'

/** Which company designation does an employee create/update refer to? Prefers the id; falls back to an exact (case-insensitive) name. */
export type ResolvedDesignation = { id: string; name: string; departmentId: string; departmentName: string }

export async function resolveDesignation(input: {
  designationId?: unknown
  designation?: unknown
  /** the employee's department, when known — narrows a name match and is checked for consistency */
  departmentId?: string | null
}): Promise<{ ok: true; value: ResolvedDesignation } | { ok: false; error: string }> {
  const pick = (d: { id: string; name: string; departmentId: string; department: { name: string } }): ResolvedDesignation =>
    ({ id: d.id, name: d.name, departmentId: d.departmentId, departmentName: d.department.name })
  const include = { department: { select: { name: true } } } as const
  let found: ResolvedDesignation | null = null

  const id = typeof input.designationId === 'string' ? input.designationId : ''
  if (id) {
    const d = await db.designation.findUnique({ where: { id }, include })
    if (!d || !d.isActive) return { ok: false, error: 'That designation does not exist or is inactive.' }
    found = pick(d)
  } else {
    const name = typeof input.designation === 'string' ? input.designation.trim() : ''
    if (!name) return { ok: false, error: 'A designation is required.' }
    const matches = (await db.designation.findMany({
      where: { name: nameLike(name), isActive: true, ...(input.departmentId ? { departmentId: input.departmentId } : {}) },
      include,
    })).filter((m) => sameName(m.name, name))
    if (matches.length === 0) {
      return { ok: false, error: 'Choose a designation defined in Rules & Settings → Designations. If it is missing, an admin must add it under the right department first.' }
    }
    if (matches.length > 1) return { ok: false, error: `“${name}” exists in several departments — select the exact designation from the list.` }
    found = pick(matches[0])
  }

  if (input.departmentId && found.departmentId !== input.departmentId) {
    return { ok: false, error: `“${found.name}” belongs to the ${found.departmentName} department, not the employee's department.` }
  }
  return { ok: true, value: found }
}

/** Shape sent to the browser. */
export function designationDto(d: {
  id: string; name: string; description: string | null; departmentId: string; parentDesignationId: string | null
  levelRank: number; isActive: boolean; department?: { name: string } | null; _count?: { users: number }
}) {
  return {
    id: d.id, name: d.name, description: d.description, departmentId: d.departmentId,
    departmentName: d.department?.name ?? null, parentDesignationId: d.parentDesignationId,
    levelRank: d.levelRank, isActive: d.isActive, employeeCount: d._count?.users ?? 0,
  }
}
