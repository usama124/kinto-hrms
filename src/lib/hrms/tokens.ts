import 'server-only'
import { createHash, randomBytes, randomUUID } from 'crypto'
import { db } from '@/lib/db'
import { signSession, type SessionPayload } from '@/lib/auth'

/**
 * Dual-token session model:
 *  - Access JWT: 15 minutes, HttpOnly cookie `hrms_at`
 *  - Refresh token: 7 days, HttpOnly cookie `hrms_rt`, rotated on every use,
 *    grouped in a token family. If a refresh token that was ALREADY rotated
 *    (usedAt != null) or revoked is replayed → the whole family is revoked
 *    (stolen-token reuse detection) and all sessions die.
 */

export const ACCESS_COOKIE = 'hrms_at'
export const REFRESH_COOKIE = 'hrms_rt'
export const ACCESS_TTL_SEC = 60 * 15 // 15 minutes
export const REFRESH_TTL_SEC = 60 * 60 * 24 * 7 // 7 days

export const accessCookieOptions = {
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: false, // sandbox terminates TLS at the gateway
  path: '/',
  maxAge: ACCESS_TTL_SEC,
}

export const refreshCookieOptions = {
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: false,
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
  | { ok: true; userId: string; refreshToken: string }
  | { ok: false; reason: 'MISSING' | 'EXPIRED' | 'REUSED' | 'REVOKED' }

/** Rotate the presented refresh token. Reuse of a used/revoked token kills the family. */
export async function rotateRefreshToken(presentedRaw: string | null, ip: string | null): Promise<RotationResult> {
  if (!presentedRaw) return { ok: false, reason: 'MISSING' }
  const hash = sha256Hex(presentedRaw)
  const stored = await db.refreshToken.findUnique({ where: { tokenHash: hash } })
  if (!stored) return { ok: false, reason: 'MISSING' }

  if (stored.revokedAt) {
    // Replay of a revoked token → family compromise
    await db.refreshToken.updateMany({ where: { familyId: stored.familyId }, data: { revokedAt: new Date() } })
    return { ok: false, reason: 'REUSED' }
  }
  if (stored.usedAt) {
    // Replay of an already-rotated token → stolen token reuse detection
    await db.refreshToken.updateMany({ where: { familyId: stored.familyId }, data: { revokedAt: new Date() } })
    return { ok: false, reason: 'REUSED' }
  }
  if (stored.expiresAt.getTime() < Date.now()) return { ok: false, reason: 'EXPIRED' }

  const nextRaw = randomBytes(48).toString('base64url')
  await db.$transaction([
    db.refreshToken.update({ where: { id: stored.id }, data: { usedAt: new Date() } }),
    db.refreshToken.create({
      data: {
        userId: stored.userId,
        familyId: stored.familyId,
        tokenHash: sha256Hex(nextRaw),
        expiresAt: new Date(Date.now() + REFRESH_TTL_SEC * 1000),
        ip,
      },
    }),
  ])
  return { ok: true, userId: stored.userId, refreshToken: nextRaw }
}

/** Revoke every token in the family that the presented raw token belongs to. */
export async function revokeFamilyOf(presentedRaw: string | null): Promise<void> {
  if (!presentedRaw) return
  const hash = sha256Hex(presentedRaw)
  const stored = await db.refreshToken.findUnique({ where: { tokenHash: hash } })
  if (!stored) return
  await db.refreshToken.updateMany({ where: { familyId: stored.familyId }, data: { revokedAt: new Date() } })
}

/** Nuke every session of a user (used on password compromise / MFA change). */
export async function revokeAllForUser(userId: string): Promise<void> {
  await db.refreshToken.updateMany({ where: { userId }, data: { revokedAt: new Date() } })
}

export async function newAccessJwt(payload: SessionPayload): Promise<string> {
  return signSession(payload, ACCESS_TTL_SEC)
}
