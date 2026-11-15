import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireSession, guard, ok, fail } from '@/lib/hrms/api-utils'
import { ROLES } from '@/lib/hrms/constants'
import { writeAudit } from '@/lib/hrms/audit'
import { cleanText } from '@/lib/hrms/sanitize'

/** Company / payroll / device settings. Read for admins+accountant, write SUPER_ADMIN only. */
export async function GET() {
  return guard(async () => {
    const session = await requireSession()
    const rows = await db.setting.findMany()
    const map: Record<string, unknown> = {}
    for (const r of rows) {
      try { map[r.key] = JSON.parse(r.value) } catch { map[r.key] = r.value }
    }
    const privileged = [ROLES.SUPER_ADMIN, ROLES.HR_MANAGER, ROLES.ACCOUNTANT].includes(session.role)
    if (!privileged) {
      // employees only see company identity
      return ok({ settings: { 'company.profile': map['company.profile'] ?? null } })
    }
    return ok({ settings: map })
  })
}

export async function PATCH(req: NextRequest) {
  return guard(async () => {
    const session = await requireSession()
    if (session.role !== ROLES.SUPER_ADMIN) return fail('Forbidden: only the System Admin can change global settings.', 403)
    const body = await req.json().catch(() => null)
    if (!body?.key) return fail('key required.', 422)
    const key = cleanText(body.key, 60)
    const value = typeof body.value === 'string' ? body.value : JSON.stringify(body.value)
    await db.setting.upsert({ where: { key }, create: { key, value }, update: { value } })
    await writeAudit({
      actorId: session.userId, actorName: session.fullName, actorRole: session.role,
      entityType: 'RULE', entityId: key, fieldName: 'setting', newValue: value.slice(0, 500),
      reason: cleanText(body?.reason, 200) || 'Settings update',
    })
    return ok({ ok: true })
  })
}

export const dynamic = 'force-dynamic'
