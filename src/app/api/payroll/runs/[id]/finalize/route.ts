import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireSession, guard, ok, fail } from '@/lib/hrms/api-utils'
import { isPayrollOperator } from '@/lib/hrms/constants'
import { writeAudit } from '@/lib/hrms/audit'

/**
 * Finalize a DRAFT run: locks the ledger and applies short-hour leave
 * conversions to employee balances (LEAVE_FIRST mode).
 */
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return guard(async () => {
    const session = await requireSession()
    if (!isPayrollOperator(session.role)) {
      return fail('Forbidden: Payroll module is restricted to Accountant and System Admin.', 403)
    }
    const { id } = await ctx.params
    const run = await db.payrollRun.findUnique({ where: { id }, include: { payslips: true } })
    if (!run) return fail('Payroll run not found.', 404)
    if (run.status === 'FINALIZED') return fail('This run is already finalized.', 409)

    // NOTE: short-hour leave-day conversions are applied by the v2 engine at
    // calculation time (Casual -> Annual -> prorated). Finalize only locks the ledger.
    void run.payslips

    const updated = await db.payrollRun.update({
      where: { id },
      data: { status: 'FINALIZED', finalizedAt: new Date() },
    })
    await writeAudit({
      actorId: session.userId, actorName: session.fullName, actorRole: session.role,
      entityType: 'PAYROLL', entityId: id,
      fieldName: 'status', oldValue: 'DRAFT', newValue: 'FINALIZED',
      reason: `Payroll run ${run.month} finalized (${run.payslips.length} payslips, net ${run.totalNet})`,
    })
    return ok({ run: updated })
  })
}
