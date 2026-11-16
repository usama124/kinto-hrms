# Input focus regression tests

Run with Node 22.12+ (Node 22 LTS recommended):

```sh
npm ci
npx playwright install chromium
npm run test:inputs
```

`npm run test:inputs:ui` opens Playwright's interactive runner. On Linux CI, install browser OS dependencies with `npx playwright install --with-deps chromium`.

The runner starts a test-only Vite server on 127.0.0.1:4173 and mounts the **actual HRMS views**, primitives, dialogs, and styles. Every API call is intercepted with synthetic responses. No Next API handlers run, no credentials are read, and no database is contacted. Unknown API calls fail the test. The Shell's Next router is replaced only in this harness; production routing is unchanged. This is browser UI integration coverage, not end-to-end authorization/database verification.

## Regression demonstrated

Before the fix, the employee create test failed after the very first character: `TextField` was declared inside `EmployeeFormDialog`, so updating form state replaced the component and detached its input. Moving `TextField` and `SelectField` to module scope preserves React identity. A second regression test reproduced unsaved edits being reset when a parent supplied a new close callback; loading now depends on open state/employee identity, and error handling reads the latest callback through a ref.

The typing helper sends individual key events and asserts focus **and original DOM-node identity after every character**. It also tests Backspace and retyping. `fill()` alone would miss this bug. Date/time/month inputs use native value entry instead because Chromium's segmented date controls do not support ordinary text typing consistently.

## Maintained cases

- Employee create and edit: all four tabs, every enabled text/email/number/date input and address textarea, values retained across tabs, keyboard Tab order.
- Employee edit parent rerender (including a new onClose callback) and insertion at the beginning of text: focus, caret editing, and value preserved.
- Login email/password and second-factor challenge.
- Forced MFA enrollment and six-digit numeric sanitization.
- Directory search while filtering results.
- Policy values, quotas, holiday fields; department/team/shift creation dialogs; security MFA code.
- Payroll salary components, change reason, adjustment amounts/note, and run month.
- Attendance HR correction and employee regularization: times, dates, reasons.
- Request creation: dates/reason and short-leave hours; approval/rejection comments.
- Organization and individual report date controls.
- Manager dashboard team search and Shell command-palette search.
- Profile quota adjustment amount/reason.

File uploads are not text inputs; selects, checkboxes, and action submission business rules are outside the typing suite. A disabled field is intentionally not typed into. The suite does not create or submit employee/payroll/approval records. MFA provisioning/login are mocked.

## Extending and debugging

Add new views to `harness/main.tsx` and synthetic responses to `fixtures.ts` / `mockApi`. Open conditional dialogs/tabs before calling `checkVisibleInputs`; do not weaken assertions to skip an inaccessible field. Keep fixtures independent of `prisma/seed.ts`. Add a case whenever a new input surface or conditional form is added.

Failure screenshots and traces are saved under ignored `test-results/`; the HTML report is in `playwright-report/`. Open with `npx playwright show-report` or `npx playwright show-trace <trace.zip>`. GitHub Actions runs this suite on pull requests and main/master pushes, retaining failure artifacts for seven days.

Keep field component definitions at module scope. Do not use changing input values, timestamps, or random values as React keys, and do not use forced refocus after every keystroke to conceal remounting.
