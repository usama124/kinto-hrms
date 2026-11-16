import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { getSession, verifyPassword } from '@/lib/auth'
import { guard, fail, ok } from '@/lib/hrms/api-utils'
import { generateTotpSecret, otpauthUri, generateBackupCodes } from '@/lib/hrms/totp'
import { MAX_AUTHENTICATORS, loadAuthenticators, serializeAuthenticators, type Authenticator } from '@/lib/hrms/authenticators'
import { cleanText } from '@/lib/hrms/sanitize'
import { randomUUID } from 'crypto'
import QRCode from 'qrcode'
import { guardRate, clientIp, RATE_LIMITS } from '@/lib/hrms/rate-limit'
import { writeAudit } from '@/lib/hrms/audit'

/**
 * Begin TOTP enrollment (allowed while enrollment is still pending, so the first-login gate works).
 *  - first authenticator: provisions secret + QR + one-time backup codes
 *  - additional authenticator (MFA already on): requires the account password; no new backup codes
 * Body: { label?: string, password?: string }. The new authenticator stays "pending" until /enroll-verify confirms a code.
 */
export async function POST(req: NextRequest) {
  return guard(async () => {
    const session = await getSession()
    if (!session) return fail('Not authenticated.', 401)
    const rl = guardRate(req, 'mfa-enroll', RATE_LIMITS.MFA_ENROLL.max, RATE_LIMITS.MFA_ENROLL.windowMs)
    if (!rl.ok) return fail(`Too many enrollment attempts. Retry after ${rl.retryAfterSec}s.`, 429)

    const body = await req.json().catch(() => ({}))
    const label = cleanText(body?.label, 40) || 'Authenticator app'
    const user = await db.user.findUnique({ where: { id: session.userId } })
    if (!user) return fail('Account not found.', 404)

    const existing = loadAuthenticators(user.mfaSecret)
    let kept: Authenticator[] = []
    let backupCodes: string[] = []
    let backupHashes: string[] | null = null
    if (user.mfaEnabled) {
      if (session.passwordChangePending) return fail('Change your temporary password first.', 403)
      if (!verifyPassword(String(body?.password ?? '').slice(0, 256), user.passwordHash)) return fail('Password incorrect.', 401)
      kept = existing.filter((a) => !a.pending) // a half-finished earlier attempt is replaced
      if (kept.length >= MAX_AUTHENTICATORS) return fail(`You can register at most ${MAX_AUTHENTICATORS} authenticators. Remove one first.`, 409)
    } else {
      const g = generateBackupCodes(8)
      backupCodes = g.plain
      backupHashes = g.hashes
    }

    const secret = generateTotpSecret()
    const item: Authenticator = { id: randomUUID(), label, secret, createdAt: new Date().toISOString(), lastUsedAt: null, pending: true }
    await db.user.update({
      where: { id: user.id },
      data: { mfaSecret: serializeAuthenticators([...kept, item]), ...(backupHashes ? { backupCodes: JSON.stringify(backupHashes) } : {}) },
    })

    const uri = otpauthUri(user.email, secret)
    const qrDataUrl = await QRCode.toDataURL(uri, { width: 220, margin: 1 })
    await writeAudit({
      actorId: user.id, actorName: user.fullName, actorRole: user.role,
      entityType: 'MFA', entityId: user.id, fieldName: 'authenticator.enroll', newValue: label,
      reason: user.mfaEnabled ? 'Additional authenticator enrollment started' : 'TOTP enrollment started', ipAddress: clientIp(req),
    })
    return ok({ id: item.id, label, secret, otpauthUri: uri, qrDataUrl, backupCodes }, { headers: { 'Cache-Control': 'no-store' } })
  })
}

export const dynamic = 'force-dynamic'
