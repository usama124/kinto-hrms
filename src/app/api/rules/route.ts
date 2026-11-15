import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireSession, guard, ok, fail } from '@/lib/hrms/api-utils'
import { ROLES, isOrgAdmin } from '@/lib/hrms/constants'
import { writeAudit } from '@/lib/hrms/audit'

/** Admin-configurable HR rules + leave caps + holiday calendar. */
export async function GET() {
  return guard(async () => {
    const session = await requireSession()
    if (!isOrgAdmin(session.role)) return fail('Forbidden: Rules & Settings is Admin / HR only.', 403)

    const [rules, leaveTypes, holidays, shift] = await Promise.all([
      db.policyRule.findMany({ orderBy: { key: 'asc' } }),
      db.leaveType.findMany({ orderBy: { name: 'asc' } }),
      db.holiday.findMany({ orderBy: { date: 'asc' } }),
      db.shift.findFirst(),
    ])
    return ok({ rules, leaveTypes, holidays, shift })
  })
}

/** Update rule values and leave-type caps (Admin only). */
export async function PUT(req: NextRequest) {
  return guard(async () => {
    const session = await requireSession()
    if (!isOrgAdmin(session.role)) return fail('Forbidden: only Admin / HR can edit policy rules.', 403)

    const body = await req.json().catch(() => null)
    if (!body) return fail('Invalid payload.', 422)

    const updates: { key: string; value: string }[] = Array.isArray(body.rules) ? body.rules : []
    for (const u of updates) {
      const existing = await db.policyRule.findUnique({ where: { key: u.key } })
      if (existing) {
        await db.policyRule.update({ where: { key: u.key }, data: { value: String(u.value) } })
      } else if (['0', '1', '2'].includes(String(u.value)) || !Number.isNaN(Number(u.value))) {
        // allow only known keys — ignore unknown
      }
    }

    const leaveCaps: { leaveTypeId: string; monthlyCap: number | null; attachmentThreshold: number | null; annualQuota: number }[] = Array.isArray(body.leaveCaps) ? body.leaveCaps : []
    for (const c of leaveCaps) {
      const lt = await db.leaveType.findUnique({ where: { id: c.leaveTypeId } })
      if (!lt) continue
      await db.leaveType.update({
        where: { id: lt.id },
        data: {
          monthlyCap: c.monthlyCap == null || c.monthlyCap < 1 ? null : Math.floor(c.monthlyCap),
          attachmentThreshold: c.attachmentThreshold == null || c.attachmentThreshold < 1 ? null : Math.floor(c.attachmentThreshold),
          annualQuota: Math.max(0, Number(c.annualQuota) || 0),
        },
      })
    }

    if (body.holiday?.date && body.holiday?.name) {
      await db.holiday.upsert({
        where: { date: String(body.holiday.date) },
        update: { name: String(body.holiday.name) },
        create: { date: String(body.holiday.date), name: String(body.holiday.name) },
      })
    }
    if (body.removeHoliday) {
      await db.holiday.deleteMany({ where: { date: String(body.removeHoliday) } })
    }

    await writeAudit({
      actorId: session.userId, actorName: session.fullName, actorRole: session.role,
      entityType: 'RULE', entityId: '-',
      reason: 'Policy / leave-cap update', meta: JSON.stringify(body).slice(0, 400),
    })

    const [rules, leaveTypes, holidays] = await Promise.all([
      db.policyRule.findMany({ orderBy: { key: 'asc' } }),
      db.leaveType.findMany({ orderBy: { name: 'asc' } }),
      db.holiday.findMany({ orderBy: { date: 'asc' } }),
    ])
    return ok({ rules, leaveTypes, holidays })
  })
}
