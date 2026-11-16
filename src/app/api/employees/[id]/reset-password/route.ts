import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { hashPassword } from '@/lib/auth'
import { requireSession, guard, ok, fail } from '@/lib/hrms/api-utils'
import { isOrgAdmin, ROLES } from '@/lib/hrms/constants'
import { generateTempPassword } from '@/lib/hrms/password'
import { revokeAllForUser } from '@/lib/hrms/tokens'
import { guardRate, clientIp, RATE_LIMITS } from '@/lib/hrms/rate-limit'
import { writeAudit } from '@/lib/hrms/audit'

/**
 * Issue a new TEMPORARY password for an employee who has lost theirs (or never recorded the one shown at onboarding).
 * The password is returned ONCE; the employee must replace it at next sign-in (mustChangePassword). All their sessions
 * are revoked and any lockout is cleared. Same authority rules as editing a profile: only the System Admin can reset an
 * HR Manager or another System Admin; nobody resets their own here (use Change password).
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return guard(async () => {
    const session = await requireSession()
    if (!isOrgAdmin(session.role)) return fail('Forbidden: only System Admin / HR Manager can reset passwords.', 403)
    const rl = guardRate(req, 'pw-reset', RATE_LIMITS.AUTH.max, RATE_LIMITS.AUTH.windowMs)
    if (!rl.ok) return fail(`Too many attempts. Retry after ${rl.retryAfterSec}s.`, 429)

    const { id } = await ctx.params
    if (id === session.userId) return fail('Use “Change password” in My Profile to change your own password.', 422)
    const target = await db.user.findUnique({ where: { id }, select: { id: true, fullName: true, email: true, role: true, isActive: true } })
    if (!target) return fail('Employee not found.', 404)
    // Resetting a password = taking over the account. HR must not be able to take over anyone who holds
    // privileged powers (payroll finalize/run, HR, admin): only the System Admin resets those.
    if (session.role !== ROLES.SUPER_ADMIN && ([ROLES.SUPER_ADMIN, ROLES.HR_MANAGER, ROLES.ACCOUNTS_MANAGER, ROLES.ACCOUNTANT] as string[]).includes(target.role)) {
      return fail('Forbidden: only the System Admin can reset the password of an HR Manager, Accounts role or System Admin.', 403)
    }

    const temporaryPassword = generateTempPassword()
    await db.user.update({
      where: { id },
      data: { passwordHash: hashPassword(temporaryPassword), mustChangePassword: true, failedAttempts: 0, lockedUntil: null },
    })
    await revokeAllForUser(id)
    await writeAudit({
      actorId: session.userId, actorName: session.fullName, actorRole: session.role,
      targetUserId: target.id, targetName: target.fullName,
      entityType: 'SECURITY', entityId: target.id, fieldName: 'password', reason: 'Temporary password issued by HR/Admin; sessions revoked',
      ipAddress: clientIp(req),
    })
    return ok({ email: target.email, temporaryPassword }, { headers: { 'Cache-Control': 'no-store' } })
  })
}

export const dynamic = 'force-dynamic'
