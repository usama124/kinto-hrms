import { db } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { guard, fail, ok } from '@/lib/hrms/api-utils'
import { isMfaRequired } from '@/lib/hrms/constants'

export async function GET() {
  return guard(async () => {
    const session = await getSession()
    if (!session) return fail('Not authenticated.', 401)
    const user = await db.user.findUnique({
      where: { id: session.userId },
      include: {
        department: true, shift: true, team: true,
        teamLead: { select: { id: true, fullName: true } },
        manager: { select: { id: true, fullName: true } },
      },
    })
    if (!user || !user.isActive) return fail('Account inactive.', 401)
    return ok({
      user: {
        id: user.id, email: user.email, fullName: user.fullName, role: user.role,
        employeeCode: user.employeeCode, designation: user.designation,
        avatarColor: user.avatarColor, departmentName: user.department?.name ?? '—',
        teamName: user.team?.name ?? null,
        joiningDate: user.joiningDate, baseSalary: user.baseSalary,
        hrAllowance: user.hrAllowance, utilityAllowance: user.utilityAllowance,
        teamLeadId: user.teamLead?.id ?? null, teamLeadName: user.teamLead?.fullName ?? null,
        managerId: user.manager?.id ?? null, managerName: user.manager?.fullName ?? null,
        shiftName: user.shift?.name ?? null,
        mfaEnabled: user.mfaEnabled,
        mfaRequired: isMfaRequired(user.role),
        mustChangePassword: user.mustChangePassword,
      },
    })
  })
}

export const dynamic = 'force-dynamic'
