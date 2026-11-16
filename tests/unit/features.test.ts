// Run: bun test tests/unit   (no database needed)
import { expect, mock, test } from 'bun:test'
import { createHmac } from 'crypto'

mock.module('server-only', () => ({}))
mock.module('@/lib/db', () => ({ db: {} })) // only pure helpers are exercised

const { loadAuthenticators, serializeAuthenticators, matchAuthenticator, activeAuthenticators } = await import('@/lib/hrms/authenticators')
const { generateTotpSecret, currentTotp } = await import('@/lib/hrms/totp')
const { verifyDeviceAuth } = await import('@/lib/hrms/biometric')
const { findDesignation } = await import('@/lib/hrms/designations')

// ── authenticators ────────────────────────────────────────────────────────────
test('a legacy single secret is read as one active authenticator', () => {
  const s = generateTotpSecret()
  const items = loadAuthenticators(s) // pre-multi-authenticator rows stored the bare secret
  expect(items).toHaveLength(1)
  expect(items[0]).toMatchObject({ id: 'primary', secret: s })
  expect(matchAuthenticator('legacy-user', items, currentTotp(s))?.id).toBe('primary')
})

test('several authenticators: any one signs in, pending ones are ignored, secrets are encrypted at rest', () => {
  const a = generateTotpSecret(), b = generateTotpSecret(), c = generateTotpSecret()
  const stored = serializeAuthenticators([
    { id: 'a', label: 'Google Authenticator · phone', secret: a, createdAt: null, lastUsedAt: null },
    { id: 'b', label: 'Microsoft Authenticator', secret: b, createdAt: null, lastUsedAt: null },
    { id: 'c', label: 'not confirmed yet', secret: c, createdAt: null, lastUsedAt: null, pending: true },
  ])
  expect(stored.includes(a) || stored.includes('Google')).toBe(false) // AES-GCM blob, not readable JSON
  const items = loadAuthenticators(stored)
  expect(items).toHaveLength(3)
  expect(activeAuthenticators(items).map((i) => i.id)).toEqual(['a', 'b'])
  expect(matchAuthenticator('multi-user', items, currentTotp(b))?.id).toBe('b')
  expect(matchAuthenticator('multi-user-2', items, currentTotp(c))).toBeNull() // pending authenticator can't be used to sign in
})

// ── biometric device registry ─────────────────────────────────────────────────
const dev = (id: string, enabled = true) => ({ id, name: id, model: 'ZKTeco K50', sn: `SN-${id}`, key: `dk_${id}_key`, secret: `${id}-secret-that-is-long-enough`, enabled, createdAt: '' })
const sign = (secret: string, ts: string, body: string) => createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')

test('any registered device authenticates with ITS OWN key + secret; a disabled one is refused', () => {
  const devices = [dev('door'), dev('gate'), dev('old', false)]
  const ts = String(Date.now()), body = 'PIN=1\tTIME=2026-01-01 09:00:00'
  expect(verifyDeviceAuth(devices, 'dk_gate_key', ts, sign(devices[1].secret, ts, body), body)).toMatchObject({ ok: true, device: { id: 'gate' } })
  expect(verifyDeviceAuth(devices, 'dk_gate_key', ts, sign(devices[0].secret, ts, body), body).ok).toBe(false) // other device's secret
  expect(verifyDeviceAuth(devices, 'dk_old_key', ts, sign(devices[2].secret, ts, body), body).ok).toBe(false) // disabled
  expect(verifyDeviceAuth(devices, 'nope', ts, 'x', body).reason).toBe('Unknown device key')
  const stale = String(Date.now() - 10 * 60_000)
  expect(verifyDeviceAuth(devices, 'dk_door_key', stale, sign(devices[0].secret, stale, body), body).reason).toBe('Stale timestamp')
  expect(verifyDeviceAuth([], 'dk_door_key', ts, 'x', body).reason).toBe('Biometric ingestion disabled')
})

// ── designations ──────────────────────────────────────────────────────────────
test('designation lookup is case-insensitive and returns the canonical spelling', () => {
  const list = ['Software Engineer', 'HR Manager']
  expect(findDesignation(list, '  software engineer ')).toBe('Software Engineer')
  expect(findDesignation(list, 'Rockstar Ninja')).toBeNull()
})
