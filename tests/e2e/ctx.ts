import { PrismaClient } from '@prisma/client'
import { Client, DEMO_PASSWORD, DOMAIN, hashPassword } from './lib'

export const db = new PrismaClient()

export const MFA_ROLES = ['SUPER_ADMIN', 'HR_MANAGER', 'ACCOUNTANT', 'ACCOUNTS_MANAGER', 'MANAGER']
export const ORG_ADMIN = ['SUPER_ADMIN', 'HR_MANAGER']
export const ACCOUNTS = ['ACCOUNTANT', 'ACCOUNTS_MANAGER']
export const PAYROLL_OPERATORS = ['SUPER_ADMIN', ...ACCOUNTS]
export const ALL_ROLES = ['SUPER_ADMIN', 'HR_MANAGER', 'ACCOUNTANT', 'ACCOUNTS_MANAGER', 'MANAGER', 'TEAM_LEAD', 'EMPLOYEE']

export type DU = {
  id: string; email: string; fullName: string; role: string; designation: string; designationId: string | null
  departmentId: string | null; departmentName: string; employeeCode: string; teamId: string | null
  teamLeadId: string | null; managerId: string | null; isDemo: boolean
  shift: { startTime: string; endTime: string; graceMinutes: number; expectedMinutes: number; workingDays: number[] }
}

export const ctx = {
  users: [] as DU[],                          // every ACTIVE user (demo + the user's real accounts)
  byId: new Map<string, DU>(),
  byEmail: new Map<string, DU>(),
  clients: new Map<string, Client>(),         // demo users that are signed in, by e-mail
  backupCodes: new Map<string, string[]>(),   // backup recovery codes issued at enrolment
  totpSecret: new Map<string, string>(),      // authenticator secrets the harness enrolled (reset in teardown)
  enrolled: new Set<string>(),                // user ids whose MFA state the harness changed
  createdUserIds: [] as string[],             // throwaway accounts made by tests → purged in teardown
  leaveTypes: [] as { id: string; code: string; name: string; annualQuota: number; monthlyCap: number | null; attachmentThreshold: number | null; isPaid: boolean }[],
  departments: [] as { id: string; name: string; code: string }[],
  holidays: new Set<string>(),
}

const DEFAULT_SHIFT = { startTime: '09:00', endTime: '18:00', graceMinutes: 15, expectedMinutes: 540, workingDays: [1, 2, 3, 4, 5] }

export async function ensureSysadmin() {
  const email = `sysadmin${DOMAIN}`
  if (await db.user.findUnique({ where: { email } })) return
  await db.user.create({
    data: {
      email, passwordHash: hashPassword(DEMO_PASSWORD), fullName: 'Demo System Admin', role: 'SUPER_ADMIN', employeeCode: 'DM-091',
      designation: 'System Administrator', joiningDate: new Date('2020-01-01T00:00:00Z'), employmentStatus: 'Permanent',
      mustChangePassword: false, avatarColor: '#0F766E',
    },
  })
  console.log(`   created ${email}`)
}

export async function loadWorld() {
  const rows = await db.user.findMany({
    where: { isActive: true },
    include: { department: { include: { shift: true } }, team: { include: { shift: true } }, shift: true },
  })
  ctx.users = rows.map((u): DU => {
    const s = u.shift ?? u.team?.shift ?? u.department?.shift
    let days = DEFAULT_SHIFT.workingDays
    try { if (s) days = JSON.parse(s.workingDays) } catch { /* default */ }
    return {
      id: u.id, email: u.email, fullName: u.fullName, role: u.role, designation: u.designation, designationId: u.designationId,
      departmentId: u.departmentId, departmentName: u.department?.name ?? '—', employeeCode: u.employeeCode, teamId: u.teamId,
      teamLeadId: u.teamLeadId, managerId: u.managerId, isDemo: u.email.endsWith(DOMAIN),
      shift: s ? { startTime: s.startTime, endTime: s.endTime, graceMinutes: s.graceMinutes, expectedMinutes: s.expectedMinutes, workingDays: days } : DEFAULT_SHIFT,
    }
  })
  ctx.byId = new Map(ctx.users.map((u) => [u.id, u]))
  ctx.byEmail = new Map(ctx.users.map((u) => [u.email, u]))
  ctx.leaveTypes = await db.leaveType.findMany({ select: { id: true, code: true, name: true, annualQuota: true, monthlyCap: true, attachmentThreshold: true, isPaid: true } })
  ctx.departments = await db.department.findMany({ select: { id: true, name: true, code: true } })
  ctx.holidays = new Set((await db.holiday.findMany()).map((h) => h.date))
}

/** Mirror of the server's visibleUserIds (src/lib/hrms/rbac.ts) — the oracle for scope checks. */
export function expectedVisible(u: DU): Set<string> {
  const all = ctx.users
  if (['SUPER_ADMIN', 'HR_MANAGER', 'ACCOUNTANT', 'ACCOUNTS_MANAGER'].includes(u.role)) return new Set(all.map((x) => x.id))
  if (u.role === 'MANAGER') {
    const leads = all.filter((x) => x.managerId === u.id)
    const leadIds = new Set(leads.map((x) => x.id))
    return new Set([u.id, ...leads.map((x) => x.id), ...all.filter((x) => x.teamLeadId && leadIds.has(x.teamLeadId)).map((x) => x.id)])
  }
  if (u.role === 'TEAM_LEAD') return new Set([u.id, ...all.filter((x) => x.teamLeadId === u.id).map((x) => x.id)])
  return new Set([u.id])
}

export const demoUsers = () => ctx.users.filter((u) => u.isDemo)
export const client = (u: DU | string) => {
  const email = typeof u === 'string' ? u : u.email
  const c = ctx.clients.get(email)
  if (!c) throw new Error(`no signed-in client for ${email}`)
  return c
}
export const userBy = (pred: (u: DU) => boolean, what = 'user') => {
  const u = ctx.users.find(pred)
  if (!u) throw new Error(`test data missing: ${what}`)
  return u
}

/** Run `fn` over items with limited concurrency. */
export async function pool<T>(items: T[], size: number, fn: (x: T, i: number) => Promise<void>) {
  let next = 0
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) { const i = next++; await fn(items[i], i) }
  }))
}

/** Remove the demo data a previous run generated so every run starts from the same state (demo accounts only). */
export async function resetAttendanceData(fromKey: string) {
  const demo = { user: { email: { endsWith: DOMAIN } } }
  const logs = await db.attendanceLog.findMany({ where: { ...demo, dateKey: { gte: fromKey } }, select: { id: true } })
  await db.attendanceAudit.deleteMany({ where: { attendanceId: { in: logs.map((l) => l.id) } } })
  await db.breakLog.deleteMany({ where: { attendanceId: { in: logs.map((l) => l.id) } } })
  await db.attendanceLog.deleteMany({ where: { id: { in: logs.map((l) => l.id) } } })
  await db.biometricPunch.deleteMany({ where: { ...demo, ts: { gte: new Date(`${fromKey}T00:00:00Z`) } } })
  const areqs = await db.attendanceRequest.findMany({ where: { ...demo }, select: { id: true } })
  await db.attendanceApproval.deleteMany({ where: { requestId: { in: areqs.map((r) => r.id) } } })
  await db.attendanceRequest.deleteMany({ where: { id: { in: areqs.map((r) => r.id) } } })
}

/** Delete demo leave requests that match `where` and hand their reserved/used days back to the balances. */
export async function resetLeaveData(where: object) {
  const reqs = await db.request.findMany({ where: { user: { email: { endsWith: DOMAIN } }, ...where } })
  for (const r of reqs) {
    if (r.type === 'LEAVE' && r.leaveTypeId && (r.status === 'APPROVED' || r.status.startsWith('PENDING'))) {
      const year = Number(r.startDate.toISOString().slice(0, 4))
      await db.leaveBalance.updateMany({
        where: { userId: r.userId, leaveTypeId: r.leaveTypeId, year },
        data: r.status === 'APPROVED' ? { availed: { decrement: r.dayCount } } : { pending: { decrement: r.dayCount } },
      })
    }
  }
  await db.approvalLog.deleteMany({ where: { requestId: { in: reqs.map((r) => r.id) } } })
  await db.request.deleteMany({ where: { id: { in: reqs.map((r) => r.id) } } })
  return reqs.length
}

/** Drop the harness's test device from the registry (a crashed earlier run may have left it behind). */
export async function removeTestDevices() {
  const row = await db.setting.findUnique({ where: { key: 'biometric.devices' } })
  if (!row) return
  try {
    const list = JSON.parse(row.value) as { sn?: string; name?: string }[]
    const kept = list.filter((d) => d.sn !== 'E2E-SN-001' && !String(d.name ?? '').startsWith('E2E '))
    if (kept.length !== list.length) await db.setting.update({ where: { key: 'biometric.devices' }, data: { value: JSON.stringify(kept) } })
  } catch { /* leave malformed settings alone */ }
}
