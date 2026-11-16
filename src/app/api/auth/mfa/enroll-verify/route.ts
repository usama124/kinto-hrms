import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { guard, fail, ok } from '@/lib/hrms/api-utils'
import { verifyTotpOnce } from '@/lib/hrms/totp'
import { decryptSecret } from '@/lib/hrms/secrets'
import { guardRate, clientIp, RATE_LIMITS } from '@/lib/hrms/rate-limit'
import { writeAudit } from '@/lib/hrms/audit'

/** Confirm enrollment with a live TOTP code → MFA becomes mandatory at login. */
export async function POST(req: NextRequest) {
  return guard(async () => {
    const session = await getSession()
    if (!session) return fail('Not authenticated.', 401)
    const rl = guardRate(req, 'mfa-enroll-verify', RATE_LIMITS.MFA_ENROLL.max, RATE_LIMITS.MFA_ENROLL.windowMs)
    if (!rl.ok) return fail(`Too many attempts. Retry after ${rl.retryAfterSec}s.`, 429)

    const body = await req.json().catch(() => null)
    const code = String(body?.code ?? '').slice(0, 16)
    const user = await db.user.findUnique({ where: { id: session.userId } })
    if (!user || !user.mfaSecret) return fail('Start enrollment first.', 422)
    if (user.mfaEnabled) return fail('MFA is already enabled.', 409)

    if (!verifyTotpOnce(user.id, decryptSecret(user.mfaSecret), code)) return fail('Invalid code — check your authenticator app.', 422)

    await db.user.update({ where: { id: user.id }, data: { mfaEnabled: true } })
    await writeAudit({
      actorId: user.id, actorName: user.fullName, actorRole: user.role,
      entityType: 'MFA', entityId: user.id, fieldName: 'mfaEnabled', oldValue: 'false', newValue: 'true',
      reason: 'TOTP enrollment confirmed', ipAddress: clientIp(req),
    })
    return ok({ mfaEnabled: true })
  })
}

export const dynamic = 'force-dynamic'
