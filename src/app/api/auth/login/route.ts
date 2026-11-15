import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { signSession, signMfaStageToken, verifyPassword } from '@/lib/auth'
import { guard, fail, ok } from '@/lib/hrms/api-utils'
import { guardRate, RATE_LIMITS } from '@/lib/hrms/rate-limit'
import { issueRefreshToken, ACCESS_COOKIE, REFRESH_COOKIE, accessCookieOptions, refreshCookieOptions, newAccessJwt } from '@/lib/hrms/tokens'
import { cleanEmail } from '@/lib/hrms/sanitize'
import { writeAudit } from '@/lib/hrms/audit'
import { isMfaRequired } from '@/lib/hrms/constants'

const MAX_FAILED_ATTEMPTS = 5
const LOCK_MINUTES = 15

export async function POST(req: NextRequest) {
  return guard(async () => {
    // Anti-DDoS: strict per-IP throttle on credentials endpoint (5 req/min)
    const rl = guardRate(req, 'login', RATE_LIMITS.AUTH.max, RATE_LIMITS.AUTH.windowMs)
    if (!rl.ok) {
      await writeAudit({ entityType: 'SECURITY', action: undefined as never, meta: `Login rate-limited (${rl.retryAfterSec}s)` } as never)
      return fail(`Too many login attempts from this network. Retry after ${rl.retryAfterSec}s.`, 429, { retryAfterSec: rl.retryAfterSec })
    }

    const body = await req.json().catch(() => null)
    const email = cleanEmail(body?.email)
    const password = String(body?.password ?? '')
    if (!email || !password) return fail('Email and password are required.', 422)

    const user = await db.user.findUnique({ where: { email }, include: { department: true } })
    if (!user || !user.isActive) return fail('Invalid credentials.', 401)

    // Account lockout after 5 consecutive failures (15 minutes)
    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      const mins = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60000)
      return fail(`Account locked after repeated failures. Try again in ${mins} minute(s).`, 423, { lockedUntil: user.lockedUntil })
    }

    const valid = verifyPassword(password, user.passwordHash)
    if (!valid) {
      const attempts = user.failedAttempts + 1
      const locked = attempts >= MAX_FAILED_ATTEMPTS
      await db.user.update({
        where: { id: user.id },
        data: locked ? { failedAttempts: 0, lockedUntil: new Date(Date.now() + LOCK_MINUTES * 60_000) } : { failedAttempts: attempts },
      })
      if (locked) {
        await writeAudit({
          actorId: user.id, actorName: user.fullName, actorRole: user.role,
          entityType: 'SECURITY', entityId: user.id,
          fieldName: 'lockedUntil', newValue: new Date(Date.now() + LOCK_MINUTES * 60_000).toISOString(),
          reason: `${MAX_FAILED_ATTEMPTS} consecutive failed password attempts`, ipAddress: req.headers.get('x-forwarded-for') ?? null,
        })
      }
      const remaining = Math.max(0, MAX_FAILED_ATTEMPTS - attempts)
      return fail(`Invalid credentials.${locked ? ' Account locked for 15 minutes.' : remaining <= 2 ? ` ${remaining} attempt(s) before lockout.` : ''}`, 401, { remainingAttempts: remaining })
    }

    await db.user.update({ where: { id: user.id }, data: { failedAttempts: 0, lockedUntil: null } })

    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? '127.0.0.1'
    const sessionPayload = { userId: user.id, email: user.email, fullName: user.fullName, role: user.role }
    const userDto = {
      id: user.id, email: user.email, fullName: user.fullName, role: user.role,
      employeeCode: user.employeeCode, designation: user.designation,
      avatarColor: user.avatarColor, departmentName: user.department?.name ?? '—',
      mfaEnabled: user.mfaEnabled, mfaRequired: isMfaRequired(user.role),
    }

    // TOTP MFA mandatory for elevated roles — if enrolled, require the second factor
    if (user.mfaEnabled) {
      const mfaToken = await signMfaStageToken(user.id)
      return ok({ mfaRequired: true, mfaToken, user: userDto })
    }

    // Issue 15-min access JWT + rotating refresh family
    const token = await signSession(sessionPayload)
    const { refreshToken } = await issueRefreshToken(user.id, ip)
    const res = ok({ mfaRequired: false, user: userDto }) as NextResponse
    res.cookies.set(ACCESS_COOKIE, token, accessCookieOptions)
    res.cookies.set(REFRESH_COOKIE, refreshToken, refreshCookieOptions)
    return res
  })
}

export const dynamic = 'force-dynamic'
