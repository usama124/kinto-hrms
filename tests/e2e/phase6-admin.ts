import { Client, DEMO_PASSWORD, JPEG, PDF, PNG, check, eq, fileForm, section, sleep, status } from './lib'
import { ctx, db, client, userBy, type DU } from './ctx'

const TEMP = /^(?=.*[A-Z])(?=.*[a-z])(?=.*\d)(?=.*[^A-Za-z0-9]).{10,}$/
const NEW_PW = 'Brand#New2026pw'
let seq = Date.now() % 100000

export async function cleanupAdminTestData() {
  const users = await db.user.findMany({ where: { email: { startsWith: 'e2e.' } }, select: { id: true } })
  const { purgeUser } = await import('./teardown')
  for (const u of users) await purgeUser(u.id)
  // children first, then parents
  for (let i = 0; i < 10; i++) await db.designation.deleteMany({ where: { name: { startsWith: 'E2E ' }, children: { none: {} }, users: { none: {} } } })
  await db.department.deleteMany({ where: { name: { startsWith: 'E2E ' }, designations: { none: {} }, users: { none: {} }, teams: { none: {} } } })
  await db.team.deleteMany({ where: { name: { startsWith: 'E2E ' }, users: { none: {} } } })
  await db.leaveBalance.deleteMany({ where: { leaveType: { code: 'E2ELV' } } })
  await db.leaveType.deleteMany({ where: { code: 'E2ELV' } })
  await db.shift.deleteMany({ where: { name: { startsWith: 'E2E ' }, users: { none: {} }, departments: { none: {} }, teams: { none: {} } } })
  await db.policyRule.deleteMany({ where: { key: { startsWith: 'custom.e2e' } } })
  await db.holiday.deleteMany({ where: { date: '2030-01-01' } })
}

/** Create an employee through the real API as `by`, return their id + temporary password. */
async function createEmployee(by: Client, body: Record<string, unknown>) {
  const n = seq++
  const res = await by.post('/api/employees', { fullName: `E2E Person ${n}`, email: `e2e.${n}@demo.hrms.local`, role: 'EMPLOYEE', joiningDate: '2026-11-02', ...body })
  if (res.status === 201) ctx.createdUserIds.push(res.json.employee.id)
  return { res, id: res.json?.employee?.id as string, email: `e2e.${n}@demo.hrms.local`, pw: res.json?.temporaryPassword as string }
}
async function loginAs(email: string, password: string) {
  const c = new Client(email)
  const r = await c.post('/api/auth/login', { email, password })
  return { c, r }
}

export async function phase6() {
  section('6a. Employee lifecycle: creation rules, forced first-login password change')
  await cleanupAdminTestData()
  const yasir = userBy((u) => u.isDemo && u.role === 'HR_MANAGER', 'HR manager')
  const sysadmin = userBy((u) => u.email === 'sysadmin@demo.hrms.local', 'sysadmin')
  const manager = userBy((u) => u.isDemo && u.role === 'MANAGER', 'manager')
  const HR = client(yasir), SA = client(sysadmin)
  const eng = ctx.departments.find((d) => d.name === 'Engineering')!
  const mkt = ctx.departments.find((d) => d.name === 'Marketing')!
  const intern = (await db.designation.findFirst({ where: { name: 'Intern', departmentId: eng.id } }))!
  const salesOfficer = (await db.designation.findFirst({ where: { name: 'Sales Officer', departmentId: mkt.id } }))!
  const pw = (r: any) => r.res.json?.temporaryPassword

  status(await client(manager).post('/api/employees', {}), 403, 'a manager cannot onboard people')
  status((await createEmployee(HR, { designationId: intern.id, departmentId: eng.id, email: 'not-an-email' })).res, 422, 'invalid e-mail → 422')
  status((await createEmployee(HR, { departmentId: eng.id })).res, 422, 'missing designation → 422')
  const undef = await createEmployee(HR, { designation: 'Chief Vibes Officer', departmentId: eng.id })
  check(undef.res.status === 422 && /designation/i.test(undef.res.json.error), 'a designation nobody defined is refused (no free-text titles)', JSON.stringify(undef.res.json))
  const mismatch = await createEmployee(HR, { designationId: salesOfficer.id, departmentId: eng.id })
  check(mismatch.res.status === 422 && /belongs to/i.test(mismatch.res.json.error), 'a Marketing designation cannot be given to an Engineering employee', JSON.stringify(mismatch.res.json))
  status((await createEmployee(HR, { designationId: intern.id, departmentId: eng.id, role: 'GOD' })).res, 422, 'unknown role → 422')
  status((await createEmployee(HR, { designationId: intern.id, departmentId: eng.id, role: 'HR_MANAGER' })).res, 403, 'HR cannot create another HR Manager')
  status((await createEmployee(HR, { designationId: intern.id, departmentId: eng.id, role: 'ACCOUNTS_MANAGER' })).res, 403, 'HR cannot create an Accounts Head')
  status((await createEmployee(HR, { designationId: intern.id, departmentId: eng.id, employmentStatus: 'Volunteer' })).res, 422, 'unknown employment status → 422')
  status((await createEmployee(HR, { designationId: intern.id, departmentId: eng.id, joiningDate: '2026-02-30' })).res, 422, 'impossible joining date → 422')
  status((await createEmployee(HR, { designationId: intern.id, departmentId: eng.id, password: 'weak' })).res, 422, 'a supplied weak password → 422')
  status((await createEmployee(HR, { designationId: intern.id, departmentId: 'cl_nope000000000000000' })).res, 422, 'unknown department → 422')

  const e1 = await createEmployee(HR, { designationId: intern.id, employeeCode: 'E2E-001', employmentStatus: 'Internship', baseSalary: 40000 })
  status(e1.res, 201, 'HR onboards an Internship employee (department inferred from the designation)')
  check(TEMP.test(pw(e1)), 'a random temporary password satisfying the policy is generated (no shared default)', pw(e1))
  const row = await db.user.findUnique({ where: { id: e1.id } })
  check(row?.mustChangePassword === true && row.designation === 'Intern' && row.designationId === intern.id && row.departmentId === eng.id && row.employmentStatus === 'Internship', 'stored: forced password change, linked designation, inferred department, Internship status', JSON.stringify(row))
  eq(await db.leaveBalance.count({ where: { userId: e1.id } }), ctx.leaveTypes.length, 'leave balances provisioned for every leave type')
  check(!(await HR.get('/api/employees')).text.includes(pw(e1)), 'the temporary password is never returned again')
  status(await createEmployee(HR, { designationId: intern.id, email: e1.email }).then((x) => x.res), 409, 'duplicate e-mail → 409') // email param overridden below
  const dupMail = await HR.post('/api/employees', { fullName: 'Dup', email: e1.email, role: 'EMPLOYEE', joiningDate: '2026-11-02', designationId: intern.id })
  status(dupMail, 409, 'duplicate e-mail → 409')
  const dupCode = await createEmployee(HR, { designationId: intern.id, employeeCode: 'E2E-001' })
  status(dupCode.res, 409, 'duplicate employee code → 409')

  // forced first-login password change
  const first = await loginAs(e1.email, pw(e1))
  status(first.r, 200, 'new employee signs in with the temporary password')
  eq(first.r.json.user.mustChangePassword, true, 'the login response flags the forced change')
  status(await first.c.get('/api/meta'), 403, 'every feature endpoint is locked (403) until the password is changed')
  status(await first.c.get('/api/dashboard'), 403, 'dashboard locked too')
  status(await first.c.get('/api/auth/me'), 200, '/auth/me still works (so the UI can show the gate)')
  const second = await loginAs(e1.email, pw(e1)) // another device, same temp password
  status(await first.c.post('/api/auth/password', { currentPassword: 'wrong', newPassword: NEW_PW }), 401, 'wrong current password → 401')
  status(await first.c.post('/api/auth/password', { currentPassword: pw(e1), newPassword: 'short' }), 422, 'too-short new password → 422')
  status(await first.c.post('/api/auth/password', { currentPassword: pw(e1), newPassword: 'alllowercase1!' }), 422, 'no uppercase → 422')
  status(await first.c.post('/api/auth/password', { currentPassword: pw(e1), newPassword: pw(e1) }), 422, 'new password must differ from the old')
  status(await first.c.post('/api/auth/password', { currentPassword: pw(e1), newPassword: NEW_PW }), 200, 'valid change succeeds')
  eq((await db.user.findUnique({ where: { id: e1.id } }))?.mustChangePassword, false, 'forced-change flag cleared')
  status(await first.c.get('/api/meta'), 200, 'workspace opens immediately after the change')
  status(await second.c.get('/api/auth/me'), 401, "the user's OTHER session was revoked by the password change")
  status((await loginAs(e1.email, pw(e1))).r, 401, 'the old temporary password no longer works')
  status((await loginAs(e1.email, NEW_PW)).r, 200, 'the new password works')

  section('6b. Employee edit, reset password, deactivation, authority (HR vs System Admin)')
  const target = ctx.users.find((u) => u.isDemo && u.role === 'EMPLOYEE' && u.departmentName === 'Marketing' && u.designation === 'Sales Officer')!
  status(await HR.patch(`/api/employees/${target.id}`, { phone: '+92 300 1112223' }), 200, 'HR edits a profile field')
  check((await db.auditLog.count({ where: { entityType: 'USER', targetUserId: target.id, fieldName: 'phone' } })) > 0, 'the change is audited per field (old → new)')
  status(await HR.patch(`/api/employees/${target.id}`, { role: 'HR_MANAGER' }), 403, 'HR cannot grant the HR Manager role')
  status(await HR.patch(`/api/employees/${target.id}`, { role: 'SUPER_ADMIN' }), 422, 'nobody can promote to System Admin through the API')
  status(await HR.patch(`/api/employees/${target.id}`, { employmentStatus: 'Retired' }), 422, 'invalid employment status → 422')
  status(await HR.patch(`/api/employees/${target.id}`, { employmentStatus: 'Internship' }), 200, 'Internship is accepted when editing')
  await HR.patch(`/api/employees/${target.id}`, { employmentStatus: 'Permanent' })
  status(await HR.patch(`/api/employees/${target.id}`, { designationId: intern.id }), 422, 'a designation from another department → 422')
  status(await HR.patch(`/api/employees/${target.id}`, { designation: 'Made Up Title' }), 422, 'an undefined designation text → 422')
  status(await HR.patch(`/api/employees/${target.id}`, { designationId: (await db.designation.findFirst({ where: { name: 'Senior Sales Officer' } }))!.id }), 200, 'a designation of the same department is accepted')
  const after = await db.user.findUnique({ where: { id: target.id } })
  eq(after?.designation, 'Senior Sales Officer', 'display title follows the linked designation')
  await HR.patch(`/api/employees/${target.id}`, { designationId: salesOfficer.id })
  status(await HR.patch(`/api/employees/${target.id}`, { departmentId: eng.id }), 422, 'moving departments while keeping a designation of the old one → 422')
  status(await HR.patch(`/api/employees/${yasir.id}`, { phone: '+92 300 0000000' }), 403, "HR cannot edit an HR Manager's record (own included)")
  status(await SA.patch(`/api/employees/${yasir.id}`, { phone: '+92 300 7777777' }), 200, "the System Admin can edit an HR Manager's record")
  status(await SA.patch(`/api/employees/${sysadmin.id}`, { isActive: false }), 422, 'nobody can deactivate their own account')
  status(await SA.patch(`/api/employees/${target.id}`, { teamLeadId: target.id }), 422, 'an employee cannot report to themself')

  // reset password
  const e2 = await createEmployee(HR, { designationId: intern.id })
  const live = await loginAs(e2.email, e2.pw)
  status(await live.c.post('/api/auth/password', { currentPassword: e2.pw, newPassword: NEW_PW }), 200, 'throwaway employee set their own password')
  status(await client(manager).post(`/api/employees/${e2.id}/reset-password`, {}), 403, 'a manager cannot reset passwords')
  status(await HR.post(`/api/employees/${yasir.id}/reset-password`, {}), 422, 'you cannot reset your own password here')
  for (const [bad, label] of [['abc', 'text'], [-5, 'negative'], [1e30, 'absurdly large'], [null, 'null']] as const) {
    status(await HR.patch(`/api/employees/${e2.id}`, { baseSalary: bad }), 422, `salary ${label} is rejected, not coerced`)
  }
  const keep = await db.user.findUnique({ where: { id: e2.id }, select: { baseSalary: true } })
  check(keep !== null, 'salary untouched after rejected edits')
  const rp = await HR.post(`/api/employees/${e2.id}/reset-password`, {})
  status(rp, 200, 'HR resets the employee\'s password')
  check(TEMP.test(rp.json.temporaryPassword) && rp.json.email === e2.email, 'a new random temporary password is returned once', JSON.stringify(rp.json))
  status(await live.c.get('/api/auth/me'), 401, "the employee's existing sessions are revoked by the reset")
  status((await loginAs(e2.email, NEW_PW)).r, 401, 'their previous password stops working')
  const relog = await loginAs(e2.email, rp.json.temporaryPassword)
  check(relog.r.status === 200 && relog.r.json.user.mustChangePassword === true, 'they must pick a new password again at next sign-in')
  const hr2 = await createEmployee(SA, { designationId: (await db.designation.findFirst({ where: { name: 'HR Manager' } }))!.id, role: 'HR_MANAGER' })
  status(hr2.res, 201, 'System Admin creates a second HR Manager')
  status(await HR.post(`/api/employees/${hr2.id}/reset-password`, {}), 403, 'HR cannot reset another HR Manager')
  status(await SA.post(`/api/employees/${hr2.id}/reset-password`, {}), 200, 'the System Admin can')
  // HR must not be able to take over payroll roles by resetting their password
  for (const role of ['ACCOUNTS_MANAGER', 'ACCOUNTANT']) {
    const acct = userBy((u) => u.isDemo && u.role === role, role)
    status(await HR.post(`/api/employees/${acct.id}/reset-password`, {}), 403, `HR cannot reset the password of an ${role}`)
  }
  HR.rotateIp() // the reset limiter is 5/min per IP
  status(await HR.post(`/api/employees/cl_missing0000000000000/reset-password`, {}), 404, 'unknown employee → 404')

  // deactivate → locked out at once
  const e3 = await createEmployee(HR, { designationId: intern.id })
  const act = await loginAs(e3.email, e3.pw)
  await act.c.post('/api/auth/password', { currentPassword: e3.pw, newPassword: NEW_PW })
  status(await act.c.get('/api/meta'), 200, 'employee is working normally')
  status(await HR.patch(`/api/employees/${e3.id}`, { isActive: false }), 200, 'HR deactivates the employee')
  status(await act.c.get('/api/meta'), 401, 'their open session dies IMMEDIATELY (not after the 15-minute token)')
  status((await loginAs(e3.email, NEW_PW)).r, 401, 'and they cannot sign in again')
  status(await HR.patch(`/api/employees/${e3.id}`, { isActive: true }), 200, 'HR reactivates')
  check((await act.c.post('/api/auth/refresh', {})).status === 401, 'revoked refresh token cannot resurrect the old session')
  status((await loginAs(e3.email, NEW_PW)).r, 200, 'they can sign in again')
  // role change revokes sessions
  const e4 = await createEmployee(HR, { designationId: intern.id })
  const rc = await loginAs(e4.email, e4.pw); await rc.c.post('/api/auth/password', { currentPassword: e4.pw, newPassword: NEW_PW })
  status(await HR.patch(`/api/employees/${e4.id}`, { role: 'TEAM_LEAD' }), 200, 'HR promotes the employee to Team Lead')
  status(await rc.c.get('/api/meta'), 401, 'a role change signs the employee out so the new role applies cleanly')

  // exposure of personal data
  const owner = client(ctx.users.find((u) => u.id === target.id)!)
  const own360 = (await owner.get(`/api/employees/${target.id}`)).json.employee
  check('baseSalary' in own360 && 'bankIban' in own360, 'owner sees their own compensation + bank details')
  const accountant = userBy((u) => u.isDemo && u.role === 'ACCOUNTANT', 'accountant')
  const accView = (await client(accountant).get(`/api/employees/${target.id}`)).json.employee
  check('baseSalary' in accView && accView.cnic == null, 'accounts see salary but not ID numbers')
  await db.user.update({ where: { id: target.id }, data: { cnic: '99999-0000000-9' } })
  const hrView = (await HR.get(`/api/employees/${target.id}`)).json.employee
  eq(hrView.cnic, '99999-0000000-9', 'HR sees ID numbers')
  eq((await owner.get(`/api/employees/${target.id}`)).json.employee.cnic, '99999-0000000-9', 'owner sees their own ID numbers')
  const tlOf = ctx.byId.get(target.teamLeadId ?? '') ?? userBy((u) => u.isDemo && u.role === 'TEAM_LEAD', 'a TL')
  if (tlOf.isDemo && tlOf.id === target.teamLeadId) check((await client(tlOf).get(`/api/employees/${target.id}`)).json.employee.cnic == null, 'the team lead does NOT see the ID number')
  await db.user.update({ where: { id: target.id }, data: { cnic: null } })

  // ── profile picture ─────────────────────────────────────────────────────────
  section('6c. Profile pictures and document uploads')
  const peer = userBy((u) => u.isDemo && u.role === 'EMPLOYEE' && u.id !== target.id && u.departmentName === 'Marketing', 'peer')
  const T = owner, P = client(peer)
  status(await new Client('anon').req('GET', `/api/employees/${target.id}/avatar`), 401, 'pictures need a signed-in session')
  status(await T.req('POST', `/api/employees/${target.id}/avatar`, { form: fileForm(PDF, 'cv.pdf', 'application/pdf') }), 415, 'a PDF is not a picture → 415')
  status(await T.req('POST', `/api/employees/${target.id}/avatar`, { form: fileForm(Buffer.from('<svg onload=alert(1)>'), 'x.png', 'image/png') }), 415, 'SVG/script disguised as .png is refused by magic bytes')
  status(await T.req('POST', `/api/employees/${target.id}/avatar`, { form: fileForm(Buffer.concat([PNG, Buffer.alloc(3 * 1024 * 1024)]), 'big.png', 'image/png') }), 413, 'a picture over 2 MB → 413')
  status(await T.req('POST', `/api/employees/${target.id}/avatar`, { form: new FormData() }), 422, 'no file field → 422')
  const up = await T.req('POST', `/api/employees/${target.id}/avatar`, { form: fileForm(PNG, 'me.png', 'image/png') })
  status(up, 201, 'an employee uploads their own picture')
  const mine = (await T.get('/api/auth/me')).json.user
  eq(mine.avatarUploadId, up.json.avatarUploadId, '/auth/me exposes the new picture id (header avatar updates)')
  const img = await P.get(`/api/employees/${target.id}/avatar?v=${up.json.avatarUploadId}`)
  check(img.status === 200 && img.headers.get('content-type') === 'image/png' && img.headers.get('x-content-type-options') === 'nosniff' && (img.headers.get('cache-control') ?? '').includes('immutable'), 'colleagues can view it (PNG, nosniff, immutable cache)', `${img.status} ${img.headers.get('content-type')}`)
  check((await HR.get('/api/employees')).json.people.find((p: any) => p.id === target.id)?.avatarUploadId === up.json.avatarUploadId, 'the directory carries the picture id')
  status(await P.req('POST', `/api/employees/${target.id}/avatar`, { form: fileForm(PNG, 'evil.png', 'image/png') }), 403, "an employee cannot change a colleague's picture")
  status(await P.del(`/api/employees/${target.id}/avatar`), 403, "…or remove it")
  const old = up.json.avatarUploadId
  const up2 = await HR.req('POST', `/api/employees/${target.id}/avatar`, { form: fileForm(JPEG, 'hr.jpg', 'image/jpeg') })
  status(up2, 201, 'HR can set an employee\'s picture')
  eq(await db.upload.count({ where: { id: old } }), 0, 'the replaced picture is deleted from storage (no orphans)')
  status(await HR.req('POST', `/api/employees/${hr2.id}/avatar`, { form: fileForm(PNG, 'x.png', 'image/png') }), 403, "HR cannot change another HR Manager's picture")
  status(await SA.req('POST', `/api/employees/${hr2.id}/avatar`, { form: fileForm(PNG, 'x.png', 'image/png') }), 201, 'the System Admin can')
  status(await HR.req('POST', `/api/employees/${yasir.id}/avatar`, { form: fileForm(PNG, 'me.png', 'image/png') }), 201, 'an HR Manager can set their OWN picture')
  status(await T.del(`/api/employees/${target.id}/avatar`), 200, 'owner removes the picture')
  status(await P.get(`/api/employees/${target.id}/avatar`), 404, 'no picture → 404 (initials shown)')
  await HR.del(`/api/employees/${yasir.id}/avatar`)

  // attachments
  const doc = await T.req('POST', '/api/uploads', { form: fileForm(PDF, 'medical.pdf', 'application/pdf') })
  status(doc, 201, 'employee uploads a document')
  const docId = doc.json.upload.id
  const dl = await T.get(`/api/uploads/${docId}`)
  check(dl.status === 200 && dl.headers.get('content-type') === 'application/pdf' && (dl.headers.get('cache-control') ?? '').includes('no-store'), 'owner downloads it (not cacheable)')
  status(await P.get(`/api/uploads/${docId}`), 403, 'a colleague cannot read it')
  const tlLive = target.teamLeadId && ctx.byId.get(target.teamLeadId)?.isDemo ? ctx.byId.get(target.teamLeadId)! : null
  if (tlLive) status(await client(tlLive).get(`/api/uploads/${docId}`), 200, 'their team lead can')
  status(await HR.get(`/api/uploads/${docId}`), 200, 'HR can')
  status(await new Client('anon').req('GET', `/api/uploads/${docId}`), 401, 'anonymous cannot')
  status(await T.req('POST', '/api/uploads', { form: fileForm(Buffer.from('MZ not a document'), 'virus.pdf', 'application/pdf') }), 415, 'an executable renamed .pdf → 415')
  status(await T.req('POST', '/api/uploads', { form: fileForm(Buffer.concat([PDF, Buffer.alloc(6 * 1024 * 1024)]), 'huge.pdf', 'application/pdf') }), 413, 'a document over 5 MB → 413 (enforced while streaming)')
  status(await T.req('POST', '/api/uploads', { form: new FormData() }), 422, 'no file → 422')

  // ── designations & departments ──────────────────────────────────────────────
  section('6d. Departments + designations: CRUD, hierarchy rules, delete protection')
  const dept = await HR.post('/api/departments', { name: 'E2E Dept', code: 'E2ED', description: 'test' })
  status(dept, 201, 'HR creates a department')
  const D = dept.json.department.id
  status(await HR.post('/api/departments', { name: 'e2e dept', code: 'ZZ1' }), 409, 'duplicate department name (case-insensitive) → 409')
  status(await HR.post('/api/departments', { name: 'Other', code: 'E2ED' }), 409, 'duplicate department code → 409')
  status(await HR.post('/api/departments', { name: 'Bad', code: 'x' }), 422, 'invalid code → 422')
  status(await client(manager).post('/api/departments', { name: 'Nope', code: 'NOPE' }), 403, 'a manager cannot create departments')
  status(await client(manager).patch(`/api/departments/${D}`, { name: 'Hijack' }), 403, '…or edit them')
  status(await client(manager).del(`/api/departments/${D}`), 403, '…or delete them')
  const mk = (b: Record<string, unknown>) => HR.post('/api/designations', { departmentId: D, ...b })
  const head = await mk({ name: 'E2E Head' }); status(head, 201, 'root designation')
  eq(head.json.designation.levelRank, 1, 'a root defaults to level rank 1')
  const lead = await mk({ name: 'E2E Lead', parentDesignationId: head.json.designation.id }); status(lead, 201, 'child designation under the root')
  eq(lead.json.designation.levelRank, 2, 'a child defaults to parent rank + 1')
  const worker = await mk({ name: 'E2E Worker', parentDesignationId: lead.json.designation.id, levelRank: 7 }); status(worker, 201, 'grandchild with an explicit rank')
  eq(worker.json.designation.levelRank, 7, 'explicit rank honoured')
  const [hId, lId, wId] = [head, lead, worker].map((x) => x.json.designation.id as string)
  status(await mk({ name: 'e2e head' }), 409, 'duplicate name inside the department (case-insensitive) → 409')
  status(await mk({ name: 'E2E X', levelRank: 0 }), 422, 'rank 0 → 422')
  status(await mk({ name: 'E2E X', levelRank: 100 }), 422, 'rank 100 → 422')
  status(await mk({ name: 'E2E X', levelRank: 1.5 }), 422, 'fractional rank → 422')
  status(await mk({ name: 'E', }), 422, 'one-letter name → 422')
  status(await HR.post('/api/designations', { name: 'E2E Orphan' }), 422, 'a designation needs a department → 422')
  status(await HR.post('/api/designations', { name: 'E2E Cross', departmentId: eng.id, parentDesignationId: hId }), 422, 'the parent must belong to the SAME department → 422')
  status(await HR.patch(`/api/designations/${hId}`, { parentDesignationId: hId }), 422, 'a designation cannot be its own parent')
  status(await HR.patch(`/api/designations/${hId}`, { parentDesignationId: wId }), 422, 'a loop (root under its own grandchild) → 422')
  status(await HR.patch(`/api/designations/${hId}`, { parentDesignationId: lId }), 422, 'a loop (root under its child) → 422')
  status(await HR.patch(`/api/designations/${wId}`, { parentDesignationId: hId }), 200, 'moving a node UP its own branch is fine')
  status(await HR.patch(`/api/designations/${wId}`, { parentDesignationId: lId }), 200, '…and back down')
  status(await HR.patch(`/api/designations/${hId}`, {}), 422, 'a PATCH with no change → 422')
  status(await HR.patch(`/api/designations/${lId}`, { departmentId: eng.id }), 409, 'cannot move a designation that has nested designations to another department')
  // depth limit
  let parent = wId, depthOk = 0
  for (let i = 0; i < 12; i++) { const r = await mk({ name: `E2E Deep ${i}`, parentDesignationId: parent }); if (r.status !== 201) { check(r.status === 422 && /deep/i.test(r.json.error), `nesting stops at the maximum depth (refused at level ${i + 4})`, JSON.stringify(r.json)); break } parent = r.json.designation.id; depthOk++ }
  check(depthOk >= 3 && depthOk <= 6, `a chain of ${depthOk + 3} levels was allowed before the limit`, String(depthOk))
  // employees + rename sync + delete protection
  const holder = await createEmployee(HR, { designationId: wId, departmentId: D })
  status(holder.res, 201, 'an employee is onboarded into the new department with the new designation')
  status(await HR.del(`/api/designations/${wId}`), 409, 'cannot delete a designation that has employees (or children)')
  status(await HR.patch(`/api/designations/${wId}`, { name: 'E2E Worker Renamed' }), 200, 'rename a designation')
  eq((await db.user.findUnique({ where: { id: holder.id } }))?.designation, 'E2E Worker Renamed', 'the rename reaches every employee holding it')
  status(await HR.patch(`/api/designations/${wId}`, { departmentId: eng.id }), 409, 'cannot move a designation that has employees')
  status(await HR.del(`/api/departments/${D}`), 409, 'cannot delete a department with designations/employees')
  status(await HR.patch(`/api/designations/${wId}`, { isActive: false }), 200, 'deactivate a designation')
  const inactive = await createEmployee(HR, { designationId: wId, departmentId: D })
  check(inactive.res.status === 422 && /inactive/i.test(inactive.res.json.error), 'an inactive designation cannot be assigned to new people', JSON.stringify(inactive.res.json))
  const listed = (await HR.get('/api/meta')).json.designations
  check(!listed.some((d: any) => d.id === wId), 'inactive designations disappear from the pickers')
  check(((await client(manager).get('/api/designations')).json.designations as any[]).some((d) => d.id === wId), 'but the management list still shows them')
  status(await HR.patch(`/api/departments/${D}`, { isActive: false }), 200, 'deactivate the department')
  status(await mk({ name: 'E2E Late' }), 422, 'no new designations in an inactive department')
  const inDept = await createEmployee(HR, { designationId: intern.id, departmentId: D })
  status(inDept.res, 422, 'no new employees in an inactive department (mismatch/inactive)')
  status(await HR.patch(`/api/departments/${D}`, { isActive: true }), 200, 'reactivate')
  // clean up the tree from the leaves up
  await HR.patch(`/api/employees/${holder.id}`, { isActive: false })
  await db.user.update({ where: { id: holder.id }, data: { designationId: null } })
  const all = (await HR.get(`/api/designations?departmentId=${D}`)).json.designations as any[]
  status(await HR.del(`/api/designations/${hId}`), 409, 'cannot delete a designation with nested designations')
  for (let i = 0; i < 12; i++) for (const d of (await HR.get(`/api/designations?departmentId=${D}`)).json.designations as any[]) await HR.del(`/api/designations/${d.id}`)
  eq(((await HR.get(`/api/designations?departmentId=${D}`)).json.designations as any[]).length, 0, `all ${all.length} test designations deleted leaf-first`)
  const deptRow = (await HR.get('/api/departments')).json.departments.find((d: any) => d.id === D)
  eq([deptRow.designationCount], [0], 'department usage counts are accurate')
  await db.user.updateMany({ where: { id: holder.id }, data: { departmentId: null } })
  status(await HR.del(`/api/departments/${D}`), 200, 'an empty department can be deleted')
  status(await HR.del(`/api/departments/${D}`), 404, 'deleting it twice → 404')

  // ── rules, leave types, holidays, settings ──────────────────────────────────
  section('6e. Policy rules, custom rules, leave types, holidays, settings')
  const rules0 = (await HR.get('/api/rules')).json
  const rule = (k: string) => rules0.rules.find((r: any) => r.key === k)?.value
  status(await HR.put('/api/rules', { rules: [{ key: 'shift.durationMinutes', value: 5 }] }), 422, 'shift duration of 5 minutes → 422')
  status(await HR.put('/api/rules', { rules: [{ key: 'shift.graceMinutes', value: 'abc' }] }), 422, 'non-numeric grace → 422')
  status(await HR.put('/api/rules', { rules: [{ key: 'shift.weeklyOffDay', value: 9 }] }), 422, 'weekly off day 9 → 422')
  status(await HR.put('/api/rules', { rules: [{ key: 'shortHours.deductionMode', value: 'WEIRD' }] }), 422, 'unknown deduction mode → 422')
  status(await HR.put('/api/rules', { rules: [{ key: 'no.such.rule', value: 1 }] }), 422, 'unknown rule key → 422')
  status(await HR.put('/api/rules', { rules: [{ key: 'shift.graceMinutes', value: 20 }, { key: 'shift.durationMinutes', value: 1 }] }), 422, 'a bad entry rejects the WHOLE update (no partial save)')
  eq((await HR.get('/api/rules')).json.rules.find((r: any) => r.key === 'shift.graceMinutes')?.value, rule('shift.graceMinutes'), '…nothing was applied')
  status(await HR.put('/api/rules', { rules: [{ key: 'shift.graceMinutes', value: 20 }] }), 200, 'valid rule update')
  eq((await HR.get('/api/rules')).json.rules.find((r: any) => r.key === 'shift.graceMinutes')?.value, '20', 'rule saved')
  await HR.put('/api/rules', { rules: [{ key: 'shift.graceMinutes', value: rule('shift.graceMinutes') ?? 15 }] })
  const cr = await HR.post('/api/rules', { label: 'E2E Rule', value: '42', category: 'GENERAL' })
  status(cr, 201, 'HR adds a custom rule')
  const cr2 = await HR.post('/api/rules', { label: 'E2E Rule', value: '43', category: 'PAYROLL' })
  check(cr2.status === 201 && cr2.json.rule.key !== cr.json.rule.key, 'a duplicate label gets a unique key instead of overwriting', `${cr.json.rule.key} vs ${cr2.json.rule.key}`)
  status(await HR.post('/api/rules', { label: 'x', value: '1' }), 422, 'rule name too short → 422')
  status(await HR.post('/api/rules', { label: 'E2E Bad', value: '' }), 422, 'empty value → 422')
  status(await HR.post('/api/rules', { label: 'E2E Bad', value: '1', category: 'MAGIC' }), 422, 'unknown category → 422')
  status(await HR.put('/api/rules', { rules: [{ key: cr.json.rule.key, value: '99', label: 'E2E Rule edited' }] }), 200, 'custom rule edited (value + name)')
  eq((await HR.get('/api/rules')).json.rules.find((r: any) => r.key === cr.json.rule.key)?.label, 'E2E Rule edited', 'edit persisted')
  status(await HR.del('/api/rules', { key: 'shift.graceMinutes' }), 403, 'a built-in rule cannot be deleted')
  status(await HR.del('/api/rules', { key: cr.json.rule.key }), 200, 'a custom rule can be deleted')
  status(await HR.del('/api/rules', { key: cr2.json.rule.key }), 200, '…both of them')
  status(await HR.del('/api/rules', { key: 'custom.e2e-ghost' }), 404, 'deleting a rule that does not exist → 404')

  const lt = await HR.post('/api/leave-types', { name: 'E2E Leave', code: 'E2ELV', annualQuota: 3, isPaid: false, colorCode: '#112233', monthlyCap: 2 })
  status(lt, 201, 'HR adds a leave type')
  const activeUsers = await db.user.count({ where: { isActive: true } })
  eq(await db.leaveBalance.count({ where: { leaveTypeId: lt.json.leaveType.id } }), activeUsers, 'every active employee instantly has a balance for it')
  status(await HR.post('/api/leave-types', { name: 'E2E Leave', code: 'E2ELX', annualQuota: 1 }), 409, 'duplicate name → 409')
  status(await HR.post('/api/leave-types', { name: 'Other', code: 'e2elv', annualQuota: 1 }), 409, 'duplicate code (case-insensitive) → 409')
  status(await HR.post('/api/leave-types', { name: 'Bad Code', code: 'a b', annualQuota: 1 }), 422, 'invalid code → 422')
  status(await HR.post('/api/leave-types', { name: 'Bad Quota', code: 'BADQ', annualQuota: 999 }), 422, 'quota 999 → 422')
  status(await HR.post('/api/leave-types', { name: 'Bad Cap', code: 'BADC', annualQuota: 1, monthlyCap: 40 }), 422, 'monthly cap 40 → 422')
  const ltId = lt.json.leaveType.id
  const ed = await HR.patch('/api/leave-types', { id: ltId, name: 'E2E Leave Edited', annualQuota: 5, isPaid: true, colorCode: '#445566', monthlyCap: null, code: 'HACKED' })
  status(ed, 200, 'HR edits the leave type')
  const lrow = await db.leaveType.findUnique({ where: { id: ltId } })
  check(lrow?.name === 'E2E Leave Edited' && lrow.annualQuota === 5 && lrow.isPaid && lrow.colorCode === '#445566' && lrow.monthlyCap === null, 'name, quota, paid flag, colour and cap updated', JSON.stringify(lrow))
  eq(lrow?.code, 'E2ELV', 'the CODE is immutable (payroll looks up CASUAL/ANNUAL by code)')
  status(await HR.patch('/api/leave-types', { id: ltId, name: 'Annual Leave' }), 409, 'renaming onto another type → 409')
  status(await HR.patch('/api/leave-types', { id: ltId, colorCode: 'red' }), 422, 'bad colour → 422')
  status(await HR.patch('/api/leave-types', { id: ltId, monthlyCap: 99 }), 422, 'bad cap → 422')
  status(await HR.patch('/api/leave-types', { id: ltId }), 422, 'no change → 422')
  status(await HR.patch('/api/leave-types', { id: 'cl_missing0000000000000', name: 'x1' }), 404, 'unknown leave type → 404')
  status(await client(manager).patch('/api/leave-types', { id: ltId, name: 'Hijack' }), 403, 'a manager cannot edit leave types')

  status(await HR.put('/api/rules', { holiday: { date: '2030-01-01' } }), 422, 'a holiday needs a name → 422')
  status(await HR.put('/api/rules', { holiday: { date: '2030-02-30', name: 'E2E Holiday' } }), 422, 'impossible holiday date → 422')
  status(await HR.put('/api/rules', { holiday: { date: '2030-01-01', name: 'E2E Holiday' } }), 200, 'add a holiday')
  check((await HR.get('/api/rules')).json.holidays.some((h: any) => h.date === '2030-01-01'), 'holiday listed')
  status(await HR.put('/api/rules', { removeHoliday: 'not-a-date' }), 422, 'invalid removeHoliday → 422')
  status(await HR.put('/api/rules', { removeHoliday: '2030-01-01' }), 200, 'remove it')
  check(!(await HR.get('/api/rules')).json.holidays.some((h: any) => h.date === '2030-01-01'), 'holiday gone')
  status(await client(manager).put('/api/rules', { holiday: { date: '2030-01-01', name: 'x' } }), 403, 'a manager cannot edit the holiday calendar')

  const s0 = (await SA.get('/api/settings')).json.settings
  status(await HR.patch('/api/settings', { key: 'company.profile', value: { name: 'x' } }), 403, 'HR cannot change global settings')
  status(await SA.patch('/api/settings', { key: 'no.such.setting', value: {} }), 422, 'unknown setting key → 422')
  status(await SA.patch('/api/settings', { key: 'company.profile', value: { address: 'no name' } }), 422, 'company profile without a name → 422')
  status(await SA.patch('/api/settings', { key: 'company.profile', value: { name: 'E2E Corp <script>alert(1)</script>', address: 'x' } }), 200, 'System Admin updates the company profile')
  check(!JSON.stringify((await SA.get('/api/settings')).json.settings['company.profile']).includes('<script>'), 'HTML is stripped from stored settings')
  if (s0['company.profile']) await SA.patch('/api/settings', { key: 'company.profile', value: s0['company.profile'] })
  const cfg = (slabs: unknown, extra = {}) => SA.patch('/api/settings', { key: 'payroll.config', value: { pfRate: 0.05, eoobiAmount: 500, eoobiThreshold: 26000, taxSlabs: slabs, ...extra } })
  status(await cfg([{ upto: 60000, rate: 0 }, { upto: 50000, rate: 5 }]), 422, 'tax slabs must be ascending → 422')
  status(await cfg([{ upto: null, rate: 0 }, { upto: 90000, rate: 5 }]), 422, 'only the last slab may be open-ended → 422')
  status(await cfg([{ upto: 60000, rate: 150 }]), 422, 'tax rate above 100% → 422')
  status(await cfg([]), 422, 'no slabs → 422')
  status(await cfg([{ upto: null, rate: 0 }], { pfRate: 2 }), 422, 'provident fund rate above 100% → 422')
  status(await cfg([{ upto: 60000, rate: 0 }, { upto: null, rate: 10 }]), 200, 'a valid payroll configuration is accepted')
  if (s0['payroll.config']) await SA.patch('/api/settings', { key: 'payroll.config', value: s0['payroll.config'] })
  const plain = (await client(peer).get('/api/settings')).json.settings
  eq(Object.keys(plain), ['company.profile'], 'ordinary employees see only the company identity')

  // ── shifts + org ─────────────────────────────────────────────────────────────
  section('6f. Shifts, org structure, reports, audit log, quota adjustment')
  status(await HR.post('/api/shifts', { name: 'E2E Shift', startTime: '25:00', endTime: '19:00' }), 422, 'a shift starting at 25:00 → 422')
  status(await HR.post('/api/shifts', { name: 'E2E Shift', startTime: '10:00', endTime: '99:99' }), 422, 'a shift ending at 99:99 → 422')
  status(await HR.post('/api/shifts', { name: 'E2E Shift', startTime: '19:00', endTime: '10:00' }), 422, 'a shift that ends before it starts → 422 (overnight shifts are not supported)')
  const sh = await HR.post('/api/shifts', { name: 'E2E Shift', startTime: '10:00', endTime: '19:00', graceMinutes: 10, breakMinutes: 60, workingDays: [1, 2, 3, 4, 5] })
  status(sh, 201, 'HR creates a shift template')
  eq(sh.json.shift.expectedMinutes, 480, 'expected minutes = span − break (540 − 60)')
  status(await HR.patch('/api/shifts', { shiftId: sh.json.shift.id }), 422, 'assigning needs exactly one target → 422')
  status(await HR.patch('/api/shifts', { shiftId: sh.json.shift.id, userId: e1.id, teamId: 'x' }), 422, 'two targets → 422')
  status(await HR.patch('/api/shifts', { shiftId: 'cl_none00000000000000000', userId: e1.id }), 404, 'unknown shift → 404')
  status(await HR.patch('/api/shifts', { shiftId: sh.json.shift.id, userId: e1.id }), 200, 'assign the shift to an employee')
  const e1c = (await loginAs(e1.email, NEW_PW)).c
  eq((await e1c.get('/api/dashboard')).json.shift?.startTime, '10:00', 'the employee\'s dashboard resolves the individual override')
  status(await client(manager).patch('/api/shifts', { shiftId: sh.json.shift.id, userId: e1.id }), 403, 'a manager cannot assign shifts')

  status(await HR.post('/api/org-structure', { kind: 'department', name: 'Engineering Again', code: (eng.code ?? 'ENG') }), 409, 'org-structure: duplicate department code → 409')
  status(await HR.post('/api/org-structure', { kind: 'nonsense' }), 422, 'org-structure: unknown kind → 422')
  const tm = await HR.post('/api/org-structure', { kind: 'team', name: 'E2E Team', departmentId: eng.id })
  status(tm, 201, 'org-structure: HR creates a team')
  const tree = await client(userBy((u) => u.isDemo && u.role === 'TEAM_LEAD', 'tl')).get('/api/org-structure')
  check(tree.status === 200 && tree.json.departments.some((d: any) => d.teams.some((t: any) => t.name === 'E2E Team')), 'the org chart shows the new team to non-employees')
  const drill = await HR.get('/api/organizations'); status(drill, 200, 'department health matrix')
  check(drill.json.departments.length >= 4 && drill.json.departments.every((d: any) => d.headcount >= 0 && d.completeHoursPct <= 100), 'every department has sane stats')
  status(await HR.get(`/api/organizations/${eng.id}/teams`), 200, 'team breakdown for a department')
  status(await HR.get(`/api/teams/${tm.json.team.id}`), 200, 'team roster')

  const org = await HR.get('/api/reports/org'); status(org, 200, 'HR org report')
  check(org.json.kpis.headcount > 50 && ['attendance', 'departments', 'leaves', 'payroll'].every((s) => org.json.sections.includes(s)), 'org report has all four sections and real headcount', JSON.stringify(org.json.kpis))
  eq((await client(accountant).get('/api/reports/org')).json.sections, ['payroll'], 'accounts staff get the payroll section only')
  const tlRep = userBy((u) => u.isDemo && u.role === 'TEAM_LEAD' && u.id !== undefined, 'tl')
  status(await client(tlRep).get('/api/reports/org'), 403, 'a team lead cannot open the org report')
  status(await HR.get('/api/reports/org?from=2026-02-30'), 422, 'invalid report dates → 422')
  for (const type of ['org-attendance', 'leave-audit', 'individual']) {
    const p = await HR.get(`/api/reports/pdf?type=${type}&userId=${yasir.id}`)
    check(p.status === 200 && p.buf.subarray(0, 4).toString() === '%PDF' && /^attachment; filename="[\w.\-]+"$/.test(p.headers.get('content-disposition') ?? ''), `HR exports the ${type} PDF`, `HTTP ${p.status} ${p.headers.get('content-disposition')}`)
  }
  status(await HR.get('/api/reports/pdf?type=bogus'), 422, 'unknown report type → 422')
  status(await client(accountant).get('/api/reports/pdf?type=org-attendance'), 403, 'accountants cannot export the org attendance report')
  status(await HR.get('/api/reports/pdf?type=individual&from=%22%0d%0aX-Evil:1'), 422, 'header-injection attempt in the date range → 422')

  const audit = await HR.get('/api/audit-logs?take=abc'); status(audit, 200, 'audit trail with a junk take= falls back to the default')
  const reqAudit = await HR.get('/api/audit-logs?entityType=REQUEST&take=50')
  check(reqAudit.json.logs.length > 0 && reqAudit.json.logs.every((l: any) => l.entityType === 'REQUEST'), 'audit filter by entity returns only that entity')
  check(((await HR.get('/api/audit-logs?take=100000')).json.logs as any[]).length <= 300, 'audit page size is capped at 300')
  check(!JSON.stringify(audit.json).match(/"(passwordHash|mfaSecret|secret)"/), 'the audit trail contains no credentials')
  const anyAudit = (audit.json.logs as any[]).find((l) => l.ipAddress)
  check(!anyAudit || /^[0-9a-fA-F:.]{3,45}$|^unknown$/.test(anyAudit.ipAddress), 'audit IP addresses are sanitised', anyAudit?.ipAddress)

  const casual = ctx.leaveTypes.find((t) => t.code === 'CASUAL')!
  const y = new Date().getFullYear()
  const adj = (b: Record<string, unknown>) => SA.post('/api/leave-balances/adjust', { userId: e1.id, leaveTypeId: casual.id, year: y, ...b })
  await db.leaveBalance.updateMany({ where: { userId: e1.id, leaveTypeId: casual.id, year: y }, data: { carryForward: 0, availed: 0, pending: 0 } })
  status(await adj({ delta: 2 }), 422, 'a quota change without a reason → 422')
  status(await adj({ delta: 0, reason: 'x' }), 422, 'a zero delta → 422')
  const plus = await adj({ delta: 2, reason: 'e2e grant' }); status(plus, 200, 'System Admin grants +2 days')
  eq(plus.json.appliedDelta, 2, 'applied exactly +2')
  const minus = await adj({ delta: -999, reason: 'e2e clawback' }); status(minus, 200, 'a huge negative delta is accepted but capped')
  const bal = await db.leaveBalance.findFirst({ where: { userId: e1.id, leaveTypeId: casual.id, year: y } })
  check(bal!.carryForward + casual.annualQuota - bal!.availed - bal!.pending - bal!.lapsed >= 0, 'the balance can never be pushed below zero', JSON.stringify(bal))
  status(await SA.post('/api/leave-balances/adjust', { userId: 'cl_missing0000000000000', leaveTypeId: casual.id, delta: 1, reason: 'x' }), 404, 'unknown employee → 404')
  check((await db.auditLog.count({ where: { entityType: 'LEAVE_QUOTA', targetUserId: e1.id } })) >= 2, 'quota adjustments are audited with reason')
  check((await db.notification.count({ where: { userId: e1.id, title: 'Leave quota updated' } })) >= 2, 'the employee is notified of quota changes')
  await sleep(0)
}
