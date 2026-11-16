'use client'

import { useCallback, useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import {
  Calculator, Download, FileSpreadsheet, FileText, Loader2, Lock, Play, Users, Wallet,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  api, ApiError, dateTimeLabel, downloadFile, money, money2,
  STATUS_BADGE_TONE, type PayrollRunV2, type PersonLite, type PayslipV2, type SessionUser,
} from '@/lib/hrms/client'
import { Avatar, EmptyState, GlassCard, Pill, SectionTitle } from './shared'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'

// ─── helpers ──────────────────────────────────────────────────────────────────

/** "2026-11" → "November 2026" */
function monthLabel(month: string): string {
  if (!/^\d{4}-\d{2}$/.test(month)) return month
  const [y, m] = month.split('-').map(Number)
  return new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, 1)))
}

function prevMonthKey(): string {
  const d = new Date()
  d.setDate(1)
  d.setMonth(d.getMonth() - 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

function openProfile(userId: string) {
  window.dispatchEvent(new CustomEvent('hrms:open-profile', { detail: { userId } }))
}

function errText(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback
}

function RunStatusPill({ status }: { status: string }) {
  return <Pill text={status} tone={STATUS_BADGE_TONE[status] ?? 'slate'} />
}

function KpiChip({ label, value, accent = 'slate' }: { label: string; value: string; accent?: 'slate' | 'teal' | 'orange' | 'emerald' }) {
  const colors = {
    slate: 'text-slate-700', teal: 'text-teal-700', orange: 'text-orange-600', emerald: 'text-emerald-600',
  } as const
  return (
    <div className="glass-subtle rounded-xl px-3 py-2 min-w-[120px]">
      <p className="text-[10px] uppercase tracking-wide text-slate-400">{label}</p>
      <p className={`text-sm font-bold tnum ${colors[accent]}`}>{value}</p>
    </div>
  )
}

// ─── Employee / manager scoped view: payslips only ────────────────────────────

function MyPayslips({ user }: { user: SessionUser }) {
  const [slips, setSlips] = useState<PayslipV2[]>([])
  const [loading, setLoading] = useState(true)
  const isEmployee = user.role === 'EMPLOYEE'

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await api<{ payslips: PayslipV2[] }>('/api/payroll/payslips')
      setSlips(res.payslips)
    } catch (err) {
      toast.error(errText(err, 'Failed to load payslips'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  async function downloadSlip(id: string) {
    try {
      await downloadFile(`/api/payroll/payslips/${id}/pdf`, 'salary-slip.pdf')
      toast.success('Salary slip downloaded')
    } catch (err) {
      toast.error(errText(err, 'Download failed'))
    }
  }

  return (
    <div className="space-y-4 hrms-enter">
      <div>
        <h1 className="text-lg md:text-xl font-bold text-slate-800">My Payslips</h1>
        <p className="text-xs text-slate-500 mt-0.5">
          {isEmployee ? 'Your finalized monthly salary slips.' : 'Finalized payslips for the employees in your scope.'}
        </p>
      </div>

      {loading ? (
        <GlassCard className="p-6 flex items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-teal-600" />
        </GlassCard>
      ) : slips.length === 0 ? (
        <GlassCard className="p-6">
          <EmptyState icon={<Wallet className="h-8 w-8" />} title="No payslips yet" hint="Payslips appear here once payroll is finalized for a month." />
        </GlassCard>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {slips.map((s, i) => (
            <motion.div
              key={s.id}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: Math.min(i * 0.03, 0.3), duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
            >
              <GlassCard className="p-4 glass-hover">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-bold text-slate-800">{monthLabel(s.run?.month ?? s.month ?? '')}</p>
                    <p className="text-[10px] text-slate-400 tnum">{s.employeeCode} · {s.designation}</p>
                  </div>
                  <RunStatusPill status={s.status} />
                </div>
                <div className="mt-3 grid grid-cols-3 gap-2 text-[11px] tnum">
                  <div>
                    <span className="block text-slate-400">Gross</span>
                    <b className="text-slate-700">{money2(s.grossPay)}</b>
                  </div>
                  <div>
                    <span className="block text-slate-400">Deductions</span>
                    <b className="text-orange-600">{money2(s.totalDeduction)}</b>
                  </div>
                  <div>
                    <span className="block text-slate-400">Net Pay</span>
                    <b className="text-teal-700">{money2(s.netPay)}</b>
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void downloadSlip(s.id)}
                  className="mt-3 w-full h-8 text-xs border-slate-200 text-slate-700 hover:bg-teal-50 hover:text-teal-700 hover:border-teal-200"
                >
                  <Download className="h-3.5 w-3.5 mr-1.5" /> Download PDF
                </Button>
              </GlassCard>
            </motion.div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Salary editor (operators only) ───────────────────────────────────────────

function SalaryEditor({ people }: { people: PersonLite[] }) {
  const eligible = people.filter((p) => p.role !== 'SUPER_ADMIN')
  const [userId, setUserId] = useState<string>('')
  const [base, setBase] = useState('')
  const [hr, setHr] = useState('')
  const [util, setUtil] = useState('')
  const [reason, setReason] = useState('')
  const [adjMonth, setAdjMonth] = useState(prevMonthKey())
  const [bonus, setBonus] = useState('')
  const [arrears, setArrears] = useState('')
  const [note, setNote] = useState('')
  const [prefilling, setPrefilling] = useState(false)
  const [savingSalary, setSavingSalary] = useState(false)
  const [savingAdj, setSavingAdj] = useState(false)

  async function prefill(id: string) {
    setUserId(id)
    setBase(''); setHr(''); setUtil('')
    if (!id) return
    setPrefilling(true)
    try {
      const res = await api<{ payslips: PayslipV2[] }>(`/api/payroll/payslips?userId=${id}`)
      const latest = res.payslips[0]
      if (latest) {
        setBase(String(latest.basicSalary))
        setHr(String(latest.hrAllowance))
        setUtil(String(latest.utilityAllowance))
      }
    } catch { /* leave fields empty */ } finally {
      setPrefilling(false)
    }
  }

  async function saveSalary() {
    if (!userId) { toast.error('Select an employee first'); return }
    const payload: { userId: string; baseSalary?: number; hrAllowance?: number; utilityAllowance?: number; reason: string } = { userId, reason: reason.trim() }
    if (!payload.reason) { toast.error('A reason is required — every change is written to the immutable audit log'); return }
    let any = false
    if (base !== '') { payload.baseSalary = Number(base); any = true }
    if (hr !== '') { payload.hrAllowance = Number(hr); any = true }
    if (util !== '') { payload.utilityAllowance = Number(util); any = true }
    if (!any) { toast.error('Enter at least one salary component'); return }
    setSavingSalary(true)
    try {
      await api('/api/payroll/salary', { method: 'PATCH', body: JSON.stringify(payload) })
      toast.success('Salary components updated — written to the audit log')
      setReason('')
    } catch (err) {
      toast.error(errText(err, 'Salary update failed'))
    } finally {
      setSavingSalary(false)
    }
  }

  async function saveAdjustment() {
    if (!userId) { toast.error('Select an employee first'); return }
    setSavingAdj(true)
    try {
      await api('/api/payroll/adjustments', {
        method: 'POST',
        body: JSON.stringify({ userId, month: adjMonth, bonus: Number(bonus || 0), arrears: Number(arrears || 0), note: note.trim() }),
      })
      toast.success(`Bonus / arrears saved for ${monthLabel(adjMonth)} — written to the audit log`)
      setBonus(''); setArrears(''); setNote('')
    } catch (err) {
      toast.error(errText(err, 'Adjustment failed'))
    } finally {
      setSavingAdj(false)
    }
  }

  return (
    <GlassCard className="p-4 md:p-5">
      <SectionTitle action={prefilling ? <Loader2 className="h-3.5 w-3.5 animate-spin text-teal-600" /> : undefined}>
        <span className="inline-flex items-center gap-1.5"><Calculator className="h-3.5 w-3.5 text-teal-600" /> Salary Editor</span>
      </SectionTitle>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <div className="space-y-3">
          <p className="text-xs font-semibold text-slate-600">Salary Components</p>
          <div className="space-y-1">
            <Label className="text-[11px] text-slate-500">Employee</Label>
            <Select value={userId} onValueChange={(v) => void prefill(v)}>
              <SelectTrigger className="w-full h-9 bg-white/70 text-xs"><SelectValue placeholder="Select employee" /></SelectTrigger>
              <SelectContent className="max-h-72 hrms-scroll">
                {eligible.map((p) => (
                  <SelectItem key={p.id} value={p.id} className="text-xs">{p.fullName} · {p.employeeCode}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <div className="space-y-1">
              <Label className="text-[11px] text-slate-500">Base Salary</Label>
              <Input type="number" min={0} value={base} onChange={(e) => setBase(e.target.value)} placeholder="0" className="h-9 bg-white/80 text-xs tnum" />
            </div>
            <div className="space-y-1">
              <Label className="text-[11px] text-slate-500">HR Allowance</Label>
              <Input type="number" min={0} value={hr} onChange={(e) => setHr(e.target.value)} placeholder="0" className="h-9 bg-white/80 text-xs tnum" />
            </div>
            <div className="space-y-1">
              <Label className="text-[11px] text-slate-500">Utility Allowance</Label>
              <Input type="number" min={0} value={util} onChange={(e) => setUtil(e.target.value)} placeholder="0" className="h-9 bg-white/80 text-xs tnum" />
            </div>
          </div>
          <div className="space-y-1">
            <Label className="text-[11px] text-slate-500">Reason (audited)</Label>
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} placeholder="e.g. Annual revision approved by COO" className="bg-white/80 text-xs" />
          </div>
          <Button onClick={() => void saveSalary()} disabled={savingSalary} className="w-full h-9 text-xs bg-teal-600 hover:bg-teal-700 text-white">
            {savingSalary ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Lock className="h-3.5 w-3.5 mr-1.5" />}
            {savingSalary ? 'Saving…' : 'Save Salary Components'}
          </Button>
          <p className="text-[10px] text-slate-400">Every change is written to the immutable audit log with a before/after diff.</p>
        </div>

        <div className="space-y-3 lg:border-l lg:border-slate-100 lg:pl-5">
          <p className="text-xs font-semibold text-slate-600">Monthly Bonus / Arrears</p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <div className="space-y-1">
              <Label className="text-[11px] text-slate-500">Month</Label>
              <Input type="month" value={adjMonth} onChange={(e) => setAdjMonth(e.target.value)} className="h-9 bg-white/80 text-xs tnum" />
            </div>
            <div className="space-y-1">
              <Label className="text-[11px] text-slate-500">Bonus (Rs.)</Label>
              <Input type="number" min={0} value={bonus} onChange={(e) => setBonus(e.target.value)} placeholder="0" className="h-9 bg-white/80 text-xs tnum" />
            </div>
            <div className="space-y-1">
              <Label className="text-[11px] text-slate-500">Arrears (Rs.)</Label>
              <Input type="number" min={0} value={arrears} onChange={(e) => setArrears(e.target.value)} placeholder="0" className="h-9 bg-white/80 text-xs tnum" />
            </div>
          </div>
          <div className="space-y-1">
            <Label className="text-[11px] text-slate-500">Note (audited)</Label>
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="e.g. Q3 performance bonus" className="bg-white/80 text-xs" />
          </div>
          <Button onClick={() => void saveAdjustment()} disabled={savingAdj} className="w-full h-9 text-xs bg-slate-800 hover:bg-slate-900 text-white">
            {savingAdj ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <FileSpreadsheet className="h-3.5 w-3.5 mr-1.5" />}
            {savingAdj ? 'Saving…' : 'Save Bonus / Arrears'}
          </Button>
          <p className="text-[10px] text-slate-400">Applies to the payroll run for the selected month; adjustments are upserted per employee per month.</p>
        </div>
      </div>
    </GlassCard>
  )
}

// ─── Operator / HR view: runs + ledger ────────────────────────────────────────

type RunDetail = PayrollRunV2 & { payslips: PayslipV2[] }

function PayrollOps({ user, people }: { user: SessionUser; people: PersonLite[] }) {
  const isOperator = user.role === 'SUPER_ADMIN' || user.role === 'ACCOUNTANT'
  const [runs, setRuns] = useState<PayrollRunV2[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<RunDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [newMonth, setNewMonth] = useState(prevMonthKey())
  const [running, setRunning] = useState(false)
  const [pendingFinalize, setPendingFinalize] = useState<PayrollRunV2 | null>(null)
  const [finalizing, setFinalizing] = useState(false)

  const loadRuns = useCallback(async () => {
    setLoading(true)
    try {
      const res = await api<{ runs: PayrollRunV2[] }>('/api/payroll/runs')
      setRuns(res.runs)
      return res.runs
    } catch (err) {
      toast.error(errText(err, 'Failed to load payroll runs'))
      return []
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void loadRuns() }, [loadRuns])

  const selectRun = useCallback(async (id: string) => {
    setSelectedId(id)
    setDetailLoading(true)
    try {
      const res = await api<{ run: RunDetail }>(`/api/payroll/runs/${id}`)
      setDetail(res.run)
    } catch (err) {
      toast.error(errText(err, 'Failed to load run detail'))
      setDetail(null)
    } finally {
      setDetailLoading(false)
    }
  }, [])

  async function createRun() {
    setRunning(true)
    try {
      const res = await api<{ run: { id: string; month: string } }>('/api/payroll/runs', { method: 'POST', body: JSON.stringify({ month: newMonth }) })
      toast.success(`Payroll ledger generated for ${monthLabel(res.run.month)} — review & finalize`)
      await loadRuns()
      await selectRun(res.run.id)
    } catch (err) {
      toast.error(errText(err, 'Payroll run failed'))
    } finally {
      setRunning(false)
    }
  }

  async function doFinalize() {
    if (!pendingFinalize) return
    setFinalizing(true)
    try {
      await api(`/api/payroll/runs/${pendingFinalize.id}/finalize`, { method: 'POST' })
      toast.success(`Payroll for ${monthLabel(pendingFinalize.month)} finalized — payslips locked`)
      setPendingFinalize(null)
      await loadRuns()
      if (selectedId === pendingFinalize.id) await selectRun(pendingFinalize.id)
    } catch (err) {
      toast.error(errText(err, 'Finalize failed'))
    } finally {
      setFinalizing(false)
    }
  }

  async function discardDraft(run: PayrollRunV2) {
    if (!window.confirm(`Discard the DRAFT payroll for ${monthLabel(run.month)}? You can then generate it again.`)) return
    try {
      await api(`/api/payroll/runs/${run.id}`, { method: 'DELETE' })
      toast.success(`Draft for ${monthLabel(run.month)} discarded — you can regenerate it`)
      setSelectedId(null)
      setDetail(null)
      await loadRuns()
    } catch (err) {
      toast.error(errText(err, 'Discard failed'))
    }
  }

  async function dl(path: string, name: string, label: string) {
    try {
      await downloadFile(path, name)
      toast.success(`${label} downloaded`)
    } catch (err) {
      toast.error(errText(err, 'Download failed'))
    }
  }

  async function downloadSlip(id: string) {
    try {
      await downloadFile(`/api/payroll/payslips/${id}/pdf`, 'salary-slip.pdf')
      toast.success('Salary slip downloaded')
    } catch (err) {
      toast.error(errText(err, 'Download failed'))
    }
  }

  return (
    <div className="space-y-4 hrms-enter">
      <div>
        <h1 className="text-lg md:text-xl font-bold text-slate-800">Payroll Module</h1>
        <p className="text-xs text-slate-500 mt-0.5">Short-hours conversion, unpaid leave deductions, loans and tax — in one reviewable ledger.</p>
      </div>

      {/* Run payroll card */}
      {isOperator && (
        <GlassCard className="p-4 md:p-5">
          <SectionTitle><span className="inline-flex items-center gap-1.5"><Play className="h-3.5 w-3.5 text-teal-600" /> Run Monthly Payroll</span></SectionTitle>
          <div className="flex flex-col sm:flex-row sm:items-end gap-3">
            <div className="space-y-1 flex-1 max-w-[220px]">
              <Label className="text-[11px] text-slate-500">Payroll Month</Label>
              <Input type="month" value={newMonth} onChange={(e) => setNewMonth(e.target.value)} className="h-9 bg-white/80 text-xs tnum" />
            </div>
            <Button onClick={() => void createRun()} disabled={running || !/^\d{4}-\d{2}$/.test(newMonth)} className="h-9 text-xs bg-teal-600 hover:bg-teal-700 text-white">
              {running ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Play className="h-3.5 w-3.5 mr-1.5" />}
              {running ? 'Calculating…' : 'Run Payroll'}
            </Button>
          </div>
          <p className="mt-2 text-[10px] text-slate-400">
            Generates a reviewable DRAFT ledger — nothing is locked until you finalize. A run already existing for the month will be rejected.
          </p>
        </GlassCard>
      )}

      {/* Payroll runs */}
      <GlassCard className="p-4 md:p-5">
        <SectionTitle action={loading ? <Loader2 className="h-3.5 w-3.5 animate-spin text-teal-600" /> : undefined}>Payroll Runs</SectionTitle>
        {loading ? (
          <div className="space-y-2">{Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-10 bg-slate-100/70 rounded-lg animate-pulse" />)}</div>
        ) : runs.length === 0 ? (
          <EmptyState icon={<Wallet className="h-8 w-8" />} title="No payroll runs yet" hint="Run monthly payroll to generate the first ledger." />
        ) : (
          <div className="overflow-x-auto max-h-[340px] overflow-y-auto hrms-scroll rounded-xl border border-slate-100">
            <table className="w-full text-xs min-w-[820px]">
              <thead className="sticky top-0 bg-white/95 backdrop-blur z-10">
                <tr className="text-left text-[10px] uppercase tracking-wide text-slate-400 border-b border-slate-100">
                  <th className="px-3 py-2.5">Month</th>
                  <th className="px-3 py-2.5">Status</th>
                  <th className="px-3 py-2.5 text-right">Employees</th>
                  <th className="px-3 py-2.5 text-right">Gross</th>
                  <th className="px-3 py-2.5 text-right">Deductions</th>
                  <th className="px-3 py-2.5 text-right">Net</th>
                  <th className="px-3 py-2.5">Created By</th>
                  <th className="px-3 py-2.5">Finalized</th>
                  <th className="px-3 py-2.5 text-center">Actions</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r, i) => (
                  <motion.tr
                    key={r.id}
                    onClick={() => void selectRun(r.id)}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: Math.min(i * 0.02, 0.2) }}
                    className={`border-b border-slate-50 cursor-pointer transition-colors ${selectedId === r.id ? 'bg-teal-50/60' : 'hover:bg-slate-50/80'}`}
                  >
                    <td className="px-3 py-2 font-bold text-slate-700 tnum">{monthLabel(r.month)}</td>
                    <td className="px-3 py-2"><RunStatusPill status={r.status} /></td>
                    <td className="px-3 py-2 text-right tnum text-slate-600">{r._count?.payslips ?? 0}</td>
                    <td className="px-3 py-2 text-right tnum text-slate-600">{money(r.totalGross)}</td>
                    <td className="px-3 py-2 text-right tnum text-orange-600">{money(r.totalDeductions)}</td>
                    <td className="px-3 py-2 text-right tnum font-bold text-teal-700">{money(r.totalNet)}</td>
                    <td className="px-3 py-2 text-slate-500 truncate max-w-[140px]">{r.createdBy?.fullName ?? '—'}</td>
                    <td className="px-3 py-2 tnum text-slate-500">{r.finalizedAt ? dateTimeLabel(r.finalizedAt) : '—'}</td>
                    <td className="px-3 py-2 text-center" onClick={(e) => e.stopPropagation()}>
                      {isOperator && r.status === 'DRAFT' && (
                        <Button size="sm" variant="outline" onClick={() => setPendingFinalize(r)} className="h-7 px-2 text-[11px] border-amber-200 text-amber-700 hover:bg-amber-50">
                          <Lock className="h-3 w-3" />
                        </Button>
                      )}
                    </td>
                  </motion.tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </GlassCard>

      {/* Selected run detail */}
      {selectedId && (
        <GlassCard className="p-4 md:p-5">
          {detailLoading || !detail ? (
            <div className="flex items-center justify-center py-10">
              <Loader2 className="h-5 w-5 animate-spin text-teal-600" />
            </div>
          ) : (
            <>
              <SectionTitle action={
                <div className="flex flex-wrap items-center gap-2">
                  {isOperator && (
                    <>
                      <Button size="sm" variant="outline" onClick={() => void dl(`/api/payroll/excel?month=${detail.month}`, 'payroll-master.xlsx', 'Excel master sheet')} className="h-8 text-xs border-slate-200 text-slate-700 hover:bg-slate-50">
                        <FileSpreadsheet className="h-3.5 w-3.5 mr-1" /> Excel Master Sheet
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => void dl(`/api/payroll/bulk-pdf?month=${detail.month}`, 'salary-slips.pdf', 'Salary slips PDF')} className="h-8 text-xs border-slate-200 text-slate-700 hover:bg-slate-50">
                        <FileText className="h-3.5 w-3.5 mr-1" /> All Salary Slips (PDF)
                      </Button>
                    </>
                  )}
                  <Button size="sm" variant="outline" onClick={() => void dl(`/api/payroll/runs/${detail.id}/pdf`, 'payroll-register.pdf', 'Payroll register PDF')} className="h-8 text-xs border-slate-200 text-slate-700 hover:bg-slate-50">
                    <Download className="h-3.5 w-3.5 mr-1" /> Payroll Register (PDF)
                  </Button>
                  {isOperator && detail.status === 'DRAFT' && (
                    <>
                      <Button size="sm" variant="outline" onClick={() => void discardDraft(detail)} className="h-8 text-xs border-rose-200 text-rose-700 hover:bg-rose-50">
                        Discard draft
                      </Button>
                      <Button size="sm" onClick={() => setPendingFinalize(detail)} className="h-8 text-xs bg-amber-500 hover:bg-amber-600 text-white">
                        <Lock className="h-3.5 w-3.5 mr-1" /> Finalize
                      </Button>
                    </>
                  )}
                </div>
              }>
                Run Ledger · {monthLabel(detail.month)} <span className="ml-2"><RunStatusPill status={detail.status} /></span>
              </SectionTitle>

              <div className="flex flex-wrap gap-2 mb-4">
                <KpiChip label="Employees" value={String(detail.payslips.length)} accent="slate" />
                <KpiChip label="Total Gross" value={money2(detail.totalGross)} accent="teal" />
                <KpiChip label="Total Deductions" value={money2(detail.totalDeductions)} accent="orange" />
                <KpiChip label="Total Net" value={money2(detail.totalNet)} accent="emerald" />
              </div>

              {detail.payslips.length === 0 ? (
                <EmptyState icon={<Users className="h-8 w-8" />} title="No payslips in this run" hint="The run was created without employees — check active rosters." />
              ) : (
                <div className="overflow-x-auto max-h-[560px] overflow-y-auto hrms-scroll rounded-xl border border-slate-100">
                  <table className="w-full text-[11px] min-w-[1780px]">
                    <thead className="sticky top-0 bg-white/95 backdrop-blur z-10">
                      <tr className="text-left text-[10px] uppercase tracking-wide text-slate-400 border-b border-slate-100">
                        <th className="px-3 py-2.5">Employee</th>
                        <th className="px-3 py-2.5">Department</th>
                        <th className="px-3 py-2.5">Designation</th>
                        <th className="px-3 py-2.5 text-right">Work Days</th>
                        <th className="px-3 py-2.5 text-right">Paid Lv</th>
                        <th className="px-3 py-2.5 text-right">Unpaid Lv</th>
                        <th className="px-3 py-2.5 text-right">Short</th>
                        <th className="px-3 py-2.5 text-right">Basic</th>
                        <th className="px-3 py-2.5 text-right">Allowances</th>
                        <th className="px-3 py-2.5 text-right">Bonus/Arr.</th>
                        <th className="px-3 py-2.5 text-right">Gross</th>
                        <th className="px-3 py-2.5 text-right">Tax</th>
                        <th className="px-3 py-2.5 text-right">EOBI/PF</th>
                        <th className="px-3 py-2.5 text-right">Loan</th>
                        <th className="px-3 py-2.5 text-right">Short Ded.</th>
                        <th className="px-3 py-2.5 text-right">Unpaid Lv Ded.</th>
                        <th className="px-3 py-2.5 text-right">Total Ded.</th>
                        <th className="px-3 py-2.5 text-right">Net</th>
                        <th className="px-3 py-2.5 text-center">Slip</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.payslips.map((s) => (
                        <tr key={s.id} className="border-b border-slate-50 hover:bg-teal-50/40 transition-colors">
                          <td className="px-3 py-2">
                            <div className="flex items-center gap-2">
                              <Avatar name={s.user?.fullName ?? s.fullName} color={s.user?.avatarColor ?? '#0f766e'} size="sm" />
                              <div className="min-w-0">
                                <button
                                  onClick={() => openProfile(s.userId)}
                                  className="font-semibold text-slate-700 hover:text-teal-700 hover:underline underline-offset-2 text-left truncate max-w-[140px] block"
                                >
                                  {s.user?.fullName ?? s.fullName}
                                </button>
                                <p className="text-[10px] text-slate-400 tnum">{s.user?.employeeCode ?? s.employeeCode}</p>
                              </div>
                            </div>
                          </td>
                          <td className="px-3 py-2 text-slate-500">{s.user?.department?.name ?? s.departmentName}</td>
                          <td className="px-3 py-2 text-slate-500 truncate max-w-[130px]">{s.user?.designation ?? s.designation}</td>
                          <td className="px-3 py-2 text-right tnum text-slate-600">{s.workingDays}/{s.workedDays}</td>
                          <td className="px-3 py-2 text-right tnum text-emerald-600">{s.paidLeaves}</td>
                          <td className="px-3 py-2 text-right tnum text-rose-600">{s.unpaidLeaveDays}</td>
                          <td className="px-3 py-2 text-right tnum text-orange-600">{(s.shortMinutes / 60).toFixed(1)}h</td>
                          <td className="px-3 py-2 text-right tnum text-slate-600">{money2(s.basicSalary)}</td>
                          <td className="px-3 py-2 text-right tnum text-slate-600">{money2(s.hrAllowance + s.utilityAllowance)}</td>
                          <td className="px-3 py-2 text-right tnum text-emerald-600">{s.bonus + s.arrears > 0 ? money2(s.bonus + s.arrears) : '—'}</td>
                          <td className="px-3 py-2 text-right tnum font-semibold text-slate-700">{money2(s.grossPay)}</td>
                          <td className="px-3 py-2 text-right tnum text-rose-600">{s.incomeTax > 0 ? money2(s.incomeTax) : '—'}</td>
                          <td className="px-3 py-2 text-right tnum text-rose-600">{s.eoobi + s.providentFund > 0 ? money2(s.eoobi + s.providentFund) : '—'}</td>
                          <td className="px-3 py-2 text-right tnum text-rose-600">{s.internalLoan > 0 ? money2(s.internalLoan) : '—'}</td>
                          <td className="px-3 py-2 text-right tnum text-orange-600">{s.shortHourDeduction > 0 ? money2(s.shortHourDeduction) : '—'}</td>
                          <td className="px-3 py-2 text-right tnum text-orange-600">{s.leaveDeduction > 0 ? money2(s.leaveDeduction) : '—'}</td>
                          <td className="px-3 py-2 text-right tnum text-orange-700 font-semibold">{money2(s.totalDeduction)}</td>
                          <td className="px-3 py-2 text-right tnum font-bold text-teal-700">{money2(s.netPay)}</td>
                          <td className="px-3 py-2 text-center">
                            <Button size="sm" variant="ghost" onClick={() => void downloadSlip(s.id)} className="h-7 px-2 text-[11px] text-teal-700 hover:bg-teal-50">
                              <Download className="h-3 w-3" />
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="mt-2 text-[10px] text-slate-400">
                Every 480 cumulative short minutes converts to one leave day (casual then annual); remaining shortfall is deducted prorated from salary.
              </p>
            </>
          )}
        </GlassCard>
      )}

      {isOperator && <SalaryEditor people={people} />}

      {/* Finalize confirmation */}
      <AlertDialog open={!!pendingFinalize} onOpenChange={(o) => { if (!o) setPendingFinalize(null) }}>
        <AlertDialogContent className="glass-strong sm:max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-sm font-semibold text-slate-800">
              Finalize payroll for {pendingFinalize ? monthLabel(pendingFinalize.month) : ''}?
            </AlertDialogTitle>
            <AlertDialogDescription className="text-xs text-slate-500">
              This locks the ledger — all payslips in the run become FINALIZED and can no longer be edited. Finalized runs cannot be re-run for the same month.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="h-8 text-xs">Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={finalizing}
              onClick={(e) => { e.preventDefault(); void doFinalize() }}
              className="h-8 text-xs bg-teal-600 text-white hover:bg-teal-700"
            >
              {finalizing ? 'Finalizing…' : 'Finalize & Lock'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

// ─── Exported view ────────────────────────────────────────────────────────────

export function PayrollView({ user, people }: { user: SessionUser; people: PersonLite[] }) {
  const isOrgAdmin = user.role === 'SUPER_ADMIN' || user.role === 'HR_MANAGER'
  const isPayrollOperator = user.role === 'SUPER_ADMIN' || user.role === 'ACCOUNTANT'
  if (!isOrgAdmin && !isPayrollOperator) return <MyPayslips user={user} />
  return <PayrollOps user={user} people={people} />
}
