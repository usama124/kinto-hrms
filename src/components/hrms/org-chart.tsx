'use client'

import { useCallback, useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { Network, Building2, Users2, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { api, ApiError, ROLE_LABELS, type OrgStructure, type SessionUser } from '@/lib/hrms/client'
import { Avatar, GlassCard, Pill, EmptyState } from './shared'
import { Button } from '@/components/ui/button'
import { ProfileSheet, ROLE_TONE } from './profile-sheet'

type Person = { id: string; fullName: string; designation: string; avatarColor: string; role: string; employeeCode: string }

function PersonChip({ p, onOpen }: { p: Person; onOpen: (id: string) => void }) {
  return (
    <button
      onClick={() => onOpen(p.id)}
      className="inline-flex items-center gap-2 rounded-full bg-white/80 ring-1 ring-inset ring-slate-200 px-2.5 py-1 text-[11px] font-medium text-slate-600 hover:ring-teal-500/40 hover:bg-teal-50/60 transition-colors"
      title={`Open ${p.fullName}'s profile`}
    >
      <Avatar name={p.fullName} color={p.avatarColor} size="sm" />
      <span className="max-w-[150px] truncate">{p.fullName}</span>
      <span className="text-[9px] text-slate-400 tnum">{p.employeeCode}</span>
    </button>
  )
}

function LeadCard({ p, label, onOpen }: { p: Person; label: string; onOpen: (id: string) => void }) {
  return (
    <button
      onClick={() => onOpen(p.id)}
      className="flex items-center gap-2.5 rounded-xl bg-teal-600/10 ring-1 ring-inset ring-teal-600/20 px-3 py-2 hover:bg-teal-600/20 transition-colors text-left"
      title={`Open ${p.fullName}'s profile`}
    >
      <Avatar name={p.fullName} color={p.avatarColor} size="sm" />
      <div className="min-w-0">
        <p className="text-[9px] uppercase tracking-wide text-teal-700/70 font-bold">{label}</p>
        <p className="text-xs font-bold text-slate-700 truncate">{p.fullName}</p>
        <p className="text-[10px] text-slate-400 truncate">{p.designation}</p>
      </div>
    </button>
  )
}

/**
 * Organization Chart — departments → managers → teams → members (click any name to open
 * the 360° popup panel). Hidden entirely for EMPLOYEE (server-side 403 as defense in depth).
 */
export function OrgChartView({ user }: { user: SessionUser }) {
  const [data, setData] = useState<OrgStructure | null>(null)
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const d = await api<OrgStructure>('/api/org-structure')
      setData(d)
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to load org structure')
      setData(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const totalPeople = data?.departments.reduce((s, d) => s + d.users.length, 0) ?? 0

  return (
    <div className="space-y-4 hrms-enter">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg md:text-xl font-bold text-slate-800">Organization Chart</h1>
          <p className="text-xs text-slate-500 mt-0.5">Departments, teams and reporting lines — click any name to open their 360° profile panel.</p>
        </div>
        <Button size="sm" variant="outline" onClick={() => void load()} className="h-9 text-xs">
          <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
        </Button>
      </div>

      {loading && !data ? (
        <div className="grid md:grid-cols-2 gap-3">{Array.from({ length: 2 }).map((_, i) => <div key={i} className="glass h-64 animate-pulse" />)}</div>
      ) : !data || data.departments.length === 0 ? (
        <GlassCard className="p-6"><EmptyState icon={<Network className="h-8 w-8" />} title="No departments configured" hint="Create departments in Rules & Settings → Organization." /></GlassCard>
      ) : (
        <>
          {/* Company root */}
          <GlassCard strong className="p-4 flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-teal-600 text-white shadow-md shadow-teal-600/20">
              <Building2 className="h-5 w-5" />
            </div>
            <div>
              <p className="text-sm font-bold text-slate-800">NovaTech Solutions</p>
              <p className="text-[11px] text-slate-400 tnum">{data.departments.length} departments · {totalPeople} people</p>
            </div>
            <Pill text="HQ — KARACHI" tone="teal" className="ml-auto" />
          </GlassCard>

          <div className="grid lg:grid-cols-2 gap-4">
            {data.departments.map((dept, di) => {
              const unassigned = dept.users.filter((u) => !u.teamId || !dept.teams.some((t) => t.id === u.teamId))
              return (
                <motion.div key={dept.id} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(di * 0.05, 0.25) }}>
                  <GlassCard className="p-4 space-y-3">
                    {/* Department header */}
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2.5">
                        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-slate-100 text-slate-500">
                          <Building2 className="h-4 w-4" />
                        </div>
                        <div>
                          <p className="text-sm font-bold text-slate-800">{dept.name}</p>
                          <p className="text-[10px] text-slate-400 tnum uppercase">{dept.code}</p>
                        </div>
                      </div>
                      <Pill text={`${dept.users.length} PEOPLE`} tone="slate" />
                    </div>

                    {/* Department manager */}
                    {dept.manager ? (
                      <div className="pl-4 border-l-2 border-teal-500/30">
                        <LeadCard p={dept.manager as unknown as Person} label="Department Head" onOpen={setSelected} />
                      </div>
                    ) : null}

                    {/* Teams */}
                    {dept.teams.map((team) => (
                      <div key={team.id} className="rounded-xl bg-slate-50/70 ring-1 ring-inset ring-slate-200/60 p-3 space-y-2">
                        <div className="flex items-center gap-2">
                          <Users2 className="h-3.5 w-3.5 text-slate-400" />
                          <p className="text-xs font-bold text-slate-600">{team.name}</p>
                          <span className="ml-auto text-[10px] text-slate-400 tnum">{team.users.length} members</span>
                        </div>
                        {team.teamLead && <LeadCard p={team.teamLead as unknown as Person} label="Team Lead" onOpen={setSelected} />}
                        <div className="flex flex-wrap gap-1.5">
                          {team.users.map((m) => <PersonChip key={m.id} p={m as unknown as Person} onOpen={setSelected} />)}
                        </div>
                      </div>
                    ))}

                    {/* Members without a team */}
                    {unassigned.length > 0 && (
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-[10px] uppercase tracking-wide text-slate-400 font-bold mr-1">Direct staff</span>
                        {unassigned.map((m) => <PersonChip key={m.id} p={m as unknown as Person} onOpen={setSelected} />)}
                      </div>
                    )}
                  </GlassCard>
                </motion.div>
              )
            })}
          </div>
      {/* People without a department */}
      {(data.unassigned?.length ?? 0) > 0 && (
        <GlassCard className="p-4 space-y-2">
          <div className="flex items-center gap-2">
            <Users2 className="h-3.5 w-3.5 text-slate-400" />
            <p className="text-xs font-bold text-slate-600">No Department Assigned</p>
            <span className="ml-auto text-[10px] text-slate-400 tnum">{data!.unassigned!.length} people</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {data!.unassigned!.map((m) => <PersonChip key={m.id} p={m as unknown as Person} onOpen={setSelected} />)}
          </div>
        </GlassCard>
      )}
        </>
      )}

      {/* 360° popup panel */}
      <ProfileSheet
        open={!!selected}
        userId={selected}
        selfId={user.id}
        selfRole={user.role}
        onClose={() => setSelected(null)}
        onOpenUser={(id) => setSelected(id)}
      />
    </div>
  )
}
