import { db } from '@/lib/db'
import { requireSession, guard, ok, fail } from '@/lib/hrms/api-utils'
import { canAccessUser } from '@/lib/hrms/rbac'
import { profileCardPDF } from '@/lib/hrms/pdf'
import { fmtDateKey } from '@/lib/hrms/dates'
import { ROLE_LABELS } from '@/lib/hrms/constants'

/** Downloadable PDF Profile Card. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return guard(async () => {
    const session = await requireSession()
    const { id } = await ctx.params
    if (!(await canAccessUser(session, id))) return fail('Forbidden: you cannot export this profile.', 403)

    const u = await db.user.findUnique({
      where: { id },
      include: {
        department: { select: { name: true } },
        teamLead: { select: { fullName: true } },
        manager: { select: { fullName: true } },
        shift: true,
      },
    })
    if (!u) return fail('Employee not found.', 404)

    const completionFields = [u.designation, u.departmentId, u.teamLeadId, u.managerId, u.shiftId, u.joiningDate]
    const completionPct = Math.round((completionFields.filter(Boolean).length / completionFields.length) * 100)

    const buf = profileCardPDF({
      fullName: u.fullName, employeeCode: u.employeeCode, designation: u.designation,
      department: u.department?.name ?? '—', roleLabel: ROLE_LABELS[u.role] ?? u.role,
      joiningDate: fmtDateKey(u.joiningDate.toISOString().slice(0, 10)), email: u.email,
      teamLead: u.teamLead?.fullName ?? '—', manager: u.manager?.fullName ?? '—',
      shift: u.shift ? `${u.shift.name} (${u.shift.startTime}–${u.shift.endTime})` : '—',
      completionPct,
    })
    return new Response(new Uint8Array(buf), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="profile-${u.employeeCode}.pdf"`,
      },
    })
  })
}
