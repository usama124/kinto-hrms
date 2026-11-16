'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Transition } from 'framer-motion'
import { AnimatePresence, motion } from 'framer-motion'
import {
  AlertTriangle, ArrowLeft, Building2, CalendarCheck2, CalendarPlus, ChevronRight,
  Clock, Gauge, Hourglass, Inbox, Leaf, Loader2, LogIn, LogOut, Plane, RefreshCw,
  ScanLine, Search, Timer, TrendingDown, UserX, Users,
} from 'lucide-react'
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip as RTooltip, ResponsiveContainer, Legend } from 'recharts'
import { toast } from 'sonner'
import {
  api, ApiError, fmtMinutes, timeLabel,
  type SessionUser, type DashboardData, type UnitStats, type RosterMember, avatarSrc } from '@/lib/hrms/client'
import { Avatar, EmptyState, GlassCard, KpiCard, KeyValue, Pill, ScoreRing, SectionTitle, SegmentedBar } from './shared'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ROLES, isOrgAdmin } from '@/lib/hrms/constants'
import { cn } from '@/lib/utils'

// ─── Drill-down response shapes ────────────────────────────────────────────────

type DeptCard = UnitStats & { teams: number }
type TeamCard = UnitStats & { teamLeadName: string | null }
type TeamsResponse = {
  department: { id: string; name: string; code: string }
  month: string
  teams: TeamCard[]
  unassigned?: { count: number; stats: { completeHoursPct: number; shortHours: number } }
}
type RosterResponse = {
  team: { id: string; name: string; departmentName: string; teamLeadName: string | null }
  month: string
  members: RosterMember[]
}

const MEMBER_PILL: Record<RosterMember['pill'], { text: string; tone: string }> = {
  ON_TRACK: { text: 'On Track', tone: 'emerald' },
  SHORT_HOURS_ALERT: { text: 'Short Hours Alert', tone: 'orange' },
  MISSING_PUNCH: { text: 'Missing Punch', tone: 'amber' },
  ATTENTION: { text: 'Attention', tone: 'rose' },
}

const levelTransition: Transition = { duration: 0.25, ease: [0.22, 1, 0.36, 1] }

// ─── Helpers ───────────────────────────────────────────────────────────────────

function monthKeyOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

function buildMonthOptions(n: number): { key: string; label: string }[] {
  const now = new Date()
  const out: { key: string; label: string }[] = []
  for (let i = 0; i < n; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    out.push({
      key: monthKeyOf(d),
      label: new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric' }).format(d),
    })
  }
  return out
}

/** Ask the global People handler to open a 360 profile. */
function openProfile(userId: string) {
  window.dispatchEvent(new CustomEvent('hrms:open-profile', { detail: { userId } }))
}

function pctTone(pct: number): string {
  return pct >= 90 ? 'text-emerald-600' : pct >= 75 ? 'text-amber-600' : 'text-rose-600'
}

// ─── Small presentational pieces ───────────────────────────────────────────────

function MiniStat({ label, value, className }: { label: string; value: React.ReactNode; className?: string }) {
  return (
    <div className="min-w-0" title={label}>
      <p className="text-[10px] font-medium uppercase tracking-wide text-slate-400 truncate">{label}</p>
      <p className={cn('mt-0.5 text-sm font-bold text-slate-700 tnum truncate', className)}>{value}</p>
    </div>
  )
}

function StatCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 text-right">
      <p className="text-[10px] font-medium uppercase tracking-wide text-slate-400 truncate">{label}</p>
      <p className="mt-0.5 text-sm font-semibold text-slate-700 tnum">{value}</p>
    </div>
  )
}

/** Clickable Level-1 / Level-2 health card (department or team). */
function UnitCard({ unit, hint, delay = 0, onClick }: {
  unit: UnitStats
  hint?: string
  delay?: number
  onClick: () => void
}) {
  return (
    <motion.button
      type="button"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay, duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
      whileHover={{ y: -2 }}
      onClick={onClick}
      className="glass glass-hover w-full p-4 text-left cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500/40"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-bold text-slate-800 truncate">{unit.name}</p>
          <p className="text-[11px] text-slate-400 tnum">{unit.code ?? '—'}</p>
        </div>
        {unit.attentionNeeded ? <Pill text="Attention Needed" tone="amber" /> : null}
      </div>
      {unit.attentionNeeded && unit.attentionReasons.length > 0 ? (
        <p className="mt-1.5 text-[11px] text-amber-600 truncate">{unit.attentionReasons.join(' · ')}</p>
      ) : null}
      <div className="mt-3 grid grid-cols-4 gap-2">
        <MiniStat label="Headcount" value={unit.headcount} />
        <MiniStat label="Complete %" value={`${unit.completeHoursPct}%`} className={pctTone(unit.completeHoursPct)} />
        <MiniStat label="Short (h)" value={unit.shortHours} />
        <MiniStat label="Pending" value={unit.pendingApprovals} />
      </div>
      <div className="mt-3 flex items-center justify-between gap-2 text-[11px] text-slate-400">
        <span className="truncate">{hint ?? 'View breakdown'}</span>
        <ChevronRight className="h-3.5 w-3.5 shrink-0" />
      </div>
    </motion.button>
  )
}

/** Roster row shared by Level-3 drill-down and My Team Overview. */
function RosterRow({ m, showLate = false }: { m: RosterMember; showLate?: boolean }) {
  const pill = MEMBER_PILL[m.pill]
  return (
    <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4 px-3 py-2.5 rounded-xl hover:bg-white/70 transition-colors">
      <div className="flex items-center gap-3 min-w-0 flex-1">
        <Avatar name={m.fullName} color={m.avatarColor} size="sm" src={avatarSrc(m)} />
        <div className="min-w-0">
          <button
            type="button"
            onClick={() => openProfile(m.id)}
            className="block max-w-full truncate text-sm font-semibold text-slate-700 hover:text-teal-700 transition-colors"
            title="Open profile"
          >
            {m.fullName}
          </button>
          <p className="text-[11px] text-slate-400 tnum truncate">{m.employeeCode} · {m.designation}</p>
        </div>
      </div>
      <Pill text={pill.text} tone={pill.tone} />
      <div className={cn('grid gap-2 shrink-0', showLate ? 'grid-cols-4 sm:w-[300px]' : 'grid-cols-3 sm:w-[240px]')}>
        <StatCell label="Short" value={`${m.shortHours}h`} />
        <StatCell label="Absent" value={String(m.absentDays)} />
        <StatCell label="Missing" value={String(m.missingPunches)} />
        {showLate ? <StatCell label="Late" value={String(m.lateCount)} /> : null}
      </div>
    </div>
  )
}

/** Late (amber) vs Short (teal) minutes trend. */
function TrendChart({ rows, className }: { rows: { name: string; late: number; short: number }[]; className?: string }) {
  return (
    <div className={cn('-ml-2', className ?? 'h-64 md:h-72')}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={rows} margin={{ top: 4, right: 12, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="dashLate" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#f59e0b" stopOpacity={0.32} />
              <stop offset="100%" stopColor="#f59e0b" stopOpacity={0.02} />
            </linearGradient>
            <linearGradient id="dashShort" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#0d9488" stopOpacity={0.32} />
              <stop offset="100%" stopColor="#0d9488" stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
          <XAxis dataKey="name" tick={{ fontSize: 10, fill: '#94a3b8' }} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={24} />
          <YAxis tick={{ fontSize: 10, fill: '#94a3b8' }} tickLine={false} axisLine={false} width={36} />
          <RTooltip contentStyle={{ borderRadius: 12, border: '1px solid #e2e8f0', fontSize: 12, background: 'rgba(255,255,255,0.92)', backdropFilter: 'blur(8px)' }} />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          <Area type="monotone" dataKey="late" name="Late (min)" stroke="#d97706" strokeWidth={2.5} fill="url(#dashLate)" />
          <Area type="monotone" dataKey="short" name="Short (min)" stroke="#0d9488" strokeWidth={2} fill="url(#dashShort)" />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}

// ─── Loading skeletons ─────────────────────────────────────────────────────────

function DashboardSkeleton({ org }: { org: boolean }) {
  return (
    <div className="space-y-4 md:space-y-5">
      <div className={cn('grid grid-cols-2 md:grid-cols-4 gap-3', !org && 'xl:grid-cols-7')}>
        {Array.from({ length: org ? 4 : 7 }).map((_, i) => <div key={i} className="glass h-24 animate-pulse" />)}
      </div>
      <div className="grid lg:grid-cols-3 gap-4 md:gap-5">
        <div className="glass h-72 animate-pulse lg:col-span-2" />
        <div className="glass h-72 animate-pulse" />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
        {Array.from({ length: org ? 6 : 3 }).map((_, i) => <div key={i} className="glass h-40 animate-pulse" />)}
      </div>
    </div>
  )
}

function CardGridSkeleton({ count = 3 }: { count?: number }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
      {Array.from({ length: count }).map((_, i) => <div key={i} className="glass h-36 animate-pulse" />)}
    </div>
  )
}

function RowsSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: rows }).map((_, i) => <div key={i} className="h-12 rounded-xl bg-white/60 animate-pulse" />)}
    </div>
  )
}

// ─── DashboardView ─────────────────────────────────────────────────────────────

export function DashboardView({ user, onGoRequests }: { user: SessionUser; onGoRequests: () => void }) {
  const MONTHS = useMemo(() => buildMonthOptions(6), [])
  const [month, setMonth] = useState<string>(() => monthKeyOf(new Date()))
  const [data, setData] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Drill-down state machine: Level 1 (matrix) -> Level 2 (teams) -> Level 3 (roster)
  const [deptId, setDeptId] = useState<string | null>(null)
  const [teamId, setTeamId] = useState<string | null>(null)
  const [teamsRes, setTeamsRes] = useState<TeamsResponse | null>(null)
  const [teamsLoading, setTeamsLoading] = useState(false)
  const [teamsError, setTeamsError] = useState<string | null>(null)
  const [rosterRes, setRosterRes] = useState<RosterResponse | null>(null)
  const [rosterLoading, setRosterLoading] = useState(false)
  const [rosterError, setRosterError] = useState<string | null>(null)
  const [drillNonce, setDrillNonce] = useState(0)

  const [punching, setPunching] = useState(false)
  const [teamQuery, setTeamQuery] = useState('')

  const isOrgViewer = isOrgAdmin(user.role)

  const load = useCallback(async (m: string) => {
    setLoading(true)
    setError(null)
    try {
      const res = await api<DashboardData>(`/api/dashboard?month=${m}`)
      setData(res)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load dashboard')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    setDeptId(null)
    setTeamId(null)
    setTeamsRes(null)
    setRosterRes(null)
    setTeamQuery('')
    void load(month)
  }, [month, load])

  // Level 2 — team breakdown for the selected department
  useEffect(() => {
    if (!deptId) { setTeamsRes(null); setTeamsError(null); return }
    let alive = true
    setTeamsLoading(true)
    setTeamsError(null)
    api<TeamsResponse>(`/api/organizations/${deptId}/teams?month=${month}`)
      .then((r) => { if (alive) setTeamsRes(r) })
      .catch((err) => {
        if (!alive) return
        const msg = err instanceof ApiError ? err.message : 'Failed to load teams'
        setTeamsError(msg)
        toast.error(msg)
      })
      .finally(() => { if (alive) setTeamsLoading(false) })
    return () => { alive = false }
  }, [deptId, month, drillNonce])

  // Level 3 — employee roster for the selected team
  useEffect(() => {
    if (!teamId) { setRosterRes(null); setRosterError(null); return }
    let alive = true
    setRosterLoading(true)
    setRosterError(null)
    api<RosterResponse>(`/api/teams/${teamId}?month=${month}`)
      .then((r) => { if (alive) setRosterRes(r) })
      .catch((err) => {
        if (!alive) return
        const msg = err instanceof ApiError ? err.message : 'Failed to load roster'
        setRosterError(msg)
        toast.error(msg)
      })
      .finally(() => { if (alive) setRosterLoading(false) })
    return () => { alive = false }
  }, [teamId, month, drillNonce])

  async function punch(type: 'IN' | 'OUT') {
    setPunching(true)
    try {
      await api('/api/attendance/punch', { method: 'POST', body: JSON.stringify({ type }) })
      toast.success(type === 'IN' ? 'Checked in — have a productive shift.' : 'Checked out — your day has been logged.')
      await load(month)
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Punch failed')
    } finally {
      setPunching(false)
    }
  }

  // Derived, safely-typed views of the payload
  const k = data && data.kind === 'personal' ? data.kpis ?? null : null
  const orgStats = data && data.kind === 'org' ? data.orgStats ?? null : null
  const departments: DeptCard[] = data && data.kind === 'org' ? data.departments ?? [] : []
  const leaveSummary = data && data.kind === 'personal' ? data.leaveSummary : []
  const teamOverview: RosterMember[] | null = data && data.kind === 'personal' && Array.isArray(data.teamOverview) ? data.teamOverview : null
  const todayPunch = data && data.kind === 'personal' ? data.todayPunch ?? null : null
  const shift = data && data.kind === 'personal' ? data.shift ?? null : null
  const canPunch = data?.kind === 'personal' && data.canPunch === true
  const canCreateRequest = data?.kind === 'personal' && data.canCreateRequest === true
  const pendingApprovals = data?.pendingApprovals ?? 0
  const trendRows = useMemo(() => (data?.trend ?? []).map((t) => ({ name: t.label, late: t.late, short: t.short })), [data])

  const showTeamOverview = (user.role === ROLES.MANAGER || user.role === ROLES.TEAM_LEAD) && teamOverview !== null
  const filteredTeam = useMemo(() => {
    const list = teamOverview ?? []
    const q = teamQuery.trim().toLowerCase()
    if (!q) return list
    return list.filter((m) =>
      m.fullName.toLowerCase().includes(q)
      || m.employeeCode.toLowerCase().includes(q)
      || m.designation.toLowerCase().includes(q),
    )
  }, [teamOverview, teamQuery])

  const nextPunch: 'IN' | 'OUT' | null = !todayPunch?.checkIn ? 'IN' : !todayPunch?.checkOut ? 'OUT' : null
  const rosterAttention = (rosterRes?.members ?? []).filter((m) => m.pill !== 'ON_TRACK').length

  return (
    <div className="space-y-4 md:space-y-5 hrms-enter">
      {/* Header: title + month selector + refresh */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg md:text-xl font-bold text-slate-800">
            {orgStats ? 'Organization Pulse' : user.role === ROLES.EMPLOYEE ? 'My Workspace' : `Hello, ${user.fullName.split(' ')[0]}`}
          </h1>
          <p className="text-xs text-slate-500 mt-0.5">
            {orgStats
              ? 'Executive drill-down — department health, team breakdown and employee rosters.'
              : 'Your attendance, leaves and requests at a glance.'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={month} onValueChange={(v) => setMonth(v)}>
            <SelectTrigger size="sm" className="w-[170px] bg-white/70 text-xs" aria-label="Select month">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MONTHS.map((m) => <SelectItem key={m.key} value={m.key} className="text-xs">{m.label}</SelectItem>)}
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="icon"
            onClick={() => void load(month)}
            disabled={loading}
            aria-label="Refresh dashboard"
            className="bg-white/70"
          >
            <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
          </Button>
        </div>
      </div>

      {loading && !data ? (
        <DashboardSkeleton org={isOrgViewer} />
      ) : error && !data ? (
        <GlassCard className="p-6">
          <EmptyState icon={<AlertTriangle className="h-8 w-8" />} title="Could not load dashboard" hint={error} />
          <div className="flex justify-center">
            <Button size="sm" onClick={() => void load(month)} className="bg-teal-600 hover:bg-teal-700 text-white">Try again</Button>
          </div>
        </GlassCard>
      ) : orgStats ? (
        /* ─────────────────────────── ORG — 3-level drill-down ─────────────────────────── */
        <AnimatePresence mode="wait">
          {!teamId && !deptId ? (
            /* Level 1 — Department Health Matrix */
            <motion.div
              key="org-l1"
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={levelTransition}
              className="space-y-4 md:space-y-5"
            >
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <KpiCard label="Active Headcount" value={String(orgStats.headcount)} sub="org-wide" icon={<Users className="h-4 w-4" />} accent="teal" />
                <KpiCard
                  label="Complete Hours" value={`${orgStats.completeHoursPct}%`}
                  sub={`Absents ${orgStats.absentDays} · Missing ${orgStats.missingPunches}`}
                  icon={<Gauge className="h-4 w-4" />} accent="emerald" delay={0.03}
                />
                <KpiCard label="Short Hours" value={`${orgStats.shortHours}h`} sub="month total" icon={<Hourglass className="h-4 w-4" />} accent="orange" delay={0.06} />
                <KpiCard
                  label="Pending Requests" value={String(orgStats.pendingRequests)}
                  sub={`${orgStats.pendingLeave} leave · ${orgStats.pendingAttendance} attendance`}
                  icon={<Inbox className="h-4 w-4" />} accent="amber" delay={0.09}
                />
              </div>

              <div className="grid lg:grid-cols-3 gap-4 md:gap-5">
                <motion.div
                  initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1, duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
                  className="lg:col-span-2"
                >
                  <GlassCard className="p-4 md:p-5">
                    <SectionTitle
                      action={(
                        <span className="flex items-center gap-1 text-[11px] text-slate-400">
                          <TrendingDown className="h-3 w-3" /> late vs short · minutes per day
                        </span>
                      )}
                    >
                      Check-In Trend
                    </SectionTitle>
                    <TrendChart rows={trendRows} className="h-52" />
                  </GlassCard>
                </motion.div>

                <motion.div
                  initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.14, duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
                >
                  <GlassCard className="p-4 md:p-5 border border-teal-200/60">
                    <SectionTitle action={<span className="text-[11px] text-slate-400">org-wide queue</span>}>Pending Approvals</SectionTitle>
                    <p className="text-3xl font-bold text-slate-800 tnum">{orgStats.pendingRequests}</p>
                    <p className="mt-0.5 text-xs text-slate-500 tnum">
                      {orgStats.pendingLeave} leave requests · {orgStats.pendingAttendance} attendance requests
                    </p>
                    <Button onClick={onGoRequests} className="mt-4 w-full bg-teal-600 hover:bg-teal-700 text-white h-9 text-xs">
                      Open request queue
                    </Button>
                  </GlassCard>
                </motion.div>
              </div>

              <div>
                <SectionTitle action={<span className="text-[11px] text-slate-400">Click a department to drill into its teams</span>}>
                  Department Health Matrix
                </SectionTitle>
                {departments.length === 0 ? (
                  <GlassCard className="p-6">
                    <EmptyState icon={<Building2 className="h-8 w-8" />} title="No departments configured" hint="Create departments and assign employees first." />
                  </GlassCard>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
                    {departments.map((d, i) => (
                      <UnitCard
                        key={d.id}
                        unit={d}
                        hint={`${d.teams} ${d.teams === 1 ? 'team' : 'teams'}`}
                        delay={i * 0.03}
                        onClick={() => setDeptId(d.id)}
                      />
                    ))}
                  </div>
                )}
              </div>
            </motion.div>
          ) : deptId && !teamId ? (
            /* Level 2 — Team Breakdown */
            <motion.div
              key="org-l2"
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={levelTransition}
              className="space-y-4"
            >
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="ghost" size="sm" onClick={() => setDeptId(null)} className="-ml-2 h-8 text-slate-500 hover:text-teal-700">
                  <ArrowLeft className="h-4 w-4" /> Back to departments
                </Button>
                <span className="text-slate-300 text-xs">/</span>
                <h2 className="text-sm font-bold text-slate-700">{teamsRes?.department.name ?? 'Department'}</h2>
                {teamsRes?.department.code ? (
                  <span className="glass-subtle px-2 py-0.5 text-[10px] font-semibold text-slate-500 tnum">{teamsRes.department.code}</span>
                ) : null}
              </div>

              {teamsLoading ? (
                <CardGridSkeleton />
              ) : teamsError ? (
                <GlassCard className="p-6">
                  <EmptyState icon={<AlertTriangle className="h-8 w-8" />} title="Could not load teams" hint={teamsError} />
                  <div className="flex justify-center">
                    <Button size="sm" variant="outline" onClick={() => setDrillNonce((n) => n + 1)} className="bg-white/70">Try again</Button>
                  </div>
                </GlassCard>
              ) : teamsRes ? (
                <>
                  {teamsRes.unassigned && teamsRes.unassigned.count > 0 ? (
                    <div className="glass-subtle px-3 py-2 text-[11px] text-slate-500 tnum">
                      {teamsRes.unassigned.count} member{teamsRes.unassigned.count === 1 ? '' : 's'} not assigned to any team · complete {teamsRes.unassigned.stats.completeHoursPct}% · short {teamsRes.unassigned.stats.shortHours}h
                    </div>
                  ) : null}
                  {teamsRes.teams.length === 0 ? (
                    <GlassCard className="p-6">
                      <EmptyState icon={<Building2 className="h-8 w-8" />} title="No teams in this department" hint="Employees here may be unassigned — see the note above." />
                    </GlassCard>
                  ) : (
                    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
                      {teamsRes.teams.map((t, i) => (
                        <UnitCard
                          key={t.id}
                          unit={t}
                          hint={t.teamLeadName ? `Lead: ${t.teamLeadName}` : 'No team lead assigned'}
                          delay={i * 0.03}
                          onClick={() => setTeamId(t.id)}
                        />
                      ))}
                    </div>
                  )}
                </>
              ) : null}
            </motion.div>
          ) : (
            /* Level 3 — Employee Roster */
            <motion.div
              key="org-l3"
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={levelTransition}
              className="space-y-4"
            >
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="ghost" size="sm" onClick={() => setTeamId(null)} className="-ml-2 h-8 text-slate-500 hover:text-teal-700">
                  <ArrowLeft className="h-4 w-4" /> Back to teams
                </Button>
                <span className="text-slate-300 text-xs">/</span>
                <h2 className="text-sm font-bold text-slate-700">{rosterRes?.team.name ?? 'Team'}</h2>
                {rosterRes ? (
                  <p className="text-[11px] text-slate-400 tnum truncate">
                    {rosterRes.team.departmentName}{rosterRes.team.teamLeadName ? ` · Lead: ${rosterRes.team.teamLeadName}` : ''}
                  </p>
                ) : null}
              </div>

              <GlassCard className="p-4 md:p-5">
                <SectionTitle
                  action={rosterRes ? (
                    <span className="text-[11px] text-slate-400 tnum">
                      {rosterAttention} of {rosterRes.members.length} need attention
                    </span>
                  ) : undefined}
                >
                  Employee Roster
                </SectionTitle>
                {rosterLoading ? (
                  <RowsSkeleton />
                ) : rosterError ? (
                  <>
                    <EmptyState icon={<AlertTriangle className="h-8 w-8" />} title="Could not load roster" hint={rosterError} />
                    <div className="flex justify-center">
                      <Button size="sm" variant="outline" onClick={() => setDrillNonce((n) => n + 1)} className="bg-white/70">Try again</Button>
                    </div>
                  </>
                ) : rosterRes && rosterRes.members.length > 0 ? (
                  <div className="space-y-1 max-h-96 overflow-y-auto hrms-scroll -mx-1 px-1">
                    {rosterRes.members.map((m) => <RosterRow key={m.id} m={m} showLate />)}
                  </div>
                ) : (
                  <EmptyState icon={<Users className="h-8 w-8" />} title="No active members in this team" hint="Assign employees to this team to see their stats here." />
                )}
              </GlassCard>
            </motion.div>
          )}
        </AnimatePresence>
      ) : k ? (
        /* ─────────────────────────── PERSONAL — non-admin ─────────────────────────── */
        <motion.div
          key="personal"
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={levelTransition}
          className="space-y-4 md:space-y-5"
        >
          <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-7 gap-3">
            <KpiCard label="Shifts" value={String(k.shifts)} icon={<CalendarCheck2 className="h-4 w-4" />} />
            <KpiCard label="Expected" value={fmtMinutes(k.expectedMinutes)} icon={<Clock className="h-4 w-4" />} accent="sky" delay={0.03} />
            <KpiCard label="Worked" value={fmtMinutes(k.workedMinutes)} icon={<Timer className="h-4 w-4" />} accent="emerald" delay={0.06} />
            <KpiCard label="Short" value={fmtMinutes(k.shortMinutes)} icon={<Hourglass className="h-4 w-4" />} accent="orange" delay={0.09} />
            <KpiCard label="Leaves" value={String(k.leaves)} icon={<Leaf className="h-4 w-4" />} accent="violet" delay={0.12} />
            <KpiCard label="Travels" value={String(k.travels)} icon={<Plane className="h-4 w-4" />} accent="purple" delay={0.15} />
            <KpiCard label="Absents" value={String(k.absents)} icon={<UserX className="h-4 w-4" />} accent="rose" delay={0.18} />
          </div>

          <div className="grid lg:grid-cols-3 gap-4 md:gap-5">
            <motion.div
              initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1, duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
              className="lg:col-span-2"
            >
              <GlassCard className="p-4 md:p-5">
                <SectionTitle
                  action={(
                    <span className="flex items-center gap-1 text-[11px] text-slate-400">
                      <TrendingDown className="h-3 w-3" /> late vs short · minutes per day
                    </span>
                  )}
                >
                  Check-In Trend
                </SectionTitle>
                <TrendChart rows={trendRows} />
              </GlassCard>
            </motion.div>

            <motion.div
              initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.14, duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
              className="space-y-4"
            >
              {/* Attendance Score */}
              <GlassCard className="p-4 md:p-5">
                <SectionTitle action={<span className="text-[11px] text-slate-400 tnum">{k.shifts} shifts scheduled</span>}>
                  Attendance Score
                </SectionTitle>
                <div className="flex justify-center py-1">
                  {k.attendanceScore == null ? (
                    <div className="relative inline-flex h-[108px] w-[108px] items-center justify-center">
                      <div className="absolute inset-0 rounded-full border-[10px] border-slate-100" />
                      <div className="flex flex-col items-center">
                        <span className="text-2xl font-bold text-slate-300 tnum">—</span>
                        <span className="text-[10px] uppercase tracking-wide text-slate-400">MTD</span>
                      </div>
                    </div>
                  ) : (
                    <ScoreRing pct={k.attendanceScore} label="MTD" />
                  )}
                </div>
              </GlassCard>

              {/* Today punch */}
              <GlassCard className="p-4 md:p-5">
                <SectionTitle
                  action={todayPunch ? <Pill text={todayPunch.status} /> : <span className="text-[11px] text-slate-400">Not punched yet</span>}
                >
                  Today
                </SectionTitle>
                {canPunch ? (
                  <>
                    <p className="text-xs text-slate-500">
                      {shift ? `${shift.name} · ${shift.startTime.slice(0, 5)} – ${shift.endTime.slice(0, 5)}` : 'No shift assigned'}
                    </p>
                    <div className="mt-3 grid grid-cols-2 gap-3">
                      <KeyValue label="Check-In" value={timeLabel(todayPunch?.checkIn ?? null)} mono />
                      <KeyValue label="Check-Out" value={timeLabel(todayPunch?.checkOut ?? null)} mono />
                    </div>
                    <Button
                      onClick={() => nextPunch && void punch(nextPunch)}
                      disabled={punching || nextPunch === null}
                      className="mt-4 w-full bg-teal-600 hover:bg-teal-700 text-white"
                    >
                      {punching ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : nextPunch === 'OUT' ? (
                        <LogOut className="h-4 w-4" />
                      ) : (
                        <LogIn className="h-4 w-4" />
                      )}
                      {nextPunch === 'IN' ? 'Check In' : nextPunch === 'OUT' ? 'Check Out' : 'Day complete'}
                    </Button>
                  </>
                ) : (
                  <div className="flex items-start gap-3 glass-subtle p-3">
                    <ScanLine className="h-4 w-4 shrink-0 text-slate-400 mt-0.5" />
                    <p className="text-xs text-slate-500">
                      Web punching is not enabled for this account — attendance is captured via biometric devices and HR records.
                    </p>
                  </div>
                )}
              </GlassCard>

              {/* Quick actions */}
              <GlassCard className="p-4 md:p-5">
                <SectionTitle>Quick Actions</SectionTitle>
                {canCreateRequest ? (
                  <Button onClick={onGoRequests} className="w-full bg-teal-600 hover:bg-teal-700 text-white">
                    <CalendarPlus className="h-4 w-4" /> Create request
                  </Button>
                ) : null}
                <button
                  type="button"
                  onClick={onGoRequests}
                  className={cn(
                    'w-full flex items-center gap-3 glass-subtle p-3 text-left hover:bg-white/80 transition-colors',
                    canCreateRequest && 'mt-3',
                  )}
                >
                  <div className="rounded-xl bg-amber-50 p-2 text-amber-600 shrink-0"><Inbox className="h-4 w-4" /></div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-slate-700 tnum">
                      {pendingApprovals} request{pendingApprovals === 1 ? '' : 's'} pending
                    </p>
                    <p className="text-[11px] text-slate-400">Review in the Requests queue</p>
                  </div>
                  <ChevronRight className="h-4 w-4 shrink-0 text-slate-400" />
                </button>
              </GlassCard>
            </motion.div>
          </div>

          <div className={cn('grid gap-4 md:gap-5', showTeamOverview && 'lg:grid-cols-3')}>
            {/* Leave Summary */}
            <GlassCard className={cn('p-4 md:p-5', showTeamOverview && 'lg:col-span-1')}>
              <SectionTitle action={<span className="text-[11px] text-slate-400">month to date</span>}>Leave Summary</SectionTitle>
              {leaveSummary.length === 0 ? (
                <EmptyState title="No leave balance configured" hint="Contact HR to set up your quotas." />
              ) : (
                <div className="space-y-3.5">
                  {leaveSummary.map((s) => (
                    <div key={s.leaveTypeId}>
                      <div className="flex items-center justify-between gap-2 mb-1.5">
                        <span className="flex items-center gap-1.5 text-xs font-semibold text-slate-600 min-w-0">
                          <span className="h-2 w-2 rounded-full shrink-0" style={{ backgroundColor: s.color }} />
                          <span className="truncate">{s.name}</span>
                        </span>
                        <span className="text-[11px] text-slate-400 tnum shrink-0">{s.availed} of {s.total} days used</span>
                      </div>
                      <SegmentedBar
                        segments={[
                          { value: s.availed, color: s.color, label: 'Availed' },
                          { value: s.pending, color: '#f59e0b', label: 'Pending' },
                          { value: Math.max(0, s.available), color: '#e2e8f0', label: 'Available' },
                        ]}
                      />
                      <div className="mt-1 flex gap-3 text-[10px] text-slate-400 tnum">
                        <span>Pending <b className="text-slate-600">{s.pending}</b></span>
                        <span>Available <b className="text-slate-600">{s.available}</b></span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </GlassCard>

            {/* My Team Overview */}
            {showTeamOverview && teamOverview ? (
              <GlassCard className="p-4 md:p-5 lg:col-span-2">
                <SectionTitle action={<span className="text-[11px] text-slate-400 tnum">{teamOverview.length} members</span>}>
                  My Team Overview
                </SectionTitle>
                <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400" />
                  <Input
                    value={teamQuery}
                    onChange={(e) => setTeamQuery(e.target.value)}
                    placeholder="Search by name, code or designation"
                    aria-label="Search team members"
                    className="h-9 pl-8 text-xs bg-white/70"
                  />
                </div>
                <div className="mt-3 space-y-1 max-h-96 overflow-y-auto hrms-scroll -mx-1 px-1">
                  {teamOverview.length === 0 ? (
                    <EmptyState icon={<Users className="h-8 w-8" />} title="No direct reports" hint="People assigned to you will appear here." />
                  ) : filteredTeam.length === 0 ? (
                    <p className="text-xs text-slate-400 py-6 text-center">No members match your search.</p>
                  ) : (
                    filteredTeam.map((m) => <RosterRow key={m.id} m={m} />)
                  )}
                </div>
              </GlassCard>
            ) : null}
          </div>
        </motion.div>
      ) : (
        <GlassCard className="p-6">
          <EmptyState icon={<Inbox className="h-8 w-8" />} title="No dashboard data available" hint="Try selecting another month." />
        </GlassCard>
      )}
    </div>
  )
}
