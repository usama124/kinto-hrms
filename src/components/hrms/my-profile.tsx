'use client'

import { useCallback, useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import {
  User, Fingerprint, Phone, Wallet, IdCard, BadgeCheck, Pencil, CalendarDays,
  ShieldCheck, Users, Camera,
} from 'lucide-react'
import { toast } from 'sonner'
import { api, ApiError, ROLE_LABELS, fmtDateKey, type Employee360, type Balance, avatarSrc } from '@/lib/hrms/client'
import { Avatar, GlassCard, KeyValue, Pill, SegmentedBar, SectionTitle, EmptyState } from './shared'
import { Button } from '@/components/ui/button'
import { EmployeeFormDialog } from './employee-form'
import { ProfileSheet, ROLE_TONE } from './profile-sheet'
import { ChangePasswordForm } from './change-password'
import { ProfilePhotoDialog } from './profile-photo'
import { MfaManager } from './mfa-manager'

function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  try {
    return new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(iso))
  } catch { return iso }
}

/**
 * My Profile — the signed-in user's own profile, rendered as a FULL PAGE.
 * Only Admin / HR can edit (server-side enforced); everyone else sees read-only details.
 */
export function MyProfileView({ userId, selfRole, onSelfUpdated }: { userId: string; selfRole: string; onSelfUpdated?: () => void }) {
  const [employee, setEmployee] = useState<Employee360 | null>(null)
  const [balances, setBalances] = useState<Balance[]>([])
  const [loading, setLoading] = useState(true)
  const [editOpen, setEditOpen] = useState(false)
  const [sheetUser, setSheetUser] = useState<string | null>(null)
  const [photoOpen, setPhotoOpen] = useState(false)

  // own profile: only the System Admin edits it (an HR Manager's record is changed by the System Admin — enforced server-side)
  const canEdit = selfRole === 'SUPER_ADMIN'

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const d = await api<{ employee: Employee360; balances: Balance[] }>(`/api/employees/${userId}`)
      setEmployee(d.employee)
      setBalances(d.balances)
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to load your profile')
    } finally {
      setLoading(false)
    }
  }, [userId])

  useEffect(() => { void load() }, [load])

  if (loading || !employee) {
    return (
      <div className="space-y-3">
        <div className="glass h-28 animate-pulse" />
        <div className="grid md:grid-cols-2 gap-3">{Array.from({ length: 4 }).map((_, i) => <div key={i} className="glass h-40 animate-pulse" />)}</div>
      </div>
    )
  }

  const e = employee

  return (
    <div className="space-y-4 hrms-enter">
      {/* Hero header */}
      <GlassCard strong className="p-5 md:p-6">
        <div className="flex flex-col sm:flex-row sm:items-center gap-4">
          <Avatar name={e.fullName} color={e.avatarColor} size="xl" src={avatarSrc(e)} />
          <div className="min-w-0 flex-1">
            <h1 className="text-xl font-bold text-slate-800">{e.fullName}</h1>
            <p className="text-xs text-slate-500 mt-0.5">{e.designation} · {e.departmentName}{e.teamName ? ` · ${e.teamName}` : ''}</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <Pill text={e.employeeCode} tone="teal" />
              <Pill text={ROLE_LABELS[e.role] ?? e.role} tone={ROLE_TONE[e.role] ?? 'slate'} />
              <Pill text={e.employmentStatus} tone="emerald" />
              <Pill text="MFA PROTECTED" tone="violet" />
            </div>
          </div>
          <div className="flex flex-col items-start sm:items-end gap-2">
            {canEdit ? (
              <>
                <Button size="sm" onClick={() => setEditOpen(true)} className="bg-teal-600 hover:bg-teal-700 text-white h-9 text-xs">
                  <Pencil className="h-3.5 w-3.5 mr-1.5" /> Edit Profile
                </Button>
                <Button size="sm" variant="outline" onClick={() => setPhotoOpen(true)} className="h-9 text-xs">
                  <Camera className="h-3.5 w-3.5 mr-1.5" /> Change photo
                </Button>
              </>
            ) : (
              // every employee can change their OWN picture here; the rest of the profile stays with HR / Admin
              <Button size="sm" onClick={() => setPhotoOpen(true)} className="bg-teal-600 hover:bg-teal-700 text-white h-9 text-xs">
                <Pencil className="h-3.5 w-3.5 mr-1.5" /> Edit Profile
              </Button>
            )}
            <p className="text-[11px] text-slate-400 flex items-center gap-1 max-w-[260px] sm:text-right">
              <ShieldCheck className="h-3.5 w-3.5 text-teal-500 shrink-0" /> {canEdit ? 'Only Admin / HR can edit profile details' : 'You can change your profile picture; other details are maintained by HR / Admin'}
            </p>
          </div>
        </div>
        <div className="mt-4">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[11px] uppercase tracking-wide text-slate-400">Profile Completion</span>
            <span className="text-xs font-bold text-slate-600 tnum">{e.completionPct}%</span>
          </div>
          <SegmentedBar segments={[{ value: e.completionPct, color: '#0d9488', label: 'Complete' }, { value: 100 - e.completionPct, color: '#e2e8f0', label: 'Missing' }]} />
        </div>
      </GlassCard>

      {/* Reporting line */}
      <div className="grid md:grid-cols-2 gap-4">
        <GlassCard className="p-4">
          <SectionTitle><span className="inline-flex items-center gap-1.5"><Users className="h-4 w-4 text-teal-600" /> Reporting Line</span></SectionTitle>
          <div className="flex flex-wrap items-center gap-2">
            {e.teamLead ? (
              <button
                onClick={() => setSheetUser(e.teamLead!.id)}
                className="inline-flex items-center gap-2 rounded-full bg-teal-100/70 ring-1 ring-inset ring-teal-600/15 px-3 py-1.5 text-xs font-semibold text-teal-800 hover:bg-teal-100 transition-colors"
              >
                <BadgeCheck className="h-3.5 w-3.5" /> Team Lead · {e.teamLead.fullName}
              </button>
            ) : <span className="text-xs text-slate-400">No Team Lead assigned</span>}
            {e.manager ? (
              <button
                onClick={() => setSheetUser(e.manager!.id)}
                className="inline-flex items-center gap-2 rounded-full bg-orange-100/70 ring-1 ring-inset ring-orange-600/15 px-3 py-1.5 text-xs font-semibold text-orange-800 hover:bg-orange-100 transition-colors"
              >
                <BadgeCheck className="h-3.5 w-3.5" /> Manager · {e.manager.fullName}
              </button>
            ) : <span className="text-xs text-slate-400">No Manager assigned</span>}
          </div>
        </GlassCard>

        <GlassCard className="p-4">
          <SectionTitle><span className="inline-flex items-center gap-1.5"><CalendarDays className="h-4 w-4 text-teal-600" /> Leave Balances (this year)</span></SectionTitle>
          {balances.length === 0 ? <EmptyState title="No balances yet" /> : (
            <div className="space-y-2.5">
              {balances.map((b) => (
                <div key={b.leaveTypeId}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-semibold text-slate-600">{b.name}</span>
                    <span className="text-[11px] text-slate-400 tnum">{b.available} of {b.total} available</span>
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
        </GlassCard>
      </div>

      {/* Detail sections */}
      <div className="grid md:grid-cols-2 gap-4">
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 }}>
          <GlassCard className="p-4 h-full">
            <SectionTitle><span className="inline-flex items-center gap-1.5"><User className="h-4 w-4 text-teal-600" /> Personal Information</span></SectionTitle>
            <div className="grid grid-cols-2 gap-x-4 gap-y-3">
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
        </motion.div>

        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}>
          <GlassCard className="p-4 h-full">
            <SectionTitle><span className="inline-flex items-center gap-1.5"><Fingerprint className="h-4 w-4 text-teal-600" /> Identity & Documents</span></SectionTitle>
            <div className="grid grid-cols-2 gap-x-4 gap-y-3">
              <KeyValue label="CNIC" value={e.cnic ?? '—'} mono />
              <KeyValue label="CNIC Expiry" value={e.cnicExpiry ?? '—'} mono />
              <KeyValue label="Driving License" value={e.drivingLicense ?? '—'} mono />
              <KeyValue label="Passport No." value={e.passportNo ?? '—'} mono />
              <KeyValue label="Passport Expiry" value={e.passportExpiry ?? '—'} mono />
              <KeyValue label="Employee Code" value={e.employeeCode} mono />
            </div>
          </GlassCard>
        </motion.div>

        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 }}>
          <GlassCard className="p-4 h-full">
            <SectionTitle><span className="inline-flex items-center gap-1.5"><Phone className="h-4 w-4 text-teal-600" /> Contact & Address</span></SectionTitle>
            <div className="grid grid-cols-2 gap-x-4 gap-y-3">
              <KeyValue label="Work Email" value={e.email} />
              <KeyValue label="Personal Email" value={e.personalEmail ?? '—'} />
              <KeyValue label="Phone" value={e.phone ?? '—'} mono />
              <KeyValue label="Emergency Contact" value={e.emergencyContactName ?? '—'} />
              <KeyValue label="Emergency Phone" value={e.emergencyContactPhone ?? '—'} mono />
              <KeyValue label="Home Address" value={e.address ?? '—'} />
            </div>
          </GlassCard>
        </motion.div>

        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }}>
          <GlassCard className="p-4 h-full">
            <SectionTitle><span className="inline-flex items-center gap-1.5"><Wallet className="h-4 w-4 text-teal-600" /> Employment & Compensation</span></SectionTitle>
            <div className="grid grid-cols-2 gap-x-4 gap-y-3">
              <KeyValue label="Joining Date" value={fmtDateKey(e.joiningDate.slice(0, 10))} mono />
              <KeyValue label="Employment Status" value={e.employmentStatus} />
              <KeyValue label="Shift" value={e.shiftTime ? `${e.shiftName} · ${e.shiftTime}` : '—'} />
              <KeyValue label="Team" value={e.teamName ?? '—'} />
              <KeyValue label="Base Salary" value={e.canSeeSalary && e.baseSalary ? `PKR ${e.baseSalary.toLocaleString()}` : '—'} mono />
              <KeyValue label="Allowances" value={e.canSeeSalary && e.allowances ? `PKR ${e.allowances.toLocaleString()}` : '—'} mono />
              <KeyValue label="Bank" value={e.canSeeSalary ? (e.bankName ?? '—') : '—'} />
              <KeyValue label="IBAN" value={e.canSeeSalary ? (e.bankIban ?? '—') : '—'} mono />
            </div>
          </GlassCard>
        </motion.div>
      </div>

      {e.directs.length > 0 && (
        <GlassCard className="p-4">
          <SectionTitle>Direct Reports ({e.directs.length}) — click to open their 360° panel</SectionTitle>
          <div className="grid sm:grid-cols-2 md:grid-cols-3 gap-2">
            {e.directs.map((d) => (
              <button key={d.id} onClick={() => setSheetUser(d.id)} className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 hover:bg-white/80 transition-colors text-left glass-subtle">
                <Avatar name={d.fullName} color={d.avatarColor} size="sm" src={avatarSrc(d)} />
                <div className="min-w-0">
                  <p className="text-xs font-medium text-slate-700 truncate">{d.fullName}</p>
                  <p className="text-[10px] text-slate-400 truncate">{d.designation}</p>
                </div>
              </button>
            ))}
          </div>
        </GlassCard>
      )}

      <div className="grid lg:grid-cols-2 gap-3">
        <GlassCard className="p-4">
          <SectionTitle><span className="inline-flex items-center gap-1.5"><ShieldCheck className="h-4 w-4 text-teal-600" /> Security — change password</span></SectionTitle>
          <p className="text-xs text-slate-500 mb-3">Changing your password signs you out of every other device.</p>
          <div className="max-w-md"><ChangePasswordForm onDone={() => undefined} /></div>
        </GlassCard>
        <GlassCard className="p-4">
          <SectionTitle><span className="inline-flex items-center gap-1.5"><ShieldCheck className="h-4 w-4 text-teal-600" /> Multi-factor authentication</span></SectionTitle>
          <MfaManager />
        </GlassCard>
      </div>

      <div className="flex items-center gap-2 text-[11px] text-slate-400">
        <IdCard className="h-3.5 w-3.5" /> Your details are maintained by HR — requests for corrections go to your HR Manager.
      </div>

      {/* Admin/HR editing their own or anyone's profile */}
      {canEdit && (
        <EmployeeFormDialog
          open={editOpen}
          onClose={() => setEditOpen(false)}
          userId={e.id}
          onSaved={() => { setEditOpen(false); void load() }}
        />
      )}

      <ProfilePhotoDialog
        open={photoOpen}
        onClose={() => setPhotoOpen(false)}
        person={e}
        onChanged={() => { void load(); onSelfUpdated?.() }}
      />

      {/* Viewing other people's profiles opens in the 360° popup panel */}
      <ProfileSheet
        open={!!sheetUser}
        userId={sheetUser}
        selfId={userId}
        selfRole={selfRole}
        onClose={() => setSheetUser(null)}
        onOpenUser={(id) => setSheetUser(id)}
        onChanged={load}
      />
    </div>
  )
}
