// ─── Sliding-window rate limiter (in-memory, per process) ─────────────────────

type Window = { hits: number[] }

const buckets = new Map<string, Window>()
let lastSweep = Date.now()

function sweep(now: number, windowMs: number) {
  if (now - lastSweep < 30_000) return
  lastSweep = now
  for (const [key, w] of buckets) {
    if (!w.hits.length || now - w.hits[w.hits.length - 1] > windowMs * 2) buckets.delete(key)
  }
}

export type RateResult = { ok: true } | { ok: false; retryAfterSec: number }

/**
 * Sliding-window counter. Returns ok=false once `max` hits occur inside `windowMs`.
 * Keys should be namespaced, e.g. `login:${ip}` or `global:${ip}`.
 */
export function rateLimit(key: string, max: number, windowMs: number): RateResult {
  const now = Date.now()
  sweep(now, windowMs)
  let w = buckets.get(key)
  if (!w) {
    w = { hits: [] }
    buckets.set(key, w)
  }
  w.hits = w.hits.filter((t) => now - t < windowMs)
  if (w.hits.length >= max) {
    const retryAfterSec = Math.max(1, Math.ceil((w.hits[0] + windowMs - now) / 1000))
    return { ok: false, retryAfterSec }
  }
  w.hits.push(now)
  return { ok: true }
}

/**
 * Client IP as seen by the reverse proxy. Uses the RIGHT-most X-Forwarded-For entry (the one our own
 * proxy appended — a client can only forge entries to its left) and validates the shape, so a forged
 * header can neither dodge the throttles nor inject junk into audit rows.
 * The app must only be reachable through the trusted proxy (Caddy); bind it to localhost otherwise.
 */
export function clientIp(req: Request): string {
  const h = req.headers
  const xff = h.get('x-forwarded-for')?.split(',').map((s) => s.trim()).filter(Boolean)
  const ip = h.get('x-real-ip')?.trim() || xff?.[xff.length - 1] || ''
  return /^[0-9a-fA-F:.]{3,45}$/.test(ip) ? ip : 'unknown'
}

/** Route-aware limit helper. Throws a sentinel via return value (never throws). */
export function guardRate(req: Request, bucket: string, max: number, windowMs: number): RateResult {
  return rateLimit(`${bucket}:${clientIp(req)}`, max, windowMs)
}

export const RATE_LIMITS = {
  AUTH: { max: 5, windowMs: 60_000 }, // 5 req/min on /auth/login & /auth/mfa
  MFA_ENROLL: { max: 10, windowMs: 60_000 },
  REFRESH: { max: 30, windowMs: 60_000 },
  BIOMETRIC: { max: 60, windowMs: 60_000 },
  GLOBAL_API: { max: 100, windowMs: 60_000 }, // per-IP global API throttle
  UPLOAD: { max: 10, windowMs: 60_000 },
} as const
