import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireSession, guard, ok, fail } from '@/lib/hrms/api-utils'
import { isOrgAdmin } from '@/lib/hrms/constants'
import { cleanText } from '@/lib/hrms/sanitize'
import { writeAudit } from '@/lib/hrms/audit'
import { clientIp } from '@/lib/hrms/rate-limit'
import { getDesignations, saveDesignations, findDesignation, MAX_DESIGNATIONS } from '@/lib/hrms/designations'

/** Designation list with how many people hold each title. Readable by everyone signed in (the employee form needs it). */
export async function GET() {
  return guard(async () => {
    await requireSession()
    const [list, counts] = await Promise.all([
      getDesignations(),
      db.user.groupBy({ by: ['designation'], _count: { _all: true } }),
    ])
    const byName = new Map(counts.map((c) => [c.designation.toLowerCase(), c._count._all]))
    return ok({ designations: list.map((name) => ({ name, count: byName.get(name.toLowerCase()) ?? 0 })) })
  })
}

/** Add a designation (System Admin / HR Manager). */
export async function POST(req: NextRequest) {
  return guard(async () => {
    const session = await requireSession()
    if (!isOrgAdmin(session.role)) return fail('Forbidden: only System Admin / HR Manager can define designations.', 403)
    const body = await req.json().catch(() => null)
    const name = cleanText(body?.name, 80)
    if (name.length < 2) return fail('Designation name is required (at least 2 characters).', 422)
    const list = await getDesignations()
    if (findDesignation(list, name)) return fail('That designation already exists.', 409)
    if (list.length >= MAX_DESIGNATIONS) return fail(`Designation limit reached (${MAX_DESIGNATIONS}).`, 422)
    await saveDesignations([...list, name])
    await writeAudit({
      actorId: session.userId, actorName: session.fullName, actorRole: session.role,
      entityType: 'RULE', entityId: 'org.designations', fieldName: 'designation.added', newValue: name,
      reason: 'Designation defined', ipAddress: clientIp(req),
    })
    return ok({ name }, { status: 201 })
  })
}

/** Remove a designation — only when nobody holds it (so no employee is left with an undefined title). */
export async function DELETE(req: NextRequest) {
  return guard(async () => {
    const session = await requireSession()
    if (!isOrgAdmin(session.role)) return fail('Forbidden: only System Admin / HR Manager can remove designations.', 403)
    const body = await req.json().catch(() => null)
    const list = await getDesignations()
    const name = findDesignation(list, String(body?.name ?? ''))
    if (!name) return fail('Designation not found.', 404)
    const inUse = await db.user.count({ where: { designation: name } })
    if (inUse > 0) return fail(`${inUse} employee(s) currently hold “${name}”. Reassign them first.`, 409)
    await saveDesignations(list.filter((d) => d !== name))
    await writeAudit({
      actorId: session.userId, actorName: session.fullName, actorRole: session.role,
      entityType: 'RULE', entityId: 'org.designations', fieldName: 'designation.removed', oldValue: name,
      reason: 'Designation removed', ipAddress: clientIp(req),
    })
    return ok({ ok: true })
  })
}

export const dynamic = 'force-dynamic'
