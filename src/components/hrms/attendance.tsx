'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlarmClock, CalendarClock, CalendarDays, Clock3, Hourglass, Inbox, Save, ShieldAlert, UserCheck, UserX,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  api, ApiError, dayLabel, timeLabel, fmtMinutes,
  type SessionUser, type PersonLite, type AttLog,
} from '@/lib/hrms/client'
import { todayKey } from '@/lib/hrms/dates'
import { Avatar, GlassCard, Pill, ScoreRing, KeyValue, KpiCard, EmptyState } from './shared'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

// ─── Local helpers ────────────────────────────────────────────────────────────

/** Statuses that count as a present/worked day (mirrors WORKED_STATUS_SET). */
const PRESENT_STATUSES = ['PRESENT', 'SHORT_DURATION', 'SHORT_LEAVE', 'WFH', 'OFFICIAL_DUTY', 'TRAVEL']
const SOURCE_TONE: Record<string, string> = { AUTO: 'slate', BIOMETRIC: 'cyan', MANUAL: 'amber', HR_OVERRIDE: 'violet' }

function openProfile(userId: string) {
  window.dispatchEvent(new CustomEvent('hrms:open-profile', { detail: { userId } }))
}

function weekdayLabel(key: string): string {
  return new Intl.DateTimeFormat('en-GB', { weekday: 'short', timeZone: 'UTC' }).format(new Date(key + 'T00:00:00Z'))
}

/** ISO timestamp → "HH:mm" in Karachi (for <input type="time"> prefill). */
function hhmm(iso: string | null): string {
  if (!iso) return ''
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Karachi', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso))
}

// ─── Attendance View ──────────────────────────────────────────────────────────

export function AttendanceView({ user, people }: { user: SessionUser; people: PersonLite[] }) {
  const [month, setMonth] = useState(todayKey().slice(0, 7))
  const [userId, setUserId] = useState(user.id) // default = me
  const [logs, setLogs] = useState<AttLog[]>([])
  const [score, setScore] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [detail, setDetail] = useState<AttLog | null>(null)
  const [reg, setReg] = useState<{ date: string } | null>(null)

  const canPick = user.role !== 'EMPLOYEE'
  const canRequestReg = user.role !== 'SUPER_ADMIN' && user.role !== 'ACCOUNTANT'
  const isHrCorrector = user.role === 'SUPER_ADMIN' || user.role === 'HR_MANAGER'

  const options = useMemo(() => {
    const self = { id: user.id, fullName: user.fullName, employeeCode: user.employeeCode, avatarColor: user.avatarColor }
    return [self, ...people.filter((p) => p.id !== user.id)]
  }, [people, user])

  const selected = useMemo(() => options.find((o) => o.id === userId) ?? null, [options, userId])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const qs = new URLSearchParams({ month })
      if (userId && userId !== user.id) qs.set('userId', userId)
      const res = await api<{ logs: AttLog[]; score: number | null }>(`/api/attendance?${qs.toString()}`)
      setLogs(res.logs)
      setScore(res.score)
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to load attendance')
    } finally {
      setLoading(false)
    }
  }, [month, userId, user.id])

  useEffect(() => { void load() }, [load])

  const sorted = useMemo(() => [...logs].sort((a, b) => a.dateKey.localeCompare(b.dateKey)), [logs])

  const stats = useMemo(() => ({
    worked: logs.reduce((s, l) => s + l.workedMinutes, 0),
    short: logs.reduce((s, l) => s + l.shortMinutes, 0),
    late: logs.filter((l) => l.lateMinutes > 0).length,
    present: logs.filter((l) => PRESENT_STATUSES.includes(l.status)).length,
    missing: logs.filter((l) => l.status === 'MISSING').length,
    absent: logs.filter((l) => l.status === 'ABSENT').length,
  }), [logs])

  return (
    <div className="space-y-4 hrms-enter">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-bold text-slate-800 md:text-xl">Attendance &amp; Timesheets</h1>
          <p className="mt-0.5 text-xs text-slate-500">
            {selected ? (
              <>
                <button
                  onClick={() => openProfile(selected.id)}
                  className="font-medium text-slate-600 hover:text-teal-700 hover:underline"
                >
                  {selected.fullName}
                </button>
                <span className="tnum"> · {selected.employeeCode}</span>
              </>
            ) : (
              'Monthly timesheet'
            )}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canRequestReg && (
            <Button
              variant="outline" onClick={() => setReg({ date: todayKey() })}
              className="h-9 border-teal-200 text-xs text-teal-700 hover:bg-teal-50"
            >
              <CalendarClock className="mr-1.5 h-3.5 w-3.5" /> Request attendance correction
            </Button>
          )}
          {canPick && (
            <Select value={userId} onValueChange={setUserId}>
              <SelectTrigger className="h-9 w-[190px] bg-white/70 text-xs"><SelectValue placeholder="Select employee" /></SelectTrigger>
              <SelectContent className="max-h-72">
                {options.map((p) => (
                  <SelectItem key={p.id} value={p.id} className="text-xs">
                    {p.fullName} · {p.employeeCode}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="h-9 w-[150px] bg-white/70 text-xs" />
        </div>
      </div>

      {/* Header strip: score ring + KPI chips */}
      <GlassCard className="p-4 md:p-5">
        <div className="flex flex-col items-center gap-5 lg:flex-row lg:items-stretch">
          {score != null ? (
            <ScoreRing pct={score} label="Score" />
          ) : (
            <div className="flex h-[108px] w-[108px] shrink-0 flex-col items-center justify-center rounded-full border-2 border-dashed border-slate-200 px-3 text-center">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Score</span>
              <span className="mt-1 text-[10px] leading-tight text-slate-400">Not available for this scope</span>
            </div>
          )}
          <div className="grid w-full flex-1 grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <KpiCard label="Worked" value={fmtMinutes(stats.worked)} icon={<Clock3 className="h-4 w-4" />} accent="teal" />
            <KpiCard label="Short" value={fmtMinutes(stats.short)} icon={<Hourglass className="h-4 w-4" />} accent="orange" />
            <KpiCard label="Late Arrivals" value={String(stats.late)} icon={<AlarmClock className="h-4 w-4" />} accent="amber" />
            <KpiCard label="Present Days" value={String(stats.present)} icon={<UserCheck className="h-4 w-4" />} accent="emerald" />
            <KpiCard label="Missing Punches" value={String(stats.missing)} icon={<CalendarDays className="h-4 w-4" />} accent="sky" />
            <KpiCard label="Absent Days" value={String(stats.absent)} icon={<UserX className="h-4 w-4" />} accent="rose" />
          </div>
        </div>
      </GlassCard>

      {/* Timesheet table */}
      <GlassCard className="p-4 md:p-5">
        {loading ? (
          <div className="space-y-2">{Array.from({ length: 8 }).map((_, i) => <div key={i} className="h-10 animate-pulse rounded-lg bg-slate-100/70" />)}</div>
        ) : sorted.length === 0 ? (
          <EmptyState icon={<Inbox className="h-8 w-8" />} title="No attendance records for this month" hint="Pick another month or employee." />
        ) : (
          <div className="hrms-scroll max-h-[520px] overflow-x-auto overflow-y-auto rounded-xl border border-slate-100">
            <table className="w-full min-w-[760px] text-xs">
              <thead className="sticky top-0 z-10 bg-white/95 backdrop-blur">
                <tr className="border-b border-slate-100 text-left text-[10px] uppercase tracking-wide text-slate-400">
                  <th className="px-3 py-2.5">Date</th>
                  <th className="px-3 py-2.5">Status</th>
                  <th className="px-3 py-2.5">Check-in</th>
                  <th className="px-3 py-2.5">Check-out</th>
                  <th className="px-3 py-2.5 text-right">Worked</th>
                  <th className="px-3 py-2.5 text-right">Short</th>
                  <th className="px-3 py-2.5 text-right">Late</th>
                  <th className="px-3 py-2.5">Source</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((log) => (
                  <tr
                    key={log.id}
                    onClick={() => setDetail(log)}
                    className="cursor-pointer border-b border-slate-50 transition-colors hover:bg-teal-50/40"
                  >
                    <td className="whitespace-nowrap px-3 py-2">
                      <p className="font-medium tnum text-slate-600">{dayLabel(log.dateKey)}</p>
                      <p className="text-[10px] text-slate-400">{weekdayLabel(log.dateKey)}</p>
                    </td>
                    <td className="px-3 py-2"><Pill text={log.status} /></td>
                    <td className="px-3 py-2 tnum text-slate-600">{timeLabel(log.checkIn)}</td>
                    <td className="px-3 py-2 tnum text-slate-600">{timeLabel(log.checkOut)}</td>
                    <td className="px-3 py-2 text-right tnum text-slate-700">{fmtMinutes(log.workedMinutes)}</td>
                    <td className="px-3 py-2 text-right tnum">
                      {log.shortMinutes > 0
                        ? <span className="font-semibold text-orange-600">{fmtMinutes(log.shortMinutes)}</span>
                        : <span className="text-slate-300">—</span>}
                    </td>
                    <td className="px-3 py-2 text-right tnum">
                      {log.lateMinutes > 0
                        ? <span className="font-semibold text-amber-600">{log.lateMinutes}m</span>
                        : <span className="text-slate-300">—</span>}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-1.5">
                        <Pill text={log.source} tone={SOURCE_TONE[log.source] ?? 'slate'} />
                        {log.isManuallyUpdated ? <Pill text="Manual" tone="amber" /> : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </GlassCard>

      {/* Detail drawer */}
      <Sheet open={!!detail} onOpenChange={(o) => { if (!o) setDetail(null) }}>
        <SheetContent side="right" className="glass-strong hrms-scroll w-full overflow-y-auto p-0 sm:max-w-lg">
          <SheetHeader className="flex-row items-center justify-between space-y-0 border-b border-slate-100 px-5 py-3.5">
            <SheetTitle className="text-sm font-semibold text-slate-700">Attendance Detail</SheetTitle>
            {detail && <Pill text={detail.status} />}
          </SheetHeader>
          {detail ? <DetailBody log={detail} canRequestReg={canRequestReg} isHrCorrector={isHrCorrector}
            onCorrectionSaved={() => { setDetail(null); void load() }}
            onRequestCorrection={(date) => { setDetail(null); setReg({ date }) }} />
            : null}
        </SheetContent>
      </Sheet>

      {/* Regularization request dialog */}
      {reg && (
        <RegularizationDialog
          initialDate={reg.date}
          onClose={() => setReg(null)}
        />
      )}
    </div>
  )
}

// ─── Drawer body ──────────────────────────────────────────────────────────────

function DetailBody({ log, canRequestReg, isHrCorrector, onCorrectionSaved, onRequestCorrection }: {
  log: AttLog
  canRequestReg: boolean
  isHrCorrector: boolean
  onCorrectionSaved: () => void
  onRequestCorrection: (date: string) => void
}) {
  const manualRelevant = !!log.isManuallyUpdated || log.source === 'MANUAL' || log.source === 'HR_OVERRIDE'
  return (
    <div className="space-y-4 p-5">
      <div className="flex items-center gap-3">
        <Avatar name={log.user.fullName} color={log.user.avatarColor} />
        <div className="min-w-0">
          <button
            onClick={() => openProfile(log.user.id)}
            className="text-sm font-semibold text-slate-800 hover:text-teal-700 hover:underline"
          >
            {log.user.fullName}
          </button>
          <p className="text-[11px] tnum text-slate-500">{log.user.employeeCode}</p>
        </div>
        <div className="ml-auto flex items-center gap-1.5 text-slate-500">
          <CalendarDays className="h-4 w-4" />
          <span className="text-sm font-semibold tnum">{dayLabel(log.dateKey)}</span>
          <span className="text-[10px] text-slate-400">{weekdayLabel(log.dateKey)}</span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <KeyValue label="Status" value={<Pill text={log.status} />} />
        <KeyValue
          label="Source"
          value={
            <span className="flex items-center gap-1.5">
              <Pill text={log.source} tone={SOURCE_TONE[log.source] ?? 'slate'} />
              {log.isManuallyUpdated ? <Pill text="Manual" tone="amber" /> : null}
            </span>
          }
        />
        <KeyValue label="Check-in" value={timeLabel(log.checkIn)} mono />
        <KeyValue label="Check-out" value={timeLabel(log.checkOut)} mono />
        <KeyValue label="Expected" value={fmtMinutes(log.expectedMinutes)} mono />
        <KeyValue label="Worked" value={fmtMinutes(log.workedMinutes)} mono />
        <KeyValue label="Short" value={log.shortMinutes > 0 ? fmtMinutes(log.shortMinutes) : '—'} mono />
        <KeyValue label="Late" value={log.lateMinutes > 0 ? `${log.lateMinutes} min` : '—'} mono />
        <KeyValue label="Early Leave" value={(log.earlyMinutes ?? 0) > 0 ? `${log.earlyMinutes} min` : '—'} mono />
        <KeyValue label="Break" value={log.breakMinutes > 0 ? `${log.breakMinutes} min` : '—'} mono />
        <KeyValue label="WFH" value={log.isWFH ? 'Yes' : 'No'} />
      </div>

      {log.notes && manualRelevant ? (
        <GlassCard className="p-3.5">
          <p className="mb-1 flex items-center gap-2 text-[11px] uppercase tracking-wide text-slate-400">
            Notes
            {log.isManuallyUpdated ? <Pill text="Manual" tone="amber" /> : null}
          </p>
          <p className="text-xs text-slate-600">{log.notes}</p>
        </GlassCard>
      ) : null}

      {isHrCorrector && <HrCorrectionForm log={log} onSaved={onCorrectionSaved} />}

      {canRequestReg && log.status === 'MISSING' && (
        <Button
          variant="outline" onClick={() => onRequestCorrection(log.dateKey)}
          className="h-9 w-full border-teal-200 text-xs text-teal-700 hover:bg-teal-50"
        >
          <CalendarClock className="mr-1.5 h-3.5 w-3.5" /> Request correction for this day
        </Button>
      )}

      {!isHrCorrector && (
        <p className="text-center text-[11px] text-slate-400">
          Punch corrections route through Team Lead → Manager → HR; every edit is audit-logged.
        </p>
      )}
    </div>
  )
}

// ─── HR / Admin direct correction ─────────────────────────────────────────────

function HrCorrectionForm({ log, onSaved }: { log: AttLog; onSaved: () => void }) {
  const [checkIn, setCheckIn] = useState(hhmm(log.checkIn))
  const [checkOut, setCheckOut] = useState(hhmm(log.checkOut))
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)

  async function save() {
    if (!reason.trim()) { toast.error('Reason is required — corrections are audit-logged.'); return }
    setBusy(true)
    try {
      await api(`/api/attendance/${log.id}/adjust`, {
        method: 'POST',
        body: JSON.stringify({
          checkIn: checkIn || undefined,
          checkOut: checkOut || undefined,
          reason: reason.trim(),
        }),
      })
      toast.success('Attendance corrected directly (HR) — audit-logged')
      onSaved()
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Correction failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <GlassCard strong className="space-y-3 p-4">
      <p className="flex items-center gap-1.5 text-xs font-semibold text-slate-700">
        <ShieldAlert className="h-3.5 w-3.5 text-violet-500" /> Direct correction (HR)
      </p>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label className="text-[11px] text-slate-500">Check-in</Label>
          <Input type="time" value={checkIn} onChange={(e) => setCheckIn(e.target.value)} className="h-8 bg-white/80 text-xs" />
        </div>
        <div className="space-y-1">
          <Label className="text-[11px] text-slate-500">Check-out</Label>
          <Input type="time" value={checkOut} onChange={(e) => setCheckOut(e.target.value)} className="h-8 bg-white/80 text-xs" />
        </div>
      </div>
      <div className="space-y-1">
        <Label className="text-[11px] text-slate-500">Reason (audit-logged)</Label>
        <Textarea
          rows={2} value={reason} onChange={(e) => setReason(e.target.value)}
          placeholder="e.g., Biometric gateway outage — verified with device logs"
          className="bg-white/80 text-xs"
        />
      </div>
      <div className="flex justify-end">
        <Button size="sm" onClick={save} disabled={busy} className="h-8 bg-teal-600 text-xs text-white hover:bg-teal-700">
          <Save className="mr-1 h-3.5 w-3.5" /> {busy ? 'Saving…' : 'Save correction'}
        </Button>
      </div>
    </GlassCard>
  )
}

// ─── Regularization request dialog ────────────────────────────────────────────

function RegularizationDialog({ initialDate, onClose }: { initialDate: string; onClose: () => void }) {
  const [date, setDate] = useState(initialDate)
  const [checkIn, setCheckIn] = useState('09:00')
  const [checkOut, setCheckOut] = useState('18:00')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit() {
    setBusy(true)
    try {
      await api('/api/attendance/requests', {
        method: 'POST',
        body: JSON.stringify({ date, requestedCheckIn: checkIn, requestedCheckOut: checkOut, reason: reason.trim() }),
      })
      toast.success('Correction request submitted — routes through Team Lead → Manager → HR')
      onClose()
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Submission failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="glass-strong sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-sm font-semibold text-slate-800">Request attendance correction</DialogTitle>
          <DialogDescription className="text-xs text-slate-500">
            Propose the correct punch times for a specific day; your approvers verify against device logs.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3.5">
          <div className="space-y-1.5">
            <Label className="text-xs text-slate-600">Date</Label>
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="h-9 bg-white/80 text-xs" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs text-slate-600">Requested check-in</Label>
              <Input type="time" value={checkIn} onChange={(e) => setCheckIn(e.target.value)} className="h-9 bg-white/80 text-xs" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-slate-600">Requested check-out</Label>
              <Input type="time" value={checkOut} onChange={(e) => setCheckOut(e.target.value)} className="h-9 bg-white/80 text-xs" />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs text-slate-600">Reason</Label>
            <Textarea
              rows={3} value={reason} onChange={(e) => setReason(e.target.value)}
              placeholder="e.g., Forgot to punch out — left office at 6:30 PM"
              className="bg-white/80 text-xs"
            />
          </div>
          <p className="text-[10px] text-slate-400">
            Three-tier approval: your Team Lead reviews first, then the Manager, then HR finalizes the correction.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose} className="h-9 text-xs">Cancel</Button>
            <Button
              onClick={submit} disabled={busy || !date || !checkIn || !checkOut || !reason.trim()}
              className="h-9 bg-teal-600 text-xs text-white hover:bg-teal-700"
            >
              {busy ? 'Submitting…' : 'Submit request'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
