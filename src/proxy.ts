import { NextRequest, NextResponse } from 'next/server'
import { rateLimit, clientIp } from '@/lib/hrms/rate-limit'

/**
 * Edge middleware — OWASP hardening:
 *  - Global per-IP sliding-window throttle on /api/* (100 req/min) → 429
 *  - CSRF defence for browser-driven mutations: Sec-Fetch-Site / Origin must be same-origin
 *    (on top of SameSite=Lax cookies). Device endpoints (/api/biometric/*) are non-browser and
 *    authenticated by HMAC, so they are exempt.
 *  - Strict security headers on every response
 *  - Request body size pre-check (defers to route-level MaxBytes enforcement)
 */

const isDev = process.env.NODE_ENV !== 'production'

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'X-DNS-Prefetch-Control': 'off',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
  // 'unsafe-eval' is development-only (React debugging) — Next/React never need it in production.
  // ponytail: script 'unsafe-inline' remains because Next's inline bootstrap scripts need it; moving to a
  // per-request nonce + 'strict-dynamic' requires dynamic rendering of every page (see node_modules/next/dist/docs/01-app/02-guides/content-security-policy.md).
  'Content-Security-Policy':
    `default-src 'self'; script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'`,
}

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

function isCrossSiteMutation(req: NextRequest): boolean {
  if (req.headers.get('sec-fetch-site') === 'cross-site') return true
  const origin = req.headers.get('origin')
  if (!origin) return false // non-browser clients send no Origin; they have no ambient cookies to abuse
  try {
    return new URL(origin).host !== req.headers.get('host')
  } catch {
    return true
  }
}

export default function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl

  if (pathname.startsWith('/api/')) {
    if (UNSAFE_METHODS.has(req.method) && !pathname.startsWith('/api/biometric/') && isCrossSiteMutation(req)) {
      return NextResponse.json({ error: 'Cross-site request blocked.' }, { status: 403, headers: SECURITY_HEADERS })
    }
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
  // API responses carry personal / payroll data: never let a browser or shared proxy cache them
  // …except profile pictures: their URL carries ?v=<upload id>, so the route marks them immutable and they should stay cacheable
  const isAvatar = req.method === 'GET' && /^\/api\/employees\/[^/]+\/avatar$/.test(pathname)
  if (pathname.startsWith('/api/') && !isAvatar) res.headers.set('Cache-Control', 'no-store')
  return res
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
