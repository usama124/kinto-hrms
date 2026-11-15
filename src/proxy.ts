import { NextRequest, NextResponse } from 'next/server'
import { rateLimit, clientIp } from '@/lib/hrms/rate-limit'

/**
 * Edge middleware — OWASP hardening:
 *  - Global per-IP sliding-window throttle on /api/* (100 req/min) → 429
 *  - Strict security headers on every response
 *  - Request body size pre-check (defers to route-level MaxBytes enforcement)
 */

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'X-DNS-Prefetch-Control': 'off',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'; form-action 'self'",
}

export default function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl

  if (pathname.startsWith('/api/')) {
    const result = rateLimit(`global:${clientIp(req)}`, 100, 60_000)
    if (!result.ok) {
      return NextResponse.json(
        { error: `Rate limit exceeded. Retry after ${result.retryAfterSec}s.` },
        { status: 429, headers: { 'Retry-After': String(result.retryAfterSec), ...SECURITY_HEADERS } },
      )
    }
    const declared = Number(req.headers.get('content-length') ?? 0)
    if (declared > 8 * 1024 * 1024) {
      return NextResponse.json({ error: 'Request body too large.' }, { status: 413, headers: SECURITY_HEADERS })
    }
  }

  const res = NextResponse.next()
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.headers.set(k, v)
  return res
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
