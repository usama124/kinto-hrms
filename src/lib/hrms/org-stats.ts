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

type Totals = { scheduled: number; attended: number; expected: number; short: number; absent: number; missing: number }
const PENDING = ['PENDING_TEAM_LEAD', 'PENDING_MANAGER', 'PENDING_HR']
const emptyTotals = (): Totals => ({ scheduled: 0, attended: 0, expected: 0, short: 0, absent: 0, missing: 0 })

/**
 * Per-user attendance totals for the month, aggregated BY THE DATABASE (two GROUP BY queries) instead of shipping every
 * attendance row to Node: a 500-person org is ~11k rows/month, and the old code re-read them for the org, for every
 * department and for every team on a single dashboard load. The result here is users × few statuses — tiny.
 */
async function aggregateByUser(month: string, userIds: string[]): Promise<{ totals: Map<string, Totals>; pending: Map<string, number> }> {
  const totals = new Map<string, Totals>()
  const pending = new Map<string, number>()
  if (!userIds.length) return { totals, pending }
  const { fromKey, toKey } = monthRangeKeys(month)
  const to = month === todayKey().slice(0, 7) ? todayKey() : toKey
  const range = { userId: { in: userIds }, dateKey: { gte: fromKey, lte: to } }
  const [byStatus, scheduled, pend] = await Promise.all([
    db.attendanceLog.groupBy({ by: ['userId', 'status'], where: range, _count: { _all: true } }),
    // "scheduled" = a working day with expected minutes (same rule as before, evaluated in SQL)
    db.attendanceLog.groupBy({
      by: ['userId'],
      where: { ...range, status: { notIn: [...NON_WORKING_STATUSES] }, expectedMinutes: { gt: 0 } },
      _count: { _all: true }, _sum: { expectedMinutes: true, shortMinutes: true },
    }),
    db.request.groupBy({ by: ['userId'], where: { userId: { in: userIds }, status: { in: PENDING } }, _count: { _all: true } }),
  ])
  const get = (id: string) => { let t = totals.get(id); if (!t) { t = emptyTotals(); totals.set(id, t) } return t }
  for (const r of byStatus) {
    const t = get(r.userId)
    if ((WORKED_STATUS_SET as readonly string[]).includes(r.status)) t.attended += r._count._all
    if (r.status === 'ABSENT') t.absent += r._count._all
    if (r.status === 'MISSING') t.missing += r._count._all
  }
  for (const r of scheduled) {
    const t = get(r.userId)
    t.scheduled = r._count._all
    t.expected = r._sum.expectedMinutes ?? 0
    t.short = r._sum.shortMinutes ?? 0
  }
  for (const r of pend) pending.set(r.userId, r._count._all)
  return { totals, pending }
}

type StatsResult = { headcount: number; scheduledDays: number; attendedDays: number; completeHoursPct: number; shortHours: number; absentDays: number; missingPunches: number; pendingApprovals: number }

/** Pure reduction of the per-user aggregates for one group of users (department, team, whole org…). */
function reduceStats(userIds: string[], agg: { totals: Map<string, Totals>; pending: Map<string, number> }): StatsResult {
  const sum = emptyTotals()
  let pendingApprovals = 0
  for (const id of userIds) {
    const t = agg.totals.get(id)
    if (t) { sum.scheduled += t.scheduled; sum.attended += t.attended; sum.expected += t.expected; sum.short += t.short; sum.absent += t.absent; sum.missing += t.missing }
    pendingApprovals += agg.pending.get(id) ?? 0
  }
  return {
    headcount: userIds.length,
    scheduledDays: sum.scheduled,
    attendedDays: sum.attended,
    completeHoursPct: sum.expected > 0 ? Math.round(((sum.expected - sum.short) / sum.expected) * 100) : 100,
    shortHours: Math.round((sum.short / 60) * 10) / 10,
    absentDays: sum.absent,
    missingPunches: sum.missing,
    pendingApprovals,
  }
}

/** Aggregate attendance + pending-approval health for a set of user ids. */
export async function computeStats(month: string, userIds: string[]): Promise<StatsResult> {
  return reduceStats(userIds, await aggregateByUser(month, userIds))
}

export function attentionFlag(s: { completeHoursPct: number; shortHours: number; absentDays: number; missingPunches: number }): { attentionNeeded: boolean; attentionReasons: string[] } {
  const reasons: string[] = []
  if (s.completeHoursPct < COMPLETE_PCT_ALERT) reasons.push(`Low completion ${s.completeHoursPct}%`)
  if (s.shortHours > SHORT_HOURS_ALERT_MIN / 60) reasons.push(`${s.shortHours}h short`)
  if (s.absentDays > ABSENT_ALERT_DAYS) reasons.push(`${s.absentDays} absent days`)
  if (s.missingPunches > 3) reasons.push(`${s.missingPunches} missing punches`)
  return { attentionNeeded: reasons.length > 0, attentionReasons: reasons.slice(0, 2) }
}

/** Level-1 department health matrix (+ the org-wide totals) from ONE aggregation pass over the whole organisation. */
export async function departmentMatrixWithOrg(month: string): Promise<{ departments: (UnitStats & { teams: number })[]; org: StatsResult }> {
  const [departments, people] = await Promise.all([
    db.department.findMany({ include: { teams: { select: { id: true } } } }),
    db.user.findMany({ where: { isActive: true, role: { not: 'SUPER_ADMIN' } }, select: { id: true, departmentId: true } }),
  ])
  const allIds = people.map((u) => u.id)
  const agg = await aggregateByUser(month, allIds)
  const byDept = new Map<string, string[]>()
  for (const u of people) if (u.departmentId) { const a = byDept.get(u.departmentId) ?? []; a.push(u.id); byDept.set(u.departmentId, a) }
  const out: (UnitStats & { teams: number })[] = departments.map((d) => {
    const s = reduceStats(byDept.get(d.id) ?? [], agg)
    return { id: d.id, name: d.name, code: d.code, teams: d.teams.length, ...s, ...attentionFlag(s) }
  })
  out.sort((a, b) => b.attentionNeeded ? 1 : a.completeHoursPct - b.completeHoursPct)
  return { departments: out, org: reduceStats(allIds, agg) }
}

export async function departmentMatrix(month: string): Promise<(UnitStats & { teams: number })[]> {
  return (await departmentMatrixWithOrg(month)).departments
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
  const agg = await aggregateByUser(month, teams.flatMap((t) => t.users.map((u) => u.id)))
  return teams.map((t) => {
    const s = reduceStats(t.users.map((u) => u.id), agg)
    return { id: t.id, name: t.name, teamLeadName: t.teamLead?.fullName ?? null, ...s, ...attentionFlag(s) }
  })
}

/** Level-3 employee roster with quick status pills. */
export type RosterMember = {
  id: string
  fullName: string
  employeeCode: string
  designation: string
  avatarColor: string
  avatarUploadId: string | null
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
    select: { id: true, fullName: true, employeeCode: true, designation: true, avatarColor: true, avatarUploadId: true, role: true },
    orderBy: { employeeCode: 'asc' },
  })
  // aggregated in SQL (per user × status) instead of loading every attendance row
  const range = { userId: { in: userIds }, dateKey: { gte: fromKey, lte: to } }
  const [byStatus, lates] = await Promise.all([
    db.attendanceLog.groupBy({ by: ['userId', 'status'], where: range, _count: { _all: true }, _sum: { shortMinutes: true } }),
    db.attendanceLog.groupBy({ by: ['userId'], where: { ...range, lateMinutes: { gt: 0 } }, _count: { _all: true } }),
  ])
  const byUser = new Map<string, { short: number; absent: number; missing: number; late: number }>()
  const slot = (id: string) => { let c = byUser.get(id); if (!c) { c = { short: 0, absent: 0, missing: 0, late: 0 }; byUser.set(id, c) } return c }
  for (const r of byStatus) {
    const c = slot(r.userId)
    c.short += r._sum.shortMinutes ?? 0
    if (r.status === 'ABSENT') c.absent += r._count._all
    if (r.status === 'MISSING') c.missing += r._count._all
  }
  for (const r of lates) slot(r.userId).late = r._count._all
  return users.map((u) => {
    const m = byUser.get(u.id) ?? { short: 0, absent: 0, missing: 0, late: 0 }
    const shortHours = Math.round((m.short / 60) * 10) / 10
    let pill: RosterMember['pill'] = 'ON_TRACK'
    if (m.missing > 0) pill = 'MISSING_PUNCH'
    if (shortHours > 4) pill = 'SHORT_HOURS_ALERT'
    if (shortHours > 4 && m.missing > 0) pill = 'ATTENTION'
    return {
      id: u.id, fullName: u.fullName, employeeCode: u.employeeCode,
      designation: u.designation, avatarColor: u.avatarColor, avatarUploadId: u.avatarUploadId, role: u.role,
      shortHours, absentDays: m.absent, missingPunches: m.missing, lateCount: m.late,
      pill,
    }
  })
}
