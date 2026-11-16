// ─── Central domain constants: roles, statuses, policy definitions ───────────

export const ROLES = {
  SUPER_ADMIN: 'SUPER_ADMIN',
  HR_MANAGER: 'HR_MANAGER',
  ACCOUNTANT: 'ACCOUNTANT',
  MANAGER: 'MANAGER',
  TEAM_LEAD: 'TEAM_LEAD',
  EMPLOYEE: 'EMPLOYEE',
} as const
export type Role = (typeof ROLES)[keyof typeof ROLES]

export const ROLE_LABELS: Record<string, string> = {
  SUPER_ADMIN: 'System Admin',
  HR_MANAGER: 'HR Manager',
  ACCOUNTANT: 'Accountant',
  MANAGER: 'Manager',
  TEAM_LEAD: 'Team Lead',
  EMPLOYEE: 'Employee',
}

/** Org-level administrators (full profile visibility, fast-track approvals, rules mgmt). */
export const ORG_ADMIN_ROLES: string[] = [ROLES.SUPER_ADMIN, ROLES.HR_MANAGER]
export function isOrgAdmin(role: string): boolean {
  return ORG_ADMIN_ROLES.includes(role)
}
/** Payroll operators. */
export function isPayrollOperator(role: string): boolean {
  return role === ROLES.SUPER_ADMIN || role === ROLES.ACCOUNTANT
}
/** Roles for which TOTP MFA is mandatory (enforced at first login). */
export const MFA_REQUIRED_ROLES: string[] = [ROLES.SUPER_ADMIN, ROLES.HR_MANAGER, ROLES.ACCOUNTANT, ROLES.MANAGER]
export function isMfaRequired(role: string): boolean {
  return MFA_REQUIRED_ROLES.includes(role)
}
/** SUPER_ADMIN is oversight-only: no personal attendance punching / leave creation. */
export function isOversightOnly(role: string): boolean {
  return role === ROLES.SUPER_ADMIN
}

export const REQUEST_TYPES = { LEAVE: 'LEAVE', OFFICIAL_DUTY: 'OFFICIAL_DUTY', TRAVEL: 'TRAVEL' } as const
export type RequestType = (typeof REQUEST_TYPES)[keyof typeof REQUEST_TYPES]
export const REQUEST_TYPE_LABELS: Record<string, string> = {
  LEAVE: 'Leave',
  OFFICIAL_DUTY: 'Official Duty',
  TRAVEL: 'Travel',
}

export const REQUEST_STATUS = {
  PENDING_TEAM_LEAD: 'PENDING_TEAM_LEAD',
  PENDING_MANAGER: 'PENDING_MANAGER',
  PENDING_HR: 'PENDING_HR',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
} as const
export type RequestStatus = (typeof REQUEST_STATUS)[keyof typeof REQUEST_STATUS]
export const PENDING_STATUSES = [REQUEST_STATUS.PENDING_TEAM_LEAD, REQUEST_STATUS.PENDING_MANAGER, REQUEST_STATUS.PENDING_HR]

export const ATT_STATUS = {
  PRESENT: 'PRESENT',
  MISSING: 'MISSING',
  ABSENT: 'ABSENT',
  SHORT_DURATION: 'SHORT_DURATION',
  DAY_OFF: 'DAY_OFF',
  WFH: 'WFH',
  FULL_LEAVE: 'FULL_LEAVE',
  SHORT_LEAVE: 'SHORT_LEAVE',
  OFFICIAL_DUTY: 'OFFICIAL_DUTY',
  TRAVEL: 'TRAVEL',
  WEEKEND: 'WEEKEND',
  HOLIDAY: 'HOLIDAY',
} as const
export type AttendanceStatus = (typeof ATT_STATUS)[keyof typeof ATT_STATUS]

// Statuses that accrue short minutes toward payroll conversion
export const SHORT_HOUR_STATUSES = ['PRESENT', 'SHORT_DURATION', 'WFH', 'SHORT_LEAVE'] as const

// Statuses counted as "worked" days for payroll
export const WORKED_STATUS_SET = ['PRESENT', 'SHORT_DURATION', 'SHORT_LEAVE', 'WFH', 'OFFICIAL_DUTY', 'TRAVEL'] as const

// Statuses considered "not working" for attendance score denominators
export const NON_WORKING_STATUSES = ['WEEKEND', 'HOLIDAY', 'DAY_OFF'] as const

export const ATT_BADGE_TONE: Record<string, string> = {
  PRESENT: 'emerald',
  WFH: 'violet',
  MISSING: 'amber',
  ABSENT: 'rose',
  SHORT_DURATION: 'orange',
  DAY_OFF: 'slate',
  WEEKEND: 'slate',
  HOLIDAY: 'teal',
  FULL_LEAVE: 'cyan',
  SHORT_LEAVE: 'teal',
  OFFICIAL_DUTY: 'purple',
  TRAVEL: 'purple',
}

export const STATUS_BADGE_TONE: Record<string, string> = {
  PENDING_TEAM_LEAD: 'amber',
  PENDING_MANAGER: 'orange',
  PENDING_HR: 'violet',
  APPROVED: 'emerald',
  REJECTED: 'rose',
  DRAFT: 'amber',
  FINALIZED: 'emerald',
}

export const STAGE_LABELS: Record<string, string> = {
  TEAM_LEAD: 'Team Lead',
  MANAGER: 'Manager',
  HR: 'HR',
  DONE: 'Completed',
}

export const POLICY_KEYS = {
  SHIFT_DURATION: 'shift.durationMinutes',
  GRACE_MINUTES: 'shift.graceMinutes',
  WEEKLY_OFF_DAY: 'shift.weeklyOffDay',
  SHORT_CONVERSION_MINUTES: 'shortHours.conversionMinutes',
  SHORT_DEDUCTION_MODE: 'shortHours.deductionMode', // LEAVE_FIRST | PRORATED
  SHORT_LEAVE_MAX_HOURS: 'leave.shortLeaveMaxHours',
  OVERTIME_RATE: 'payroll.overtimeRatePerHour',
} as const

export const DEFAULT_RULES: Record<string, { value: string; label: string; category: string }> = {
  [POLICY_KEYS.SHIFT_DURATION]: { value: '540', label: 'Shift Duration (minutes/day)', category: 'SHORT_HOURS' },
  [POLICY_KEYS.GRACE_MINUTES]: { value: '15', label: 'Daily Grace Period (minutes)', category: 'SHORT_HOURS' },
  [POLICY_KEYS.WEEKLY_OFF_DAY]: { value: '0', label: 'Weekly Day Off (0=Sun … 6=Sat)', category: 'GENERAL' },
  [POLICY_KEYS.SHORT_CONVERSION_MINUTES]: { value: '480', label: 'Short Minutes per Leave-Day Deduction', category: 'SHORT_HOURS' },
  [POLICY_KEYS.SHORT_DEDUCTION_MODE]: { value: 'LEAVE_FIRST', label: 'Short-Hours Deduction Mode', category: 'SHORT_HOURS' },
  [POLICY_KEYS.SHORT_LEAVE_MAX_HOURS]: { value: '3', label: 'Max Short-Leave Hours per Request', category: 'LEAVE_CAPS' },
  [POLICY_KEYS.OVERTIME_RATE]: { value: '250', label: 'Overtime Rate (PKR/hour)', category: 'PAYROLL' },
}

export const APP_NAME = 'KINTO HRMS'

export const UPLOAD_DIR = 'uploads'
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024
export const ALLOWED_MIME = ['application/pdf', 'image/png', 'image/jpeg']
