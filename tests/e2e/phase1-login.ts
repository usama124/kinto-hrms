import { Client, DEMO_PASSWORD, check, eq, section, status, totp } from './lib'
import { MFA_ROLES, ctx, demoUsers, pool } from './ctx'

/** Phase 1 — every demo account signs in with its credentials; elevated roles are gated until TOTP is enrolled. */
export async function phase1() {
  section('1. Sign-in as every demo account (credentials, MFA gate, enrolment)')
  const users = demoUsers()
  const MIN = Number(process.env.E2E_MIN_ACCOUNTS ?? 90) // a fresh database (e.g. Turso) has fewer demo people
  check(users.length >= MIN, `${users.length} demo accounts found (expected ≥ ${MIN})`)

  await pool(users, 8, async (u) => {
    const c = new Client(u.email)
    const r = await c.post('/api/auth/login', { email: u.email, password: DEMO_PASSWORD })
    if (!check(r.status === 200, `login ${u.email} (${u.role})`, `HTTP ${r.status} ${JSON.stringify(r.json)}`)) return
    const mfaRole = MFA_ROLES.includes(u.role)
    if (r.json.mfaRequired) { check(false, `${u.email}: unexpected MFA challenge before enrolment`); return }
    check(r.json.user?.role === u.role && r.json.user?.mfaRequired === mfaRole, `${u.email}: login DTO has role ${u.role} and mfaRequired=${mfaRole}`, JSON.stringify(r.json.user))
    check(r.json.user?.mustChangePassword === false, `${u.email}: no forced password change for demo accounts`)

    if (mfaRole) {
      // server-side gate: a session exists, but every feature endpoint refuses until TOTP is enrolled
      const gated = await c.get('/api/meta')
      check(gated.status === 403, `${u.email}: feature endpoints are 403 until MFA is enrolled`, `HTTP ${gated.status}`)
      const me = await c.get('/api/auth/me')
      check(me.status === 200 && me.json.user.mfaEnabled === false, `${u.email}: /auth/me still works while enrolment is pending`)
      const en = await c.post('/api/auth/mfa/enroll', { label: 'E2E authenticator' })
      if (!check(en.status === 200 && !!en.json.secret && en.json.backupCodes?.length === 8, `${u.email}: enrol returns secret + 8 backup codes`, JSON.stringify(en.json))) return
      ctx.totpSecret.set(u.email, en.json.secret)
      ctx.backupCodes.set(u.email, en.json.backupCodes)
      ctx.enrolled.add(u.id)
      const bad = await c.post('/api/auth/mfa/enroll-verify', { code: '000000' })
      check(bad.status === 422, `${u.email}: wrong enrolment code rejected`, `HTTP ${bad.status}`)
      let ok = await c.post('/api/auth/mfa/enroll-verify', { code: totp(en.json.secret, -1) })
      // offset -1 sits on the edge of the server's ±1 window: if the 30 s step rolled over mid-request, recompute once
      if (ok.status === 422) ok = await c.post('/api/auth/mfa/enroll-verify', { code: totp(en.json.secret, -1) })
      if (!check(ok.status === 200, `${u.email}: enrolment confirmed with a live code`, JSON.stringify(ok.json))) return
    }

    const meta = await c.get('/api/meta')
    check(meta.status === 200 && meta.json.people?.length > 0, `${u.email}: workspace usable (meta 200)`, `HTTP ${meta.status}`)
    const me = await c.get('/api/auth/me')
    check(me.status === 200 && me.json.user.email === u.email && me.json.user.role === u.role && me.json.user.designation === u.designation, `${u.email}: /auth/me matches the stored role + designation`)
    ctx.clients.set(u.email, c)
  })

  // wrong credentials: same answer for unknown account and wrong password (no enumeration)
  const c = new Client('anon')
  const wrong = await c.post('/api/auth/login', { email: users[0].email, password: 'Wrong@12345' })
  const unknown = await c.post('/api/auth/login', { email: 'nobody@demo.hrms.local', password: 'Wrong@12345' })
  status(wrong, 401, 'wrong password → 401')
  eq([wrong.status, wrong.json?.error], [unknown.status, unknown.json?.error], 'unknown e-mail and wrong password are indistinguishable')
  check(ctx.clients.size === users.length, `${ctx.clients.size}/${users.length} accounts signed in`)
}
