import 'server-only'
import { SignJWT, jwtVerify } from 'jose'
import { cookies } from 'next/headers'
import { randomBytes, scryptSync, timingSafeEqual } from 'crypto'
import { db } from '@/lib/db'
import { ACCESS_COOKIE, ACCESS_TTL_SEC, accessCookieOptions } from '@/lib/hrms/tokens'
import { isMfaRequired } from '@/lib/hrms/constants'
import { authSecretString } from '@/lib/hrms/secrets'

const secret = () => new TextEncoder().encode(authSecretString())

export { ACCESS_COOKIE, ACCESS_TTL_SEC, accessCookieOptions }

export type SessionPayload = {
  userId: string
  email: string
  fullName: string
  role: string
  /** refresh-token family this access token belongs to — revoking the family kills the access token too */
  fid?: string
  /** derived from the DB on every request: elevated role that has not enrolled TOTP yet */
  mfaPending?: boolean
}

// ─── Password hashing (scrypt, no external dep) ───────────────────────────────

export function hashPassword(plain: string): string {
  const salt = randomBytes(16).toString('hex')
  const hash = scryptSync(plain, salt, 64).toString('hex')
  return `${salt}:${hash}`
}

export function verifyPassword(plain: string, stored: string): boolean {
  const [salt, hash] = stored.split(':')
  if (!salt || !hash) return false
  const candidate = scryptSync(plain, salt, 64)
  const expected = Buffer.from(hash, 'hex')
  return candidate.length === expected.length && timingSafeEqual(candidate, expected)
}

// ─── JWT session (15-minute access token) ─────────────────────────────────────

export async function signSession(payload: SessionPayload, ttlSec: number = ACCESS_TTL_SEC): Promise<string> {
  const { mfaPending: _ignored, ...claims } = payload // never trust a client-held flag; it is recomputed from the DB
  void _ignored
  return new SignJWT({ ...claims })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${ttlSec}s`)
    .sign(secret())
}

/** Short-lived (3 min) signed token bridging password step → MFA step. */
export async function signMfaStageToken(userId: string): Promise<string> {
  return new SignJWT({ userId, stage: 'mfa' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('180s')
    .sign(secret())
}

export async function verifyMfaStageToken(token: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, secret(), { algorithms: ['HS256'] })
    if (payload.stage !== 'mfa' || !payload.userId) return null
    return payload.userId as string
  } catch {
    return null
  }
}

export async function verifySession(token: string): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, secret(), { algorithms: ['HS256'] })
    if (!payload.userId || !payload.role || payload.stage) return null // stage tokens are not sessions
    return {
      userId: payload.userId as string,
      email: payload.email as string,
      fullName: payload.fullName as string,
      role: payload.role as string,
      fid: typeof payload.fid === 'string' ? payload.fid : undefined,
    }
  } catch {
    return null
  }
}

/**
 * Read the access session from cookies and re-validate it against the database, so that
 * deactivation, role changes, logout and "revoke all sessions" take effect immediately
 * instead of when the 15-minute JWT expires.
 */
export async function getSession(): Promise<SessionPayload | null> {
  const jar = await cookies()
  const token = jar.get(ACCESS_COOKIE)?.value
  if (!token) return null
  const claims = await verifySession(token)
  if (!claims) return null

  const u = await db.user.findUnique({
    where: { id: claims.userId },
    select: { isActive: true, role: true, email: true, fullName: true, mfaEnabled: true },
  })
  if (!u || !u.isActive) return null
  if (claims.fid) {
    const live = await db.refreshToken.findFirst({ where: { familyId: claims.fid, revokedAt: null }, select: { id: true } })
    if (!live) return null
  }
  return {
    userId: claims.userId, email: u.email, fullName: u.fullName, role: u.role, fid: claims.fid,
    mfaPending: isMfaRequired(u.role) && !u.mfaEnabled,
  }
}
