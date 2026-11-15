'use client'

import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { api, type SessionUser, type PersonLite, type Notif } from '@/lib/hrms/client'
import { LoginView } from './login'
import { MfaGate } from './mfa-gate'
import { Shell, type ViewKey } from './shell'
import { DashboardView } from './dashboard'
import { MyProfileView } from './my-profile'
import { DirectoryView } from './directory'
import { OrgChartView } from './org-chart'
import { AttendanceView } from './attendance'
import { RequestsView } from './requests'
import { PayrollView } from './payroll'
import { ReportsView } from './reports'
import { RulesView } from './rules'

export function HRMSApp() {
  const [user, setUser] = useState<SessionUser | null>(null)
  const [booting, setBooting] = useState(true)
  const [view, setView] = useState<ViewKey>('dashboard')
  const [people, setPeople] = useState<PersonLite[]>([])
  const [unread, setUnread] = useState(0)
  const [pendingApprovals, setPendingApprovals] = useState(0)
  const [profileTarget, setProfileTarget] = useState<string | null>(null)

  const reloadPeople = useCallback(async () => {
    try {
      const m = await api<{ people: PersonLite[] }>('/api/meta')
      setPeople(m.people)
    } catch { /* keep stale list */ }
  }, [])

  // Global hierarchy navigation: any clickable employee name anywhere opens the 360° profile
  // popup inside the Employee Directory
  useEffect(() => {
    const handler = (e: Event) => {
      const userId = (e as CustomEvent<{ userId: string }>).detail?.userId
      if (!userId) return
      setProfileTarget(`${userId}#${Date.now()}`)
      setView('directory')
    }
    window.addEventListener('hrms:open-profile', handler)
    return () => window.removeEventListener('hrms:open-profile', handler)
  }, [])

  const refreshNotifs = useCallback(async () => {
    try {
      const data = await api<{ items: Notif[]; unread: number }>('/api/notifications')
      setUnread(data.unread)
    } catch { /* ignore */ }
  }, [])

  useEffect(() => {
    ;(async () => {
      try {
        const me = await api<{ user: SessionUser }>('/api/auth/me')
        setUser(me.user)
        const meta = await api<{ people: PersonLite[] }>('/api/meta')
        setPeople(meta.people)
        refreshNotifs()
      } catch { /* not signed in */ } finally {
        setBooting(false)
      }
    })()
  }, [refreshNotifs])

  const refreshDashboardBadge = useCallback(async () => {
    try {
      const d = await api<{ pendingApprovals: number }>('/api/dashboard')
      setPendingApprovals(d.pendingApprovals ?? 0)
    } catch { /* ignore */ }
  }, [])

  useEffect(() => {
    if (user) refreshDashboardBadge()
  }, [user, refreshDashboardBadge])

  function handleLogin(u: SessionUser) {
    setUser(u)
    api<{ people: PersonLite[] }>('/api/meta').then((m) => setPeople(m.people)).catch(() => {})
    refreshNotifs()
    setView('dashboard')
  }

  function handleMfaDone() {
    if (!user) return
    setUser({ ...user, mfaEnabled: true, mfaRequired: true })
  }

  async function handleLogout() {
    try { await api('/api/auth/logout', { method: 'POST', body: '{}' }) } catch { /* ignore */ }
    setUser(null)
    setPeople([])
    setUnread(0)
    setView('dashboard')
    toast('Signed out — session fully revoked.')
  }

  if (booting) {
    return (
      <div className="min-h-screen hrms-canvas flex items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-teal-600 border-t-transparent" />
      </div>
    )
  }

  if (!user) return <LoginView onLogin={handleLogin} />

  // Mandatory TOTP enrollment before the workspace opens
  if (user.mfaRequired && !user.mfaEnabled) {
    return <MfaGate user={user} onDone={handleMfaDone} />
  }

  return (
    <Shell
      user={user}
      view={view}
      onView={setView}
      onLogout={handleLogout}
      people={people}
      unread={unread}
      onRefreshNotifs={refreshNotifs}
      pendingApprovals={pendingApprovals}
    >
      {view === 'dashboard' && <DashboardView user={user} onGoRequests={() => setView('requests')} />}
      {view === 'profile' && <MyProfileView userId={user.id} selfRole={user.role} />}
      {view === 'directory' && <DirectoryView user={user} people={people} initialOpenUserId={profileTarget} onPeopleChanged={reloadPeople} />}
      {view === 'org-chart' && <OrgChartView user={user} />}
      {view === 'attendance' && <AttendanceView user={user} people={people} />}
      {view === 'requests' && <RequestsView user={user} people={people} onApproved={refreshDashboardBadge} />}
      {view === 'payroll' && <PayrollView user={user} people={people} />}
      {view === 'reports' && <ReportsView user={user} people={people} />}
      {view === 'rules' && (user.role === 'SUPER_ADMIN' || user.role === 'HR_MANAGER') && <RulesView user={user} />}
    </Shell>
  )
}
