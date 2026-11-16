import reset from './reset-mfa'
import { test, expect, type Page } from '@playwright/test'

test.beforeAll(() => reset()) // each spec starts with un-enrolled demo accounts
const PW = process.env.DUMMY_PASSWORD ?? 'Demo@12345'
let ipSeq = 10 + Math.floor(Math.random() * 100)
async function login(page: Page, email: string, password = PW) {
  await page.context().setExtraHTTPHeaders({ 'x-real-ip': `10.88.${ipSeq++ % 250}.${Math.floor(Math.random() * 250) + 1}` })
  await page.goto('/')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Sign in' }).click()
}
const go = (page: Page, label: string) => page.getByRole('button', { name: label, exact: true }).first().click()

test('wrong password shows an error and stays on the login form', async ({ page }) => {
  await login(page, 'adeel.chaudhry@demo.hrms.local', 'Not-the-password-1')
  await expect(page.getByText(/invalid|incorrect|wrong/i).first()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible()
})

test('sign out returns to the login form and the session is really gone', async ({ page }) => {
  await login(page, 'adeel.chaudhry@demo.hrms.local')
  await expect(page.getByRole('button', { name: 'Dashboard', exact: true })).toBeVisible({ timeout: 20_000 })
  await page.getByRole('button', { name: 'Profile menu' }).click()
  await page.getByText('Sign out').click()
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible()
  expect((await page.request.get('/api/auth/me')).status()).toBe(401)
  await page.reload()
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible()
})

test('employee files a leave in the UI and the team lead sees it in the approval queue', async ({ page, browser }) => {
  const reason = `UI test leave ${Date.now()}`
  await login(page, 'adeel.chaudhry@demo.hrms.local')
  await go(page, 'Requests')
  await page.getByRole('button', { name: 'Create Request' }).click()
  const dlg = page.getByRole('dialog')
  await expect(dlg.getByText('Create Request')).toBeVisible()
  await expect(dlg.getByText('Loading policy metadata')).toHaveCount(0, { timeout: 15_000 })
  const dates = dlg.locator('input[type=date]')
  await dates.nth(0).fill('2027-09-14')
  await dates.nth(1).fill('2027-09-14')
  await dlg.locator('textarea, input[placeholder*="eason" i]').first().fill(reason)
  await dlg.getByRole('button', { name: 'Submit Request' }).click()
  await expect(page.getByText(reason).first()).toBeVisible({ timeout: 15_000 })
  // the period must show the day that was typed (a Karachi-midnight timestamp must not render as the day before)
  await expect(page.getByRole('row').filter({ hasText: reason }).getByText('14 Sept')).toBeVisible()

  // the employee's own supervisor (Team Lead waqas.mirza) sees it
  const ctx2 = await browser.newContext()
  const p2 = await ctx2.newPage()
  await login(p2, 'waqas.mirza@demo.hrms.local')
  await go(p2, 'Requests')
  await expect(p2.getByText(reason).first()).toBeVisible({ timeout: 20_000 })
  await ctx2.close()
})

test('System Admin: every Rules & Settings tab renders without errors', async ({ page }) => {
  const errs: string[] = []
  page.on('pageerror', (e) => errs.push(e.message))
  page.on('response', (r) => { if (r.url().includes('/api/') && r.status() >= 400 && r.status() !== 401) errs.push(`HTTP ${r.status()} ${r.url()}`) })
  await page.context().setExtraHTTPHeaders({ 'x-real-ip': `10.89.${ipSeq++ % 250}.5` })
  // MFA role: enrol over the API, then drive the UI
  const { createHmac } = await import('crypto')
  const b32 = (s: string) => { const a = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = ''; for (const c of s.toUpperCase()) bits += a.indexOf(c).toString(2).padStart(5, '0'); const o: number[] = []; for (let i = 0; i + 8 <= bits.length; i += 8) o.push(parseInt(bits.slice(i, i + 8), 2)); return Buffer.from(o) }
  const code = (secret: string) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000) - 1)); const h = createHmac('sha1', b32(secret)).update(b).digest(); const o = h[h.length - 1] & 15; return String((((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1e6).padStart(6, '0') }
  await page.request.post('/api/auth/login', { data: { email: 'sysadmin@demo.hrms.local', password: PW } })
  const en = await (await page.request.post('/api/auth/mfa/enroll', { data: { label: 'ui' } })).json()
  await page.request.post('/api/auth/mfa/enroll-verify', { data: { code: code(en.secret) } })
  await page.goto('/')
  await go(page, 'Rules & Settings')
  for (const tab of ['Policy Rules', 'Org & Shifts', 'Designations', 'Security & MFA', 'Audit Logs']) {
    await page.getByRole('tab', { name: tab }).click()
    await page.waitForTimeout(900)
    await expect(page.getByText(/something went wrong|application error/i)).toHaveCount(0)
    await page.screenshot({ path: `/tmp/hrms-ui-results/shots/ADMIN-rules-${tab.replace(/\W+/g, '_')}.png` })
  }
  expect(errs, errs.join('\n')).toEqual([])
})

test('payroll: "Run Payroll" card is offered to Accounts only, not to HR', async ({ page, browser }) => {
  // HR sees payroll read-only → no Run Payroll button (HR is MFA role: enrol via API first)
  const { createHmac } = await import('crypto')
  const b32 = (s: string) => { const a = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = ''; for (const c of s.toUpperCase()) bits += a.indexOf(c).toString(2).padStart(5, '0'); const o: number[] = []; for (let i = 0; i + 8 <= bits.length; i += 8) o.push(parseInt(bits.slice(i, i + 8), 2)); return Buffer.from(o) }
  const code = (secret: string) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000) - 1)); const h = createHmac('sha1', b32(secret)).update(b).digest(); const o = h[h.length - 1] & 15; return String((((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1e6).padStart(6, '0') }
  async function mfaLogin(p: Page, email: string) {
    await p.context().setExtraHTTPHeaders({ 'x-real-ip': `10.90.${ipSeq++ % 250}.7` })
    await p.request.post('/api/auth/login', { data: { email, password: PW } })
    const en = await (await p.request.post('/api/auth/mfa/enroll', { data: { label: 'ui' } })).json()
    await p.request.post('/api/auth/mfa/enroll-verify', { data: { code: code(en.secret) } })
    await p.goto('/')
  }
  await mfaLogin(page, 'yasir.hussain@demo.hrms.local')
  await go(page, 'Payroll')
  await expect(page.getByText('Payroll', { exact: false }).first()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Run Payroll' })).toHaveCount(0)
  const c2 = await browser.newContext(); const p2 = await c2.newPage()
  await mfaLogin(p2, 'bushra.rehman@demo.hrms.local')
  await go(p2, 'Payroll')
  await expect(p2.getByRole('button', { name: 'Run Payroll' })).toBeVisible({ timeout: 15_000 })
  await c2.close()
})
