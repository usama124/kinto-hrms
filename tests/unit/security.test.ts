// Run: bun test tests/unit   (db is mocked; no database needed)
import { expect, mock, test } from 'bun:test'

mock.module('server-only', () => ({})) // Next provides this guard internally; it isn't an installed package

type U = { id: string; role: string; teamLeadId: string | null; managerId: string | null }
const users: Record<string, U> = {
  emp: { id: 'emp', role: 'EMPLOYEE', teamLeadId: 'tl', managerId: 'mgr' },
  hr: { id: 'hr', role: 'HR_MANAGER', teamLeadId: 'tl', managerId: 'mgr' }, // even with a reporting line assigned
  hr2: { id: 'hr2', role: 'HR_MANAGER', teamLeadId: null, managerId: null },
  admin: { id: 'admin', role: 'SUPER_ADMIN', teamLeadId: null, managerId: null },
}
mock.module('@/lib/db', () => ({ db: { user: { findUnique: async ({ where }: { where: { id: string } }) => users[where.id] ?? null } } }))

const { canApproveLeaveAtStage, canApproveAttendanceAtStage, nextStageOf, initialStageOf } = await import('@/lib/hrms/rbac')
const { encryptSecret, decryptSecret } = await import('@/lib/hrms/secrets')
const { passwordPolicyError, generateTempPassword } = await import('@/lib/hrms/password')
const { generateBackupCodes, verifyBackupCode, sha256Hex, verifyTotpOnce, generateTotpSecret, currentTotp } = await import('@/lib/hrms/totp')

const sess = (id: string, role: string) => ({ userId: id, email: '', fullName: id, role })
const pending = (userId: string, stage = 'TEAM_LEAD') => ({ userId, status: `PENDING_${stage}`, currentStage: stage })

// ── approval authority (both request kinds share the rules) ────────────────────
for (const [name, can] of [['leave', canApproveLeaveAtStage], ['attendance', canApproveAttendanceAtStage]] as const) {
  test(`${name}: an HR Manager cannot approve their own request`, async () => {
    expect((await can(sess('hr', 'HR_MANAGER'), pending('hr', 'HR'))).allowed).toBe(false)
  })
  test(`${name}: another HR Manager / team lead / manager cannot approve an HR Manager's request`, async () => {
    for (const s of [sess('hr2', 'HR_MANAGER'), sess('tl', 'TEAM_LEAD'), sess('mgr', 'MANAGER')]) {
      expect((await can(s, pending('hr', 'HR'))).allowed).toBe(false)
      expect((await can(s, pending('hr', 'TEAM_LEAD'))).allowed).toBe(false)
    }
  })
  test(`${name}: only the System Admin approves an HR Manager's request`, async () => {
    expect(await can(sess('admin', 'SUPER_ADMIN'), pending('hr', 'HR'))).toEqual({ allowed: true, level: 'ADMIN' })
  })
  test(`${name}: the System Admin's own request is decided by the System Admin only`, async () => {
    expect((await can(sess('admin', 'SUPER_ADMIN'), pending('admin', 'HR'))).allowed).toBe(true)
    expect((await can(sess('hr', 'HR_MANAGER'), pending('admin', 'HR'))).allowed).toBe(false)
  })
  test(`${name}: normal chain unchanged — assigned team lead yes, stranger no, HR fast-track yes`, async () => {
    expect((await can(sess('tl', 'TEAM_LEAD'), pending('emp'))).level).toBe('TEAM_LEAD')
    expect((await can(sess('other', 'TEAM_LEAD'), pending('emp'))).allowed).toBe(false)
    expect((await can(sess('hr', 'HR_MANAGER'), pending('emp'))).level).toBe('ADMIN')
  })
  test(`${name}: nobody approves their own request`, async () => {
    expect((await can(sess('emp', 'EMPLOYEE'), pending('emp'))).allowed).toBe(false)
  })
}
test('HR Manager requests have a single stage (HR, decided by the System Admin)', () => {
  expect(initialStageOf('LEAVE', users.hr)).toEqual({ status: 'PENDING_HR', stage: 'HR' })
  expect(nextStageOf('ATTENDANCE', users.hr, 'HR')).toBeNull()
  expect(initialStageOf('LEAVE', users.emp)).toEqual({ status: 'PENDING_TEAM_LEAD', stage: 'TEAM_LEAD' })
})

// ── MFA secret at rest / backup codes / TOTP replay ────────────────────────────
test('MFA secret round-trips, is not stored in clear, and legacy plaintext still decrypts', () => {
  const s = generateTotpSecret()
  const enc = encryptSecret(s)
  expect(enc.startsWith('enc1:') && !enc.includes(s)).toBe(true)
  expect(decryptSecret(enc)).toBe(s)
  expect(decryptSecret(s)).toBe(s)
  expect(() => decryptSecret(enc.slice(0, -2) + 'AA')).toThrow() // tampering is detected (GCM tag)
})
test('backup codes are single-use; legacy sha256 codes still work', () => {
  const { plain, hashes } = generateBackupCodes(2)
  const r = verifyBackupCode(plain[0].toLowerCase().replace(/-/g, ' '), JSON.stringify(hashes))
  expect(r.ok).toBe(true)
  expect(verifyBackupCode(plain[0], JSON.stringify(r.remaining)).ok).toBe(false)
  expect(verifyBackupCode('ABCDE-12345', JSON.stringify([sha256Hex('ABCDE-12345')])).ok).toBe(true)
})
test('a TOTP code cannot be replayed', () => {
  const s = generateTotpSecret()
  const code = currentTotp(s)
  expect(verifyTotpOnce('u1', s, code)).toBe(true)
  expect(verifyTotpOnce('u1', s, code)).toBe(false)
})

// ── password policy ───────────────────────────────────────────────────────────
test('password policy + generated temp passwords satisfy it', () => {
  expect(passwordPolicyError('short1A!')).not.toBeNull()
  expect(passwordPolicyError('alllowercase1!')).not.toBeNull()
  expect(passwordPolicyError('Str0ng!Passw0rd')).toBeNull()
  for (let i = 0; i < 50; i++) expect(passwordPolicyError(generateTempPassword())).toBeNull()
})
