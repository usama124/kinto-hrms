import { db } from '@/lib/db'
import { requireSession, guard, ok } from '@/lib/hrms/api-utils'
import { visibleUserIds } from '@/lib/hrms/rbac'
import { getRules } from '@/lib/hrms/policy'
import { todayKey } from '@/lib/hrms/dates'

/** Shared metadata for selectors, calendars and the rules engine preview. */
export async function GET() {
  return guard(async () => {
    const session = await requireSession()
    const rules = await getRules()
    const year = Number(todayKey().slice(0, 4))
    const [departments, leaveTypes, shifts, holidays, teams, visible] = await Promise.all([
      db.department.findMany({ orderBy: { name: 'asc' } }),
      db.leaveType.findMany({ orderBy: { name: 'asc' } }),
      db.shift.findMany({ orderBy: { name: 'asc' } }),
      db.holiday.findMany({ orderBy: { date: 'asc' } }),
      db.team.findMany({ include: { teamLead: { select: { fullName: true } } }, orderBy: { name: 'asc' } }),
      visibleUserIds(session),
    ])
    const people = await db.user.findMany({
      where: { id: { in: visible } },
      select: { id: true, fullName: true, employeeCode: true, designation: true, role: true, avatarColor: true, departmentId: true, teamLeadId: true, managerId: true },
      orderBy: { fullName: 'asc' },
    })
    return ok({
      departments, leaveTypes, shifts, teams,
      holidays: holidays.map((h) => h.date),
      weeklyOffDay: rules.weeklyOffDay,
      graceMinutes: rules.graceMinutes,
      shiftDurationMinutes: rules.shiftDurationMinutes,
      shortLeaveMaxHours: rules.shortLeaveMaxHours,
      people,
      today: todayKey(),
      year,
    })
  })
}
