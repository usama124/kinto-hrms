'use client'

import { APP_NAME } from '@/lib/hrms/constants'
import { useState } from 'react'
import { motion } from 'framer-motion'
import { Building2, Loader2, ShieldCheck, KeyRound } from 'lucide-react'
import { toast } from 'sonner'
import { api, ApiError, type SessionUser } from '@/lib/hrms/client'
import { GlassCard } from './shared'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

const DEMOS = [
  { label: 'System Admin', email: 'admin@hrms.local', pw: 'Admin@123' },
  { label: 'HR Manager', email: 'hr@hrms.local', pw: 'Hr@123' },
  { label: 'Accountant', email: 'accountant@hrms.local', pw: 'Acc@123' },
  { label: 'Manager', email: 'manager@hrms.local', pw: 'Mgr@123' },
  { label: 'Team Lead', email: 'lead@hrms.local', pw: 'Lead@123' },
  { label: 'Employee', email: 'employee@hrms.local', pw: 'Emp@123' },
]

type LoginResponse = { mfaRequired: boolean; mfaToken?: string; user?: SessionUser }

export function LoginView({ onLogin }: { onLogin: (u: SessionUser) => void }) {
  const [email, setEmail] = useState('hr@hrms.local')
  const [password, setPassword] = useState('Hr@123')
  const [busy, setBusy] = useState(false)
  const [mfaToken, setMfaToken] = useState<string | null>(null)
  const [mfaName, setMfaName] = useState('')
  const [code, setCode] = useState('')
  const [isBackup, setIsBackup] = useState(false)

  async function submit(e?: React.FormEvent, creds?: { email: string; pw: string }) {
    e?.preventDefault()
    setBusy(true)
    try {
      const data = await api<LoginResponse>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email: creds?.email ?? email, password: creds?.pw ?? password }),
      })
      if (data.mfaRequired && data.mfaToken) {
        setMfaToken(data.mfaToken)
        setMfaName(data.user?.fullName ?? '')
        toast.info('Two-factor authentication required')
        return
      }
      if (data.user) {
        toast.success(`Welcome back, ${data.user.fullName}`)
        onLogin(data.user)
      }
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Sign-in failed')
    } finally {
      setBusy(false)
    }
  }

  async function verifyMfa(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    try {
      const data = await api<{ user: SessionUser }>('/api/auth/mfa', {
        method: 'POST',
        body: JSON.stringify({ mfaToken, code, isBackupCode: isBackup }),
      })
      toast.success(`Welcome back, ${data.user.fullName}`)
      onLogin(data.user)
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Invalid code')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="min-h-screen hrms-canvas flex items-center justify-center p-4">
      <motion.div initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }} className="w-full max-w-md">
        <div className="flex items-center justify-center gap-2.5 mb-6">
          <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-teal-600 text-white shadow-lg shadow-teal-600/25">
            <Building2 className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-slate-800 leading-tight">{APP_NAME}</h1>
            <p className="text-[11px] text-slate-500">People · Attendance · Payroll</p>
          </div>
        </div>

        {mfaToken ? (
          <GlassCard strong className="p-6">
            <div className="flex items-center gap-2 mb-1">
              <ShieldCheck className="h-4.5 w-4.5 text-teal-600" />
              <h2 className="text-base font-semibold text-slate-800">Two-factor verification</h2>
            </div>
            <p className="text-xs text-slate-500 mb-5">{mfaName ? `Enter the 6-digit code from your authenticator app for ${mfaName}.` : 'Enter the 6-digit code from your authenticator app.'}</p>
            <form onSubmit={verifyMfa} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="code" className="text-xs text-slate-600">{isBackup ? 'Backup recovery code' : 'Authenticator code'}</Label>
                <Input
                  id="code" value={code} onChange={(e) => setCode(e.target.value)} required autoFocus
                  placeholder={isBackup ? 'XXXXX-XXXXX' : '123456'}
                  className="bg-white/70 text-center text-lg tracking-[0.4em] tnum font-semibold"
                  inputMode={isBackup ? 'text' : 'numeric'}
                  maxLength={isBackup ? 11 : 6}
                />
              </div>
              <Button type="submit" disabled={busy} className="w-full bg-teal-600 hover:bg-teal-700 text-white h-10">
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
                {busy ? 'Verifying…' : 'Verify & sign in'}
              </Button>
              <div className="flex items-center justify-between text-[11px]">
                <button type="button" className="text-teal-700 hover:underline" onClick={() => setIsBackup((v) => !v)}>
                  {isBackup ? 'Use authenticator code instead' : 'Use a backup recovery code'}
                </button>
                <button type="button" className="text-slate-400 hover:underline" onClick={() => { setMfaToken(null); setCode('') }}>
                  Back to sign in
                </button>
              </div>
            </form>
          </GlassCard>
        ) : (
          <GlassCard strong className="p-6">
            <h2 className="text-base font-semibold text-slate-800">Sign in to your workspace</h2>
            <p className="text-xs text-slate-500 mt-0.5 mb-5">Use a demo role below or your credentials. Elevated roles must enroll TOTP MFA at first login.</p>
            <form onSubmit={submit} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="email" className="text-xs text-slate-600">Email</Label>
                <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" required autoComplete="username" className="bg-white/70" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="password" className="text-xs text-slate-600">Password</Label>
                <Input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" required autoComplete="current-password" className="bg-white/70" />
              </div>
              <Button type="submit" disabled={busy} className="w-full bg-teal-600 hover:bg-teal-700 text-white h-10">
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {busy ? 'Signing in…' : 'Sign in'}
              </Button>
            </form>

            <div className="mt-5 border-t border-slate-200/70 pt-4">
              <p className="text-[11px] uppercase tracking-wide text-slate-400 mb-2">Demo roles — one click</p>
              <div className="flex flex-wrap gap-1.5">
                {DEMOS.map((d) => (
                  <button
                    key={d.email}
                    type="button"
                    disabled={busy}
                    onClick={() => { setEmail(d.email); setPassword(d.pw); submit(undefined, d) }}
                    className="glass-subtle px-2.5 py-1.5 text-[11px] font-medium text-slate-600 hover:bg-white hover:text-teal-700 transition-colors disabled:opacity-50"
                  >
                    {d.label}
                  </button>
                ))}
              </div>
            </div>
          </GlassCard>
        )}

        <p className="mt-5 text-center text-[11px] text-slate-400">Glassmorphism + Material 3 · Zero-trust RBAC · TOTP MFA · Biometric sync</p>
      </motion.div>
    </div>
  )
}
