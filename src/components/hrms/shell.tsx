'use client'

import { APP_NAME } from '@/lib/hrms/constants'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { AnimatePresence, motion } from 'framer-motion'
import {
  LayoutDashboard, Users, CalendarClock, Inbox, Wallet, PieChart, SlidersHorizontal,
  Search, Bell, ChevronLeft, LogOut, Building2, CheckCheck, CircleUser, Network,
} from 'lucide-react'
import { toast } from 'sonner'
import { api, ApiError, type SessionUser, type PersonLite, type Notif, dateTimeLabel, avatarSrc } from '@/lib/hrms/client'
import { Avatar, GlassCard, Pill } from './shared'
import { openProfile } from './profile-sheet'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

export type ViewKey = 'dashboard' | 'profile' | 'directory' | 'org-chart' | 'attendance' | 'requests' | 'payroll' | 'reports' | 'rules'

const ALL_ROLES = ['SUPER_ADMIN', 'HR_MANAGER', 'ACCOUNTANT', 'ACCOUNTS_MANAGER', 'MANAGER', 'TEAM_LEAD', 'EMPLOYEE']
const NON_EMPLOYEE = ['SUPER_ADMIN', 'HR_MANAGER', 'ACCOUNTANT', 'ACCOUNTS_MANAGER', 'MANAGER', 'TEAM_LEAD']

export const NAV: { key: ViewKey; label: string; icon: React.ComponentType<{ className?: string }>; roles: string[] }[] = [
  { key: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, roles: ALL_ROLES },
  { key: 'profile', label: 'My Profile', icon: CircleUser, roles: ALL_ROLES },
  { key: 'directory', label: 'Employee Directory', icon: Users, roles: ALL_ROLES },
  { key: 'org-chart', label: 'Org Chart', icon: Network, roles: NON_EMPLOYEE },
  { key: 'attendance', label: 'Attendance', icon: CalendarClock, roles: ALL_ROLES },
  { key: 'requests', label: 'Requests', icon: Inbox, roles: ['SUPER_ADMIN', 'HR_MANAGER', 'MANAGER', 'TEAM_LEAD', 'EMPLOYEE'] }, // accounts roles are barred from leave/regularization server-side,
  { key: 'payroll', label: 'Payroll', icon: Wallet, roles: ['SUPER_ADMIN', 'HR_MANAGER', 'ACCOUNTANT', 'ACCOUNTS_MANAGER'] },
  { key: 'reports', label: 'Reports', icon: PieChart, roles: NON_EMPLOYEE },
  { key: 'rules', label: 'Rules & Settings', icon: SlidersHorizontal, roles: ['SUPER_ADMIN', 'HR_MANAGER'] },
]

export function Shell(props: {
  user: SessionUser
  view: ViewKey
  onView: (v: ViewKey) => void
  onLogout: () => void
  people: PersonLite[]
  unread: number
  onRefreshNotifs: () => void
  children: React.ReactNode
  pendingApprovals?: number
}) {
  const { user, view, onView, onLogout, people, unread, onRefreshNotifs, children } = props
  const [expanded, setExpanded] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [notifOpen, setNotifOpen] = useState(false)
  const [notifs, setNotifs] = useState<Notif[]>([])
  const router = useRouter()

  const nav = useMemo(() => NAV.filter((n) => n.roles.includes(user.role)), [user.role])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen((o) => !o)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  const openNotifs = useCallback(async () => {
    setNotifOpen(true)
    try {
      const data = await api<{ items: Notif[] }>('/api/notifications')
      setNotifs(data.items)
    } catch { /* silent */ }
  }, [])

  const markAll = useCallback(async () => {
    try {
      await api('/api/notifications', { method: 'POST', body: JSON.stringify({ all: true }) })
      setNotifs((ns) => ns.map((n) => ({ ...n, read: true })))
      onRefreshNotifs()
      toast.success('All notifications marked as read')
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed')
    }
  }, [onRefreshNotifs])

  async function logout() {
    try { await api('/api/auth/logout', { method: 'POST' }) } catch { /* ignore */ }
    onLogout()
    router.refresh()
  }

  return (
    <TooltipProvider delayDuration={200}>
      <div className="min-h-screen flex flex-col hrms-canvas">
        {/* Top bar */}
        <header className="sticky top-0 z-40 glass-strong rounded-none border-x-0 border-t-0 px-3 md:px-5 py-2.5">
          <div className="flex items-center gap-3 max-w-[1440px] mx-auto">
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-teal-600 text-white shadow-md shadow-teal-600/20 shrink-0">
                <Building2 className="h-4.5 w-4.5" />
              </div>
              <div className="hidden sm:block min-w-0">
                <p className="text-sm font-bold text-slate-800 leading-tight truncate">{APP_NAME}</p>
                <p className="text-[10px] text-slate-500 truncate">{user.designation} · {user.departmentName}</p>
              </div>
            </div>

            <button
              onClick={() => setPaletteOpen(true)}
              className="ml-auto md:ml-6 flex items-center gap-2 glass-subtle h-9 px-3 text-slate-400 hover:text-slate-600 transition-colors min-w-0"
            >
              <Search className="h-3.5 w-3.5 shrink-0" />
              <span className="hidden md:inline text-xs">Search people, modules…</span>
              <kbd className="hidden md:inline-flex ml-2 items-center rounded border border-slate-200 bg-white/80 px-1.5 py-0.5 text-[10px] font-medium text-slate-400">⌘K</kbd>
            </button>

            <div className="ml-auto flex items-center gap-1.5">
              <button onClick={openNotifs} className="relative glass-subtle h-9 w-9 flex items-center justify-center text-slate-500 hover:text-slate-700 transition-colors" aria-label="Notifications">
                <Bell className="h-4 w-4" />
                {unread > 0 && (
                  <span className="absolute -top-1 -right-1 flex h-4.5 min-w-4.5 px-1 items-center justify-center rounded-full bg-rose-500 text-[9px] font-bold text-white tnum">
                    {unread > 9 ? '9+' : unread}
                  </span>
                )}
              </button>

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button className="flex items-center gap-2 glass-subtle h-9 pl-1.5 pr-2.5 hover:bg-white/90 transition-colors" aria-label="Profile menu">
                    <Avatar name={user.fullName} color={user.avatarColor} size="sm" src={avatarSrc(user)} />
                    <span className="hidden lg:block text-xs font-semibold text-slate-700 max-w-[120px] truncate">{user.fullName}</span>
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  <DropdownMenuLabel className="text-xs">
                    <p className="font-semibold text-slate-700">{user.fullName}</p>
                    <p className="text-[11px] text-slate-400 font-normal">{user.email} · {user.employeeCode}</p>
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => onView('profile')} className="text-xs">My profile</DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={logout} className="text-xs text-rose-600 focus:text-rose-600">
                    <LogOut className="h-3.5 w-3.5 mr-2" /> Sign out
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        </header>

        <div className="flex flex-1 w-full max-w-[1440px] mx-auto">
          {/* Icon rail */}
          <motion.aside
            animate={{ width: expanded ? 200 : 68 }}
            transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
            className="sticky top-[57px] self-start hidden sm:flex flex-col gap-1 py-4 px-2.5 h-[calc(100vh-57px)] shrink-0 border-r border-white/50 z-30"
          >
            {nav.map((n) => {
              const active = view === n.key
              return (
                <Tooltip key={n.key}>
                  <TooltipTrigger asChild>
                    <button
                      onClick={() => onView(n.key)}
                      aria-label={n.label}
                      className={relative(active) ? 'relative flex items-center gap-3 rounded-xl px-3 h-10 w-full text-left transition-colors bg-teal-600 text-white shadow-md shadow-teal-600/20' : 'relative flex items-center gap-3 rounded-xl px-3 h-10 w-full text-left transition-colors text-slate-500 hover:bg-white/80 hover:text-teal-700'}
                      aria-current={active ? 'page' : undefined}
                    >
                      <n.icon className="h-[18px] w-[18px] shrink-0" />
                      <AnimatePresence>
                        {expanded && (
                          <motion.span initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }} className="text-xs font-semibold whitespace-nowrap truncate">
                            {n.label}
                          </motion.span>
                        )}
                      </AnimatePresence>
                      {n.key === 'requests' && (props.pendingApprovals ?? 0) > 0 && (
                        <span className="absolute right-2 top-2 flex h-4 min-w-4 px-1 items-center justify-center rounded-full bg-rose-500 text-[9px] font-bold text-white tnum">{props.pendingApprovals}</span>
                      )}
                    </button>
                  </TooltipTrigger>
                  {!expanded && <TooltipContent side="right" className="text-xs">{n.label}</TooltipContent>}
                </Tooltip>
              )
            })}
            <div className="mt-auto">
              <Tooltip>
                <TooltipTrigger asChild>
                  <button onClick={() => setExpanded((e) => !e)} className="flex items-center gap-3 rounded-xl px-3 h-10 w-full text-left text-slate-400 hover:bg-white/80 hover:text-slate-600 transition-colors" aria-label={expanded ? 'Collapse rail' : 'Expand rail'}>
                    <ChevronLeft className={`h-[18px] w-[18px] transition-transform ${expanded ? '' : 'rotate-180'}`} />
                    {expanded && <span className="text-xs font-medium">Collapse</span>}
                  </button>
                </TooltipTrigger>
                {!expanded && <TooltipContent side="right" className="text-xs">Expand</TooltipContent>}
              </Tooltip>
            </div>
          </motion.aside>

          {/* Mobile nav */}
          <div className="sm:hidden fixed bottom-0 inset-x-0 z-40 glass-strong rounded-none border-x-0 border-b-0 px-1 py-1.5 flex justify-around">
            {nav.slice(0, 6).map((n) => {
              const active = view === n.key
              return (
                <button key={n.key} onClick={() => onView(n.key)} aria-label={n.label} className={`relative flex flex-col items-center gap-0.5 rounded-lg px-2.5 py-1.5 ${active ? 'text-teal-700' : 'text-slate-400'}`}>
                  <n.icon className="h-4.5 w-4.5" />
                  <span className="text-[9px] font-medium">{n.label.split(' ')[0]}</span>
                  {n.key === 'requests' && (props.pendingApprovals ?? 0) > 0 && (
                    <span className="absolute -top-0.5 right-0.5 h-3.5 min-w-3.5 px-0.5 flex items-center justify-center rounded-full bg-rose-500 text-[8px] font-bold text-white tnum">{props.pendingApprovals}</span>
                  )}
                </button>
              )
            })}
          </div>

          {/* Content */}
          <main className="flex-1 min-w-0 px-3 md:px-6 py-4 md:py-6 pb-20 sm:pb-6">
            <AnimatePresence mode="wait">
              <motion.div
                key={view}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
                className="flex-1"
              >
                {children}
              </motion.div>
            </AnimatePresence>
          </main>
        </div>

        {/* Sticky footer */}
        <footer className="mt-auto border-t border-white/50 bg-white/60 backdrop-blur-xl px-4 md:px-6 py-2.5 sm:pl-[84px]">
          <div className="max-w-[1440px] mx-auto flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-400">
            <span>© {new Date().getFullYear()} {APP_NAME} · Glassmorphism + Material 3 HR Suite</span>
            <span className="tnum">Zero-trust RBAC · TOTP MFA · 3-tier approvals · Server-side PDF engine</span>
          </div>
        </footer>

        {/* Cmd+K palette */}
        <CommandDialog open={paletteOpen} onOpenChange={setPaletteOpen}>
          <CommandInput placeholder="Search modules and people…" />
          <CommandList className="hrms-scroll">
            <CommandEmpty>No results found.</CommandEmpty>
            <CommandGroup heading="Navigate">
              {nav.map((n) => (
                <CommandItem key={n.key} onSelect={() => { onView(n.key); setPaletteOpen(false) }}>
                  <n.icon className="h-4 w-4 mr-2 text-slate-400" />
                  {n.label}
                </CommandItem>
              ))}
            </CommandGroup>
            {people.length > 0 && (
              <CommandGroup heading="People">
                {people.slice(0, 12).map((p) => (
                  <CommandItem key={p.id} onSelect={() => { setPaletteOpen(false); openProfile(p.id) }}>
                    <Avatar name={p.fullName} color={p.avatarColor} size="sm" src={avatarSrc(p)} />
                    <span className="ml-2 text-sm">{p.fullName}</span>
                    <span className="ml-auto text-xs text-slate-400 tnum">{p.employeeCode}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </CommandDialog>

        {/* Notifications drawer */}
        <Sheet open={notifOpen} onOpenChange={setNotifOpen}>
          <SheetContent side="right" className="w-full sm:max-w-md p-0 glass-strong">
            <SheetHeader className="px-4 py-3 border-b border-slate-100 flex-row items-center justify-between space-y-0">
              <SheetTitle className="text-sm font-semibold text-slate-700">Notifications</SheetTitle>
              <Button variant="ghost" size="sm" onClick={markAll} className="text-xs text-teal-700 h-8">
                <CheckCheck className="h-3.5 w-3.5 mr-1" /> Mark all read
              </Button>
            </SheetHeader>
            <div className="p-3 space-y-2 max-h-[calc(100vh-64px)] overflow-y-auto hrms-scroll">
              {notifs.length === 0 && <p className="text-center text-xs text-slate-400 py-10">No notifications yet.</p>}
              {notifs.map((n) => (
                <GlassCard key={n.id} className={`p-3 ${n.read ? 'opacity-60' : ''}`}>
                  <div className="flex items-start gap-2">
                    <div className="mt-0.5">
                      <Pill text={n.type === 'APPROVAL' ? 'APPROVED' : n.type === 'ALERT' ? 'ALERT' : n.type === 'PAYROLL' ? 'PAYROLL' : 'INFO'} tone={n.type === 'ALERT' ? 'rose' : n.type === 'PAYROLL' ? 'violet' : n.type === 'APPROVAL' ? 'emerald' : 'sky'} />
                    </div>
                    <div className="min-w-0">
                      <p className="text-xs font-semibold text-slate-700">{n.title}</p>
                      <p className="text-xs text-slate-500 mt-0.5">{n.body}</p>
                      <p className="text-[10px] text-slate-400 mt-1 tnum">{dateTimeLabel(n.createdAt)}</p>
                    </div>
                  </div>
                </GlassCard>
              ))}
            </div>
          </SheetContent>
        </Sheet>
      </div>
    </TooltipProvider>
  )
}

function relative(active: boolean) {
  return active
}
