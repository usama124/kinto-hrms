'use client'

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle, CalendarClock, CalendarPlus, Check, ChevronDown, ChevronRight, Inbox, Loader2, Paperclip, Plane, Wallet, X,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  api, ApiError, refreshSession, dayLabel, dateTimeLabel,
  type SessionUser, type PersonLite, type RequestRow, type AttRequestRow, type Balance, type Meta,
  REQUEST_TYPE_LABELS, STATUS_BADGE_TONE, STAGE_LABELS,
} from '@/lib/hrms/client'
import { Avatar, GlassCard, Pill, SegmentedBar, SectionTitle, EmptyState } from './shared'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

// ─── Local helpers ────────────────────────────────────────────────────────────

const PENDING_STATUSES = ['PENDING_TEAM_LEAD', 'PENDING_MANAGER', 'PENDING_HR']
const CREATE_ROLES = ['TEAM_LEAD', 'MANAGER', 'EMPLOYEE', 'HR_MANAGER', 'SUPER_ADMIN']
const TYPE_TONE: Record<string, string> = { LEAVE: 'teal', OFFICIAL_DUTY: 'purple', TRAVEL: 'cyan' }

function openProfile(userId: string) {
  window.dispatchEvent(new CustomEvent('hrms:open-profile', { detail: { userId } }))
}

/** Multipart upload — raw fetch because api() forces a JSON content-type. */
async function uploadAttachment(file: File): Promise<string> {
  const fd = new FormData()
  fd.append('file', file)
  let res = await fetch('/api/uploads', { method: 'POST', body: fd })
  if (res.status === 401) {
    const ok = await refreshSession()
    if (ok) res = await fetch('/api/uploads', { method: 'POST', body: fd })
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError((data as { error?: string }).error ?? 'Upload failed', res.status)
  return (data as { upload: { id: string } }).upload.id
}

type ActTarget = { kind: 'leave' | 'att'; id: string; action: 'approve' | 'reject'; who: string; stage: string }

// ─── Requests View ────────────────────────────────────────────────────────────

export function RequestsView({ user, people, onApproved }: {
  user: SessionUser
  people: PersonLite[]
  onApproved: () => void
}) {
  const [tab, setTab] = useState<'LEAVE_TRAVEL' | 'REGULARIZATION' | 'BALANCES'>('LEAVE_TRAVEL')
  const [leaveRows, setLeaveRows] = useState<RequestRow[]>([])
  const [attRows, setAttRows] = useState<AttRequestRow[]>([])
  const [balances, setBalances] = useState<Balance[]>([])
  const [leaveLoading, setLeaveLoading] = useState(true)
  const [attLoading, setAttLoading] = useState(true)
  const [balLoading, setBalLoading] = useState(true)
  const [createOpen, setCreateOpen] = useState(false)
  const [act, setAct] = useState<ActTarget | null>(null)
  const [comment, setComment] = useState('')
  const [busy, setBusy] = useState(false)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  const isFastTrack = user.role === 'SUPER_ADMIN' || user.role === 'HR_MANAGER'
  const canCreate = CREATE_ROLES.includes(user.role)

  const loadLeave = useCallback(async () => {
    setLeaveLoading(true)
    try {
      const res = await api<{ requests: RequestRow[] }>('/api/requests')
      setLeaveRows(res.requests)
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to load requests')
    } finally {
      setLeaveLoading(false)
    }
  }, [])

  const loadAtt = useCallback(async () => {
    setAttLoading(true)
    try {
      const res = await api<{ requests: AttRequestRow[] }>('/api/attendance/requests')
      setAttRows(res.requests)
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to load attendance requests')
    } finally {
      setAttLoading(false)
    }
  }, [])

  const loadBalances = useCallback(async () => {
    setBalLoading(true)
    try {
      const res = await api<{ balances: Balance[] }>('/api/leave-balances')
      setBalances(res.balances)
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to load leave balances')
    } finally {
      setBalLoading(false)
    }
  }, [user.role])

  useEffect(() => { void loadLeave(); void loadAtt(); void loadBalances() }, [loadLeave, loadAtt, loadBalances])

  const toggle = (key: string) => setExpanded((e) => ({ ...e, [key]: !e[key] }))

  // Mirrors the server rule (rbac.ts): an HR Manager's / System Admin's request is decided by the System Admin only,
  // and nobody else acts on their own request.
  const rowLocked = (r: { userId: string; user: { role?: string } }) =>
    r.user.role === 'HR_MANAGER' || r.user.role === 'SUPER_ADMIN' ? user.role !== 'SUPER_ADMIN' : r.userId === user.id

  const canActLeave = (r: RequestRow) => {
    if (!PENDING_STATUSES.includes(r.status) || rowLocked(r)) return false
    if (user.role === 'TEAM_LEAD') return r.currentStage === 'TEAM_LEAD'
    if (user.role === 'MANAGER') return r.currentStage === 'MANAGER'
    return isFastTrack // SUPER_ADMIN / HR_MANAGER fast-track any pending stage
  }

  const canActAtt = (r: AttRequestRow) => {
    if (!PENDING_STATUSES.includes(r.status) || rowLocked(r)) return false
    if (user.role === 'TEAM_LEAD') return r.currentStage === 'TEAM_LEAD'
    if (user.role === 'MANAGER') return r.currentStage === 'MANAGER'
    return isFastTrack
  }

  async function confirmAct() {
    if (!act) return
    setBusy(true)
    try {
      if (act.kind === 'leave') {
        await api(`/api/requests/${act.id}/${act.action}`, { method: 'POST', body: JSON.stringify({ comment: comment.trim() || undefined }) })
        if (act.action === 'approve') {
          toast.success(isFastTrack ? 'Request approved — fast-tracked and finalized in one step' : 'Request approved')
        } else {
          toast.success('Request rejected — pending balance restored')
        }
        await loadLeave()
        await loadBalances() // pending balance changes either way
      } else {
        await api(`/api/attendance/requests/${act.id}/${act.action}`, { method: 'POST', body: JSON.stringify({ comment: comment.trim() || undefined }) })
        if (act.action === 'approve') {
          toast.success(act.stage === 'HR' || isFastTrack ? 'Attendance request approved — finalized' : 'Attendance request approved')
        } else {
          toast.success('Attendance correction request rejected')
        }
        await loadAtt()
      }
      setAct(null)
      setComment('')
      onApproved()
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Action failed')
    } finally {
      setBusy(false)
    }
  }

  const pendingLeave = leaveRows.filter((r) => PENDING_STATUSES.includes(r.status))
  const settledLeave = leaveRows.filter((r) => !PENDING_STATUSES.includes(r.status))
  const pendingAtt = attRows.filter((r) => PENDING_STATUSES.includes(r.status))
  const settledAtt = attRows.filter((r) => !PENDING_STATUSES.includes(r.status))

  const subtitle = user.role === 'TEAM_LEAD' || user.role === 'MANAGER'
    ? `Three-tier workflow: Team Lead → Manager → HR · ${people.length} people in your scope`
    : 'Three-tier workflow: Team Lead → Manager → HR'

  // ── row renderers (two <tr> per record: main row + optional trail row) ──────

  const trailCell = (r: RequestRow | AttRequestRow, kind: 'leave' | 'att') => (
    <button
      onClick={(e) => { e.stopPropagation(); toggle(`${kind}:${r.id}`) }}
      className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-slate-500 hover:bg-slate-100 transition-colors"
    >
      {expanded[`${kind}:${r.id}`] ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
      Trail{r.approvals.length > 0 ? <span className="tnum"> ({r.approvals.length})</span> : null}
    </button>
  )

  const trailRow = (r: RequestRow | AttRequestRow, kind: 'leave' | 'att', colSpan: number) => {
    if (!expanded[`${kind}:${r.id}`]) return null
    return (
      <tr className="bg-slate-50/70">
        <td colSpan={colSpan} className="px-4 py-3 border-b border-slate-100">
          {r.approvals.length === 0 ? (
            <p className="text-[11px] text-slate-400">
              No approvals recorded yet — awaiting {STAGE_LABELS[r.currentStage] ?? 'first-level'} review.
            </p>
          ) : (
            <div className="space-y-2">
              {r.approvals.map((a) => (
                <div key={a.id} className="glass-subtle rounded-lg p-2.5 flex items-start gap-2.5">
                  <Pill text={a.action} tone={a.action === 'APPROVED' ? 'emerald' : 'rose'} />
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-semibold text-slate-700">
                      {a.approver.fullName}
                      <span className="font-normal text-slate-400"> · {STAGE_LABELS[a.level] ?? a.level} level</span>
                    </p>
                    {a.comment ? <p className="mt-0.5 text-[11px] italic text-slate-500">&ldquo;{a.comment}&rdquo;</p> : null}
                  </div>
                  <span className="whitespace-nowrap text-[10px] text-slate-400 tnum">{dateTimeLabel(a.createdAt)}</span>
                </div>
              ))}
            </div>
          )}
        </td>
      </tr>
    )
  }

  const leaveRow = (r: RequestRow) => (
    <Fragment key={r.id}>
      <tr onClick={() => toggle(`leave:${r.id}`)} className="border-b border-slate-50 hover:bg-teal-50/40 cursor-pointer transition-colors">
        <td className="px-3 py-2.5">
          <div className="flex items-center gap-2.5">
            <Avatar name={r.user.fullName} color={r.user.avatarColor} size="sm" />
            <div className="min-w-0">
              <button
                onClick={(e) => { e.stopPropagation(); openProfile(r.userId) }}
                className="block max-w-[180px] truncate text-left text-xs font-semibold text-slate-700 hover:text-teal-700 hover:underline"
              >
                {r.user.fullName}
              </button>
              <p className="text-[10px] text-slate-400 tnum">{r.user.employeeCode}</p>
            </div>
          </div>
        </td>
        <td className="px-3 py-2.5">
          <div className="flex flex-col items-start gap-1">
            <Pill text={REQUEST_TYPE_LABELS[r.type] ?? r.type} tone={TYPE_TONE[r.type] ?? 'slate'} />
            {r.leaveType ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-slate-50 px-2 py-0.5 text-[10px] font-medium text-slate-600 ring-1 ring-slate-200">
                <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: r.leaveType.colorCode }} />
                {r.leaveType.name}
              </span>
            ) : null}
          </div>
        </td>
        <td className="px-3 py-2.5 whitespace-nowrap">
          <p className="text-xs text-slate-600 tnum">
            {dayLabel(r.startDate.slice(0, 10))}
            {r.endDate.slice(0, 10) !== r.startDate.slice(0, 10) ? ` → ${dayLabel(r.endDate.slice(0, 10))}` : ''}
          </p>
          <p className="text-[10px] text-slate-400 tnum">
            {r.isShortLeave ? `Short leave · ${r.shortHours}h` : `${r.dayCount} day(s)`}
          </p>
        </td>
        <td className="px-3 py-2.5">
          <div className="flex flex-col items-start gap-1">
            <Pill text={r.status} tone={STATUS_BADGE_TONE[r.status]} />
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-500">
              {r.currentStage === 'DONE' ? 'Completed' : `At ${STAGE_LABELS[r.currentStage] ?? r.currentStage}`}
            </span>
          </div>
        </td>
        <td className="px-3 py-2.5">{trailCell(r, 'leave')}</td>
        <td className="max-w-[180px] px-3 py-2.5">
          <p className="truncate text-xs text-slate-500" title={r.reason}>{r.reason}</p>
          {r.attachment?.id ? (
            <button
              onClick={(e) => { e.stopPropagation(); window.open(`/api/uploads/${r.attachment?.id}`, '_blank', 'noopener,noreferrer') }}
              className="mt-1 inline-flex items-center gap-1 text-[11px] font-medium text-teal-700 hover:text-teal-800 hover:underline"
            >
              <Paperclip className="h-3 w-3" />
              <span className="max-w-[140px] truncate">{r.attachment.name || 'attachment'}</span>
            </button>
          ) : null}
        </td>
        <td className="px-3 py-2.5">
          <div className="flex items-center justify-end gap-1.5" onClick={(e) => e.stopPropagation()}>
            {canActLeave(r) ? (
              <>
                {isFastTrack && <Pill text="Fast-track" tone="violet" />}
                <Button
                  size="sm" disabled={busy}
                  onClick={() => setAct({ kind: 'leave', id: r.id, action: 'approve', who: r.user.fullName, stage: r.currentStage })}
                  className="h-7 px-2.5 text-[11px] bg-emerald-600 hover:bg-emerald-700 text-white"
                >
                  <Check className="mr-0.5 h-3 w-3" /> Approve
                </Button>
                <Button
                  size="sm" variant="outline" disabled={busy}
                  onClick={() => setAct({ kind: 'leave', id: r.id, action: 'reject', who: r.user.fullName, stage: r.currentStage })}
                  className="h-7 px-2.5 text-[11px] border-rose-200 text-rose-600 hover:bg-rose-50"
                >
                  <X className="mr-0.5 h-3 w-3" /> Reject
                </Button>
              </>
            ) : (
              <span className="text-[11px] text-slate-300">—</span>
            )}
          </div>
        </td>
      </tr>
      {trailRow(r, 'leave', 7)}
    </Fragment>
  )

  const attRow = (r: AttRequestRow) => (
    <Fragment key={r.id}>
      <tr onClick={() => toggle(`att:${r.id}`)} className="border-b border-slate-50 hover:bg-teal-50/40 cursor-pointer transition-colors">
        <td className="px-3 py-2.5">
          <div className="flex items-center gap-2.5">
            <Avatar name={r.user.fullName} color={r.user.avatarColor} size="sm" />
            <div className="min-w-0">
              <button
                onClick={(e) => { e.stopPropagation(); openProfile(r.userId) }}
                className="block max-w-[180px] truncate text-left text-xs font-semibold text-slate-700 hover:text-teal-700 hover:underline"
              >
                {r.user.fullName}
              </button>
              <p className="text-[10px] text-slate-400 tnum">{r.user.employeeCode}</p>
            </div>
          </div>
        </td>
        <td className="px-3 py-2.5 whitespace-nowrap text-xs text-slate-600 tnum">{dayLabel(r.date.slice(0, 10))}</td>
        <td className="px-3 py-2.5 whitespace-nowrap text-xs text-slate-700 tnum font-medium">
          {r.requestedCheckIn} – {r.requestedCheckOut}
        </td>
        <td className="max-w-[200px] px-3 py-2.5">
          <p className="truncate text-xs text-slate-500" title={r.reason}>{r.reason}</p>
        </td>
        <td className="px-3 py-2.5">
          <div className="flex flex-col items-start gap-1">
            <Pill text={r.status} tone={STATUS_BADGE_TONE[r.status]} />
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-500">
              {r.currentStage === 'DONE' ? 'Completed' : `At ${STAGE_LABELS[r.currentStage] ?? r.currentStage}`}
            </span>
          </div>
        </td>
        <td className="px-3 py-2.5">{trailCell(r, 'att')}</td>
        <td className="px-3 py-2.5">
          <div className="flex items-center justify-end gap-1.5" onClick={(e) => e.stopPropagation()}>
            {canActAtt(r) ? (
              <>
                {isFastTrack && <Pill text="Fast-track" tone="violet" />}
                <Button
                  size="sm" disabled={busy}
                  onClick={() => setAct({ kind: 'att', id: r.id, action: 'approve', who: r.user.fullName, stage: r.currentStage })}
                  className="h-7 px-2.5 text-[11px] bg-emerald-600 hover:bg-emerald-700 text-white"
                >
                  <Check className="mr-0.5 h-3 w-3" /> Approve
                </Button>
                <Button
                  size="sm" variant="outline" disabled={busy}
                  onClick={() => setAct({ kind: 'att', id: r.id, action: 'reject', who: r.user.fullName, stage: r.currentStage })}
                  className="h-7 px-2.5 text-[11px] border-rose-200 text-rose-600 hover:bg-rose-50"
                >
                  <X className="mr-0.5 h-3 w-3" /> Reject
                </Button>
              </>
            ) : (
              <span className="text-[11px] text-slate-300">—</span>
            )}
          </div>
        </td>
      </tr>
      {trailRow(r, 'att', 7)}
    </Fragment>
  )

  const skeleton = (n: number) => (
    <div className="space-y-2">{Array.from({ length: n }).map((_, i) => <div key={i} className="h-11 animate-pulse rounded-lg bg-slate-100/70" />)}</div>
  )

  const pendingDivider = (show: boolean) =>
    show ? <DividerRow colSpan={7} caption="Pending — newest first" /> : null

  return (
    <div className="space-y-4 hrms-enter">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-bold text-slate-800 md:text-xl">Requests &amp; Approvals</h1>
          <p className="mt-0.5 text-xs text-slate-500">{subtitle}</p>
        </div>
        {canCreate && (
          <Button onClick={() => setCreateOpen(true)} className="h-9 bg-teal-600 text-white text-xs hover:bg-teal-700">
            <CalendarPlus className="mr-1.5 h-4 w-4" /> Create Request
          </Button>
        )}
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
        <TabsList className="glass-subtle h-9 p-1">
          <TabsTrigger value="LEAVE_TRAVEL" className="h-7 text-xs data-[state=active]:bg-teal-600 data-[state=active]:text-white">
            <Plane className="mr-1 h-3.5 w-3.5" /> Leave &amp; Travel Requests
          </TabsTrigger>
          <TabsTrigger value="REGULARIZATION" className="h-7 text-xs data-[state=active]:bg-teal-600 data-[state=active]:text-white">
            <CalendarClock className="mr-1 h-3.5 w-3.5" /> Attendance Regularization
          </TabsTrigger>
          <TabsTrigger value="BALANCES" className="h-7 text-xs data-[state=active]:bg-teal-600 data-[state=active]:text-white">
            <Wallet className="mr-1 h-3.5 w-3.5" /> My Balances
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {/* ── Leave & Travel tab ─────────────────────────────────────────────── */}
      {tab === 'LEAVE_TRAVEL' && (
        <GlassCard className="p-4 md:p-5">
          <SectionTitle action={pendingLeave.length > 0 ? <Pill text={`PENDING ${pendingLeave.length}`} tone="amber" /> : undefined}>
            Leave &amp; Travel Requests
          </SectionTitle>
          {leaveLoading ? skeleton(5) : leaveRows.length === 0 ? (
            <EmptyState icon={<Inbox className="h-8 w-8" />} title="No leave or travel requests" hint={canCreate ? 'Create one with the button above.' : undefined} />
          ) : (
            <div className="hrms-scroll max-h-[520px] overflow-x-auto overflow-y-auto rounded-xl border border-slate-100">
              <table className="w-full min-w-[880px] text-xs">
                <thead className="sticky top-0 z-10 bg-white/95 backdrop-blur">
                  <tr className="border-b border-slate-100 text-left text-[10px] uppercase tracking-wide text-slate-400">
                    <th className="px-3 py-2.5">Employee</th>
                    <th className="px-3 py-2.5">Type</th>
                    <th className="px-3 py-2.5">Period</th>
                    <th className="px-3 py-2.5">Status</th>
                    <th className="px-3 py-2.5">Trail</th>
                    <th className="px-3 py-2.5">Reason</th>
                    <th className="px-3 py-2.5 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {pendingLeave.map((r) => leaveRow(r))}
                  {pendingDivider(pendingLeave.length > 0 && settledLeave.length > 0)}
                  {settledLeave.map((r) => leaveRow(r))}
                </tbody>
              </table>
            </div>
          )}
        </GlassCard>
      )}

      {/* ── Attendance Regularization tab ──────────────────────────────────── */}
      {tab === 'REGULARIZATION' && (
        <GlassCard className="p-4 md:p-5">
          <SectionTitle action={pendingAtt.length > 0 ? <Pill text={`PENDING ${pendingAtt.length}`} tone="amber" /> : undefined}>
            Attendance Regularization
          </SectionTitle>
          <p className="mb-3 text-[11px] text-slate-400">
            Three-tier chain: Team Lead → Manager → HR. HR approval finalizes; org admins fast-track in one step.
          </p>
          {attLoading ? skeleton(4) : attRows.length === 0 ? (
            <EmptyState icon={<Inbox className="h-8 w-8" />} title="No attendance regularization requests" hint="Employees raise these from the Attendance view." />
          ) : (
            <div className="hrms-scroll max-h-[520px] overflow-x-auto overflow-y-auto rounded-xl border border-slate-100">
              <table className="w-full min-w-[820px] text-xs">
                <thead className="sticky top-0 z-10 bg-white/95 backdrop-blur">
                  <tr className="border-b border-slate-100 text-left text-[10px] uppercase tracking-wide text-slate-400">
                    <th className="px-3 py-2.5">Employee</th>
                    <th className="px-3 py-2.5">Date</th>
                    <th className="px-3 py-2.5">Requested Times</th>
                    <th className="px-3 py-2.5">Reason</th>
                    <th className="px-3 py-2.5">Status</th>
                    <th className="px-3 py-2.5">Trail</th>
                    <th className="px-3 py-2.5 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {pendingAtt.map((r) => attRow(r))}
                  {pendingDivider(pendingAtt.length > 0 && settledAtt.length > 0)}
                  {settledAtt.map((r) => attRow(r))}
                </tbody>
              </table>
            </div>
          )}
        </GlassCard>
      )}

      {/* ── My Balances tab ────────────────────────────────────────────────── */}
      {tab === 'BALANCES' && (
        <GlassCard className="p-4 md:p-5">
          <SectionTitle>My Leave Balances</SectionTitle>
          {user.role === 'SUPER_ADMIN' ? (
            <EmptyState
              icon={<Wallet className="h-8 w-8" />}
              title="Oversight-only account — no personal leave balances"
              hint="SUPER_ADMIN does not accrue leave. Review org-wide leave usage in Reports, or adjust individual balances via HR tooling."
            />
          ) : balLoading ? skeleton(3) : balances.length === 0 ? (
            <EmptyState icon={<Wallet className="h-8 w-8" />} title="No leave balances yet" hint="Balances appear once HR provisions your leave types." />
          ) : (
            <div className="hrms-scroll max-h-[480px] overflow-x-auto overflow-y-auto rounded-xl border border-slate-100">
              <table className="w-full min-w-[680px] text-xs">
                <thead className="sticky top-0 z-10 bg-white/95 backdrop-blur">
                  <tr className="border-b border-slate-100 text-left text-[10px] uppercase tracking-wide text-slate-400">
                    <th className="px-3 py-2.5">Leave Type</th>
                    <th className="px-3 py-2.5 text-right">Carry</th>
                    <th className="px-3 py-2.5 text-right">Quota</th>
                    <th className="px-3 py-2.5 text-right">Availed</th>
                    <th className="px-3 py-2.5 text-right">Pending</th>
                    <th className="px-3 py-2.5 text-right">Available</th>
                    <th className="min-w-[140px] px-3 py-2.5">Usage</th>
                  </tr>
                </thead>
                <tbody>
                  {balances.map((b) => (
                    <tr key={b.leaveTypeId} className="border-b border-slate-50">
                      <td className="whitespace-nowrap px-3 py-2.5 font-semibold text-slate-700">
                        <span className="mr-1.5 inline-block h-2 w-2 rounded-full" style={{ backgroundColor: b.color }} />
                        {b.name}
                        <span className="ml-1.5 text-[10px] font-normal text-slate-400">{b.code}</span>
                      </td>
                      <td className="px-3 py-2.5 text-right tnum text-slate-500">{b.carryForward}</td>
                      <td className="px-3 py-2.5 text-right tnum text-slate-500">{b.quota}</td>
                      <td className="px-3 py-2.5 text-right tnum text-slate-700">{b.availed}</td>
                      <td className="px-3 py-2.5 text-right tnum text-amber-600">{b.pending}</td>
                      <td className="px-3 py-2.5 text-right font-bold tnum text-teal-700">{b.available}</td>
                      <td className="px-3 py-2.5">
                        <SegmentedBar
                          height="h-2"
                          segments={[
                            { value: b.availed, color: b.color, label: 'Availed' },
                            { value: b.pending, color: '#f59e0b', label: 'Pending' },
                            { value: Math.max(0, b.available), color: '#e2e8f0', label: 'Available' },
                          ]}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </GlassCard>
      )}

      {/* ── Approve / Reject dialog ────────────────────────────────────────── */}
      <Dialog open={!!act} onOpenChange={(o) => { if (!o) { setAct(null); setComment('') } }}>
        <DialogContent className="glass-strong sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-sm font-semibold text-slate-800">
              {act?.action === 'approve' ? 'Approve request' : 'Reject request'}
            </DialogTitle>
            <DialogDescription className="text-xs text-slate-500">
              {act ? `${act.who} · currently at ${STAGE_LABELS[act.stage] ?? act.stage} stage${isFastTrack ? ' · fast-tracks to a final decision' : ''}` : ''}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3.5">
            <div className="space-y-1.5">
              <Label className="text-xs text-slate-600">Comment {act?.action === 'reject' ? '(recommended)' : '(optional)'}</Label>
              <Textarea
                rows={3}
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder={act?.action === 'approve' ? 'e.g., Approved — please plan your handover' : 'e.g., Team is short-staffed on these dates'}
                className="bg-white/80 text-xs"
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => { setAct(null); setComment('') }} className="h-9 text-xs">Cancel</Button>
              <Button
                onClick={confirmAct} disabled={busy}
                className={`h-9 text-xs text-white ${act?.action === 'approve' ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-rose-600 hover:bg-rose-700'}`}
              >
                {busy && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
                {act?.action === 'approve' ? 'Confirm approval' : 'Confirm rejection'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Create Request dialog ──────────────────────────────────────────── */}
      {createOpen && (
        <CreateRequestDialog
          onClose={() => setCreateOpen(false)}
          onCreated={() => { setCreateOpen(false); void loadLeave(); void loadBalances(); onApproved() }}
        />
      )}
    </div>
  )
}

// ─── Pending divider ──────────────────────────────────────────────────────────

function DividerRow({ colSpan, caption }: { colSpan: number; caption: string }) {
  return (
    <tr>
      <td colSpan={colSpan} className="pb-1 pt-2">
        <div className="flex items-center gap-3">
          <span className="h-px flex-1 bg-slate-200" />
          <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{caption}</span>
          <span className="h-px flex-1 bg-slate-200" />
        </div>
      </td>
    </tr>
  )
}

// ─── Create Request modal ─────────────────────────────────────────────────────

type CreateType = 'LEAVE' | 'OFFICIAL_DUTY' | 'TRAVEL' | 'SHORT_LEAVE'

function CreateRequestDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [meta, setMeta] = useState<Meta | null>(null)
  const [metaError, setMetaError] = useState(false)
  const [type, setType] = useState<CreateType>('LEAVE')
  const [leaveTypeId, setLeaveTypeId] = useState('')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [shortHours, setShortHours] = useState('2')
  const [reason, setReason] = useState('')
  const [attachmentId, setAttachmentId] = useState<string | null>(null)
  const [attachmentName, setAttachmentName] = useState('')
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [serverError, setServerError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // fetch /api/meta once for leaveTypes + policy hints
  useEffect(() => {
    let alive = true
    api<Meta>('/api/meta')
      .then((m) => {
        if (!alive) return
        setMeta(m)
        setLeaveTypeId((v) => v || m.leaveTypes[0]?.id || '')
        setStartDate((s) => s || m.today)
        setEndDate((e) => e || m.today)
      })
      .catch(() => { if (alive) setMetaError(true) })
    return () => { alive = false }
  }, [])

  const isShort = type === 'SHORT_LEAVE'
  const selectedLt = meta?.leaveTypes.find((l) => l.id === leaveTypeId)

  // live working-days hint (weekends & holidays are excluded server-side)
  const dayHint = useMemo(() => {
    if (isShort) {
      const h = Number(shortHours)
      if (!startDate || !h) return null
      return `Short leave · ${h}h on ${dayLabel(startDate)} — deducted from balance on approval`
    }
    if (!startDate || !endDate) return null
    if (endDate < startDate) return 'End date must be on or after the start date'
    const calendar = Math.floor((new Date(endDate + 'T00:00:00Z').getTime() - new Date(startDate + 'T00:00:00Z').getTime()) / 86400000) + 1
    let working = 0
    let guard = 0
    let cur = startDate
    while (cur <= endDate && guard < 90) {
      const d = new Date(cur + 'T00:00:00Z')
      if (d.getUTCDay() !== (meta?.weeklyOffDay ?? -1) && !meta?.holidays.includes(cur)) working++
      cur = new Date(d.getTime() + 86400000).toISOString().slice(0, 10)
      guard++
    }
    return `${calendar} calendar day(s) · ~${working} working day(s) — weekends & holidays are excluded server-side`
  }, [meta, isShort, startDate, endDate, shortHours])

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    if (!f) return
    if (f.size > 5 * 1024 * 1024) { setUploadError('File exceeds the 5 MB limit'); e.target.value = ''; return }
    setUploading(true)
    setUploadError(null)
    try {
      const id = await uploadAttachment(f)
      setAttachmentId(id)
      setAttachmentName(f.name)
      toast.success('Document attached')
    } catch (err) {
      setUploadError(err instanceof ApiError ? err.message : 'Upload failed')
    } finally {
      setUploading(false)
      e.target.value = ''
    }
  }

  async function submit() {
    if (!meta) return
    setServerError(null)
    setBusy(true)
    try {
      await api('/api/requests', {
        method: 'POST',
        body: JSON.stringify({
          type: isShort ? 'LEAVE' : type,
          leaveTypeId: type === 'LEAVE' || isShort ? leaveTypeId || undefined : undefined,
          isShortLeave: isShort || undefined,
          shortHours: isShort ? Number(shortHours) : undefined,
          startDate,
          endDate: isShort ? startDate : (endDate || startDate),
          reason: reason.trim(),
          attachmentId: attachmentId || undefined,
        }),
      })
      toast.success('Request submitted — routed to Team Lead for first-level approval')
      onCreated()
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Submission failed'
      if (err instanceof ApiError && err.status === 422) setServerError(msg) // cap / quota violations explained here
      toast.error(msg)
    } finally {
      setBusy(false)
    }
  }

  const canSubmit = !!reason.trim() && !!startDate && (isShort ? Number(shortHours) > 0 : !!endDate) && !uploading && !busy

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="glass-strong hrms-scroll max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-sm font-semibold text-slate-800">Create Request</DialogTitle>
          <DialogDescription className="text-xs text-slate-500">
            Submit leave, official duty or travel. Approval chain: Team Lead → Manager → HR.
          </DialogDescription>
        </DialogHeader>

        {metaError ? (
          <Alert variant="destructive" className="text-xs">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle className="text-xs">Could not load policy metadata</AlertTitle>
            <AlertDescription className="text-xs">Close this dialog and try again.</AlertDescription>
          </Alert>
        ) : !meta ? (
          <div className="flex items-center justify-center gap-2 py-10 text-xs text-slate-400">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading policy metadata…
          </div>
        ) : (
          <div className="space-y-3.5 pt-1">
            <div className="space-y-1.5">
              <Label className="text-xs text-slate-600">Request Type</Label>
              <Select value={type} onValueChange={(v) => setType(v as CreateType)}>
                <SelectTrigger className="h-9 bg-white/80 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="LEAVE" className="text-xs">Leave</SelectItem>
                  <SelectItem value="OFFICIAL_DUTY" className="text-xs">Official Duty</SelectItem>
                  <SelectItem value="TRAVEL" className="text-xs">Travel</SelectItem>
                  <SelectItem value="SHORT_LEAVE" className="text-xs">Short Leave</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {(type === 'LEAVE' || isShort) && (
              <div className="space-y-1.5">
                <Label className="text-xs text-slate-600">Leave Type</Label>
                <Select value={leaveTypeId} onValueChange={setLeaveTypeId}>
                  <SelectTrigger className="h-9 bg-white/80 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {meta.leaveTypes.map((lt) => (
                      <SelectItem key={lt.id} value={lt.id} className="text-xs">
                        {lt.name}
                        {lt.monthlyCap ? ` · max ${lt.monthlyCap}/month` : ''}{!lt.isPaid ? ' · unpaid' : ''}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {selectedLt?.monthlyCap ? (
                  <p className="text-[10px] text-slate-400">
                    Policy: max {selectedLt.monthlyCap} day(s) per calendar month
                    {selectedLt.attachmentThreshold ? ` · certificate required beyond ${selectedLt.attachmentThreshold} days` : ''}.
                  </p>
                ) : null}
              </div>
            )}

            {isShort ? (
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs text-slate-600">Date</Label>
                  <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="h-9 bg-white/80 text-xs" />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-slate-600">Hours</Label>
                  <Input
                    type="number" min="0.5" max={meta.shortLeaveMaxHours} step="0.5"
                    value={shortHours} onChange={(e) => setShortHours(e.target.value)}
                    className="h-9 bg-white/80 text-xs"
                  />
                </div>
                <p className="col-span-2 text-[10px] text-slate-400">Hours-based leave — up to {meta.shortLeaveMaxHours}h per request.</p>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs text-slate-600">From</Label>
                  <Input
                    type="date" value={startDate}
                    onChange={(e) => { setStartDate(e.target.value); if (endDate && endDate < e.target.value) setEndDate(e.target.value) }}
                    className="h-9 bg-white/80 text-xs"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs text-slate-600">To</Label>
                  <Input type="date" value={endDate} min={startDate} onChange={(e) => setEndDate(e.target.value)} className="h-9 bg-white/80 text-xs" />
                </div>
              </div>
            )}

            {dayHint && (
              <p className="rounded-lg bg-teal-50 px-2.5 py-2 text-[11px] font-medium text-teal-700 tnum ring-1 ring-teal-100">{dayHint}</p>
            )}

            <div className="space-y-1.5">
              <Label className="text-xs text-slate-600">Reason</Label>
              <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} placeholder="Why do you need this?" className="bg-white/80 text-xs" />
            </div>

            <div className="space-y-1.5">
              <Label className="flex items-center gap-1 text-xs text-slate-600"><Paperclip className="h-3 w-3" /> Document (optional)</Label>
              {attachmentId ? (
                <div className="flex w-fit items-center gap-2 rounded-lg bg-teal-50 px-2.5 py-2 text-[11px] font-medium text-teal-700 ring-1 ring-teal-100">
                  <Paperclip className="h-3 w-3" />
                  <span className="max-w-[240px] truncate">{attachmentName}</span>
                  <button
                    type="button" aria-label="Remove attachment"
                    onClick={() => { setAttachmentId(null); setAttachmentName('') }}
                    className="text-teal-600 hover:text-teal-800"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ) : (
                <Input
                  type="file" accept=".pdf,.png,.jpg" disabled={uploading} onChange={onFile}
                  className="h-9 bg-white/80 text-xs file:mr-2 file:rounded-md file:border-0 file:bg-teal-50 file:px-2 file:py-1 file:text-xs file:font-semibold file:text-teal-700"
                />
              )}
              <p className="text-[10px] text-slate-400">PDF, PNG or JPG · max 5 MB. Sick leave beyond the certificate threshold requires an attachment.</p>
              {uploadError && <p className="text-[10px] font-medium text-rose-600">{uploadError}</p>}
            </div>

            {serverError && (
              <Alert variant="destructive" className="text-xs">
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle className="text-xs">Submission blocked by policy</AlertTitle>
                <AlertDescription className="text-xs">{serverError}</AlertDescription>
                <button
                  type="button" aria-label="Dismiss" onClick={() => setServerError(null)}
                  className="absolute right-3 top-3 text-slate-400 hover:text-slate-600"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </Alert>
            )}

            <div className="flex justify-end gap-2 pt-1">
              <Button variant="ghost" onClick={onClose} className="h-9 text-xs">Cancel</Button>
              <Button onClick={submit} disabled={!canSubmit} className="h-9 bg-teal-600 text-xs text-white hover:bg-teal-700">
                {busy && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
                {busy ? 'Submitting…' : 'Submit Request'}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
