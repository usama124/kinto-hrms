import reset from './reset-mfa'
import { createHmac } from 'crypto'
import { test, expect, type Page } from '@playwright/test'

test.beforeAll(() => reset()) // each spec starts with un-enrolled demo accounts
const PW = process.env.DUMMY_PASSWORD ?? 'Demo@12345'
const ACCOUNTS = [
  { role: 'EMPLOYEE', email: 'adeel.chaudhry@demo.hrms.local' },
  { role: 'TEAM_LEAD', email: 'aiza.ansari@demo.hrms.local' },
  { role: 'MANAGER', email: 'aiza.iqbal@demo.hrms.local' },
  { role: 'HR_MANAGER', email: 'yasir.hussain@demo.hrms.local' },
  { role: 'ACCOUNTANT', email: 'adeel.farooqi@demo.hrms.local' },
  { role: 'ACCOUNTS_MANAGER', email: 'bushra.rehman@demo.hrms.local' },
  { role: 'SUPER_ADMIN', email: 'sysadmin@demo.hrms.local' },
]
const NAV: Record<string, string[]> = {
  EMPLOYEE: ['Dashboard', 'My Profile', 'Employee Directory', 'Attendance', 'Requests'],
}
const ALL = ['Dashboard', 'My Profile', 'Employee Directory', 'Org Chart', 'Attendance', 'Requests', 'Payroll', 'Reports', 'Rules & Settings']
const wanted = (role: string) => NAV[role] ?? ALL.filter((l) => {
  if (l === 'Payroll') return ['SUPER_ADMIN', 'HR_MANAGER', 'ACCOUNTANT', 'ACCOUNTS_MANAGER'].includes(role)
  if (l === 'Rules & Settings') return ['SUPER_ADMIN', 'HR_MANAGER'].includes(role)
  if (l === 'Requests') return !['ACCOUNTANT', 'ACCOUNTS_MANAGER'].includes(role)
  return role !== 'EMPLOYEE' || !['Org Chart', 'Reports'].includes(l)
})

function b32(s: string) { const a = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = ''; for (const c of s.replace(/=+$/, '').toUpperCase()) bits += a.indexOf(c).toString(2).padStart(5, '0'); const out: number[] = []; for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2)); return Buffer.from(out) }
function totp(secret: string, off = 0) { const c = Math.floor(Date.now() / 30000) + off; const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(c)); const h = createHmac('sha1', b32(secret)).update(b).digest(); const o = h[h.length - 1] & 15; return String((((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1e6).padStart(6, '0') }

/** MFA roles are enrolled through the API (the QR step needs an authenticator app); everything after is real UI. */
let ipSeq = 100 + Math.floor(Math.random() * 100)
async function signIn(page: Page, email: string, mfa: boolean) {
  // the test server has no reverse proxy: give each sign-in its own simulated client IP so the 5/min login limiter is not shared
  await page.context().setExtraHTTPHeaders({ 'x-real-ip': `10.77.${ipSeq++ % 250}.${Math.floor(Math.random() * 250) + 1}` })
  if (!mfa) {
    await page.goto('/')
    await page.getByLabel('Email').fill(email)
    await page.getByLabel('Password').fill(PW)
    await page.getByRole('button', { name: 'Sign in' }).click()
    return
  }
  const r = page.request
  const login = await r.post('/api/auth/login', { data: { email, password: PW } })
  expect(login.status()).toBe(200)
  const en = await r.post('/api/auth/mfa/enroll', { data: { label: 'UI test' } })
  const secret = (await en.json()).secret
  expect((await r.post('/api/auth/mfa/enroll-verify', { data: { code: totp(secret, -1) } })).status()).toBe(200)
  await page.goto('/')
}

for (const a of ACCOUNTS) {
  test.describe(a.role, () => {
    test(`${a.role}: sign in, menu matches the role, every screen renders cleanly`, async ({ page }) => {
      const problems: string[] = []
      let cur = 'sign-in'
      page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`))
      page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) problems.push(`console: ${m.text().slice(0, 200)}`) })
      page.on('response', (r) => { if (r.url().includes('/api/') && r.status() >= 400 && r.status() !== 401) problems.push(`HTTP ${r.status()} ${r.request().method()} ${r.url()} (on ${cur})`) })

      await signIn(page, a.email, a.role !== 'EMPLOYEE' && a.role !== 'TEAM_LEAD')
      // getByRole ignores hidden elements, so the (hidden) mobile bottom bar is not matched on desktop
      const item = (l: string) => page.getByRole('button', { name: l, exact: true })
      await expect(item('Dashboard')).toBeVisible({ timeout: 20_000 })

      for (const label of ALL) {
        const visible = await item(label).count()
        expect(visible > 0, `${a.role}: menu item "${label}" ${wanted(a.role).includes(label) ? 'should' : 'should NOT'} be visible`).toBe(wanted(a.role).includes(label))
      }
      for (const label of wanted(a.role)) {
        cur = label
        await item(label).first().click()
        await page.waitForTimeout(900) // views poll, so 'networkidle' never settles
        await expect(page.getByText(/something went wrong|application error|unhandled/i)).toHaveCount(0)
        await page.screenshot({ path: `/tmp/hrms-ui-results/shots/${a.role}-${label.replace(/\W+/g, '_')}.png` })
      }
      expect(problems, problems.join('\n')).toEqual([])
    })
  })
}
