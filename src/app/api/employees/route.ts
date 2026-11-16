import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { hashPassword } from '@/lib/auth'
import { requireSession, guard, ok, fail } from '@/lib/hrms/api-utils'
import { isOrgAdmin, isSysAdminGrantedRole, ROLES, EMPLOYMENT_STATUSES } from '@/lib/hrms/constants'
import { resolveDesignation } from '@/lib/hrms/designations'
import { cleanText, cleanEmail, cleanNumber, cleanDateKey } from '@/lib/hrms/sanitize'
import { writeAudit } from '@/lib/hrms/audit'
import { visibleUserIds, canSeeCompensation } from '@/lib/hrms/rbac'
import { passwordPolicyError, generateTempPassword } from '@/lib/hrms/password'
import { clientIp } from '@/lib/hrms/rate-limit'
import { todayKey } from '@/lib/hrms/dates'

const CREATABLE_BY_HR = [ROLES.EMPLOYEE, ROLES.TEAM_LEAD, ROLES.MANAGER, ROLES.ACCOUNTANT]
const CREATABLE_BY_ADMIN = [...CREATABLE_BY_HR, ROLES.HR_MANAGER, ROLES.ACCOUNTS_MANAGER]

/**
 * GET /api/employees — people directory, RBAC-scoped (repo-level query scoping).
 */
export async function GET() {
  return guard(async () => {
    const session = await requireSession()
    const ids = await visibleUserIds(session)
    const users = await db.user.findMany({
      where: { id: { in: ids } },
      include: {
        department: { select: { name: true } },
        teamLead: { select: { id: true, fullName: true } },
        manager: { select: { id: true, fullName: true } },
        shift: { select: { name: true, startTime: true, endTime: true } },
      },
      orderBy: { fullName: 'asc' },
    })
    return ok({
      people: users.map((u) => ({
        id: u.id, fullName: u.fullName, email: u.email, role: u.role,
        employeeCode: u.employeeCode, designation: u.designation,
        departmentName: u.department?.name ?? '—', departmentId: u.departmentId,
        joiningDate: u.joiningDate, avatarColor: u.avatarColor, avatarUploadId: u.avatarUploadId,
        teamLead: u.teamLead?.fullName ?? null, manager: u.manager?.fullName ?? null,
        shiftName: u.shift?.name ?? null,
        // compensation only for the owner, HR/Admin and the accountant — never for a supervisor browsing their team
        ...(canSeeCompensation(session, u.id) ? { baseSalary: u.baseSalary, allowances: u.hrAllowance + u.utilityAllowance } : {}),
        isActive: u.isActive,
      })),
    })
  })
}

/**
 * POST /api/employees — onboard a new employee (System Admin / HR Manager only).
 * Auto-generates the employee code (biometric PIN), initializes this year's leave
 * balances and writes an immutable audit entry.
 */
export async function POST(req: NextRequest) {
  return guard(async () => {
    const session = await requireSession()
    if (!isOrgAdmin(session.role)) return fail('Forbidden: only System Admin / HR Manager can add employees.', 403)

    const body = await req.json().catch(() => null)
    if (!body) return fail('Invalid JSON body.', 400)

    const fullName = cleanText(body.fullName, 80)
    const email = cleanEmail(body.email)
    const role = String(body.role ?? ROLES.EMPLOYEE)
    const designationInput = cleanText(body.designation, 80)
    const joiningDate = cleanDateKey(body.joiningDate)

    if (!fullName || !email || !(designationInput || body.designationId) || !joiningDate) {
      return fail('Full name, email, designation and joining date are required.', 422)
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail('Invalid email address.', 422)
    if (!CREATABLE_BY_ADMIN.includes(role)) return fail('Invalid role.', 422)
    for (const f of ['baseSalary', 'hrAllowance', 'utilityAllowance']) {
      if (body[f] === undefined || body[f] === '') continue
      const n = Number(body[f])
      if (body[f] === null || !Number.isFinite(n) || n < 0 || n > 100_000_000) return fail(`${f} must be a number between 0 and 100,000,000.`, 422)
    }
    if (body.employmentStatus !== undefined && !(EMPLOYMENT_STATUSES as readonly string[]).includes(String(body.employmentStatus))) {
      return fail(`Employment status must be one of: ${EMPLOYMENT_STATUSES.join(', ')}.`, 422)
    }
    if (isSysAdminGrantedRole(role) && session.role !== ROLES.SUPER_ADMIN) {
      return fail('Forbidden: only the System Admin can create HR Manager / Accounts Head accounts.', 403)
    }

    const emailExists = await db.user.findUnique({ where: { email }, select: { id: true } })
    if (emailExists) return fail('A user with this email already exists.', 409)

    // Auto-generate employee code (NT-###) — unique, also used as the ZKTeco PIN
    const existing = await db.user.findMany({ select: { employeeCode: true } })
    const maxNum = existing.reduce((m, u) => {
      const match = /^NT-(\d+)$/.exec(u.employeeCode)
      return match ? Math.max(m, Number(match[1])) : m
    }, 0)
    const employeeCode = cleanText(body.employeeCode, 12) || `NT-${String(maxNum + 1).padStart(3, '0')}`
    const codeExists = await db.user.findUnique({ where: { employeeCode }, select: { id: true } })
    if (codeExists) return fail('Employee code already in use.', 409)

    // Validate optional relations
    let departmentId = body.departmentId ? String(body.departmentId) : null
    const teamId = body.teamId ? String(body.teamId) : null
    const teamLeadId = body.teamLeadId ? String(body.teamLeadId) : null
    const managerId = body.managerId ? String(body.managerId) : null
    const shiftId = body.shiftId ? String(body.shiftId) : null
    if (departmentId) {
      const dept = await db.department.findUnique({ where: { id: departmentId } })
      if (!dept) return fail('Department not found.', 422)
      if (!dept.isActive) return fail(`${dept.name} is inactive — pick an active department.`, 422)
    }
    if (teamId && !(await db.team.findUnique({ where: { id: teamId } }))) return fail('Team not found.', 422)
    if (teamLeadId && !(await db.user.findUnique({ where: { id: teamLeadId } }))) return fail('Team Lead not found.', 422)
    if (managerId && !(await db.user.findUnique({ where: { id: managerId } }))) return fail('Manager not found.', 422)
    if (shiftId && !(await db.shift.findUnique({ where: { id: shiftId } }))) return fail('Shift not found.', 422)

    // The designation must come from the company structure (Rules & Settings → Designations), not free text, and
    // must belong to the employee's department. With no department chosen, the designation's department is used.
    const resolved = await resolveDesignation({ designationId: body.designationId, designation: designationInput, departmentId })
    if (!resolved.ok) return fail(resolved.error, 422)
    const designation = resolved.value
    departmentId = departmentId ?? designation.departmentId

    const dob = cleanDateKey(body.dateOfBirth)
    // no shared default password any more: an explicit password must meet the policy, otherwise a random one is generated
    const supplied = typeof body.password === 'string' && body.password.length > 0 ? body.password : null
    if (supplied) {
      const problem = passwordPolicyError(supplied)
      if (problem) return fail(problem, 422)
    }
    const password = supplied ?? generateTempPassword()

    const u = await db.user.create({
      data: {
        email,
        passwordHash: hashPassword(password),
        mustChangePassword: true, // HR/Admin knows this password, so the employee must replace it at first sign-in
        fullName,
        fatherName: cleanText(body.fatherName, 80) || null,
        motherName: cleanText(body.motherName, 80) || null,
        phone: cleanText(body.phone, 24) || null,
        personalEmail: cleanEmail(body.personalEmail) || null,
        cnic: cleanText(body.cnic, 20) || null,
        cnicExpiry: cleanDateKey(body.cnicExpiry),
        drivingLicense: cleanText(body.drivingLicense, 30) || null,
        passportNo: cleanText(body.passportNo, 20) || null,
        passportExpiry: cleanDateKey(body.passportExpiry),
        dateOfBirth: dob ? new Date(`${dob}T00:00:00Z`) : null,
        gender: cleanText(body.gender, 10) || null,
        maritalStatus: cleanText(body.maritalStatus, 12) || null,
        bloodGroup: cleanText(body.bloodGroup, 5) || null,
        religion: cleanText(body.religion, 20) || null,
        nationality: cleanText(body.nationality, 30) || null,
        emergencyContactName: cleanText(body.emergencyContactName, 80) || null,
        emergencyContactPhone: cleanText(body.emergencyContactPhone, 24) || null,
        address: cleanText(body.address, 200) || null,
        role,
        employeeCode,
        designation: designation.name,
        designationId: designation.id,
        departmentId,
        teamId,
        teamLeadId,
        managerId,
        shiftId,
        joiningDate: new Date(`${joiningDate}T00:00:00Z`),
        employmentStatus: body.employmentStatus !== undefined ? String(body.employmentStatus) : 'Permanent',
        baseSalary: Math.max(0, cleanNumber(body.baseSalary, 0)),
        hrAllowance: Math.max(0, cleanNumber(body.hrAllowance, 0)),
        utilityAllowance: Math.max(0, cleanNumber(body.utilityAllowance, 0)),
        bankName: cleanText(body.bankName, 40) || null,
        bankIban: cleanText(body.bankIban, 34) || null,
      },
    })

    // Initialize this year's leave balances for every active leave type
    const year = Number(todayKey().slice(0, 4))
    const leaveTypes = await db.leaveType.findMany()
    if (leaveTypes.length) {
      await db.leaveBalance.createMany({
        data: leaveTypes.map((t) => ({ userId: u.id, leaveTypeId: t.id, year, carryForward: 0, availed: 0, pending: 0, lapsed: 0 })),
      })
    }

    await writeAudit({
      actorId: session.userId, actorName: session.fullName, actorRole: session.role,
      targetUserId: u.id, targetName: u.fullName,
      entityType: 'USER', entityId: u.id, fieldName: 'employee.created',
      newValue: `${u.fullName} (${u.employeeCode}) · ${role}`,
      reason: 'Employee onboarded', ipAddress: clientIp(req),
    })

    return ok({
      employee: { id: u.id, fullName: u.fullName, email: u.email, employeeCode: u.employeeCode, role: u.role },
      temporaryPassword: password,
    }, { status: 201, headers: { 'Cache-Control': 'no-store' } })
  })
}

export const dynamic = 'force-dynamic'
