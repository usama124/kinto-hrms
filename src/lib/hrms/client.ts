'use client'

import { REQUEST_TYPE_LABELS } from '@/lib/hrms/constants'

export { fmtMinutes, fmtDateKey } from '@/lib/hrms/dates'
export { REQUEST_TYPE_LABELS, ROLE_LABELS, STATUS_BADGE_TONE, ATT_BADGE_TONE, STAGE_LABELS } from '@/lib/hrms/constants'

export class ApiError extends Error {
  constructor(message: string, public status: number) { super(message) }
}

let refreshing: Promise<boolean> | null = null

/** Silent session refresh — rotates the refresh token cookie. */
export async function refreshSession(): Promise<boolean> {
  refreshing = refreshing ?? (async () => {
    try {
      const res = await fetch('/api/auth/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      if (res.status === 409) { // another tab is mid-rotation; its fresh cookies are about to land
        await new Promise((r) => setTimeout(r, 400))
        return true
      }
      return res.ok
    } catch {
      return false
    } finally {
      setTimeout(() => { refreshing = null }, 100)
    }
  })()
  return refreshing
}

/** JSON API client with a single automatic refresh+retry on 401. */
export async function api<T>(path: string, init?: RequestInit, retried = false): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  })
  if (res.status === 401 && !retried && !path.startsWith('/api/auth/login') && !path.startsWith('/api/auth/mfa')) {
    const ok = await refreshSession()
    if (ok) return api<T>(path, init, true)
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError((data as { error?: string }).error ?? 'Request failed', res.status)
  return data as T
}

/** Download a binary (PDF/XLSX) endpoint and trigger a save. */
export async function downloadFile(path: string, fallbackName: string) {
  let res = await fetch(path)
  if (res.status === 401) {
    const ok = await refreshSession()
    if (ok) res = await fetch(path)
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new ApiError((data as { error?: string }).error ?? 'Download failed', res.status)
  }
  const blob = await res.blob()
  const cd = res.headers.get('Content-Disposition') ?? ''
  const m = /filename="?([^";]+)"?/.exec(cd)
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = m?.[1] ?? fallbackName
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(a.href), 4000)
}

/** URL of a user's profile picture, or null → show coloured initials. `?v=` makes a changed picture a new, cacheable URL. */
export function avatarSrc(u?: { id: string; avatarUploadId?: string | null } | null): string | null {
  return u?.avatarUploadId ? `/api/employees/${u.id}/avatar?v=${u.avatarUploadId}` : null
}

/** multipart POST with the same one-shot refresh-and-retry as api(). */
export async function postForm<T>(path: string, form: FormData): Promise<T> {
  let res = await fetch(path, { method: 'POST', body: form })
  if (res.status === 401 && (await refreshSession())) res = await fetch(path, { method: 'POST', body: form })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError((data as { error?: string }).error ?? 'Upload failed', res.status)
  return data as T
}

// ─── Shared API types ─────────────────────────────────────────────────────────

export type SessionUser = {
  id: string; email: string; fullName: string; role: string
  employeeCode: string; designation: string; avatarColor: string; avatarUploadId?: string | null; departmentName: string
  teamName?: string | null
  joiningDate?: string; baseSalary?: number; hrAllowance?: number; utilityAllowance?: number
  teamLeadId?: string | null; teamLeadName?: string | null
  managerId?: string | null; managerName?: string | null
  shiftName?: string | null
  mfaEnabled?: boolean; mfaRequired?: boolean
  /** admin-issued temporary password not yet replaced → the app shows the change-password gate */
  mustChangePassword?: boolean
}

export type PersonLite = {
  id: string; fullName: string; employeeCode: string; designation: string
  role: string; avatarColor: string; avatarUploadId?: string | null; departmentId: string | null
  teamLeadId: string | null; managerId: string | null
}

/** Full 360° employee payload from GET /api/employees/[id]. */
export type Employee360 = {
  id: string; fullName: string; email: string; role: string
  employeeCode: string; designation: string; designationId?: string | null
  departmentName: string; departmentId: string | null
  teamId: string | null; teamName: string | null
  joiningDate: string; avatarColor: string; avatarUploadId?: string | null
  teamLead: { id: string; fullName: string; designation: string } | null
  manager: { id: string; fullName: string; designation: string } | null
  shiftId: string | null; shiftName: string | null; shiftTime: string | null
  fatherName: string | null; motherName: string | null
  dateOfBirth: string | null; gender: string | null; maritalStatus: string | null
  bloodGroup: string | null; religion: string | null; nationality: string | null
  cnic: string | null; cnicExpiry: string | null
  drivingLicense: string | null; passportNo: string | null; passportExpiry: string | null
  phone: string | null; personalEmail: string | null
  emergencyContactName: string | null; emergencyContactPhone: string | null
  address: string | null
  employmentStatus: string; isActive: boolean
  baseSalary?: number; hrAllowance?: number; utilityAllowance?: number; allowances?: number
  bankName?: string | null; bankIban?: string | null
  canSeeSalary: boolean; completionPct: number
  directs: { id: string; fullName: string; designation: string; avatarColor: string; avatarUploadId?: string | null }[]
}

/** Payload of GET /api/org-structure. */
export type OrgStructure = {
  departments: {
    id: string; name: string; code: string
    manager: { id: string; fullName: string; designation: string; avatarColor: string; avatarUploadId?: string | null } | null
    users: { id: string; fullName: string; designation: string; avatarColor: string; avatarUploadId?: string | null; role: string; teamId: string | null; employeeCode: string }[]
    teams: {
      id: string; name: string
      teamLead: { id: string; fullName: string; designation: string; avatarColor: string; avatarUploadId?: string | null } | null
      users: { id: string; fullName: string; designation: string; avatarColor: string; avatarUploadId?: string | null; role: string; employeeCode: string }[]
    }[]
  }[]
  unassigned?: { id: string; fullName: string; designation: string; avatarColor: string; avatarUploadId?: string | null; role: string; employeeCode: string }[]
}

export type Meta = {
  departments: { id: string; name: string; code: string; managerId?: string | null; isActive?: boolean; description?: string | null }[]
  leaveTypes: { id: string; name: string; code: string; annualQuota: number; colorCode: string; monthlyCap: number | null; attachmentThreshold: number | null; isPaid: boolean }[]
  shifts: { id: string; name: string; startTime: string; endTime: string; expectedMinutes: number; graceMinutes: number; workingDays?: string }[]
  teams: { id: string; name: string; departmentId: string; teamLeadId: string | null; teamLeadName?: string | null }[]
  designations: { id: string; name: string; departmentId: string; departmentName: string; parentDesignationId: string | null; levelRank: number }[]
  holidays: string[]
  weeklyOffDay: number
  graceMinutes: number
  shiftDurationMinutes: number
  shortLeaveMaxHours: number
  people: PersonLite[]
  today: string
  year: number
}

export type UnitStats = {
  id: string; name: string; code?: string
  headcount: number; scheduledDays: number; attendedDays: number
  completeHoursPct: number; shortHours: number; absentDays: number
  missingPunches: number; pendingApprovals: number
  attentionNeeded: boolean; attentionReasons: string[]
}

export type DashboardData = {
  kind: 'org' | 'personal'
  month: string
  departments?: (UnitStats & { teams: number })[]
  orgStats?: { headcount: number; completeHoursPct: number; shortHours: number; absentDays: number; missingPunches: number; pendingRequests: number; pendingLeave: number; pendingAttendance: number }
  kpis?: { shifts: number; expectedMinutes: number; workedMinutes: number; shortMinutes: number; leaves: number; travels: number; absents: number; attendanceScore: number | null }
  trend: { day: string; label: string; late: number; short: number; checkInMin: number | null }[]
  leaveSummary: { leaveTypeId: string; name: string; color: string; total: number; availed: number; pending: number; available: number; monthlyCap: number | null }[]
  pendingApprovals: number
  teamOverview?: RosterMember[]
  todayPunch?: { checkIn: string | null; checkOut: string | null; status: string } | null
  shift?: { name: string; startTime: string; endTime: string; expectedMinutes: number; graceMinutes: number; workingDays: number[] } | null
  canPunch?: boolean
  canCreateRequest?: boolean
  supervisors?: { teamLead: { id: string; fullName: string } | null; manager: { id: string; fullName: string } | null }
}

export type RosterMember = {
  id: string; fullName: string; employeeCode: string; designation: string
  avatarColor: string; avatarUploadId?: string | null; role: string
  shortHours: number; absentDays: number; missingPunches: number; lateCount: number
  pill: 'ON_TRACK' | 'SHORT_HOURS_ALERT' | 'MISSING_PUNCH' | 'ATTENTION'
}

export type Balance = {
  leaveTypeId: string; name: string; code: string; color: string
  carryForward: number; quota: number; total: number
  availed: number; pending: number; lapsed: number; available: number
}

export type RequestRow = {
  id: string; type: string; userId: string
  leaveTypeId: string | null; leaveType: { id: string; name: string; colorCode: string } | null
  startDate: string; endDate: string; isShortLeave: boolean; shortHours: number
  dayCount: number; reason: string; attachmentId: string | null
  attachment?: { id: string; name: string; mime: string } | null
  status: string; currentStage: string; createdAt: string
  user: { id: string; fullName: string; employeeCode: string; avatarColor: string; designation: string; role?: string; avatarUploadId?: string | null }
  approvals: { id: string; level: string; action: string; comment: string | null; createdAt: string; approver: { fullName: string; role: string } }[]
}

export type AttRequestRow = {
  id: string; userId: string; date: string
  requestedCheckIn: string; requestedCheckOut: string; reason: string
  status: string; currentStage: string; createdAt: string
  user: { id: string; fullName: string; employeeCode: string; avatarColor: string; designation: string; role?: string; avatarUploadId?: string | null }
  approvals: { id: string; level: string; action: string; comment: string | null; createdAt: string; approver: { fullName: string; role: string } }[]
}

export type AttLog = {
  id: string; dateKey: string; status: string; checkIn: string | null; checkOut: string | null
  expectedMinutes: number; workedMinutes: number; shortMinutes: number; lateMinutes: number
  earlyMinutes?: number; breakMinutes: number; isWFH: boolean; source: string
  isManuallyUpdated?: boolean; notes: string | null
  user: { id: string; fullName: string; employeeCode: string; avatarColor: string; avatarUploadId?: string | null }
}

export type PayslipV2 = {
  id: string; month?: string
  runId: string; run?: { id: string; month: string; status: string }
  userId: string
  employeeCode: string; fullName: string; fatherName: string | null
  designation: string; departmentName: string; employmentStatus: string
  workingDays: number; workedDays: number; paidLeaves: number; unpaidLeaveDays: number
  shortMinutes: number; lateMinutes: number
  leaveDaysEquivalent: number; shortConvertedFromBalance: number
  basicSalary: number; hrAllowance: number; utilityAllowance: number
  providentFundEarning: number; bonus: number; arrears: number
  overtimeAmount: number; grossPay: number
  internalLoan: number; incomeTax: number; providentFund: number; eoobi: number; taxAdjustment: number
  shortHourDeduction: number; leaveDeduction: number; totalDeduction: number; netPay: number
  status: string
  user?: { id: string; fullName: string; employeeCode: string; designation: string; avatarColor: string; department?: { name: string } }
}

export type PayrollRunV2 = {
  id: string; month: string; status: string
  totalGross: number; totalDeductions: number; totalNet: number
  finalizedAt: string | null; createdAt: string
  createdBy?: { fullName: string }
  _count?: { payslips: number }
}

export type AuditRow = {
  id: string; actorName: string | null; actorRole: string | null
  targetUserId: string | null; targetName: string | null
  entityType: string; entityId: string | null
  fieldName: string | null; oldValue: string | null; newValue: string | null
  reason: string | null; ipAddress: string | null
  createdAt: string
}

export type Notif = { id: string; title: string; body: string; type: string; read: boolean; createdAt: string }

export function dayLabel(key: string): string {
  return new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short' }).format(new Date(key + 'T00:00:00Z'))
}

export function timeLabel(iso: string | null): string {
  if (!iso) return '—'
  return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Karachi' }).format(new Date(iso))
}

export function dateTimeLabel(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Karachi' }).format(new Date(iso))
}

export function money(n: number): string {
  return `PKR ${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
}

export function money2(n: number): string {
  return `Rs. ${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}
