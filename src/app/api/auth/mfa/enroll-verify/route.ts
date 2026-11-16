import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { guard, fail, ok } from '@/lib/hrms/api-utils'
import { verifyTotpOnce } from '@/lib/hrms/totp'
import { loadAuthenticators, serializeAuthenticators } from '@/lib/hrms/authenticators'
import { guardRate, clientIp, RATE_LIMITS } from '@/lib/hrms/rate-limit'
import { writeAudit } from '@/lib/hrms/audit'

/** Confirm the pending authenticator with a live code → it becomes active (and MFA is switched on for the first one). */
export async function POST(req: NextRequest) {
  return guard(async () => {
    const session = await getSession()
    if (!session) return fail('Not authenticated.', 401)
    const rl = guardRate(req, 'mfa-enroll-verify', RATE_LIMITS.MFA_ENROLL.max, RATE_LIMITS.MFA_ENROLL.windowMs)
    if (!rl.ok) return fail(`Too many attempts. Retry after ${rl.retryAfterSec}s.`, 429)

    const body = await req.json().catch(() => null)
    const code = String(body?.code ?? '').slice(0, 16)
    const user = await db.user.findUnique({ where: { id: session.userId } })
    const items = loadAuthenticators(user?.mfaSecret ?? null)
    const pending = items.find((a) => a.pending && (!body?.id || a.id === body.id))
    if (!user || !pending) return fail('Start enrollment first.', 422)

    if (!verifyTotpOnce(`${user.id}:${pending.id}`, pending.secret, code)) return fail('Invalid code — check your authenticator app.', 422)

    const now = new Date().toISOString()
    await db.user.update({
      where: { id: user.id },
      data: {
        mfaEnabled: true,
        mfaSecret: serializeAuthenticators(items.map((a) => (a.id === pending.id ? { ...a, pending: false, lastUsedAt: now } : a))),
      },
    })
    await writeAudit({
      actorId: user.id, actorName: user.fullName, actorRole: user.role,
      entityType: 'MFA', entityId: user.id, fieldName: 'authenticator.added', newValue: pending.label,
      reason: user.mfaEnabled ? 'Additional authenticator confirmed' : 'TOTP enrollment confirmed', ipAddress: clientIp(req),
    })
    return ok({ mfaEnabled: true })
  })
}

export const dynamic = 'force-dynamic'
