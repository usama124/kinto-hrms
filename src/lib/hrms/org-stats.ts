import 'server-only'
import { db } from '@/lib/db'
import { WORKED_STATUS_SET, NON_WORKING_STATUSES } from '@/lib/hrms/constants'
import { monthRangeKeys, todayKey } from '@/lib/hrms/dates'

export type UnitStats = {
  id: string
  name: string
  code?: string
  headcount: number
  scheduledDays: number
  attendedDays: number
  completeHoursPct: number
  shortHours: number
  absentDays: number
  missingPunches: number
  pendingApprovals: number
  attentionNeeded: boolean
  attentionReasons: string[]
}

const SHORT_HOURS_ALERT_MIN = 480 // > 8h/month short
const ABSENT_ALERT_DAYS = 2
const COMPLETE_PCT_ALERT = 85

/** Aggregate attendance + pending-approval health for a set of user ids. */
export async function computeStats(month: string, userIds: string[]): Promise<{
  headcount: number
  scheduledDays: number
  attendedDays: number
  completeHoursPct: number
  shortHours: number
  absentDays: number
  missingPunches: number
  pendingApprovals: number
}> {
  const { fromKey, toKey } = monthRangeKeys(month)
  const to = month === todayKey().slice(0, 7) ? todayKey() : toKey
  const logs = userIds.length
    ? await db.attendanceLog.findMany({ where: { userId: { in: userIds }, dateKey: { gte: fromKey, lte: to } } })
    : []
  const scheduled = logs.filter((l) => !NON_WORKING_STATUSES.includes(l.status as never) && l.expectedMinutes > 0)
  const attendedDays = logs.filter((l) => (WORKED_STATUS_SET as readonly string[]).includes(l.status)).length
  const expectedMinutes = scheduled.reduce((s, l) => s + l.expectedMinutes, 0)
  const shortMinutes = scheduled.reduce((s, l) => s + l.shortMinutes, 0)
  const pending = await db.request.count({ where: { userId: { in: userIds }, status: { in: ['PENDING_TEAM_LEAD', 'PENDING_MANAGER', 'PENDING_HR'] } } })
  return {
    headcount: userIds.length,
    scheduledDays: scheduled.length,
    attendedDays,
    completeHoursPct: expectedMinutes > 0 ? Math.round(((expectedMinutes - shortMinutes) / expectedMinutes) * 100) : 100,
    shortHours: Math.round((shortMinutes / 60) * 10) / 10,
    absentDays: logs.filter((l) => l.status === 'ABSENT').length,
    missingPunches: logs.filter((l) => l.status === 'MISSING').length,
    pendingApprovals: pending,
  }
}

export function attentionFlag(s: { completeHoursPct: number; shortHours: number; absentDays: number; missingPunches: number }): { attentionNeeded: boolean; attentionReasons: string[] } {
  const reasons: string[] = []
  if (s.completeHoursPct < COMPLETE_PCT_ALERT) reasons.push(`Low completion ${s.completeHoursPct}%`)
  if (s.shortHours > SHORT_HOURS_ALERT_MIN / 60) reasons.push(`${s.shortHours}h short`)
  if (s.absentDays > ABSENT_ALERT_DAYS) reasons.push(`${s.absentDays} absent days`)
  if (s.missingPunches > 3) reasons.push(`${s.missingPunches} missing punches`)
  return { attentionNeeded: reasons.length > 0, attentionReasons: reasons.slice(0, 2) }
}

/** Level-1 department health matrix. */
export async function departmentMatrix(month: string): Promise<(UnitStats & { teams: number })[]> {
  const departments = await db.department.findMany({ include: { users: { where: { isActive: true, role: { not: 'SUPER_ADMIN' } }, select: { id: true } }, teams: { select: { id: true } } } })
  const out: (UnitStats & { teams: number })[] = []
  for (const d of departments) {
    const ids = d.users.map((u) => u.id)
    const s = await computeStats(month, ids)
    const flag = attentionFlag(s)
    out.push({
      id: d.id, name: d.name, code: d.code,
      teams: d.teams.length,
      ...s,
      ...flag,
    })
  }
  return out.sort((a, b) => b.attentionNeeded ? 1 : a.completeHoursPct - b.completeHoursPct)
}

/** Level-2 team breakdown within a department (+ unassigned bucket). */
export async function teamBreakdown(departmentId: string, month: string): Promise<(UnitStats & { teamLeadName: string | null })[]> {
  const teams = await db.team.findMany({
    where: { departmentId },
    include: {
      teamLead: { select: { fullName: true } },
      users: { where: { isActive: true, role: { not: 'SUPER_ADMIN' } }, select: { id: true } },
    },
  })
  const out: (UnitStats & { teamLeadName: string | null })[] = []
  for (const t of teams) {
    const ids = t.users.map((u) => u.id)
    const s = await computeStats(month, ids)
    out.push({ id: t.id, name: t.name, teamLeadName: t.teamLead?.fullName ?? null, ...s, ...attentionFlag(s) })
  }
  return out
}

/** Level-3 employee roster with quick status pills. */
export type RosterMember = {
  id: string
  fullName: string
  employeeCode: string
  designation: string
  avatarColor: string
  role: string
  shortHours: number
  absentDays: number
  missingPunches: number
  lateCount: number
  pill: 'ON_TRACK' | 'SHORT_HOURS_ALERT' | 'MISSING_PUNCH' | 'ATTENTION'
}

export async function rosterFor(userIds: string[], month: string): Promise<RosterMember[]> {
  const { fromKey, toKey } = monthRangeKeys(month)
  const to = month === todayKey().slice(0, 7) ? todayKey() : toKey
  if (!userIds.length) return []
  const users = await db.user.findMany({
    where: { id: { in: userIds }, isActive: true },
    select: { id: true, fullName: true, employeeCode: true, designation: true, avatarColor: true, role: true },
    orderBy: { employeeCode: 'asc' },
  })
  const logs = await db.attendanceLog.findMany({ where: { userId: { in: userIds }, dateKey: { gte: fromKey, lte: to } } })
  const byUser = new Map<string, { short: number; absent: number; missing: number; late: number }>()
  for (const l of logs) {
    const cur = byUser.get(l.userId) ?? { short: 0, absent: 0, missing: 0, late: 0 }
    cur.short += l.shortMinutes
    if (l.status === 'ABSENT') cur.absent++
    if (l.status === 'MISSING') cur.missing++
    if (l.lateMinutes > 0) cur.late++
    byUser.set(l.userId, cur)
  }
  return users.map((u) => {
    const m = byUser.get(u.id) ?? { short: 0, absent: 0, missing: 0, late: 0 }
    const shortHours = Math.round((m.short / 60) * 10) / 10
    let pill: RosterMember['pill'] = 'ON_TRACK'
    if (m.missing > 0) pill = 'MISSING_PUNCH'
    if (shortHours > 4) pill = 'SHORT_HOURS_ALERT'
    if (shortHours > 4 && m.missing > 0) pill = 'ATTENTION'
    return {
      id: u.id, fullName: u.fullName, employeeCode: u.employeeCode,
      designation: u.designation, avatarColor: u.avatarColor, role: u.role,
      shortHours, absentDays: m.absent, missingPunches: m.missing, lateCount: m.late,
      pill,
    }
  })
}
