import { APP_NAME } from '@/lib/hrms/constants'
// ─── TOTP (RFC 6238) — Google Authenticator / Authy compatible ────────────────
// Dependency-free implementation: base32 secret, HMAC-SHA1, 30s step, 6 digits.

import { createHmac, randomBytes, createHash, timingSafeEqual } from 'crypto'

const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function base32Encode(buf: Buffer): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of buf) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31]
  return out
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/=+$/, '').replace(/\s/g, '')
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const c of clean) {
    const idx = B32_ALPHABET.indexOf(c)
    if (idx === -1) continue
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20))
}

function hotp(secretBuf: Buffer, counter: number): string {
  const buf = Buffer.alloc(8)
  buf.writeBigUInt64BE(BigInt(counter))
  const hmac = createHmac('sha1', secretBuf).update(buf).digest()
  const offset = hmac[hmac.length - 1] & 0x0f
  const bin =
    ((hmac[offset] & 0x7f) << 24) |
    (hmac[offset + 1] << 16) |
    (hmac[offset + 2] << 8) |
    hmac[offset + 3]
  return String(bin % 1_000_000).padStart(6, '0')
}

export function currentTotp(secret: string, stepSeconds = 30, offset = 0): string {
  const counter = Math.floor(Date.now() / 1000 / stepSeconds) + offset
  return hotp(base32Decode(secret), counter)
}

/** Verify a 6-digit code with ±1 time-step drift tolerance. */
export function verifyTotp(secret: string, code: string, window = 1, stepSeconds = 30): boolean {
  const clean = (code ?? '').replace(/\D/g, '')
  if (clean.length !== 6) return false
  const secretBuf = base32Decode(secret)
  const counter = Math.floor(Date.now() / 1000 / stepSeconds)
  for (let i = -window; i <= window; i++) {
    const expected = hotp(secretBuf, counter + i)
    const a = Buffer.from(expected)
    const b = Buffer.from(clean)
    if (a.length === b.length && timingSafeEqual(a, b)) return true
  }
  return false
}

export function otpauthUri(email: string, secret: string, issuer = APP_NAME): string {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(email)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`
}

// ─── Backup recovery codes (hashed, one-time) ────────────────────────────────

export function generateBackupCodes(count = 8): { plain: string[]; hashes: string[] } {
  const plain: string[] = []
  const hashes: string[] = []
  for (let i = 0; i < count; i++) {
    const raw = randomBytes(5).toString('hex').toUpperCase() // 10 hex chars
    const code = `${raw.slice(0, 5)}-${raw.slice(5)}`
    plain.push(code)
    hashes.push(sha256Hex(code))
  }
  return { plain, hashes }
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

export function verifyBackupCode(code: string, hashesJson: string | null): { ok: boolean; remaining: string[] } {
  if (!hashesJson) return { ok: false, remaining: [] }
  const hashes: string[] = JSON.parse(hashesJson)
  const h = sha256Hex((code ?? '').trim().toUpperCase())
  if (!hashes.includes(h)) return { ok: false, remaining: hashes }
  return { ok: true, remaining: hashes.filter((x) => x !== h) }
}
