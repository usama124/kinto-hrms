import { createHmac } from 'crypto'
import { Client, DEMO_PASSWORD, check, eq, section, sleep, status, totp } from './lib'
import { ctx, db, client, userBy, type DU } from './ctx'

const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url')
const NEWPW = 'Secure#Pass2026x'
let n = (Date.now() + 7) % 100000

async function throwaway(role: string, designation: string, by: Client, extra: Record<string, unknown> = {}) {
  const id = n++
  const d = await db.designation.findFirst({ where: { name: designation } })
  const res = await by.post('/api/employees', { fullName: `E2E Sec ${id}`, email: `e2e.sec${id}@demo.hrms.local`, role, designationId: d!.id, joiningDate: '2026-11-02', ...extra })
  if (res.status !== 201) throw new Error(`could not create throwaway ${role}: ${JSON.stringify(res.json)}`)
  ctx.createdUserIds.push(res.json.employee.id)
  const email = `e2e.sec${id}@demo.hrms.local`
  const c = new Client(email)
  const l = await c.post('/api/auth/login', { email, password: res.json.temporaryPassword })
  if (l.status !== 200) throw new Error(`throwaway login failed: ${JSON.stringify(l.json)}`)
  const ch = await c.post('/api/auth/password', { currentPassword: res.json.temporaryPassword, newPassword: NEWPW })
  if (ch.status !== 200) throw new Error(`throwaway password change failed: ${JSON.stringify(ch.json)}`)
  return { id: res.json.employee.id as string, email, c }
}

export async function phase7() {
  const yasir = userBy((u) => u.isDemo && u.role === 'HR_MANAGER', 'HR manager')
  const HR = client(yasir)

  section('7a. MFA: multiple authenticators, replay protection, backup codes, lockout')
  // a dedicated demo manager that phase 1 enrolled (its secret is known to the harness)
  const mgr = ctx.users.filter((u) => u.isDemo && u.role === 'MANAGER' && ctx.totpSecret.has(u.email)).at(-1)!
  const sec1 = ctx.totpSecret.get(mgr.email)!
  const backup = ctx.backupCodes.get(mgr.email)!
  const fresh = () => new Client(mgr.email)
  let c = fresh()
  let l = await c.post('/api/auth/login', { email: mgr.email, password: DEMO_PASSWORD })
  check(l.status === 200 && l.json.mfaRequired === true && !!l.json.mfaToken, 'an enrolled account gets an MFA challenge, not a session', JSON.stringify(l.json))
  status(await c.get('/api/meta'), 401, 'before the 2nd factor there is no session at all')
  const stage = l.json.mfaToken as string
  c.jar.set('hrms_at', stage)
  status(await c.get('/api/auth/me'), 401, 'the MFA stage token is not accepted as a session cookie')
  c.jar.clear()
  status(await c.post('/api/auth/mfa', { code: '123456' }), 422, 'MFA without a token → 422')
  status(await c.post('/api/auth/mfa', { mfaToken: 'garbage', code: '123456' }), 401, 'a garbage MFA token → 401')
  status(await c.post('/api/auth/mfa', { mfaToken: stage, code: '000000' }), 401, 'a wrong code → 401')
  const good = await c.post('/api/auth/mfa', { mfaToken: stage, code: totp(sec1, 0) })
  status(good, 200, 'the correct authenticator code completes sign-in')
  status(await c.get('/api/meta'), 200, 'a real session now exists')
  const c2 = fresh(); const l2 = await c2.post('/api/auth/login', { email: mgr.email, password: DEMO_PASSWORD })
  status(await c2.post('/api/auth/mfa', { mfaToken: l2.json.mfaToken, code: totp(sec1, 0) }), 401, 'the SAME code cannot be used twice (replay protection)')
  const c3 = fresh(); const l3 = await c3.post('/api/auth/login', { email: mgr.email, password: DEMO_PASSWORD })
  status(await c3.post('/api/auth/mfa', { mfaToken: l3.json.mfaToken, code: totp(sec1, 1) }), 200, 'the next time-step code is accepted')
  // backup codes: single use
  const bc = fresh(); const lb = await bc.post('/api/auth/login', { email: mgr.email, password: DEMO_PASSWORD })
  status(await bc.post('/api/auth/mfa', { mfaToken: lb.json.mfaToken, code: backup[0], isBackupCode: true }), 200, 'a backup recovery code signs in')
  const bc2 = fresh(); const lb2 = await bc2.post('/api/auth/login', { email: mgr.email, password: DEMO_PASSWORD })
  status(await bc2.post('/api/auth/mfa', { mfaToken: lb2.json.mfaToken, code: backup[0], isBackupCode: true }), 401, 'the same backup code is dead after one use')
  const dev0 = await bc.get('/api/auth/mfa/devices')
  eq([dev0.json.mfaEnabled, dev0.json.backupCodesRemaining, dev0.json.authenticators.length], [true, 7, 1], 'the authenticator list shows 1 device and 7 backup codes left')
  check(!JSON.stringify(dev0.json).includes(sec1), 'the secret is never returned by the device list')
  check(dev0.json.authenticators[0].label === 'E2E authenticator' && !!dev0.json.authenticators[0].lastUsedAt, 'label and last-used time are tracked', JSON.stringify(dev0.json.authenticators[0]))

  // a second authenticator
  const S = bc // a signed-in session of this manager
  status(await S.post('/api/auth/mfa/enroll', { label: 'Microsoft Authenticator · phone 2' }), 401, 'adding an authenticator needs the account password')
  status(await S.post('/api/auth/mfa/enroll', { label: 'x', password: 'wrong' }), 401, '…and the right one')
  const en2 = await S.post('/api/auth/mfa/enroll', { label: 'Microsoft Authenticator · phone 2', password: DEMO_PASSWORD })
  status(en2, 200, 'second authenticator enrolment starts')
  eq(en2.json.backupCodes, [], 'no new backup codes are issued for an additional authenticator')
  const sec2 = en2.json.secret as string
  const cx = fresh(); const lx = await cx.post('/api/auth/login', { email: mgr.email, password: DEMO_PASSWORD })
  status(await cx.post('/api/auth/mfa', { mfaToken: lx.json.mfaToken, code: totp(sec2, 0) }), 401, 'an UNCONFIRMED authenticator cannot be used to sign in')
  status(await S.post('/api/auth/mfa/enroll-verify', { id: en2.json.id, code: '000000' }), 422, 'confirming with a wrong code → 422')
  status(await S.post('/api/auth/mfa/enroll-verify', { id: en2.json.id, code: totp(sec2, -1) }), 200, 'confirming with a live code activates it')
  const dev1 = await S.get('/api/auth/mfa/devices')
  eq(dev1.json.authenticators.map((a: any) => a.label).sort(), ['E2E authenticator', 'Microsoft Authenticator · phone 2'], 'both authenticators are listed by their labels')
  const cy = fresh(); const ly = await cy.post('/api/auth/login', { email: mgr.email, password: DEMO_PASSWORD })
  status(await cy.post('/api/auth/mfa', { mfaToken: ly.json.mfaToken, code: totp(sec2, 0) }), 200, 'the second authenticator now signs in')
  // remove the first
  const firstId = dev1.json.authenticators.find((a: any) => a.label === 'E2E authenticator').id
  status(await S.del('/api/auth/mfa/devices', { id: firstId, password: 'wrong', code: totp(sec2, 1) }), 401, 'removal needs the right password')
  status(await S.del('/api/auth/mfa/devices', { id: firstId, password: DEMO_PASSWORD, code: '000000' }), 401, '…and a valid code (proof of possession)')
  status(await S.del('/api/auth/mfa/devices', { id: firstId, password: DEMO_PASSWORD, code: totp(sec2, 1) }), 200, 'removing one authenticator works with password + code')
  const cz = fresh(); const lz = await cz.post('/api/auth/login', { email: mgr.email, password: DEMO_PASSWORD })
  status(await cz.post('/api/auth/mfa', { mfaToken: lz.json.mfaToken, code: totp(sec1, 1) }), 401, 'the removed authenticator no longer works')
  const lastId = (await S.get('/api/auth/mfa/devices')).json.authenticators[0].id
  status(await S.del('/api/auth/mfa/devices', { id: lastId, password: DEMO_PASSWORD, code: totp(sec2, 1) }), 409, 'the LAST authenticator cannot be removed')
  status(await S.del('/api/auth/mfa/devices', { id: 'nope', password: DEMO_PASSWORD, code: totp(sec2, 1) }), 404, 'unknown authenticator id → 404')
  status(await S.post('/api/auth/mfa/disable', { password: DEMO_PASSWORD, code: totp(sec2, 1) }), 403, 'MFA cannot be turned off for a role that requires it')
  // authenticator limit
  let added = 0
  for (let i = 0; i < 6; i++) {
    const e = await S.post('/api/auth/mfa/enroll', { label: `extra ${i}`, password: DEMO_PASSWORD })
    if (e.status !== 200) { check(e.status === 409, `no more than 5 authenticators (refused after ${added + 1})`, JSON.stringify(e.json)); break }
    const v = await S.post('/api/auth/mfa/enroll-verify', { id: e.json.id, code: totp(e.json.secret, -1) }); if (v.status !== 200) { check(false, 'extra authenticator verify', JSON.stringify(v.json)); break }
    added++
  }
  eq(added, 4, 'exactly 4 more fit (5 total)')

  // optional role: enrol, then switch MFA off again
  const opt = await throwaway('EMPLOYEE', 'Intern', HR)
  check((await opt.c.get('/api/auth/mfa/devices')).json.mfaRequired === false, 'MFA is optional for a plain employee')
  const eo = await opt.c.post('/api/auth/mfa/enroll', { label: 'Authy' }); status(eo, 200, 'an employee may enrol voluntarily')
  status(await opt.c.post('/api/auth/mfa/enroll-verify', { code: totp(eo.json.secret, -1) }), 200, '…and confirm')
  status(await opt.c.post('/api/auth/mfa/disable', { password: 'wrong', code: totp(eo.json.secret, 0) }), 401, 'turning it off needs the password')
  status(await opt.c.post('/api/auth/mfa/disable', { password: NEWPW, code: totp(eo.json.secret, 1) }), 200, 'an optional-role employee can turn MFA off')
  status(await opt.c.get('/api/meta'), 401, 'disabling MFA signs the user out everywhere')
  status((await new Client('x').post('/api/auth/login', { email: opt.email, password: NEWPW })), 200, '…and they sign in normally afterwards')

  // MFA lockout
  const mgrT = await throwaway('MANAGER', 'Engineering Manager', HR)
  const em = await mgrT.c.post('/api/auth/mfa/enroll', {}); status(em, 200, 'throwaway manager starts MFA enrolment (gate)')
  status(await mgrT.c.post('/api/auth/mfa/enroll-verify', { code: totp(em.json.secret, -1) }), 200, 'throwaway manager enrolled')
  const lk = new Client('lock'); const ll = await lk.post('/api/auth/login', { email: mgrT.email, password: NEWPW })
  for (let i = 0; i < 5; i++) { lk.rotateIp(); await lk.post('/api/auth/mfa', { mfaToken: ll.json.mfaToken, code: '000000' }) }
  lk.rotateIp()
  const locked = await lk.post('/api/auth/mfa', { mfaToken: ll.json.mfaToken, code: totp(em.json.secret, 0) })
  status(locked, 423, 'after 5 wrong codes the account is locked — even the right code is refused')
  const locked2 = await new Client('lock2').post('/api/auth/login', { email: mgrT.email, password: NEWPW })
  status(locked2, 401, 'a locked account also refuses the password step (generic message)')
  const gen = await new Client('lock3').post('/api/auth/login', { email: 'nobody.at.all@demo.hrms.local', password: 'Wrong@12345pw' })
  eq(locked2.json.error, gen.json.error, 'the locked-account answer is identical to an unknown account (no enumeration)')

  section('7b. Sessions, tokens and attack-style requests')
  // unauthenticated access to everything
  const anon = new Client('anon')
  const gets = ['/api/auth/me', '/api/meta', '/api/dashboard', '/api/employees', '/api/requests', '/api/attendance', '/api/attendance/requests', '/api/payroll/runs', '/api/payroll/payslips', '/api/rules', '/api/audit-logs', '/api/settings', '/api/designations', '/api/departments', '/api/notifications', '/api/reports/org', '/api/biometric/devices', '/api/org-structure', '/api/leave-balances', '/api/shifts', '/api/organizations', '/api/auth/mfa/devices']
  for (const p of gets) status(await anon.get(p), 401, `anonymous GET ${p} → 401`)
  for (const p of ['/api/requests', '/api/attendance/punch', '/api/employees', '/api/departments', '/api/designations', '/api/payroll/runs']) status(await anon.post(p, {}), 401, `anonymous POST ${p} → 401`)

  // forged / tampered tokens
  const live = userBy((u) => u.isDemo && u.role === 'EMPLOYEE', 'employee')
  const lc = client(live)
  const real = lc.jar.get('hrms_at')!
  const [h, p, sig] = real.split('.')
  const bad = new Client('bad')
  for (const [name, tok] of [
    ['garbage', 'not.a.jwt'],
    ['tampered signature', `${h}.${p}.${sig.slice(0, -2)}AA`],
    ['tampered payload (role=SUPER_ADMIN)', `${h}.${b64u(JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url').toString()), role: 'SUPER_ADMIN' }))}.${sig}`],
    ['alg=none', `${b64u(JSON.stringify({ alg: 'none', typ: 'JWT' }))}.${p}.`],
    ['signed with a guessed secret', (() => { const hd = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' })); const pl = b64u(JSON.stringify({ userId: live.id, role: 'SUPER_ADMIN', email: live.email, fullName: 'x', exp: Math.floor(Date.now() / 1000) + 3600 })); return `${hd}.${pl}.${createHmac('sha256', 'novatech-hrms-dev-secret-9f2b7c').update(`${hd}.${pl}`).digest('base64url')}` })()],
  ] as const) { bad.jar.set('hrms_at', tok); status(await bad.get('/api/auth/me'), 401, `forged token rejected: ${name}`) }
  bad.jar.clear()
  const viaQuery = await bad.get(`/api/auth/me?hrms_at=${real}`)
  status(viaQuery, 401, 'a token in the query string is not a credential')
  const viaHeader = await bad.get('/api/auth/me', { headers: { Authorization: `Bearer ${real}` } })
  status(viaHeader, 401, 'a Bearer header is not a credential either (cookie only)')

  // logout revokes the access token immediately
  const t1 = await throwaway('EMPLOYEE', 'Intern', HR)
  const cookieBefore = [...t1.c.jar].map(([k, v]) => `${k}=${v}`).join('; ')
  status(await t1.c.get('/api/meta'), 200, 'throwaway session works')
  status(await t1.c.post('/api/auth/logout', {}), 200, 'logout')
  const replay = await new Client('replay').get('/api/meta', { headers: { Cookie: cookieBefore } })
  status(replay, 401, 'the old access cookie is dead right after logout (not valid for 15 more minutes)')
  status(await new Client('replay2').post('/api/auth/refresh', {}, { headers: { Cookie: cookieBefore } }), 401, 'the old refresh token is revoked too')

  // refresh rotation + theft detection
  const t2 = await throwaway('EMPLOYEE', 'Intern', HR)
  const oldRt = t2.c.jar.get('hrms_rt')!
  const r1 = await t2.c.post('/api/auth/refresh', {}); status(r1, 200, 'refresh rotates the tokens')
  check(t2.c.jar.get('hrms_rt') !== oldRt, 'a NEW refresh token is issued on every use')
  status(await t2.c.get('/api/meta'), 200, 'the rotated session works')
  const stolen = new Client('thief')
  const race = await stolen.post('/api/auth/refresh', {}, { headers: { Cookie: `hrms_rt=${oldRt}` } })
  status(race, 409, 'replaying the old token within the 10 s grace window is treated as a race (409), not theft')
  status(await t2.c.get('/api/meta'), 200, '…and does NOT log the real user out')
  await sleep(10_500)
  const theft = await stolen.post('/api/auth/refresh', {}, { headers: { Cookie: `hrms_rt=${oldRt}` } })
  status(theft, 401, 'replaying a rotated token after the grace window → 401 (token theft)')
  status(await t2.c.get('/api/meta'), 401, 'theft detection revoked the whole token family: the victim session is dead too')
  status(await new Client('r3').post('/api/auth/refresh', {}), 401, 'refresh without a cookie → 401')
  status(await new Client('r4').post('/api/auth/refresh', { refreshToken: 'x'.repeat(64) }), 401, 'refresh with a made-up token → 401')
  const t3 = await throwaway('EMPLOYEE', 'Intern', HR)
  const [a, b] = await Promise.all([t3.c.post('/api/auth/refresh', {}), new Client('twin').post('/api/auth/refresh', {}, { headers: { Cookie: `hrms_rt=${t3.c.jar.get('hrms_rt')}` } })])
  check([a.status, b.status].filter((s) => s === 200).length <= 1 && [a.status, b.status].every((s) => [200, 409].includes(s)), 'two simultaneous refreshes with one token → at most one succeeds', `${a.status}/${b.status}`)

  // password lockout + unlock by HR
  const t4 = await throwaway('EMPLOYEE', 'Intern', HR)
  const lc4 = new Client('lock4')
  const msgs = new Set<string>()
  for (let i = 0; i < 5; i++) { lc4.rotateIp(); const r = await lc4.post('/api/auth/login', { email: t4.email, password: 'Wrong@123456' }); msgs.add(`${r.status}:${r.json?.error}`) }
  eq(msgs.size, 1, 'every failure — including the locking attempt — returns the same message')
  lc4.rotateIp()
  const afterLock = await lc4.post('/api/auth/login', { email: t4.email, password: NEWPW })
  status(afterLock, 401, 'the CORRECT password is refused while locked')
  check((await db.user.findUnique({ where: { id: t4.id } }))!.lockedUntil! > new Date(), 'a lock-out timestamp is stored')
  const rs = await HR.post(`/api/employees/${t4.id}/reset-password`, {}); status(rs, 200, 'HR reset clears the lock')
  lc4.rotateIp(); status(await lc4.post('/api/auth/login', { email: t4.email, password: rs.json.temporaryPassword }), 200, 'the employee can sign in with the new temporary password')

  // rate limiting (own IP so nothing else is affected)
  const rl = new Client('ratelimit'); rl.rotate = false
  const codes: number[] = []
  for (let i = 0; i < 7; i++) codes.push((await rl.post('/api/auth/login', { email: 'ghost@demo.hrms.local', password: 'Wrong@123456' })).status)
  check(codes.slice(0, 5).every((s) => s === 401) && codes.slice(5).every((s) => s === 429), 'login is throttled per IP: 5 attempts then 429', codes.join(','))
  const rg = new Client('global'); rg.rotate = false; const gc: number[] = []
  for (let i = 0; i < 110; i++) gc.push((await rg.get('/api/auth/me')).status)
  check(gc.slice(0, 100).every((s) => s === 401) && gc.slice(100).some((s) => s === 429), 'the global API throttle (100/min per IP) kicks in', `first429 at ${gc.indexOf(429)}`)

  // CSRF
  const csrf = (extra: Record<string, string>, origin?: string | null) => lc.req('POST', '/api/requests', { json: {}, headers: extra, origin })
  status(await csrf({}, 'http://evil.example'), 403, 'CSRF: a cross-origin POST is blocked (Origin check)')
  status(await csrf({ 'Sec-Fetch-Site': 'cross-site' }), 403, 'CSRF: Sec-Fetch-Site=cross-site is blocked')
  check((await csrf({}, null)).status !== 403, 'a non-browser client (no Origin) is not blocked', 'blocked')
  check((await csrf({ 'Sec-Fetch-Site': 'same-origin' })).status !== 403, 'same-origin POST goes through the guard')
  status(await lc.req('PATCH', '/api/employees/x', { json: {}, origin: 'http://evil.example' }), 403, 'CSRF guard covers PATCH')
  status(await lc.req('DELETE', '/api/payroll/runs/x', { json: {}, origin: 'http://evil.example' }), 403, '…and DELETE')

  // headers + cookie flags
  const login = await new Client('hdr').post('/api/auth/login', { email: live.email, password: DEMO_PASSWORD })
  const raw = (login.headers as any).getSetCookie() as string[]
  const at = raw.find((c) => c.startsWith('hrms_at='))!, rt = raw.find((c) => c.startsWith('hrms_rt='))!
  for (const [name, ck] of [['access', at], ['refresh', rt]] as const) check(/HttpOnly/i.test(ck) && /SameSite=Lax/i.test(ck) && /Secure/i.test(ck) && /Path=\//i.test(ck), `${name} cookie: HttpOnly + Secure + SameSite=Lax`, ck.replace(/=[^;]+/, '=…'))
  const page = await new Client('page').get('/'), api = await lc.get('/api/auth/me')
  for (const [nm, r] of [['page', page], ['api', api]] as const) {
    const hd = r.headers
    check(hd.get('x-content-type-options') === 'nosniff' && hd.get('x-frame-options') === 'DENY' && /frame-ancestors 'none'/.test(hd.get('content-security-policy') ?? '') && !!hd.get('strict-transport-security') && !!hd.get('referrer-policy') && !!hd.get('permissions-policy'), `${nm}: security headers present`, [...hd.keys()].join(','))
    check(!/unsafe-eval/.test(hd.get('content-security-policy') ?? ''), `${nm}: CSP has no unsafe-eval in production`)
    check(!hd.get('x-powered-by'), `${nm}: X-Powered-By is not advertised`)
  }
  eq(api.headers.get('cache-control'), 'no-store', 'API responses are never cacheable')

  // hostile input
  const inj = new Client('inj'); inj.rotate = true
  for (const e of ["' OR '1'='1", "admin@demo.hrms.local'; DROP TABLE \"User\";--", '{"$ne":null}', '<script>alert(1)</script>', 'a'.repeat(5000)]) {
    inj.rotateIp(); const r = await inj.post('/api/auth/login', { email: e, password: "' OR '1'='1" })
    check(r.status === 401 || r.status === 422, `login with hostile e-mail never errors (${e.slice(0, 24)}…)`, `HTTP ${r.status}`)
  }
  inj.rotateIp(); const arr = await inj.post('/api/auth/login', { email: ['a@b.c'], password: { $gt: '' } }); check([401, 422].includes(arr.status), 'JSON arrays/objects as credentials are refused cleanly', `HTTP ${arr.status}`)
  inj.rotateIp(); const mal = await inj.req('POST', '/api/auth/login', { raw: '{"email": ', headers: { 'Content-Type': 'application/json' } }); check([400, 422].includes(mal.status), 'malformed JSON → 4xx, not 500', `HTTP ${mal.status}`)
  const big = await lc.req('POST', '/api/requests', { raw: 'x'.repeat(9 * 1024 * 1024), headers: { 'Content-Type': 'text/plain' } }); status(big, 413, 'a 9 MB body is refused at the edge (413)')
  const xss = await lc.post('/api/requests', { type: 'OFFICIAL_DUTY', reason: '<script>alert(1)</script><img src=x onerror=alert(2)>ok', startDate: '2027-07-05', endDate: '2027-07-05' })
  check(xss.status === 201 && !/[<>]/.test(xss.json.request.reason), 'HTML/script in free text is stripped on the way in', xss.json?.request?.reason)
  const mass = await lc.post('/api/requests', { type: 'OFFICIAL_DUTY', reason: 'mass assignment', startDate: '2027-07-06', endDate: '2027-07-06', status: 'APPROVED', currentStage: 'DONE', dayCount: 0.01, id: 'attacker-chosen', createdAt: '2000-01-01' })
  check(mass.status === 201 && mass.json.request.status.startsWith('PENDING') && mass.json.request.dayCount === 1 && mass.json.request.id !== 'attacker-chosen', 'mass assignment: status/stage/dayCount/id from the client are ignored', JSON.stringify(mass.json?.request))
  const trav = await lc.get('/api/uploads/..%2F..%2F..%2Fetc%2Fpasswd'); check(trav.status === 404 && !trav.text.includes('root:'), 'path traversal through the upload id finds nothing', `HTTP ${trav.status}`)
  const sneakyRole = await lc.patch(`/api/employees/${live.id}`, { role: 'SUPER_ADMIN' }); status(sneakyRole, 403, 'an employee cannot promote themself')
  status(await lc.post('/api/biometric/sync', { punches: [{ pin: live.employeeCode, timestamp: new Date().toISOString() }] }), 401, 'the biometric batch endpoint refuses a plain user session')

  section('7c. Dashboard numbers agree with the database')
  const tl = userBy((u) => u.isDemo && u.role === 'TEAM_LEAD' && ctx.users.some((x) => x.teamLeadId === u.id), 'team lead with reports')
  const directs = ctx.users.filter((x) => x.teamLeadId === tl.id).map((x) => x.id)
  const wantPending = (await db.request.count({ where: { status: 'PENDING_TEAM_LEAD', userId: { in: [tl.id, ...directs] } } })) + (await db.attendanceRequest.count({ where: { status: 'PENDING_TEAM_LEAD', userId: { in: [tl.id, ...directs] } } }))
  const d = (await client(tl).get('/api/dashboard')).json
  eq(d.pendingApprovals, wantPending, `${tl.fullName}'s pending-approval badge equals the database`)
  eq(d.teamOverview.length, directs.length, "the team-overview roster lists exactly the lead's direct reports")
  const emp = userBy((u) => u.isDemo && u.role === 'EMPLOYEE' && u.departmentName === 'Engineering' && !!u.teamLeadId && ctx.byId.get(u.teamLeadId)!.isDemo, 'engineer')
  const ed = (await client(emp).get('/api/dashboard')).json
  check(ed.kind === 'personal' && ed.kpis.shifts > 0 && ed.kpis.attendanceScore >= 0 && ed.kpis.attendanceScore <= 100 && ed.leaveSummary.length === await db.leaveType.count(), 'employee dashboard: KPIs, score within 0–100, a balance per leave type', JSON.stringify(ed.kpis))
  check(!!ed.supervisors.teamLead && !!ed.supervisors.manager && ed.canPunch === true && ed.canCreateRequest === true, 'employee sees their team lead + manager and may punch / file')
  const od = (await HR.get('/api/dashboard')).json
  check(od.kind === 'org' && od.departments.length === 4 && od.orgStats.headcount > 50, 'HR dashboard: org matrix with all 4 departments', JSON.stringify(od.orgStats))
  const accD = (await client(userBy((u) => u.isDemo && u.role === 'ACCOUNTANT', 'acc')).get('/api/dashboard')).json
  eq(accD.canCreateRequest, false, 'accounts staff are not offered "create request"')
  const sd = (await client(userBy((u) => u.email === 'sysadmin@demo.hrms.local', 'sa')).get('/api/dashboard')).json
  eq(sd.kind, 'org', 'System Admin gets the org dashboard')
}
