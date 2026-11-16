/**
 * End-to-end harness: talks to a RUNNING server over HTTP exactly like a browser (cookies, headers), plus a direct DB
 * connection for setup, expectations and cleanup. Run via tests/e2e/run.ts.
 */
import { createHash, createHmac, randomBytes, scryptSync } from 'crypto'

export const BASE = process.env.E2E_BASE ?? 'http://127.0.0.1:3100'
export const DEMO_PASSWORD = process.env.DUMMY_PASSWORD ?? 'Demo@12345'
export const DOMAIN = '@demo.hrms.local'

// ─── reporting ────────────────────────────────────────────────────────────────
type Result = { section: string; name: string; ok: boolean; detail?: string }
const results: Result[] = []
let currentSection = ''
export const section = (name: string) => { currentSection = name; console.log(`\n▶ ${name}`) }

export function check(ok: boolean, name: string, detail?: unknown) {
  results.push({ section: currentSection, name, ok, detail: ok ? undefined : String(detail ?? '') })
  if (!ok) console.log(`   ✗ ${name}${detail !== undefined ? `  →  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`.slice(0, 400) : ''}`)
  return ok
}
export const eq = (actual: unknown, expected: unknown, name: string) =>
  check(JSON.stringify(actual) === JSON.stringify(expected), name, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
export const status = (r: Res, expected: number | number[], name: string) => {
  const list = Array.isArray(expected) ? expected : [expected]
  return check(list.includes(r.status), name, `expected HTTP ${list.join('/')}, got ${r.status} ${r.status >= 400 ? JSON.stringify(r.json) : ''}`)
}

export function summary(): { passed: number; failed: number } {
  const failed = results.filter((r) => !r.ok)
  const bySection = new Map<string, { p: number; f: number }>()
  for (const r of results) {
    const s = bySection.get(r.section) ?? { p: 0, f: 0 }
    r.ok ? s.p++ : s.f++
    bySection.set(r.section, s)
  }
  console.log('\n══════════════════ SUMMARY ══════════════════')
  for (const [s, v] of bySection) console.log(`${v.f ? '✗' : '✓'} ${s.padEnd(58)} ${String(v.p).padStart(4)} passed${v.f ? `, ${v.f} FAILED` : ''}`)
  console.log(`\nTOTAL: ${results.length - failed.length} passed, ${failed.length} failed (${results.length} checks)`)
  if (failed.length) {
    console.log('\nFAILURES:')
    for (const f of failed) console.log(` - [${f.section}] ${f.name}\n     ${f.detail}`)
  }
  return { passed: results.length - failed.length, failed: failed.length }
}

// ─── HTTP client with a cookie jar ───────────────────────────────────────────
export type Res = { status: number; json: any; headers: Headers; buf: Buffer; text: string }

let ipCounter = Math.floor(Math.random() * (1 << 22)) // random start per run: the server remembers rate-limit buckets per IP for a minute, so a re-run must not reuse the last run's addresses
export const nextIp = () => { ipCounter++; return `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter & 255}` }

export class Client {
  jar = new Map<string, string>()
  ip = nextIp() // the app rate-limits per IP (X-Real-IP behind the proxy) — each simulated user gets their own
  rotate = true // long-running actors (HR, System Admin…) move to a fresh simulated IP every 40 requests; limiter tests switch this off
  private sent = 0
  constructor(public label = '') {}
  rotateIp() { this.ip = nextIp() }

  private cookieHeader() { return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ') }
  private store(res: Response) {
    for (const c of (res.headers as any).getSetCookie?.() ?? []) {
      const [pair, ...attrs] = c.split(';')
      const i = pair.indexOf('=')
      const name = pair.slice(0, i).trim(), value = pair.slice(i + 1).trim()
      const gone = value === '' || attrs.some((a: string) => /max-age=0/i.test(a))
      gone ? this.jar.delete(name) : this.jar.set(name, value)
    }
  }

  async req(method: string, path: string, opts: { json?: unknown; form?: FormData; raw?: string | Buffer; headers?: Record<string, string>; origin?: string | null } = {}): Promise<Res> {
    if (this.rotate && ++this.sent % 40 === 0) this.rotateIp()
    const headers: Record<string, string> = { 'X-Real-IP': this.ip, ...(opts.headers ?? {}) }
    if (opts.origin !== null) headers.Origin = opts.origin ?? BASE // browsers send Origin on same-origin POSTs; the CSRF guard checks it
    if (this.jar.size) headers.Cookie = this.cookieHeader()
    let body: any
    if (opts.json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(opts.json) }
    else if (opts.form) body = opts.form
    else if (opts.raw !== undefined) body = opts.raw
    const res = await fetch(BASE + path, { method, headers, body, redirect: 'manual' })
    this.store(res)
    const buf = Buffer.from(await res.arrayBuffer())
    const text = buf.toString('utf8')
    let json: any = null
    if ((res.headers.get('content-type') ?? '').includes('json')) { try { json = JSON.parse(text) } catch { /* not json */ } }
    return { status: res.status, json, headers: res.headers, buf, text }
  }
  get = (p: string, o?: Parameters<Client['req']>[2]) => this.req('GET', p, o)
  post = (p: string, json?: unknown, o?: Parameters<Client['req']>[2]) => this.req('POST', p, { json: json ?? {}, ...o })
  patch = (p: string, json?: unknown, o?: Parameters<Client['req']>[2]) => this.req('PATCH', p, { json: json ?? {}, ...o })
  put = (p: string, json?: unknown, o?: Parameters<Client['req']>[2]) => this.req('PUT', p, { json: json ?? {}, ...o })
  del = (p: string, json?: unknown, o?: Parameters<Client['req']>[2]) => this.req('DELETE', p, { json: json ?? {}, ...o })
}

// ─── TOTP (RFC 6238), independent of the app's implementation ─────────────────
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
function b32decode(s: string): Buffer {
  let bits = 0, value = 0
  const out: number[] = []
  for (const c of s.toUpperCase().replace(/=+$/, '')) {
    const i = B32.indexOf(c)
    if (i < 0) continue
    value = (value << 5) | i; bits += 5
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8 }
  }
  return Buffer.from(out)
}
/** Code for the current 30 s step shifted by `offset` steps (the server accepts ±1). */
export function totp(secret: string, offset = 0): string {
  const counter = Math.floor(Date.now() / 30000) + offset
  const buf = Buffer.alloc(8); buf.writeBigUInt64BE(BigInt(counter))
  const h = createHmac('sha1', b32decode(secret)).update(buf).digest()
  const o = h[h.length - 1] & 0xf
  const bin = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]
  return String(bin % 1_000_000).padStart(6, '0')
}

// ─── misc helpers ─────────────────────────────────────────────────────────────
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
export const hashPassword = (plain: string) => { const salt = randomBytes(16).toString('hex'); return `${salt}:${scryptSync(plain, salt, 64).toString('hex')}` }
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

/** A tiny valid PNG (1×1) / JPEG header for upload tests — the server sniffs magic bytes. */
export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
export const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from('JFIF'), Buffer.alloc(40)])
export const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n')

export function fileForm(buf: Buffer, name: string, type: string, field = 'file') {
  const fd = new FormData()
  fd.append(field, new File([new Uint8Array(buf)], name, { type }))
  return fd
}

/** YYYY-MM-DD helpers (UTC-anchored date arithmetic; Karachi has no DST). */
export const addDays = (key: string, n: number) => { const d = new Date(`${key}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10) }
export const isoWeekday = (key: string) => { const w = new Date(`${key}T00:00:00Z`).getUTCDay(); return w === 0 ? 7 : w }
export const todayKarachi = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi' }).format(new Date())
