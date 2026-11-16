'use client'

import { useState } from 'react'
import { motion } from 'framer-motion'
import { Check, Eye, EyeOff, KeyRound, Loader2, ShieldAlert, X } from 'lucide-react'
import { toast } from 'sonner'
import { api, ApiError } from '@/lib/hrms/client'
import { GlassCard } from './shared'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

// Mirrors passwordPolicyError() in src/lib/hrms/password.ts — the server is the authority, this only guides the user.
const RULES: { label: string; test: (p: string) => boolean }[] = [
  { label: 'At least 10 characters', test: (p) => p.length >= 10 },
  { label: 'An uppercase letter', test: (p) => /[A-Z]/.test(p) },
  { label: 'A lowercase letter', test: (p) => /[a-z]/.test(p) },
  { label: 'A digit', test: (p) => /[0-9]/.test(p) },
  { label: 'A symbol (e.g. ! @ # $)', test: (p) => /[^A-Za-z0-9]/.test(p) },
]

/** Current + new + confirm form. Used by the forced first-login gate and by My Profile → Security. */
export function ChangePasswordForm({ onDone, submitLabel = 'Change password' }: { onDone: () => void; submitLabel?: string }) {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [show, setShow] = useState(false)
  const [busy, setBusy] = useState(false)

  const allRulesMet = RULES.every((r) => r.test(next))
  const matches = next.length > 0 && next === confirm
  const differs = next !== current
  const canSubmit = !busy && current.length > 0 && allRulesMet && matches && differs

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!canSubmit) return
    setBusy(true)
    try {
      await api('/api/auth/password', { method: 'POST', body: JSON.stringify({ currentPassword: current, newPassword: next }) })
      toast.success('Password changed. Other devices were signed out.')
      setCurrent(''); setNext(''); setConfirm('')
      onDone()
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not change the password')
    } finally {
      setBusy(false)
    }
  }

  const type = show ? 'text' : 'password'
  return (
    <form onSubmit={submit} className="space-y-3.5" autoComplete="off">
      <div className="space-y-1.5">
        <Label htmlFor="pw-current" className="text-xs text-slate-600">Current password</Label>
        <Input id="pw-current" type={type} value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required className="bg-white/70" />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="pw-new" className="text-xs text-slate-600">New password</Label>
        <Input id="pw-new" type={type} value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" required className="bg-white/70" />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="pw-confirm" className="text-xs text-slate-600">Confirm new password</Label>
        <Input id="pw-confirm" type={type} value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required className="bg-white/70" />
        {confirm.length > 0 && !matches && <p className="text-[11px] text-rose-600">Passwords do not match.</p>}
        {next.length > 0 && current.length > 0 && !differs && <p className="text-[11px] text-rose-600">The new password must differ from the current one.</p>}
      </div>

      <ul className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1">
        {RULES.map((r) => {
          const met = r.test(next)
          return (
            <li key={r.label} className={`flex items-center gap-1.5 text-[11px] ${met ? 'text-emerald-600' : 'text-slate-400'}`}>
              {met ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />} {r.label}
            </li>
          )
        })}
      </ul>

      <div className="flex items-center justify-between gap-3">
        <button type="button" onClick={() => setShow((v) => !v)} className="inline-flex items-center gap-1 text-[11px] text-slate-500 hover:text-teal-700">
          {show ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />} {show ? 'Hide' : 'Show'} passwords
        </button>
        <Button type="submit" disabled={!canSubmit} className="bg-teal-600 hover:bg-teal-700 text-white h-9">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
          {busy ? 'Saving…' : submitLabel}
        </Button>
      </div>
    </form>
  )
}

/** Full-screen gate shown right after sign-in while the account still has an admin-issued temporary password. */
export function PasswordGate({ fullName, onDone, onLogout }: { fullName: string; onDone: () => void; onLogout: () => void }) {
  return (
    <div className="min-h-screen hrms-canvas flex items-center justify-center p-4">
      <motion.div initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} className="w-full max-w-md">
        <GlassCard strong className="p-6">
          <div className="flex items-center gap-2 mb-1">
            <ShieldAlert className="h-5 w-5 text-amber-500" />
            <h2 className="text-base font-semibold text-slate-800">Choose your own password</h2>
          </div>
          <p className="text-xs text-slate-500 mb-5">
            Welcome{fullName ? `, ${fullName}` : ''}. Your account was created with a temporary password that HR or an administrator
            has seen. Set a private one to continue — nothing else is available until you do.
          </p>
          <ChangePasswordForm onDone={onDone} submitLabel="Set password & continue" />
          <div className="mt-4 text-center">
            <button type="button" onClick={onLogout} className="text-[11px] text-slate-400 hover:underline">Sign out</button>
          </div>
        </GlassCard>
      </motion.div>
    </div>
  )
}
