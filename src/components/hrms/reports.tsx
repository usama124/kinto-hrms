'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  BarChart3, Download, FileText, Loader2, ScanSearch, ShieldAlert, UserSearch,
} from 'lucide-react'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RTooltip, ResponsiveContainer,
  LineChart, Line, Legend, AreaChart, Area, Cell,
} from 'recharts'
import { toast } from 'sonner'
import {
  api, ApiError, dayLabel, downloadFile, fmtMinutes, money2, timeLabel,
  type PersonLite, type SessionUser,
} from '@/lib/hrms/client'
import { Avatar, EmptyState, GlassCard, KpiCard, Pill, ScoreRing, SectionTitle, SegmentedBar } from './shared'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { STATUS_BADGE_TONE } from '@/lib/hrms/constants'

// ─── helpers & shared types ───────────────────────────────────────────────────

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** First day of the current month as YYYY-MM-DD */
function monthStartKey(): string {
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-01`
}

/** Today as YYYY-MM-DD */
function todayKey(): string {
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** "2026-01" → "Jan 26" (chart axis labels) */
function shortMonth(month: string): string {
  if (!/^\d{4}-\d{2}$/.test(month)) return month
  const [y, m] = month.split('-').map(Number)
  return new Intl.DateTimeFormat('en-GB', { month: 'short', year: '2-digit', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, 1)))
}

/** ISO datetime → "05 Nov" (UTC-anchored day) */
function isoDay(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', timeZone: 'UTC' }).format(new Date(iso))
}

function errText(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback
}

function ForbiddenAlert({ message }: { message: string }) {
  return (
    <Alert variant="destructive" className="glass">
      <ShieldAlert className="h-4 w-4" />
      <AlertTitle className="text-sm">Access denied</AlertTitle>
      <AlertDescription className="text-xs">{message}</AlertDescription>
    </Alert>
  )
}

const CHART_TIP = { borderRadius: 12, fontSize: 12, border: '1px solid #e2e8f0', background: 'rgba(255,255,255,0.92)' } as const

// Exact response shapes from GET /api/reports/org (src/app/api/reports/org/route.ts)
type OrgReport = {
  sections: string[]
  range: { from: string; to: string }
  attendanceTrend: { month: string; attendanceRate: number; punctualityRate: number; shortMinutes: number; absentDays: number }[]
  deptComparison: { department: string; employees: number; shortHours: number; absentDays: number; punctuality: number }[]
  leaveUtilization: { type: string; color: string; requests: number; availed: number; pending: number; rejected: number }[]
  payrollTrend: { month: string; gross: number; deductions: number; net: number }[]
  kpis: { headcount: number; attendanceRate: number; shortHours: number; absentDays: number }
}

// Exact response shape from GET /api/reports/individual (src/app/api/reports/individual/route.ts)
type IndividualReport = {
  employee: {
    id: string; fullName: string; employeeCode: string; designation: string
    departmentName: string; role: string; joiningDate: string
    teamLeadName: string; managerName: string; shiftName: string; avatarColor: string
  }
  sections: string[]
  range: { from: string; to: string }
  attendance: {
    score: number | null
    totals: { expected: number; worked: number; short: number; lateDays: number }
    lateFrequency: { dateKey: string; lateMinutes: number; checkIn: string | null }[]
  }
  leaves: {
    ledger: { leaveTypeId: string; name: string; color: string; carryForward: number; quota: number; availed: number; pending: number; lapsed: number; available: number }[]
    history: { id: string; type: string; color: string; startDate: string; endDate: string; dayCount: number; isShortLeave: boolean; shortHours: number; status: string; reason: string }[]
  }
  payroll: {
    id: string; month: string; grossPay: number; shortMinutes: number
    leaveDaysEquivalent: number; shortConvertedFromBalance: number
    shortHourDeduction: number; unpaidLeaveDays: number
    leaveDeduction: number; overtimeAmount: number; netPay: number
  }[]
}

// ─── Organization Analytics ───────────────────────────────────────────────────

function OrgAnalytics({ user }: { user: SessionUser }) {
  const [from, setFrom] = useState(monthStartKey())
  const [to, setTo] = useState(todayKey())
  const [org, setOrg] = useState<OrgReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [forbidden, setForbidden] = useState<string | null>(null)
  const isOrgAdmin = user.role === 'SUPER_ADMIN' || user.role === 'HR_MANAGER'

  const load = useCallback(async () => {
    if (from > to) { toast.error('Invalid date range — "From" must be before "To"'); return }
    setLoading(true)
    setForbidden(null)
    try {
      const res = await api<OrgReport>(`/api/reports/org?from=${from}&to=${to}`)
      setOrg(res)
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) setForbidden(err.message)
      else toast.error(errText(err, 'Failed to load organization analytics'))
      setOrg(null)
    } finally {
      setLoading(false)
    }
  }, [from, to])

  useEffect(() => { void load() }, [load])

  async function exportPdf(type: 'org-attendance' | 'leave-audit') {
    try {
      await downloadFile(`/api/reports/pdf?type=${type}&from=${from}&to=${to}`, `${type}.pdf`)
      toast.success(type === 'org-attendance' ? 'Org attendance summary PDF downloaded' : 'Leave audit PDF downloaded')
    } catch (err) {
      toast.error(errText(err, 'Export failed'))
    }
  }

  return (
    <div className="space-y-4">
      <GlassCard className="p-4 md:p-5">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label className="text-[11px] text-slate-500">From</Label>
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-9 bg-white/80 text-xs tnum w-[150px]" />
          </div>
          <div className="space-y-1">
            <Label className="text-[11px] text-slate-500">To</Label>
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-9 bg-white/80 text-xs tnum w-[150px]" />
          </div>
          {isOrgAdmin && (
            <div className="flex flex-wrap gap-2 sm:ml-auto">
              <Button size="sm" variant="outline" onClick={() => void exportPdf('org-attendance')} className="h-9 text-xs border-slate-200 text-slate-700 hover:bg-slate-50">
                <FileText className="h-3.5 w-3.5 mr-1" /> Org Attendance Summary PDF
              </Button>
              <Button size="sm" variant="outline" onClick={() => void exportPdf('leave-audit')} className="h-9 text-xs border-slate-200 text-slate-700 hover:bg-slate-50">
                <FileText className="h-3.5 w-3.5 mr-1" /> Leave Audit PDF
              </Button>
            </div>
          )}
        </div>
        <p className="mt-2 text-[10px] text-slate-400">
          Org-wide PDF exports are restricted to System Admin / HR Manager. {(user.role === 'ACCOUNTANT' || user.role === 'ACCOUNTS_MANAGER') ? 'Your payroll register PDF is available in the Payroll module.' : ''}
        </p>
      </GlassCard>

      {forbidden ? (
        <ForbiddenAlert message={forbidden} />
      ) : loading ? (
        <div className="space-y-4">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">{Array.from({ length: 4 }).map((_, i) => <div key={i} className="glass h-24 animate-pulse rounded-xl" />)}</div>
          <div className="glass h-64 animate-pulse rounded-xl" />
        </div>
      ) : org ? (
        <div className="space-y-4">
          {/* KPI chips (only render attendance KPIs when the section was returned) */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <KpiCard label="Headcount" value={String(org.kpis.headcount)} icon={<BarChart3 className="h-4 w-4" />} />
            {org.sections.includes('attendance') && (
              <>
                <KpiCard label="Attendance Rate" value={`${org.kpis.attendanceRate}%`} accent="emerald" delay={0.05} />
                <KpiCard label="Short Hours" value={`${org.kpis.shortHours}h`} accent="orange" delay={0.1} />
                <KpiCard label="Absent Days" value={String(org.kpis.absentDays)} accent="rose" delay={0.15} />
              </>
            )}
          </div>

          {org.sections.includes('attendance') && org.attendanceTrend.length > 0 && (
            <GlassCard className="p-4">
              <SectionTitle>Attendance & Punctuality Trend</SectionTitle>
              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={org.attendanceTrend.map((t) => ({ ...t, name: shortMonth(t.month) }))}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                    <XAxis dataKey="name" tick={{ fontSize: 10, fill: '#94a3b8' }} tickLine={false} axisLine={false} />
                    <YAxis tick={{ fontSize: 10, fill: '#94a3b8' }} tickLine={false} axisLine={false} width={32} unit="%" />
                    <RTooltip contentStyle={CHART_TIP} />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Line type="monotone" dataKey="attendanceRate" name="Attendance %" stroke="#0d9488" strokeWidth={2.5} dot={false} />
                    <Line type="monotone" dataKey="punctualityRate" name="Punctuality %" stroke="#64748b" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </GlassCard>
          )}

          {org.sections.includes('attendance') && org.deptComparison.length > 0 && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <GlassCard className="p-4">
                <SectionTitle>Department Comparison</SectionTitle>
                <div className="h-56">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={org.deptComparison}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                      <XAxis dataKey="department" tick={{ fontSize: 10, fill: '#94a3b8' }} tickLine={false} axisLine={false} />
                      <YAxis tick={{ fontSize: 10, fill: '#94a3b8' }} tickLine={false} axisLine={false} width={32} />
                      <RTooltip contentStyle={CHART_TIP} />
                      <Legend wrapperStyle={{ fontSize: 11 }} />
                      <Bar dataKey="shortHours" name="Short Hours" fill="#0d9488" radius={[6, 6, 0, 0]} />
                      <Bar dataKey="absentDays" name="Absent Days" fill="#94a3b8" radius={[6, 6, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </GlassCard>
              <GlassCard className="p-4">
                <SectionTitle>Department Table</SectionTitle>
                <div className="overflow-x-auto max-h-60 overflow-y-auto hrms-scroll rounded-xl border border-slate-100">
                  <table className="w-full text-xs min-w-[420px]">
                    <thead className="sticky top-0 bg-white/95 backdrop-blur z-10">
                      <tr className="text-left text-[10px] uppercase tracking-wide text-slate-400 border-b border-slate-100">
                        <th className="px-3 py-2">Department</th>
                        <th className="px-3 py-2 text-right">Employees</th>
                        <th className="px-3 py-2 text-right">Short Hours</th>
                        <th className="px-3 py-2 text-right">Absent Days</th>
                        <th className="px-3 py-2 text-right">Punctuality</th>
                      </tr>
                    </thead>
                    <tbody>
                      {org.deptComparison.map((d) => (
                        <tr key={d.department} className="border-b border-slate-50 hover:bg-teal-50/40 transition-colors">
                          <td className="px-3 py-2 font-medium text-slate-700">{d.department}</td>
                          <td className="px-3 py-2 text-right tnum text-slate-600">{d.employees}</td>
                          <td className="px-3 py-2 text-right tnum text-orange-600">{d.shortHours}h</td>
                          <td className="px-3 py-2 text-right tnum text-rose-600">{d.absentDays}</td>
                          <td className="px-3 py-2 text-right tnum text-teal-700">{d.punctuality}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </GlassCard>
            </div>
          )}

          {org.sections.includes('leaves') && org.leaveUtilization.length > 0 && (
            <GlassCard className="p-4">
              <SectionTitle>Leave Utilization by Type</SectionTitle>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
                <div className="h-56">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={org.leaveUtilization}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                      <XAxis dataKey="type" tick={{ fontSize: 10, fill: '#94a3b8' }} tickLine={false} axisLine={false} />
                      <YAxis tick={{ fontSize: 10, fill: '#94a3b8' }} tickLine={false} axisLine={false} width={32} />
                      <RTooltip contentStyle={CHART_TIP} />
                      <Legend wrapperStyle={{ fontSize: 11 }} />
                      <Bar dataKey="availed" name="Days Availed" radius={[6, 6, 0, 0]}>
                        {org.leaveUtilization.map((l, i) => <Cell key={`lu-${i}`} fill={l.color} />)}
                      </Bar>
                      <Bar dataKey="pending" name="Pending Days" fill="#fbbf24" radius={[6, 6, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <div className="overflow-x-auto rounded-xl border border-slate-100">
                  <table className="w-full text-xs min-w-[360px]">
                    <thead>
                      <tr className="text-left text-[10px] uppercase tracking-wide text-slate-400 border-b border-slate-100 bg-white/90">
                        <th className="px-3 py-2">Type</th>
                        <th className="px-3 py-2 text-right">Requests</th>
                        <th className="px-3 py-2 text-right">Availed</th>
                        <th className="px-3 py-2 text-right">Pending</th>
                        <th className="px-3 py-2 text-right">Rejected</th>
                      </tr>
                    </thead>
                    <tbody>
                      {org.leaveUtilization.map((l) => (
                        <tr key={l.type} className="border-b border-slate-50">
                          <td className="px-3 py-2 font-medium text-slate-700"><span className="inline-block h-2 w-2 rounded-full mr-1.5" style={{ backgroundColor: l.color }} />{l.type}</td>
                          <td className="px-3 py-2 text-right tnum text-slate-600">{l.requests}</td>
                          <td className="px-3 py-2 text-right tnum text-emerald-600">{l.availed}</td>
                          <td className="px-3 py-2 text-right tnum text-amber-600">{l.pending}</td>
                          <td className="px-3 py-2 text-right tnum text-rose-600">{l.rejected}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </GlassCard>
          )}

          <GlassCard className="p-4">
            <SectionTitle>Monthly Payroll Cost & Deduction Trend</SectionTitle>
            {org.payrollTrend.length === 0 ? (
              <EmptyState icon={<BarChart3 className="h-8 w-8" />} title="No finalized payroll runs in range" hint="Finalize a payroll run to populate the cost trend." />
            ) : (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
                <div className="h-56">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={org.payrollTrend.map((p) => ({ ...p, name: shortMonth(p.month) }))}>
                      <defs>
                        <linearGradient id="gGross" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="#0d9488" stopOpacity={0.3} />
                          <stop offset="100%" stopColor="#0d9488" stopOpacity={0.02} />
                        </linearGradient>
                        <linearGradient id="gDed" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="#f59e0b" stopOpacity={0.3} />
                          <stop offset="100%" stopColor="#f59e0b" stopOpacity={0.02} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                      <XAxis dataKey="name" tick={{ fontSize: 10, fill: '#94a3b8' }} tickLine={false} axisLine={false} />
                      <YAxis tick={{ fontSize: 10, fill: '#94a3b8' }} tickLine={false} axisLine={false} width={56} tickFormatter={(v: number) => `${Math.round(v / 1000)}k`} />
                      <RTooltip contentStyle={CHART_TIP} formatter={(v: number | string) => money2(Number(v))} />
                      <Legend wrapperStyle={{ fontSize: 11 }} />
                      <Area type="monotone" dataKey="gross" name="Gross" stroke="#0d9488" strokeWidth={2.5} fill="url(#gGross)" />
                      <Area type="monotone" dataKey="deductions" name="Deductions" stroke="#f59e0b" strokeWidth={2} fill="url(#gDed)" />
                      <Area type="monotone" dataKey="net" name="Net" stroke="#059669" strokeWidth={2} fill="none" />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
                <div className="overflow-x-auto max-h-60 overflow-y-auto hrms-scroll rounded-xl border border-slate-100">
                  <table className="w-full text-xs min-w-[380px]">
                    <thead className="sticky top-0 bg-white/95 backdrop-blur z-10">
                      <tr className="text-left text-[10px] uppercase tracking-wide text-slate-400 border-b border-slate-100">
                        <th className="px-3 py-2">Month</th>
                        <th className="px-3 py-2 text-right">Gross</th>
                        <th className="px-3 py-2 text-right">Deductions</th>
                        <th className="px-3 py-2 text-right">Net</th>
                      </tr>
                    </thead>
                    <tbody>
                      {org.payrollTrend.map((p) => (
                        <tr key={p.month} className="border-b border-slate-50 hover:bg-teal-50/40 transition-colors">
                          <td className="px-3 py-2 font-medium text-slate-700 tnum">{shortMonth(p.month)}</td>
                          <td className="px-3 py-2 text-right tnum text-slate-600">{money2(p.gross)}</td>
                          <td className="px-3 py-2 text-right tnum text-orange-600">{money2(p.deductions)}</td>
                          <td className="px-3 py-2 text-right tnum font-bold text-teal-700">{money2(p.net)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </GlassCard>
        </div>
      ) : null}
    </div>
  )
}

// ─── Individual 360° ──────────────────────────────────────────────────────────

function Individual360({ user, people }: { user: SessionUser; people: PersonLite[] }) {
  // Employees always see themselves, even if /api/meta did not return their record
  const selectable: PersonLite[] = user.role === 'EMPLOYEE'
    ? (() => {
      const self = people.find((p) => p.id === user.id)
      return self ? [self] : [{
        id: user.id, fullName: user.fullName, employeeCode: user.employeeCode, designation: user.designation,
        role: user.role, avatarColor: user.avatarColor, departmentId: null, teamLeadId: null, managerId: null,
      }]
    })()
    : people
  const [userId, setUserId] = useState(user.id)
  const [from, setFrom] = useState(monthStartKey())
  const [to, setTo] = useState(todayKey())
  const [data, setData] = useState<IndividualReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [forbidden, setForbidden] = useState(false)

  const load = useCallback(async () => {
    if (from > to) { toast.error('Invalid date range — "From" must be before "To"'); return }
    setLoading(true)
    setForbidden(false)
    try {
      const res = await api<IndividualReport>(`/api/reports/individual?userId=${userId}&from=${from}&to=${to}`)
      setData(res)
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) setForbidden(true)
      else toast.error(errText(err, 'Failed to load 360° report'))
      setData(null)
    } finally {
      setLoading(false)
    }
  }, [userId, from, to])

  useEffect(() => { void load() }, [load])

  async function exportIndividualPdf() {
    try {
      await downloadFile(`/api/reports/pdf?type=individual&userId=${userId}&from=${from}&to=${to}`, 'individual-360.pdf')
      toast.success('Individual 360° PDF downloaded')
    } catch (err) {
      toast.error(errText(err, 'Export failed'))
    }
  }

  async function exportProfileCard() {
    try {
      await downloadFile(`/api/employees/${userId}/profile-pdf`, 'profile-card.pdf')
      toast.success('Profile card PDF downloaded')
    } catch (err) {
      toast.error(errText(err, 'Export failed'))
    }
  }

  return (
    <GlassCard className="p-4 md:p-5 space-y-4">
      <SectionTitle action={
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => void exportIndividualPdf()} className="h-8 text-xs border-slate-200 text-slate-700 hover:bg-slate-50">
            <FileText className="h-3.5 w-3.5 mr-1" /> Individual 360° PDF
          </Button>
          <Button size="sm" variant="outline" onClick={() => void exportProfileCard()} className="h-8 text-xs border-slate-200 text-slate-700 hover:bg-slate-50">
            <Download className="h-3.5 w-3.5 mr-1" /> Profile Card PDF
          </Button>
        </div>
      }>
        <span className="inline-flex items-center gap-1.5"><UserSearch className="h-3.5 w-3.5 text-teal-600" /> Individual 360° Report</span>
      </SectionTitle>

      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1 flex-1 min-w-[200px] max-w-[320px]">
          <Label className="text-[11px] text-slate-500">Employee</Label>
          <Select value={userId} onValueChange={setUserId}>
            <SelectTrigger className="w-full h-9 bg-white/70 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent className="max-h-72 hrms-scroll">
              {selectable.map((p) => (
                <SelectItem key={p.id} value={p.id} className="text-xs">{p.fullName} · {p.employeeCode}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-[11px] text-slate-500">From</Label>
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-9 bg-white/80 text-xs tnum w-[150px]" />
        </div>
        <div className="space-y-1">
          <Label className="text-[11px] text-slate-500">To</Label>
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-9 bg-white/80 text-xs tnum w-[150px]" />
        </div>
      </div>

      {forbidden ? (
        <Alert variant="destructive" className="glass">
          <ShieldAlert className="h-4 w-4" />
          <AlertTitle className="text-sm">Access denied</AlertTitle>
          <AlertDescription className="text-xs">You are not allowed to view this employee&apos;s report.</AlertDescription>
        </Alert>
      ) : loading ? (
        <div className="space-y-3">
          <div className="glass h-28 animate-pulse rounded-xl" />
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">{Array.from({ length: 4 }).map((_, i) => <div key={i} className="glass h-16 animate-pulse rounded-xl" />)}</div>
        </div>
      ) : !data ? null : (
        <div className="space-y-5">
          {/* Employee header */}
          <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4">
            <Avatar name={data.employee.fullName} color={data.employee.avatarColor} size="lg" />
            <div className="min-w-0">
              <p className="text-sm font-bold text-slate-800">{data.employee.fullName} <span className="text-slate-400 font-medium tnum">· {data.employee.employeeCode}</span></p>
              <p className="text-xs text-slate-500">{data.employee.designation} · {data.employee.departmentName}</p>
              <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-slate-500 tnum">
                <span>TL: {data.employee.teamLeadName}</span>
                <span className="text-slate-300">|</span>
                <span>Mgr: {data.employee.managerName}</span>
                <span className="text-slate-300">|</span>
                <span>Shift: {data.employee.shiftName}</span>
                <span className="text-slate-300">|</span>
                <span>Joined: {data.employee.joiningDate ? isoDay(data.employee.joiningDate) : '—'}</span>
              </div>
            </div>
          </div>

          {/* Attendance section */}
          {data.sections.includes('attendance') && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <GlassCard className="p-4">
                <SectionTitle>Attendance</SectionTitle>
                <div className="flex flex-col sm:flex-row items-center gap-4">
                  <ScoreRing pct={data.attendance.score ?? 0} label="Score" size={96} />
                  <div className="grid grid-cols-2 gap-3 flex-1 w-full">
                    <div><p className="text-[11px] uppercase text-slate-400">Expected</p><p className="text-sm font-bold text-slate-700 tnum">{fmtMinutes(data.attendance.totals.expected)}</p></div>
                    <div><p className="text-[11px] uppercase text-slate-400">Worked</p><p className="text-sm font-bold text-emerald-600 tnum">{fmtMinutes(data.attendance.totals.worked)}</p></div>
                    <div><p className="text-[11px] uppercase text-slate-400">Short</p><p className="text-sm font-bold text-orange-600 tnum">{fmtMinutes(data.attendance.totals.short)}</p></div>
                    <div><p className="text-[11px] uppercase text-slate-400">Late Days</p><p className="text-sm font-bold text-rose-600 tnum">{data.attendance.totals.lateDays}</p></div>
                  </div>
                </div>
                <div className="mt-4">
                  <p className="text-xs font-semibold text-slate-600 mb-2">Late Check-ins (worst 12)</p>
                  {data.attendance.lateFrequency.length === 0 ? (
                    <EmptyState title="No late arrivals in range" />
                  ) : (
                    <div className="space-y-1.5 max-h-44 overflow-y-auto hrms-scroll">
                      {data.attendance.lateFrequency.map((l) => (
                        <div key={l.dateKey} className="flex items-center gap-2 text-[11px] tnum">
                          <span className="text-slate-500 w-20">{dayLabel(l.dateKey)}</span>
                          <div className="flex-1 h-2 bg-slate-100 rounded-full overflow-hidden">
                            <div className="h-full bg-rose-400 rounded-full" style={{ width: `${Math.min(100, (l.lateMinutes / 120) * 100)}%` }} />
                          </div>
                          <span className="text-slate-600 w-24 text-right">{l.lateMinutes}m · in {timeLabel(l.checkIn)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </GlassCard>

              <GlassCard className="p-4">
                <SectionTitle>Leave Ledger</SectionTitle>
                {data.leaves.ledger.length === 0 ? (
                  <EmptyState title="No leave balances for the current year" />
                ) : (
                  <div className="space-y-2.5 max-h-72 overflow-y-auto hrms-scroll">
                    {data.leaves.ledger.map((b) => (
                      <div key={b.leaveTypeId}>
                        <div className="flex justify-between text-[11px] mb-1 tnum">
                          <span className="font-medium text-slate-600">{b.name}</span>
                          <span className="text-slate-400">{b.availed}/{b.carryForward + b.quota} · avail {Math.max(0, b.available)}</span>
                        </div>
                        <SegmentedBar height="h-2" segments={[
                          { value: b.availed, color: b.color, label: 'Availed' },
                          { value: b.pending, color: '#f59e0b', label: 'Pending' },
                          { value: Math.max(0, b.available), color: '#e2e8f0', label: 'Available' },
                        ]} />
                      </div>
                    ))}
                  </div>
                )}
                {data.leaves.history.length > 0 && (
                  <div className="mt-4">
                    <p className="text-xs font-semibold text-slate-600 mb-2">Leave History (range)</p>
                    <div className="overflow-x-auto max-h-52 overflow-y-auto hrms-scroll rounded-xl border border-slate-100">
                      <table className="w-full text-[11px] min-w-[420px]">
                        <thead className="sticky top-0 bg-white/95 backdrop-blur z-10">
                          <tr className="text-left text-[10px] uppercase tracking-wide text-slate-400 border-b border-slate-100">
                            <th className="px-3 py-2">Type</th>
                            <th className="px-3 py-2">Dates</th>
                            <th className="px-3 py-2 text-right">Days</th>
                            <th className="px-3 py-2">Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {data.leaves.history.map((h) => (
                            <tr key={h.id} className="border-b border-slate-50">
                              <td className="px-3 py-2 font-medium text-slate-700">
                                <span className="inline-block h-2 w-2 rounded-full mr-1.5" style={{ backgroundColor: h.color }} />{h.type}
                                {h.isShortLeave && <span className="ml-1 text-[10px] text-slate-400 tnum">({h.shortHours}h)</span>}
                              </td>
                              <td className="px-3 py-2 tnum text-slate-500">{isoDay(h.startDate)} → {isoDay(h.endDate)}</td>
                              <td className="px-3 py-2 text-right tnum text-slate-600">{h.dayCount}</td>
                              <td className="px-3 py-2"><Pill text={h.status} tone={STATUS_BADGE_TONE[h.status] ?? 'slate'} /></td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </GlassCard>
            </div>
          )}

          {/* Payroll section */}
          <GlassCard className="p-4">
            <SectionTitle>Payroll / Deduction History</SectionTitle>
            {data.payroll.length === 0 ? (
              <EmptyState title="No finalized payslips in range" hint="Payslips appear here after the monthly payroll run is finalized." />
            ) : (
              <div className="overflow-x-auto max-h-[420px] overflow-y-auto hrms-scroll rounded-xl border border-slate-100">
                <table className="w-full text-xs min-w-[720px]">
                  <thead className="sticky top-0 bg-white/95 backdrop-blur z-10">
                    <tr className="text-left text-[10px] uppercase tracking-wide text-slate-400 border-b border-slate-100">
                      <th className="px-3 py-2.5">Month</th>
                      <th className="px-3 py-2.5 text-right">Gross</th>
                      <th className="px-3 py-2.5 text-right">Short</th>
                      <th className="px-3 py-2.5 text-right">Short Conv.</th>
                      <th className="px-3 py-2.5 text-right">Unpaid Days</th>
                      <th className="px-3 py-2.5 text-right">Short Ded.</th>
                      <th className="px-3 py-2.5 text-right">Leave Ded.</th>
                      <th className="px-3 py-2.5 text-right">OT</th>
                      <th className="px-3 py-2.5 text-right">Net</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.payroll.map((p) => (
                      <tr key={p.id} className="border-b border-slate-50 hover:bg-teal-50/40 transition-colors">
                        <td className="px-3 py-2 font-medium text-slate-700 tnum">{p.month}</td>
                        <td className="px-3 py-2 text-right tnum text-slate-600">{money2(p.grossPay)}</td>
                        <td className="px-3 py-2 text-right tnum text-orange-600">{fmtMinutes(p.shortMinutes)}</td>
                        <td className="px-3 py-2 text-right tnum text-teal-600">{p.shortConvertedFromBalance}d</td>
                        <td className="px-3 py-2 text-right tnum text-rose-600">{p.unpaidLeaveDays}</td>
                        <td className="px-3 py-2 text-right tnum text-orange-600">{p.shortHourDeduction > 0 ? money2(p.shortHourDeduction) : '—'}</td>
                        <td className="px-3 py-2 text-right tnum text-rose-600">{p.leaveDeduction > 0 ? money2(p.leaveDeduction) : '—'}</td>
                        <td className="px-3 py-2 text-right tnum text-emerald-600">{p.overtimeAmount > 0 ? money2(p.overtimeAmount) : '—'}</td>
                        <td className="px-3 py-2 text-right tnum font-bold text-teal-700">{money2(p.netPay)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </GlassCard>
        </div>
      )}
    </GlassCard>
  )
}

// ─── Exported view ────────────────────────────────────────────────────────────

const ORG_ROLES = ['SUPER_ADMIN', 'HR_MANAGER', 'ACCOUNTANT', 'ACCOUNTS_MANAGER', 'MANAGER']

export function ReportsView({ user, people }: { user: SessionUser; people: PersonLite[] }) {
  const canSeeOrg = ORG_ROLES.includes(user.role)

  if (!canSeeOrg) {
    return (
      <div className="space-y-4 hrms-enter">
        <div>
          <h1 className="text-lg md:text-xl font-bold text-slate-800">Reports</h1>
          <p className="text-xs text-slate-500 mt-0.5">Your personal 360° analytics with one-click PDF exports.</p>
        </div>
        <Individual360 user={user} people={people} />
      </div>
    )
  }

  return (
    <div className="space-y-4 hrms-enter">
      <div>
        <h1 className="text-lg md:text-xl font-bold text-slate-800">Reports & Analytics</h1>
        <p className="text-xs text-slate-500 mt-0.5">Organization analytics and individual dossiers with one-click branded PDF exports.</p>
      </div>
      <Tabs defaultValue="org">
        <TabsList className="glass-subtle h-9 p-1">
          <TabsTrigger value="org" className="text-xs h-7 data-[state=active]:bg-teal-600 data-[state=active]:text-white">
            <BarChart3 className="h-3.5 w-3.5 mr-1" /> Organization Analytics
          </TabsTrigger>
          <TabsTrigger value="individual" className="text-xs h-7 data-[state=active]:bg-teal-600 data-[state=active]:text-white">
            <ScanSearch className="h-3.5 w-3.5 mr-1" /> Individual 360°
          </TabsTrigger>
        </TabsList>
        <TabsContent value="org" className="mt-4">
          <OrgAnalytics user={user} />
        </TabsContent>
        <TabsContent value="individual" className="mt-4">
          <Individual360 user={user} people={people} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
