import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireSession, guard, ok, fail } from '@/lib/hrms/api-utils'
import { isPayrollOperator, isOrgAdmin } from '@/lib/hrms/constants'
import { cleanMonth } from '@/lib/hrms/sanitize'

/** Payslip list — Employee: own only; Admin/Accountant: all; Manager/TL: scoped hierarchy. */
export async function GET(req: NextRequest) {
  return guard(async () => {
    const session = await requireSession()
    const qp = req.nextUrl.searchParams
    const userId = qp.get('userId')
    const month = qp.get('month')

    // Compensation is private: the owner, payroll operators and HR/Admin only. A team lead / manager
    // does NOT get their reports' payslips just because those people are in their hierarchy scope.
    const privileged = isPayrollOperator(session.role) || isOrgAdmin(session.role)
    let target: string[] | null = null
    if (userId) {
      if (userId !== session.userId && !privileged) return fail('Forbidden: you cannot view this employee’s payslips.', 403)
      target = [userId]
    } else if (!privileged) {
      target = [session.userId]
    }
    if (month !== null && !cleanMonth(month)) return fail('month must be YYYY-MM.', 422)

    const slips = await db.payslip.findMany({
      where: {
        ...(target ? { userId: { in: target } } : {}),
        // employees only ever see finalized slips; drafts are for the payroll team
        run: { ...(month ? { month } : {}), ...(privileged ? {} : { status: 'FINALIZED' }) },
      },
      include: {
        user: { select: { id: true, fullName: true, employeeCode: true, designation: true, avatarColor: true, department: { select: { name: true } } } },
        run: { select: { id: true, month: true, status: true } },
      },
      orderBy: [{ userId: 'asc' }, { run: { month: 'desc' } }],
    })
    return ok({ payslips: slips })
  })
}

export const dynamic = 'force-dynamic'
