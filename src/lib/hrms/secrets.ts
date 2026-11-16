import 'server-only'
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'crypto'

/**
 * Signing / encryption key material.
 *  - AUTH_SECRET (>= 32 chars) is REQUIRED in production — there is no built-in fallback any more.
 *  - In development without it, a random per-process secret is used (cached on globalThis because
 *    Next compiles each route separately); sessions simply reset on restart.
 *  - MFA_ENC_KEY optionally separates the MFA-at-rest key from AUTH_SECRET.
 */
const g = globalThis as unknown as { __devAuthSecret?: string }

export function authSecretString(): string {
  const env = process.env.AUTH_SECRET
  if (env && env.length >= 32) return env
  if (process.env.NODE_ENV === 'production') {
    throw new Error('AUTH_SECRET must be set to a random string of at least 32 characters in production.')
  }
  if (!g.__devAuthSecret) {
    g.__devAuthSecret = randomBytes(32).toString('hex')
    console.warn('[auth] AUTH_SECRET missing/short — using a random development secret (sessions reset on restart).')
  }
  return g.__devAuthSecret
}

function mfaKey(): Buffer {
  const base = process.env.MFA_ENC_KEY || (process.env.AUTH_SECRET && process.env.AUTH_SECRET.length >= 32 ? process.env.AUTH_SECRET : null)
  if (!base) {
    if (process.env.NODE_ENV === 'production') throw new Error('AUTH_SECRET (or MFA_ENC_KEY) must be set in production.')
    return createHash('sha256').update('kinto-dev-only-mfa-key').digest() // dev only; stable so enrolled dev accounts survive restarts
  }
  return createHash('sha256').update(`kinto-mfa:${base}`).digest()
}

/** AES-256-GCM. Output: enc1:<iv>:<tag>:<ciphertext> (base64url). */
export function encryptSecret(plain: string): string {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', mfaKey(), iv)
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()])
  return `enc1:${iv.toString('base64url')}:${c.getAuthTag().toString('base64url')}:${ct.toString('base64url')}`
}

/** Decrypts enc1: values; legacy plaintext (pre-encryption rows) is returned unchanged. */
export function decryptSecret(stored: string): string {
  if (!stored.startsWith('enc1:')) return stored
  const [, iv, tag, ct] = stored.split(':')
  const d = createDecipheriv('aes-256-gcm', mfaKey(), Buffer.from(iv, 'base64url'))
  d.setAuthTag(Buffer.from(tag, 'base64url'))
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8')
}

/** Keyed hash for values that must not be brute-forceable from a leaked database (backup codes). */
export function keyedHash(value: string): string {
  return createHmac('sha256', mfaKey()).update(value).digest('hex')
}
