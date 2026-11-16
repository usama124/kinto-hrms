// Run: bun test tests/unit   (no database needed)
import { expect, mock, test } from 'bun:test'
import { createHmac } from 'crypto'

mock.module('server-only', () => ({}))
mock.module('@/lib/db', () => ({ db: {} })) // only pure helpers are exercised

const { loadAuthenticators, serializeAuthenticators, matchAuthenticator, activeAuthenticators } = await import('@/lib/hrms/authenticators')
const { generateTotpSecret, currentTotp } = await import('@/lib/hrms/totp')
const { verifyDeviceAuth } = await import('@/lib/hrms/biometric')
const tree = await import('@/lib/hrms/designation-tree')

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

// ── designation hierarchy ─────────────────────────────────────────────────────
const n = (id: string, parent: string | null, levelRank = 1, name = id, departmentId = 'd1') => ({ id, name, departmentId, parentDesignationId: parent, levelRank })
//   head ─ manager ─ lead ─ engineer
const chain = [n('head', null), n('manager', 'head', 2), n('lead', 'manager', 3), n('engineer', 'lead', 4)]

test('a designation cannot be placed under itself or under its own descendants (no loops)', () => {
  expect(tree.wouldCreateCycle(chain, 'head', 'head')).toBe(true) // itself
  expect(tree.wouldCreateCycle(chain, 'head', 'engineer')).toBe(true) // its grandchild
  expect(tree.wouldCreateCycle(chain, 'manager', 'lead')).toBe(true)
  expect(tree.wouldCreateCycle(chain, 'lead', 'head')).toBe(false) // moving UP the same branch is fine
  expect(tree.wouldCreateCycle(chain, 'engineer', null)).toBe(false) // becoming a root is fine
})

test('ancestors, descendants and depth', () => {
  expect(tree.ancestorsOf(chain, 'engineer')).toEqual(['lead', 'manager', 'head'])
  expect([...tree.descendantsOf(chain, 'manager')].sort()).toEqual(['engineer', 'lead'])
  expect(tree.depthOf(chain, 'engineer')).toBe(3)
  expect(tree.subtreeHeight(chain, 'head')).toBe(3)
})

test('corrupt cyclic data cannot hang the walkers', () => {
  const bad = [n('a', 'b'), n('b', 'a')]
  expect(tree.ancestorsOf(bad, 'a').length).toBeLessThanOrEqual(3)
  expect(tree.orderedTree(bad)).toHaveLength(0) // nothing is a root, nothing loops
})

test('maximum nesting depth is enforced for new leaves and for moved subtrees', () => {
  const deep = Array.from({ length: tree.MAX_DESIGNATION_DEPTH + 1 }, (_, i) => n(`n${i}`, i ? `n${i - 1}` : null)) // depth 0..MAX
  expect(tree.exceedsMaxDepth(deep, null, `n${tree.MAX_DESIGNATION_DEPTH}`)).toBe(true) // one level too many
  expect(tree.exceedsMaxDepth(deep, null, `n${tree.MAX_DESIGNATION_DEPTH - 1}`)).toBe(false)
  expect(tree.exceedsMaxDepth([...chain, n('x', null)], 'head', 'x')).toBe(false) // 4-level subtree under a root is fine
})

test('display order: roots by level rank then name, children nested right after their parent, orphans shown as roots', () => {
  const list = [n('b', null, 2, 'Beta'), n('a', null, 1, 'Zed'), n('a1', 'a', 2, 'Kid'), n('c', null, 2, 'Alpha'), n('o', 'missing', 9, 'Orphan')]
  expect(tree.orderedTree(list).map((d) => `${d.depth}:${d.name}`)).toEqual(['0:Zed', '1:Kid', '0:Alpha', '0:Beta', '0:Orphan'])
})

test('level rank input: optional, 1–99 whole numbers only', () => {
  expect(tree.parseLevelRank(undefined)).toBeUndefined()
  expect(tree.parseLevelRank('')).toBeUndefined()
  expect(tree.parseLevelRank('3')).toBe(3)
  for (const bad of [0, 100, 1.5, 'abc', -2]) expect(tree.parseLevelRank(bad)).toBe('invalid')
})
