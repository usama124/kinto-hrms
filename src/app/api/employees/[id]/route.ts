import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireSession, guard, ok, fail } from '@/lib/hrms/api-utils'
import { canAccessUser } from '@/lib/hrms/rbac'
import { isOrgAdmin, isAccountsRole, isSysAdminGrantedRole, ROLES, EMPLOYMENT_STATUSES } from '@/lib/hrms/constants'
import { resolveDesignation } from '@/lib/hrms/designations'
import { writeAuditDiff } from '@/lib/hrms/audit'
import { revokeAllForUser } from '@/lib/hrms/tokens'
import { clientIp } from '@/lib/hrms/rate-limit'

/** Employee 360° metadata — strict access check (403 for outsiders). */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return guard(async () => {
    const session = await requireSession()
    const { id } = await ctx.params
    if (!(await canAccessUser(session, id))) return fail('Forbidden: you cannot view this employee.', 403)

    const u = await db.user.findUnique({
      where: { id },
      include: {
        department: { select: { name: true } },
        teamLead: { select: { id: true, fullName: true, designation: true } },
        manager: { select: { id: true, fullName: true, designation: true } },
        team: { select: { name: true } },
        shift: true,
        directs: { select: { id: true, fullName: true, designation: true, avatarColor: true, avatarUploadId: true } },
      },
    })
    if (!u) return fail('Employee not found.', 404)

    const year = new Date().getFullYear()
    const balances = await db.leaveBalance.findMany({
      where: { userId: id, year },
      include: { leaveType: true },
      orderBy: { leaveTypeId: 'asc' },
    })

    // Salary fields are only serialized for the owner, org admins and the accountant
    const canSeeSalary = session.userId === id || isOrgAdmin(session.role) || isAccountsRole(session.role)

    const completionFields = [
      u.designation, u.departmentId, u.teamLeadId, u.managerId, u.shiftId,
      u.dateOfBirth, u.cnic, u.phone, u.address, u.fatherName, u.motherName, u.bankIban, u.baseSalary > 0,
    ]
    const completionPct = Math.round((completionFields.filter(Boolean).length / completionFields.length) * 100)

    return ok({
      employee: {
        id: u.id, fullName: u.fullName, email: u.email, role: u.role,
        employeeCode: u.employeeCode, designation: u.designation, designationId: u.designationId,
        departmentName: u.department?.name ?? '—', departmentId: u.departmentId,
        teamId: u.teamId, teamName: u.team?.name ?? null,
        joiningDate: u.joiningDate,
        avatarColor: u.avatarColor, avatarUploadId: u.avatarUploadId, teamLead: u.teamLead, manager: u.manager,
        shiftId: u.shiftId, shiftName: u.shift?.name ?? null, shiftTime: u.shift ? `${u.shift.startTime}–${u.shift.endTime}` : null,
        // personal
        fatherName: u.fatherName, motherName: u.motherName,
        dateOfBirth: u.dateOfBirth?.toISOString() ?? null,
        gender: u.gender, maritalStatus: u.maritalStatus, bloodGroup: u.bloodGroup,
        religion: u.religion, nationality: u.nationality,
        // identity documents
        // government IDs: owner and HR/Admin only — a team lead/manager scoping this profile does not need them
        ...((session.userId === id || isOrgAdmin(session.role)) ? {
          cnic: u.cnic, cnicExpiry: u.cnicExpiry,
          drivingLicense: u.drivingLicense, passportNo: u.passportNo, passportExpiry: u.passportExpiry,
        } : { cnic: null, cnicExpiry: null, drivingLicense: null, passportNo: null, passportExpiry: null }),
        // contact
        phone: u.phone, personalEmail: u.personalEmail,
        emergencyContactName: u.emergencyContactName, emergencyContactPhone: u.emergencyContactPhone,
        address: u.address,
        // employment
        employmentStatus: u.employmentStatus, isActive: u.isActive,
        // compensation (gated server-side)
        ...(canSeeSalary ? {
          baseSalary: u.baseSalary, hrAllowance: u.hrAllowance, utilityAllowance: u.utilityAllowance,
          allowances: u.hrAllowance + u.utilityAllowance, bankName: u.bankName, bankIban: u.bankIban,
        } : {}),
        canSeeSalary,
        completionPct,
        directs: u.directs,
      },
      balances: balances.map((b) => {
        const total = b.carryForward + b.leaveType.annualQuota
        return {
          leaveTypeId: b.leaveTypeId, name: b.leaveType.name, color: b.leaveType.colorCode,
          carryForward: b.carryForward, quota: b.leaveType.annualQuota, total,
          availed: b.availed, pending: b.pending, lapsed: b.lapsed,
          available: Math.round((total - b.availed - b.pending - b.lapsed) * 100) / 100,
        }
      }),
    })
  })
}

/**
 * PATCH /api/employees/[id] — update an employee's profile (System Admin / HR Manager only).
 * Every changed field is written to the immutable audit log; deactivation also revokes
 * all of the employee's sessions.
 */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return guard(async () => {
    const session = await requireSession()
    if (!isOrgAdmin(session.role)) return fail('Forbidden: only System Admin / HR Manager can edit employee profiles.', 403)

    const { id } = await ctx.params
    const u = await db.user.findUnique({ where: { id } })
    if (!u) return fail('Employee not found.', 404)
    if (u.role === ROLES.SUPER_ADMIN && session.role !== ROLES.SUPER_ADMIN) {
      return fail('Forbidden: only the System Admin can edit another System Admin.', 403)
    }
    // HR Manager records (own profile included) can only be changed by the System Admin — an HR Manager
    // must not be able to raise their own salary/role or tamper with a colleague's record
    if (u.role === ROLES.HR_MANAGER && session.role !== ROLES.SUPER_ADMIN) {
      return fail('Forbidden: only the System Admin can edit an HR Manager profile.', 403)
    }

    const body = await req.json().catch(() => null)
    if (!body) return fail('Invalid JSON body.', 400)

    // ── gather next values ───────────────────────────────────────────────────────
    const next: Record<string, string | number | boolean | Date | null> = {}

    if (body.fullName !== undefined) {
      const v = String(body.fullName ?? '').trim().slice(0, 80).replace(/<[^>]*>/g, '')
      if (!v) return fail('Full name cannot be empty.', 422)
      next.fullName = v
    }
    if (body.role !== undefined) {
      const v = String(body.role)
      if (!['EMPLOYEE', 'TEAM_LEAD', 'MANAGER', 'ACCOUNTANT', 'ACCOUNTS_MANAGER', 'HR_MANAGER'].includes(v)) return fail('Invalid role.', 422)
      if (isSysAdminGrantedRole(v) && session.role !== 'SUPER_ADMIN') {
        return fail('Forbidden: only the System Admin can grant the HR Manager / Accounts Head roles.', 403)
      }
      // demoting an HR Manager / Accounts Head is just as sensitive as granting the role
      if (isSysAdminGrantedRole(u.role) && v !== u.role && session.role !== 'SUPER_ADMIN') {
        return fail('Forbidden: only the System Admin can change an HR Manager / Accounts Head role.', 403)
      }
      next.role = v
    }
    if (body.employeeCode !== undefined) {
      const v = String(body.employeeCode ?? '').trim().slice(0, 12).replace(/<[^>]*>/g, '')
      if (!v) return fail('Employee code cannot be empty.', 422)
      if (v !== u.employeeCode) {
        const clash = await db.user.findUnique({ where: { employeeCode: v }, select: { id: true } })
        if (clash) return fail('Employee code already in use.', 409)
      }
      next.employeeCode = v
    }
    if (body.email !== undefined) {
      const v = String(body.email ?? '').trim().toLowerCase().slice(0, 200)
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return fail('Invalid email address.', 422)
      if (v !== u.email) {
        const clash = await db.user.findUnique({ where: { email: v }, select: { id: true } })
        if (clash) return fail('A user with this email already exists.', 409)
      }
      next.email = v
    }

    // optional text profile fields
    const textFields: [string, number][] = [
      ['fatherName', 80], ['motherName', 80], ['phone', 24], ['cnic', 20], ['drivingLicense', 30],
      ['passportNo', 20], ['gender', 10], ['maritalStatus', 12], ['bloodGroup', 5], ['religion', 20],
      ['nationality', 30], ['emergencyContactName', 80], ['emergencyContactPhone', 24], ['address', 200],
      ['bankName', 40], ['bankIban', 34],
    ]
    for (const [f, max] of textFields) {
      if (body[f] !== undefined) next[f] = String(body[f] ?? '').trim().slice(0, max).replace(/<[^>]*>/g, '') || null
    }
    if (body.personalEmail !== undefined) next.personalEmail = String(body.personalEmail ?? '').trim().toLowerCase().slice(0, 200) || null

    // date keys
    const dateKeyOf = (v: unknown) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v ?? '')) ? String(v) : null)
    for (const f of ['cnicExpiry', 'passportExpiry']) {
      if (body[f] !== undefined) next[f] = dateKeyOf(body[f])
    }
    if (body.dateOfBirth !== undefined) {
      const dob = dateKeyOf(body.dateOfBirth)
      next.dateOfBirth = dob ? new Date(`${dob}T00:00:00Z`) : null
    }
    if (body.joiningDate !== undefined) {
      const jd = dateKeyOf(body.joiningDate)
      if (!jd) return fail('Invalid joining date.', 422)
      next.joiningDate = new Date(`${jd}T00:00:00Z`)
    }

    // relations
    const relChecks: [string, () => Promise<unknown>][] = [
      ['departmentId', () => db.department.findUnique({ where: { id: String(body.departmentId) } })],
      ['teamId', () => db.team.findUnique({ where: { id: String(body.teamId) } })],
      ['shiftId', () => db.shift.findUnique({ where: { id: String(body.shiftId) } })],
      ['teamLeadId', () => db.user.findUnique({ where: { id: String(body.teamLeadId) } })],
      ['managerId', () => db.user.findUnique({ where: { id: String(body.managerId) } })],
    ]
    for (const [f, check] of relChecks) {
      if (body[f] !== undefined) {
        const v = body[f] ? String(body[f]) : null
        if (v && !(await check())) return fail(`Referenced ${f.replace('Id', '')} not found.`, 422)
        if (v === id) return fail('An employee cannot report to themselves.', 422)
        next[f] = v
      }
    }

    // ── designation (company structure) ─────────────────────────────────────────
    // The designation must exist in Rules & Settings → Designations and belong to the employee's department.
    // Leaving a legacy free-text title untouched is allowed, so old records stay editable.
    const effectiveDept: string | null = body.departmentId !== undefined ? (body.departmentId ? String(body.departmentId) : null) : u.departmentId
    const wantsId = typeof body.designationId === 'string' && body.designationId ? body.designationId : null
    const nameIn = body.designation !== undefined ? String(body.designation ?? '').trim().slice(0, 80).replace(/<[^>]*>/g, '') : null
    if (body.designationId !== undefined || body.designation !== undefined) {
      const unchanged = wantsId ? wantsId === u.designationId : nameIn !== null && nameIn.toLowerCase() === u.designation.toLowerCase()
      if (!wantsId && !nameIn) return fail('Designation cannot be empty.', 422)
      if (!unchanged) {
        const resolved = await resolveDesignation({ designationId: wantsId, designation: nameIn, departmentId: effectiveDept })
        if (!resolved.ok) return fail(resolved.error, 422)
        next.designation = resolved.value.name
        next.designationId = resolved.value.id
        if (!effectiveDept) next.departmentId = resolved.value.departmentId
      }
    }
    if (body.departmentId !== undefined && next.designationId === undefined && u.designationId && effectiveDept) {
      // moving departments while keeping a designation that belongs to the old one would break the structure
      const held = await db.designation.findUnique({ where: { id: u.designationId }, include: { department: { select: { name: true } } } })
      if (held && held.departmentId !== effectiveDept) {
        return fail(`This employee holds “${held.name}” (${held.department.name}). Choose a designation from the new department as well.`, 422)
      }
    }
    if (body.departmentId && next.departmentId !== undefined && next.departmentId !== u.departmentId) {
      const d = await db.department.findUnique({ where: { id: String(next.departmentId) }, select: { isActive: true, name: true } })
      if (d && !d.isActive) return fail(`${d.name} is inactive — pick an active department.`, 422)
    }

    if (body.employmentStatus !== undefined) {
      if (!(EMPLOYMENT_STATUSES as readonly string[]).includes(String(body.employmentStatus))) {
        return fail(`Employment status must be one of: ${EMPLOYMENT_STATUSES.join(', ')}.`, 422)
      }
      next.employmentStatus = String(body.employmentStatus)
    }
    for (const f of ['baseSalary', 'hrAllowance', 'utilityAllowance']) {
      if (body[f] !== undefined) {
        const n = Number(body[f])
        // never coerce garbage to 0 (that would silently wipe someone's pay) and never accept absurd magnitudes
        if (body[f] === null || body[f] === '' || !Number.isFinite(n) || n < 0 || n > 100_000_000) return fail(`${f} must be a number between 0 and 100,000,000.`, 422)
        next[f] = n
      }
    }
    if (body.isActive !== undefined) {
      next.isActive = Boolean(body.isActive)
      if (id === session.userId && !next.isActive) return fail('You cannot deactivate your own account.', 422)
    }

    // nothing to change?
    if (Object.keys(next).length === 0) return fail('No changes provided.', 422)

    // ── apply + per-field audit diff ─────────────────────────────────────────────
    const before = u as unknown as Record<string, unknown>
    const updated = await db.user.update({ where: { id }, data: next as never })

    const reason = String(body.reason ?? '').trim().slice(0, 200) || null
    const changes = Object.entries(next).map(([fieldName, newValue]) => ({ fieldName, oldValue: before[fieldName], newValue }))
    await writeAuditDiff({
      actorId: session.userId, actorName: session.fullName, actorRole: session.role,
      targetUserId: u.id, targetName: u.fullName,
      entityType: 'USER', entityId: u.id,
      reason: reason ?? 'Employee profile updated', ipAddress: clientIp(req),
    }, changes)

    // deactivating or changing role/e-mail → revoke every session of that employee immediately
    if ((next.isActive === false && u.isActive) || (next.role && next.role !== u.role) || (next.email && next.email !== u.email)) {
      await revokeAllForUser(u.id)
    }

    return ok({
      employee: { id: updated.id, fullName: updated.fullName, employeeCode: updated.employeeCode, role: updated.role, isActive: updated.isActive },
    })
  })
}

export const dynamic = 'force-dynamic'
