import { check, eq, section } from './lib'
import { ACCOUNTS, ORG_ADMIN, PAYROLL_OPERATORS, ALL_ROLES, ctx, demoUsers, expectedVisible, pool, client, userBy } from './ctx'

type Rule = {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  path: (me: { id: string; teamId: string | null }) => string
  body?: unknown
  /** roles that must get through authorization; everyone else must get exactly 403 */
  allow: string[]
  label: string
}
const ALL = ALL_ROLES
const NOT_EMPLOYEE = ALL_ROLES.filter((r) => r !== 'EMPLOYEE')
const NOT_ACCOUNTS = ALL_ROLES.filter((r) => !ACCOUNTS.includes(r))

export async function phase2() {
  section('2a. Role × endpoint access matrix (every demo account)')
  const target = userBy((u) => u.isDemo && u.role === 'EMPLOYEE', 'a demo employee')
  const team = ctx.users.find((u) => u.teamId)?.teamId ?? 'x'
  const FAKE = 'cl_fake_id_000000000000'
  const month = '2020-01'

  const rules: Rule[] = [
    // reads
    { method: 'GET', path: () => '/api/auth/me', allow: ALL, label: 'me' },
    { method: 'GET', path: () => '/api/meta', allow: ALL, label: 'meta' },
    { method: 'GET', path: () => '/api/dashboard', allow: ALL, label: 'dashboard' },
    { method: 'GET', path: () => '/api/employees', allow: ALL, label: 'employees list' },
    { method: 'GET', path: (m) => `/api/employees/${m.id}`, allow: ALL, label: 'own 360 profile' },
    { method: 'GET', path: () => '/api/org-structure', allow: NOT_EMPLOYEE, label: 'org chart' },
    { method: 'GET', path: () => '/api/requests', allow: NOT_ACCOUNTS, label: 'leave requests list' },
    { method: 'GET', path: () => '/api/attendance/requests', allow: NOT_ACCOUNTS, label: 'regularization list' },
    { method: 'GET', path: () => '/api/attendance', allow: ALL, label: 'timesheet' },
    { method: 'GET', path: () => '/api/leave-balances', allow: ALL, label: 'leave balances' },
    { method: 'GET', path: () => '/api/notifications', allow: ALL, label: 'notifications' },
    { method: 'GET', path: () => '/api/shifts', allow: ALL, label: 'shifts' },
    { method: 'GET', path: () => '/api/departments', allow: ALL, label: 'departments' },
    { method: 'GET', path: () => '/api/designations', allow: ALL, label: 'designations' },
    { method: 'GET', path: () => '/api/settings', allow: ALL, label: 'settings (limited for plain users)' },
    { method: 'GET', path: () => '/api/auth/mfa/devices', allow: ALL, label: 'my authenticators' },
    { method: 'GET', path: () => '/api/payroll/payslips', allow: ALL, label: 'payslips (own)' },
    { method: 'GET', path: (m) => `/api/reports/individual?userId=${m.id}`, allow: ALL, label: 'own report' },
    { method: 'GET', path: () => '/api/rules', allow: ORG_ADMIN, label: 'rules' },
    { method: 'GET', path: () => '/api/audit-logs', allow: ORG_ADMIN, label: 'audit logs' },
    { method: 'GET', path: () => '/api/organizations', allow: ORG_ADMIN, label: 'org drill-down' },
    { method: 'GET', path: () => `/api/teams/${team}`, allow: ORG_ADMIN, label: 'team roster' },
    { method: 'GET', path: () => '/api/biometric/devices', allow: ORG_ADMIN, label: 'biometric devices' },
    { method: 'GET', path: () => '/api/payroll/runs', allow: [...PAYROLL_OPERATORS, 'HR_MANAGER'], label: 'payroll runs (HR read-only)' },
    { method: 'GET', path: () => `/api/payroll/excel?month=${month}`, allow: PAYROLL_OPERATORS, label: 'payroll excel' },
    { method: 'GET', path: () => `/api/payroll/bulk-pdf?month=${month}`, allow: PAYROLL_OPERATORS, label: 'payroll bulk pdf' },
    { method: 'GET', path: () => '/api/reports/org', allow: [...ORG_ADMIN, ...ACCOUNTS], label: 'org report (accounts = payroll only)' },
    { method: 'GET', path: () => '/api/reports/pdf?type=org-attendance', allow: ORG_ADMIN, label: 'org attendance pdf' },
    // writes: bodies are deliberately invalid so allowed roles stop at validation (never reach a side effect)
    { method: 'POST', path: () => '/api/employees', body: {}, allow: ORG_ADMIN, label: 'create employee' },
    { method: 'PATCH', path: () => `/api/employees/${target.id}`, body: {}, allow: ORG_ADMIN, label: 'edit employee' },
    { method: 'POST', path: () => '/api/departments', body: {}, allow: ORG_ADMIN, label: 'create department' },
    { method: 'POST', path: () => '/api/designations', body: {}, allow: ORG_ADMIN, label: 'create designation' },
    { method: 'POST', path: () => '/api/leave-types', body: {}, allow: ORG_ADMIN, label: 'create leave type' },
    { method: 'POST', path: () => '/api/rules', body: {}, allow: ORG_ADMIN, label: 'add custom rule' },
    { method: 'PUT', path: () => '/api/rules', body: { rules: [{ key: 'nope', value: 1 }] }, allow: ORG_ADMIN, label: 'edit rules' },
    { method: 'POST', path: () => '/api/shifts', body: {}, allow: ORG_ADMIN, label: 'create shift' },
    { method: 'POST', path: () => '/api/org-structure', body: {}, allow: ORG_ADMIN, label: 'create dept/team' },
    { method: 'POST', path: () => '/api/biometric/devices', body: {}, allow: ORG_ADMIN, label: 'add device' },
    { method: 'POST', path: () => '/api/attendance/sync', body: { from: 'bad' }, allow: ORG_ADMIN, label: 'attendance sync' },
    { method: 'POST', path: () => '/api/payroll/runs', body: {}, allow: PAYROLL_OPERATORS, label: 'create payroll run' },
    { method: 'PATCH', path: () => '/api/payroll/salary', body: {}, allow: PAYROLL_OPERATORS, label: 'edit salary' },
    { method: 'POST', path: () => '/api/payroll/adjustments', body: {}, allow: PAYROLL_OPERATORS, label: 'payroll adjustment' },
    { method: 'DELETE', path: () => `/api/payroll/runs/${FAKE}`, allow: PAYROLL_OPERATORS, label: 'discard draft run' },
    { method: 'POST', path: () => `/api/payroll/runs/${FAKE}/finalize`, allow: ['ACCOUNTS_MANAGER'], label: 'finalize payroll (Accounts Head only)' },
    { method: 'POST', path: () => '/api/leave-balances/adjust', body: {}, allow: ['SUPER_ADMIN'], label: 'adjust leave quota' },
    { method: 'PATCH', path: () => '/api/settings', body: {}, allow: ['SUPER_ADMIN'], label: 'change settings' },
    { method: 'POST', path: () => '/api/requests', body: {}, allow: NOT_ACCOUNTS, label: 'file leave request' },
    { method: 'POST', path: () => '/api/attendance/requests', body: {}, allow: NOT_ACCOUNTS.filter((r) => r !== 'SUPER_ADMIN'), label: 'file regularization' },
    { method: 'POST', path: () => '/api/attendance/punch', body: {}, allow: ALL.filter((r) => r !== 'SUPER_ADMIN'), label: 'web punch (System Admin is oversight-only)' },
    { method: 'POST', path: () => '/api/biometric/simulate', body: {}, allow: [], label: 'demo simulator is disabled in production' },
  ]

  const users = demoUsers()
  let n = 0
  await pool(users, 8, async (u) => {
    const c = client(u)
    for (const r of rules) {
      const res = await c.req(r.method, r.path(u), r.body !== undefined ? { json: r.body } : {})
      const allowed = r.allow.includes(u.role)
      n++
      if (allowed) check(res.status !== 401 && res.status !== 403 && res.status < 500, `${u.role} ${u.email} → ${r.method} ${r.label} allowed`, `HTTP ${res.status} ${JSON.stringify(res.json)}`)
      else check(res.status === 403, `${u.role} ${u.email} → ${r.method} ${r.label} denied`, `HTTP ${res.status} ${JSON.stringify(res.json)}`)
    }
  })
  console.log(`   ${n} role/endpoint decisions evaluated`)

  // ── data scope ─────────────────────────────────────────────────────────────
  section('2b. Data scope per account (who sees whom)')
  await pool(users, 8, async (u) => {
    const c = client(u)
    const want = expectedVisible(u)
    const emp = await c.get('/api/employees')
    const got = new Set<string>((emp.json?.people ?? []).map((p: any) => p.id))
    check(got.size === want.size && [...want].every((id) => got.has(id)), `${u.role} ${u.email}: directory shows exactly its scope (${want.size})`, `got ${got.size}, expected ${want.size}`)
    const meta = await c.get('/api/meta')
    const mp = new Set<string>((meta.json?.people ?? []).map((p: any) => p.id))
    check(mp.size === want.size && [...want].every((id) => mp.has(id)), `${u.role} ${u.email}: meta.people equals its scope`, `got ${mp.size}, expected ${want.size}`)

    // compensation never leaks to a supervisor browsing their team
    const richOK = ['SUPER_ADMIN', 'HR_MANAGER', 'ACCOUNTANT', 'ACCOUNTS_MANAGER'].includes(u.role)
    for (const p of emp.json?.people ?? []) {
      const mayRead = p.id === u.id || richOK
      if (!mayRead && ('baseSalary' in p || 'allowances' in p)) { check(false, `${u.email}: directory leaks salary of ${p.fullName}`); break }
    }

    // a stranger's 360 profile is refused (403); in-scope profiles load
    const outsider = ctx.users.find((x) => !want.has(x.id))
    if (outsider) {
      const r = await c.get(`/api/employees/${outsider.id}`)
      check(r.status === 403, `${u.role} ${u.email}: outsider profile → 403`, `HTTP ${r.status}`)
    }
    const insider = [...want].find((id) => id !== u.id)
    if (insider) {
      const r = await c.get(`/api/employees/${insider}`)
      check(r.status === 200, `${u.role} ${u.email}: in-scope profile → 200`, `HTTP ${r.status}`)
      if (r.status === 200 && !richOK && u.role !== 'HR_MANAGER') {
        const e = r.json.employee
        check(e.cnic == null && e.passportNo == null && !('baseSalary' in e), `${u.email}: supervisor view hides ID numbers and salary`, JSON.stringify({ cnic: e.cnic, baseSalary: e.baseSalary }))
      }
    }
  })

  // dashboard flavour per role
  section('2c. Dashboard per role')
  await pool(users, 8, async (u) => {
    const d = await client(u).get('/api/dashboard')
    const org = ['SUPER_ADMIN', 'HR_MANAGER'].includes(u.role)
    eq(d.json?.kind, org ? 'org' : 'personal', `${u.role} ${u.email}: dashboard kind`)
  })
}
