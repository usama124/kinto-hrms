import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { signSession, verifyMfaStageToken } from '@/lib/auth'
import { guard, fail, ok } from '@/lib/hrms/api-utils'
import { guardRate, RATE_LIMITS } from '@/lib/hrms/rate-limit'
import { issueRefreshToken, ACCESS_COOKIE, REFRESH_COOKIE, accessCookieOptions, refreshCookieOptions } from '@/lib/hrms/tokens'
import { verifyTotp, verifyBackupCode } from '@/lib/hrms/totp'
import { writeAudit } from '@/lib/hrms/audit'

/** Second factor at login — TOTP code or one-time backup code. */
export async function POST(req: NextRequest) {
  return guard(async () => {
    const rl = guardRate(req, 'mfa', RATE_LIMITS.AUTH.max, RATE_LIMITS.AUTH.windowMs)
    if (!rl.ok) return fail(`Too many MFA attempts. Retry after ${rl.retryAfterSec}s.`, 429)

    const body = await req.json().catch(() => null)
    const mfaToken = String(body?.mfaToken ?? '')
    const code = String(body?.code ?? '')
    const isBackup = Boolean(body?.isBackupCode)
    if (!mfaToken || !code) return fail('MFA token and code are required.', 422)

    const userId = await verifyMfaStageToken(mfaToken)
    if (!userId) return fail('MFA session expired — please sign in again.', 401)

    const user = await db.user.findUnique({ where: { id: userId }, include: { department: true } })
    if (!user || !user.isActive || !user.mfaEnabled) return fail('Invalid MFA session.', 401)

    let valid = false
    if (isBackup) {
      const result = verifyBackupCode(code, user.backupCodes)
      valid = result.ok
      if (valid) {
        await db.user.update({ where: { id: user.id }, data: { backupCodes: JSON.stringify(result.remaining) } })
      }
    } else {
      valid = user.mfaSecret ? verifyTotp(user.mfaSecret, code) : false
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
        ipAddress: req.headers.get('x-forwarded-for') ?? null,
      })
      return fail(locked ? 'Too many failed MFA attempts — account locked for 15 minutes.' : 'Invalid authenticator code.', 401)
    }

    await db.user.update({ where: { id: user.id }, data: { failedAttempts: 0, lockedUntil: null } })
    await writeAudit({
      actorId: user.id, actorName: user.fullName, actorRole: user.role,
      entityType: 'SECURITY', entityId: user.id, reason: isBackup ? 'MFA via backup recovery code' : 'MFA via authenticator', ipAddress: req.headers.get('x-forwarded-for') ?? null,
    })

    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? '127.0.0.1'
    const token = await signSession({ userId: user.id, email: user.email, fullName: user.fullName, role: user.role })
    const { refreshToken } = await issueRefreshToken(user.id, ip)
    const res = ok({
      user: {
        id: user.id, email: user.email, fullName: user.fullName, role: user.role,
        employeeCode: user.employeeCode, designation: user.designation,
        avatarColor: user.avatarColor, departmentName: user.department?.name ?? '—',
        mfaEnabled: true,
      },
    }) as NextResponse
    res.cookies.set(ACCESS_COOKIE, token, accessCookieOptions)
    res.cookies.set(REFRESH_COOKIE, refreshToken, refreshCookieOptions)
    return res
  })
}

export const dynamic = 'force-dynamic'
