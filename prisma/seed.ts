/**
 * KINTO HRMS — seed for the upgraded dual-role, biometric, 3-tier architecture.
 * Run: bun prisma/seed.ts
 */
import { db as sharedDb } from '../src/lib/db' // honours DB_PROVIDER (postgres | turso)
import { randomBytes, randomUUID, scryptSync, createHash } from 'crypto'
import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'

const db = sharedDb

// ─── deterministic RNG ────────────────────────────────────────────────────────
let seedState = 778812
function rng(): number {
  seedState |= 0; seedState = (seedState + 0x6d2b79f5) | 0
  let t = Math.imul(seedState ^ (seedState >>> 15), 1 | seedState)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const rand = (min: number, max: number) => Math.floor(rng() * (max - min + 1)) + min

// ─── Karachi date helpers ─────────────────────────────────────────────────────
const pad = (n: number) => String(n).padStart(2, '0')
function keyOf(d: Date): string { return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` }
function parseKey(k: string): Date { const [y, m, d] = k.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)) }
function addDaysKey(k: string, n: number): string { const d = parseKey(k); d.setUTCDate(d.getUTCDate() + n); return keyOf(d) }
function weekdayOf(k: string): number { return parseKey(k).getUTCDay() } // 0=Sun..6=Sat
function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number)
  const d = new Date(Date.UTC(y, m - 1 + delta, 1))
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`
}
function karachiDate(k: string, hhmm: string): Date {
  const [y, mo, d] = k.split('-').map(Number)
  const [h, mi] = hhmm.split(':').map(Number)
  return new Date(Date.UTC(y, mo - 1, d, h - 5, mi))
}
function hashPassword(plain: string): string {
  const salt = randomBytes(16).toString('hex')
  return `${salt}:${scryptSync(plain, salt, 64).toString('hex')}`
}
const isoWeekday = (k: string) => { const w = weekdayOf(k); return w === 0 ? 7 : w } // 1=Mon..7=Sun

const nowKey = keyOf(new Date(Date.now() + 5 * 3600 * 1000))
const THIS_MONTH = nowKey.slice(0, 7)
const PREV_MONTH = shiftMonth(THIS_MONTH, -1)
const YEAR = Number(THIS_MONTH.slice(0, 4))

async function main() {
  console.log('Seeding KINTO HRMS… (today =', nowKey, ')')

  // ─── wipe ───────────────────────────────────────────────────────────────────
  await db.attendanceAudit.deleteMany()
  await db.attendanceApproval.deleteMany()
  await db.attendanceRequest.deleteMany()
  await db.biometricPunch.deleteMany()
  await db.breakLog.deleteMany()
  await db.attendanceLog.deleteMany()
  await db.approvalLog.deleteMany()
  await db.request.deleteMany()
  await db.upload.deleteMany()
  await db.payslip.deleteMany()
  await db.payrollRun.deleteMany()
  await db.loan.deleteMany()
  await db.monthlyAdjustment.deleteMany()
  await db.leaveBalance.deleteMany()
  await db.refreshToken.deleteMany()
  await db.notification.deleteMany()
  await db.auditLog.deleteMany()
  await db.policyRule.deleteMany()
  await db.setting.deleteMany()
  await db.holiday.deleteMany()
  await db.leaveType.deleteMany()
  await db.user.deleteMany({ where: {} })
  await db.team.deleteMany()
  await db.department.deleteMany()
  await db.shift.deleteMany()

  // ─── settings ───────────────────────────────────────────────────────────────
  const settings: [string, string][] = [
    ['company.profile', JSON.stringify({
      name: 'KINTO HRMS',
      address: 'Plot 42, I.I. Chundrigar Road, Karachi 74000, Pakistan',
      phone: '+92 21 3456 7890', email: 'payroll@example.com', regNo: 'REG-KHI-2019-04871',
    })],
    ['payroll.config', JSON.stringify({
      pfRate: 0.05,
      eoobiAmount: 500,
      eoobiThreshold: 26000,
      taxSlabs: [
        { upto: 60000, rate: 0 },
        { upto: 120000, rate: 2.5 },
        { upto: 200000, rate: 7.5 },
        { upto: 320000, rate: 12.5 },
        { upto: null, rate: 15 },
      ],
    })],
    ['biometric.device', JSON.stringify({
      key: 'zk-k50-7f3a', secret: 'zk-hmac-9d41c2-secret', enabled: true, model: 'ZKTeco K50', sn: 'CJ7T201660772',
    })],
    ['app.demo', JSON.stringify({ mode: true })],
  ]
  for (const [key, value] of settings) await db.setting.create({ data: { key, value } })

  // ─── policy rules ───────────────────────────────────────────────────────────
  const rules: [string, string, string, string][] = [
    ['shift.durationMinutes', '540', 'Shift Duration (minutes/day)', 'SHORT_HOURS'],
    ['shift.graceMinutes', '15', 'Daily Grace Period (minutes)', 'SHORT_HOURS'],
    ['shift.weeklyOffDay', '0', 'Default Weekly Day Off (0=Sun … 6=Sat)', 'GENERAL'],
    ['shortHours.conversionMinutes', '480', 'Short Minutes per Leave-Day Deduction', 'SHORT_HOURS'],
    ['shortHours.deductionMode', 'LEAVE_FIRST', 'Short-Hours Deduction Mode', 'SHORT_HOURS'],
    ['leave.shortLeaveMaxHours', '3', 'Max Short-Leave Hours per Request', 'LEAVE_CAPS'],
    ['payroll.overtimeRatePerHour', '250', 'Overtime Rate (PKR/hour)', 'PAYROLL'],
  ]
  for (const [key, value, label, category] of rules) await db.policyRule.create({ data: { key, value, label, category } })

  // ─── shifts ─────────────────────────────────────────────────────────────────
  const shiftEng = await db.shift.create({
    data: { name: 'Engineering Shift (11 AM – 8 PM)', startTime: '11:00', endTime: '20:00', breakMinutes: 60, graceMinutes: 15, expectedMinutes: 540, workingDays: '[1,2,3,4,5]' },
  })
  const shiftGeneral = await db.shift.create({
    data: { name: 'General Shift (9 AM – 6 PM)', startTime: '09:00', endTime: '18:00', breakMinutes: 60, graceMinutes: 15, expectedMinutes: 540, workingDays: '[1,2,3,4,5]' },
  })

  // ─── departments ────────────────────────────────────────────────────────────
  const eng = await db.department.create({ data: { name: 'Engineering', code: 'ENG', shiftId: shiftEng.id } })
  const sales = await db.department.create({ data: { name: 'Sales', code: 'SAL', shiftId: shiftGeneral.id } })
  const hr = await db.department.create({ data: { name: 'HR', code: 'HRD', shiftId: shiftGeneral.id } })
  const accounts = await db.department.create({ data: { name: 'Accounts', code: 'ACC', shiftId: shiftGeneral.id } })

  // ─── leave types ────────────────────────────────────────────────────────────
  const tAnnual = await db.leaveType.create({ data: { name: 'Annual', code: 'ANNUAL', annualQuota: 14, colorCode: '#0D9488', monthlyCap: null, attachmentThreshold: null, isPaid: true } })
  const tCasual = await db.leaveType.create({ data: { name: 'Casual', code: 'CASUAL', annualQuota: 12, colorCode: '#B45309', monthlyCap: 2, attachmentThreshold: null, isPaid: true } })
  const tSick = await db.leaveType.create({ data: { name: 'Sick', code: 'SICK', annualQuota: 10, colorCode: '#BE185D', monthlyCap: 3, attachmentThreshold: 2, isPaid: true } })
  const tUnpaid = await db.leaveType.create({ data: { name: 'Unpaid', code: 'UNPAID', annualQuota: 0, colorCode: '#64748B', monthlyCap: null, attachmentThreshold: null, isPaid: false } })

  // ─── holidays ───────────────────────────────────────────────────────────────
  const holidayDefs: [string, string][] = [
    [`${YEAR}-02-05`, 'Kashmir Day'], [`${YEAR}-03-23`, 'Pakistan Day'], [`${YEAR}-05-01`, 'Labour Day'],
    [`${YEAR}-08-14`, 'Independence Day'], [`${YEAR}-11-09`, 'Iqbal Day'], [`${YEAR}-12-25`, 'Christmas Day'],
    [`${YEAR + 1}-01-01`, 'New Year Day'],
  ]
  for (const [date, name] of holidayDefs) await db.holiday.create({ data: { date, name } })
  const holidayKeys = new Set(holidayDefs.map(([d]) => d))

  // ─── people ─────────────────────────────────────────────────────────────────
  type Spec = {
    key: string; fullName: string; fatherName: string; email: string; pw: string; role: string; code: string
    designation: string; dept?: string; color: string; joined: string; base: number; hrA: number; util: number
    teamLead?: string; manager?: string; employment?: string; phone?: string
  }
  const specs: Spec[] = [
    { key: 'admin', fullName: 'Mohammad Yasin', fatherName: 'Abdul Karim', email: 'admin@hrms.local', pw: 'Admin@123', role: 'SUPER_ADMIN', code: 'NT-000', designation: 'System Administrator', color: '#334155', joined: '2019-01-02', base: 0, hrA: 0, util: 0, phone: '+92 300 0000001' },
    { key: 'hr', fullName: 'Ayesha Khan', fatherName: 'Tariq Khan', email: 'hr@hrms.local', pw: 'Hr@123', role: 'HR_MANAGER', code: 'NT-001', designation: 'HR Manager', dept: 'HR', color: '#0D9488', joined: '2021-06-01', base: 280000, hrA: 30000, util: 10000, phone: '+92 300 0000002' },
    { key: 'accountant', fullName: 'Bilal Ahmed', fatherName: 'Rashid Ahmed', email: 'accountant@hrms.local', pw: 'Acc@123', role: 'ACCOUNTANT', code: 'NT-002', designation: 'Payroll Accountant', dept: 'ACC', color: '#7C3AED', joined: '2022-02-15', base: 220000, hrA: 22000, util: 8000, phone: '+92 300 0000003' },
    { key: 'manager', fullName: 'Omar Siddiqui', fatherName: 'Yousuf Siddiqui', email: 'manager@hrms.local', pw: 'Mgr@123', role: 'MANAGER', code: 'NT-003', designation: 'Head of Engineering', dept: 'ENG', color: '#B45309', joined: '2021-03-10', base: 340000, hrA: 40000, util: 12000, phone: '+92 300 0000004' },
    { key: 'manager2', fullName: 'Nadia Hussain', fatherName: 'Anwar Hussain', email: 'nadia.manager@hrms.local', pw: 'Mgr@123', role: 'MANAGER', code: 'NT-004', designation: 'Head of Sales', dept: 'SAL', color: '#BE185D', joined: '2021-09-01', base: 310000, hrA: 35000, util: 10000, phone: '+92 300 0000005' },
    { key: 'lead1', fullName: 'Hamza Raza', fatherName: 'Iqbal Raza', email: 'lead@hrms.local', pw: 'Lead@123', role: 'TEAM_LEAD', code: 'NT-005', designation: 'Team Lead — Platform', dept: 'ENG', color: '#0369A1', joined: '2022-04-18', base: 230000, hrA: 25000, util: 8000, manager: 'manager', phone: '+92 301 1110001' },
    { key: 'lead2', fullName: 'Zara Sheikh', fatherName: 'Asad Sheikh', email: 'zara.lead@hrms.local', pw: 'Lead@123', role: 'TEAM_LEAD', code: 'NT-006', designation: 'Team Lead — Web Apps', dept: 'ENG', color: '#4D7C0F', joined: '2022-07-11', base: 215000, hrA: 23000, util: 7000, manager: 'manager', phone: '+92 301 1110002' },
    { key: 'lead3', fullName: 'Ali Hassan', fatherName: 'Ghulam Hassan', email: 'ali.lead@hrms.local', pw: 'Lead@123', role: 'TEAM_LEAD', code: 'NT-007', designation: 'Team Lead — Enterprise Sales', dept: 'SAL', color: '#9333EA', joined: '2022-05-23', base: 205000, hrA: 22000, util: 7000, manager: 'manager2', phone: '+92 301 1110003' },
    { key: 'emp1', fullName: 'Fatima Noor', fatherName: 'Mohammad Noor', email: 'employee@hrms.local', pw: 'Emp@123', role: 'EMPLOYEE', code: 'NT-008', designation: 'Senior Software Engineer', dept: 'ENG', color: '#0F766E', joined: '2023-01-16', base: 175000, hrA: 18000, util: 6000, teamLead: 'lead1', manager: 'manager', phone: '+92 302 2220001' },
    { key: 'emp2', fullName: 'Usman Tariq', fatherName: 'Tariq Mehmood', email: 'usman@hrms.local', pw: 'Emp@123', role: 'EMPLOYEE', code: 'NT-009', designation: 'Software Engineer', dept: 'ENG', color: '#1D4ED8', joined: '2023-03-06', base: 150000, hrA: 15000, util: 5000, teamLead: 'lead1', manager: 'manager', phone: '+92 302 2220002' },
    { key: 'emp3', fullName: 'Ahmed Raza', fatherName: 'Kamal Raza', email: 'ahmed@hrms.local', pw: 'Emp@123', role: 'EMPLOYEE', code: 'NT-010', designation: 'Software Engineer', dept: 'ENG', color: '#6D28D9', joined: '2023-08-21', base: 145000, hrA: 14500, util: 5000, teamLead: 'lead2', manager: 'manager', phone: '+92 302 2220003' },
    { key: 'emp4', fullName: 'Hira Iqbal', fatherName: 'Iqbal Masih', email: 'hira@hrms.local', pw: 'Emp@123', role: 'EMPLOYEE', code: 'NT-011', designation: 'QA Engineer', dept: 'ENG', color: '#DB2777', joined: '2023-11-13', base: 130000, hrA: 13000, util: 4500, teamLead: 'lead2', manager: 'manager', phone: '+92 302 2220004' },
    { key: 'emp5', fullName: 'Mahnoor Asif', fatherName: 'Asif Javed', email: 'mahnoor@hrms.local', pw: 'Emp@123', role: 'EMPLOYEE', code: 'NT-012', designation: 'Enterprise Account Executive', dept: 'SAL', color: '#CA8A04', joined: '2023-05-02', base: 140000, hrA: 16000, util: 5000, teamLead: 'lead3', manager: 'manager2', phone: '+92 302 2220005' },
    { key: 'emp6', fullName: 'Danish Ali', fatherName: 'Ali Akbar', email: 'danish@hrms.local', pw: 'Emp@123', role: 'EMPLOYEE', code: 'NT-013', designation: 'Sales Consultant', dept: 'SAL', color: '#0891B2', joined: '2024-02-19', base: 120000, hrA: 12000, util: 4000, teamLead: 'lead3', manager: 'manager2', phone: '+92 302 2220006' },
    { key: 'emp7', fullName: 'Saad Jamil', fatherName: 'Jamil Ahmed', email: 'saad@hrms.local', pw: 'Emp@123', role: 'EMPLOYEE', code: 'NT-014', designation: 'HR Executive', dept: 'HR', color: '#15803D', joined: '2023-10-09', base: 110000, hrA: 11000, util: 4000, teamLead: 'hr', phone: '+92 302 2220007' },
    { key: 'emp8', fullName: 'Rabia Butt', fatherName: 'Salim Butt', email: 'rabia@hrms.local', pw: 'Emp@123', role: 'EMPLOYEE', code: 'NT-015', designation: 'Accounts Officer', dept: 'ACC', color: '#B91C1C', joined: '2024-04-01', base: 105000, hrA: 10000, util: 3500, teamLead: 'accountant', phone: '+92 302 2220008' },
  ]

  const deptMap: Record<string, string> = { ENG: eng.id, SAL: sales.id, HR: hr.id, ACC: accounts.id }
  const shiftForDept: Record<string, string> = { ENG: shiftEng.id, SAL: shiftGeneral.id, HR: shiftGeneral.id, ACC: shiftGeneral.id }

  const users: Record<string, { id: string; fullName: string; employeeCode: string; designation: string; role: string; baseSalary: number; hrAllowance: number; utilityAllowance: number; email: string; departmentId: string | null }> = {}
  for (const s of specs) {
    const dobYear = 1985 + rand(0, 15)
    const u = await db.user.create({
      data: {
        email: s.email, passwordHash: hashPassword(s.pw), fullName: s.fullName, fatherName: s.fatherName,
        motherName: `Bibi ${s.fullName.split(' ')[0]}`,
        role: s.role, employeeCode: s.code, designation: s.designation,
        departmentId: s.dept ? deptMap[s.dept] : null,
        shiftId: s.dept ? shiftForDept[s.dept] : null,
        joiningDate: new Date(s.joined), avatarColor: s.color,
        baseSalary: s.base, hrAllowance: s.hrA, utilityAllowance: s.util,
        employmentStatus: s.employment ?? 'Permanent', phone: s.phone ?? null,
        personalEmail: `${s.key}.${rand(10, 99)}@gmail.com`,
        cnic: `${rand(31000, 42999)}-${rand(1000000, 9999999)}-${rand(1, 9)}`,
        cnicExpiry: `${rand(2027, 2036)}-${String(rand(1, 12)).padStart(2, '0')}-${String(rand(1, 28)).padStart(2, '0')}`,
        drivingLicense: rand(0, 3) === 0 ? null : `KHI-${rand(2015, 2025)}-${rand(100000, 999999)}`,
        passportNo: rand(0, 3) === 0 ? null : `AB${rand(1000000, 9999999)}`,
        passportExpiry: `${rand(2027, 2034)}-${String(rand(1, 12)).padStart(2, '0')}-${String(rand(1, 28)).padStart(2, '0')}`,
        dateOfBirth: new Date(`${dobYear}-${String(rand(1, 12)).padStart(2, '0')}-${String(rand(1, 28)).padStart(2, '0')}T00:00:00Z`),
        gender: ['Fatima', 'Hira', 'Mahnoor', 'Zara', 'Nadia', 'Rabia', 'Ayesha'].some((n) => s.fullName.startsWith(n)) ? 'Female' : 'Male',
        maritalStatus: ['Married', 'Single', 'Single', 'Married'][rand(0, 3)],
        bloodGroup: ['A+', 'B+', 'O+', 'AB+', 'A-', 'O-'][rand(0, 5)],
        religion: 'Islam',
        nationality: 'Pakistani',
        emergencyContactName: `${['Aslam', 'Rashid', 'Nasir', 'Kiran', 'Sana'][rand(0, 4)]} ${s.fullName.split(' ').slice(-1)[0]}`,
        emergencyContactPhone: `+92 3${rand(0, 4)}${rand(0, 9)} ${rand(7000000, 9999999)}`,
        address: `House ${rand(1, 400)}, Block ${rand(1, 6)}, Karachi`,
        bankName: ['MEZN Bank', 'HBL', 'UBL', 'MCB', 'Bank Alfalah'][rand(0, 4)],
        bankIban: `PK${rand(10, 99)}MEZN${rand(100000000000, 999999999999)}`,
      },
    })
    users[s.key] = {
      id: u.id, fullName: u.fullName, employeeCode: u.employeeCode, designation: u.designation,
      role: u.role, baseSalary: u.baseSalary, hrAllowance: u.hrAllowance, utilityAllowance: u.utilityAllowance,
      email: u.email, departmentId: u.departmentId,
    }
  }

  // reporting lines
  for (const s of specs) {
    if (s.teamLead || s.manager) {
      await db.user.update({
        where: { id: users[s.key].id },
        data: { teamLeadId: s.teamLead ? users[s.teamLead].id : null, managerId: s.manager ? users[s.manager].id : null },
      })
    }
  }
  // department heads
  await db.department.update({ where: { id: eng.id }, data: { managerId: users['manager'].id } })
  await db.department.update({ where: { id: sales.id }, data: { managerId: users['manager2'].id } })
  await db.department.update({ where: { id: hr.id }, data: { managerId: users['hr'].id } })
  await db.department.update({ where: { id: accounts.id }, data: { managerId: users['accountant'].id } })

  // ─── teams ──────────────────────────────────────────────────────────────────
  const tPlatform = await db.team.create({ data: { name: 'Core Platform', departmentId: eng.id, teamLeadId: users['lead1'].id, shiftId: shiftEng.id } })
  const tWebApps = await db.team.create({ data: { name: 'Web Applications', departmentId: eng.id, teamLeadId: users['lead2'].id, shiftId: shiftEng.id } })
  const tEnterprise = await db.team.create({ data: { name: 'Enterprise Sales', departmentId: sales.id, teamLeadId: users['lead3'].id, shiftId: shiftGeneral.id } })

  const teamMembership: Record<string, string> = {
    lead1: tPlatform.id, emp1: tPlatform.id, emp2: tPlatform.id,
    lead2: tWebApps.id, emp3: tWebApps.id, emp4: tWebApps.id,
    lead3: tEnterprise.id, emp5: tEnterprise.id, emp6: tEnterprise.id,
  }
  for (const [k, teamId] of Object.entries(teamMembership)) {
    await db.user.update({ where: { id: users[k].id }, data: { teamId } })
  }

  // ─── leave balances (everyone except SUPER_ADMIN) ───────────────────────────
  const balanceSpecs = specs.filter((s) => s.role !== 'SUPER_ADMIN')
  for (const s of balanceSpecs) {
    for (const t of [tAnnual, tCasual, tSick, tUnpaid]) {
      await db.leaveBalance.create({
        data: {
          userId: users[s.key].id, leaveTypeId: t.id, year: YEAR,
          carryForward: t.code === 'ANNUAL' ? rand(0, 4) : 0,
        },
      })
    }
  }

  // ─── demo documents (uploads dir + a tiny valid PDF certificate) ────────────
  mkdirSync('uploads', { recursive: true })
  const miniPdf = Buffer.from(
    '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]>>endobj\nxref\n0 4\ntrailer<</Size 4/Root 1 0 R>>\n%%EOF',
  )
  const certPath = join('uploads', `${randomUUID()}.pdf`)
  writeFileSync(certPath, miniPdf)

  // ─── approved / pending / rejected leave requests ───────────────────────────
  function daysAgoKey(n: number): string { return addDaysKey(nowKey, -n) }

  // 1. Mahnoor — approved Sick leave, 2 days this month (triggers certificate rule on 3rd request)
  const sickFrom = daysAgoKey(6)
  const sickTo = daysAgoKey(5)
  const rSick = await db.request.create({
    data: {
      userId: users['emp5'].id, type: 'LEAVE', leaveTypeId: tSick.id,
      startDate: karachiDate(sickFrom, '00:00'), endDate: karachiDate(sickTo, '00:00'),
      dayCount: 2, reason: 'Viral fever — doctor advised bed rest.',
      status: 'APPROVED', currentStage: 'DONE',
      attachmentId: (await db.upload.create({
        data: { name: 'medical-certificate.pdf', mime: 'application/pdf', size: miniPdf.length, path: certPath, uploadedById: users['emp5'].id },
      })).id,
    },
  })
  await db.approvalLog.create({ data: { requestId: rSick.id, approverId: users['lead3'].id, level: 'TEAM_LEAD', action: 'APPROVED', comment: 'Get well soon.' } })
  await db.approvalLog.create({ data: { requestId: rSick.id, approverId: users['manager2'].id, level: 'MANAGER', action: 'APPROVED', comment: 'Approved — rest well.' } })
  await db.leaveBalance.update({
    where: { userId_leaveTypeId_year: { userId: users['emp5'].id, leaveTypeId: tSick.id, year: YEAR } },
    data: { availed: { increment: 2 } },
  })

  // 2. Fatima — pending at MANAGER stage (Annual, 3 days next week)
  const fFrom = addDaysKey(nowKey, 4); const fTo = addDaysKey(nowKey, 6)
  const rFatima = await db.request.create({
    data: {
      userId: users['emp1'].id, type: 'LEAVE', leaveTypeId: tAnnual.id,
      startDate: karachiDate(fFrom, '00:00'), endDate: karachiDate(fTo, '00:00'),
      dayCount: 3, reason: 'Family wedding out of city.',
      status: 'PENDING_MANAGER', currentStage: 'MANAGER',
    },
  })
  await db.approvalLog.create({ data: { requestId: rFatima.id, approverId: users['lead1'].id, level: 'TEAM_LEAD', action: 'APPROVED', comment: 'Work handed over to Usman.' } })
  await db.leaveBalance.update({
    where: { userId_leaveTypeId_year: { userId: users['emp1'].id, leaveTypeId: tAnnual.id, year: YEAR } },
    data: { pending: { increment: 3 } },
  })
  await db.notification.create({ data: { userId: users['manager'].id, title: 'Request escalated to final approval', body: 'Fatima Noor · Annual — awaiting your final approval.', type: 'APPROVAL' } })

  // 3. Usman — pending at TEAM_LEAD stage (Casual, 1 day)
  const uFrom = addDaysKey(nowKey, 2)
  const rUsman = await db.request.create({
    data: {
      userId: users['emp2'].id, type: 'LEAVE', leaveTypeId: tCasual.id,
      startDate: karachiDate(uFrom, '00:00'), endDate: karachiDate(uFrom, '00:00'),
      dayCount: 1, reason: 'CNIC renewal at NADRA office.',
      status: 'PENDING_TEAM_LEAD', currentStage: 'TEAM_LEAD',
    },
  })
  await db.leaveBalance.update({
    where: { userId_leaveTypeId_year: { userId: users['emp2'].id, leaveTypeId: tCasual.id, year: YEAR } },
    data: { pending: { increment: 1 } },
  })
  await db.notification.create({ data: { userId: users['lead1'].id, title: 'New leave request needs your approval', body: 'Usman Tariq · Casual — 1 day.', type: 'APPROVAL' } })

  // 4. Ahmed — rejected Casual leave
  const aFrom = daysAgoKey(9)
  const rAhmed = await db.request.create({
    data: {
      userId: users['emp3'].id, type: 'LEAVE', leaveTypeId: tCasual.id,
      startDate: karachiDate(aFrom, '00:00'), endDate: karachiDate(aFrom, '00:00'),
      dayCount: 1, reason: 'Personal errand.',
      status: 'REJECTED', currentStage: 'DONE',
    },
  })
  await db.approvalLog.create({ data: { requestId: rAhmed.id, approverId: users['lead2'].id, level: 'TEAM_LEAD', action: 'REJECTED', comment: 'Sprint release day — please plan for next week.' } })

  // 5. Danish — approved Travel (2 days last week)
  const dFrom = daysAgoKey(8); const dTo = daysAgoKey(7)
  const rDanish = await db.request.create({
    data: {
      userId: users['emp6'].id, type: 'TRAVEL',
      startDate: karachiDate(dFrom, '00:00'), endDate: karachiDate(dTo, '00:00'),
      dayCount: 2, reason: 'Client onboarding — Lahore site visit.',
      status: 'APPROVED', currentStage: 'DONE',
    },
  })
  await db.approvalLog.create({ data: { requestId: rDanish.id, approverId: users['lead3'].id, level: 'TEAM_LEAD', action: 'APPROVED', comment: 'Carry the demo kit.' } })
  await db.approvalLog.create({ data: { requestId: rDanish.id, approverId: users['manager2'].id, level: 'MANAGER', action: 'APPROVED' } })

  // 6. Hira — approved Annual leave in PREVIOUS month (for payroll history)
  const prevFrom = `${PREV_MONTH}-20`; const prevTo = `${PREV_MONTH}-21`
  const rHira = await db.request.create({
    data: {
      userId: users['emp4'].id, type: 'LEAVE', leaveTypeId: tAnnual.id,
      startDate: karachiDate(prevFrom, '00:00'), endDate: karachiDate(prevTo, '00:00'),
      dayCount: 2, reason: 'Short family trip.',
      status: 'APPROVED', currentStage: 'DONE',
    },
  })
  await db.approvalLog.create({ data: { requestId: rHira.id, approverId: users['lead2'].id, level: 'TEAM_LEAD', action: 'APPROVED' } })
  await db.approvalLog.create({ data: { requestId: rHira.id, approverId: users['manager'].id, level: 'MANAGER', action: 'APPROVED' } })
  await db.leaveBalance.update({
    where: { userId_leaveTypeId_year: { userId: users['emp4'].id, leaveTypeId: tAnnual.id, year: YEAR } },
    data: { availed: { increment: 2 } },
  })

  // ─── 3-tier attendance regularization requests ──────────────────────────────
  const ar1Date = daysAgoKey(1)
  const ar1 = await db.attendanceRequest.create({
    data: {
      userId: users['emp2'].id, date: ar1Date, requestedCheckIn: '11:00', requestedCheckOut: '20:00',
      reason: 'Forgot to punch out — device was under maintenance after 8 PM.',
      status: 'PENDING_TEAM_LEAD', currentStage: 'TEAM_LEAD',
    },
  })
  const ar2Date = daysAgoKey(3)
  const ar2 = await db.attendanceRequest.create({
    data: {
      userId: users['emp4'].id, date: ar2Date, requestedCheckIn: '11:05', requestedCheckOut: '20:02',
      reason: 'Punched with wrong finger — machine rejected both punches.',
      status: 'PENDING_MANAGER', currentStage: 'MANAGER',
    },
  })
  await db.attendanceApproval.create({ data: { requestId: ar2.id, approverId: users['lead2'].id, level: 'TEAM_LEAD', action: 'APPROVED', comment: 'Verified with the device log.' } })
  const ar3Date = daysAgoKey(4)
  const ar3 = await db.attendanceRequest.create({
    data: {
      userId: users['emp5'].id, date: ar3Date, requestedCheckIn: '09:00', requestedCheckOut: '18:00',
      reason: 'Biometric machine was offline the whole day (power outage).',
      status: 'PENDING_HR', currentStage: 'HR',
    },
  })
  await db.attendanceApproval.create({ data: { requestId: ar3.id, approverId: users['lead3'].id, level: 'TEAM_LEAD', action: 'APPROVED' } })
  await db.attendanceApproval.create({ data: { requestId: ar3.id, approverId: users['manager2'].id, level: 'MANAGER', action: 'APPROVED' } })

  // ─── loans & adjustments ────────────────────────────────────────────────────
  await db.loan.create({ data: { userId: users['emp2'].id, name: 'Internal Loan — Bike', loanAmount: 120000, installments: 10, installmentAmount: 12000, paidInstallments: 3, startDate: shiftMonth(THIS_MONTH, -3) } })
  await db.loan.create({ data: { userId: users['emp5'].id, name: 'Internal Loan — Wedding', loanAmount: 60000, installments: 6, installmentAmount: 10000, paidInstallments: 2, startDate: shiftMonth(THIS_MONTH, -2) } })
  await db.monthlyAdjustment.create({ data: { userId: users['emp1'].id, month: THIS_MONTH, bonus: 25000, note: 'Q3 delivery star award' } })
  await db.monthlyAdjustment.create({ data: { userId: users['emp2'].id, month: THIS_MONTH, arrears: 8000, note: 'Late reimbursement — Oct travel claim' } })

  // ─── attendance generation ──────────────────────────────────────────────────
  type ShiftDef = { start: string; end: string; expected: number; grace: number }
  const shiftDefs: Record<string, ShiftDef> = {
    ENG: { start: '11:00', end: '20:00', expected: 540, grace: 15 },
    GEN: { start: '09:00', end: '18:00', expected: 540, grace: 15 },
  }
  const deptShift: Record<string, keyof typeof shiftDefs> = { ENG: 'ENG', SAL: 'GEN', HR: 'GEN', ACC: 'GEN' }
  const leaveDaysByUser = new Map<string, Set<string>>()
  const travelDaysByUser = new Map<string, Set<string>>()
  for (const [k, from, to] of [['emp5', sickFrom, sickTo], ['emp1', fFrom, fTo], ['emp2', uFrom, uFrom], ['emp6', dFrom, dTo], ['emp4', prevFrom, prevTo], ['emp3', aFrom, aFrom]] as [string, string, string][]) {
    if (!leaveDaysByUser.has(k)) leaveDaysByUser.set(k, new Set())
    let cur = from
    while (cur <= to) { leaveDaysByUser.get(k)!.add(cur); cur = addDaysKey(cur, 1) }
  }
  leaveDaysByUser.get('emp1')!.clear() // pending leave — not yet on timesheet
  leaveDaysByUser.get('emp2')!.clear()
  leaveDaysByUser.get('emp3')!.clear() // rejected
  let cur = dFrom; while (cur <= dTo) { (travelDaysByUser.get('emp6') ?? travelDaysByUser.set('emp6', new Set()).get('emp6')!).add(cur); cur = addDaysKey(cur, 1) }

  // pending regularization days look like missing punches
  const missingOnlyDays = new Map<string, Set<string>>([
    ['emp2', new Set([ar1Date])],
    ['emp4', new Set([ar2Date])],
    ['emp5', new Set([ar3Date])],
  ])

  async function generateAttendance(userKey: string, month: string) {
    const s = specs.find((x) => x.key === userKey)!
    if (!s.dept) return
    const def = shiftDefs[deptShift[s.dept]]
    const [y, m] = month.split('-').map(Number)
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
    const upTo = month === THIS_MONTH ? Number(nowKey.slice(8, 10)) : last
    for (let day = 1; day <= upTo; day++) {
      const key = `${month}-${pad(day)}`
      if (parseKey(key) < parseKey(s.joined)) continue
      const wd = isoWeekday(key)
      if (wd >= 6) { await createLog(userKey, key, { status: 'WEEKEND' }); continue }
      if (holidayKeys.has(key)) { await createLog(userKey, key, { status: 'HOLIDAY' }); continue }
      if (leaveDaysByUser.get(userKey)?.has(key)) { await createLog(userKey, key, { status: 'FULL_LEAVE' }); continue }
      if (travelDaysByUser.get(userKey)?.has(key)) { await createLog(userKey, key, { status: 'TRAVEL' }); continue }
      if (missingOnlyDays.get(userKey)?.has(key)) {
        await createLog(userKey, key, { status: 'MISSING', checkIn: def.start, checkOut: null })
        continue
      }
      const roll = rng()
      if (roll < 0.015) { await createLog(userKey, key, { status: 'ABSENT' }); continue }
      if (roll < 0.035) { // WFH
        const inM = rand(-4, 6); await createLog(userKey, key, { status: 'WFH', isWFH: true, checkIn: addMin(def.start, inM), checkOut: addMin(def.end, rand(-8, 12)) })
        continue
      }
      if (roll < 0.043) { // official duty
        await createLog(userKey, key, { status: 'OFFICIAL_DUTY', checkIn: def.start, checkOut: def.end }); continue
      }
      if (roll < 0.055) { // short duration — early leave
        const outM = rand(150, 300) // minutes before end
        const out = addMin(def.end, -outM)
        const worked = def.expected - outM
        await createLog(userKey, key, { status: 'SHORT_DURATION', checkIn: def.start, checkOut: out, worked, short: outM })
        continue
      }
      if (roll < 0.075) { // late but full day
        const late = rand(16, 55)
        await createLog(userKey, key, { status: 'PRESENT', checkIn: addMin(def.start, late), checkOut: def.end, worked: def.expected - late, short: late, late })
        continue
      }
      if (roll < 0.085 && month === THIS_MONTH && day === upTo && key === nowKey) { /* handled below */ }
      // normal on-time day
      const inJit = rand(-8, 6)
      const outJit = rand(-4, 14)
      const inK = addMin(def.start, inJit)
      const outK = addMin(def.end, outJit)
      const worked = def.expected - inJit + outJit
      const short = Math.max(0, def.expected - worked)
      const late = Math.max(0, inJit - def.grace)
      if (key === nowKey) {
        await createLog(userKey, key, { status: 'PRESENT', checkIn: inK, checkOut: null, worked: Math.min(worked, minutesSinceKarachi(def.start)), short: 0, late })
      } else {
        await createLog(userKey, key, { status: short > 0 ? 'SHORT_DURATION' : 'PRESENT', checkIn: inK, checkOut: outK, worked, short, late })
      }
    }
  }

  function minutesSinceKarachi(startHHmm: string): number {
    const [h, mi] = startHHmm.split(':').map(Number)
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Karachi', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date())
    const nowH = Number(parts.find((p) => p.type === 'hour')?.value ?? '0')
    const nowM = Number(parts.find((p) => p.type === 'minute')?.value ?? '0')
    return Math.max(15, nowH * 60 + nowM - (h * 60 + mi))
  }
  function addMin(hhmm: string, delta: number): string {
    const [h, m] = hhmm.split(':').map(Number)
    let t = h * 60 + m + delta
    t = ((t % 1440) + 1440) % 1440
    return `${pad(Math.floor(t / 60))}:${pad(t % 60)}`
  }
  async function createLog(userKey: string, key: string, o: { status: string; checkIn?: string | null; checkOut?: string | null; worked?: number; short?: number; late?: number; isWFH?: boolean }) {
    const s = specs.find((x) => x.key === userKey)!
    const def = shiftDefs[deptShift[s.dept!]]
    const worked = o.worked ?? (o.status === 'PRESENT' || o.status === 'WFH' || o.status === 'OFFICIAL_DUTY' ? def.expected : 0)
    const short = o.short ?? 0
    const late = o.late ?? 0
    const early = 0
    await db.attendanceLog.create({
      data: {
        userId: users[userKey].id, dateKey: key,
        checkIn: o.checkIn ? karachiDate(key, o.checkIn) : null,
        checkOut: o.checkOut ? karachiDate(key, o.checkOut) : null,
        status: o.status, expectedMinutes: def.expected, workedMinutes: worked,
        shortMinutes: short, lateMinutes: late, earlyMinutes: early,
        breakMinutes: o.checkOut ? def.expected - (worked + short) >= 0 ? 0 : 0 : 0,
        isWFH: o.isWFH ?? false,
        source: 'BIOMETRIC',
      },
    })
  }

  for (const s of specs) {
    if (s.role === 'SUPER_ADMIN') continue
    await generateAttendance(s.key, PREV_MONTH)
    await generateAttendance(s.key, THIS_MONTH)
  }

  // biometric punch audit trail for today (device sync demo)
  for (const s of specs) {
    if (s.role === 'SUPER_ADMIN' || !s.dept) continue
    const def = shiftDefs[deptShift[s.dept]]
    const log = await db.attendanceLog.findUnique({ where: { userId_dateKey: { userId: users[s.key].id, dateKey: nowKey } } })
    if (log?.checkIn) {
      await db.biometricPunch.create({
        data: {
          pin: s.code, userId: users[s.key].id, ts: log.checkIn, status: 0,
          deviceSn: 'CJ7T201660772', ip: '192.168.1.110',
          raw: `PIN=${s.code}\tTIME=${log.checkIn.toISOString().slice(0, 19).replace('T', ' ')}\tSTATUS=0`,
          dedupHash: createHash('sha256').update(`${s.code}|${log.checkIn.toISOString()}|0`).digest('hex'),
          processed: true,
        },
      })
    }
  }

  // ─── PREVIOUS month payroll run (FINALIZED) ─────────────────────────────────
  const pfRate = 0.05, eoobiAmount = 500, eoobiThreshold = 26000
  const taxSlabs = [
    { upto: 60000, rate: 0 }, { upto: 120000, rate: 2.5 }, { upto: 200000, rate: 7.5 },
    { upto: 320000, rate: 12.5 }, { upto: null, rate: 15 },
  ] as { upto: number | null; rate: number }[]
  function monthlyTax(taxable: number): number {
    let tax = 0, prev = 0
    for (const slab of taxSlabs) {
      const upper = slab.upto == null ? Infinity : slab.upto
      if (taxable > prev) {
        tax += ((Math.min(taxable, upper) - prev) * slab.rate) / 100
        prev = upper
      }
    }
    return Math.round(tax)
  }

  const run = await db.payrollRun.create({
    data: { month: PREV_MONTH, status: 'FINALIZED', createdById: users['accountant'].id, finalizedAt: new Date() },
  })
  let runGross = 0, runDed = 0, runNet = 0
  for (const s of specs) {
    if (s.role === 'SUPER_ADMIN') continue
    const u = users[s.key]
    const gross = u.baseSalary + u.hrAllowance + u.utilityAllowance
    const pf = Math.round(u.baseSalary * pfRate)
    const eoobi = u.baseSalary >= eoobiThreshold ? eoobiAmount : 0
    const logs = await db.attendanceLog.findMany({ where: { userId: u.id, dateKey: { startsWith: PREV_MONTH } } })
    const shortMin = logs.reduce((acc, l) => acc + (['PRESENT', 'SHORT_DURATION', 'WFH', 'SHORT_LEAVE'].includes(l.status) ? l.shortMinutes : 0), 0)
    const lateMin = logs.reduce((acc, l) => acc + l.lateMinutes, 0)
    const leaveEquiv = Math.floor(shortMin / 480)
    const dayRate = gross / 22
    const fromBalance = Math.min(leaveEquiv, 1)
    const shortDed = Math.round((leaveEquiv - fromBalance) * dayRate)
    const unpaidDays = 0
    const leaveDed = Math.round(unpaidDays * dayRate)
    const loan = s.key === 'emp2' ? 12000 : s.key === 'emp5' ? 10000 : 0
    const taxable = gross - pf - eoobi
    const tax = monthlyTax(taxable)
    const totalDed = pf + eoobi + tax + loan + shortDed + leaveDed
    const net = gross - totalDed
    runGross += gross; runDed += totalDed; runNet += net
    await db.payslip.create({
      data: {
        runId: run.id, userId: u.id,
        employeeCode: u.employeeCode, fullName: u.fullName, fatherName: s.fatherName,
        designation: u.designation, departmentName: s.dept === 'ENG' ? 'Engineering' : s.dept === 'SAL' ? 'Sales' : s.dept === 'HR' ? 'HR' : 'Accounts',
        employmentStatus: s.employment ?? 'Permanent', joiningDate: new Date(s.joined),
        workingDays: 22, workedDays: 22 - (leaveEquiv > 0 ? 0 : 0), paidLeaves: s.key === 'emp4' ? 2 : 0,
        unpaidLeaveDays: unpaidDays, shortMinutes: shortMin, lateMinutes: lateMin,
        leaveDaysEquivalent: leaveEquiv, shortConvertedFromBalance: fromBalance,
        basicSalary: u.baseSalary, hrAllowance: u.hrAllowance, utilityAllowance: u.utilityAllowance,
        providentFundEarning: pf, bonus: 0, arrears: 0, overtimeAmount: 0, grossPay: gross,
        internalLoan: loan, incomeTax: tax, providentFund: pf, eoobi, taxAdjustment: 0,
        shortHourDeduction: shortDed, leaveDeduction: leaveDed, totalDeduction: totalDed, netPay: net,
        loanStatus: loan > 0 ? JSON.stringify({ loanAmount: s.key === 'emp2' ? 120000 : 60000, instNo: s.key === 'emp2' ? 4 : 3, instAmount: loan, paid: s.key === 'emp2' ? 36000 : 20000, balance: s.key === 'emp2' ? 84000 : 40000 }) : null,
        taxStatus: JSON.stringify({ taxableEarning: taxable, taxLiability: tax, taxPaid: tax, balance: 0 }),
      },
    })
  }
  await db.payrollRun.update({ where: { id: run.id }, data: { totalGross: runGross, totalDeductions: runDed, totalNet: runNet } })

  // ─── audit log samples ──────────────────────────────────────────────────────
  await db.auditLog.createMany({
    data: [
      { actorId: users['hr'].id, actorName: 'Ayesha Khan', actorRole: 'HR_MANAGER', targetUserId: users['emp3'].id, targetName: 'Ahmed Raza', entityType: 'SALARY', fieldName: 'hrAllowance', oldValue: '14000', newValue: '14500', reason: 'Annual allowance revision 2025', ipAddress: '10.0.4.12' },
      { actorId: users['admin'].id, actorName: 'Mohammad Yasin', actorRole: 'SUPER_ADMIN', targetUserId: users['emp5'].id, targetName: 'Mahnoor Asif', entityType: 'LEAVE_QUOTA', fieldName: 'annualQuota', oldValue: '14', newValue: '16', reason: 'Retention exception approved by COO', ipAddress: '10.0.4.2' },
      { actorId: users['hr'].id, actorName: 'Ayesha Khan', actorRole: 'HR_MANAGER', targetUserId: users['emp2'].id, targetName: 'Usman Tariq', entityType: 'SHIFT', fieldName: 'shiftId', oldValue: 'General Shift', newValue: 'Engineering Shift', reason: 'Moved to Platform pod', ipAddress: '10.0.4.12' },
    ],
  })

  // ─── notifications for demo employee ────────────────────────────────────────
  await db.notification.create({ data: { userId: users['emp1'].id, title: 'First-level approval received', body: 'Your Annual leave request has moved to the Manager approval stage.', type: 'INFO' } })
  await db.notification.create({ data: { userId: users['emp6'].id, title: 'Request approved', body: 'Your Travel request was fully approved.', type: 'APPROVAL' } })

  console.log('Seed complete.')
  console.log('  accounts: admin@hrms.local / Admin@123  (SUPER_ADMIN — no personal attendance/leave)')
  console.log('            hr@hrms.local / Hr@123        (HR MANAGER — dual role)')
  console.log('            accountant@hrms.local / Acc@123')
  console.log('            manager@hrms.local / Mgr@123   nadia.manager@hrms.local / Mgr@123')
  console.log('            lead@hrms.local / Lead@123     employee@hrms.local / Emp@123')
}

main()
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(() => db.$disconnect())
