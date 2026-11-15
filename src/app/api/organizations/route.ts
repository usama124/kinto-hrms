import { NextRequest } from 'next/server'
import { requireSession, guard, ok, fail } from '@/lib/hrms/api-utils'
import { isOrgAdmin } from '@/lib/hrms/constants'
import { departmentMatrix } from '@/lib/hrms/org-stats'
import { todayKey } from '@/lib/hrms/dates'

/** Level 1 — Department Health Matrix (Admin/HR only). */
export async function GET(req: NextRequest) {
  return guard(async () => {
    const session = await requireSession()
    if (!isOrgAdmin(session.role)) return fail('Forbidden: org drill-down is restricted to Admin / HR.', 403)
    const month = req.nextUrl.searchParams.get('month') ?? todayKey().slice(0, 7)
    const departments = await departmentMatrix(month)
    return ok({ month, departments })
  })
}

export const dynamic = 'force-dynamic'
