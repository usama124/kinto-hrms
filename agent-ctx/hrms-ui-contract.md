# NovaTech HRMS — Frontend UI Contract (for view subagents)

## Stack & Conventions
- Next.js 16 App Router, React 19, TypeScript strict, Tailwind 4, shadcn/ui (New York), lucide-react icons, framer-motion, recharts, sonner toasts.
- Single-page app: components live in `src/components/hrms/`. NO new routes, NO next/navigation router.push.
- NO emojis. Numbers use `tnum` class. Avoid blue/indigo for primary accents — use teal/slate/emerald/amber/rose/violet.

## Design system (existing, reuse!)
From `./shared.tsx`: `GlassCard` (glass card, optional `strong`), `Pill({text, tone})`, `KpiCard({label,value,sub,icon,accent,delay})`, `ScoreRing({pct,label})`, `SegmentedBar({segments})`, `Avatar({name,color,size})`, `SectionTitle({children,action})`, `EmptyState({icon,title,hint})`, `KeyValue({label,value,mono})`.
CSS classes available: `hrms-canvas` (page bg), `glass`, `glass-strong`, `glass-subtle`, `glass-hover`, `hrms-scroll` (styled scrollbar).

## Client helpers (`@/lib/hrms/client`)
- `api<T>(path, init?)` — JSON fetch, auto session-refresh on 401, throws `ApiError`.
- `downloadFile(path, fallbackName)` — binary download w/ auth retry.
- Formatters: `fmtMinutes(m)` ("8h 30m"), `timeLabel(iso)`, `dayLabel(key)` ("15 Nov"), `fmtDateKey`, `money(n)` ("PKR 12,000"), `money2(n)` ("Rs. 12,000.00"), `dateTimeLabel(iso)`.
- `STATUS_BADGE_TONE` / `ATT_BADGE_TONE` / `REQUEST_TYPE_LABELS` / `ROLE_LABELS` / `STAGE_LABELS` re-exported from constants.

## Key types (client.ts): SessionUser, PersonLite, Meta, DashboardData (kind:'org'|'personal'), UnitStats, RosterMember, RequestRow, AttRequestRow, AttLog, PayslipV2, PayrollRunV2, AuditRow, Balance, Notif.

## API endpoints (all exist and work; roles enforced server-side with 403)
- `GET /api/dashboard?month=` → DashboardData union. kind 'org': `departments[]` (UnitStats + teams), `orgStats`, `trend[]` (day,label,late,short,checkInMin), `pendingApprovals`. kind 'personal': `kpips`{shifts,expectedMinutes,workedMinutes,shortMinutes,leaves,travels,absents,attendanceScore}, `teamOverview[]` (MANAGER/TEAM_LEAD), `todayPunch`, `shift`, `canPunch`, `canCreateRequest`, `leaveSummary[]`, `pendingApprovals`.
- `GET /api/organizations?month=` → `{departments: (UnitStats&{teams})[]}` (SUPER_ADMIN/HR only)
- `GET /api/organizations/:id/teams?month=` → `{teams: (UnitStats&{teamLeadName})[], department}`
- `GET /api/teams/:id?month=` → `{members: RosterMember[], team}`
- `GET /api/requests?type=&status=` → `{requests: RequestRow[]}` PENDING always sorted first
- `POST /api/requests` `{type:'LEAVE'|'OFFICIAL_DUTY'|'TRAVEL', leaveTypeId?, startDate:'YYYY-MM-DD', endDate, isShortLeave?, shortHours?, reason, attachmentId?}` → 422 shows server rule message
- `POST /api/requests/:id/approve {comment}` / `POST /api/requests/:id/reject {comment}` — admin fast-track + TL→Mgr chain
- `GET /api/attendance/requests` → `{requests: AttRequestRow[]}` (3-tier chain TEAM_LEAD→MANAGER→HR)
- `POST /api/attendance/requests` `{date, requestedCheckIn:'HH:mm', requestedCheckOut:'HH:mm', reason}`
- `POST /api/attendance/requests/:id/approve {comment}` / `.../reject {comment}`
- `POST /api/attendance/punch {type:'IN'|'OUT'}`
- `GET /api/attendance?month=&userId=` → `{logs: AttLog[], score|null}` (userId optional; hierarchy enforced)
- `GET /api/employees` → `{employees}`; `GET /api/employees/:id` → 360 profile incl. balances, teamLead/manager `{id,fullName}` clickable
- `GET /api/leave-balances` → balances; `POST /api/leave-balances/adjust {userId,leaveTypeId,year,delta,reason}` (SUPER_ADMIN)
- `GET /api/payroll/runs` (SUPER_ADMIN/ACCOUNTANT/HR read) → `{runs: PayrollRunV2[]}`
- `POST /api/payroll/runs {month:'YYYY-MM'}` → creates run (SUPER_ADMIN/ACCOUNTANT)
- `GET /api/payroll/payslips?month=&userId=` → `{payslips: PayslipV2[]}`
- `GET /api/payroll/payslips/:id/pdf` — detailed salary slip
- `GET /api/payroll/excel?month=` — .xlsx master sheet
- `GET /api/payroll/bulk-pdf?month=` — all slips collection
- `PATCH /api/payroll/salary {userId, baseSalary?, hrAllowance?, utilityAllowance?, reason}` (ACCOUNTANT/SUPER_ADMIN)
- `POST /api/payroll/adjustments {userId, month, bonus, arrears, note}` (ACCOUNTANT/SUPER_ADMIN)
- `GET /api/audit-logs?entityType=&take=` → `{logs: AuditRow[]}` (SUPER_ADMIN/HR)
- `POST /api/biometric/simulate {dateKey?}` → device sync demo (SUPER_ADMIN/HR)
- `GET /api/reports/org?from=&to=`, `GET /api/reports/individual?userId=&from=&to=`
- `GET /api/reports/pdf?type=individual|org|leave-audit|payroll&userId=&from=&to=` (check the actual route file for exact params before wiring)
- `GET /api/rules`, `PUT /api/rules` (SUPER_ADMIN/HR)
- `GET /api/meta` → Meta (people scoped to caller's hierarchy)

## Role strings (use everywhere): SUPER_ADMIN, HR_MANAGER, ACCOUNTANT, MANAGER, TEAM_LEAD, EMPLOYEE.
Rules: SUPER_ADMIN = oversight-only (NO personal punch / NO create-request UI; approvals + org stats only).
ACCOUNTANT = payroll/reports only. isOrgAdmin = SUPER_ADMIN || HR_MANAGER (fast-track approval, adjust attendance, audit logs, rules).

## Rules of engagement
- Rewrite ONLY the files assigned to you (listed in your task). Do NOT touch shared.tsx, shell.tsx, app.tsx, login.tsx, people.tsx, rules.tsx, mfa-gate.tsx, or anything in src/lib, src/app/api.
- Keep components exported with the same names/props as the current file so app.tsx keeps compiling: DashboardView({user, onGoRequests}), AttendanceView({user, people}), RequestsView({user, people, onApproved}), PayrollView({user, people}), ReportsView({user, people}).
- Employee names anywhere (tables, approvals, roster) must be clickable buttons that call `onOpenProfile(userId)` prop if provided — otherwise dispatch `window.dispatchEvent(new CustomEvent('hrms:open-profile', {detail:{userId}}))` which People/global handler will listen for.
- Toast every mutation result (sonner). Loading states with Loader2 spinners or skeletons. Empty states with EmptyState.
- Long lists: max-h + overflow-y-auto + `hrms-scroll`. Cards: `p-4`/`p-6`, `gap-4`/`gap-6`. Responsive grid: `grid-cols-1 sm:grid-cols-2 lg:grid-cols-4`.
- Verify your files type-check logically (imports resolve, types from client.ts). Do NOT run lint/build/dev — the orchestrator does.
