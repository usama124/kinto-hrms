'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Building2, CornerDownRight, Loader2, Pencil, Plus, Trash2, Users } from 'lucide-react'
import { toast } from 'sonner'
import { api, ApiError } from '@/lib/hrms/client'
import { descendantsOf, orderedTree } from '@/lib/hrms/designation-tree'
import { EmptyState, GlassCard, Pill } from './shared'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'

type Dept = {
  id: string; name: string; code: string; description: string | null; isActive: boolean
  managerName: string | null; employeeCount: number; teamCount: number; designationCount: number
}
type Desig = {
  id: string; name: string; description: string | null; departmentId: string; departmentName: string | null
  parentDesignationId: string | null; levelRank: number; isActive: boolean; employeeCount: number
}

const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback)
const SELECT_CLASS = 'w-full h-9 rounded-md border border-slate-200 bg-white/70 px-2 text-xs text-slate-700'

// ─── Department dialog ────────────────────────────────────────────────────────

function DepartmentDialog({ editing, onClose, onSaved }: { editing: Dept | 'new'; onClose: () => void; onSaved: () => void }) {
  const dept = editing === 'new' ? null : editing
  const [name, setName] = useState(dept?.name ?? '')
  const [code, setCode] = useState(dept?.code ?? '')
  const [description, setDescription] = useState(dept?.description ?? '')
  const [isActive, setIsActive] = useState(dept?.isActive ?? true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const valid = name.trim().length >= 2 && /^[A-Z0-9]{2,10}$/.test(code)

  async function save() {
    setBusy(true); setError(null)
    try {
      const body = JSON.stringify({ name, code, description, isActive })
      if (dept) await api(`/api/departments/${dept.id}`, { method: 'PATCH', body })
      else await api('/api/departments', { method: 'POST', body })
      toast.success(dept ? 'Department updated' : 'Department created')
      onSaved()
    } catch (err) {
      const msg = errText(err, 'Could not save the department')
      setError(msg); toast.error(msg)
    } finally { setBusy(false) }
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="sm:max-w-md glass-strong">
        <DialogHeader>
          <DialogTitle className="text-sm">{dept ? `Edit ${dept.name}` : 'Add department'}</DialogTitle>
          <DialogDescription className="text-xs">Departments group designations (and people). Designations are created inside a department.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-1">
          <div className="space-y-1.5"><Label className="text-xs text-slate-600">Name *</Label><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="e.g., Engineering" className="bg-white/70 h-9" /></div>
          <div className="space-y-1.5">
            <Label className="text-xs text-slate-600">Code * (2–10 letters or digits)</Label>
            <Input value={code} onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))} maxLength={10} placeholder="ENG" className="bg-white/70 h-9" />
          </div>
          <div className="space-y-1.5"><Label className="text-xs text-slate-600">Description</Label><Input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} placeholder="What this department does" className="bg-white/70 h-9" /></div>
          <div className="flex items-center gap-2">
            <Switch checked={isActive} onCheckedChange={setIsActive} />
            <Label className="text-xs text-slate-600">Active <span className="text-slate-400">(inactive departments are hidden from pickers; existing people and history are kept)</span></Label>
          </div>
          {error && <p role="alert" className="text-xs text-rose-600">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" disabled={busy || !valid} onClick={save} className="bg-teal-600 hover:bg-teal-700 text-white">
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : null}{dept ? 'Save changes' : 'Create department'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── Designation dialog ───────────────────────────────────────────────────────

function DesignationDialog({ editing, defaultDepartmentId, departments, designations, onClose, onSaved }: {
  editing: Desig | 'new'
  defaultDepartmentId: string
  departments: Dept[]
  designations: Desig[]
  onClose: () => void
  onSaved: () => void
}) {
  const cur = editing === 'new' ? null : editing
  const [name, setName] = useState(cur?.name ?? '')
  const [departmentId, setDepartmentId] = useState(cur?.departmentId ?? defaultDepartmentId)
  const [parentId, setParentId] = useState(cur?.parentDesignationId ?? '')
  const [levelRank, setLevelRank] = useState(cur ? String(cur.levelRank) : '')
  const [description, setDescription] = useState(cur?.description ?? '')
  const [isActive, setIsActive] = useState(cur?.isActive ?? true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Parent choices: same department only, never itself or one of its own descendants (that would be a loop).
  const parentOptions = useMemo(() => {
    const inDept = designations.filter((d) => d.departmentId === departmentId)
    const blocked = cur ? descendantsOf(inDept, cur.id) : new Set<string>()
    return orderedTree(inDept).filter((d) => d.id !== cur?.id && !blocked.has(d.id))
  }, [designations, departmentId, cur])

  const selectableDepartments = departments.filter((d) => d.isActive || d.id === cur?.departmentId)
  const rankOk = levelRank === '' || (Number.isInteger(Number(levelRank)) && Number(levelRank) >= 1 && Number(levelRank) <= 99)
  const valid = name.trim().length >= 2 && !!departmentId && rankOk

  async function save() {
    setBusy(true); setError(null)
    try {
      const body = JSON.stringify({
        name, departmentId, description, isActive,
        parentDesignationId: parentId || null,
        levelRank: levelRank === '' ? undefined : Number(levelRank),
      })
      if (cur) await api(`/api/designations/${cur.id}`, { method: 'PATCH', body })
      else await api('/api/designations', { method: 'POST', body })
      toast.success(cur ? 'Designation updated' : 'Designation created')
      onSaved()
    } catch (err) {
      const msg = errText(err, 'Could not save the designation')
      setError(msg); toast.error(msg)
    } finally { setBusy(false) }
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="sm:max-w-md glass-strong">
        <DialogHeader>
          <DialogTitle className="text-sm">{cur ? `Edit “${cur.name}”` : 'Add designation'}</DialogTitle>
          <DialogDescription className="text-xs">
            Pick the department it belongs to and, optionally, the designation it sits under (for example a Team Lead under an Engineering Manager).
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-1">
          <div className="space-y-1.5"><Label className="text-xs text-slate-600">Name *</Label><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="e.g., Senior Software Engineer" className="bg-white/70 h-9" /></div>
          <div className="space-y-1.5">
            <Label className="text-xs text-slate-600">Department *</Label>
            <select value={departmentId} onChange={(e) => { setDepartmentId(e.target.value); setParentId('') }} className={SELECT_CLASS}>
              <option value="">Select department</option>
              {selectableDepartments.map((d) => <option key={d.id} value={d.id}>{d.name}{d.isActive ? '' : ' (inactive)'}</option>)}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs text-slate-600">Parent designation <span className="text-slate-400">(optional — same department)</span></Label>
            <select value={parentId} onChange={(e) => setParentId(e.target.value)} disabled={!departmentId} className={`${SELECT_CLASS} disabled:opacity-50`}>
              <option value="">None — top level</option>
              {parentOptions.map((d) => <option key={d.id} value={d.id}>{`${'   '.repeat(d.depth)}${d.depth ? '└ ' : ''}${d.name}`}</option>)}
            </select>
            {departmentId && parentOptions.length === 0 && <p className="text-[11px] text-slate-400">This department has no other designations yet, so this one will be top level.</p>}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs text-slate-600">Level rank <span className="text-slate-400">(1 = most senior)</span></Label>
              <Input type="number" min={1} max={99} value={levelRank} onChange={(e) => setLevelRank(e.target.value)} placeholder="Auto" className="bg-white/70 h-9 tnum" />
              {!rankOk && <p className="text-[11px] text-rose-600">Whole number from 1 to 99.</p>}
            </div>
            <div className="flex items-end gap-2 pb-1.5"><Switch checked={isActive} onCheckedChange={setIsActive} /><Label className="text-xs text-slate-600">Active</Label></div>
          </div>
          <div className="space-y-1.5"><Label className="text-xs text-slate-600">Description</Label><Input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} placeholder="Optional" className="bg-white/70 h-9" /></div>
          {error && <p role="alert" className="text-xs text-rose-600">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" disabled={busy || !valid} onClick={save} className="bg-teal-600 hover:bg-teal-700 text-white">
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : null}{cur ? 'Save changes' : 'Create designation'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── One department: header + indented designation tree ───────────────────────

function DepartmentCard({ dept, designations, onAddDesignation, onEditDept, onDeleteDept, onEditDesignation, onDeleteDesignation }: {
  dept: Dept
  designations: Desig[]
  onAddDesignation: () => void
  onEditDept: () => void
  onDeleteDept: () => void
  onEditDesignation: (d: Desig) => void
  onDeleteDesignation: (d: Desig) => void
}) {
  const tree = useMemo(() => orderedTree(designations), [designations])
  return (
    <GlassCard className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Building2 className="h-4 w-4 text-teal-600 shrink-0" />
            <h3 className="text-sm font-bold text-slate-800">{dept.name}</h3>
            <Pill text={dept.code} tone="teal" />
            {!dept.isActive && <Pill text="INACTIVE" tone="amber" />}
          </div>
          {dept.description && <p className="mt-1 text-xs text-slate-500">{dept.description}</p>}
          <p className="mt-1 text-[11px] text-slate-400 tnum">
            {dept.employeeCount} employee(s) · {dept.teamCount} team(s) · {designations.length} designation(s){dept.managerName ? ` · head: ${dept.managerName}` : ''}
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" onClick={onAddDesignation} disabled={!dept.isActive} className="h-8 bg-teal-600 hover:bg-teal-700 text-white text-xs"><Plus className="h-3.5 w-3.5 mr-1" />Add designation</Button>
          <Button size="sm" variant="outline" onClick={onEditDept} className="h-8 text-xs"><Pencil className="h-3.5 w-3.5 mr-1" />Edit</Button>
          <Button size="sm" variant="outline" onClick={onDeleteDept} className="h-8 text-xs text-rose-600 border-rose-200 hover:bg-rose-50"><Trash2 className="h-3.5 w-3.5 mr-1" />Delete</Button>
        </div>
      </div>

      <div className="mt-4">
        {tree.length === 0 ? (
          <p className="rounded-xl border border-dashed border-slate-200 py-5 text-center text-xs text-slate-400">No designations in this department yet.</p>
        ) : (
          <ul className="space-y-1.5">
            {tree.map((d) => (
              <li key={d.id} style={{ marginLeft: d.depth * 24 }} className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-100 bg-white/60 px-3 py-2">
                {d.depth > 0 && <CornerDownRight className="h-3.5 w-3.5 shrink-0 text-slate-300" aria-hidden />}
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`text-sm font-semibold ${d.isActive ? 'text-slate-700' : 'text-slate-400'}`}>{d.name}</span>
                    <Pill text={`L${d.levelRank}`} tone="slate" />
                    {!d.isActive && <Pill text="INACTIVE" tone="amber" />}
                  </div>
                  <p className="text-[11px] text-slate-400">
                    <Users className="mr-1 inline h-3 w-3" />{d.employeeCount} employee(s){d.description ? ` · ${d.description}` : ''}
                  </p>
                </div>
                <Button size="sm" variant="outline" onClick={() => onEditDesignation(d)} className="h-7 text-[11px]"><Pencil className="h-3 w-3 mr-1" />Edit</Button>
                <Button size="sm" variant="outline" onClick={() => onDeleteDesignation(d)} className="h-7 text-[11px] text-rose-600 border-rose-200 hover:bg-rose-50"><Trash2 className="h-3 w-3 mr-1" />Delete</Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </GlassCard>
  )
}

// ─── The tab ──────────────────────────────────────────────────────────────────

/** Departments → designations tree management (System Admin / HR Manager). Starts empty: nothing is pre-seeded. */
export function DesignationManager() {
  const [departments, setDepartments] = useState<Dept[] | null>(null)
  const [designations, setDesignations] = useState<Desig[]>([])
  const [filter, setFilter] = useState('all')
  const [deptDialog, setDeptDialog] = useState<Dept | 'new' | null>(null)
  const [desigDialog, setDesigDialog] = useState<{ editing: Desig | 'new'; departmentId: string } | null>(null)

  const load = useCallback(async () => {
    try {
      const [d, g] = await Promise.all([api<{ departments: Dept[] }>('/api/departments'), api<{ designations: Desig[] }>('/api/designations')])
      setDepartments(d.departments)
      setDesignations(g.designations)
    } catch (err) {
      toast.error(errText(err, 'Failed to load departments and designations'))
      setDepartments((cur) => cur ?? [])
    }
  }, [])
  useEffect(() => { void load() }, [load])

  async function removeDept(d: Dept) {
    if (!window.confirm(`Delete the department “${d.name}”? This cannot be undone.`)) return
    try {
      await api(`/api/departments/${d.id}`, { method: 'DELETE' })
      toast.success('Department deleted')
      if (filter === d.id) setFilter('all')
      await load()
    } catch (err) { toast.error(errText(err, 'Could not delete the department')) }
  }

  async function removeDesig(d: Desig) {
    if (!window.confirm(`Delete the designation “${d.name}”? This cannot be undone.`)) return
    try {
      await api(`/api/designations/${d.id}`, { method: 'DELETE' })
      toast.success('Designation deleted')
      await load()
    } catch (err) { toast.error(errText(err, 'Could not delete the designation')) }
  }

  const afterSave = () => { setDeptDialog(null); setDesigDialog(null); void load() }

  if (!departments) return <div className="space-y-3">{Array.from({ length: 3 }).map((_, i) => <div key={i} className="glass h-24 animate-pulse" />)}</div>

  const shown = filter === 'all' ? departments : departments.filter((d) => d.id === filter)
  const firstActive = departments.find((d) => d.isActive)?.id ?? ''

  return (
    <div className="space-y-4">
      <GlassCard className="p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-700">Departments & designations</h2>
            <p className="text-[11px] text-slate-500">
              Designations belong to a department and can be nested under one another. Employees can only be given a designation defined here.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {departments.length > 1 && (
              <select value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter by department" className="h-8 rounded-md border border-slate-200 bg-white/70 px-2 text-xs text-slate-600">
                <option value="all">All departments</option>
                {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            )}
            <Button size="sm" variant="outline" onClick={() => setDeptDialog('new')} className="h-8 text-xs"><Building2 className="h-3.5 w-3.5 mr-1" />Add department</Button>
            <Button size="sm" onClick={() => setDesigDialog({ editing: 'new', departmentId: filter !== 'all' ? filter : firstActive })} disabled={!departments.some((d) => d.isActive)} className="h-8 bg-teal-600 hover:bg-teal-700 text-white text-xs"><Plus className="h-3.5 w-3.5 mr-1" />Add designation</Button>
          </div>
        </div>
      </GlassCard>

      {departments.length === 0 ? (
        <GlassCard className="p-6">
          <EmptyState
            icon={<Building2 className="h-8 w-8" />}
            title="No departments yet"
            hint="Create a department first, then add its designations (employees pick their designation from here)."
          />
          <div className="flex justify-center"><Button size="sm" onClick={() => setDeptDialog('new')} className="bg-teal-600 hover:bg-teal-700 text-white h-8 text-xs"><Plus className="h-3.5 w-3.5 mr-1" />Create the first department</Button></div>
        </GlassCard>
      ) : (
        shown.map((d) => (
          <DepartmentCard
            key={d.id}
            dept={d}
            designations={designations.filter((x) => x.departmentId === d.id)}
            onAddDesignation={() => setDesigDialog({ editing: 'new', departmentId: d.id })}
            onEditDept={() => setDeptDialog(d)}
            onDeleteDept={() => void removeDept(d)}
            onEditDesignation={(g) => setDesigDialog({ editing: g, departmentId: g.departmentId })}
            onDeleteDesignation={(g) => void removeDesig(g)}
          />
        ))
      )}

      {deptDialog && <DepartmentDialog key={typeof deptDialog === 'string' ? 'new' : deptDialog.id} editing={deptDialog} onClose={() => setDeptDialog(null)} onSaved={afterSave} />}
      {desigDialog && (
        <DesignationDialog
          key={typeof desigDialog.editing === 'string' ? 'new' : desigDialog.editing.id}
          editing={desigDialog.editing}
          defaultDepartmentId={desigDialog.departmentId}
          departments={departments}
          designations={designations}
          onClose={() => setDesigDialog(null)}
          onSaved={afterSave}
        />
      )}
    </div>
  )
}
