import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireSession, guard, ok, fail } from '@/lib/hrms/api-utils'
import { isPayrollOperator, ROLES } from '@/lib/hrms/constants'
import { writeAudit } from '@/lib/hrms/audit'

/** Run detail with payslip ledger (Accountant + Admin). */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return guard(async () => {
    const session = await requireSession()
    if (!isPayrollOperator(session.role) && session.role !== ROLES.HR_MANAGER) {
      return fail('Forbidden: Payroll module is restricted to Accountant and System Admin.', 403)
    }
    const { id } = await ctx.params
    const run = await db.payrollRun.findUnique({
      where: { id },
      include: {
        createdBy: { select: { fullName: true } },
        payslips: {
          include: { user: { select: { id: true, fullName: true, employeeCode: true, designation: true, avatarColor: true, department: { select: { name: true } } } } },
          orderBy: { netPay: 'desc' },
        },
      },
    })
    if (!run) return fail('Payroll run not found.', 404)
    return ok({ run })
  })
}

/**
 * Discard a DRAFT run so the month can be recalculated (salary/attendance/adjustment fixes).
 * Safe because drafts no longer touch balances or loans — that only happens at finalize.
 */
export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return guard(async () => {
    const session = await requireSession()
    if (!isPayrollOperator(session.role)) return fail('Forbidden: only the Accountant or System Admin can discard payroll runs.', 403)
    const { id } = await ctx.params
    const run = await db.payrollRun.findUnique({ where: { id } })
    if (!run) return fail('Payroll run not found.', 404)
    // status in the where-clause makes a racing finalize win: nothing is deleted then
    const deleted = await db.$transaction(async (tx) => {
      if ((await tx.payrollRun.count({ where: { id, status: 'DRAFT' } })) === 0) return false
      await tx.payslip.deleteMany({ where: { runId: id } })
      await tx.payrollRun.delete({ where: { id } })
      return true
    })
    if (!deleted) return fail('A finalized run is locked and cannot be discarded.', 409)
    await writeAudit({
      actorId: session.userId, actorName: session.fullName, actorRole: session.role,
      entityType: 'PAYROLL', entityId: id, reason: `Draft payroll run ${run.month} discarded`,
    })
    return ok({ ok: true })
  })
}
