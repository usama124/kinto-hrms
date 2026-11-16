import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { signMfaStageToken, verifyPassword, hashPassword } from '@/lib/auth'
import { guard, fail, ok } from '@/lib/hrms/api-utils'
import { guardRate, clientIp, RATE_LIMITS } from '@/lib/hrms/rate-limit'
import { cleanEmail } from '@/lib/hrms/sanitize'
import { writeAudit } from '@/lib/hrms/audit'
import { isMfaRequired } from '@/lib/hrms/constants'
import { startSession } from '@/lib/hrms/session'

const MAX_FAILED_ATTEMPTS = 5
const LOCK_MINUTES = 15
// One message for every failure (unknown email, wrong password, locked) so responses can't be used to
// discover which accounts exist or which are locked.
const BAD_LOGIN = `Invalid credentials. After ${MAX_FAILED_ATTEMPTS} failed attempts an account is locked for ${LOCK_MINUTES} minutes.`

// Verified when the account is unknown/locked so every path costs one scrypt (no timing oracle).
let dummyHash: string | null = null
const burnPasswordCheck = (pw: string) => verifyPassword(pw, (dummyHash ??= hashPassword('dummy-password-for-timing')))

export async function POST(req: NextRequest) {
  return guard(async () => {
    const ip = clientIp(req)
    // Anti-DDoS: strict per-IP throttle on credentials endpoint (5 req/min)
    const rl = guardRate(req, 'login', RATE_LIMITS.AUTH.max, RATE_LIMITS.AUTH.windowMs)
    if (!rl.ok) {
      await writeAudit({ entityType: 'SECURITY', reason: `Login rate-limited (${rl.retryAfterSec}s)`, ipAddress: ip })
      return fail(`Too many login attempts from this network. Retry after ${rl.retryAfterSec}s.`, 429, { retryAfterSec: rl.retryAfterSec })
    }

    const body = await req.json().catch(() => null)
    const email = cleanEmail(body?.email)
    const password = String(body?.password ?? '').slice(0, 256)
    if (!email || !password) return fail('Email and password are required.', 422)

    const user = await db.user.findUnique({ where: { email }, include: { department: true } })
    const locked = !!user?.lockedUntil && user.lockedUntil.getTime() > Date.now()
    if (!user || !user.isActive || locked) {
      burnPasswordCheck(password)
      return fail(BAD_LOGIN, 401)
    }

    if (!verifyPassword(password, user.passwordHash)) {
      const attempts = user.failedAttempts + 1
      const lock = attempts >= MAX_FAILED_ATTEMPTS
      await db.user.update({
        where: { id: user.id },
        data: lock ? { failedAttempts: 0, lockedUntil: new Date(Date.now() + LOCK_MINUTES * 60_000) } : { failedAttempts: attempts },
      })
      if (lock) {
        await writeAudit({
          actorId: user.id, actorName: user.fullName, actorRole: user.role,
          entityType: 'SECURITY', entityId: user.id,
          fieldName: 'lockedUntil', newValue: new Date(Date.now() + LOCK_MINUTES * 60_000).toISOString(),
          reason: `${MAX_FAILED_ATTEMPTS} consecutive failed password attempts`, ipAddress: ip,
        })
      }
      return fail(BAD_LOGIN, 401)
    }

    await db.user.update({ where: { id: user.id }, data: { failedAttempts: 0, lockedUntil: null } })

    const userDto = {
      id: user.id, email: user.email, fullName: user.fullName, role: user.role,
      employeeCode: user.employeeCode, designation: user.designation,
      avatarColor: user.avatarColor, avatarUploadId: user.avatarUploadId, departmentName: user.department?.name ?? '—',
      mfaEnabled: user.mfaEnabled, mfaRequired: isMfaRequired(user.role), mustChangePassword: user.mustChangePassword,
    }

    // TOTP: if enrolled, the second factor is required before any session exists
    if (user.mfaEnabled) {
      const mfaToken = await signMfaStageToken(user.id)
      return ok({ mfaRequired: true, mfaToken, user: userDto })
    }

    // Not enrolled: the session is issued, but for elevated roles requireSession() refuses every
    // feature endpoint (403) until enrollment completes — enforced server-side, not just by the UI gate.
    const res = ok({ mfaRequired: false, user: userDto }) as NextResponse
    await startSession(res, user, ip)
    return res
  })
}

export const dynamic = 'force-dynamic'
