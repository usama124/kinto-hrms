import { test, expect, type Page, type Locator } from '@playwright/test'
import { attendance, balance, dashboard, employee, meta, request, user } from './fixtures'

test.beforeEach(async ({ page }) => {
  page.on('pageerror', error => { throw error })
})

const harness = '/tests/browser/harness/'
const editable = 'input:not([type=file]):not([type=hidden]):not([type=checkbox]):not([type=radio]):visible, textarea:visible'

async function mockApi(page: Page) {
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname
    const responses: Record<string, unknown> = {
      '/api/dashboard': dashboard,
      '/api/auth/me': { user }, '/api/meta': meta,
      '/api/employees/test-employee': { employee, balances: [balance] },
      '/api/attendance': { logs: [attendance], score: 100 },
      '/api/requests': { requests: [request] }, '/api/attendance/requests': { requests: [] },
      '/api/leave-balances': { balances: [balance] },
      '/api/payroll/runs': { runs: [] }, '/api/payroll/payslips': { payslips: [] },
      '/api/notifications': { items: [], unread: 0 },
      '/api/rules': { rules: [{ id: 'rule', key: 'shift.hours', label: 'Shift hours', value: '9', category: 'SHIFT' }], leaveTypes: [balance.leaveType], holidays: [] },
      '/api/org-structure': { departments: [], teams: [], leads: [] }, '/api/shifts': { shifts: [] },
      '/api/settings': { settings: {} }, '/api/audit-logs': { logs: [] },
      '/api/auth/login': { mfaRequired: true, mfaToken: 'test-only', user },
      '/api/auth/mfa/enroll': { secret: 'SYNTHETIC', qrDataUrl: 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=', backupCodes: ['TEST-CODE'] },
      '/api/reports/individual': { employee: { ...employee, roleLabel: 'Employee', department: 'Testing', teamLead: 'Test Lead', manager: 'Test Manager', shiftName: 'Day' }, sections: [], range: {}, attendance: { score: 100, totals: { expected: 540, worked: 540, short: 0, lateDays: 0 }, lateFrequency: [] }, leaves: { ledger: [], history: [] }, payroll: [] },
      '/api/reports/org': { sections: [], range: { from: '2026-11-01', to: '2026-11-16' }, attendanceTrend: [], deptComparison: [], leaveUtilization: [], payrollTrend: [], kpis: { headcount: 1, attendanceRate: 100, shortHours: 0, absentDays: 0 } },
    }
    if (!(path in responses)) throw new Error(`Unmocked API: ${path}`)
    await route.fulfill({ json: responses[path] })
  })
}

async function open(page: Page, view: string) {
  await mockApi(page)
  await page.goto(`${harness}?view=${view}`)
}

// Real key events, not fill(): check every character and retain the original DOM node.
async function typeWithoutBlur(input: Locator, text = 'Focus test') {
  await expect(input).toBeEnabled()
  await input.fill('')
  await input.focus()
  await input.press('ControlOrMeta+A')
  const original = await input.elementHandle()
  for (const char of text) {
    await input.pressSequentially(char)
    await expect(input).toBeFocused()
    expect(await original!.evaluate(el => el.isConnected && el === document.activeElement)).toBe(true)
  }
  await expect(input).toHaveValue(text)
  await input.press('Backspace')
  await expect(input).toBeFocused()
  await expect(input).toHaveValue(text.slice(0, -1))
  await input.pressSequentially(text.slice(-1))
  await expect(input).toHaveValue(text)
  await original!.dispose()
}

async function checkVisibleInputs(page: Page, scope: Locator = page.locator('body')) {
  const inputs = scope.locator(editable)
  expect(await inputs.count()).toBeGreaterThan(0)
  for (let i = 0; i < await inputs.count(); i++) {
    const input = inputs.nth(i)
    if (await input.isDisabled() || await input.getAttribute('readonly') !== null) continue
    const type = await input.getAttribute('type')
    if (['date', 'time', 'month'].includes(type ?? '')) {
      // Native segmented controls do not accept pressSequentially portably.
      const value = type === 'date' ? '2026-11-16' : type === 'time' ? '10:30' : '2026-11'
      await input.fill(value)
      await expect(input).toBeFocused()
      await expect(input).toHaveValue(value)
    } else {
      const numeric = type === 'number' || await input.getAttribute('inputmode') === 'numeric' || await input.getAttribute('maxlength') === '6'
      await typeWithoutBlur(input, numeric ? '123' : (await input.getAttribute('placeholder'))?.startsWith('Code') ? 'FOCUS TEST' : 'Focus test')
    }
  }
}

for (const view of ['employee', 'edit']) {
  test(`${view}: every employee tab retains focus and values`, async ({ page }) => {
    await open(page, view)
    await expect(page.getByRole('tab', { name: 'Personal', exact: true })).toBeVisible()
    // Wait for edit hydration; otherwise delayed prefill can overwrite our input.
    if (view === 'edit') await expect(page.locator('input').first()).toHaveValue(employee.fullName)
    for (const tab of ['Personal', 'Identity', 'Contact', 'Job & Pay']) {
      await page.getByRole('tab', { name: tab, exact: true }).click()
      await checkVisibleInputs(page, page.getByRole('dialog'))
    }
    await page.getByRole('tab', { name: 'Personal', exact: true }).click()
    await expect(page.locator('input').first()).toHaveValue('Focus test')
    await page.locator('input').first().focus()
    await page.keyboard.press('Tab')
    await expect(page.locator('input').nth(1)).toBeFocused()
  })
}

test('login and MFA challenge retain focus', async ({ page }) => {
  await open(page, 'login')
  await checkVisibleInputs(page)
  await page.locator('#email').fill('hr@example.invalid')
  await page.getByRole('button', { name: /Sign in/i }).first().click()
  await expect(page.locator('#code')).toBeVisible()
  await typeWithoutBlur(page.locator('#code'), '123456')
})

test('MFA enrollment retains focus and preserves numeric validation', async ({ page }) => {
  await open(page, 'mfa')
  await page.getByRole('button', { name: 'Begin MFA enrollment' }).click()
  await typeWithoutBlur(page.locator('#mfa-code'), '123456')
  await page.locator('#mfa-code').fill('12ab34')
  await expect(page.locator('#mfa-code')).toHaveValue('1234')
})

test('directory search retains focus while filtering', async ({ page }) => {
  await open(page, 'directory')
  await typeWithoutBlur(page.getByPlaceholder('Search name, code, designation…'))
})

test('policy, organization and security inputs retain focus', async ({ page }) => {
  await open(page, 'rules')
  await expect(page.getByText('Shift hours', { exact: true })).toBeVisible()
  await checkVisibleInputs(page)
  await page.getByRole('tab', { name: 'Org & Shifts' }).click()
  for (const name of ['New Department', 'New Team', 'New Shift']) {
    await page.getByRole('button', { name, exact: true }).click()
    await checkVisibleInputs(page, page.getByRole('dialog'))
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  }
  await page.getByRole('tab', { name: 'Security & MFA' }).click()
  await page.getByRole('button', { name: 'Enroll authenticator' }).click()
  await typeWithoutBlur(page.getByPlaceholder('123456'), '123456')
})

test('payroll salary and adjustment inputs retain focus', async ({ page }) => {
  await open(page, 'payroll')
  await checkVisibleInputs(page)
})

test('attendance correction and regularization retain focus', async ({ page }) => {
  await open(page, 'attendance')
  await expect(page.locator('tbody tr').first()).toBeVisible()
  await page.locator('tbody tr').first().click()
  await checkVisibleInputs(page, page.getByRole('dialog'))
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: /Request.*correction|Request.*regularization/i }).first().click()
  await checkVisibleInputs(page, page.getByRole('dialog'))
})

test('request reason and date inputs retain focus', async ({ page }) => {
  await open(page, 'requests')
  await page.getByRole('button', { name: /Create request/i }).click()
  await expect(page.getByPlaceholder('Why do you need this?')).toBeVisible()
  await checkVisibleInputs(page, page.getByRole('dialog'))
})

test('report date controls retain focus', async ({ page }) => {
  await open(page, 'reports')
  await checkVisibleInputs(page)
  await page.getByRole('tab', { name: 'Individual 360°' }).click()
  await checkVisibleInputs(page)
})


test('dashboard team search retains focus', async ({ page }) => {
  await open(page, 'dashboard')
  await typeWithoutBlur(page.getByRole('textbox', { name: 'Search team members' }))
})

test('command palette search retains focus', async ({ page }) => {
  await open(page, 'shell')
  await page.keyboard.press('ControlOrMeta+k')
  await typeWithoutBlur(page.getByPlaceholder('Search modules and people…'))
})

test('profile quota dialog retains focus', async ({ page }) => {
  await open(page, 'profile')
  await page.getByRole('button', { name: '+ QUOTA', exact: true }).click()
  await checkVisibleInputs(page, page.getByRole('dialog', { name: 'Increment Casual quota' }))
})

for (const action of ['Approve', 'Reject']) {
  test(`request ${action.toLowerCase()} comment retains focus`, async ({ page }) => {
    await open(page, 'requests')
    await page.getByRole('button', { name: action, exact: true }).first().click()
    await typeWithoutBlur(page.getByRole('dialog').locator('textarea'))
  })
}


test('employee edit typing survives unrelated parent renders and caret edits', async ({ page }) => {
  await open(page, 'edit')
  const input = page.locator('input').first()
  await expect(input).toHaveValue(employee.fullName)
  await typeWithoutBlur(input)
  const original = await input.elementHandle()
  await page.evaluate(() => window.dispatchEvent(new Event('test:rerender')))
  await expect(page.locator('[data-revision]')).toHaveAttribute('data-revision', '1')
  await expect(input).toBeFocused()
  expect(await original!.evaluate(el => el.isConnected)).toBe(true)
  await input.press('Home')
  await input.pressSequentially('X')
  await expect(input).toHaveValue('XFocus test')
  await expect(input).toBeFocused()
  await original!.dispose()
})

test('short-leave hours retain focus', async ({ page }) => {
  await open(page, 'requests')
  await page.getByRole('button', { name: /Create request/i }).click()
  await expect(page.getByPlaceholder('Why do you need this?')).toBeVisible()
  await page.getByRole('dialog').getByRole('combobox').first().click()
  await page.getByRole('option', { name: /Short leave/i }).click()
  await typeWithoutBlur(page.getByRole('dialog').locator('input[type=number]'), '12')
})
