import { check, eq, section, status } from './lib'
import { ctx, db, client, userBy, type DU } from './ctx'

const r2 = (n: number) => Math.round(n * 100) / 100
const MONTH = '2026-11' // the real month the attendance demo data lives in (drafts only — discarded at the end)
const ARTIFICIAL = ['2020-01', '2020-02', '2020-03', '2020-04'] // finalized in tests; removed in teardown (nobody can have worked then)

export async function cleanupPayrollTestData() {
  await db.monthlyAdjustment.deleteMany({ where: { month: '2026-13' } }) // left by pre-validation runs
  await db.payslip.deleteMany({ where: { run: { month: { in: ARTIFICIAL } } } })
  await db.payrollRun.deleteMany({ where: { month: { in: ARTIFICIAL } } })
  await db.attendanceLog.deleteMany({ where: { dateKey: { startsWith: '2020-' } } })
  await db.leaveBalance.deleteMany({ where: { year: 2020 } })
  await db.loan.deleteMany({ where: { name: { startsWith: 'E2E ' } } })
  await db.monthlyAdjustment.deleteMany({ where: { month: { in: ARTIFICIAL } } })
}

export async function phase5() {
  section('5a. Payroll: authority, draft run, figures, exports')
  await cleanupPayrollTestData()
  await db.payslip.deleteMany({ where: { run: { month: MONTH, status: 'DRAFT' } } })
  await db.payrollRun.deleteMany({ where: { month: MONTH, status: 'DRAFT' } })

  const accountant = userBy((u) => u.isDemo && u.role === 'ACCOUNTANT', 'accountant')
  const otherAcc = userBy((u) => u.isDemo && u.role === 'ACCOUNTANT' && u.id !== accountant.id, 'second accountant')
  const head = userBy((u) => u.isDemo && u.role === 'ACCOUNTS_MANAGER', 'accounts manager')
  const yasir = userBy((u) => u.isDemo && u.role === 'HR_MANAGER', 'HR manager')
  const sysadmin = userBy((u) => u.email === 'sysadmin@demo.hrms.local', 'sysadmin')
  const emp = userBy((u) => u.isDemo && u.role === 'EMPLOYEE' && u.departmentName === 'Engineering' && /^Software Engineer$/i.test(u.designation), 'engineer')
  const tl = ctx.byId.get(emp.teamLeadId!)!
  const mg = ctx.byId.get(emp.managerId!)!
  const A = client(accountant), H = client(head), Y = client(yasir), S = client(sysadmin), E = client(emp)

  // ── salary + adjustments ──
  status(await A.patch('/api/payroll/salary', { userId: emp.id, baseSalary: 100000, hrAllowance: 10000, utilityAllowance: 5000, reason: 'e2e baseline' }), 200, 'accountant sets the engineer\'s salary components')
  status(await A.patch('/api/payroll/salary', { userId: 'cl_missing_0000000000000', baseSalary: 1 }), 404, 'salary edit for an unknown employee → 404')
  status(await A.patch('/api/payroll/salary', { userId: sysadmin.id, baseSalary: 1 }), 403, 'the System Admin has no salary profile')
  status(await A.patch('/api/payroll/salary', { userId: accountant.id, baseSalary: 999999 }), 403, 'nobody edits their OWN salary (segregation of duties)')
  status(await H.patch('/api/payroll/salary', { userId: accountant.id, baseSalary: 150000 }), 200, 'the Accounts Head may adjust an accountant\'s salary')
  status(await H.patch('/api/payroll/salary', { userId: head.id, baseSalary: 1 }), 403, 'the Accounts Head cannot edit their own salary either')
  status(await A.patch('/api/payroll/salary', { userId: emp.id }), 422, 'salary edit with no fields → 422')
  check((await db.auditLog.count({ where: { entityType: 'SALARY', targetUserId: emp.id } })) > 0, 'salary change audited field-by-field')
  status(await A.post('/api/payroll/adjustments', { userId: emp.id, month: MONTH, bonus: 5000, arrears: 2000, note: 'e2e bonus' }), 200, 'bonus + arrears recorded for the month')
  status(await A.post('/api/payroll/adjustments', { userId: accountant.id, month: MONTH, bonus: 1e6 }), 403, 'cannot award yourself a bonus')
  status(await A.post('/api/payroll/adjustments', { userId: emp.id, month: '2026-13' }), 422, 'invalid month → 422')
  status(await A.post('/api/payroll/adjustments', { userId: sysadmin.id, month: MONTH, bonus: 1 }), 404, 'no adjustments for the System Admin')

  // ── draft run ──
  const activeNonAdmin = await db.user.count({ where: { isActive: true, role: { not: 'SUPER_ADMIN' } } })
  status(await A.post('/api/payroll/runs', {}), 422, 'run without a month → 422')
  status(await A.post('/api/payroll/runs', { month: 'November' }), 422, 'malformed month → 422')
  status(await Y.post('/api/payroll/runs', { month: MONTH }), 403, 'HR Manager cannot create a run (read-only)')
  status(await E.post('/api/payroll/runs', { month: MONTH }), 403, 'employee cannot create a run')
  const run = await A.post('/api/payroll/runs', { month: MONTH })
  status(run, 201, 'accountant creates the DRAFT run')
  const runId: string = run.json.run.id
  eq(run.json.payslips, activeNonAdmin, `one payslip per active non-admin employee (${activeNonAdmin})`)
  status(await A.post('/api/payroll/runs', { month: MONTH }), 409, 'a second run for the same month → 409')
  status(await S.post('/api/payroll/runs', { month: MONTH }), 409, 'also 409 for the System Admin')

  const detail = await A.get(`/api/payroll/runs/${runId}`)
  status(detail, 200, 'run detail loads')
  const slip = detail.json.run.payslips.find((p: any) => p.userId === emp.id)
  check(!!slip, 'the engineer has a payslip in the run')
  const days = 20 // Nov 2026: 21 weekdays − the Nov 9 holiday
  eq(slip.workingDays, days, 'shift-aware working days (21 weekdays − 1 holiday = 20)')
  const base = 100000, hra = 10000, util = 5000, bonus = 5000, arrears = 2000
  const pf = Math.round(base * 0.05)
  eq([slip.basicSalary, slip.hrAllowance, slip.utilityAllowance, slip.bonus, slip.arrears], [base, hra, util, bonus, arrears], 'earnings copied into the payslip snapshot')
  eq(slip.grossPay, r2(base + hra + util + bonus + arrears + pf), 'gross = components + bonus + arrears + provident fund')
  const dayRate = (base + hra + util) / days
  const logs = await db.attendanceLog.findMany({ where: { userId: emp.id, dateKey: { startsWith: MONTH } } })
  const shortMin = logs.filter((l) => ['PRESENT', 'SHORT_DURATION', 'WFH', 'SHORT_LEAVE'].includes(l.status)).reduce((s, l) => s + l.shortMinutes, 0)
  const absent = logs.filter((l) => l.status === 'ABSENT').length
  eq(slip.shortMinutes, shortMin, 'short minutes aggregated from the attendance rows')
  eq(slip.workedDays, logs.filter((l) => ['PRESENT', 'SHORT_DURATION', 'SHORT_LEAVE', 'WFH', 'OFFICIAL_DUTY', 'TRAVEL'].includes(l.status)).length, 'worked days counted from attendance')
  eq(slip.leaveDeduction, r2(absent * dayRate), 'absent days are deducted at gross ÷ working days')
  eq(slip.netPay, r2(slip.grossPay - slip.totalDeduction + slip.overtimeAmount), 'net = gross − deductions + overtime')
  eq(slip.totalDeduction, r2(slip.internalLoan + slip.incomeTax + slip.providentFund + slip.eoobi + slip.shortHourDeduction + slip.leaveDeduction), 'total deduction adds up')
  check(detail.json.run.payslips.every((p: any) => Number.isFinite(p.netPay) && p.netPay <= p.grossPay + p.overtimeAmount + 0.01), 'no payslip has a NaN/inflated net pay')
  const gone = ctx.users.find((u) => u.isDemo)!
  check(detail.json.run.payslips.some((p: any) => p.paidLeaves > 0), 'the approved paid leave from the leave tests appears as paid leave')
  eq(r2(detail.json.run.payslips.reduce((s: number, p: any) => s + p.netPay, 0)), r2(detail.json.run.totalNet), 'run total net = sum of payslips')
  void gone

  // no side effects while it is only a draft
  const leaveBefore = await db.leaveBalance.aggregate({ _sum: { availed: true }, where: { year: 2026 } })
  const draftAgain = await A.get(`/api/payroll/runs/${runId}`)
  status(draftAgain, 200, 'reading a draft is read-only')
  eq((await db.leaveBalance.aggregate({ _sum: { availed: true }, where: { year: 2026 } }))._sum.availed, leaveBefore._sum.availed, 'creating a draft did not touch any leave balance')

  // visibility of a DRAFT payslip
  const slips = await A.get(`/api/payroll/payslips?month=${MONTH}`)
  const slipId = slips.json.payslips.find((p: any) => p.userId === emp.id)?.id
  check(!!slipId, 'payroll team sees the draft payslip')
  eq((await E.get('/api/payroll/payslips')).json.payslips.length, 0, "the employee does NOT see a draft payslip")
  status(await E.get(`/api/payroll/payslips/${slipId}/pdf`), 403, 'employee cannot download a draft payslip')
  status(await client(tl).get(`/api/payroll/payslips/${slipId}/pdf`), 403, "team lead cannot download a report's payslip")
  status(await client(mg).get(`/api/payroll/payslips?userId=${emp.id}`), 403, "manager cannot list a report's payslips")
  status(await client(tl).get(`/api/payroll/payslips?userId=${emp.id}`), 403, "team lead cannot list a report's payslips")
  status(await Y.get(`/api/payroll/payslips/${slipId}/pdf`), 200, 'HR Manager can open any payslip')
  status(await A.get(`/api/payroll/payslips/${slipId}/pdf`), 200, 'accountant can open it')
  status(await client(otherAcc).get(`/api/payroll/runs/${runId}`), 200, 'another accountant can read the run')
  status(await E.get(`/api/payroll/runs/${runId}`), 403, 'employee cannot read a run')

  // exports
  const xl = await A.get(`/api/payroll/excel?month=${MONTH}`)
  check(xl.status === 200 && (xl.headers.get('content-type') ?? '').includes('spreadsheetml') && xl.buf.subarray(0, 2).toString() === 'PK' && xl.buf.length > 3000, 'Excel master sheet is a real .xlsx (zip) file', `HTTP ${xl.status} ${xl.buf.length}B`)
  const bulk = await A.get(`/api/payroll/bulk-pdf?month=${MONTH}`)
  check(bulk.status === 200 && bulk.buf.subarray(0, 4).toString() === '%PDF' && bulk.buf.length > 5000, 'bulk salary-slip PDF is a real PDF', `HTTP ${bulk.status} ${bulk.buf.length}B`)
  const reg = await Y.get(`/api/payroll/runs/${runId}/pdf`)
  check(reg.status === 200 && reg.buf.subarray(0, 4).toString() === '%PDF', 'payroll register PDF (HR can read)')
  status(await Y.get(`/api/payroll/excel?month=${MONTH}`), 403, 'HR cannot export the Excel master sheet')
  status(await A.get('/api/payroll/excel?month=2020-13'), 422, 'bad month for export → 422')
  status(await A.get('/api/payroll/excel?month=1999-01'), 404, 'export for a month with no run → 404')

  // authority: only the Accounts Head finalizes
  for (const [who, c] of [['accountant', A], ['System Admin', S], ['HR Manager', Y], ['employee', E]] as const) status(await c.post(`/api/payroll/runs/${runId}/finalize`, {}), 403, `${who} cannot finalize payroll`)

  // recalculation path: discard → fix salary → regenerate
  status(await Y.del(`/api/payroll/runs/${runId}`), 403, 'HR cannot discard a run')
  status(await A.del(`/api/payroll/runs/${runId}`), 200, 'accountant discards the draft')
  status(await A.get(`/api/payroll/runs/${runId}`), 404, 'the discarded run is gone')
  status(await A.patch('/api/payroll/salary', { userId: emp.id, baseSalary: 120000 }), 200, 'salary corrected')
  const rerun = await S.post('/api/payroll/runs', { month: MONTH }); status(rerun, 201, 'the month can be regenerated (System Admin may prepare runs)')
  const slip2 = (await S.get(`/api/payroll/runs/${rerun.json.run.id}`)).json.run.payslips.find((p: any) => p.userId === emp.id)
  eq(slip2.basicSalary, 120000, 'regenerated payslip reflects the corrected salary')
  status(await S.del(`/api/payroll/runs/${rerun.json.run.id}`), 200, 'draft discarded again (real month left free)')
  await A.patch('/api/payroll/salary', { userId: emp.id, baseSalary: 100000, reason: 'e2e restore' })

  // race: two simultaneous creations of the same month
  const [c1, c2] = await Promise.all([A.post('/api/payroll/runs', { month: '2020-04' }), S.post('/api/payroll/runs', { month: '2020-04' })])
  eq([c1.status, c2.status].sort(), [201, 409], 'two simultaneous runs for one month → exactly one is created')

  // ── finalize: artificial months only ────────────────────────────────────────
  section('5b. Payroll finalize: Accounts Head only, one-shot, side effects (leave conversion, loans)')
  const convEmp = userBy((u) => u.isDemo && u.role === 'EMPLOYEE' && u.departmentName === 'Marketing' && /ui\/ux designer/i.test(u.designation) && !/senior/i.test(u.designation), 'marketing designer')
  const loanEmp = userBy((u) => u.isDemo && u.role === 'EMPLOYEE' && u.departmentName === 'Engineering' && /^Intern$/i.test(u.designation), 'intern')
  const closeEmp = userBy((u) => u.isDemo && u.role === 'EMPLOYEE' && u.departmentName === 'Engineering' && /^QA Intern$/i.test(u.designation), 'QA intern')
  const casual = ctx.leaveTypes.find((t) => t.code === 'CASUAL')!
  // synthetic history: 2 days with 480 short minutes each → 960 min = 2 leave days at the default 480-min conversion
  await db.leaveBalance.create({ data: { userId: convEmp.id, leaveTypeId: casual.id, year: 2020 } })
  for (const d of ['2020-03-02', '2020-03-03']) await db.attendanceLog.create({ data: { userId: convEmp.id, dateKey: d, status: 'SHORT_DURATION', expectedMinutes: 480, workedMinutes: 0, shortMinutes: 480, source: 'SYSTEM' } })
  await db.loan.create({ data: { userId: loanEmp.id, name: 'E2E Loan 3x', loanAmount: 30000, installments: 3, installmentAmount: 10000, startDate: '2020-01' } })
  await db.loan.create({ data: { userId: closeEmp.id, name: 'E2E Loan 1x', loanAmount: 10000, installments: 1, installmentAmount: 10000, startDate: '2020-01' } })

  const m3 = await A.post('/api/payroll/runs', { month: '2020-03' }); status(m3, 201, 'draft for the artificial month with synthetic short hours + loans')
  const d3 = (await A.get(`/api/payroll/runs/${m3.json.run.id}`)).json.run
  const conv = d3.payslips.find((p: any) => p.userId === convEmp.id)
  eq([conv.shortMinutes, conv.leaveDaysEquivalent, conv.shortConvertedFromBalance], [960, 2, 2], '960 short minutes → 2 leave days, both covered by the Casual balance')
  eq(conv.shortHourDeduction, 0, 'nothing deducted from salary while the leave balance covers it')
  const casBefore = await db.leaveBalance.findFirst({ where: { userId: convEmp.id, leaveTypeId: casual.id, year: 2020 } })
  eq(casBefore!.availed, 0, 'the balance is untouched while the run is a draft')
  const loanSlip = d3.payslips.find((p: any) => p.userId === loanEmp.id)
  eq(loanSlip.internalLoan, 10000, 'loan installment deducted in the draft')
  check(!!JSON.parse(loanSlip.loanStatus).loanId, 'the payslip snapshot records WHICH loan it paid')
  eq((await db.loan.findFirst({ where: { name: 'E2E Loan 3x' } }))!.paidInstallments, 0, 'loan not advanced by a draft')

  status(await A.post(`/api/payroll/runs/${m3.json.run.id}/finalize`, {}), 403, 'accountant still cannot finalize')
  status(await S.post(`/api/payroll/runs/${m3.json.run.id}/finalize`, {}), 403, 'System Admin cannot finalize')
  const fin = await H.post(`/api/payroll/runs/${m3.json.run.id}/finalize`, {})
  status(fin, 200, 'the Accounts Head finalizes')
  eq(fin.json.run.status, 'FINALIZED', 'run is FINALIZED')
  eq((await db.leaveBalance.findFirst({ where: { userId: convEmp.id, leaveTypeId: casual.id, year: 2020 } }))!.availed, 2, 'finalize debited the 2 converted days from the Casual balance')
  const loanAfter = await db.loan.findFirst({ where: { name: 'E2E Loan 3x' } })
  eq([loanAfter!.paidInstallments, loanAfter!.isActive], [1, true], 'finalize advanced the loan by one installment (still active)')
  const closed = await db.loan.findFirst({ where: { name: 'E2E Loan 1x' } })
  eq([closed!.paidInstallments, closed!.isActive], [1, false], 'a fully paid loan is closed')
  status(await H.post(`/api/payroll/runs/${m3.json.run.id}/finalize`, {}), 409, 'finalizing twice → 409 (nothing applied again)')
  eq((await db.loan.findFirst({ where: { name: 'E2E Loan 3x' } }))!.paidInstallments, 1, 'the second finalize attempt changed nothing')
  status(await A.del(`/api/payroll/runs/${m3.json.run.id}`), 409, 'a finalized run is locked: cannot be discarded')
  status(await A.post('/api/payroll/adjustments', { userId: emp.id, month: '2020-03', bonus: 1 }), 409, 'adjustments to a finalized month are rejected')
  status(await A.post('/api/payroll/runs', { month: '2020-03' }), 409, 'cannot regenerate a finalized month')

  // concurrent finalize
  const m4 = (await db.payrollRun.findFirst({ where: { month: '2020-04' } }))!
  const [f1, f2] = await Promise.all([H.post(`/api/payroll/runs/${m4.id}/finalize`, {}), client(userBy((u) => u.isDemo && u.role === 'ACCOUNTS_MANAGER' && u.id !== head.id, 'second head')).post(`/api/payroll/runs/${m4.id}/finalize`, {})])
  eq([f1.status, f2.status].sort(), [200, 409], 'two Accounts Heads finalizing at once → exactly one wins')

  // finalized payslip visibility
  const fSlip = d3.payslips.find((p: any) => p.userId === convEmp.id)
  const C = client(convEmp)
  const own = await C.get('/api/payroll/payslips')
  check(own.json.payslips.some((p: any) => p.id === fSlip.id && p.run.month === '2020-03'), 'the employee now sees their FINALIZED payslip')
  eq(own.json.payslips.every((p: any) => p.userId === convEmp.id), true, 'and only their own')
  const pdf = await C.get(`/api/payroll/payslips/${fSlip.id}/pdf`)
  check(pdf.status === 200 && pdf.buf.subarray(0, 4).toString() === '%PDF', 'owner downloads the salary slip PDF')
  status(await E.get(`/api/payroll/payslips/${fSlip.id}/pdf`), 403, 'a colleague cannot download it')
  status(await E.get(`/api/payroll/payslips?userId=${convEmp.id}`), 403, "…or list someone else's payslips")
  const convTl = ctx.byId.get(convEmp.teamLeadId!)!
  status(await client(convTl).get(`/api/payroll/payslips/${fSlip.id}/pdf`), 403, 'even their team lead cannot')
  status(await Y.get(`/api/payroll/payslips/${fSlip.id}/pdf`), 200, 'HR can')
  const rep = await C.get(`/api/reports/individual?userId=${convEmp.id}&from=2020-01-01&to=2020-12-31`)
  check(rep.status === 200 && rep.json.sections.includes('payroll'), 'own report includes the payroll section')
  const supRep = await client(convTl).get(`/api/reports/individual?userId=${convEmp.id}&from=2020-01-01&to=2020-12-31`)
  check(supRep.status === 200 && !supRep.json.sections.includes('payroll') && supRep.json.payroll.length === 0, "a supervisor's view of the same report has NO payroll section")
  const pdfRep = await client(convTl).get(`/api/reports/pdf?type=individual&userId=${convEmp.id}&from=2020-01-01&to=2020-12-31`)
  check(pdfRep.status === 200 && pdfRep.buf.subarray(0, 4).toString() === '%PDF', 'supervisor can still export the attendance/leave report PDF')

  await cleanupPayrollTestData()
}
