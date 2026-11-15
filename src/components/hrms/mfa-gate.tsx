'use client'

import { useState } from 'react'
import { motion } from 'framer-motion'
import { ShieldCheck, Loader2, Copy, KeyRound } from 'lucide-react'
import { toast } from 'sonner'
import { api, ApiError, type SessionUser } from '@/lib/hrms/client'
import { GlassCard } from './shared'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

/**
 * Forced TOTP enrollment gate — mandatory for SUPER_ADMIN, HR_MANAGER,
 * ACCOUNTANT and MANAGER before the workspace opens.
 */
export function MfaGate({ user, onDone }: { user: SessionUser; onDone: () => void }) {
  const [secret, setSecret] = useState<string | null>(null)
  const [qr, setQr] = useState<string | null>(null)
  const [backupCodes, setBackupCodes] = useState<string[]>([])
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [savedBackup, setSavedBackup] = useState(false)

  async function start() {
    setBusy(true)
    try {
      const data = await api<{ secret: string; qrDataUrl: string; backupCodes: string[] }>('/api/auth/mfa/enroll', { method: 'POST' })
      setSecret(data.secret)
      setQr(data.qrDataUrl)
      setBackupCodes(data.backupCodes)
      setSavedBackup(false)
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Enrollment failed')
    } finally {
      setBusy(false)
    }
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    try {
      await api('/api/auth/mfa/enroll-verify', { method: 'POST', body: JSON.stringify({ code }) })
      toast.success('MFA enabled — your account is now protected.')
      onDone()
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Invalid code')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="min-h-screen hrms-canvas flex items-center justify-center p-4">
      <motion.div initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} className="w-full max-w-lg">
        <div className="flex items-center justify-center gap-2.5 mb-6">
          <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-teal-600 text-white shadow-lg shadow-teal-600/25">
            <ShieldCheck className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-slate-800 leading-tight">Secure your account</h1>
            <p className="text-[11px] text-slate-500">TOTP multi-factor authentication is mandatory for {user.role.replaceAll('_', ' ')} accounts</p>
          </div>
        </div>

        <GlassCard strong className="p-6">
          {!secret ? (
            <div className="space-y-4">
              <p className="text-xs text-slate-500">
                You are required to set up Google Authenticator / Authy before continuing. Scan the QR code with your app, then confirm a live code.
              </p>
              <Button onClick={start} disabled={busy} className="w-full bg-teal-600 hover:bg-teal-700 text-white h-10">
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
                {busy ? 'Provisioning…' : 'Begin MFA enrollment'}
              </Button>
            </div>
          ) : (
            <div className="space-y-5">
              <div className="flex flex-col sm:flex-row items-center gap-4">
                {qr ? (
                  <img src={qr} alt="TOTP QR code" className="h-44 w-44 rounded-xl border border-slate-200 bg-white p-2" />
                ) : null}
                <div className="flex-1 space-y-2 text-xs text-slate-500">
                  <p className="font-semibold text-slate-700 text-sm">1. Scan with your authenticator app</p>
                  <p>Or enter the secret manually:</p>
                  <div className="flex items-center gap-2">
                    <code className="glass-subtle px-2 py-1 rounded text-[11px] font-mono tracking-wider text-slate-700 break-all">{secret}</code>
                    <button
                      type="button"
                      onClick={() => { navigator.clipboard?.writeText(secret); toast.success('Secret copied') }}
                      className="glass-subtle h-7 w-7 flex items-center justify-center text-slate-400 hover:text-teal-700"
                      aria-label="Copy secret"
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              </div>

              <div className="glass-subtle rounded-xl p-3">
                <p className="text-[11px] font-semibold text-slate-600 mb-1.5">2. Save your one-time backup codes</p>
                <div className="grid grid-cols-4 gap-1.5">
                  {backupCodes.map((c) => (
                    <code key={c} className="text-[10px] text-center bg-white/70 rounded px-1 py-0.5 tnum text-slate-600">{c}</code>
                  ))}
                </div>
                <Button
                  variant="ghost" size="sm"
                  className="mt-2 text-[11px] text-teal-700 h-7"
                  onClick={() => { navigator.clipboard?.writeText(backupCodes.join('\n')); setSavedBackup(true); toast.success('Backup codes copied') }}
                >
                  <KeyRound className="h-3 w-3 mr-1" /> {savedBackup ? 'Copied' : 'Copy codes'}
                </Button>
              </div>

              <form onSubmit={verify} className="space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="mfa-code" className="text-xs text-slate-600">3. Enter the current 6-digit code</Label>
                  <Input
                    id="mfa-code" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    placeholder="123456" required autoFocus inputMode="numeric" maxLength={6}
                    className="bg-white/70 text-center text-lg tracking-[0.4em] tnum font-semibold"
                  />
                </div>
                <Button type="submit" disabled={busy || code.length !== 6} className="w-full bg-teal-600 hover:bg-teal-700 text-white h-10">
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
                  Confirm & enter workspace
                </Button>
              </form>
            </div>
          )}
        </GlassCard>
      </motion.div>
    </div>
  )
}
