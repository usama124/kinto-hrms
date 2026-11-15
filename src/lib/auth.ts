import 'server-only'
import { SignJWT, jwtVerify } from 'jose'
import { cookies } from 'next/headers'
import { randomBytes, scryptSync, timingSafeEqual } from 'crypto'
import { ACCESS_COOKIE, ACCESS_TTL_SEC, accessCookieOptions } from '@/lib/hrms/tokens'

const SECRET = new TextEncoder().encode(process.env.AUTH_SECRET ?? 'novatech-hrms-dev-secret-9f2b7c')

export { ACCESS_COOKIE, ACCESS_TTL_SEC, accessCookieOptions }

export type SessionPayload = {
  userId: string
  email: string
  fullName: string
  role: string
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
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${ttlSec}s`)
    .sign(SECRET)
}

/** Short-lived (3 min) signed token bridging password step → MFA step. */
export async function signMfaStageToken(userId: string): Promise<string> {
  return new SignJWT({ userId, stage: 'mfa' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('180s')
    .sign(SECRET)
}

export async function verifyMfaStageToken(token: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, SECRET)
    if (payload.stage !== 'mfa' || !payload.userId) return null
    return payload.userId as string
  } catch {
    return null
  }
}

export async function verifySession(token: string): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, SECRET)
    if (!payload.userId || !payload.role) return null
    return {
      userId: payload.userId as string,
      email: payload.email as string,
      fullName: payload.fullName as string,
      role: payload.role as string,
    }
  } catch {
    return null
  }
}

/** Read the 15-minute access session from cookies (App Router server context). */
export async function getSession(): Promise<SessionPayload | null> {
  const jar = await cookies()
  const token = jar.get(ACCESS_COOKIE)?.value
  if (!token) return null
  return verifySession(token)
}
