import 'server-only'
import { db } from '@/lib/db'

/**
 * Make sure a user has a balance row for every leave type in `year` (idempotent: the
 * user+type+year unique key + skipDuplicates make concurrent calls safe). Covers accounts that
 * never had balances provisioned (e.g. the System Admin) and the first request of a new year.
 */
export async function ensureLeaveBalances(userId: string, year: number): Promise<void> {
  const types = await db.leaveType.findMany({ select: { id: true } })
  if (!types.length) return
  await db.leaveBalance.createMany({
    data: types.map((t) => ({ userId, leaveTypeId: t.id, year })),
    skipDuplicates: true,
  })
}
