'use client'

import { useCallback, useEffect, useState } from 'react'
import { Loader2, KeyRound, Plus, ShieldCheck, Smartphone, Trash2, QrCode } from 'lucide-react'
import { toast } from 'sonner'
import { api, ApiError, dateTimeLabel } from '@/lib/hrms/client'
import { Pill } from './shared'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog'

type Device = { id: string; label: string; createdAt: string | null; lastUsedAt: string | null }
type DevicesResponse = { mfaEnabled: boolean; mfaRequired: boolean; authenticators: Device[]; backupCodesRemaining: number }
type EnrollResponse = { id: string; label: string; secret: string; qrDataUrl: string; backupCodes: string[] }

const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback)

/**
 * Registered authenticators for the signed-in user: list, add another, remove one.
 * TOTP is app-agnostic (Google Authenticator, Microsoft Authenticator, Authy, 1Password … all scan the same QR code),
 * so the server cannot tell which app a device is — each one carries a name the user chose.
 */
export function MfaManager() {
  const [data, setData] = useState<DevicesResponse | null>(null)
  const [loading, setLoading] = useState(true)

  // add / enroll
  const [addOpen, setAddOpen] = useState(false)
  const [label, setLabel] = useState('')
  const [password, setPassword] = useState('')
  const [enroll, setEnroll] = useState<EnrollResponse | null>(null)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [freshBackup, setFreshBackup] = useState<string[]>([])

  // remove / disable
  const [removing, setRemoving] = useState<Device | null>(null)
  const [disableOpen, setDisableOpen] = useState(false)
  const [rmPassword, setRmPassword] = useState('')
  const [rmCode, setRmCode] = useState('')

  const load = useCallback(async () => {
    try {
      setData(await api<DevicesResponse>('/api/auth/mfa/devices'))
    } catch (err) {
      toast.error(errText(err, 'Failed to load authenticators'))
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => { void load() }, [load])

  function closeAdd() {
    setAddOpen(false); setEnroll(null); setCode(''); setPassword(''); setLabel('')
  }

  async function startEnroll() {
    setBusy(true)
    try {
      const d = await api<EnrollResponse>('/api/auth/mfa/enroll', {
        method: 'POST',
        body: JSON.stringify({ label: label.trim() || undefined, password: data?.mfaEnabled ? password : undefined }),
      })
      setEnroll(d)
      if (d.backupCodes.length) setFreshBackup(d.backupCodes)
    } catch (err) { toast.error(errText(err, 'Could not start enrollment')) } finally { setBusy(false) }
  }

  async function confirmEnroll() {
    if (!enroll) return
    setBusy(true)
    try {
      await api('/api/auth/mfa/enroll-verify', { method: 'POST', body: JSON.stringify({ id: enroll.id, code }) })
      toast.success(`“${enroll.label}” added — it can now be used at sign-in`)
      closeAdd()
      await load()
    } catch (err) { toast.error(errText(err, 'Invalid code')) } finally { setBusy(false) }
  }

  async function confirmRemove() {
    if (!removing) return
    setBusy(true)
    try {
      await api('/api/auth/mfa/devices', { method: 'DELETE', body: JSON.stringify({ id: removing.id, password: rmPassword, code: rmCode }) })
      toast.success(`“${removing.label}” removed`)
      setRemoving(null); setRmPassword(''); setRmCode('')
      await load()
    } catch (err) { toast.error(errText(err, 'Could not remove the authenticator')) } finally { setBusy(false) }
  }

  async function confirmDisable() {
    setBusy(true)
    try {
      await api('/api/auth/mfa/disable', { method: 'POST', body: JSON.stringify({ password: rmPassword, code: rmCode }) })
      toast.success('MFA disabled — you were signed out everywhere. Sign in again.')
      setDisableOpen(false); setRmPassword(''); setRmCode('')
      window.location.reload()
    } catch (err) { toast.error(errText(err, 'Could not disable MFA')) } finally { setBusy(false) }
  }

  if (loading) return <div className="glass h-24 animate-pulse" />
  if (!data) return <p className="text-xs text-slate-500">Authenticators could not be loaded.</p>

  const only = data.authenticators.length <= 1

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Pill text={data.mfaEnabled ? 'MFA ENABLED' : 'MFA OFF'} tone={data.mfaEnabled ? 'emerald' : 'amber'} />
        {data.mfaEnabled && <span className="text-[11px] text-slate-400 tnum">{data.backupCodesRemaining} backup code(s) left</span>}
      </div>

      {data.mfaEnabled ? (
        <ul className="space-y-2">
          {data.authenticators.map((a) => (
            <li key={a.id} className="glass-subtle rounded-xl p-3 flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-teal-50 text-teal-600 shrink-0"><Smartphone className="h-4 w-4" /></div>
              <div className="min-w-0 flex-1">
                <p className="text-xs font-semibold text-slate-700 truncate">{a.label}</p>
                <p className="text-[10px] text-slate-400">
                  {a.createdAt ? `Added ${dateTimeLabel(a.createdAt)}` : 'Added earlier'} · {a.lastUsedAt ? `last used ${dateTimeLabel(a.lastUsedAt)}` : 'not used yet'}
                </p>
              </div>
              <Button
                size="sm" variant="outline" disabled={only}
                title={only ? 'Your only authenticator — add another one first' : 'Remove this authenticator'}
                onClick={() => setRemoving(a)} className="h-8 px-2 text-rose-600 border-rose-200 hover:bg-rose-50 disabled:opacity-40"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-slate-500">
          {data.mfaRequired ? 'Your role requires TOTP MFA. Enroll an authenticator to secure every login.' : 'MFA is optional for your role but recommended.'}
        </p>
      )}

      <p className="text-[11px] text-slate-400">
        Works with Google Authenticator, Microsoft Authenticator, Authy, 1Password and any other TOTP app. The app can’t be detected
        automatically, so give each one a name you will recognise (for example “Google Authenticator · my phone”).
      </p>

      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => setAddOpen(true)} className="bg-teal-600 hover:bg-teal-700 text-white h-8 text-xs">
          <Plus className="h-3.5 w-3.5 mr-1" /> {data.mfaEnabled ? 'Add authenticator' : 'Enroll authenticator'}
        </Button>
        {data.mfaEnabled && !data.mfaRequired && (
          <Button size="sm" variant="outline" onClick={() => setDisableOpen(true)} className="h-8 text-xs border-slate-200 text-slate-600">Turn MFA off</Button>
        )}
      </div>

      {freshBackup.length > 0 && (
        <div className="glass-subtle rounded-lg p-3">
          <p className="text-[11px] font-semibold text-slate-600 mb-1">Backup recovery codes — shown once, store them safely</p>
          <div className="grid grid-cols-2 gap-1">{freshBackup.map((c) => <code key={c} className="text-[10px] text-center bg-white/70 rounded px-1 py-0.5 tnum">{c}</code>)}</div>
          <button type="button" onClick={() => setFreshBackup([])} className="mt-2 text-[11px] text-teal-700 hover:underline">I have saved them</button>
        </div>
      )}

      {/* Add / enroll */}
      <Dialog open={addOpen} onOpenChange={(o) => { if (!o) closeAdd() }}>
        <DialogContent className="sm:max-w-md glass-strong">
          <DialogHeader>
            <DialogTitle className="text-sm flex items-center gap-1.5"><QrCode className="h-4 w-4 text-teal-600" /> {data.mfaEnabled ? 'Add another authenticator' : 'Enroll your authenticator'}</DialogTitle>
            <DialogDescription className="text-xs">Scan the QR code with your authenticator app, then enter the 6-digit code it shows.</DialogDescription>
          </DialogHeader>
          {!enroll ? (
            <div className="space-y-3 py-1">
              <div className="space-y-1.5">
                <Label className="text-xs text-slate-600">Name this authenticator</Label>
                <Input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={40} placeholder="e.g., Microsoft Authenticator · work phone" className="bg-white/70 h-9" />
              </div>
              {data.mfaEnabled && (
                <div className="space-y-1.5">
                  <Label className="text-xs text-slate-600">Confirm with your account password</Label>
                  <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" className="bg-white/70 h-9" />
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-3 py-1">
              <div className="flex items-center gap-3">
                <img src={enroll.qrDataUrl} alt="TOTP QR code" className="h-32 w-32 rounded-lg border border-slate-200 bg-white p-1.5" />
                <div className="text-xs text-slate-500 space-y-1 min-w-0">
                  <p>Can’t scan? Enter this key manually:</p>
                  <p className="font-mono text-[10px] break-all text-slate-600">{enroll.secret}</p>
                  <button type="button" onClick={() => { void navigator.clipboard?.writeText(enroll.secret); toast.success('Key copied') }} className="text-teal-700 hover:underline">Copy key</button>
                </div>
              </div>
              <Input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="123456" maxLength={6} inputMode="numeric" className="bg-white/70 h-9 text-center tnum tracking-[0.3em]" />
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={closeAdd}>Cancel</Button>
            {!enroll ? (
              <Button size="sm" disabled={busy || (data.mfaEnabled && !password)} onClick={startEnroll} className="bg-teal-600 hover:bg-teal-700 text-white">
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : null} Continue
              </Button>
            ) : (
              <Button size="sm" disabled={busy || code.length !== 6} onClick={confirmEnroll} className="bg-teal-600 hover:bg-teal-700 text-white">
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <ShieldCheck className="h-3.5 w-3.5 mr-1" />} Verify & add
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Remove one / turn MFA off — both need password + proof of possession */}
      <Dialog open={!!removing || disableOpen} onOpenChange={(o) => { if (!o) { setRemoving(null); setDisableOpen(false); setRmPassword(''); setRmCode('') } }}>
        <DialogContent className="sm:max-w-sm glass-strong">
          <DialogHeader>
            <DialogTitle className="text-sm">{removing ? `Remove “${removing.label}”?` : 'Turn multi-factor authentication off?'}</DialogTitle>
            <DialogDescription className="text-xs">
              {removing ? 'Confirm with your password and a current code (or a backup code).' : 'You will be signed out everywhere. Confirm with your password and a current authenticator code.'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-1">
            <Input type="password" value={rmPassword} onChange={(e) => setRmPassword(e.target.value)} placeholder="Account password" autoComplete="current-password" className="bg-white/70 h-9" />
            <Input value={rmCode} onChange={(e) => setRmCode(e.target.value.slice(0, 24))} placeholder={removing ? '6-digit code or backup code' : '6-digit code'} className="bg-white/70 h-9 tnum" />
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => { setRemoving(null); setDisableOpen(false) }}>Cancel</Button>
            <Button size="sm" disabled={busy || !rmPassword || !rmCode} onClick={removing ? confirmRemove : confirmDisable} className="bg-rose-600 hover:bg-rose-700 text-white">
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <KeyRound className="h-3.5 w-3.5 mr-1" />} {removing ? 'Remove' : 'Turn off'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
