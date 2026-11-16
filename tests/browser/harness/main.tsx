import { useEffect, useState } from 'react'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { EmployeeFormDialog } from '@/components/hrms/employee-form'
import { LoginView } from '@/components/hrms/login'
import { MfaGate } from '@/components/hrms/mfa-gate'
import { DirectoryView } from '@/components/hrms/directory'
import { AttendanceView } from '@/components/hrms/attendance'
import { RequestsView } from '@/components/hrms/requests'
import { PayrollView } from '@/components/hrms/payroll'
import { ReportsView } from '@/components/hrms/reports'
import { RulesView } from '@/components/hrms/rules'
import { DashboardView } from '@/components/hrms/dashboard'
import { Shell } from '@/components/hrms/shell'
import { ProfileSheet } from '@/components/hrms/profile-sheet'
import { employee, user } from '../fixtures'

// Load styles without the Next server or production API.
import '@/app/globals.css'

const noop = () => {}
function Harness() {
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    const rerender = () => setRevision(value => value + 1)
    window.addEventListener('test:rerender', rerender)
    return () => window.removeEventListener('test:rerender', rerender)
  }, [])
  const view = new URLSearchParams(location.search).get('view')
  const people = [employee]
  const views: Record<string, React.ReactNode> = {
    dashboard: <DashboardView user={{ ...user, role: 'MANAGER' }} onGoRequests={noop} />,
    shell: <Shell user={user} view="dashboard" onView={noop} onLogout={noop} people={people} unread={0} onRefreshNotifs={noop}><div>Test workspace</div></Shell>,
    employee: <EmployeeFormDialog open onClose={noop} onSaved={noop} />,
    edit: <EmployeeFormDialog open userId={employee.id} onClose={() => noop()} onSaved={noop} />,
    login: <LoginView onLogin={noop} />,
    mfa: <MfaGate user={user} onDone={noop} />,
    directory: <DirectoryView user={user} people={people} onPeopleChanged={noop} />,
    attendance: <AttendanceView user={user} people={people} />,
    requests: <RequestsView user={user} people={people} onApproved={noop} />,
    payroll: <PayrollView user={{ ...user, role: 'ACCOUNTANT' }} people={people} />,
    reports: <ReportsView user={user} people={people} />,
    rules: <RulesView user={user} />,
    profile: <ProfileSheet open userId={employee.id} selfId={user.id} selfRole="SUPER_ADMIN" onClose={noop} onOpenUser={noop} />,
  }
  return <div data-revision={revision}>{views[view ?? 'employee']}</div>
}
createRoot(document.getElementById('root')!).render(<Harness />)
