/**
 * E2E run.  Prereq: the production server is running (default http://127.0.0.1:3100) against the dev database.
 *   bun tests/e2e/run.ts                 → all phases
 *   bun tests/e2e/run.ts 1 2             → only some phases (1 is always run first: it signs everyone in)
 * Always finishes with teardown (MFA reset on demo accounts, removal of throwaway test data).
 */
import { db, ctx, ensureSysadmin, loadWorld } from './ctx'
import { BASE, summary } from './lib'
import { phase1 } from './phase1-login'
import { phase2 } from './phase2-matrix'
import { phase3 } from './phase3-leave'
import { phase4 } from './phase4-attendance'
import { phase5 } from './phase5-payroll'
import { phase6 } from './phase6-admin'
import { phase7 } from './phase7-security'

const wanted = new Set(process.argv.slice(2).map(Number))
const run = (n: number) => wanted.size === 0 || wanted.has(n) || n === 1

async function main() {
  const t0 = Date.now()
  const ping = await fetch(`${BASE}/api/auth/me`).catch(() => null)
  if (!ping) { console.error(`Server not reachable at ${BASE}`); process.exit(2) }
  console.log(`E2E against ${BASE}`)
  await ensureSysadmin()
  await loadWorld()
  console.log(`world: ${ctx.users.length} active users (${ctx.users.filter((u) => u.isDemo).length} demo), ${ctx.departments.length} departments, ${ctx.leaveTypes.length} leave types`)

  try {
    if (run(1)) await phase1()
    if (run(2)) await phase2()
    if (run(3)) await phase3()
    if (run(4)) await phase4()
    if (run(5)) await phase5()
    if (run(6)) await phase6()
    if (run(7)) await phase7()
  } finally {
    const { teardown } = await import('./teardown')
    await teardown()
  }
  const { failed } = summary()
  console.log(`\nfinished in ${Math.round((Date.now() - t0) / 1000)}s`)
  await db.$disconnect()
  process.exit(failed ? 1 : 0)
}
main().catch(async (e) => { console.error(e); try { (await import('./teardown')).teardown() } catch { /* */ } process.exit(1) })
