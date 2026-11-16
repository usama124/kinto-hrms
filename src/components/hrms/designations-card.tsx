'use client'

import { useCallback, useEffect, useState } from 'react'
import { Plus, X } from 'lucide-react'
import { toast } from 'sonner'
import { api, ApiError } from '@/lib/hrms/client'
import { GlassCard, SectionTitle } from './shared'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

type Row = { name: string; count: number }
const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback)

/** Company-defined designation list. Employees can only be given a title from here. */
export function DesignationsCard() {
  const [rows, setRows] = useState<Row[] | null>(null)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try { setRows((await api<{ designations: Row[] }>('/api/designations')).designations) }
    catch (err) { toast.error(errText(err, 'Failed to load designations')); setRows([]) }
  }, [])
  useEffect(() => { void load() }, [load])

  async function add(e: React.FormEvent) {
    e.preventDefault()
    if (name.trim().length < 2) return
    setBusy(true)
    try {
      await api('/api/designations', { method: 'POST', body: JSON.stringify({ name }) })
      toast.success('Designation added')
      setName('')
      await load()
    } catch (err) { toast.error(errText(err, 'Could not add the designation')) } finally { setBusy(false) }
  }

  async function remove(r: Row) {
    if (!window.confirm(`Remove the designation “${r.name}”?`)) return
    try {
      await api('/api/designations', { method: 'DELETE', body: JSON.stringify({ name: r.name }) })
      toast.success('Designation removed')
      await load()
    } catch (err) { toast.error(errText(err, 'Could not remove the designation')) }
  }

  return (
    <GlassCard className="p-5">
      <SectionTitle>Designations</SectionTitle>
      <p className="text-[11px] text-slate-500 mb-3">
        Employees can only be assigned a designation from this list — define it here first. A designation can be removed only when nobody holds it.
      </p>
      <form onSubmit={add} className="flex flex-wrap items-center gap-2 mb-3">
        <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="New designation, e.g., Senior Software Engineer" className="h-8 w-72 max-w-full bg-white/70 text-xs" />
        <Button type="submit" size="sm" disabled={busy || name.trim().length < 2} className="h-8 bg-teal-600 hover:bg-teal-700 text-white text-xs"><Plus className="h-3.5 w-3.5 mr-1" />Add</Button>
      </form>
      {!rows ? <div className="glass h-10 animate-pulse" /> : rows.length === 0 ? (
        <p className="text-xs text-slate-400">No designations yet — add the first one above.</p>
      ) : (
        <div className="flex flex-wrap gap-1.5 max-h-44 overflow-y-auto hrms-scroll">
          {rows.map((r) => (
            <span key={r.name} className="glass-subtle inline-flex items-center gap-1.5 rounded-full pl-2.5 pr-1.5 py-1 text-[11px] text-slate-600">
              {r.name}
              <span className="text-[10px] text-slate-400 tnum">{r.count}</span>
              <button
                type="button" disabled={r.count > 0} onClick={() => void remove(r)}
                title={r.count > 0 ? `${r.count} employee(s) hold this designation` : 'Remove'}
                className="rounded-full p-0.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-slate-400"
                aria-label={`Remove ${r.name}`}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}
    </GlassCard>
  )
}
