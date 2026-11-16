import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireSession, guard, ok, fail } from '@/lib/hrms/api-utils'
import { isPayrollOperator } from '@/lib/hrms/constants'
import { pickShortConversionBalance } from '@/lib/hrms/payroll-v2'
import { writeAudit } from '@/lib/hrms/audit'

/**
 * Finalize a DRAFT run — one transaction that:
 *  1. claims DRAFT → FINALIZED (a concurrent/double finalize gets 409 and applies nothing)
 *  2. debits short-hour leave conversions from Casual/Annual balances (LEAVE_FIRST mode)
 *  3. advances each deducted loan by one installment (closing it when fully paid)
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

    const year = Number(run.month.slice(0, 4))
    const claimed = await db.$transaction(async (tx) => {
      const c = await tx.payrollRun.updateMany({ where: { id, status: 'DRAFT' }, data: { status: 'FINALIZED', finalizedAt: new Date() } })
      if (c.count === 0) return false

      for (const p of run.payslips) {
        if (p.shortConvertedFromBalance > 0) {
          const bal = await pickShortConversionBalance(tx, p.userId, year)
          if (bal) await tx.leaveBalance.update({ where: { id: bal.id }, data: { availed: { increment: p.shortConvertedFromBalance } } })
        }
        // loanId is stored in the payslip snapshot; drafts created before this change have none and are skipped
        const loanId = p.internalLoan > 0 && p.loanStatus ? (JSON.parse(p.loanStatus) as { loanId?: string }).loanId : undefined
        if (loanId) {
          const loan = await tx.loan.update({ where: { id: loanId }, data: { paidInstallments: { increment: 1 } } })
          if (loan.paidInstallments >= loan.installments) await tx.loan.update({ where: { id: loanId }, data: { isActive: false } })
        }
      }
      return true
    }, { timeout: 30_000 })
    if (!claimed) return fail('This run is already finalized.', 409)

    await writeAudit({
      actorId: session.userId, actorName: session.fullName, actorRole: session.role,
      entityType: 'PAYROLL', entityId: id,
      fieldName: 'status', oldValue: 'DRAFT', newValue: 'FINALIZED',
      reason: `Payroll run ${run.month} finalized (${run.payslips.length} payslips, net ${run.totalNet})`,
    })
    return ok({ run: await db.payrollRun.findUnique({ where: { id } }) })
  })
}
