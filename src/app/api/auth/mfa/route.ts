import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyMfaStageToken } from '@/lib/auth'
import { guard, fail, ok } from '@/lib/hrms/api-utils'
import { guardRate, clientIp, RATE_LIMITS } from '@/lib/hrms/rate-limit'
import { verifyBackupCode } from '@/lib/hrms/totp'
import { loadAuthenticators, matchAuthenticator, serializeAuthenticators } from '@/lib/hrms/authenticators'
import { writeAudit } from '@/lib/hrms/audit'
import { startSession } from '@/lib/hrms/session'

/** Second factor at login — TOTP code or one-time backup code. */
export async function POST(req: NextRequest) {
  return guard(async () => {
    const ip = clientIp(req)
    const rl = guardRate(req, 'mfa', RATE_LIMITS.AUTH.max, RATE_LIMITS.AUTH.windowMs)
    if (!rl.ok) return fail(`Too many MFA attempts. Retry after ${rl.retryAfterSec}s.`, 429)

    const body = await req.json().catch(() => null)
    const mfaToken = String(body?.mfaToken ?? '')
    const code = String(body?.code ?? '').slice(0, 64)
    const isBackup = Boolean(body?.isBackupCode)
    if (!mfaToken || !code) return fail('MFA token and code are required.', 422)

    const userId = await verifyMfaStageToken(mfaToken)
    if (!userId) return fail('MFA session expired — please sign in again.', 401)

    const user = await db.user.findUnique({ where: { id: userId }, include: { department: true } })
    if (!user || !user.isActive || !user.mfaEnabled) return fail('Invalid MFA session.', 401)
    // the lockout also gates this step, otherwise a held stage token could keep guessing codes
    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) return fail('Account temporarily locked. Try again later.', 423)

    let valid = false
    if (isBackup) {
      const result = verifyBackupCode(code, user.backupCodes)
      valid = result.ok
      if (valid) {
        await db.user.update({ where: { id: user.id }, data: { backupCodes: JSON.stringify(result.remaining) } })
      }
    } else {
      // any registered authenticator may satisfy the challenge
      const items = loadAuthenticators(user.mfaSecret)
      const hit = matchAuthenticator(user.id, items, code)
      valid = Boolean(hit)
      if (hit) {
        await db.user.update({ where: { id: user.id }, data: { mfaSecret: serializeAuthenticators(items.map((a) => (a.id === hit.id ? { ...a, lastUsedAt: new Date().toISOString() } : a))) } })
      }
    }

    if (!valid) {
      const attempts = user.failedAttempts + 1
      const locked = attempts >= 5
      await db.user.update({
        where: { id: user.id },
        data: locked ? { failedAttempts: 0, lockedUntil: new Date(Date.now() + 15 * 60_000) } : { failedAttempts: attempts },
      })
      await writeAudit({
        actorId: user.id, actorName: user.fullName, actorRole: user.role,
        entityType: 'SECURITY', entityId: user.id, reason: locked ? 'Account locked — 5 failed MFA attempts' : 'Failed MFA attempt',
        ipAddress: ip,
      })
      return fail(locked ? 'Too many failed MFA attempts — account locked for 15 minutes.' : 'Invalid authenticator code.', 401)
    }

    await db.user.update({ where: { id: user.id }, data: { failedAttempts: 0, lockedUntil: null } })
    await writeAudit({
      actorId: user.id, actorName: user.fullName, actorRole: user.role,
      entityType: 'SECURITY', entityId: user.id, reason: isBackup ? 'MFA via backup recovery code' : 'MFA via authenticator', ipAddress: ip,
    })

    const res = ok({
      user: {
        id: user.id, email: user.email, fullName: user.fullName, role: user.role,
        employeeCode: user.employeeCode, designation: user.designation,
        avatarColor: user.avatarColor, avatarUploadId: user.avatarUploadId, departmentName: user.department?.name ?? '—',
        mfaEnabled: true, mfaRequired: true, mustChangePassword: user.mustChangePassword,
      },
    }) as NextResponse
    await startSession(res, user, ip)
    return res
  })
}

export const dynamic = 'force-dynamic'
