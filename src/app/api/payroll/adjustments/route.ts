import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireSession, guard, ok, fail } from '@/lib/hrms/api-utils'
import { isPayrollOperator } from '@/lib/hrms/constants'
import { cleanNumber, cleanText } from '@/lib/hrms/sanitize'
import { writeAudit } from '@/lib/hrms/audit'

/** POST /api/payroll/adjustments — monthly bonus / arrears for a payslip. */
export async function POST(req: NextRequest) {
  return guard(async () => {
    const session = await requireSession()
    if (!isPayrollOperator(session.role)) return fail('Forbidden.', 403)

    const body = await req.json().catch(() => null)
    const userId = String(body?.userId ?? '')
    const month = String(body?.month ?? '')
    if (!userId || !/^\d{4}-\d{2}$/.test(month)) return fail('userId and month (YYYY-MM) required.', 422)

    const target = await db.user.findUnique({ where: { id: userId } })
    if (!target || target.role === 'SUPER_ADMIN') return fail('Employee not found.', 404)
    if (target.id === session.userId) return fail('Forbidden: you cannot award yourself a bonus or arrears.', 403)
    // a finalized month is locked: adjustments would silently never be paid
    const lockedRun = await db.payrollRun.findUnique({ where: { month }, select: { status: true } })
    if (lockedRun?.status === 'FINALIZED') return fail('This month is finalized — adjustments are locked.', 409)

    const bonus = Math.max(0, cleanNumber(body?.bonus, 0))
    const arrears = Math.max(0, cleanNumber(body?.arrears, 0))
    const note = cleanText(body?.note, 200)

    const upserted = await db.monthlyAdjustment.upsert({
      where: { userId_month: { userId, month } },
      create: { userId, month, bonus, arrears, note },
      update: { bonus, arrears, note },
    })

    await writeAudit({
      actorId: session.userId, actorName: session.fullName, actorRole: session.role,
      targetUserId: target.id, targetName: target.fullName,
      entityType: 'SALARY', entityId: `${userId}:${month}`,
      fieldName: 'bonus/arrears', oldValue: '—', newValue: `bonus=${bonus}, arrears=${arrears}`,
      reason: note || 'Monthly payroll adjustment', ipAddress: req.headers.get('x-forwarded-for') ?? null,
    })

    return ok({ adjustment: upserted })
  })
}

export const dynamic = 'force-dynamic'
