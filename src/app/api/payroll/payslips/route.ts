import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireSession, guard, ok, fail } from '@/lib/hrms/api-utils'
import { visibleUserIds } from '@/lib/hrms/rbac'
import { ROLES, isPayrollOperator, isOrgAdmin } from '@/lib/hrms/constants'

/** Payslip list — Employee: own only; Admin/Accountant: all; Manager/TL: scoped hierarchy. */
export async function GET(req: NextRequest) {
  return guard(async () => {
    const session = await requireSession()
    const qp = req.nextUrl.searchParams
    const userId = qp.get('userId')
    const month = qp.get('month')

    let target: string[] | null = null
    if (userId) {
      const allowed =
        userId === session.userId ||
        isPayrollOperator(session.role) ||
        isOrgAdmin(session.role) ||
        (await visibleUserIds(session)).includes(userId)
      if (!allowed) return fail('Forbidden: you cannot view this employee’s payslips.', 403)
      target = [userId]
    } else if (!isPayrollOperator(session.role) && !isOrgAdmin(session.role)) {
      target = await visibleUserIds(session)
    }

    const slips = await db.payslip.findMany({
      where: {
        ...(target ? { userId: { in: target } } : {}),
        ...(month ? { run: { month } } : {}),
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
