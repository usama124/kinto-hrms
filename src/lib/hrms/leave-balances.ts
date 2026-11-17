import 'server-only'
import { db } from '@/lib/db'
import { createManySkipDuplicates } from '@/lib/hrms/db-compat'

/**
 * Make sure a user has a balance row for every leave type in `year` (idempotent: the
 * user+type+year unique key + skipDuplicates make concurrent calls safe). Covers accounts that
 * never had balances provisioned (e.g. the System Admin) and the first request of a new year.
 */
export async function ensureLeaveBalances(userId: string, year: number): Promise<void> {
  // read first: this runs on every dashboard load, and the common case is "nothing to create" — so don't issue a write
  const [types, have] = await Promise.all([
    db.leaveType.findMany({ select: { id: true } }),
    db.leaveBalance.findMany({ where: { userId, year }, select: { leaveTypeId: true } }),
  ])
  const owned = new Set(have.map((h) => h.leaveTypeId))
  const missing = types.filter((t) => !owned.has(t.id))
  if (!missing.length) return
  await createManySkipDuplicates(db.leaveBalance as never, missing.map((t) => ({ userId, leaveTypeId: t.id, year })))
}
