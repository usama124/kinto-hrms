import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireSession, guard, ok, fail } from '@/lib/hrms/api-utils'
import { isOrgAdmin } from '@/lib/hrms/constants'
import { visibleUserIds } from '@/lib/hrms/rbac'

/** Immutable audit trail — Admin/HR only, optionally scoped to a target user. */
export async function GET(req: NextRequest) {
  return guard(async () => {
    const session = await requireSession()
    if (!isOrgAdmin(session.role)) return fail('Forbidden: audit trail is Admin / HR only.', 403)
    const qp = req.nextUrl.searchParams
    const entityType = qp.get('entityType')
    const targetUserId = qp.get('targetUserId')
    const take = Math.min(Number(qp.get('take') ?? 100), 300)

    const rows = await db.auditLog.findMany({
      where: {
        ...(entityType ? { entityType } : {}),
        ...(targetUserId ? { targetUserId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take,
    })
    return ok({ logs: rows })
  })
}

export const dynamic = 'force-dynamic'
