import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { getSession, verifyPassword } from '@/lib/auth'
import { guard, fail, ok } from '@/lib/hrms/api-utils'
import { verifyTotp } from '@/lib/hrms/totp'
import { revokeAllForUser } from '@/lib/hrms/tokens'
import { writeAudit } from '@/lib/hrms/audit'
import { isMfaRequired } from '@/lib/hrms/constants'

/** Disable MFA — requires password + current code. Blocked for mandatory-role users. */
export async function POST(req: NextRequest) {
  return guard(async () => {
    const session = await getSession()
    if (!session) return fail('Not authenticated.', 401)

    const body = await req.json().catch(() => null)
    const password = String(body?.password ?? '')
    const code = String(body?.code ?? '')

    const user = await db.user.findUnique({ where: { id: session.userId } })
    if (!user || !user.mfaEnabled) return fail('MFA is not enabled.', 409)
    if (isMfaRequired(user.role)) return fail('MFA is mandatory for your role and cannot be disabled.', 403)
    if (!verifyPassword(password, user.passwordHash)) return fail('Password incorrect.', 401)
    if (!user.mfaSecret || !verifyTotp(user.mfaSecret, code)) return fail('Invalid authenticator code.', 401)

    await db.user.update({ where: { id: user.id }, data: { mfaEnabled: false, mfaSecret: null, backupCodes: null } })
    await revokeAllForUser(user.id)
    await writeAudit({
      actorId: user.id, actorName: user.fullName, actorRole: user.role,
      entityType: 'MFA', entityId: user.id, fieldName: 'mfaEnabled', oldValue: 'true', newValue: 'false',
      reason: 'MFA disabled by user', ipAddress: req.headers.get('x-forwarded-for') ?? null,
    })
    return ok({ mfaEnabled: false, sessionsRevoked: true })
  })
}

export const dynamic = 'force-dynamic'
