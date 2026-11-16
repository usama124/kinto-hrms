'use client'

import { useState } from 'react'
import { cn } from '@/lib/utils'
import { motion } from 'framer-motion'
import { ATT_BADGE_TONE } from '@/lib/hrms/constants'

const TONE_CLASS: Record<string, string> = {
  emerald: 'bg-emerald-100 text-emerald-700 ring-emerald-600/15',
  amber: 'bg-amber-100 text-amber-800 ring-amber-600/15',
  rose: 'bg-rose-100 text-rose-700 ring-rose-600/15',
  orange: 'bg-orange-100 text-orange-800 ring-orange-600/15',
  slate: 'bg-slate-100 text-slate-600 ring-slate-500/15',
  sky: 'bg-sky-100 text-sky-700 ring-sky-600/15',
  cyan: 'bg-cyan-100 text-cyan-700 ring-cyan-600/15',
  teal: 'bg-teal-100 text-teal-700 ring-teal-600/15',
  violet: 'bg-violet-100 text-violet-700 ring-violet-600/15',
  purple: 'bg-purple-100 text-purple-700 ring-purple-600/15',
  indigo: 'bg-indigo-100 text-indigo-700 ring-indigo-600/15',
}

export function Pill({ text, tone, className }: { text: string; tone?: string; className?: string }) {
  const t = tone ?? ATT_BADGE_TONE[text] ?? 'slate'
  const label = text.replaceAll('_', ' ')
  return (
    <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset whitespace-nowrap tnum', TONE_CLASS[t] ?? TONE_CLASS.slate, className)}>
      {label}
    </span>
  )
}

export function GlassCard({ className, children, strong }: { className?: string; children: React.ReactNode; strong?: boolean }) {
  return <div className={cn(strong ? 'glass-strong' : 'glass', className)}>{children}</div>
}

export function KpiCard({ label, value, sub, icon, accent = 'teal', delay = 0 }: {
  label: string; value: string; sub?: string; icon?: React.ReactNode; accent?: string; delay?: number
}) {
  const ring: Record<string, string> = {
    teal: 'bg-teal-50 text-teal-600', emerald: 'bg-emerald-50 text-emerald-600',
    orange: 'bg-orange-50 text-orange-600', rose: 'bg-rose-50 text-rose-600',
    amber: 'bg-amber-50 text-amber-600', sky: 'bg-sky-50 text-sky-600',
    violet: 'bg-violet-50 text-violet-600', purple: 'bg-purple-50 text-purple-600',
  }
  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay, duration: 0.3, ease: [0.22, 1, 0.36, 1] }}>
      <GlassCard className="p-4 glass-hover">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500 truncate">{label}</p>
            <p className="mt-1.5 text-xl font-bold text-slate-800 tnum">{value}</p>
            {sub ? <p className="mt-0.5 text-[11px] text-slate-400 tnum">{sub}</p> : null}
          </div>
          {icon ? <div className={cn('rounded-xl p-2 shrink-0', ring[accent] ?? ring.teal)}>{icon}</div> : null}
        </div>
      </GlassCard>
    </motion.div>
  )
}

export function SegmentedBar({ segments, height = 'h-2.5' }: {
  segments: { value: number; color: string; label: string }[]
  height?: string
}) {
  const total = segments.reduce((s, x) => s + x.value, 0) || 1
  return (
    <div className={cn('flex w-full overflow-hidden rounded-full bg-slate-100', height)}>
      {segments.filter((s) => s.value > 0).map((s, i) => (
        <div key={i} title={`${s.label}: ${s.value}`} style={{ width: `${(s.value / total) * 100}%`, backgroundColor: s.color }} />
      ))}
    </div>
  )
}

export function ScoreRing({ pct, size = 108, label }: { pct: number; size?: number; label?: string }) {
  const r = (size - 14) / 2
  const c = 2 * Math.PI * r
  const color = pct >= 90 ? '#059669' : pct >= 75 ? '#d97706' : '#e11d48'
  return (
    <div className="relative inline-flex items-center justify-center">
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} strokeWidth={10} className="stroke-slate-100" fill="none" />
        <motion.circle
          cx={size / 2} cy={size / 2} r={r} strokeWidth={10} stroke={color} fill="none" strokeLinecap="round"
          strokeDasharray={c} initial={{ strokeDashoffset: c }} animate={{ strokeDashoffset: c - (c * Math.min(100, pct)) / 100 }}
          transition={{ duration: 1, ease: [0.22, 1, 0.36, 1] }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-2xl font-bold text-slate-800 tnum">{pct}%</span>
        {label ? <span className="text-[10px] uppercase tracking-wide text-slate-400">{label}</span> : null}
      </div>
    </div>
  )
}

export function Avatar({ name, color, size = 'md', src }: { name: string; color: string; size?: 'sm' | 'md' | 'lg' | 'xl'; src?: string | null }) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null) // keyed by src so a NEW picture gets a fresh chance
  const dims = { sm: 'h-7 w-7 text-[10px]', md: 'h-10 w-10 text-xs', lg: 'h-14 w-14 text-base', xl: 'h-24 w-24 text-2xl' }[size]
  // a profile picture when there is one (falls back to initials if it fails to load)
  if (src && src !== failedSrc) {
    return <img src={src} alt={name} onError={() => setFailedSrc(src)} className={cn('rounded-full object-cover shrink-0 shadow-inner bg-slate-100', dims)} />
  }
  const initials = name.split(' ').map((n) => n[0]).slice(0, 2).join('').toUpperCase()
  return (
    <div className={cn('flex items-center justify-center rounded-full font-bold text-white shrink-0 shadow-inner', dims)} style={{ backgroundColor: color }}>
      {initials}
    </div>
  )
}

export function SectionTitle({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 mb-3">
      <h3 className="text-sm font-semibold text-slate-700">{children}</h3>
      {action}
    </div>
  )
}

export function EmptyState({ icon, title, hint }: { icon?: React.ReactNode; title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      {icon ? <div className="mb-3 text-slate-300">{icon}</div> : null}
      <p className="text-sm font-medium text-slate-500">{title}</p>
      {hint ? <p className="mt-1 text-xs text-slate-400">{hint}</p> : null}
    </div>
  )
}

export function KeyValue({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] uppercase tracking-wide text-slate-400">{label}</span>
      <span className={cn('text-sm font-medium text-slate-700', mono && 'tnum')}>{value}</span>
    </div>
  )
}
