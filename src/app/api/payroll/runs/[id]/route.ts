import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireSession, guard, ok, fail } from '@/lib/hrms/api-utils'
import { isPayrollOperator, ROLES } from '@/lib/hrms/constants'

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
