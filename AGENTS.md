# Repository context and working guidance

Inspected 2026-11-16. This document describes the working tree, not a production deployment certification. No application changes were made during this analysis. Confirm the intended next task with the user before implementation.

## Architecture and data flow

This is a full-stack HRMS in one Next.js App Router application, not separate frontend/backend services. `src/app/layout.tsx` supplies fonts, global CSS and Sonner; `src/app/page.tsx` renders the client-side `HRMSApp` in `src/components/hrms/app.tsx`. Login, MFA enrollment and the authenticated workspace are conditional render branches. Workspace navigation uses React `view` state and `Shell`/`ViewKey`, not separate page URLs. A browser `hrms:open-profile` custom event navigates employee links to the directory profile sheet.

State is mainly local `useState`, effects and callbacks. `src/lib/hrms/client.ts` contains DTO types, formatters, JSON `api<T>` and binary downloads. It retries once after a 401 using a shared in-flight refresh promise. Installed Zustand and React Query are not wired into the inspected app; do not assume a global store/cache provider exists.

Typical flow: component → same-origin `/api/...` fetch → `src/proxy.ts` throttling/security headers → route handler → session/role/hierarchy checks → domain helpers → shared Prisma client → database → JSON DTO → component state/toast. Authentication is enforced in handlers, not centrally by the proxy. Most handlers use `guard`, `requireSession`, `ok` and `fail` from `api-utils.ts`; resource scoping lives in `rbac.ts`.

Directory map:
- `src/app/api`: auth/MFA, employees, organization/teams/shifts, attendance, requests, balances, payroll, reports, policy/settings, notifications, audit, uploads and biometric ingestion.
- `src/components/hrms`: feature views and shared HR UI; `src/components/ui`: shadcn/Radix primitives; `src/hooks`: reusable UI hooks.
- `src/lib/hrms`: policy, RBAC, attendance/regularization, biometric ingestion, payroll, exports, date/security/client helpers. `src/lib/auth.ts` handles password/JWT sessions; `src/lib/db.ts` owns Prisma.
- `prisma`: schema and destructive demo seed; `scripts/backfill-profiles.mjs`: demo profile mutation script.
- `uploads`: local attachment bytes; database `Upload` records own metadata. Filesystem and DB writes are not one transaction.
- `db/custom.db`: tracked legacy SQLite artifact. `examples/websocket`: examples, not evidence of a running websocket service. `mini-services` is empty in this checkout.
- `tests`: deployment shell checks, not HRMS unit/integration tests. `agent-ctx/hrms-ui-contract.md`: useful historical UI contract; verify endpoint claims against source. Its assignment-specific restrictions are historical, not blanket ownership rules.

### Domain storage and flows

The schema defines Department/Team/Shift/Holiday/Setting; User with department/team, manager and team-lead self-relations; LeaveType/LeaveBalance; Request/ApprovalLog; AttendanceLog/BreakLog/AttendanceAudit/AttendanceRequest/AttendanceApproval; BiometricPunch; PolicyRule; PayrollRun/Payslip/Loan/MonthlyAdjustment; RefreshToken/Upload/Notification/AuditLog.

IDs generally use Prisma cuid defaults. Roles/statuses and several structured settings are strings/JSON-encoded strings rather than database enums/JSON schemas. Unique keys include user+leave type+year balances, user+date attendance, month payroll runs and run+user payslips. Monetary values are `Float`, so rounding/precision needs deliberate verification.

Leave approvals follow assigned team lead → manager, with HR fallback and org-admin fast-track. Attendance regularization adds an HR stage. Approval handlers update status, balances, notifications and audit records through multiple writes; these are not uniformly transactional and are sensitive to retries/concurrency.

Attendance resolves shifts user → team → department → default, excludes holidays/rest days, and derives worked/short/late/early minutes. Use `dates.ts` for Asia/Karachi date keys and time conversion. ZKTeco device pushes are key/HMAC authenticated; ingestion persists punches and rebuilds daily attendance. The simulate endpoint is a separate privileged demo surface.

Payroll routes use `payroll-v2.ts` for shift-aware working days, leave/short-hour conversion, earnings, loan installments, PF/EOBI and configurable tax slabs. Run+payslip creation is transactional; calculations precede that transaction and audit follows it. Payslips snapshot employee/calculation data. PDF generation uses jsPDF/autotable helpers; Excel exports use ExcelJS. Preserve existing snapshot/finalization semantics and assess the older `payroll.ts` before changing shared calculations.

## Stack, dependencies and execution

Manifest ranges: Next `^16.1.1`, React/React DOM `^19.0.0`, TypeScript `^5`, Prisma/client `^6.11.1`, Tailwind `^4`, ESLint `^9`. The manifest does not pin an engines field or packageManager. Both `bun.lock` and an existing untracked `package-lock.json` are present; choose a package-manager policy before dependency updates. Host observations were Node 18.19.1 and Bun 1.4.4; these are not supported-version declarations. Check installed Next engine requirements before attempting Node-based execution.

Tailwind runs through `@tailwindcss/postcss`; global CSS supplies HRMS design tokens. shadcn New York/Radix provide UI primitives; Lucide icons, Framer Motion, Recharts and Sonner support views. `clsx`, CVA and tailwind-merge support class composition. `jose` signs/verifies JWTs; Node crypto implements scrypt, TOTP/HMAC and token hashing; QRCode supports enrollment. React Hook Form is used in the generic form primitive. Zod, NextAuth, next-intl and various template dependencies are installed but do not establish the active HRMS auth/validation architecture.

Current working schema provider is **PostgreSQL**, via `DATABASE_URL`. This is an existing local change from committed SQLite. No migration history is checked in. The tracked SQLite file and shell runtime test assumptions are legacy and do not demonstrate PostgreSQL migration readiness. Do not revert the user's provider edit or repoint/connect to a database without understanding the environment. Never reproduce `.env` values in output or documentation.

`next.config.ts` enables standalone output, disables React Strict Mode and ignores TypeScript build errors. `build` copies public/static assets into standalone output; `start` runs its server with Bun. Caddy listens on :81 and forwards to :3000, with a query-controlled `XTransformPort` alternate localhost upstream. No checked-in GitHub Actions workflows, Dockerfile or complete CI/CD pipeline were found. No persistence/backup provisioning for uploads or database is documented.

## Coding style and conventions

Use the `@/*` → `src/*` alias. Feature filenames are lower-case/kebab-case; components and types use PascalCase, variables/functions camelCase, role/status constants UPPER_SNAKE_CASE. Domain source commonly uses two-space indentation, single quotes and no semicolons; generated/config files differ. Match the touched file rather than reformatting broadly.

Keep HTTP parsing/authorization/response orchestration in route handlers and reusable calculations/security rules in `src/lib/hrms`. Server helpers commonly import `server-only`; browser modules use `'use client'`. Dynamic route params are promises and are awaited. Reuse `ROLES`, policy/date helpers, shared DTOs, `api<T>`/`ApiError` and HR UI abstractions rather than duplicating strings or fetch/auth logic.

`guard` converts `HttpError` to JSON and logs unexpected errors with `console.error('[api]', e)`, returning a generic 500. Expected failures use `{ error: message }` and appropriate HTTP status codes. Client mutations generally report through Sonner; some background refresh errors deliberately retain stale state. Prisma logs errors only. There is no dedicated structured logging/telemetry service. `writeAudit`/`writeAuditDiff` create actor/target/field/reason audit rows; this is application-level append behavior, not database-enforced immutability or guaranteed atomic auditing.

Reuse `shared.tsx` cards, pills, KPI/empty-state components and global glass classes. The historical UI contract specifies teal/slate accents, tabular-number `tnum`, responsive grids, loading/empty states, no emoji and clickable employee names. Preserve component export names/props and the existing state-based navigation unless a requested architectural change requires otherwise.

## Security and validation posture

Implemented controls:
- Salted scrypt password hashes and timing-safe password comparison; account lockout after five failures for fifteen minutes.
- Custom HS256 access JWTs (15 minutes), HttpOnly SameSite=Lax cookies; random refresh tokens stored SHA-256 hashed, rotated with token-family replay revocation (7-day TTL).
- TOTP challenge for enrolled accounts, elevated-role enrollment UI and hashed recovery codes.
- Server role gates plus hierarchy scoping: SUPER_ADMIN/HR_MANAGER org visibility; ACCOUNTANT broad underlying scope with endpoint-specific payroll restrictions; MANAGER self/reporting leads/their employees; TEAM_LEAD self/direct reports; EMPLOYEE self.
- Manual `cleanText`, email/date/number sanitizers and endpoint-specific checks. Do not infer runtime validation from TypeScript DTOs or the installed Zod package.
- Global/per-route in-memory IP throttling and security headers. Uploads enforce a 5 MB size cap, basic PDF/PNG/JPEG magic-byte checks, UUID paths and authenticated owner/admin/assigned-supervisor downloads.

Observed risks and review priorities (not fixed):
- `auth.ts` falls back to a hard-coded signing secret; both cookies set `secure: false`. Require environment-specific hardening before production use.
- Login issues normal session tokens to elevated users who have not enrolled MFA; `requireSession` only checks JWT validity. The UI enrollment gate is not a universal server enforcement boundary.
- JWT role/active-account state can remain stale until expiry; `/auth/me` and refresh recheck active state, but the common guard does not. Revoking refresh tokens does not immediately invalidate existing access JWTs.
- Refresh rotation reads eligibility before its write transaction; concurrent requests merit replay/race testing. Approval/balance/audit workflows likewise need transaction/idempotency review.
- TOTP secrets are ordinary schema strings; encryption-at-rest handling is not evident. Demo seed contains known account/device credentials and deletes data. Never run seed/backfill against real personnel data.
- CSP allows unsafe-inline and unsafe-eval scripts. Throttles are process-local and trust forwarded IP headers; deployed proxy trust must be explicit. Declared Content-Length checks do not enforce actual streamed body size, and upload multipart parsing occurs before route file-size rejection.
- No explicit general CSRF token/origin guard was found in inspected mutations; SameSite cookies provide partial protection, not a substitute for reviewing each sensitive endpoint.
- Caddy query-controlled upstream port selection exposes a sensitive internal routing surface; restrict it for production.
- The tracked database and PDF attachment must be treated as potentially sensitive; do not inspect/export their contents unnecessarily. Employee profiles, identity documents, bank details, salaries, medical uploads, reports, device credentials and audit values require field-level exposure review.
- Preserve parameterized Prisma access; manual text cleanup and magic-byte sniffing are limited defenses, not comprehensive HTML sanitization or malware scanning.

## Testing and verification

Available commands (npm run or Bun equivalent):
- `dev`: Next dev on port 3000, tee to dev.log.
- `lint`: eslint .; many TypeScript, hooks and general correctness checks are disabled in eslint.config.mjs.
- `build`: next build plus standalone static/public copying. A successful build does not prove type safety because ignoreBuildErrors is true.
- `start`: production standalone server through Bun, tee to server.log.
- `db:generate`: prisma generate; `db:migrate`: prisma migrate dev.
- `db:push`: prisma db push --accept-data-loss; `db:reset`: prisma migrate reset. These can destroy data and are not routine verification commands.
- `bun prisma/seed.ts`: explicit destructive demo initialization; not wired as a manifest test/seed command.

The initial inspection found no application test suite. Browser input regression coverage has since been added: `npm run test:inputs` runs Playwright against actual views mounted in a test-only Vite harness. See `tests/browser/README.md` and `playwright.config.ts`. All API traffic uses synthetic fixtures; no database or real credentials are required. Install Chromium with `npx playwright install chromium`; use Node 22.12+ for the test tooling. `.github/workflows/input-regressions.yml` runs these checks for pull requests and main/master pushes. `tests/database-runtime-build.sh` mocks Bun/db:push using a temporary executable and checks SQLite artifact copying/initialization. Python build checks use temporary fixtures, and the container test requires Docker plus a runner image. All three reference absent `.zscripts` helpers and therefore are incomplete in this checkout. They do not validate attendance, RBAC, approvals or payroll.

For future changes, use lint, an explicit TypeScript check (`tsc --noEmit`, preferably disabling incremental output if avoiding generated files), and a build under a compatible runtime. Verify important flows against an isolated test database: role/ownership denials, login/MFA/refresh/logout, approval transitions and balances, Karachi dates/holidays/shifts, payroll totals/finalization, uploads and binary reports. Add targeted regression tests when changing those behaviors; browser test mocks live in `tests/browser/fixtures.ts` and the `mockApi` helper; keep their data synthetic.

Analysis verification was source/config inspection only; no application build, database connection/migration, seed, data-file inspection or runtime security testing was performed. Existing schema changes and untracked package-lock.json were preserved. Do not claim the app passes checks until they have actually run.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->


## Input component stability

Keep reusable JSX component definitions at module scope. Defining input wrappers inside a stateful parent causes React to remount them on each keystroke, losing focus. Employee dialog loading depends on open state and employee identity; changing an onClose callback must not reload the form or overwrite edits. Preserve these behaviors with the maintained browser input suite. This suite verifies UI behavior, not server authorization or database business rules.
