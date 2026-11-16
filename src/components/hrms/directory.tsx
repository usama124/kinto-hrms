'use client'

import { useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { Search, Users, UserPlus, Building2 } from 'lucide-react'
import { api, ROLE_LABELS, type SessionUser, type PersonLite, avatarSrc } from '@/lib/hrms/client'
import { Avatar, GlassCard, Pill, EmptyState } from './shared'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { ProfileSheet, ROLE_TONE, openProfile } from './profile-sheet'
import { EmployeeFormDialog } from './employee-form'

/**
 * Employee Directory — every person within the viewer's RBAC visibility.
 * Clicking a card opens the 360° popup panel. Admin/HR can onboard new employees here.
 */
export function DirectoryView({ user, people, initialOpenUserId, onPeopleChanged }: {
  user: SessionUser
  people: PersonLite[]
  initialOpenUserId?: string | null
  onPeopleChanged?: () => void
}) {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const isOrgAdmin = user.role === 'SUPER_ADMIN' || user.role === 'HR_MANAGER'

  const list = useMemo(() => people.filter((p) =>
    p.fullName.toLowerCase().includes(query.toLowerCase()) ||
    p.employeeCode.toLowerCase().includes(query.toLowerCase()) ||
    p.designation.toLowerCase().includes(query.toLowerCase()),
  ), [people, query])

  // Open the 360° panel when a global open-profile event targets this view
  const [lastTarget, setLastTarget] = useState<string | null>(null)
  if (initialOpenUserId && initialOpenUserId !== lastTarget) {
    setLastTarget(initialOpenUserId)
    setSelected(initialOpenUserId.split('#')[0])
  }

  return (
    <div className="space-y-4 hrms-enter">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg md:text-xl font-bold text-slate-800">Employee Directory</h1>
          <p className="text-xs text-slate-500 mt-0.5 tnum">
            {isOrgAdmin ? `${list.length} people across the organization` : `${list.length} people in your visibility scope`}
            {' '}— click any card to open the 360° profile panel
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="h-3.5 w-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search name, code, designation…" className="pl-8 w-52 md:w-72 bg-white/70 h-9 text-xs" />
          </div>
          {isOrgAdmin && (
            <Button size="sm" onClick={() => setAddOpen(true)} className="bg-teal-600 hover:bg-teal-700 text-white h-9 text-xs">
              <UserPlus className="h-3.5 w-3.5 mr-1.5" /> Add Employee
            </Button>
          )}
        </div>
      </div>

      {list.length === 0 ? (
        <GlassCard className="p-6"><EmptyState icon={<Users className="h-8 w-8" />} title="No people found" hint="Try a different search." /></GlassCard>
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
          {list.map((p, i) => (
            <motion.button
              key={p.id}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: Math.min(i * 0.03, 0.3) }}
              onClick={() => setSelected(p.id)}
              className="text-left glass glass-hover p-4"
            >
              <div className="flex items-center gap-3">
                <Avatar name={p.fullName} color={p.avatarColor} src={avatarSrc(p)} />
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-slate-800 truncate">{p.fullName}</p>
                  <p className="text-[11px] text-slate-500 truncate">{p.designation}</p>
                </div>
              </div>
              <div className="mt-3 flex items-center justify-between">
                <span className="text-[11px] text-slate-400 tnum">{p.employeeCode}</span>
                <Pill text={ROLE_LABELS[p.role]?.split(' ')[0] ?? p.role} tone={ROLE_TONE[p.role] ?? 'teal'} />
              </div>
            </motion.button>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2 text-[11px] text-slate-400">
        <Building2 className="h-3.5 w-3.5" />
        {isOrgAdmin
          ? 'As Admin / HR you can onboard employees (Add Employee) and edit any profile.'
          : 'Only Admin / HR can add employees or edit profiles. Directory visibility follows your hierarchy.'}
      </div>

      {/* 360° popup panel for other users */}
      <ProfileSheet
        open={!!selected}
        userId={selected}
        selfId={user.id}
        selfRole={user.role}
        onClose={() => setSelected(null)}
        onOpenUser={(id) => setSelected(id)}
        onChanged={onPeopleChanged}
      />

      {/* Admin/HR onboarding dialog */}
      {isOrgAdmin && (
        <EmployeeFormDialog
          open={addOpen}
          onClose={() => setAddOpen(false)}
          onSaved={() => { setAddOpen(false); onPeopleChanged?.() }}
        />
      )}
    </div>
  )
}

// keep the helper exported for other modules
export { openProfile }
