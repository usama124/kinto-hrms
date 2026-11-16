import { PDF, addDays, check, eq, fileForm, section, status } from './lib'
import { ctx, db, client, userBy, resetLeaveData, type DU } from './ctx'

const YEAR = 2027 // all leave tests live in 2027 so they never touch the current year's balances
let slot = 0
/** Two working days (Tue–Wed), a fresh week per call, none on a holiday. */
const dates = () => { const s = addDays('2027-01-05', 7 * slot++); return { startDate: s, endDate: addDays(s, 1) } }
const lt = (code: string) => ctx.leaveTypes.find((t) => t.code === code)!
const bal = async (userId: string, code: string) => db.leaveBalance.findUnique({ where: { userId_leaveTypeId_year: { userId, leaveTypeId: lt(code).id, year: YEAR } } })

async function file(u: DU, extra: Record<string, unknown> = {}, code = 'ANNUAL') {
  return client(u).post('/api/requests', { type: 'LEAVE', leaveTypeId: lt(code).id, reason: 'E2E test leave', ...dates(), ...extra })
}
const act = (u: DU, id: string, action: 'approve' | 'reject', comment = 'e2e') => client(u).post(`/api/requests/${id}/${action}`, { comment })
const dbReq = (id: string) => db.request.findUnique({ where: { id }, include: { approvals: true } })

export async function phase3() {
  section('3. Leave & request workflows (chain, rejection, authority, validation, races)')
  const wiped = await resetLeaveData({ startDate: { gte: new Date('2026-12-31T00:00:00Z') } }) // all leave tests live in 2027 → safe to reset
  await db.leaveBalance.deleteMany({ where: { year: YEAR, user: { email: { endsWith: '@demo.hrms.local' } } } })
  console.log(`   reset ${wiped} request(s) from a previous run`)
  const yasir = userBy((u) => u.isDemo && u.role === 'HR_MANAGER', 'demo HR manager')
  const sysadmin = userBy((u) => u.email === 'sysadmin@demo.hrms.local', 'demo sysadmin')
  const accountant = userBy((u) => u.isDemo && u.role === 'ACCOUNTANT', 'demo accountant')
  const find = (dept: string, pred: (u: DU) => boolean, what: string) => userBy((u) => u.isDemo && u.departmentName === dept && pred(u), what)

  // ── full chain per department that has a demo TL + demo manager ──────────────
  for (const dept of ['Engineering', 'Marketing']) {
    const emp = find(dept, (u) => u.role === 'EMPLOYEE' && /intern/i.test(u.designation) && !!u.teamLeadId && !!u.managerId, `${dept} intern`)
    const tl = ctx.byId.get(emp.teamLeadId!)!, mgr = ctx.byId.get(emp.managerId!)!
    check(tl.isDemo && mgr.isDemo, `${dept}: ${emp.fullName}'s team lead + manager are demo accounts`, `${tl.email} / ${mgr.email}`)

    const before = await bal(emp.id, 'ANNUAL')
    const r = await file(emp)
    status(r, 201, `${dept} intern files ANNUAL leave`)
    const id: string = r.json.request.id
    eq([r.json.request.status, r.json.request.currentStage, r.json.request.dayCount], ['PENDING_TEAM_LEAD', 'TEAM_LEAD', 2], `${dept}: routed to team lead, 2 days`)
    const pend = await bal(emp.id, 'ANNUAL')
    eq(pend!.pending - (before?.pending ?? 0), 2, `${dept}: 2 days reserved as pending`)

    // wrong people cannot act
    const strangerTl = userBy((u) => u.isDemo && u.role === 'TEAM_LEAD' && u.id !== tl.id, 'another TL')
    status(await act(strangerTl, id, 'approve'), 403, `${dept}: unrelated team lead cannot approve`)
    status(await act(mgr, id, 'approve'), 403, `${dept}: manager cannot approve at the team-lead stage`)
    status(await act(emp, id, 'approve'), 403, `${dept}: employee cannot approve own request`)
    status(await act(accountant, id, 'approve'), 403, `${dept}: accountant cannot approve`)
    status(await act(emp, id, 'reject'), 403, `${dept}: employee cannot reject own request`)

    // chain
    let a = await act(tl, id, 'approve'); status(a, 200, `${dept}: team lead approves`)
    eq(a.json?.stage, 'PENDING_MANAGER', `${dept}: advances to manager`)
    status(await act(tl, id, 'approve'), 403, `${dept}: team lead cannot approve twice`)
    a = await act(mgr, id, 'approve'); status(a, 200, `${dept}: manager approves`)
    eq(a.json?.stage, 'PENDING_HR', `${dept}: advances to HR`)
    a = await act(yasir, id, 'approve'); status(a, 200, `${dept}: HR manager approves (final)`)
    const done = await dbReq(id)
    eq([done!.status, done!.currentStage, done!.approvals.length], ['APPROVED', 'DONE', 3], `${dept}: APPROVED with 3 approval records`)
    const after = await bal(emp.id, 'ANNUAL')
    eq([after!.pending - (before?.pending ?? 0), after!.availed - (before?.availed ?? 0)], [0, 2], `${dept}: pending released, 2 days availed`)
    check((await db.notification.count({ where: { userId: emp.id, title: 'Request approved' } })) > 0, `${dept}: employee notified of approval`)
    check((await db.auditLog.count({ where: { entityType: 'REQUEST', entityId: id } })) >= 3, `${dept}: every step is in the audit log`)
    status(await act(yasir, id, 'approve'), 403, `${dept}: finished request cannot be re-approved`)

    // visibility: TL + manager + employee see it, a stranger does not
    const ids = (r: any) => new Set<string>((r.json?.requests ?? []).map((x: any) => x.id))
    check(ids(await client(emp).get('/api/requests')).has(id), `${dept}: employee sees own request`)
    check(ids(await client(tl).get('/api/requests')).has(id), `${dept}: team lead sees it`)
    check(ids(await client(mgr).get('/api/requests')).has(id), `${dept}: manager sees it`)
    check(!ids(await client(strangerTl).get('/api/requests')).has(id), `${dept}: unrelated team lead does NOT see it`)

    // rejection at team-lead stage releases the reservation
    const r2 = await file(emp); status(r2, 201, `${dept}: second request`)
    const b2 = await bal(emp.id, 'ANNUAL')
    status(await act(tl, r2.json.request.id, 'reject', 'not now'), 200, `${dept}: team lead rejects`)
    const b3 = await bal(emp.id, 'ANNUAL')
    eq([(await dbReq(r2.json.request.id))!.status, b2!.pending - b3!.pending], ['REJECTED', 2], `${dept}: REJECTED and the 2 reserved days released`)
    status(await act(mgr, r2.json.request.id, 'approve'), 403, `${dept}: rejected request cannot be approved`)

    // rejection by HR at the last stage
    const r3 = await file(emp); const id3 = r3.json.request.id
    await act(tl, id3, 'approve'); await act(mgr, id3, 'approve')
    status(await act(yasir, id3, 'reject', 'policy'), 200, `${dept}: HR rejects at final stage`)
    eq((await dbReq(id3))!.status, 'REJECTED', `${dept}: final-stage rejection stored`)

    // double approval at the same instant: exactly one wins, the balance moves once
    const r4 = await file(emp); const id4 = r4.json.request.id
    const [x, y] = await Promise.all([act(tl, id4, 'approve'), act(tl, id4, 'approve')])
    const codes = [x.status, y.status].sort()
    check(codes[0] === 200 && [403, 409].includes(codes[1]), `${dept}: concurrent double-approve → one 200 + one refusal`, codes.join('/'))
    eq((await dbReq(id4))!.approvals.length, 1, `${dept}: only one approval row written`)
    await act(mgr, id4, 'approve')
    const bBefore = await bal(emp.id, 'ANNUAL')
    const [h1, h2] = await Promise.all([act(yasir, id4, 'approve'), act(yasir, id4, 'approve')])
    const hc = [h1.status, h2.status].sort()
    check(hc[0] === 200 && [403, 409].includes(hc[1]), `${dept}: concurrent FINAL approval → one wins`, hc.join('/'))
    const bAfter = await bal(emp.id, 'ANNUAL')
    eq([bAfter!.availed - bBefore!.availed, bAfter!.pending - bBefore!.pending], [2, -2], `${dept}: balance moved exactly once under a race`)
  }

  // ── admin fast-track, and a department whose team lead is not a demo login (HR) ─
  {
    const emp = find('Human Resource', (u) => u.role === 'EMPLOYEE' && /intern/i.test(u.designation), 'HR intern')
    const r = await file(emp); status(r, 201, 'HR intern files leave (team lead is a real account)')
    status(await act(emp, r.json.request.id, 'approve'), 403, 'HR intern cannot approve own')
    const f = await act(sysadmin, r.json.request.id, 'approve')
    check(f.status === 200 && f.json.fastTrack === true && f.json.stage === 'APPROVED', 'System Admin fast-tracks to APPROVED in one step', JSON.stringify(f.json))
    const emp2 = find('Human Resource', (u) => u.role === 'EMPLOYEE' && /intern/i.test(u.designation) && u.id !== emp.id, 'second HR intern')
    const r2 = await file(emp2)
    const f2 = await act(yasir, r2.json.request.id, 'approve')
    check(f2.status === 200 && f2.json.stage === 'APPROVED', 'HR Manager fast-tracks an employee request', JSON.stringify(f2.json))
  }

  // ── requester's position changes the route ───────────────────────────────────
  {
    const tlU = find('Engineering', (u) => u.role === 'TEAM_LEAD' && !!u.managerId && ctx.byId.get(u.managerId)!.isDemo, 'engineering TL')
    const m = ctx.byId.get(tlU.managerId!)!
    let r = await file(tlU); status(r, 201, 'team lead files leave')
    eq(r.json.request.status, 'PENDING_MANAGER', 'a team lead\'s request skips the team-lead stage → manager')
    status(await act(m, r.json.request.id, 'approve'), 200, "manager approves the lead's request")
    status(await act(yasir, r.json.request.id, 'approve'), 200, "HR finalises the lead's request")

    const mgrU = find('Engineering', (u) => u.role === 'MANAGER' && !!u.managerId && ctx.byId.get(u.managerId)!.isDemo, 'engineering manager under a VP')
    const vp = ctx.byId.get(mgrU.managerId!)!
    r = await file(mgrU); status(r, 201, 'manager files leave')
    eq(r.json.request.status, 'PENDING_MANAGER', "a manager's request goes to the VP")
    status(await act(vp, r.json.request.id, 'approve'), 200, 'VP approves')
    status(await act(yasir, r.json.request.id, 'approve'), 200, 'HR finalises the manager request')

    r = await file(vp); status(r, 201, 'VP (top of department) files leave')
    eq(r.json.request.status, 'PENDING_HR', 'a VP with no manager goes straight to HR')
    status(await act(vp, r.json.request.id, 'approve'), 403, 'VP cannot approve own request')
    status(await act(yasir, r.json.request.id, 'approve'), 200, 'HR approves the VP request')
  }

  // ── YOUR RULES: HR Manager / System Admin requests ───────────────────────────
  {
    const r = await file(yasir); status(r, 201, 'HR Manager files own leave')
    const id = r.json.request.id
    eq([r.json.request.status, r.json.request.currentStage], ['PENDING_HR', 'HR'], "HR Manager's request goes to a single HR stage (System Admin only)")
    status(await act(yasir, id, 'approve'), 403, 'HR Manager CANNOT approve own leave')
    status(await act(yasir, id, 'reject'), 403, 'HR Manager cannot reject own leave either')
    for (const role of ['MANAGER', 'TEAM_LEAD', 'ACCOUNTS_MANAGER']) status(await act(userBy((u) => u.isDemo && u.role === role, role), id, 'approve'), 403, `${role} cannot approve an HR Manager's leave`)
    const ok = await act(sysadmin, id, 'approve'); status(ok, 200, 'only the System Admin can approve the HR Manager\'s leave')
    eq((await dbReq(id))!.status, 'APPROVED', "HR Manager's leave is APPROVED")
    check((await db.notification.count({ where: { userId: sysadmin.id, body: { contains: 'Yasir' } } })) > 0, "System Admin is notified that an HR Manager's request awaits them")

    const s = await file(sysadmin); status(s, 201, 'System Admin files personal leave (now allowed)')
    eq(s.json.request.status, 'PENDING_HR', "System Admin's own request is decided at the HR stage")
    status(await act(yasir, s.json.request.id, 'approve'), 403, "HR Manager cannot approve the System Admin's leave")
    status(await act(sysadmin, s.json.request.id, 'approve'), 200, 'System Admin can approve own leave')
    const b = await bal(sysadmin.id, 'ANNUAL')
    check(!!b && b.availed >= 2, 'System Admin balance was provisioned and debited', JSON.stringify(b))
    const myBalances = await client(sysadmin).get('/api/leave-balances')
    check(myBalances.status === 200 && myBalances.json.balances.length === ctx.leaveTypes.length, 'System Admin sees a balance for every leave type', JSON.stringify(myBalances.json))
  }

  // ── on-behalf filing ─────────────────────────────────────────────────────────
  {
    const emp = find('Marketing', (u) => u.role === 'EMPLOYEE' && /sales officer/i.test(u.designation) && !/senior/i.test(u.designation), 'sales officer')
    const r = await client(yasir).post('/api/requests', { userId: emp.id, type: 'LEAVE', leaveTypeId: lt('ANNUAL').id, reason: 'filed by HR', ...dates() })
    status(r, 201, 'HR files leave on behalf of an employee')
    eq(r.json?.request?.userId, emp.id, 'the request belongs to the employee, not HR')
    check((await db.notification.count({ where: { userId: emp.id, title: { contains: 'filed for you' } } })) > 0, 'employee is notified that HR filed it')
    check((await client(emp).get('/api/requests')).json.requests.some((x: any) => x.id === r.json.request.id), 'employee sees the request HR filed')
    check((await db.auditLog.findFirst({ where: { entityType: 'REQUEST', entityId: r.json.request.id, reason: { contains: 'on behalf' } } })) !== null, 'audit trail says it was filed on behalf (actor = HR)')
    // employees can only ever file for themselves
    const other = find('Marketing', (u) => u.role === 'EMPLOYEE' && u.id !== emp.id, 'another employee')
    const sneaky = await client(emp).post('/api/requests', { userId: other.id, type: 'LEAVE', leaveTypeId: lt('ANNUAL').id, reason: 'sneaky', ...dates() })
    status(sneaky, 201, 'employee file with a foreign userId is accepted…')
    eq(sneaky.json?.request?.userId, emp.id, '…but the userId is ignored — it is filed for the employee themself')
  }

  // ── accounts staff are outside the leave workflow ───────────────────────────
  {
    for (const role of ['ACCOUNTANT', 'ACCOUNTS_MANAGER']) {
      const u = userBy((x) => x.isDemo && x.role === role, role)
      status(await file(u), 403, `${role} cannot file leave requests`)
      status(await client(u).get('/api/requests'), 403, `${role} cannot open the requests module`)
    }
  }

  // ── validation + policy ──────────────────────────────────────────────────────
  {
    const emp = find('Engineering', (u) => u.role === 'EMPLOYEE' && /^Software Engineer$/i.test(u.designation), 'software engineer')
    const c = client(emp)
    const base = { type: 'LEAVE', leaveTypeId: lt('ANNUAL').id, reason: 'validation' }
    status(await c.post('/api/requests', { ...base, startDate: '2027-02-02', endDate: '2027-03-30' }), 422, 'more days than the balance → 422 (hard quota gate)')
    status(await c.post('/api/requests', { ...base, startDate: '2027-02-09', endDate: '2027-02-08' }), 422, 'end before start → 422')
    status(await c.post('/api/requests', { ...base, startDate: '2027-02-30', endDate: '2027-02-30' }), 422, 'impossible date (Feb 30) → 422')
    status(await c.post('/api/requests', { ...base, startDate: 'tomorrow', endDate: 'tomorrow' }), 422, 'non-date text → 422')
    status(await c.post('/api/requests', { ...base, startDate: '2027-02-09', endDate: 'garbage' }), 422, 'garbage end date → 422')
    status(await c.post('/api/requests', { ...base, type: 'NONSENSE', startDate: '2027-02-09' }), 422, 'unknown request type → 422')
    status(await c.post('/api/requests', { ...base, leaveTypeId: undefined, startDate: '2027-02-09' }), 422, 'leave without a leave type → 422')
    status(await c.post('/api/requests', { ...base, isShortLeave: true, shortHours: 'abc', startDate: '2027-02-09' }), 422, 'short leave with non-numeric hours → 422 (NaN guard)')
    status(await c.post('/api/requests', { ...base, isShortLeave: true, shortHours: 9, startDate: '2027-02-09' }), 422, 'short leave beyond the policy maximum → 422')
    status(await c.post('/api/requests', { ...base, isShortLeave: true, shortHours: 0, startDate: '2027-02-09' }), 422, 'short leave of 0 hours → 422')
    const short = await c.post('/api/requests', { ...base, isShortLeave: true, shortHours: 2, startDate: '2027-02-09' })
    check(short.status === 201 && short.json.request.dayCount > 0 && short.json.request.dayCount < 1, 'valid short leave (2h) becomes a fraction of a day', JSON.stringify(short.json))
    const od = await c.post('/api/requests', { type: 'OFFICIAL_DUTY', reason: 'client visit', ...dates() }); status(od, 201, 'official duty request')
    const tr = await c.post('/api/requests', { type: 'TRAVEL', reason: 'conference', ...dates() }); status(tr, 201, 'travel request')
    status(await c.post('/api/requests', { ...base, attachmentId: 'cl_not_mine_00000000000000', ...dates() }), 422, 'attachment that does not exist → 422')

    // monthly cap: CASUAL max 2 days/month — pending requests count, including those already at HR
    const cas = lt('CASUAL')
    check(cas.monthlyCap === 2, 'CASUAL has a monthly cap of 2 in this dataset')
    const m1 = await c.post('/api/requests', { type: 'LEAVE', leaveTypeId: cas.id, reason: 'cap test', startDate: '2027-03-02', endDate: '2027-03-03' })
    status(m1, 201, 'CASUAL: 2 days within the cap')
    status(await c.post('/api/requests', { type: 'LEAVE', leaveTypeId: cas.id, reason: 'cap test', startDate: '2027-03-09', endDate: '2027-03-09' }), 422, 'CASUAL: a 3rd day in the same month is blocked (pending counts)')
    const tl = ctx.byId.get(emp.teamLeadId!)!, mg = ctx.byId.get(emp.managerId!)!
    await act(tl, m1.json.request.id, 'approve'); await act(mg, m1.json.request.id, 'approve') // now PENDING_HR
    eq((await dbReq(m1.json.request.id))!.status, 'PENDING_HR', 'CASUAL request waits at HR')
    status(await c.post('/api/requests', { type: 'LEAVE', leaveTypeId: cas.id, reason: 'cap test', startDate: '2027-03-16', endDate: '2027-03-16' }), 422, 'CASUAL: cap still enforced while a request sits at the HR stage (regression)')
    status(await c.post('/api/requests', { type: 'LEAVE', leaveTypeId: cas.id, reason: 'cap test', startDate: '2027-04-06', endDate: '2027-04-06' }), 201, 'CASUAL: a different month is fine')

    // conditional certificate: SICK needs a document beyond 2 days/month
    const sick = lt('SICK')
    status(await c.post('/api/requests', { type: 'LEAVE', leaveTypeId: sick.id, reason: 'flu', startDate: '2027-05-04', endDate: '2027-05-05' }), 201, 'SICK: first 2 days need no certificate')
    const noDoc = await c.post('/api/requests', { type: 'LEAVE', leaveTypeId: sick.id, reason: 'flu', startDate: '2027-05-11', endDate: '2027-05-11' })
    check(noDoc.status === 422 && /supporting document|certificate/i.test(noDoc.json?.error ?? ''), 'SICK: beyond the threshold a document is required', JSON.stringify(noDoc.json))
    const up = await c.req('POST', '/api/uploads', { form: fileForm(PDF, 'medical.pdf', 'application/pdf') })
    status(up, 201, 'medical certificate uploads (PDF magic bytes accepted)')
    const withDoc = await c.post('/api/requests', { type: 'LEAVE', leaveTypeId: sick.id, reason: 'flu', startDate: '2027-05-11', endDate: '2027-05-11', attachmentId: up.json.upload.id, attachmentName: 'medical.pdf' })
    status(withDoc, 201, 'SICK: accepted once the certificate is attached')
    // someone else's upload cannot be attached
    const other = find('Engineering', (u) => u.role === 'EMPLOYEE' && u.id !== emp.id, 'other engineer')
    const othersUp = await client(other).req('POST', '/api/uploads', { form: fileForm(PDF, 'theirs.pdf', 'application/pdf') })
    status(await c.post('/api/requests', { type: 'LEAVE', leaveTypeId: sick.id, reason: 'x', startDate: '2027-05-18', endDate: '2027-05-18', attachmentId: othersUp.json.upload.id }), 422, "attaching another employee's document → 422")

    // overdraw race: two simultaneous requests that together exceed the balance
    const racer = find('Marketing', (u) => u.role === 'EMPLOYEE' && /ui\/ux designer/i.test(u.designation) && !/senior/i.test(u.designation), 'ui/ux designer')
    const range = { startDate: '2027-06-01', endDate: '2027-06-09' } // 8 working days (Sunday excluded); balance is 15
    const [a, b] = await Promise.all([1, 2].map(() => client(racer).post('/api/requests', { type: 'LEAVE', leaveTypeId: lt('ANNUAL').id, reason: 'race', ...range })))
    const created = [a, b].filter((x) => x.status === 201).length
    eq(created, 1, 'two simultaneous 8-day requests against 15 days → exactly one is accepted (no overdraw)')
    const rb = await bal(racer.id, 'ANNUAL')
    check(!!rb && rb.pending === 8 && rb.carryForward + lt('ANNUAL').annualQuota - rb.availed - rb.pending >= 0, 'balance never goes negative under the race', JSON.stringify(rb))
  }

  // ── notifications ───────────────────────────────────────────────────────────
  {
    const emp = find('Engineering', (u) => u.role === 'EMPLOYEE' && /intern/i.test(u.designation) && !!u.teamLeadId, 'intern')
    const n = await client(emp).get('/api/notifications')
    check(n.status === 200 && n.json.items.length > 0 && n.json.unread >= 0, 'employee has notifications from the workflow')
    const mark = await client(emp).post('/api/notifications', { all: true })
    eq(mark.json?.unread, 0, 'mark-all-read clears the unread counter')
    const bad = await client(emp).post('/api/notifications', { ids: [1, { $ne: 1 }, null] })
    status(bad, 200, 'malformed ids are ignored instead of crashing')
  }
}
