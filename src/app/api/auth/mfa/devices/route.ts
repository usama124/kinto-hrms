import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { verifyPassword } from '@/lib/auth'
import { guard, fail, ok, requireSession } from '@/lib/hrms/api-utils'
import { guardRate, clientIp, RATE_LIMITS } from '@/lib/hrms/rate-limit'
import { verifyBackupCode } from '@/lib/hrms/totp'
import { activeAuthenticators, loadAuthenticators, matchAuthenticator, publicAuthenticator, serializeAuthenticators } from '@/lib/hrms/authenticators'
import { writeAudit } from '@/lib/hrms/audit'
import { isMfaRequired } from '@/lib/hrms/constants'

/** The signed-in user's registered authenticators (labels + dates only, never secrets). */
export async function GET() {
  return guard(async () => {
    const session = await requireSession()
    const user = await db.user.findUnique({ where: { id: session.userId }, select: { mfaEnabled: true, mfaSecret: true, backupCodes: true, role: true } })
    if (!user) return fail('Account not found.', 404)
    let remaining = 0
    try { remaining = user.backupCodes ? (JSON.parse(user.backupCodes) as string[]).length : 0 } catch { /* none */ }
    return ok({
      mfaEnabled: user.mfaEnabled,
      mfaRequired: isMfaRequired(user.role),
      authenticators: loadAuthenticators(user.mfaSecret).filter((a) => !a.pending).map(publicAuthenticator),
      backupCodesRemaining: remaining,
    })
  })
}

/**
 * Remove one authenticator. Needs the account password AND proof of possession (a current code from a registered
 * authenticator, or a backup code). The last authenticator cannot be removed — use "disable MFA" (optional roles) instead.
 */
export async function DELETE(req: NextRequest) {
  return guard(async () => {
    const session = await requireSession()
    const rl = guardRate(req, 'mfa-device-remove', RATE_LIMITS.AUTH.max, RATE_LIMITS.AUTH.windowMs)
    if (!rl.ok) return fail(`Too many attempts. Retry after ${rl.retryAfterSec}s.`, 429)

    const body = await req.json().catch(() => null)
    const id = String(body?.id ?? '')
    const password = String(body?.password ?? '').slice(0, 256)
    const code = String(body?.code ?? '').slice(0, 64)
    const user = await db.user.findUnique({ where: { id: session.userId } })
    if (!user || !user.mfaEnabled) return fail('MFA is not enabled.', 409)
    if (!verifyPassword(password, user.passwordHash)) return fail('Password incorrect.', 401)

    const items = loadAuthenticators(user.mfaSecret)
    const active = activeAuthenticators(items)
    const target = active.find((a) => a.id === id)
    if (!target) return fail('Authenticator not found.', 404)
    if (active.length <= 1) return fail('This is your only authenticator. Add another one first (or disable MFA if your role allows it).', 409)

    const backup = verifyBackupCode(code, user.backupCodes)
    if (!matchAuthenticator(user.id, items, code) && !backup.ok) return fail('Invalid authenticator or backup code.', 401)

    await db.user.update({
      where: { id: user.id },
      data: {
        mfaSecret: serializeAuthenticators(items.filter((a) => a.id !== id)),
        ...(backup.ok ? { backupCodes: JSON.stringify(backup.remaining) } : {}),
      },
    })
    await writeAudit({
      actorId: user.id, actorName: user.fullName, actorRole: user.role,
      entityType: 'MFA', entityId: user.id, fieldName: 'authenticator.removed', oldValue: target.label,
      reason: 'Authenticator removed by user', ipAddress: clientIp(req),
    })
    return ok({ ok: true })
  })
}

export const dynamic = 'force-dynamic'
