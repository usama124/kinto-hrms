'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  BadgeCheck, CalendarDays, Download, IdCard, TrendingUp, ShieldAlert, Pencil,
  User, Fingerprint, Phone, Wallet,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  api, ApiError, downloadFile, ROLE_LABELS, fmtMinutes, fmtDateKey, dateTimeLabel,
  type Employee360, type Balance, type AttLog, type RequestRow, avatarSrc } from '@/lib/hrms/client'
import { Avatar, GlassCard, KeyValue, Pill, SegmentedBar, SectionTitle, EmptyState } from './shared'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { EmployeeFormDialog } from './employee-form'

export const ROLE_TONE: Record<string, string> = {
  SUPER_ADMIN: 'rose', HR_MANAGER: 'violet', ACCOUNTANT: 'purple', ACCOUNTS_MANAGER: 'purple',
  MANAGER: 'orange', TEAM_LEAD: 'teal', EMPLOYEE: 'slate',
}

/** Global convention: any employee name click anywhere opens the 360° profile. */
export function openProfile(userId: string) {
  window.dispatchEvent(new CustomEvent('hrms:open-profile', { detail: { userId } }))
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  try {
    return new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(iso))
  } catch { return iso }
}

/**
 * 360° employee popup panel — used by the Employee Directory, Org Chart and
 * My Profile views. Hierarchical access is enforced server-side (403 outside scope).
 */
export function ProfileSheet(props: {
  open: boolean
  userId: string | null
  selfId: string
  selfRole: string
  onClose: () => void
  onOpenUser: (id: string) => void
  onChanged?: () => void
}) {
  const { open, userId, selfId, selfRole, onClose, onOpenUser, onChanged } = props
  const [detail, setDetail] = useState<Employee360 | null>(null)
  const [balances, setBalances] = useState<Balance[]>([])
  const [loading, setLoading] = useState(false)
  const [month, setMonth] = useState(() => `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`)
  const [attLogs, setAttLogs] = useState<AttLog[]>([])
  const [attScore, setAttScore] = useState<number | null>(null)
  const [attLoading, setAttLoading] = useState(false)
  const [recentRequests, setRecentRequests] = useState<RequestRow[]>([])
  const [quotaDialog, setQuotaDialog] = useState<Balance | null>(null)
  const [quotaDelta, setQuotaDelta] = useState('1')
  const [quotaReason, setQuotaReason] = useState('')
  const [editOpen, setEditOpen] = useState(false)

  const canEdit = selfRole === 'SUPER_ADMIN' || selfRole === 'HR_MANAGER'

  const load = useCallback(async (id: string, m: string) => {
    setLoading(true)
    setDetail(null)
    setBalances([])
    try {
      const d = await api<{ employee: Employee360; balances: Balance[] }>(`/api/employees/${id}`)
      setDetail(d.employee)
      setBalances(d.balances)
      try {
        const att = await api<{ logs: AttLog[]; score: number | null }>(`/api/attendance?month=${m}&userId=${id}`)
        setAttLogs(att.logs ?? [])
        setAttScore(att.score ?? null)
      } catch { setAttLogs([]); setAttScore(null) }
      try {
        const reqs = await api<{ requests: RequestRow[] }>('/api/requests')
        setRecentRequests((reqs.requests ?? []).filter((r) => r.userId === id).slice(0, 5))
      } catch { setRecentRequests([]) }
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to load profile — outside your hierarchy.')
      onClose()
    } finally {
      setLoading(false)
    }
  }, [onClose])

  useEffect(() => {
    if (open && userId) void load(userId, month)
  }, [open, userId, month, load])

  async function downloadProfile(id: string) {
    try {
      await downloadFile(`/api/employees/${id}/profile-pdf`, 'profile.pdf')
      toast.success('Profile card PDF downloaded')
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Download failed')
    }
  }

  async function submitQuota() {
    if (!quotaDialog || !userId) return
    try {
      await api('/api/leave-balances/adjust', {
        method: 'POST',
        body: JSON.stringify({ userId, leaveTypeId: quotaDialog.leaveTypeId, year: new Date().getFullYear(), delta: Number(quotaDelta), reason: quotaReason }),
      })
      toast.success('Quota adjusted — recorded in the audit log')
      setQuotaDialog(null)
      setQuotaDelta('1'); setQuotaReason('')
      void load(userId, month)
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Adjustment failed')
    }
  }

  const e = detail

  return (
    <>
      <Sheet open={open} onOpenChange={(o) => { if (!o) { onClose(); setEditOpen(false) } }}>
        <SheetContent side="right" className="w-full sm:max-w-xl p-0 glass-strong overflow-y-auto hrms-scroll">
          <SheetHeader className="px-5 py-3.5 border-b border-slate-100 flex-row items-center justify-between space-y-0">
            <SheetTitle className="text-sm font-semibold text-slate-700">Employee 360° Profile</SheetTitle>
            <div className="flex items-center gap-2">
              {canEdit && userId && (
                <Button size="sm" variant="outline" onClick={() => setEditOpen(true)} className="h-8 text-xs">
                  <Pencil className="h-3.5 w-3.5 mr-1" /> Edit
                </Button>
              )}
              {userId && (
                <Button size="sm" variant="outline" onClick={() => downloadProfile(userId)} className="h-8 text-xs">
                  <Download className="h-3.5 w-3.5 mr-1" /> PDF Card
                </Button>
              )}
            </div>
          </SheetHeader>

          {loading || !e ? (
            <div className="p-6 space-y-3">{Array.from({ length: 5 }).map((_, i) => <div key={i} className="glass h-16 animate-pulse" />)}</div>
          ) : (
            <div className="p-5 space-y-5">
              {/* Identity */}
              <div className="flex items-center gap-4">
                <Avatar name={e.fullName} color={e.avatarColor} size="lg" src={avatarSrc(e)} />
                <div className="min-w-0">
                  <p className="text-base font-bold text-slate-800">{e.fullName}</p>
                  <p className="text-xs text-slate-500">{e.designation} · {e.departmentName}{e.teamName ? ` · ${e.teamName}` : ''}</p>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    <Pill text={e.employeeCode} tone="teal" />
                    <Pill text={ROLE_LABELS[e.role] ?? e.role} tone={ROLE_TONE[e.role] ?? 'slate'} />
                    <Pill text={e.employmentStatus} tone="emerald" />
                    {!e.isActive && <Pill text="INACTIVE" tone="rose" />}
                  </div>
                </div>
              </div>

              {/* Clickable reporting line — hierarchy enforced server-side */}
              <GlassCard className="p-4">
                <SectionTitle>Reporting Line (click to open profile)</SectionTitle>
                <div className="flex flex-wrap items-center gap-2">
                  {e.teamLead ? (
                    <button
                      onClick={() => onOpenUser(e.teamLead!.id)}
                      className="inline-flex items-center gap-2 rounded-full bg-teal-100/70 ring-1 ring-inset ring-teal-600/15 px-3 py-1.5 text-xs font-semibold text-teal-800 hover:bg-teal-100 transition-colors"
                      title="Open Team Lead profile"
                    >
                      <BadgeCheck className="h-3.5 w-3.5" /> Team Lead · {e.teamLead.fullName}
                    </button>
                  ) : <span className="text-xs text-slate-400">No Team Lead assigned</span>}
                  {e.manager ? (
                    <button
                      onClick={() => onOpenUser(e.manager!.id)}
                      className="inline-flex items-center gap-2 rounded-full bg-orange-100/70 ring-1 ring-inset ring-orange-600/15 px-3 py-1.5 text-xs font-semibold text-orange-800 hover:bg-orange-100 transition-colors"
                      title="Open Manager profile"
                    >
                      <BadgeCheck className="h-3.5 w-3.5" /> Manager · {e.manager.fullName}
                    </button>
                  ) : <span className="text-xs text-slate-400">No Manager assigned</span>}
                </div>
              </GlassCard>

              {/* Personal information */}
              <GlassCard className="p-4">
                <SectionTitle><span className="inline-flex items-center gap-1.5"><User className="h-4 w-4 text-teal-600" /> Personal Information</span></SectionTitle>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-x-4 gap-y-3">
                  <KeyValue label="Father Name" value={e.fatherName ?? '—'} />
                  <KeyValue label="Mother Name" value={e.motherName ?? '—'} />
                  <KeyValue label="Date of Birth" value={e.dateOfBirth ? fmtDate(e.dateOfBirth) : '—'} mono />
                  <KeyValue label="Gender" value={e.gender ?? '—'} />
                  <KeyValue label="Marital Status" value={e.maritalStatus ?? '—'} />
                  <KeyValue label="Blood Group" value={e.bloodGroup ?? '—'} />
                  <KeyValue label="Religion" value={e.religion ?? '—'} />
                  <KeyValue label="Nationality" value={e.nationality ?? '—'} />
                </div>
              </GlassCard>

              {/* Identity documents */}
              <GlassCard className="p-4">
                <SectionTitle><span className="inline-flex items-center gap-1.5"><Fingerprint className="h-4 w-4 text-teal-600" /> Identity & Documents</span></SectionTitle>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-x-4 gap-y-3">
                  <KeyValue label="CNIC" value={e.cnic ?? '—'} mono />
                  <KeyValue label="CNIC Expiry" value={e.cnicExpiry ?? '—'} mono />
                  <KeyValue label="Driving License" value={e.drivingLicense ?? '—'} mono />
                  <KeyValue label="Passport No." value={e.passportNo ?? '—'} mono />
                  <KeyValue label="Passport Expiry" value={e.passportExpiry ?? '—'} mono />
                  <KeyValue label="Employee Code" value={e.employeeCode} mono />
                </div>
              </GlassCard>

              {/* Contact & address */}
              <GlassCard className="p-4">
                <SectionTitle><span className="inline-flex items-center gap-1.5"><Phone className="h-4 w-4 text-teal-600" /> Contact & Address</span></SectionTitle>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-x-4 gap-y-3">
                  <KeyValue label="Work Email" value={e.email} />
                  <KeyValue label="Personal Email" value={e.personalEmail ?? '—'} />
                  <KeyValue label="Phone" value={e.phone ?? '—'} mono />
                  <KeyValue label="Emergency Contact" value={e.emergencyContactName ?? '—'} />
                  <KeyValue label="Emergency Phone" value={e.emergencyContactPhone ?? '—'} mono />
                  <KeyValue label="Address" value={e.address ?? '—'} />
                </div>
              </GlassCard>

              {/* Completion */}
              <GlassCard className="p-4">
                <SectionTitle>Profile Completion</SectionTitle>
                <SegmentedBar segments={[{ value: e.completionPct, color: '#0d9488', label: 'Complete' }, { value: 100 - e.completionPct, color: '#e2e8f0', label: 'Missing' }]} />
                <p className="mt-2 text-xs text-slate-500 tnum">{e.completionPct}% complete</p>
              </GlassCard>

              {/* Attendance */}
              <GlassCard className="p-4">
                <SectionTitle
                  action={
                    <div className="flex items-center gap-2">
                      <input
                        type="month" value={month} onChange={(ev) => setMonth(ev.target.value)}
                        className="glass-subtle rounded-lg h-8 px-2 text-[11px] text-slate-600"
                        aria-label="Attendance month"
                      />
                      {attLoading ? <span className="h-4 w-4 rounded-full border-2 border-teal-600 border-t-transparent animate-spin" /> : null}
                    </div>
                  }
                >
                  <span className="inline-flex items-center gap-1.5"><CalendarDays className="h-4 w-4 text-teal-600" /> Attendance & Leave</span>
                </SectionTitle>
                <div className="flex flex-wrap items-center gap-4 mb-3">
                  <div className="flex items-baseline gap-1.5">
                    <TrendingUp className="h-4 w-4 text-teal-600" />
                    <span className="text-xl font-bold text-slate-800 tnum">{attScore != null ? `${attScore}%` : '—'}</span>
                    <span className="text-[11px] text-slate-400">attendance score</span>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <Pill text={`PRESENT ${attLogs.filter((l) => ['PRESENT', 'SHORT_DURATION'].includes(l.status)).length}`} tone="emerald" />
                    <Pill text={`MISSING ${attLogs.filter((l) => l.status === 'MISSING').length}`} tone="amber" />
                    <Pill text={`ABSENT ${attLogs.filter((l) => l.status === 'ABSENT').length}`} tone="rose" />
                    <Pill text={`LEAVE ${attLogs.filter((l) => l.status === 'FULL_LEAVE' || l.status === 'SHORT_LEAVE').length}`} tone="cyan" />
                    <Pill text={`SHORT ${attLogs.reduce((s, l) => s + l.shortMinutes, 0)}m`} tone="orange" />
                  </div>
                </div>
                {attLogs.length === 0 ? (
                  <EmptyState title="No attendance in this month" hint={e.role === 'SUPER_ADMIN' ? 'System Admin has no personal attendance.' : undefined} />
                ) : (
                  <div className="max-h-48 overflow-y-auto hrms-scroll rounded-lg border border-slate-100">
                    <table className="w-full text-[11px]">
                      <thead className="sticky top-0 bg-white/90 backdrop-blur text-slate-400">
                        <tr><th className="text-left px-2.5 py-1.5 font-medium">Date</th><th className="text-left px-2 py-1.5 font-medium">Status</th><th className="text-right px-2 py-1.5 font-medium">In</th><th className="text-right px-2 py-1.5 font-medium">Out</th><th className="text-right px-2.5 py-1.5 font-medium">Worked</th></tr>
                      </thead>
                      <tbody>
                        {attLogs.slice(-15).reverse().map((l) => (
                          <tr key={l.id} className="border-t border-slate-50">
                            <td className="px-2.5 py-1.5 text-slate-600 tnum">{fmtDateKey(l.dateKey)}</td>
                            <td className="px-2 py-1.5"><Pill text={l.status} /></td>
                            <td className="px-2 py-1.5 text-right text-slate-500 tnum">{l.checkIn ? new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Karachi' }).format(new Date(l.checkIn)) : '—'}</td>
                            <td className="px-2 py-1.5 text-right text-slate-500 tnum">{l.checkOut ? new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Karachi' }).format(new Date(l.checkOut)) : '—'}</td>
                            <td className="px-2.5 py-1.5 text-right text-slate-600 tnum">{fmtMinutes(l.workedMinutes)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </GlassCard>

              {/* Direct reports */}
              {e.directs.length > 0 && (
                <GlassCard className="p-4">
                  <SectionTitle>Direct Reports ({e.directs.length})</SectionTitle>
                  <div className="space-y-2 max-h-40 overflow-y-auto hrms-scroll">
                    {e.directs.map((d) => (
                      <button key={d.id} onClick={() => onOpenUser(d.id)} className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-white/80 transition-colors text-left">
                        <Avatar name={d.fullName} color={d.avatarColor} size="sm" src={avatarSrc(d)} />
                        <span className="text-xs font-medium text-slate-700">{d.fullName}</span>
                        <span className="ml-auto text-[11px] text-slate-400 truncate">{d.designation}</span>
                      </button>
                    ))}
                  </div>
                </GlassCard>
              )}

              {/* Recent requests */}
              {recentRequests.length > 0 && (
                <GlassCard className="p-4">
                  <SectionTitle>Recent Requests</SectionTitle>
                  <div className="space-y-2">
                    {recentRequests.map((r) => (
                      <div key={r.id} className="flex items-center justify-between gap-2 text-xs">
                        <span className="text-slate-600 truncate">{r.leaveType?.name ?? r.type.replaceAll('_', ' ')} · {r.dayCount}d</span>
                        <span className="flex items-center gap-1.5">
                          <span className="text-[10px] text-slate-400 tnum">{dateTimeLabel(r.createdAt)}</span>
                          <Pill text={r.status} />
                        </span>
                      </div>
                    ))}
                  </div>
                </GlassCard>
              )}

              {/* Balances + admin quota adjust */}
              <GlassCard className="p-4">
                <SectionTitle>Leave Balances (this year)</SectionTitle>
                {balances.length === 0 ? <EmptyState title="No balances yet" hint={e.role === 'SUPER_ADMIN' ? 'System Admin has no personal leave.' : undefined} /> : (
                  <div className="space-y-3">
                    {balances.map((b) => (
                      <div key={b.leaveTypeId}>
                        <div className="flex items-center justify-between mb-1.5">
                          <span className="text-xs font-semibold text-slate-600">{b.name}</span>
                          <span className="flex items-center gap-2">
                            <span className="text-[11px] text-slate-400 tnum">{b.available} available</span>
                            {selfRole === 'SUPER_ADMIN' && userId !== selfId && (
                              <button
                                onClick={() => setQuotaDialog(b)}
                                className="rounded-md bg-teal-600/10 px-2 py-0.5 text-[10px] font-bold text-teal-700 hover:bg-teal-600/20 transition-colors"
                              >
                                + QUOTA
                              </button>
                            )}
                          </span>
                        </div>
                        <SegmentedBar height="h-2" segments={[
                          { value: b.availed, color: b.color, label: 'Availed' },
                          { value: b.pending, color: '#f59e0b', label: 'Pending' },
                          { value: Math.max(0, b.available), color: '#e2e8f0', label: 'Available' },
                        ]} />
                        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-slate-400 tnum">
                          <span>CF <b className="text-slate-600">{b.carryForward}</b></span>
                          <span>Quota <b className="text-slate-600">{b.quota}</b></span>
                          <span>Availed <b className="text-slate-600">{b.availed}</b></span>
                          <span>Pending <b className="text-slate-600">{b.pending}</b></span>
                          <span>Lapsed <b className="text-slate-600">{b.lapsed}</b></span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </GlassCard>

              {/* Employment + compensation */}
              <div className="grid grid-cols-2 md:grid-cols-3 gap-x-4 gap-y-3">
                <KeyValue label="Work Email" value={e.email} />
                <KeyValue label="Joining Date" value={fmtDateKey(e.joiningDate.slice(0, 10))} mono />
                <KeyValue label="Shift" value={e.shiftTime ? `${e.shiftName} · ${e.shiftTime}` : '—'} />
                {e.canSeeSalary && (
                  <>
                    <KeyValue label="Base Salary" value={e.baseSalary ? `PKR ${e.baseSalary.toLocaleString()}` : '—'} mono />
                    <KeyValue label="Allowances" value={e.allowances ? `PKR ${e.allowances.toLocaleString()}` : '—'} mono />
                    <KeyValue label="Bank" value={e.bankName ?? '—'} />
                  </>
                )}
              </div>

              {!e.canSeeSalary && (
                <div className="flex items-center gap-2 text-[11px] text-slate-400">
                  <Wallet className="h-3.5 w-3.5" /> Compensation details are hidden for this role
                </div>
              )}

              <div className="flex items-center gap-2 text-[11px] text-slate-400">
                <IdCard className="h-3.5 w-3.5" /> Data visible strictly per RBAC scope
                <BadgeCheck className="h-3.5 w-3.5 ml-2 text-teal-500" /> Verified
              </div>
            </div>
          )}
        </SheetContent>
      </Sheet>

      {/* Admin quota increment dialog */}
      <Dialog open={!!quotaDialog} onOpenChange={(o) => { if (!o) setQuotaDialog(null) }}>
        <DialogContent className="sm:max-w-sm glass-strong">
          <DialogHeader>
            <DialogTitle className="text-sm flex items-center gap-2">
              <ShieldAlert className="h-4 w-4 text-teal-600" /> Increment {quotaDialog?.name} quota
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-1">
            <div className="space-y-1.5">
              <label className="text-xs text-slate-600">Days to add</label>
              <Input type="number" value={quotaDelta} onChange={(ev) => setQuotaDelta(ev.target.value)} min={1} className="bg-white/70 h-9 tnum" />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-slate-600">Reason (audited)</label>
              <Input value={quotaReason} onChange={(ev) => setQuotaReason(ev.target.value)} placeholder="e.g., Retention exception approved by COO" className="bg-white/70 h-9" />
            </div>
            <p className="text-[11px] text-slate-400">Only the System Admin may adjust quotas. The change is written to the immutable audit log and the employee is notified.</p>
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setQuotaDialog(null)}>Cancel</Button>
            <Button size="sm" disabled={!quotaReason.trim()} onClick={submitQuota} className="bg-teal-600 hover:bg-teal-700 text-white">Apply increment</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Admin/HR edit dialog */}
      {canEdit && (
        <EmployeeFormDialog
          open={editOpen && !!userId}
          onClose={() => setEditOpen(false)}
          userId={userId}
          onSaved={() => {
            setEditOpen(false)
            if (userId) void load(userId, month)
            onChanged?.()
          }}
        />
      )}
    </>
  )
}
