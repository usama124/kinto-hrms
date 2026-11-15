import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { guard, fail, ok } from '@/lib/hrms/api-utils'
import { generateTotpSecret, otpauthUri, generateBackupCodes } from '@/lib/hrms/totp'
import QRCode from 'qrcode'
import { guardRate, RATE_LIMITS } from '@/lib/hrms/rate-limit'
import { writeAudit } from '@/lib/hrms/audit'

/** Begin TOTP enrollment: provision secret + QR + one-time backup codes. */
export async function POST(req: NextRequest) {
  return guard(async () => {
    const session = await getSession()
    if (!session) return fail('Not authenticated.', 401)
    const rl = guardRate(req, 'mfa-enroll', RATE_LIMITS.MFA_ENROLL.max, RATE_LIMITS.MFA_ENROLL.windowMs)
    if (!rl.ok) return fail(`Too many enrollment attempts. Retry after ${rl.retryAfterSec}s.`, 429)

    const user = await db.user.findUnique({ where: { id: session.userId } })
    if (!user) return fail('Account not found.', 404)
    if (user.mfaEnabled) return fail('MFA is already enabled on this account.', 409)

    const secret = generateTotpSecret()
    const { plain, hashes } = generateBackupCodes(8)
    await db.user.update({
      where: { id: user.id },
      data: { mfaSecret: secret, backupCodes: JSON.stringify(hashes) },
    })

    const uri = otpauthUri(user.email, secret)
    const qrDataUrl = await QRCode.toDataURL(uri, { width: 220, margin: 1 })
    await writeAudit({
      actorId: user.id, actorName: user.fullName, actorRole: user.role,
      entityType: 'MFA', entityId: user.id, reason: 'TOTP enrollment started', ipAddress: req.headers.get('x-forwarded-for') ?? null,
    })

    return ok({ secret, otpauthUri: uri, qrDataUrl, backupCodes: plain })
  })
}

export const dynamic = 'force-dynamic'
