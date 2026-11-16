import 'server-only'
import type { NextResponse } from 'next/server'
import { signSession } from '@/lib/auth'
import { issueRefreshToken, ACCESS_COOKIE, REFRESH_COOKIE, accessCookieOptions, refreshCookieOptions } from '@/lib/hrms/tokens'

/** Open a new session: fresh refresh family + access JWT bound to it (so logout/revoke kills both), set as cookies. */
export async function startSession(
  res: NextResponse,
  user: { id: string; email: string; fullName: string; role: string },
  ip: string,
): Promise<void> {
  const { refreshToken, familyId } = await issueRefreshToken(user.id, ip)
  const access = await signSession({ userId: user.id, email: user.email, fullName: user.fullName, role: user.role, fid: familyId })
  res.cookies.set(ACCESS_COOKIE, access, accessCookieOptions)
  res.cookies.set(REFRESH_COOKIE, refreshToken, refreshCookieOptions)
}
