'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, UserPlus, Pencil, Lock } from 'lucide-react'
import { toast } from 'sonner'
import { api, ApiError, type Employee360, type Meta } from '@/lib/hrms/client'
import { EMPLOYMENT_STATUSES } from '@/lib/hrms/constants'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

type FormState = {
  fullName: string; email: string; role: string; employeeCode: string; designation: string
  fatherName: string; motherName: string; dateOfBirth: string; gender: string
  maritalStatus: string; bloodGroup: string; religion: string; nationality: string
  cnic: string; cnicExpiry: string; drivingLicense: string; passportNo: string; passportExpiry: string
  phone: string; personalEmail: string; emergencyContactName: string; emergencyContactPhone: string; address: string
  departmentId: string; teamId: string; teamLeadId: string; managerId: string; shiftId: string
  joiningDate: string; employmentStatus: string
  baseSalary: string; hrAllowance: string; utilityAllowance: string; bankName: string; bankIban: string
  isActive: boolean
}

const EMPTY: FormState = {
  fullName: '', email: '', role: 'EMPLOYEE', employeeCode: '', designation: '',
  fatherName: '', motherName: '', dateOfBirth: '', gender: '', maritalStatus: '', bloodGroup: '', religion: 'Islam', nationality: 'Pakistani',
  cnic: '', cnicExpiry: '', drivingLicense: '', passportNo: '', passportExpiry: '',
  phone: '', personalEmail: '', emergencyContactName: '', emergencyContactPhone: '', address: '',
  departmentId: '', teamId: '', teamLeadId: '', managerId: '', shiftId: '',
  joiningDate: '', employmentStatus: 'Permanent',
  baseSalary: '0', hrAllowance: '0', utilityAllowance: '0', bankName: '', bankIban: '',
  isActive: true,
}

const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-']
const GENDERS = ['Male', 'Female']
const MARITAL = ['Single', 'Married', 'Divorced', 'Widowed']
const EMP_STATUSES: readonly string[] = EMPLOYMENT_STATUSES
const ROLE_OPTIONS = [
  { value: 'EMPLOYEE', label: 'Employee', adminOnly: false },
  { value: 'TEAM_LEAD', label: 'Team Lead', adminOnly: false },
  { value: 'MANAGER', label: 'Manager', adminOnly: false },
  { value: 'ACCOUNTANT', label: 'Accountant', adminOnly: false },
  { value: 'ACCOUNTS_MANAGER', label: 'Accounts Head / Manager (finalizes payroll)', adminOnly: true },
  { value: 'HR_MANAGER', label: 'HR Manager', adminOnly: true },
]

// Keep field component identities stable across parent state updates.
function SelectField({ label, value, onChange, placeholder, options }: {
  label: string; value: string; onChange: (v: string) => void; placeholder: string
  options: { value: string; label: string }[]
}) {
  return (
    <div className="space-y-1">
      <Label className="text-[11px] text-slate-500">{label}</Label>
      <Select value={value || '__none'} onValueChange={(v) => onChange(v === '__none' ? '' : v)}>
        <SelectTrigger className="w-full h-9 bg-white/70 text-xs"><SelectValue placeholder={placeholder} /></SelectTrigger>
        <SelectContent className="max-h-64 hrms-scroll">
          <SelectItem value="__none" className="text-xs text-slate-400">— None —</SelectItem>
          {options.map((o) => <SelectItem key={o.value} value={o.value} className="text-xs">{o.label}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
  )
}

function TextField({ label, value, onChange, type = 'text', placeholder, required, disabled }: {
  label: string; value: string; onChange: (v: string) => void
  type?: string; placeholder?: string; required?: boolean; disabled?: boolean
}) {
  return (
    <div className="space-y-1">
      <Label className="text-[11px] text-slate-500">{label}{required ? ' *' : ''}</Label>
      <Input type={type} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} disabled={disabled}
        className="h-9 bg-white/70 text-xs" />
    </div>
  )
}

/**
 * Add / Edit employee dialog — System Admin & HR Manager only (enforced server-side).
 * Add flow: POST /api/employees (auto employee code + leave balances + audit).
 * Edit flow: PATCH /api/employees/[id] (per-field immutable audit diff).
 */
export function EmployeeFormDialog(props: {
  open: boolean
  onClose: () => void
  userId?: string | null // null/undefined → create mode
  onSaved?: () => void
}) {
  const { open, onClose, userId, onSaved } = props
  // A parent rerender may provide a new callback without changing the employee.
  const onCloseRef = useRef(onClose)
  useEffect(() => { onCloseRef.current = onClose }, [onClose])
  const isEdit = !!userId
  const [selfRole, setSelfRole] = useState('')
  const [meta, setMeta] = useState<Meta | null>(null)
  const [form, setForm] = useState<FormState>(EMPTY)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [created, setCreated] = useState<{ name: string; code: string; email: string; password: string } | null>(null)

  const set = (k: keyof FormState) => (v: string | boolean) => setForm((f) => ({ ...f, [k]: v }))

  // load session role + metadata for selects
  useEffect(() => {
    if (!open) return
    setCreated(null)
    api<{ user: { role: string } }>('/api/auth/me')
      .then((m) => setSelfRole(m.user.role))
      .catch(() => setSelfRole(''))
    api<Meta>('/api/meta').then(setMeta).catch(() => setMeta(null))
  }, [open])

  // load target employee in edit mode
  useEffect(() => {
    if (!open) { setForm(EMPTY); return }
    if (isEdit && userId) {
      setLoading(true)
      api<{ employee: Employee360 }>(`/api/employees/${userId}`)
        .then((d) => {
          const e = d.employee
          setForm({
            fullName: e.fullName, email: e.email, role: e.role, employeeCode: e.employeeCode, designation: e.designation,
            fatherName: e.fatherName ?? '', motherName: e.motherName ?? '',
            dateOfBirth: e.dateOfBirth ? e.dateOfBirth.slice(0, 10) : '',
            gender: e.gender ?? '', maritalStatus: e.maritalStatus ?? '', bloodGroup: e.bloodGroup ?? '', religion: e.religion ?? '', nationality: e.nationality ?? '',
            cnic: e.cnic ?? '', cnicExpiry: e.cnicExpiry ?? '', drivingLicense: e.drivingLicense ?? '', passportNo: e.passportNo ?? '', passportExpiry: e.passportExpiry ?? '',
            phone: e.phone ?? '', personalEmail: e.personalEmail ?? '', emergencyContactName: e.emergencyContactName ?? '', emergencyContactPhone: e.emergencyContactPhone ?? '', address: e.address ?? '',
            departmentId: e.departmentId ?? '', teamId: e.teamId ?? '', teamLeadId: e.teamLead?.id ?? '', managerId: e.manager?.id ?? '', shiftId: e.shiftId ?? '',
            joiningDate: e.joiningDate.slice(0, 10), employmentStatus: e.employmentStatus,
            baseSalary: String(e.baseSalary ?? 0), hrAllowance: String(e.hrAllowance ?? 0), utilityAllowance: String(e.utilityAllowance ?? 0),
            bankName: e.bankName ?? '', bankIban: e.bankIban ?? '',
            isActive: e.isActive,
          })
        })
        .catch((err) => { toast.error(err instanceof ApiError ? err.message : 'Failed to load employee'); onCloseRef.current() })
        .finally(() => setLoading(false))
    } else {
      setForm(EMPTY)
    }
  }, [open, isEdit, userId])

  const teams = useMemo(() => (meta?.teams ?? []).filter((t) => !form.departmentId || t.departmentId === form.departmentId), [meta, form.departmentId])
  const people = meta?.people ?? []
  const designationOptions = useMemo(() => {
    const list = meta?.designations ?? []
    const all = form.designation && !list.some((d) => d.toLowerCase() === form.designation.toLowerCase()) ? [form.designation, ...list] : list
    return all.map((d) => ({ value: d, label: d }))
  }, [meta, form.designation])
  const isAdmin = selfRole === 'SUPER_ADMIN'
  const roleOptions = ROLE_OPTIONS.filter((r) => isAdmin || !r.adminOnly)

  async function submit() {
    setSaving(true)
    try {
      const payload: Record<string, unknown> = {
        fullName: form.fullName, email: form.email, role: form.role, designation: form.designation,
        fatherName: form.fatherName || undefined, motherName: form.motherName || undefined,
        dateOfBirth: form.dateOfBirth || undefined,
        gender: form.gender || undefined, maritalStatus: form.maritalStatus || undefined,
        bloodGroup: form.bloodGroup || undefined, religion: form.religion || undefined, nationality: form.nationality || undefined,
        cnic: form.cnic || undefined, cnicExpiry: form.cnicExpiry || undefined,
        drivingLicense: form.drivingLicense || undefined, passportNo: form.passportNo || undefined, passportExpiry: form.passportExpiry || undefined,
        phone: form.phone || undefined, personalEmail: form.personalEmail || undefined,
        emergencyContactName: form.emergencyContactName || undefined, emergencyContactPhone: form.emergencyContactPhone || undefined,
        address: form.address || undefined,
        departmentId: form.departmentId || null, teamId: form.teamId || null,
        teamLeadId: form.teamLeadId || null, managerId: form.managerId || null, shiftId: form.shiftId || null,
        joiningDate: form.joiningDate, employmentStatus: form.employmentStatus,
        baseSalary: Number(form.baseSalary) || 0, hrAllowance: Number(form.hrAllowance) || 0, utilityAllowance: Number(form.utilityAllowance) || 0,
        bankName: form.bankName || undefined, bankIban: form.bankIban || undefined,
      }
      if (isEdit && userId) {
        payload.employeeCode = form.employeeCode
        payload.isActive = form.isActive
        await api(`/api/employees/${userId}`, { method: 'PATCH', body: JSON.stringify(payload) })
        toast.success('Profile updated — changes written to the audit log')
      } else {
        const res = await api<{ employee: { fullName: string; employeeCode: string; email: string }; temporaryPassword: string }>('/api/employees', {
          method: 'POST',
          body: JSON.stringify(payload),
        })
        setCreated({ name: res.employee.fullName, code: res.employee.employeeCode, email: res.employee.email, password: res.temporaryPassword })
        toast.success(`${res.employee.fullName} added (${res.employee.employeeCode})`)
      }
      onSaved?.()
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="sm:max-w-2xl glass-strong max-h-[92vh] overflow-y-auto hrms-scroll">
        <DialogHeader>
          <DialogTitle className="text-sm flex items-center gap-2">
            {isEdit ? <><Pencil className="h-4 w-4 text-teal-600" /> Edit Employee Profile</> : <><UserPlus className="h-4 w-4 text-teal-600" /> Add Employee</>}
            <span className="ml-auto inline-flex items-center gap-1 text-[10px] font-normal text-slate-400">
              <Lock className="h-3 w-3" /> Admin / HR only
            </span>
          </DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-12"><Loader2 className="h-5 w-5 animate-spin text-teal-600" /></div>
        ) : created ? (
          <div className="py-4 space-y-3 text-sm">
            <p className="font-semibold text-slate-700">{created.name} has been onboarded.</p>
            <div className="glass-subtle rounded-lg p-3 text-xs space-y-1.5">
              <p><span className="text-slate-400">Employee Code:</span> <b className="tnum text-slate-700">{created.code}</b> <span className="text-slate-400">(ZKTeco PIN)</span></p>
              <p><span className="text-slate-400">Email:</span> <b className="text-slate-700">{created.email}</b></p>
              <p><span className="text-slate-400">Temporary Password:</span> <b className="tnum text-teal-700">{created.password}</b></p>
              <p className="text-[11px] text-slate-400">This year&apos;s leave balances have been initialized and the onboarding was written to the audit log.</p>
            </div>
            <DialogFooter>
              <Button size="sm" onClick={onClose} className="bg-teal-600 hover:bg-teal-700 text-white h-8 text-xs">Done</Button>
            </DialogFooter>
          </div>
        ) : (
          <Tabs defaultValue="personal" className="mt-1">
            <TabsList className="glass-subtle h-9 p-1 w-full justify-start">
              <TabsTrigger value="personal" className="text-xs h-7 data-[state=active]:bg-teal-600 data-[state=active]:text-white">Personal</TabsTrigger>
              <TabsTrigger value="identity" className="text-xs h-7 data-[state=active]:bg-teal-600 data-[state=active]:text-white">Identity</TabsTrigger>
              <TabsTrigger value="contact" className="text-xs h-7 data-[state=active]:bg-teal-600 data-[state=active]:text-white">Contact</TabsTrigger>
              <TabsTrigger value="job" className="text-xs h-7 data-[state=active]:bg-teal-600 data-[state=active]:text-white">Job & Pay</TabsTrigger>
            </TabsList>

            <TabsContent value="personal" className="mt-3 space-y-3">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <TextField label="Full Name" required value={form.fullName} onChange={set('fullName')} placeholder="e.g., Muhammad Muaz" />
                <SelectField label="Designation *" value={form.designation} onChange={set('designation')} placeholder="Select designation" options={designationOptions} />
                <TextField label="Father Name" value={form.fatherName} onChange={set('fatherName')} />
                <TextField label="Mother Name" value={form.motherName} onChange={set('motherName')} />
                <TextField label="Date of Birth" type="date" value={form.dateOfBirth} onChange={set('dateOfBirth')} />
                <SelectField label="Gender" value={form.gender} onChange={set('gender')} placeholder="Select" options={GENDERS.map((g) => ({ value: g, label: g }))} />
                <SelectField label="Marital Status" value={form.maritalStatus} onChange={set('maritalStatus')} placeholder="Select" options={MARITAL.map((g) => ({ value: g, label: g }))} />
                <SelectField label="Blood Group" value={form.bloodGroup} onChange={set('bloodGroup')} placeholder="Select" options={BLOOD_GROUPS.map((g) => ({ value: g, label: g }))} />
                <TextField label="Religion" value={form.religion} onChange={set('religion')} />
                <TextField label="Nationality" value={form.nationality} onChange={set('nationality')} />
              </div>
            </TabsContent>

            <TabsContent value="identity" className="mt-3 space-y-3">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <TextField label="CNIC" value={form.cnic} onChange={set('cnic')} placeholder="35202-1234567-1" />
                <TextField label="CNIC Expiry" type="date" value={form.cnicExpiry} onChange={set('cnicExpiry')} />
                <TextField label="Driving License No." value={form.drivingLicense} onChange={set('drivingLicense')} />
                <TextField label="Passport No." value={form.passportNo} onChange={set('passportNo')} />
                <TextField label="Passport Expiry" type="date" value={form.passportExpiry} onChange={set('passportExpiry')} />
              </div>
            </TabsContent>

            <TabsContent value="contact" className="mt-3 space-y-3">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <TextField label="Work Email" required type="email" value={form.email} onChange={set('email')} placeholder="name@company.com" />
                <TextField label="Personal Email" type="email" value={form.personalEmail} onChange={set('personalEmail')} />
                <TextField label="Phone" value={form.phone} onChange={set('phone')} placeholder="+92 300 1234567" />
                <TextField label="Emergency Contact Name" value={form.emergencyContactName} onChange={set('emergencyContactName')} />
                <TextField label="Emergency Contact Phone" value={form.emergencyContactPhone} onChange={set('emergencyContactPhone')} />
                <div className="md:col-span-2">
                  <Label className="text-[11px] text-slate-500">Home Address</Label>
                  <Textarea value={form.address} onChange={(e) => set('address')(e.target.value)} placeholder="House, street, block, city" className="bg-white/70 text-xs min-h-[64px]" />
                </div>
              </div>
            </TabsContent>

            <TabsContent value="job" className="mt-3 space-y-3">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <SelectField label="Role" value={form.role} onChange={set('role')} placeholder="Select" options={roleOptions.map((r) => ({ value: r.value, label: r.label }))} />
                <TextField label="Employee Code (ZKTeco PIN)" value={form.employeeCode} onChange={set('employeeCode')} placeholder={isEdit ? '' : 'Auto-generated'} disabled={!isEdit} />
                <SelectField label="Department" value={form.departmentId} onChange={set('departmentId')} placeholder="Select" options={(meta?.departments ?? []).map((d) => ({ value: d.id, label: d.name }))} />
                <SelectField label="Team" value={form.teamId} onChange={set('teamId')} placeholder="Select" options={teams.map((t) => ({ value: t.id, label: t.name }))} />
                <SelectField label="Team Lead (first approver)" value={form.teamLeadId} onChange={set('teamLeadId')} placeholder="Select" options={people.map((p) => ({ value: p.id, label: `${p.fullName} · ${p.designation}` }))} />
                <SelectField label="Manager (second approver)" value={form.managerId} onChange={set('managerId')} placeholder="Select" options={people.map((p) => ({ value: p.id, label: `${p.fullName} · ${p.designation}` }))} />
                <SelectField label="Shift" value={form.shiftId} onChange={set('shiftId')} placeholder="Select" options={(meta?.shifts ?? []).map((s) => ({ value: s.id, label: `${s.name} (${s.startTime}–${s.endTime})` }))} />
                <TextField label="Joining Date" required type="date" value={form.joiningDate} onChange={set('joiningDate')} />
                <SelectField label="Employment Status" value={form.employmentStatus} onChange={set('employmentStatus')} placeholder="Select" options={EMP_STATUSES.map((s) => ({ value: s, label: s }))} />
                <TextField label="Base Salary (PKR)" type="number" value={form.baseSalary} onChange={set('baseSalary')} />
                <TextField label="H/R Allowance (PKR)" type="number" value={form.hrAllowance} onChange={set('hrAllowance')} />
                <TextField label="Utility Allowance (PKR)" type="number" value={form.utilityAllowance} onChange={set('utilityAllowance')} />
                <TextField label="Bank Name" value={form.bankName} onChange={set('bankName')} />
                <TextField label="Bank IBAN" value={form.bankIban} onChange={set('bankIban')} placeholder="PK00XXXX0000000000000000" />
              </div>
              {isEdit && (
                <div className="flex items-center justify-between rounded-lg border border-slate-200 bg-white/60 px-3 py-2.5">
                  <div>
                    <p className="text-xs font-semibold text-slate-700">Account Active</p>
                    <p className="text-[11px] text-slate-400">Deactivating revokes all sessions immediately.</p>
                  </div>
                  <Switch checked={form.isActive} onCheckedChange={(v) => set('isActive')(v)} />
                </div>
              )}
              {!isEdit && (
                <p className="text-[11px] text-slate-400">A temporary password will be assigned and shown after onboarding. Leave balances are initialized automatically.</p>
              )}
            </TabsContent>
          </Tabs>
        )}

        {!created && !loading && (
          <DialogFooter className="mt-2">
            <Button variant="outline" size="sm" onClick={onClose} className="h-8 text-xs">Cancel</Button>
            <Button
              size="sm"
              disabled={saving || !form.fullName.trim() || !form.email.trim() || !form.designation.trim() || !form.joiningDate}
              onClick={submit}
              className="bg-teal-600 hover:bg-teal-700 text-white h-8 text-xs"
            >
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : null}
              {isEdit ? 'Save Changes' : 'Add Employee'}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}
