import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireSession, guard, ok, fail } from '@/lib/hrms/api-utils'
import { isPayrollOperator } from '@/lib/hrms/constants'
import { cleanNumber, cleanText } from '@/lib/hrms/sanitize'
import { writeAudit, writeAuditDiff } from '@/lib/hrms/audit'
import { clientIp } from '@/lib/hrms/rate-limit'

/**
 * PATCH /api/payroll/salary — Accountant-only salary component edits.
 * Every changed field is written to the immutable audit log.
 */
export async function PATCH(req: NextRequest) {
  return guard(async () => {
    const session = await requireSession()
    if (!isPayrollOperator(session.role)) {
      return fail('Forbidden: only the Accountant or System Admin may edit salary components.', 403)
    }

    const body = await req.json().catch(() => null)
    const userId = String(body?.userId ?? '')
    if (!userId) return fail('userId required.', 422)

    const target = await db.user.findUnique({ where: { id: userId } })
    if (!target) return fail('Employee not found.', 404)
    if (target.role === 'SUPER_ADMIN') return fail('System Admin has no salary profile.', 403)
    // segregation of duties: nobody changes their own pay
    if (target.id === session.userId) return fail('Forbidden: you cannot change your own salary components.', 403)

    const patch: { baseSalary?: number; hrAllowance?: number; utilityAllowance?: number; fatherName?: string; bankIban?: string } = {}
    if (body?.baseSalary != null) patch.baseSalary = Math.max(0, cleanNumber(body.baseSalary, target.baseSalary))
    if (body?.hrAllowance != null) patch.hrAllowance = Math.max(0, cleanNumber(body.hrAllowance, target.hrAllowance))
    if (body?.utilityAllowance != null) patch.utilityAllowance = Math.max(0, cleanNumber(body.utilityAllowance, target.utilityAllowance))
    if (body?.fatherName != null) patch.fatherName = cleanText(body.fatherName, 100)
    if (body?.bankIban != null) patch.bankIban = cleanText(body.bankIban, 40)
    if (Object.keys(patch).length === 0) return fail('No editable fields supplied.', 422)

    const updated = await db.user.update({ where: { id: userId }, data: patch })

    await writeAuditDiff(
      {
        actorId: session.userId, actorName: session.fullName, actorRole: session.role,
        targetUserId: target.id, targetName: target.fullName,
        entityType: 'SALARY', entityId: target.id,
        reason: cleanText(body?.reason, 300) || 'Salary component update',
        ipAddress: clientIp(req),
      },
      [
        { fieldName: 'baseSalary', oldValue: target.baseSalary, newValue: patch.baseSalary ?? target.baseSalary },
        { fieldName: 'hrAllowance', oldValue: target.hrAllowance, newValue: patch.hrAllowance ?? target.hrAllowance },
        { fieldName: 'utilityAllowance', oldValue: target.utilityAllowance, newValue: patch.utilityAllowance ?? target.utilityAllowance },
        { fieldName: 'bankIban', oldValue: target.bankIban, newValue: patch.bankIban ?? target.bankIban },
      ],
    )
    await db.notification.create({
      data: { userId: target.id, title: 'Salary components updated', body: 'Your salary structure was updated by the Accounts department.', type: 'PAYROLL' },
    })

    return ok({ user: { id: updated.id, baseSalary: updated.baseSalary, hrAllowance: updated.hrAllowance, utilityAllowance: updated.utilityAllowance } })
  })
}

export const dynamic = 'force-dynamic'
