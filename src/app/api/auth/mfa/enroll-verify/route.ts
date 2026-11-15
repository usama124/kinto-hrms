import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { guard, fail, ok } from '@/lib/hrms/api-utils'
import { verifyTotp } from '@/lib/hrms/totp'
import { writeAudit } from '@/lib/hrms/audit'

/** Confirm enrollment with a live TOTP code → MFA becomes mandatory at login. */
export async function POST(req: NextRequest) {
  return guard(async () => {
    const session = await getSession()
    if (!session) return fail('Not authenticated.', 401)

    const body = await req.json().catch(() => null)
    const code = String(body?.code ?? '')
    const user = await db.user.findUnique({ where: { id: session.userId } })
    if (!user || !user.mfaSecret) return fail('Start enrollment first.', 422)
    if (user.mfaEnabled) return fail('MFA is already enabled.', 409)

    if (!verifyTotp(user.mfaSecret, code)) return fail('Invalid code — check your authenticator app.', 422)

    await db.user.update({ where: { id: user.id }, data: { mfaEnabled: true } })
    await writeAudit({
      actorId: user.id, actorName: user.fullName, actorRole: user.role,
      entityType: 'MFA', entityId: user.id, fieldName: 'mfaEnabled', oldValue: 'false', newValue: 'true',
      reason: 'TOTP enrollment confirmed', ipAddress: req.headers.get('x-forwarded-for') ?? null,
    })
    return ok({ mfaEnabled: true })
  })
}

export const dynamic = 'force-dynamic'
