/**
 * Gives the DEMO people (e-mail ending @demo.hrms.local) teams, team leads and managers.
 *
 *   bun prisma/dummy-structure.ts           → dry run: prints the plan, writes nothing
 *   bun prisma/dummy-structure.ts --apply   → writes it
 *
 * Touches ONLY demo users, plus it fills a team's lead when that is still empty. It never creates teams (it uses the teams you
 * already made), never edits a real person, and can be re-run (the result is deterministic).
 *
 * Rules
 *  - Teams: a person joins a team whose name matches their job title ("Sales" ← Sales Officers, "UI/UX" ← UI/UX Designers);
 *    everyone else is spread evenly over the department's teams. Managers / VPs sit above teams — except Accounts, where everybody belongs to the accounts team.
 *  - Team lead: the team's Team-Lead-role member (an existing real lead already in the team wins). If a team has members but no lead
 *    and the department has none, its most senior demo member is promoted to Team Lead.
 *  - Manager: the nearest manager up the DESIGNATION hierarchy (Intern → … → Engineering Manager → VP Engineering), never the same
 *    person as their team lead.
 *  - Accounts: the Accounts Manager leads the accounts team (or acts as team lead if there is no team), VP Accounts is the manager.
 */
import { db as sharedDb } from '../src/lib/db' // honours DB_PROVIDER (postgres | turso)
import { ancestorsOf } from '../src/lib/hrms/designation-tree'

const db = sharedDb
const APPLY = process.argv.includes('--apply')
const DOMAIN = '@demo.hrms.local'
const ACCOUNTS_RE = /account|finance|payroll|audit/i
const STOP = new Set(['team', 'the', 'and', 'of', 'for'])

type U = { id: string; email: string; fullName: string; role: string; designationId: string | null; departmentId: string | null; teamId: string | null; teamLeadId: string | null; managerId: string | null }
type Plan = { role?: string; teamId: string | null; teamLeadId: string | null; managerId: string | null }

const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 2 && !STOP.has(w))
const isDemo = (u: U) => u.email.endsWith(DOMAIN)
const isManagerRole = (u: U) => u.role === 'MANAGER' || u.role === 'ACCOUNTS_MANAGER'

async function main() {
  const [depts, desigs, usersAll, teams] = await Promise.all([
    db.department.findMany({ where: { isActive: true }, orderBy: { name: 'asc' } }),
    db.designation.findMany({ where: { isActive: true }, select: { id: true, name: true, departmentId: true, parentDesignationId: true, levelRank: true } }),
    db.user.findMany({ where: { isActive: true }, select: { id: true, email: true, fullName: true, role: true, designationId: true, departmentId: true, teamId: true, teamLeadId: true, managerId: true } }),
    db.team.findMany({ orderBy: { name: 'asc' } }),
  ])
  const users = usersAll as U[]
  const plans = new Map<string, Plan>()
  const teamLeadFill = new Map<string, string>() // teamId → lead user id (only applied when the team has no lead yet)
  const promoted: string[] = []
  const report: string[] = []

  for (const dept of depts) {
    const accounts = ACCOUNTS_RE.test(dept.name)
    const dd = desigs.filter((d) => d.departmentId === dept.id)
    const dn = (u: U) => dd.find((d) => d.id === u.designationId)
    const people = users.filter((u) => u.departmentId === dept.id)
    const demo = people.filter(isDemo)
    if (!demo.length) continue
    const deptTeams = teams.filter((t) => t.departmentId === dept.id)

    // work on a mutable copy so promotions are visible to later steps
    const role = new Map(people.map((u) => [u.id, u.role]))
    const roleOf = (u: U) => role.get(u.id) ?? u.role
    const seniority = (u: U) => dn(u)?.levelRank ?? 99
    const bySeniority = (a: U, b: U) => seniority(a) - seniority(b) || a.fullName.localeCompare(b.fullName)

    // ── 1) teams ─────────────────────────────────────────────────────────────
    const teamOf = new Map<string, string>() // user id → team id
    const members = new Map<string, U[]>(deptTeams.map((t) => [t.id, []]))
    if (deptTeams.length) {
      const tokens = new Map(deptTeams.map((t) => [t.id, new Set(words(t.name))]))
      const generic = deptTeams.filter((t) => ![...(tokens.get(t.id) ?? [])].some((w) => demo.some((u) => words(dn(u)?.name ?? '').includes(w))))
      let rr = 0
      // everywhere managers sit above teams — except Accounts, where the whole department (VPs and managers included) is in the accounts team
      const candidates = demo.filter((u) => accounts || !isManagerRole(u)).sort((a, b) => seniority(a) - seniority(b) || a.id.localeCompare(b.id))
      for (const u of candidates) {
        const titleWords = words(dn(u)?.name ?? '')
        const matched = deptTeams.filter((t) => [...(tokens.get(t.id) ?? [])].some((w) => titleWords.includes(w)))
        const pool = matched.length ? matched : (generic.length ? generic : deptTeams)
        const t = matched.length ? matched[rr++ % matched.length] : pool[rr++ % pool.length]
        teamOf.set(u.id, t.id)
        members.get(t.id)!.push(u)
      }
      // real people already sitting in a team stay there and count as members (they are never edited)
      for (const u of people.filter((p) => !isDemo(p) && p.teamId && members.has(p.teamId))) members.get(u.teamId!)!.push(u)
    }

    // ── 2) team leads (+ promotions where a team would have none) ────────────
    const leadOf = new Map<string, U>() // team id → lead
    const deptHasTL = people.some((u) => roleOf(u) === 'TEAM_LEAD')
    // accounts: the (non-VP) Accounts Managers lead the accounts team(s)
    const accountsLeads = accounts ? people.filter((u) => roleOf(u) === 'ACCOUNTS_MANAGER' && dn(u)?.parentDesignationId).sort(bySeniority) : []
    for (const [ti, t] of deptTeams.entries()) {
      const ms = members.get(t.id) ?? []
      let lead = (accountsLeads.length ? accountsLeads[ti % accountsLeads.length] : undefined) ?? ms.find((u) => !isDemo(u) && roleOf(u) === 'TEAM_LEAD') // an existing real lead wins
        ?? ms.filter((u) => roleOf(u) === 'TEAM_LEAD').sort((a, b) => Number(/principal|lead/i.test(dn(b)?.name ?? '')) - Number(/principal|lead/i.test(dn(a)?.name ?? '')) || bySeniority(a, b))[0]
      if (!lead && ms.filter(isDemo).length >= 2 && !deptHasTL) {
        lead = ms.filter(isDemo).sort(bySeniority)[0] // department has no leads at all → promote the most senior member
        role.set(lead.id, 'TEAM_LEAD')
        promoted.push(`${lead.fullName} (${dn(lead)?.name}) → Team Lead of ${t.name}`)
      }
      if (lead) {
        leadOf.set(t.id, lead)
        if (!t.teamLeadId) teamLeadFill.set(t.id, lead.id)
        if (isDemo(lead)) teamOf.set(lead.id, t.id)
      }
    }

    // ── 3) approvers up the designation hierarchy ────────────────────────────
    const holders = new Map<string, U[]>()
    for (const u of people) if (u.designationId) holders.set(u.designationId, [...(holders.get(u.designationId) ?? []), u])
    const counters = new Map<string, number>()
    const spread = (list: U[]) => {
      const key = list.map((u) => u.id).join(',')
      const n = counters.get(key) ?? 0
      counters.set(key, n + 1)
      return list[n % list.length]
    }
    const isTLish = (u: U) => roleOf(u) === 'TEAM_LEAD' || (accounts && roleOf(u) === 'ACCOUNTS_MANAGER')
    const isMgrish = (u: U) => roleOf(u) === 'MANAGER' || roleOf(u) === 'ACCOUNTS_MANAGER'
    const deptManagers = people.filter((u) => roleOf(u) === 'MANAGER' || roleOf(u) === 'ACCOUNTS_MANAGER')

    for (const u of demo) {
      const anc = u.designationId ? ancestorsOf(dd as never, u.designationId) : []
      const groups = anc.map((id) => (holders.get(id) ?? []).filter((x) => x.id !== u.id))
      const team = teamOf.get(u.id)
      const r = roleOf(u)

      // team lead: the team's lead; in departments without teams (accounts) the nearest suitable ancestor
      let tl: U | undefined
      if (r === 'EMPLOYEE' || r === 'ACCOUNTANT') {
        tl = team ? leadOf.get(team) : undefined
        if (!tl && accounts) { const g = groups.find((x) => x.some(isTLish)); if (g) tl = spread(g.filter(isTLish)) }
      }
      if (tl && tl.id === u.id) tl = undefined

      // manager: nearest manager up the tree that is not the team lead
      let mgr: U | undefined
      for (const g of groups) {
        const c = g.filter((x) => isMgrish(x) && x.id !== tl?.id)
        if (c.length) { mgr = spread(c); break }
      }
      if (!mgr && (r !== 'MANAGER' && r !== 'ACCOUNTS_MANAGER')) mgr = deptManagers.find((x) => x.id !== tl?.id)

      plans.set(u.id, {
        ...(r !== u.role ? { role: r } : {}),
        teamId: team ?? null,
        teamLeadId: tl?.id ?? null,
        managerId: mgr?.id ?? null,
      })
    }

    // ── report ───────────────────────────────────────────────────────────────
    report.push(`\n${dept.name}${accounts ? '  (Accounts Manager leads the team)' : ''}`)
    for (const t of deptTeams) {
      const ms = members.get(t.id) ?? []
      const lead = leadOf.get(t.id)
      report.push(`   ${t.name.padEnd(16)} lead: ${(lead?.fullName ?? '—').padEnd(22)} members: ${ms.length}${ms.filter((x) => !isDemo(x)).length ? ` (${ms.filter((x) => !isDemo(x)).length} real)` : ''}`)
    }
    const planned = demo.map((u) => plans.get(u.id)!)
    report.push(`   demo people: ${demo.length} · in a team: ${planned.filter((p) => p.teamId).length} · with team lead: ${planned.filter((p) => p.teamLeadId).length} · with manager: ${planned.filter((p) => p.managerId).length}`)
  }

  console.log(report.join('\n'))
  if (promoted.length) console.log('\nPromotions to Team Lead (demo people only):\n   ' + promoted.join('\n   '))
  console.log(`\nTeam leads that will be filled in on your existing teams: ${teamLeadFill.size}`)

  if (!APPLY) { console.log('\nDRY RUN — nothing was written. Re-run with --apply.'); return }

  await db.$transaction(async (tx) => {
    for (const [id, p] of plans) await tx.user.update({ where: { id }, data: { ...(p.role ? { role: p.role } : {}), teamId: p.teamId, teamLeadId: p.teamLeadId, managerId: p.managerId } })
    for (const [teamId, leadId] of teamLeadFill) await tx.team.updateMany({ where: { id: teamId, teamLeadId: null }, data: { teamLeadId: leadId } })
  }, { timeout: 120_000 })
  console.log(`\nUpdated ${plans.size} demo people and ${teamLeadFill.size} team lead(s).`)
}

main().catch((e) => { console.error(e); process.exit(1) }).finally(() => db.$disconnect())
