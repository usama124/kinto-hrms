import 'server-only'
import { createHash, randomBytes, randomUUID } from 'crypto'
import { db } from '@/lib/db'
import { signSession, type SessionPayload } from '@/lib/auth'

/**
 * Dual-token session model:
 *  - Access JWT: 15 minutes, HttpOnly cookie `hrms_at`, bound to a refresh-token family (`fid`)
 *  - Refresh token: 7 days, HttpOnly cookie `hrms_rt`, rotated on every use,
 *    grouped in a token family. If a refresh token that was ALREADY rotated
 *    (usedAt != null) or revoked is replayed → the whole family is revoked
 *    (stolen-token reuse detection) and all sessions die.
 */

export const ACCESS_COOKIE = 'hrms_at'
export const REFRESH_COOKIE = 'hrms_rt'
export const ACCESS_TTL_SEC = 60 * 15 // 15 minutes
export const REFRESH_TTL_SEC = 60 * 60 * 24 * 7 // 7 days
/** Two tabs refreshing at the same instant both present the same token; the loser must not look like theft. */
const ROTATION_GRACE_MS = 10_000

/**
 * Cookies are `Secure` in production. Behind a plain-HTTP gateway set COOKIE_SECURE=false explicitly
 * (the browser would otherwise drop the cookies); set COOKIE_SECURE=true to force it elsewhere.
 */
const SECURE = process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === 'true' : process.env.NODE_ENV === 'production'

export const accessCookieOptions = {
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: SECURE,
  path: '/',
  maxAge: ACCESS_TTL_SEC,
}

export const refreshCookieOptions = {
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: SECURE,
  path: '/',
  maxAge: REFRESH_TTL_SEC,
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

export type IssuedTokens = { refreshToken: string; familyId: string }

/** Create a fresh refresh-token family + raw token, persisted hashed. */
export async function issueRefreshToken(userId: string, ip: string | null): Promise<IssuedTokens> {
  const familyId = randomUUID()
  const raw = randomBytes(48).toString('base64url')
  await db.refreshToken.create({
    data: {
      userId,
      familyId,
      tokenHash: sha256Hex(raw),
      expiresAt: new Date(Date.now() + REFRESH_TTL_SEC * 1000),
      ip,
    },
  })
  return { refreshToken: raw, familyId }
}

export type RotationResult =
  | { ok: true; userId: string; familyId: string; refreshToken: string }
  | { ok: false; reason: 'MISSING' | 'EXPIRED' | 'REUSED' | 'REVOKED' | 'RACE' }

async function killFamily(familyId: string) {
  await db.refreshToken.updateMany({ where: { familyId }, data: { revokedAt: new Date() } })
}

/** Rotate the presented refresh token. Reuse of a used/revoked token kills the family. */
export async function rotateRefreshToken(presentedRaw: string | null, ip: string | null): Promise<RotationResult> {
  if (!presentedRaw) return { ok: false, reason: 'MISSING' }
  const hash = sha256Hex(presentedRaw)
  const stored = await db.refreshToken.findUnique({ where: { tokenHash: hash } })
  if (!stored) return { ok: false, reason: 'MISSING' }

  if (stored.revokedAt) {
    // Replay of a revoked token → family compromise
    await killFamily(stored.familyId)
    return { ok: false, reason: 'REUSED' }
  }
  if (stored.usedAt) {
    if (Date.now() - stored.usedAt.getTime() < ROTATION_GRACE_MS) return { ok: false, reason: 'RACE' }
    // Replay of an already-rotated token → stolen token reuse detection
    await killFamily(stored.familyId)
    return { ok: false, reason: 'REUSED' }
  }
  if (stored.expiresAt.getTime() < Date.now()) return { ok: false, reason: 'EXPIRED' }

  const nextRaw = randomBytes(48).toString('base64url')
  // Atomic claim: only ONE concurrent request can flip usedAt from null; the rest see count 0.
  const rotated = await db.$transaction(async (tx) => {
    const claim = await tx.refreshToken.updateMany({ where: { id: stored.id, usedAt: null, revokedAt: null }, data: { usedAt: new Date() } })
    if (claim.count === 0) return false
    await tx.refreshToken.create({
      data: {
        userId: stored.userId,
        familyId: stored.familyId,
        tokenHash: sha256Hex(nextRaw),
        expiresAt: new Date(Date.now() + REFRESH_TTL_SEC * 1000),
        ip,
      },
    })
    return true
  })
  if (!rotated) return { ok: false, reason: 'RACE' }
  return { ok: true, userId: stored.userId, familyId: stored.familyId, refreshToken: nextRaw }
}

/** Revoke every token in the family that the presented raw token belongs to. */
export async function revokeFamilyOf(presentedRaw: string | null): Promise<void> {
  if (!presentedRaw) return
  const hash = sha256Hex(presentedRaw)
  const stored = await db.refreshToken.findUnique({ where: { tokenHash: hash } })
  if (!stored) return
  await killFamily(stored.familyId)
}

/** Nuke every session of a user (used on password change / MFA change / deactivation). */
export async function revokeAllForUser(userId: string): Promise<void> {
  await db.refreshToken.updateMany({ where: { userId }, data: { revokedAt: new Date() } })
}

export async function newAccessJwt(payload: SessionPayload): Promise<string> {
  return signSession(payload, ACCESS_TTL_SEC)
}
