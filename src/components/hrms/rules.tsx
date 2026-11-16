'use client'

import { useCallback, useEffect, useState } from 'react'
import { ShieldCheck, Fingerprint, ScrollText, Clock, Building, Plus, Save, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { api, ApiError, dateTimeLabel, type SessionUser, type AuditRow } from '@/lib/hrms/client'
import { GlassCard, Pill, SectionTitle, EmptyState } from './shared'
import { MfaManager } from './mfa-manager'
import { BiometricDevices } from './biometric-devices'
import { DesignationsCard } from './designations-card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Switch } from '@/components/ui/switch'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'

type RuleRow = { id: string; key: string; value: string; label: string; category: string }
type LeaveTypeRow = { id: string; name: string; code: string; annualQuota: number; monthlyCap: number | null; attachmentThreshold: number | null; colorCode: string; isPaid: boolean }
type HolidayRow = { id: string; date: string; name: string }
type ShiftRow = { id: string; name: string; startTime: string; endTime: string; graceMinutes: number; expectedMinutes: number; workingDays: string; _count?: { users: number; departments: number; teams: number } }
type DepartmentRow = { id: string; name: string; code: string; managerId?: string | null; manager?: { fullName: string } | null; _count?: { users: number }; teams?: { id: string; name: string; teamLead?: { fullName: string } | null }[] }
type TeamRow = { id: string; name: string; departmentId: string; teamLeadId: string | null; teamLeadName?: string | null }
type OrgData = { departments: DepartmentRow[]; leads: { id: string; fullName: string; role: string }[] }

export function RulesView({ user }: { user: SessionUser }) {
  const isSuperAdmin = user.role === 'SUPER_ADMIN'
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg md:text-xl font-bold text-slate-800">Rules & Settings</h1>
        <p className="text-xs text-slate-500 mt-0.5">Policy engine · Leave caps · Shifts · Organization · Security</p>
      </div>

      <Tabs defaultValue="policy" className="space-y-4">
        <TabsList className="glass-strong flex-wrap h-auto gap-1 p-1.5">
          <TabsTrigger value="policy" className="text-xs">Policy Rules</TabsTrigger>
          <TabsTrigger value="org" className="text-xs">Org & Shifts</TabsTrigger>
          <TabsTrigger value="security" className="text-xs">Security & MFA</TabsTrigger>
          <TabsTrigger value="audit" className="text-xs">Audit Logs</TabsTrigger>
        </TabsList>

        <TabsContent value="policy"><PolicyTab onChanged={() => {}} /></TabsContent>
        <TabsContent value="org"><OrgTab /></TabsContent>
        <TabsContent value="security"><SecurityTab user={user} /></TabsContent>
        <TabsContent value="audit"><AuditTab canView={isSuperAdmin || user.role === 'HR_MANAGER'} /></TabsContent>
      </Tabs>
    </div>
  )
}

// ─── Policy rules + leave caps + holidays ─────────────────────────────────────

function PolicyTab(_props: { onChanged: () => void }) {
  const [loading, setLoading] = useState(true)
  const [rules, setRules] = useState<RuleRow[]>([])
  const [leaveTypes, setLeaveTypes] = useState<LeaveTypeRow[]>([])
  const [holidays, setHolidays] = useState<HolidayRow[]>([])
  const [saving, setSaving] = useState(false)
  const [newHoliday, setNewHoliday] = useState({ date: '', name: '' })
  const [newRule, setNewRule] = useState({ label: '', value: '', category: 'GENERAL' })
  const [ltOpen, setLtOpen] = useState(false)
  const [lt, setLt] = useState({ name: '', code: '', annualQuota: 10, isPaid: true, colorCode: '#0D9488', monthlyCap: '', attachmentThreshold: '' })

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const d = await api<{ rules: RuleRow[]; leaveTypes: LeaveTypeRow[]; holidays: HolidayRow[] }>('/api/rules')
      setRules(d.rules); setLeaveTypes(d.leaveTypes); setHolidays(d.holidays)
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to load rules')
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { void load() }, [load])

  async function save() {
    setSaving(true)
    try {
      await api('/api/rules', {
        method: 'PUT',
        body: JSON.stringify({
          // custom rules also carry their (editable) name; built-in rules keep their fixed label
          rules: rules.map((r) => (r.key.startsWith('custom.') ? { key: r.key, value: r.value, label: r.label } : { key: r.key, value: r.value })),
          leaveCaps: leaveTypes.map((t) => ({ leaveTypeId: t.id, annualQuota: t.annualQuota, monthlyCap: t.monthlyCap, attachmentThreshold: t.attachmentThreshold })),
        }),
      })
      toast.success('Policy engine updated — audit logged')
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Save failed')
    } finally { setSaving(false) }
  }

  async function addRule() {
    if (newRule.label.trim().length < 2 || !newRule.value.trim()) return
    setSaving(true)
    try {
      await api('/api/rules', { method: 'POST', body: JSON.stringify(newRule) })
      toast.success('Rule added')
      setNewRule({ label: '', value: '', category: 'GENERAL' })
      void load()
    } catch (err) { toast.error(err instanceof ApiError ? err.message : 'Could not add the rule') } finally { setSaving(false) }
  }

  async function deleteRule(r: RuleRow) {
    if (!window.confirm(`Delete the rule “${r.label}”?`)) return
    try {
      await api('/api/rules', { method: 'DELETE', body: JSON.stringify({ key: r.key }) })
      toast.success('Rule deleted')
      void load()
    } catch (err) { toast.error(err instanceof ApiError ? err.message : 'Could not delete the rule') }
  }

  async function addLeaveType() {
    setSaving(true)
    try {
      await api('/api/leave-types', {
        method: 'POST',
        body: JSON.stringify({ ...lt, code: lt.code.trim().toUpperCase(), monthlyCap: lt.monthlyCap === '' ? null : Number(lt.monthlyCap), attachmentThreshold: lt.attachmentThreshold === '' ? null : Number(lt.attachmentThreshold) }),
      })
      toast.success('Leave type added — every employee now has a balance for it')
      setLtOpen(false)
      setLt({ name: '', code: '', annualQuota: 10, isPaid: true, colorCode: '#0D9488', monthlyCap: '', attachmentThreshold: '' })
      void load()
    } catch (err) { toast.error(err instanceof ApiError ? err.message : 'Could not add the leave type') } finally { setSaving(false) }
  }

  async function addHoliday() {
    if (!newHoliday.date || !newHoliday.name) return
    try {
      await api('/api/rules', { method: 'PUT', body: JSON.stringify({ holiday: newHoliday }) })
      toast.success('Holiday added')
      setNewHoliday({ date: '', name: '' })
      void load()
    } catch (err) { toast.error(err instanceof ApiError ? err.message : 'Failed') }
  }

  async function removeHoliday(date: string) {
    try {
      await api('/api/rules', { method: 'PUT', body: JSON.stringify({ removeHoliday: date }) })
      toast.success('Holiday removed')
      void load()
    } catch (err) { toast.error(err instanceof ApiError ? err.message : 'Failed') }
  }

  if (loading) return <LoadingBlock />

  return (
    <div className="space-y-4">
      <GlassCard className="p-5">
        <SectionTitle action={<Button size="sm" onClick={save} disabled={saving} className="bg-teal-600 hover:bg-teal-700 text-white h-8 text-xs"><Save className="h-3.5 w-3.5 mr-1" />{saving ? 'Saving…' : 'Save all rules'}</Button>}>
          Shift & Short-Hours Policy Engine
        </SectionTitle>
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {rules.filter((r) => !r.key.startsWith('custom.')).map((r) => (
            <div key={r.key} className="glass-subtle rounded-xl p-3">
              <label className="text-[11px] font-semibold text-slate-600">{r.label}</label>
              <Input
                value={rules.find((x) => x.key === r.key)?.value ?? ''}
                onChange={(e) => setRules((rs) => rs.map((x) => x.key === r.key ? { ...x, value: e.target.value } : x))}
                className="mt-1.5 h-8 bg-white/70 text-xs tnum"
              />
              <p className="mt-1 text-[10px] text-slate-400">{r.key}</p>
            </div>
          ))}
        </div>
      </GlassCard>

      <GlassCard className="p-5">
        <SectionTitle>Custom Rules</SectionTitle>
        <p className="text-[11px] text-slate-500 mb-3">
          Add your own policy rules and settings (for example a probation period or a notice period). Built-in rules above drive attendance and payroll
          calculations; custom rules are recorded policy values you and your team can reference, and they are audit-logged. Use <b>Save all rules</b> to store edits.
        </p>
        <div className="flex flex-wrap items-end gap-2 mb-4">
          <div className="space-y-1"><Label className="text-[11px] text-slate-500">Rule name</Label><Input value={newRule.label} onChange={(e) => setNewRule((r) => ({ ...r, label: e.target.value }))} maxLength={80} placeholder="e.g., Probation period (months)" className="h-8 w-60 max-w-full bg-white/70 text-xs" /></div>
          <div className="space-y-1"><Label className="text-[11px] text-slate-500">Value</Label><Input value={newRule.value} onChange={(e) => setNewRule((r) => ({ ...r, value: e.target.value }))} maxLength={200} placeholder="e.g., 3" className="h-8 w-40 bg-white/70 text-xs" /></div>
          <div className="space-y-1">
            <Label className="text-[11px] text-slate-500">Category</Label>
            <select value={newRule.category} onChange={(e) => setNewRule((r) => ({ ...r, category: e.target.value }))} className="h-8 rounded-md border border-slate-200 bg-white/70 px-2 text-xs text-slate-600">
              {['GENERAL', 'LEAVE_CAPS', 'SHORT_HOURS', 'PAYROLL'].map((c) => <option key={c} value={c}>{c.replace('_', ' ')}</option>)}
            </select>
          </div>
          <Button size="sm" onClick={addRule} disabled={saving || newRule.label.trim().length < 2 || !newRule.value.trim()} className="h-8 bg-teal-600 hover:bg-teal-700 text-white text-xs"><Plus className="h-3.5 w-3.5 mr-1" />Add rule</Button>
        </div>
        {rules.filter((r) => r.key.startsWith('custom.')).length === 0 ? (
          <p className="text-xs text-slate-400">No custom rules yet.</p>
        ) : (
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {rules.filter((r) => r.key.startsWith('custom.')).map((r) => (
              <div key={r.key} className="glass-subtle rounded-xl p-3">
                <div className="flex items-center justify-between gap-2">
                  <Pill text={r.category.replace('_', ' ')} tone="slate" />
                  <button type="button" onClick={() => void deleteRule(r)} className="text-slate-400 hover:text-rose-600" aria-label={`Delete ${r.label}`}><Trash2 className="h-3.5 w-3.5" /></button>
                </div>
                <Input value={r.label} maxLength={80} onChange={(e) => setRules((rs) => rs.map((x) => x.key === r.key ? { ...x, label: e.target.value } : x))} className="mt-2 h-8 bg-white/70 text-xs font-semibold" />
                <Input value={r.value} maxLength={200} onChange={(e) => setRules((rs) => rs.map((x) => x.key === r.key ? { ...x, value: e.target.value } : x))} className="mt-1.5 h-8 bg-white/70 text-xs tnum" />
                <p className="mt-1 text-[10px] text-slate-400">{r.key}</p>
              </div>
            ))}
          </div>
        )}
      </GlassCard>

      <GlassCard className="p-5">
        <SectionTitle action={<Button size="sm" variant="outline" onClick={() => setLtOpen(true)} className="h-8 text-xs"><Plus className="h-3.5 w-3.5 mr-1" />Add leave type</Button>}>
          Leave Types — Annual Quotas, Monthly Caps & Conditional Certificates
        </SectionTitle>
        <div className="overflow-x-auto">
          <table className="w-full text-xs min-w-[640px]">
            <thead className="text-slate-400">
              <tr>
                <th className="text-left py-2 font-medium">Type</th>
                <th className="text-right px-3 py-2 font-medium">Annual Quota</th>
                <th className="text-right px-3 py-2 font-medium">Monthly Cap</th>
                <th className="text-right px-3 py-2 font-medium">Certificate after</th>
                <th className="text-left px-3 py-2 font-medium">Paid</th>
              </tr>
            </thead>
            <tbody>
              {leaveTypes.map((t) => (
                <tr key={t.id} className="border-t border-slate-100">
                  <td className="py-2"><span className="inline-flex items-center gap-2 font-semibold text-slate-700"><span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: t.colorCode }} />{t.name}</span></td>
                  <td className="text-right px-3 py-2"><Input type="number" min={0} value={t.annualQuota} onChange={(e) => setLeaveTypes((ts) => ts.map((x) => x.id === t.id ? { ...x, annualQuota: Number(e.target.value) } : x))} className="w-20 h-8 bg-white/70 text-right tnum" /></td>
                  <td className="text-right px-3 py-2"><Input type="number" min={0} value={t.monthlyCap ?? ''} placeholder="∞" onChange={(e) => setLeaveTypes((ts) => ts.map((x) => x.id === t.id ? { ...x, monthlyCap: e.target.value === '' ? null : Number(e.target.value) } : x))} className="w-20 h-8 bg-white/70 text-right tnum" /></td>
                  <td className="text-right px-3 py-2"><Input type="number" min={0} value={t.attachmentThreshold ?? ''} placeholder="—" onChange={(e) => setLeaveTypes((ts) => ts.map((x) => x.id === t.id ? { ...x, attachmentThreshold: e.target.value === '' ? null : Number(e.target.value) } : x))} className="w-20 h-8 bg-white/70 text-right tnum" /></td>
                  <td className="px-3 py-2"><Pill text={t.isPaid ? 'PAID' : 'UNPAID'} tone={t.isPaid ? 'emerald' : 'slate'} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-[11px] text-slate-400">Monthly cap = hard block at submission (UI + API). Certificate threshold = beyond N availed days/month, a document upload becomes mandatory.</p>
      </GlassCard>

      <GlassCard className="p-5">
        <SectionTitle>Holiday Calendar</SectionTitle>
        <div className="flex flex-wrap items-end gap-2 mb-3">
          <div className="space-y-1"><Label className="text-[11px] text-slate-500">Date</Label><Input type="date" value={newHoliday.date} onChange={(e) => setNewHoliday((h) => ({ ...h, date: e.target.value }))} className="h-8 bg-white/70 text-xs" /></div>
          <div className="space-y-1"><Label className="text-[11px] text-slate-500">Name</Label><Input value={newHoliday.name} onChange={(e) => setNewHoliday((h) => ({ ...h, name: e.target.value }))} placeholder="e.g., Quaid Day" className="h-8 bg-white/70 text-xs w-44" /></div>
          <Button size="sm" onClick={addHoliday} className="h-8 bg-teal-600 hover:bg-teal-700 text-white text-xs"><Plus className="h-3.5 w-3.5 mr-1" />Add</Button>
        </div>
        <div className="flex flex-wrap gap-1.5 max-h-32 overflow-y-auto hrms-scroll">
          {holidays.map((h) => (
            <button key={h.id} onClick={() => removeHoliday(h.date)} className="glass-subtle rounded-full px-2.5 py-1 text-[11px] text-slate-600 hover:bg-rose-50 hover:text-rose-600 transition-colors" title="Click to remove">
              {h.date} · {h.name}
            </button>
          ))}
        </div>
      </GlassCard>

      <Dialog open={ltOpen} onOpenChange={setLtOpen}>
        <DialogContent className="sm:max-w-md glass-strong">
          <DialogHeader><DialogTitle className="text-sm">Add leave type</DialogTitle></DialogHeader>
          <div className="grid grid-cols-2 gap-3 py-1">
            <div className="col-span-2 space-y-1"><Label className="text-[11px] text-slate-500">Name *</Label><Input value={lt.name} onChange={(e) => setLt((f) => ({ ...f, name: e.target.value }))} maxLength={40} placeholder="e.g., Maternity Leave" className="bg-white/70 h-9" /></div>
            <div className="space-y-1"><Label className="text-[11px] text-slate-500">Code * (A–Z, 0–9, _)</Label><Input value={lt.code} onChange={(e) => setLt((f) => ({ ...f, code: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '') }))} maxLength={12} placeholder="MATERNITY" className="bg-white/70 h-9" /></div>
            <div className="space-y-1"><Label className="text-[11px] text-slate-500">Annual quota (days)</Label><Input type="number" min={0} max={365} value={lt.annualQuota} onChange={(e) => setLt((f) => ({ ...f, annualQuota: Number(e.target.value) }))} className="bg-white/70 h-9 tnum" /></div>
            <div className="space-y-1"><Label className="text-[11px] text-slate-500">Monthly cap (optional)</Label><Input type="number" min={1} max={31} value={lt.monthlyCap} onChange={(e) => setLt((f) => ({ ...f, monthlyCap: e.target.value }))} placeholder="∞" className="bg-white/70 h-9 tnum" /></div>
            <div className="space-y-1"><Label className="text-[11px] text-slate-500">Certificate after (days)</Label><Input type="number" min={1} max={31} value={lt.attachmentThreshold} onChange={(e) => setLt((f) => ({ ...f, attachmentThreshold: e.target.value }))} placeholder="—" className="bg-white/70 h-9 tnum" /></div>
            <div className="flex items-center gap-2"><Switch checked={lt.isPaid} onCheckedChange={(v) => setLt((f) => ({ ...f, isPaid: v }))} /><Label className="text-xs text-slate-600">Paid leave</Label></div>
            <div className="space-y-1"><Label className="text-[11px] text-slate-500">Colour</Label><Input type="color" value={lt.colorCode} onChange={(e) => setLt((f) => ({ ...f, colorCode: e.target.value }))} className="bg-white/70 h-9 p-1" /></div>
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setLtOpen(false)}>Cancel</Button>
            <Button size="sm" disabled={saving || lt.name.trim().length < 2 || lt.code.length < 2} onClick={addLeaveType} className="bg-teal-600 hover:bg-teal-700 text-white">Add</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ─── Org structure + shift templates ──────────────────────────────────────────

function OrgTab() {
  const [org, setOrg] = useState<OrgData | null>(null)
  const [shifts, setShifts] = useState<ShiftRow[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [deptDialog, setDeptDialog] = useState(false)
  const [teamDialog, setTeamDialog] = useState(false)
  const [shiftDialog, setShiftDialog] = useState(false)
  const [assignDialog, setAssignDialog] = useState<{ shift: ShiftRow } | null>(null)

  const [deptForm, setDeptForm] = useState({ name: '', code: '', managerId: '' })
  const [teamForm, setTeamForm] = useState({ name: '', departmentId: '', teamLeadId: '' })
  const [shiftForm, setShiftForm] = useState({ name: '', startTime: '11:00', endTime: '20:00', graceMinutes: 15, days: [1, 2, 3, 4, 5] })
  const [assignForm, setAssignForm] = useState({ userId: '', teamId: '', departmentId: '' })

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [o, s] = await Promise.all([api<OrgData>('/api/org-structure'), api<{ shifts: ShiftRow[] }>('/api/shifts')])
      setOrg(o); setShifts(s.shifts)
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to load org data')
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { void load() }, [load])

  async function createDept() {
    setBusy(true)
    try {
      await api('/api/org-structure', { method: 'POST', body: JSON.stringify({ kind: 'department', ...deptForm, managerId: deptForm.managerId || null }) })
      toast.success('Department created'); setDeptDialog(false); setDeptForm({ name: '', code: '', managerId: '' }); void load()
    } catch (err) { toast.error(err instanceof ApiError ? err.message : 'Failed') } finally { setBusy(false) }
  }
  async function createTeam() {
    setBusy(true)
    try {
      await api('/api/org-structure', { method: 'POST', body: JSON.stringify({ kind: 'team', ...teamForm, teamLeadId: teamForm.teamLeadId || null }) })
      toast.success('Team created'); setTeamDialog(false); setTeamForm({ name: '', departmentId: '', teamLeadId: '' }); void load()
    } catch (err) { toast.error(err instanceof ApiError ? err.message : 'Failed') } finally { setBusy(false) }
  }
  async function createShift() {
    setBusy(true)
    try {
      await api('/api/shifts', { method: 'POST', body: JSON.stringify(shiftForm) })
      toast.success('Shift template created'); setShiftDialog(false); void load()
    } catch (err) { toast.error(err instanceof ApiError ? err.message : 'Failed') } finally { setBusy(false) }
  }
  async function assignShift() {
    if (!assignDialog) return
    setBusy(true)
    try {
      await api('/api/shifts', {
        method: 'PATCH',
        body: JSON.stringify({
          shiftId: assignDialog.shift.id,
          ...(assignForm.userId ? { userId: assignForm.userId } : assignForm.teamId ? { teamId: assignForm.teamId } : { departmentId: assignForm.departmentId }),
        }),
      })
      toast.success('Shift assigned'); setAssignDialog(null); void load()
    } catch (err) { toast.error(err instanceof ApiError ? err.message : 'Failed') } finally { setBusy(false) }
  }

  if (loading) return <LoadingBlock />

  return (
    <div className="space-y-4">
      <GlassCard className="p-5">
        <SectionTitle action={
          <div className="flex gap-2">
            <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => setDeptDialog(true)}><Building className="h-3.5 w-3.5 mr-1" />New Department</Button>
            <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => setTeamDialog(true)}><Plus className="h-3.5 w-3.5 mr-1" />New Team</Button>
            <Button size="sm" className="h-8 text-xs bg-teal-600 hover:bg-teal-700 text-white" onClick={() => setShiftDialog(true)}><Clock className="h-3.5 w-3.5 mr-1" />New Shift</Button>
          </div>
        }>
          Departments & Teams
        </SectionTitle>
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {(org?.departments ?? []).map((d) => (
            <div key={d.id} className="glass-subtle rounded-xl p-3">
              <div className="flex items-center justify-between">
                <p className="text-sm font-bold text-slate-700">{d.name}</p>
                <Pill text={d.code} tone="teal" />
              </div>
              <p className="mt-1 text-[11px] text-slate-500">Head: {d.manager?.fullName ?? '—'} · {d._count?.users ?? 0} people</p>
              <div className="mt-2 space-y-1">
                {(d.teams ?? []).map((t) => (
                  <div key={t.id} className="text-[11px] text-slate-500 flex items-center justify-between">
                    <span className="truncate">{t.name}</span>
                    <span className="text-slate-400 truncate max-w-[90px]">{t.teamLead?.fullName ?? 'no lead'}</span>
                  </div>
                ))}
                {(d.teams ?? []).length === 0 && <span className="text-[10px] text-slate-400">No teams yet</span>}
              </div>
            </div>
          ))}
        </div>
      </GlassCard>

      <DesignationsCard />

      <GlassCard className="p-5">
        <SectionTitle>Shift Templates (Office Timing Configuration)</SectionTitle>
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {shifts.map((s) => (
            <div key={s.id} className="glass-subtle rounded-xl p-3">
              <p className="text-sm font-bold text-slate-700">{s.name}</p>
              <p className="mt-1 text-xs text-slate-500 tnum">{s.startTime} – {s.endTime} · grace {s.graceMinutes}m · expected {s.expectedMinutes}m</p>
              <p className="mt-1 text-[10px] text-slate-400">{daysLabel(s.workingDays)}</p>
              <div className="mt-2 flex items-center justify-between">
                <span className="text-[10px] text-slate-400 tnum">{s._count?.users ?? 0} users · {s._count?.departments ?? 0} depts · {s._count?.teams ?? 0} teams</span>
                <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => { setAssignDialog({ shift: s }); setAssignForm({ userId: '', teamId: '', departmentId: '' }) }}>Assign</Button>
              </div>
            </div>
          ))}
        </div>
        <p className="mt-3 text-[11px] text-slate-400">Assignment priority: Employee override → Team shift → Department shift → global default.</p>
      </GlassCard>

      {/* Department dialog */}
      <Dialog open={deptDialog} onOpenChange={setDeptDialog}>
        <DialogContent className="sm:max-w-sm glass-strong">
          <DialogHeader><DialogTitle className="text-sm">Create department</DialogTitle></DialogHeader>
          <div className="space-y-3 py-1">
            <Input placeholder="Name (e.g., Marketing)" value={deptForm.name} onChange={(e) => setDeptForm((f) => ({ ...f, name: e.target.value }))} className="bg-white/70 h-9" />
            <Input placeholder="Code (e.g., MKT)" value={deptForm.code} onChange={(e) => setDeptForm((f) => ({ ...f, code: e.target.value.toUpperCase() }))} className="bg-white/70 h-9" />
            <select value={deptForm.managerId} onChange={(e) => setDeptForm((f) => ({ ...f, managerId: e.target.value }))} className="w-full h-9 rounded-md border border-slate-200 bg-white/70 px-2 text-xs text-slate-600">
              <option value="">Department head (optional)</option>
              {(org?.leads ?? []).map((l) => <option key={l.id} value={l.id}>{l.fullName} · {l.role.replaceAll('_', ' ')}</option>)}
            </select>
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setDeptDialog(false)}>Cancel</Button>
            <Button size="sm" disabled={!deptForm.name || !deptForm.code || busy} onClick={createDept} className="bg-teal-600 hover:bg-teal-700 text-white">Create</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Team dialog */}
      <Dialog open={teamDialog} onOpenChange={setTeamDialog}>
        <DialogContent className="sm:max-w-sm glass-strong">
          <DialogHeader><DialogTitle className="text-sm">Create team</DialogTitle></DialogHeader>
          <div className="space-y-3 py-1">
            <Input placeholder="Team name" value={teamForm.name} onChange={(e) => setTeamForm((f) => ({ ...f, name: e.target.value }))} className="bg-white/70 h-9" />
            <select value={teamForm.departmentId} onChange={(e) => setTeamForm((f) => ({ ...f, departmentId: e.target.value }))} className="w-full h-9 rounded-md border border-slate-200 bg-white/70 px-2 text-xs text-slate-600">
              <option value="">Select department</option>
              {(org?.departments ?? []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
            <select value={teamForm.teamLeadId} onChange={(e) => setTeamForm((f) => ({ ...f, teamLeadId: e.target.value }))} className="w-full h-9 rounded-md border border-slate-200 bg-white/70 px-2 text-xs text-slate-600">
              <option value="">Team Lead (optional)</option>
              {(org?.leads ?? []).filter((l) => l.role === 'TEAM_LEAD' || l.role === 'MANAGER').map((l) => <option key={l.id} value={l.id}>{l.fullName}</option>)}
            </select>
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setTeamDialog(false)}>Cancel</Button>
            <Button size="sm" disabled={!teamForm.name || !teamForm.departmentId || busy} onClick={createTeam} className="bg-teal-600 hover:bg-teal-700 text-white">Create</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Shift dialog */}
      <Dialog open={shiftDialog} onOpenChange={setShiftDialog}>
        <DialogContent className="sm:max-w-sm glass-strong">
          <DialogHeader><DialogTitle className="text-sm">Create shift template</DialogTitle></DialogHeader>
          <div className="space-y-3 py-1">
            <Input placeholder="Shift name (e.g., Evening Shift)" value={shiftForm.name} onChange={(e) => setShiftForm((f) => ({ ...f, name: e.target.value }))} className="bg-white/70 h-9" />
            <div className="grid grid-cols-2 gap-2">
              <div><Label className="text-[11px] text-slate-500">Start</Label><Input type="time" value={shiftForm.startTime} onChange={(e) => setShiftForm((f) => ({ ...f, startTime: e.target.value }))} className="bg-white/70 h-9" /></div>
              <div><Label className="text-[11px] text-slate-500">End</Label><Input type="time" value={shiftForm.endTime} onChange={(e) => setShiftForm((f) => ({ ...f, endTime: e.target.value }))} className="bg-white/70 h-9" /></div>
            </div>
            <div><Label className="text-[11px] text-slate-500">Grace minutes</Label><Input type="number" value={shiftForm.graceMinutes} onChange={(e) => setShiftForm((f) => ({ ...f, graceMinutes: Number(e.target.value) }))} className="bg-white/70 h-9 tnum" /></div>
            <div>
              <Label className="text-[11px] text-slate-500">Working days</Label>
              <div className="flex flex-wrap gap-1.5 mt-1">
                {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d, i) => {
                  const day = i + 1
                  const on = shiftForm.days.includes(day)
                  return (
                    <button
                      key={d} type="button"
                      onClick={() => setShiftForm((f) => ({ ...f, days: on ? f.days.filter((x) => x !== day) : [...f.days, day] }))}
                      className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors ${on ? 'bg-teal-600 text-white' : 'glass-subtle text-slate-500'}`}
                    >
                      {d}
                    </button>
                  )
                })}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setShiftDialog(false)}>Cancel</Button>
            <Button size="sm" disabled={!shiftForm.name || busy} onClick={createShift} className="bg-teal-600 hover:bg-teal-700 text-white">Create</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Assign dialog */}
      <Dialog open={!!assignDialog} onOpenChange={(o) => { if (!o) setAssignDialog(null) }}>
        <DialogContent className="sm:max-w-sm glass-strong">
          <DialogHeader><DialogTitle className="text-sm">Assign “{assignDialog?.shift.name}”</DialogTitle></DialogHeader>
          <div className="space-y-3 py-1">
            <select value={assignForm.userId} onChange={(e) => setAssignForm((f) => ({ ...f, userId: e.target.value, teamId: '', departmentId: '' }))} className="w-full h-9 rounded-md border border-slate-200 bg-white/70 px-2 text-xs text-slate-600">
              <option value="">Assign to individual employee…</option>
            </select>
            <select value={assignForm.teamId} onChange={(e) => setAssignForm((f) => ({ ...f, teamId: e.target.value, userId: '', departmentId: '' }))} className="w-full h-9 rounded-md border border-slate-200 bg-white/70 px-2 text-xs text-slate-600">
              <option value="">Assign to team…</option>
              {(org?.departments ?? []).flatMap((d) => (d.teams ?? []).map((t) => <option key={t.id} value={t.id}>{t.name} · {d.name}</option>))}
            </select>
            <select value={assignForm.departmentId} onChange={(e) => setAssignForm((f) => ({ ...f, departmentId: e.target.value, userId: '', teamId: '' }))} className="w-full h-9 rounded-md border border-slate-200 bg-white/70 px-2 text-xs text-slate-600">
              <option value="">Assign to whole department…</option>
              {(org?.departments ?? []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
            <p className="text-[11px] text-slate-400">Choose exactly one target. Every assignment is written to the audit log.</p>
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setAssignDialog(null)}>Cancel</Button>
            <Button size="sm" disabled={busy || Object.values(assignForm).filter(Boolean).length !== 1} onClick={assignShift} className="bg-teal-600 hover:bg-teal-700 text-white">Assign</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ─── Security: MFA enrollment + biometric device sync ────────────────────────

function SecurityTab({ user }: { user: SessionUser }) {
  void user
  return (
    <div className="grid lg:grid-cols-2 gap-4">
      <GlassCard className="p-5">
        <SectionTitle><span className="inline-flex items-center gap-1.5"><ShieldCheck className="h-4 w-4 text-teal-600" /> Multi-Factor Authentication · my authenticators</span></SectionTitle>
        <MfaManager />
      </GlassCard>

      <GlassCard className="p-5">
        <SectionTitle><span className="inline-flex items-center gap-1.5"><Fingerprint className="h-4 w-4 text-teal-600" /> Biometric attendance devices</span></SectionTitle>
        <BiometricDevices />
      </GlassCard>
    </div>
  )
}

// ─── Audit logs ───────────────────────────────────────────────────────────────

function AuditTab({ canView }: { canView: boolean }) {
  const [logs, setLogs] = useState<AuditRow[]>([])
  const [loading, setLoading] = useState(true)
  const [entity, setEntity] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const d = await api<{ logs: AuditRow[] }>(`/api/audit-logs?take=150${entity ? `&entityType=${entity}` : ''}`)
      setLogs(d.logs)
    } catch (err) { toast.error(err instanceof ApiError ? err.message : 'Failed to load audit trail') } finally { setLoading(false) }
  }, [entity])

  useEffect(() => { void load() }, [load])

  if (!canView) return <GlassCard className="p-6"><EmptyState title="Audit trail is Admin / HR only" /></GlassCard>

  return (
    <GlassCard className="p-5">
      <SectionTitle action={
        <div className="flex items-center gap-2">
          <select value={entity} onChange={(e) => setEntity(e.target.value)} className="h-8 rounded-md border border-slate-200 bg-white/70 px-2 text-xs text-slate-600">
            <option value="">All entities</option>
            {['SALARY', 'LEAVE_QUOTA', 'ATTENDANCE', 'ATTENDANCE_REQUEST', 'REQUEST', 'RULE', 'PAYROLL', 'MFA', 'SECURITY', 'SHIFT'].map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <Button size="sm" variant="outline" className="h-8" onClick={() => void load()}><ScrollText className="h-3.5 w-3.5" /></Button>
        </div>
      }>
        <span className="inline-flex items-center gap-1.5"><ScrollText className="h-4 w-4 text-teal-600" /> Immutable Audit Trail</span>
      </SectionTitle>
      {loading ? <LoadingBlock /> : logs.length === 0 ? <EmptyState title="No audit entries" /> : (
        <div className="max-h-96 overflow-y-auto hrms-scroll rounded-lg border border-slate-100">
          <table className="w-full text-[11px] min-w-[720px]">
            <thead className="sticky top-0 bg-white/90 backdrop-blur text-slate-400">
              <tr>
                <th className="text-left px-3 py-2 font-medium">When</th>
                <th className="text-left px-2 py-2 font-medium">Actor</th>
                <th className="text-left px-2 py-2 font-medium">Target</th>
                <th className="text-left px-2 py-2 font-medium">Entity / Field</th>
                <th className="text-left px-2 py-2 font-medium">Change</th>
                <th className="text-left px-3 py-2 font-medium">Reason</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((l) => (
                <tr key={l.id} className="border-t border-slate-50 hover:bg-white/70">
                  <td className="px-3 py-2 text-slate-400 tnum whitespace-nowrap">{dateTimeLabel(l.createdAt)}</td>
                  <td className="px-2 py-2 text-slate-600">{l.actorName ?? 'System'}<span className="block text-[9px] text-slate-400">{l.actorRole?.replaceAll('_', ' ')}</span></td>
                  <td className="px-2 py-2 text-slate-600">{l.targetName ?? '—'}</td>
                  <td className="px-2 py-2"><Pill text={l.entityType} tone="violet" />{l.fieldName ? <span className="block text-[9px] text-slate-400 mt-0.5">{l.fieldName}</span> : null}</td>
                  <td className="px-2 py-2 tnum text-slate-500 max-w-[200px] truncate" title={`${l.oldValue ?? ''} → ${l.newValue ?? ''}`}>{l.oldValue != null ? `${truncate(l.oldValue)} → ` : ''}<b className="text-slate-700">{l.newValue != null ? truncate(l.newValue) : ''}</b></td>
                  <td className="px-3 py-2 text-slate-500 max-w-[220px] truncate" title={l.reason ?? ''}>{l.reason ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </GlassCard>
  )
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function truncate(s: string, n = 26): string {
  return s.length > n ? `${s.slice(0, n)}…` : s
}

function daysLabel(json: string): string {
  try {
    const arr = JSON.parse(json) as number[]
    const names = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
    return arr.map((d) => names[d - 1] ?? d).join(' · ')
  } catch { return json }
}

function LoadingBlock() {
  return (
    <div className="space-y-3">
      {Array.from({ length: 3 }).map((_, i) => <div key={i} className="glass h-16 animate-pulse" />)}
    </div>
  )
}
