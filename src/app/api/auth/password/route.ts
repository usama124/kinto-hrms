import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getSession, hashPassword, verifyPassword } from '@/lib/auth'
import { guard, fail, ok } from '@/lib/hrms/api-utils'
import { revokeAllForUser } from '@/lib/hrms/tokens'
import { startSession } from '@/lib/hrms/session'
import { passwordPolicyError } from '@/lib/hrms/password'
import { guardRate, clientIp, RATE_LIMITS } from '@/lib/hrms/rate-limit'
import { writeAudit } from '@/lib/hrms/audit'

/** Change own password (current + new). Every other session is revoked; this browser gets a fresh one. */
export async function POST(req: NextRequest) {
  return guard(async () => {
    const session = await getSession() // allowed while MFA enrollment is pending
    if (!session) return fail('Not authenticated.', 401)
    const rl = guardRate(req, 'password', RATE_LIMITS.AUTH.max, RATE_LIMITS.AUTH.windowMs)
    if (!rl.ok) return fail(`Too many attempts. Retry after ${rl.retryAfterSec}s.`, 429)

    const body = await req.json().catch(() => null)
    const current = String(body?.currentPassword ?? '').slice(0, 256)
    const next = String(body?.newPassword ?? '')
    const user = await db.user.findUnique({ where: { id: session.userId } })
    if (!user) return fail('Account not found.', 404)
    if (!verifyPassword(current, user.passwordHash)) return fail('Current password is incorrect.', 401)
    const problem = passwordPolicyError(next)
    if (problem) return fail(problem, 422)
    if (next === current) return fail('New password must differ from the current one.', 422)

    await db.user.update({ where: { id: user.id }, data: { passwordHash: hashPassword(next), failedAttempts: 0, lockedUntil: null, mustChangePassword: false } })
    await revokeAllForUser(user.id)
    await writeAudit({
      actorId: user.id, actorName: user.fullName, actorRole: user.role,
      entityType: 'SECURITY', entityId: user.id, fieldName: 'password', reason: 'Password changed by user; all sessions revoked',
      ipAddress: clientIp(req),
    })
    const res = ok({ ok: true }) as NextResponse
    await startSession(res, user, clientIp(req))
    return res
  })
}

export const dynamic = 'force-dynamic'
