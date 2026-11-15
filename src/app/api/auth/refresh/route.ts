import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { signSession } from '@/lib/auth'
import { guard, fail, ok } from '@/lib/hrms/api-utils'
import { rotateRefreshToken, REFRESH_COOKIE, ACCESS_COOKIE, refreshCookieOptions, accessCookieOptions } from '@/lib/hrms/tokens'
import { guardRate, RATE_LIMITS } from '@/lib/hrms/rate-limit'
import { writeAudit } from '@/lib/hrms/audit'

/** Rotate the refresh token (reuse → family revoked) and mint a fresh 15-min access JWT. */
export async function POST(req: NextRequest) {
  return guard(async () => {
    const rl = guardRate(req, 'refresh', RATE_LIMITS.REFRESH.max, RATE_LIMITS.REFRESH.windowMs)
    if (!rl.ok) return fail(`Rate limited. Retry after ${rl.retryAfterSec}s.`, 429)

    const body = await req.json().catch(() => ({}))
    const jar = await req.cookies
    const presented = body?.refreshToken ? String(body.refreshToken) : (jar.get(REFRESH_COOKIE)?.value ?? null)

    const result = await rotateRefreshToken(presented, req.headers.get('x-forwarded-for') ?? null)
    if (!result.ok) {
      const res = fail(
        result.reason === 'REUSED'
          ? 'Session security violation detected (token reuse) — all sessions revoked. Please sign in again.'
          : 'Session expired. Please sign in again.',
        401,
      ) as NextResponse
      res.cookies.set(ACCESS_COOKIE, '', { path: '/', maxAge: 0 })
      res.cookies.set(REFRESH_COOKIE, '', { path: '/', maxAge: 0 })
      if (result.reason === 'REUSED') {
        await writeAudit({
          entityType: 'SECURITY', reason: 'Refresh-token replay detected — token family revoked',
          ipAddress: req.headers.get('x-forwarded-for') ?? null,
        })
      }
      return res
    }

    const user = await db.user.findUnique({ where: { id: result.userId }, include: { department: true } })
    if (!user || !user.isActive) {
      const res = fail('Account inactive.', 401) as NextResponse
      res.cookies.set(ACCESS_COOKIE, '', { path: '/', maxAge: 0 })
      res.cookies.set(REFRESH_COOKIE, '', { path: '/', maxAge: 0 })
      return res
    }

    const access = await signSession({ userId: user.id, email: user.email, fullName: user.fullName, role: user.role })
    const res = ok({
      user: {
        id: user.id, email: user.email, fullName: user.fullName, role: user.role,
        employeeCode: user.employeeCode, designation: user.designation,
        avatarColor: user.avatarColor, departmentName: user.department?.name ?? '—',
        mfaEnabled: user.mfaEnabled,
      },
    }) as NextResponse
    res.cookies.set(ACCESS_COOKIE, access, accessCookieOptions)
    res.cookies.set(REFRESH_COOKIE, result.refreshToken, refreshCookieOptions)
    return res
  })
}

export const dynamic = 'force-dynamic'
