// Synthetic data only; never import the seed or connect to a real database.
export const user = {
  id: 'test-hr', fullName: 'Test HR', email: 'hr@example.invalid', role: 'HR_MANAGER',
  employeeCode: 'TEST-001', designation: 'HR Manager', avatarColor: '#0D9488',
  departmentName: 'Testing', mfaEnabled: false,
}
export const employee = {
  ...user, id: 'test-employee', role: 'EMPLOYEE', fullName: 'Test Employee',
  email: 'employee@example.invalid', departmentId: 'dept', departmentName: 'Testing',
  teamId: null, teamName: null, teamLead: null, manager: null,
  joiningDate: '2024-01-01T00:00:00.000Z', employmentStatus: 'Permanent',
  fatherName: null, motherName: null, dateOfBirth: null, gender: null, maritalStatus: null,
  bloodGroup: null, religion: null, nationality: null, cnic: null, cnicExpiry: null,
  drivingLicense: null, passportNo: null, passportExpiry: null, phone: null, personalEmail: null,
  emergencyContactName: null, emergencyContactPhone: null, address: null,
  shiftId: null, shiftName: null, shiftTime: null, teamLeadId: null, managerId: null,
  canSeeSalary: true, completionPct: 50, directs: [],
  baseSalary: 50000, hrAllowance: 1000, utilityAllowance: 500, isActive: true,
}
export const balance = {
  id: 'balance', leaveTypeId: 'casual', leaveType: { id: 'casual', name: 'Casual', code: 'CL', annualQuota: 12, colorCode: '#0D9488' },
  color: '#0D9488', total: 12, name: 'Casual', code: 'CL', annualQuota: 12, quota: 12, available: 12,
  carryForward: 0, availed: 0, pending: 0, lapsed: 0, remaining: 12,
}
export const meta = {
  people: [employee], departments: [{ id: 'dept', name: 'Testing', code: 'TEST' }],
  teams: [], shifts: [], leaveTypes: [balance.leaveType], holidays: [],
  weeklyOffDay: 0, today: '2026-11-16', rules: {},
}
export const attendance = {
  id: 'log', userId: user.id, date: '2026-11-16', dateKey: '2026-11-16',
  user: { ...user }, fullName: user.fullName, employeeCode: user.employeeCode,
  checkIn: '2026-11-16T04:00:00Z', checkOut: '2026-11-16T13:00:00Z',
  workedMinutes: 540, expectedMinutes: 540, shortMinutes: 0, lateMinutes: 0,
  earlyMinutes: 0, status: 'PRESENT', source: 'MANUAL', breaks: [], audits: [],
}

export const request = {
  id: 'request', type: 'LEAVE', userId: employee.id, leaveTypeId: 'casual', leaveType: balance.leaveType,
  startDate: '2026-11-16T00:00:00Z', endDate: '2026-11-16T00:00:00Z', isShortLeave: false,
  shortHours: 0, dayCount: 1, reason: 'Synthetic request', attachmentId: null,
  status: 'PENDING_HR', currentStage: 'HR', createdAt: '2026-11-15T00:00:00Z', user: employee, approvals: [],
}
export const dashboard = {
  kind: 'personal', month: '2026-11', trend: [], leaveSummary: [], pendingApprovals: 0,
  kpis: { shifts: 20, expectedMinutes: 10000, workedMinutes: 9000, shortMinutes: 0, leaves: 0, travels: 0, absents: 0, attendanceScore: 90 },
  teamOverview: [], todayPunch: null, canPunch: false, canCreateRequest: false,
}
