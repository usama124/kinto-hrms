'use client'

import { useCallback, useEffect, useState } from 'react'
import { Copy, Fingerprint, KeyRound, Loader2, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { api, ApiError, dateTimeLabel } from '@/lib/hrms/client'
import { Pill } from './shared'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog'

type Device = {
  id: string; name: string; model: string; sn: string; enabled: boolean; createdAt: string | null
  keyPreview: string; lastPunchAt: string | null; punchCount: number
}
type Credentials = { key: string; secret: string }

const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback)
const ENDPOINT = '/api/biometric/zkteco/iclock/cdata'

function CopyRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{label}</p>
      <div className="mt-0.5 flex items-center gap-2">
        <code className="flex-1 break-all rounded bg-white/70 px-2 py-1 text-[11px] text-slate-700">{value}</code>
        <button type="button" onClick={() => { void navigator.clipboard?.writeText(value); toast.success(`${label} copied`) }} className="text-teal-700 hover:text-teal-900" aria-label={`Copy ${label}`}>
          <Copy className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  )
}

/** Attendance device registry: add, rename/edit, enable/disable, rotate secret, remove. Secrets are shown only once. */
export function BiometricDevices() {
  const [devices, setDevices] = useState<Device[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [syncing, setSyncing] = useState(false)

  const [formOpen, setFormOpen] = useState<{ mode: 'add' } | { mode: 'edit'; device: Device } | null>(null)
  const [form, setForm] = useState({ name: '', model: 'ZKTeco K50', sn: '' })
  const [creds, setCreds] = useState<{ title: string; credentials: Credentials } | null>(null)

  const load = useCallback(async () => {
    try {
      const d = await api<{ devices: Device[] }>('/api/biometric/devices')
      setDevices(d.devices)
    } catch (err) {
      toast.error(errText(err, 'Failed to load devices'))
      setDevices([])
    }
  }, [])
  useEffect(() => { void load() }, [load])

  function openAdd() { setForm({ name: '', model: 'ZKTeco K50', sn: '' }); setFormOpen({ mode: 'add' }) }
  function openEdit(d: Device) { setForm({ name: d.name, model: d.model, sn: d.sn }); setFormOpen({ mode: 'edit', device: d }) }

  async function saveForm() {
    if (!formOpen) return
    setBusy(true)
    try {
      if (formOpen.mode === 'add') {
        const r = await api<{ credentials: Credentials }>('/api/biometric/devices', { method: 'POST', body: JSON.stringify(form) })
        setCreds({ title: `Device “${form.name}” added`, credentials: r.credentials })
        toast.success('Device registered')
      } else {
        await api('/api/biometric/devices', { method: 'PATCH', body: JSON.stringify({ id: formOpen.device.id, ...form }) })
        toast.success('Device updated')
      }
      setFormOpen(null)
      await load()
    } catch (err) { toast.error(errText(err, 'Could not save the device')) } finally { setBusy(false) }
  }

  async function toggle(d: Device, enabled: boolean) {
    try {
      await api('/api/biometric/devices', { method: 'PATCH', body: JSON.stringify({ id: d.id, enabled }) })
      toast.success(`${d.name} ${enabled ? 'enabled' : 'disabled'}`)
      await load()
    } catch (err) { toast.error(errText(err, 'Could not change the device')) }
  }

  async function rotate(d: Device) {
    if (!window.confirm(`Rotate the secret of “${d.name}”? The device stops syncing until you enter the new secret on it.`)) return
    try {
      const r = await api<{ credentials: Credentials }>('/api/biometric/devices', { method: 'PATCH', body: JSON.stringify({ id: d.id, rotateSecret: true }) })
      setCreds({ title: `New secret for “${d.name}”`, credentials: r.credentials })
      await load()
    } catch (err) { toast.error(errText(err, 'Could not rotate the secret')) }
  }

  async function remove(d: Device) {
    if (!window.confirm(`Remove “${d.name}”? It will stop syncing immediately. Punches it already sent are kept.`)) return
    try {
      await api('/api/biometric/devices', { method: 'DELETE', body: JSON.stringify({ id: d.id }) })
      toast.success('Device removed')
      await load()
    } catch (err) { toast.error(errText(err, 'Could not remove the device')) }
  }

  async function simulateSync() {
    setSyncing(true)
    try {
      const d = await api<{ dateKey: string; stored: number; duplicates: number; daysRebuilt: number; message?: string }>('/api/biometric/simulate', { method: 'POST', body: '{}' })
      if (d.message) toast.info(d.message)
      else toast.success(`Synced ${d.stored} punches for ${d.dateKey} — ${d.daysRebuilt} day(s) rebuilt, ${d.duplicates} duplicates skipped`)
    } catch (err) { toast.error(errText(err, 'Sync failed')) } finally { setSyncing(false) }
  }

  if (!devices) return <div className="glass h-24 animate-pulse" />

  return (
    <div className="space-y-3">
      {devices.length === 0 ? (
        <p className="text-xs text-slate-500">No attendance device is registered, so nothing can push punches. Add your first device to get its key and secret.</p>
      ) : (
        <ul className="space-y-2">
          {devices.map((d) => (
            <li key={d.id} className="glass-subtle rounded-xl p-3">
              <div className="flex items-start gap-3">
                <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-teal-50 text-teal-600 shrink-0"><Fingerprint className="h-4 w-4" /></div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-xs font-semibold text-slate-700 truncate">{d.name}</p>
                    <Pill text={d.enabled ? 'ENABLED' : 'DISABLED'} tone={d.enabled ? 'emerald' : 'slate'} />
                  </div>
                  <p className="text-[11px] text-slate-500">{d.model}{d.sn ? ` · SN ${d.sn}` : ''} · key <span className="font-mono">{d.keyPreview}</span></p>
                  <p className="text-[10px] text-slate-400 tnum">
                    {d.lastPunchAt ? `Last punch received ${dateTimeLabel(d.lastPunchAt)}` : 'No punches received yet'} · {d.punchCount} punch(es) stored
                  </p>
                </div>
                <Switch checked={d.enabled} onCheckedChange={(v) => void toggle(d, v)} aria-label={`${d.enabled ? 'Disable' : 'Enable'} ${d.name}`} />
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => openEdit(d)}><Pencil className="h-3 w-3 mr-1" />Edit</Button>
                <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => void rotate(d)}><KeyRound className="h-3 w-3 mr-1" />Rotate secret</Button>
                <Button size="sm" variant="outline" className="h-7 text-[11px] text-rose-600 border-rose-200 hover:bg-rose-50" onClick={() => void remove(d)}><Trash2 className="h-3 w-3 mr-1" />Remove</Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={openAdd} className="bg-teal-600 hover:bg-teal-700 text-white h-8 text-xs"><Plus className="h-3.5 w-3.5 mr-1" />Add device</Button>
        <Button size="sm" variant="outline" onClick={simulateSync} disabled={syncing} className="h-8 text-xs">
          {syncing ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <RefreshCw className="h-3.5 w-3.5 mr-1" />} Pull device data now (demo)
        </Button>
      </div>
      <p className="text-[11px] text-slate-400">
        Devices push punches to <code className="text-[10px] bg-slate-100 rounded px-1">{ENDPOINT}</code> signed with HMAC-SHA256. First punch = Check-In, last = Check-Out,
        duplicates are rejected by hash, days with a single punch are flagged MISSING for regularization.
      </p>

      {/* Add / edit */}
      <Dialog open={!!formOpen} onOpenChange={(o) => { if (!o) setFormOpen(null) }}>
        <DialogContent className="sm:max-w-sm glass-strong">
          <DialogHeader>
            <DialogTitle className="text-sm">{formOpen?.mode === 'edit' ? 'Edit device' : 'Add a device'}</DialogTitle>
            {formOpen?.mode === 'add' && <DialogDescription className="text-xs">A key and secret are generated for this device and shown once.</DialogDescription>}
          </DialogHeader>
          <div className="space-y-3 py-1">
            <div className="space-y-1.5"><Label className="text-xs text-slate-600">Name *</Label><Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="e.g., Main entrance" maxLength={60} className="bg-white/70 h-9" /></div>
            <div className="space-y-1.5"><Label className="text-xs text-slate-600">Model</Label><Input value={form.model} onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))} maxLength={60} className="bg-white/70 h-9" /></div>
            <div className="space-y-1.5"><Label className="text-xs text-slate-600">Serial number</Label><Input value={form.sn} onChange={(e) => setForm((f) => ({ ...f, sn: e.target.value }))} placeholder="Printed on the device" maxLength={40} className="bg-white/70 h-9" /></div>
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setFormOpen(null)}>Cancel</Button>
            <Button size="sm" disabled={busy || form.name.trim().length < 2} onClick={saveForm} className="bg-teal-600 hover:bg-teal-700 text-white">
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : null}{formOpen?.mode === 'edit' ? 'Save' : 'Add device'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* One-time credentials */}
      <Dialog open={!!creds} onOpenChange={(o) => { if (!o) setCreds(null) }}>
        <DialogContent className="sm:max-w-lg glass-strong">
          <DialogHeader>
            <DialogTitle className="text-sm">{creds?.title}</DialogTitle>
            <DialogDescription className="text-xs text-amber-700">Copy these now — the secret is not shown again. If you lose it, rotate the secret.</DialogDescription>
          </DialogHeader>
          {creds && (
            <div className="space-y-3 py-1">
              <CopyRow label="Endpoint path" value={ENDPOINT} />
              <CopyRow label="Device key (X-Device-Key)" value={creds.credentials.key} />
              <CopyRow label="HMAC secret" value={creds.credentials.secret} />
              <p className="text-[11px] text-slate-500">
                Sign every request: <code className="text-[10px] bg-slate-100 rounded px-1">X-Device-Sig = hex(HMAC-SHA256(secret, X-Device-Ts + "." + rawBody))</code>,
                where <code className="text-[10px] bg-slate-100 rounded px-1">X-Device-Ts</code> is the current time in Unix milliseconds (±5 min).
              </p>
            </div>
          )}
          <DialogFooter><Button size="sm" onClick={() => setCreds(null)} className="bg-teal-600 hover:bg-teal-700 text-white">I have saved them</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
