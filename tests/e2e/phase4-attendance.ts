import { createHmac } from 'crypto'
import { Client, addDays, check, eq, isoWeekday, section, status, todayKarachi } from './lib'
import { ctx, db, client, demoUsers, pool, userBy, resetAttendanceData, resetLeaveData, removeTestDevices, type DU } from './ctx'

const hm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`
const mins = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5))

/** Independent oracle for one day of punches — the rules from the spec, not copied code paths. */
function oracle(shift: DU['shift'], inT: string | null, outT: string | null) {
  if (!inT) return { status: 'ABSENT', worked: 0, short: 0, late: 0 }
  const start = mins(shift.startTime), end = mins(shift.endTime)
  const i = mins(inT), o = outT ? mins(outT) : null
  const late = Math.max(0, i - start - shift.graceMinutes)
  const arrival = i <= start + shift.graceMinutes ? Math.min(i, start) : i // inside grace (or early) counts from shift start
  const worked = o != null ? Math.max(0, Math.min(o, end) - arrival) : 0
  const short = Math.max(0, shift.expectedMinutes - worked)
  return { status: o == null ? 'MISSING' : short === 0 ? 'PRESENT' : 'SHORT_DURATION', worked, short, late }
}

type Pattern = 'ontime' | 'late' | 'early' | 'missing' | 'absent'
type Plan = { u: DU; days: { date: string; inT: string | null; outT: string | null; pattern: Pattern }[] }

/** The last 9 working days before today (skipping holidays). */
function workingDays(): string[] {
  const out: string[] = []
  for (let d = addDays(todayKarachi(), -1); out.length < 9; d = addDays(d, -1)) if (!ctx.holidays.has(d) && isoWeekday(d) <= 5) out.push(d)
  return out.reverse()
}

export const attendanceState: { days: string[]; plans: Plan[]; device?: { id: string; key: string; secret: string; sn: string }; missingEmp?: DU } = { days: [], plans: [] }

function sign(secret: string, ts: string, body: string) { return createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex') }
const pushHeaders = (d: { key: string; secret: string }, body: string, tsOverride?: string) => {
  const ts = tsOverride ?? String(Date.now())
  return { 'X-Device-Key': d.key, 'X-Device-Ts': ts, 'X-Device-Sig': sign(d.secret, ts, body), 'Content-Type': 'text/plain' }
}

export async function phase4() {
  section('4a. Biometric devices: registry, signatures, ingestion')
  await removeTestDevices()
  const dayList = workingDays()
  await resetAttendanceData(dayList[0]) // idempotent: wipe what a previous run generated for the demo accounts
  await resetLeaveData({ reason: { startsWith: 'e2e:' } })

  const yasir = userBy((u) => u.isDemo && u.role === 'HR_MANAGER', 'HR manager')
  const sysadmin = userBy((u) => u.email === 'sysadmin@demo.hrms.local', 'sysadmin')
  const hr = client(yasir)
  const employee = userBy((u) => u.isDemo && u.role === 'EMPLOYEE', 'employee')
  const anon = new Client('device')

  // registry
  status(await client(employee).post('/api/biometric/devices', { name: 'Nope' }), 403, 'employee cannot register a device')
  status(await hr.post('/api/biometric/devices', { name: 'x' }), 422, 'device name must be at least 2 characters')
  const created = await hr.post('/api/biometric/devices', { name: 'E2E Test Device', model: 'ZKTeco K50', sn: 'E2E-SN-001' })
  status(created, 201, 'HR registers a device')
  const dev = { id: created.json.device.id as string, key: created.json.credentials.key as string, secret: created.json.credentials.secret as string, sn: 'E2E-SN-001' }
  attendanceState.device = dev
  check(/^dk_[0-9a-f]{24}$/.test(dev.key) && /^[0-9a-f]{64}$/.test(dev.secret), 'server generated a strong key + 256-bit secret', `${dev.key}`)
  status(await hr.post('/api/biometric/devices', { name: 'e2e test device' }), 409, 'duplicate device name (case-insensitive) → 409')
  status(await hr.post('/api/biometric/devices', { name: 'Other', sn: 'e2e-sn-001' }), 409, 'duplicate serial number → 409')
  const list = await hr.get('/api/biometric/devices')
  const row = list.json.devices.find((d: any) => d.id === dev.id)
  check(!!row && !JSON.stringify(list.json).includes(dev.secret) && !JSON.stringify(list.json).includes(dev.key), 'device list never exposes the key or secret again', JSON.stringify(row))
  const settings = await client(yasir).get('/api/settings')
  check(!JSON.stringify(settings.json).includes(dev.secret) && !('biometric.devices' in (settings.json.settings ?? {})), '/api/settings never exposes device credentials')
  status(await client(sysadmin).patch('/api/settings', { key: 'biometric.device', value: { key: 'abcdefgh', secret: 'x'.repeat(20), enabled: true } }), 422, 'devices cannot be edited through the generic settings endpoint')

  // authentication matrix on the ADMS endpoint
  const line = (pin: string, date: string, t: string, st: number) => `PIN=${pin}\tTIME=${date} ${t}:00\tSTATUS=${st}`
  const probeEmp = employee
  const probeDay = addDays(todayKarachi(), -400) // far past: never collides with generated data
  const body = line(probeEmp.employeeCode, probeDay, '09:00', 0)
  const push = (h: Record<string, string>, b = body) => anon.req('POST', '/api/biometric/zkteco/iclock/cdata', { raw: b, headers: h, origin: null })
  status(await push({}), 401, 'no signature headers → 401')
  status(await push({ ...pushHeaders({ key: 'dk_wrong', secret: dev.secret }, body) }), 401, 'unknown device key → 401')
  status(await push({ ...pushHeaders({ key: dev.key, secret: 'f'.repeat(64) }, body) }), 401, 'wrong secret (bad HMAC) → 401')
  status(await push(pushHeaders(dev, body, String(Date.now() - 10 * 60_000))), 401, 'stale timestamp (10 min old) → 401 (replay protection)')
  const tampered = pushHeaders(dev, body)
  status(await push(tampered, body.replace('09:00', '03:00')), 401, 'body altered after signing → 401')
  const hs = await anon.req('GET', '/api/biometric/zkteco/iclock/cdata', { origin: null })
  check(hs.status === 200 && hs.text === 'OK', 'unauthenticated GET handshake returns OK but ingests nothing')
  const ok1 = await push(pushHeaders(dev, body))
  check(ok1.status === 200 && ok1.json.stored === 1, 'correctly signed punch is accepted', JSON.stringify(ok1.json))
  const dup = await push(pushHeaders(dev, body))
  check(dup.status === 200 && dup.json.stored === 0 && dup.json.duplicates === 1, 'replaying the same punch is a duplicate, not a second row', JSON.stringify(dup.json))
  await db.biometricPunch.deleteMany({ where: { pin: probeEmp.employeeCode, ts: { lt: new Date(Date.now() - 300 * 86400_000) } } })
  await db.attendanceLog.deleteMany({ where: { userId: probeEmp.id, dateKey: probeDay } })

  // disable / enable / rotate
  status(await hr.patch('/api/biometric/devices', { id: dev.id, enabled: false }), 200, 'HR disables the device')
  status(await push(pushHeaders(dev, body)), 401, 'a disabled device is refused immediately')
  status(await hr.patch('/api/biometric/devices', { id: dev.id, enabled: true }), 200, 'HR re-enables it')
  const rot = await hr.patch('/api/biometric/devices', { id: dev.id, rotateSecret: true })
  status(rot, 200, 'HR rotates the secret')
  const oldSecret = dev.secret
  dev.secret = rot.json.credentials.secret
  check(dev.secret !== oldSecret, 'a new secret is issued')
  status(await push(pushHeaders({ key: dev.key, secret: oldSecret }, body)), 401, 'the OLD secret stops working at once')
  status(await hr.patch('/api/biometric/devices', { id: dev.id }), 422, 'a PATCH with no change → 422')
  status(await hr.patch('/api/biometric/devices', { id: dev.id, name: 'E2E Test Device (renamed)' }), 200, 'rename a device')
  await hr.patch('/api/biometric/devices', { id: dev.id, name: 'E2E Test Device' })

  // ── generate ~9 working days of punches for everyone (demo data + test oracle) ──
  section('4b. Generate attendance for all demo accounts and validate every day against the rules')
  const days = dayList; attendanceState.days = days
  const people = demoUsers().filter((u) => u.role !== 'SUPER_ADMIN').sort((a, b) => a.employeeCode.localeCompare(b.employeeCode)) // System Admin is oversight-only; stable order → the same pattern per person on every run
  const eng = (pred: (u: DU) => boolean) => people.find((u) => u.departmentName === 'Engineering' && u.role === 'EMPLOYEE' && !!u.teamLeadId && !!u.managerId && ctx.byId.get(u.teamLeadId)!.isDemo && ctx.byId.get(u.managerId)!.isDemo && pred(u))
  const regEmp = eng((u) => /^Software Engineer$/i.test(u.designation))!
  const rejEmp = eng((u) => /^Associate Software Engineer$/i.test(u.designation))!
  const adjEmp = people.find((u) => u.departmentName === 'Marketing' && u.role === 'EMPLOYEE' && /sales officer/i.test(u.designation))!
  attendanceState.missingEmp = regEmp
  const special = new Map<string, Pattern[]>() // userId → pattern per day index
  const setFor = (u: DU, p: Pattern, at: number) => { const a = special.get(u.id) ?? Array(days.length).fill('ontime'); a[at] = p; special.set(u.id, a) }
  setFor(regEmp, 'missing', 3); setFor(rejEmp, 'missing', 3); setFor(yasir, 'missing', 3)
  setFor(adjEmp, 'early', 2)
  const absentUsers: DU[] = []
  people.forEach((u, idx) => {
    if ([regEmp.id, rejEmp.id, adjEmp.id, yasir.id].includes(u.id)) return
    if (idx % 6 === 1) { setFor(u, 'late', 1); setFor(u, 'late', 4) }
    if (idx % 6 === 2) setFor(u, 'early', 5)
    if (idx % 6 === 4) setFor(u, 'missing', 6)
    if (idx % 6 === 5) { setFor(u, 'absent', 2); absentUsers.push(u) }
  })

  const lines: string[] = []
  const plans: Plan[] = []
  for (const u of people) {
    const ps = special.get(u.id) ?? Array(days.length).fill('ontime')
    const plan: Plan = { u, days: [] }
    days.forEach((date, i) => {
      const p: Pattern = ps[i]
      if (!u.shift.workingDays.includes(isoWeekday(date))) return
      const start = mins(u.shift.startTime), end = mins(u.shift.endTime)
      let inT: string | null = hm(start), outT: string | null = hm(end)
      if (p === 'late') inT = hm(start + 60)
      if (p === 'early') outT = hm(end - 90)
      if (p === 'missing') outT = null
      if (p === 'absent') { inT = null; outT = null }
      plan.days.push({ date, inT, outT, pattern: p })
      if (inT) lines.push(line(u.employeeCode, date, inT, 0))
      if (outT) lines.push(line(u.employeeCode, date, outT, 1))
    })
    plans.push(plan)
  }
  attendanceState.plans = plans
  const future = addDays(todayKarachi(), 5)
  const payload = [...lines, line(people[0].employeeCode, future, '09:00', 0), line('ZZ-NOBODY', days[0], '09:00', 0)].join('\n')
  const ing = await anon.req('POST', '/api/biometric/zkteco/iclock/cdata', { raw: payload, headers: pushHeaders(dev, payload), origin: null })
  check(ing.status === 200 && ing.json.stored === lines.length, `all ${lines.length} punches stored in one signed push`, JSON.stringify(ing.json))
  check(ing.json?.rejected === 1 && ing.json?.unknownPins === 1, 'future-dated punch rejected; unknown PIN counted (neither stored)', JSON.stringify(ing.json))
  check(ing.json?.daysRebuilt >= plans.reduce((n, p) => n + p.days.filter((d) => d.inT).length, 0), 'attendance rebuilt for every touched day', JSON.stringify(ing.json))
  const again = await anon.req('POST', '/api/biometric/zkteco/iclock/cdata', { raw: payload, headers: pushHeaders(dev, payload), origin: null })
  check(again.status === 200 && again.json.stored === 0 && again.json.duplicates === lines.length, 'pushing the whole batch again stores nothing (idempotent)', JSON.stringify(again.json))
  const devRow = (await hr.get('/api/biometric/devices')).json.devices.find((d: any) => d.id === dev.id)
  check(devRow?.punchCount >= lines.length && !!devRow?.lastPunchAt, 'device card shows punch count + last punch time', JSON.stringify(devRow))

  // validate every user's timesheet against the oracle
  let compared = 0
  await pool(plans, 8, async (plan) => {
    const c = client(plan.u)
    const months = [...new Set(plan.days.map((d) => d.date.slice(0, 7)))]
    const logs: any[] = []
    // managers / HR / accounts get every visible person's rows back — keep only this person's
    for (const m of months) logs.push(...((await c.get(`/api/attendance?month=${m}`)).json?.logs ?? []).filter((l: any) => l.user?.id === plan.u.id))
    for (const d of plan.days) {
      const log = logs.find((l) => l.dateKey === d.date)
      const exp = oracle(plan.u.shift, d.inT, d.outT)
      if (d.pattern === 'absent') { check(!log, `${plan.u.email} ${d.date}: no punches → no row before the sync`, JSON.stringify(log)); continue }
      compared++
      if (!log) { check(false, `${plan.u.email} ${d.date}: attendance row missing`); continue }
      const ok = log.status === exp.status && log.workedMinutes === exp.worked && log.shortMinutes === exp.short && log.lateMinutes === exp.late
      check(ok, `${plan.u.role} ${plan.u.email} ${d.date} [${d.pattern}] → ${exp.status}`, `got ${log.status} worked=${log.workedMinutes} short=${log.shortMinutes} late=${log.lateMinutes}; want ${JSON.stringify(exp)}`)
    }
  })
  console.log(`   ${compared} attendance days compared with the oracle`)

  // ── absence materialisation + approved leave becomes attendance ─────────────
  section('4c. Absences, approved leave on past days, attendance sync')
  const gone = absentUsers[0]
  const goneDay = days[2]
  const lr = await client(gone).post('/api/requests', { type: 'LEAVE', leaveTypeId: ctx.leaveTypes.find((t) => t.code === 'ANNUAL')!.id, startDate: goneDay, endDate: goneDay, reason: 'e2e: leave on a past day' })
  status(lr, 201, `${gone.fullName} files leave for the day they were absent`)
  status(await client(sysadmin).post(`/api/requests/${lr.json.request.id}/approve`, {}), 200, 'System Admin approves it')
  const lg = await db.attendanceLog.findUnique({ where: { userId_dateKey: { userId: gone.id, dateKey: goneDay } } })
  check(lg?.status === 'FULL_LEAVE' && lg.expectedMinutes === 0, 'approved leave on a past day immediately becomes a FULL_LEAVE attendance row (not counted against the score)', JSON.stringify(lg))

  status(await client(employee).post('/api/attendance/sync', { from: days[0], to: days[8] }), 403, 'employee cannot run the attendance sync')
  status(await hr.post('/api/attendance/sync', { from: days[0], to: todayKarachi() }), 422, 'sync refuses today/future (people may still punch)')
  status(await hr.post('/api/attendance/sync', { from: days[8], to: days[0] }), 422, 'sync refuses an inverted range')
  status(await hr.post('/api/attendance/sync', { from: addDays(days[0], -200), to: days[0] }), 422, 'sync refuses a range over 93 days')
  const sync = await hr.post('/api/attendance/sync', { from: days[0], to: days[8] })
  status(sync, 200, 'HR runs the attendance sync')
  const absNow = await db.attendanceLog.findMany({ where: { userId: { in: absentUsers.map((u) => u.id) }, dateKey: goneDay } })
  check(absNow.filter((l) => l.status === 'ABSENT').length === absentUsers.length - 1, 'every other punch-less user is marked ABSENT for that day', JSON.stringify(absNow.map((l) => l.status)))
  check(absNow.find((l) => l.userId === gone.id)?.status === 'FULL_LEAVE', 'the user with approved leave stays FULL_LEAVE (sync never overwrites it)')
  const again2 = await hr.post('/api/attendance/sync', { from: days[0], to: days[8] })
  check(again2.status === 200 && again2.json.created === 0, 'running the sync twice is idempotent', JSON.stringify(again2.json))
  const holidayRows = await db.attendanceLog.count({ where: { dateKey: { in: [...ctx.holidays] }, source: 'SYSTEM' } })
  eq(holidayRows, 0, 'the sync never creates absences on holidays')
  // real Sat/Sun dates inside the synced range (don't assume days[4] is a Friday)
  const weekendKeys: string[] = []
  for (let d = days[0]; d <= days[8]; d = addDays(d, 1)) { const w = new Date(d + 'T12:00:00Z').getUTCDay(); if (w === 0 || w === 6) weekendKeys.push(d) }
  const weekendRows = await db.attendanceLog.count({ where: { source: 'SYSTEM', dateKey: { in: weekendKeys } } })
  eq(weekendRows, 0, 'the sync never creates absences on weekends')

  // ── web punch ───────────────────────────────────────────────────────────────
  section('4d. Self punch (web)')
  const today = todayKarachi()
  const punchers = people.filter((u) => u.role === 'EMPLOYEE' && u.shift.workingDays.includes(isoWeekday(today)))
  let puncher: DU | undefined
  for (const u of punchers) if (!(await db.attendanceLog.findUnique({ where: { userId_dateKey: { userId: u.id, dateKey: today } } }))) { puncher = u; break }
  if (!puncher) console.log('   (every employee already punched today — skipping)')
  else {
    const c = client(puncher)
    status(await c.post('/api/attendance/punch', { type: 'OUT' }), 409, 'check-out before check-in → 409')
    status(await c.post('/api/attendance/punch', { type: 'SIDEWAYS' }), 422, 'invalid punch type → 422')
    status(await c.post('/api/attendance/punch', { type: 'IN' }), 200, `${puncher.fullName} checks in`)
    status(await c.post('/api/attendance/punch', { type: 'IN' }), 409, 'second check-in the same day → 409')
    status(await c.post('/api/attendance/punch', { type: 'OUT' }), 200, 'checks out')
    status(await c.post('/api/attendance/punch', { type: 'OUT' }), 409, 'second check-out → 409')
    const row = await db.attendanceLog.findUnique({ where: { userId_dateKey: { userId: puncher.id, dateKey: today } } })
    check(!!row?.checkIn && !!row.checkOut, "both punches stored on today's row")
  }
  status(await client(sysadmin).post('/api/attendance/punch', { type: 'IN' }), 403, 'System Admin is oversight-only: cannot punch')

  // ── regularization ──────────────────────────────────────────────────────────
  section('4e. Attendance regularization: 3-tier chain, rejection, HR Manager rule, manual rows survive device data')
  const date = days[3]
  const tl = ctx.byId.get(regEmp.teamLeadId!)!, mg = ctx.byId.get(regEmp.managerId!)!
  const rc = client(regEmp)
  const times = { requestedCheckIn: regEmp.shift.startTime, requestedCheckOut: regEmp.shift.endTime }
  status(await rc.post('/api/attendance/requests', { date, ...times }), 422, 'missing reason → 422')
  status(await rc.post('/api/attendance/requests', { date: addDays(todayKarachi(), 3), ...times, reason: 'x' }), 422, 'future date → 422')
  status(await rc.post('/api/attendance/requests', { date, requestedCheckIn: '18:00', requestedCheckOut: '09:00', reason: 'x' }), 422, 'check-out before check-in → 422')
  status(await rc.post('/api/attendance/requests', { date, requestedCheckIn: '25:61', requestedCheckOut: '09:00', reason: 'x' }), 422, 'invalid time → 422')
  const rq = await rc.post('/api/attendance/requests', { date, ...times, reason: 'forgot to punch out (e2e)' })
  status(rq, 201, `${regEmp.fullName} requests a correction`)
  const rid = rq.json.request.id
  eq(rq.json.request.status, 'PENDING_TEAM_LEAD', 'routed to the team lead first')
  status(await rc.post('/api/attendance/requests', { date, ...times, reason: 'again' }), 409, 'a second open request for the same day → 409')
  status(await client(mg).post(`/api/attendance/requests/${rid}/approve`, {}), 403, 'manager cannot jump the team-lead stage')
  status(await rc.post(`/api/attendance/requests/${rid}/approve`, {}), 403, 'employee cannot approve own correction')
  const strangerTl = userBy((u) => u.isDemo && u.role === 'TEAM_LEAD' && u.id !== tl.id, 'another team lead')
  status(await client(strangerTl).post(`/api/attendance/requests/${rid}/approve`, {}), 403, 'unrelated team lead cannot approve')
  let r = await client(tl).post(`/api/attendance/requests/${rid}/approve`, {}); status(r, 200, 'team lead approves'); eq(r.json?.stage, 'PENDING_MANAGER', '→ manager stage')
  r = await client(mg).post(`/api/attendance/requests/${rid}/approve`, {}); status(r, 200, 'manager approves'); eq(r.json?.stage, 'PENDING_HR', '→ HR stage')
  const before = await db.attendanceLog.findUnique({ where: { userId_dateKey: { userId: regEmp.id, dateKey: date } } })
  eq(before?.status, 'MISSING', 'the day is still MISSING until HR finalises')
  r = await hr.post(`/api/attendance/requests/${rid}/approve`, {}); status(r, 200, 'HR approves (final)'); eq(r.json?.stage, 'APPROVED', 'APPROVED')
  const fixed = await db.attendanceLog.findUnique({ where: { userId_dateKey: { userId: regEmp.id, dateKey: date } } })
  check(fixed?.status === 'PRESENT' && fixed.isManuallyUpdated && fixed.source === 'MANUAL' && !!fixed.checkOut, 'attendance row now complete, flagged manual', JSON.stringify(fixed))
  check((await db.attendanceAudit.count({ where: { attendanceId: fixed!.id, field: 'regularization' } })) === 1, 'field-level audit row written for the correction')
  status(await hr.post(`/api/attendance/requests/${rid}/approve`, {}), 403, 'an approved correction cannot be approved again')

  // a later device push must not clobber the corrected day
  const late = line(regEmp.employeeCode, date, '23:30', 1)
  const lateIng = await anon.req('POST', '/api/biometric/zkteco/iclock/cdata', { raw: late, headers: pushHeaders(dev, late), origin: null })
  check(lateIng.status === 200 && lateIng.json.stored === 1, 'a later device punch for that day is stored')
  const still = await db.attendanceLog.findUnique({ where: { userId_dateKey: { userId: regEmp.id, dateKey: date } } })
  check(still?.status === 'PRESENT' && still.isManuallyUpdated && still.checkOut?.getTime() === fixed?.checkOut?.getTime(), 'the manually corrected row is NOT overwritten by device data', JSON.stringify(still))

  // rejection path
  const rj = await client(rejEmp).post('/api/attendance/requests', { date, requestedCheckIn: rejEmp.shift.startTime, requestedCheckOut: rejEmp.shift.endTime, reason: 'reject me' })
  status(rj, 201, 'second employee files a correction')
  const rjTl = ctx.byId.get(rejEmp.teamLeadId!)!
  const rjr = await client(rjTl).post(`/api/attendance/requests/${rj.json.request.id}/reject`, { comment: 'no evidence' })
  check(rjr.status === 200 && rjr.json.stage === 'REJECTED', 'team lead rejects → terminal', JSON.stringify(rjr.json))
  eq((await db.attendanceLog.findUnique({ where: { userId_dateKey: { userId: rejEmp.id, dateKey: date } } }))?.status, 'MISSING', 'a rejected correction leaves the record untouched')
  status(await client(rjTl).post(`/api/attendance/requests/${rj.json.request.id}/approve`, {}), 403, 'rejected request cannot be approved')

  // HR Manager: only the System Admin may decide
  const yr = await hr.post('/api/attendance/requests', { date, requestedCheckIn: yasir.shift.startTime, requestedCheckOut: yasir.shift.endTime, reason: 'HR manager correction' })
  status(yr, 201, 'HR Manager files own correction')
  eq(yr.json.request.status, 'PENDING_HR', "HR Manager's correction goes to the single HR stage")
  status(await hr.post(`/api/attendance/requests/${yr.json.request.id}/approve`, {}), 403, 'HR Manager CANNOT approve own correction')
  status(await client(mg).post(`/api/attendance/requests/${yr.json.request.id}/approve`, {}), 403, 'a manager cannot approve it either')
  status(await client(sysadmin).post(`/api/attendance/requests/${yr.json.request.id}/approve`, {}), 200, 'System Admin approves the HR Manager correction')
  status(await client(userBy((u) => u.isDemo && u.role === 'ACCOUNTANT', 'acc')).post('/api/attendance/requests', { date, ...times, reason: 'x' }), 403, 'accounts staff cannot file corrections')
  status(await client(sysadmin).post('/api/attendance/requests', { date, ...times, reason: 'x' }), 403, 'System Admin cannot file corrections (oversight)')

  // ── direct HR adjustment ────────────────────────────────────────────────────
  section('4f. Direct HR adjustment + timesheet access')
  const adjLog = (await client(adjEmp).get(`/api/attendance?month=${days[2].slice(0, 7)}`)).json.logs.find((l: any) => l.dateKey === days[2])
  check(!!adjLog, 'target record found for HR adjustment')
  status(await client(adjEmp).post(`/api/attendance/${adjLog.id}/adjust`, { checkIn: '10:00', checkOut: '19:00', reason: 'x' }), 403, 'employee cannot adjust records directly')
  status(await hr.post(`/api/attendance/${adjLog.id}/adjust`, { checkIn: '10:00', checkOut: '19:00' }), 422, 'adjustment without a reason → 422')
  status(await hr.post(`/api/attendance/${adjLog.id}/adjust`, { checkIn: '10:00', checkOut: '19:00', status: 'DANCING', reason: 'x' }), 422, 'unknown status → 422')
  const adj = await hr.post(`/api/attendance/${adjLog.id}/adjust`, { checkIn: adjEmp.shift.startTime, checkOut: adjEmp.shift.endTime, reason: 'e2e correction' })
  status(adj, 200, 'HR adjusts a record')
  const adjRow = await db.attendanceLog.findUnique({ where: { id: adjLog.id } })
  check(adjRow?.isManuallyUpdated === true && adjRow.status === 'PRESENT', 'record recomputed and flagged manual', JSON.stringify(adjRow))
  check((await db.auditLog.count({ where: { entityType: 'ATTENDANCE', entityId: adjLog.id } })) > 0 && (await db.attendanceAudit.count({ where: { attendanceId: adjLog.id } })) > 0, 'adjustment is audited (actor, reason, old → new)')
  const hrLog = await db.attendanceLog.findUnique({ where: { userId_dateKey: { userId: yasir.id, dateKey: days[0] } } })
  status(await hr.post(`/api/attendance/${hrLog!.id}/adjust`, { checkIn: '09:00', checkOut: '18:00', reason: 'self-serving' }), 403, "HR Manager cannot adjust an HR Manager's own attendance")
  status(await client(sysadmin).post(`/api/attendance/${hrLog!.id}/adjust`, { checkIn: yasir.shift.startTime, checkOut: yasir.shift.endTime, reason: 'sysadmin fixes HR record' }), 200, "System Admin can adjust the HR Manager's attendance")

  // timesheet access
  const other = people.find((u) => u.role === 'EMPLOYEE' && u.departmentName === 'Marketing' && u.id !== adjEmp.id)!
  status(await client(adjEmp).get(`/api/attendance?month=${days[0].slice(0, 7)}&userId=${other.id}`), 403, "an employee cannot open a colleague's timesheet")
  status(await client(tl).get(`/api/attendance?month=${days[0].slice(0, 7)}&userId=${regEmp.id}`), 200, "a team lead opens a direct report's timesheet")
  status(await client(mg).get(`/api/attendance?month=${days[0].slice(0, 7)}&userId=${regEmp.id}`), 200, "a manager opens a report's timesheet")
  status(await client(strangerTl).get(`/api/attendance?month=${days[0].slice(0, 7)}&userId=${regEmp.id}`), 403, 'an unrelated team lead cannot')
  status(await hr.get(`/api/attendance?month=${days[0].slice(0, 7)}&userId=${regEmp.id}`), 200, "HR opens anyone's timesheet")
  const detail = await client(regEmp).get(`/api/attendance/${fixed!.id}`)
  check(detail.status === 200 && detail.json.log.audits.length >= 1, 'the detail drawer shows the audit trail')
  status(await client(adjEmp).get(`/api/attendance/${fixed!.id}`), 403, "another employee cannot open someone else's attendance detail")
  const agg = await client(userBy((u) => u.isDemo && u.role === 'ACCOUNTANT', 'acc')).get('/api/attendance')
  check(agg.status === 200, 'accounts staff can read attendance within their (org-wide) scope')
}
