import 'server-only'
import { decryptSecret, encryptSecret } from '@/lib/hrms/secrets'
import { verifyTotpOnce } from '@/lib/hrms/totp'

/**
 * A user can register several TOTP authenticators (phone + backup phone, Google/Microsoft/Authy…).
 * TOTP is app-agnostic — the server cannot tell which app scanned the QR code — so each one carries a
 * user-given label ("Google Authenticator · Pixel").
 *
 * Storage: User.mfaSecret holds ONE AES-GCM-encrypted JSON document {v:2, items:[…]}.
 * Rows written before multi-authenticator support hold a single bare secret and are read as one
 * item with id "primary" — no migration needed.
 */
export type Authenticator = {
  id: string
  label: string
  secret: string // base32
  createdAt: string | null
  lastUsedAt: string | null
  /** enrolled but not yet confirmed with a code — ignored when signing in */
  pending?: boolean
}

export const MAX_AUTHENTICATORS = 5

export function loadAuthenticators(mfaSecret: string | null): Authenticator[] {
  if (!mfaSecret) return []
  const plain = decryptSecret(mfaSecret)
  if (plain.startsWith('{')) {
    try {
      const doc = JSON.parse(plain) as { v?: number; items?: Authenticator[] }
      if (doc.v === 2 && Array.isArray(doc.items)) return doc.items
    } catch { /* corrupt → treated as none */ }
    return []
  }
  return [{ id: 'primary', label: 'Authenticator app', secret: plain, createdAt: null, lastUsedAt: null }]
}

export function serializeAuthenticators(items: Authenticator[]): string {
  return encryptSecret(JSON.stringify({ v: 2, items }))
}

export const activeAuthenticators = (items: Authenticator[]) => items.filter((i) => !i.pending)

/** The authenticator whose current code matches (single-use per time-step), or null. */
export function matchAuthenticator(userId: string, items: Authenticator[], code: string): Authenticator | null {
  for (const it of activeAuthenticators(items)) {
    if (verifyTotpOnce(`${userId}:${it.id}`, it.secret, code)) return it
  }
  return null
}

/** What the browser may see — never the secret. */
export const publicAuthenticator = (a: Authenticator) => ({
  id: a.id, label: a.label, createdAt: a.createdAt, lastUsedAt: a.lastUsedAt, pending: Boolean(a.pending),
})
