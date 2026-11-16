/**
 * ADDITIVE demo people — never deletes or edits an existing row.
 *
 *   bun prisma/dummy-people.ts            → dry run: reads the DB and prints the plan, writes nothing
 *   bun prisma/dummy-people.ts --apply    → creates the people
 *
 * Guarantees: at least one person per ROLE and MIN_PER_DESIGNATION people per DESIGNATION (counting people who already
 * hold it), so small designations end up with several members. Every created account uses an @demo.hrms.local e-mail and a
 * DM-### employee code, so they are easy to recognise (and to remove later). Re-running only tops up what is missing.
 *
 * Needs the company structure (departments + designations) to exist — create it in Rules & Settings → Designations first.
 */
import { PrismaClient } from '@prisma/client'
import { randomBytes, scryptSync } from 'crypto'

const db = new PrismaClient()
const APPLY = process.argv.includes('--apply')
const PASSWORD = process.env.DUMMY_PASSWORD ?? 'Demo@12345'
const DOMAIN = 'demo.hrms.local'
const MIN_LEAF = 3 // junior / leaf designations ("small" ones get several members)
const MIN_SENIOR = 2 // roots that have sub-designations

const ALL_ROLES = ['SUPER_ADMIN', 'HR_MANAGER', 'ACCOUNTANT', 'ACCOUNTS_MANAGER', 'MANAGER', 'TEAM_LEAD', 'EMPLOYEE'] as const
type Role = (typeof ALL_ROLES)[number]

// ── same hash format as src/lib/auth.ts (salt:scrypt) ────────────────────────
const hashPassword = (plain: string) => {
  const salt = randomBytes(16).toString('hex')
  return `${salt}:${scryptSync(plain, salt, 64).toString('hex')}`
}

// ── deterministic randomness so a dry run and the real run build the same plan ─
let seed = 20261116
const rnd = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
const pick = <T,>(a: readonly T[]) => a[Math.floor(rnd() * a.length)]
const between = (lo: number, hi: number) => Math.round(lo + rnd() * (hi - lo))

const FIRST_M = ['Ahmed', 'Bilal', 'Usman', 'Hamza', 'Faisal', 'Imran', 'Kamran', 'Saad', 'Talha', 'Zain', 'Hassan', 'Omar', 'Danish', 'Fahad', 'Junaid', 'Waqas', 'Adeel', 'Rizwan', 'Shahid', 'Yasir']
const FIRST_F = ['Ayesha', 'Fatima', 'Sana', 'Hira', 'Maryam', 'Zainab', 'Noor', 'Iqra', 'Mahnoor', 'Amna', 'Rabia', 'Sadia', 'Laiba', 'Anum', 'Komal', 'Bushra', 'Nimra', 'Hina', 'Mehwish', 'Aiza']
const LAST = ['Khan', 'Ahmed', 'Malik', 'Sheikh', 'Qureshi', 'Siddiqui', 'Raza', 'Hussain', 'Butt', 'Chaudhry', 'Mirza', 'Ansari', 'Farooqi', 'Baig', 'Javed', 'Rehman', 'Iqbal', 'Naqvi', 'Shah', 'Abbasi']
const FATHER = ['Muhammad Aslam', 'Abdul Rashid', 'Ghulam Mustafa', 'Tariq Mehmood', 'Nazir Ahmed', 'Zahid Hussain', 'Shabbir Ali', 'Anwar Khan']
const COLORS = ['#0D9488', '#7C3AED', '#2563EB', '#DB2777', '#EA580C', '#16A34A', '#CA8A04', '#0891B2']
const CITIES = ['Karachi', 'Lahore', 'Islamabad', 'Rawalpindi', 'Faisalabad', 'Multan']

type Desig = { id: string; name: string; departmentId: string; departmentName: string; parentId: string | null; levelRank: number; hasChildren: boolean; isRoot: boolean; members: number }
type Planned = { role: Role; desig: Desig | null; fullName: string; email: string; code: string; female: boolean }

const ACCOUNTS_RE = /account|finance|payroll|audit/i
const HR_RE = /\bhr\b|human resource|people|talent|recruit/i

/** Role from the TITLE (long seniority chains like VP → Principal → Senior → Intern make "has children" useless). */
function roleFor(d: Desig): Role {
  const accountsDept = ACCOUNTS_RE.test(d.departmentName) || ACCOUNTS_RE.test(d.name)
  const senior = /\b(manager|vp|head|director|chief)\b/i.test(d.name)
  const lead = /\b(lead|principal|architect)\b/i.test(d.name)
  if (accountsDept) return senior ? 'ACCOUNTS_MANAGER' : 'ACCOUNTANT'
  if (senior) return 'MANAGER'
  if (lead) return 'TEAM_LEAD'
  return 'EMPLOYEE'
}

const SALARY: Record<Role, [number, number]> = {
  SUPER_ADMIN: [0, 0], HR_MANAGER: [200000, 280000], ACCOUNTANT: [110000, 170000], ACCOUNTS_MANAGER: [300000, 400000],
  MANAGER: [260000, 360000], TEAM_LEAD: [160000, 210000], EMPLOYEE: [55000, 130000],
}

async function main() {
  const [depts, desigRows, users, leaveTypes] = await Promise.all([
    db.department.findMany({ where: { isActive: true } }),
    db.designation.findMany({ where: { isActive: true, department: { isActive: true } }, include: { department: { select: { name: true } }, _count: { select: { users: true } } } }),
    db.user.findMany({ select: { email: true, employeeCode: true, fullName: true, role: true, designationId: true } }),
    db.leaveType.findMany({ select: { id: true } }),
  ])

  const desigs: Desig[] = desigRows.map((d) => ({
    id: d.id, name: d.name, departmentId: d.departmentId, departmentName: d.department.name, parentId: d.parentDesignationId,
    levelRank: d.levelRank, hasChildren: desigRows.some((x) => x.parentDesignationId === d.id), isRoot: !d.parentDesignationId, members: d._count.users,
  }))
  if (!desigs.length) {
    console.log('No departments/designations exist yet. Create them in Rules & Settings → Designations, then run this again.')
    return
  }

  const usedEmails = new Set(users.map((u) => u.email.toLowerCase()))
  const usedNames = new Set(users.map((u) => u.fullName.toLowerCase()))
  let codeN = Math.max(0, ...users.map((u) => Number(/^DM-(\d+)$/.exec(u.employeeCode)?.[1] ?? 0)))
  const plan: Planned[] = []

  const newPerson = (role: Role, desig: Desig | null): Planned => {
    const female = rnd() < 0.45
    let name = ''
    for (let i = 0; i < 400; i++) {
      name = `${pick(female ? FIRST_F : FIRST_M)} ${pick(LAST)}`
      if (!usedNames.has(name.toLowerCase())) break
    }
    usedNames.add(name.toLowerCase())
    const base = name.toLowerCase().replace(/[^a-z]+/g, '.')
    let email = `${base}@${DOMAIN}`
    for (let i = 2; usedEmails.has(email); i++) email = `${base}${i}@${DOMAIN}`
    usedEmails.add(email)
    codeN += 1
    const p: Planned = { role, desig, fullName: name, email, code: `DM-${String(codeN).padStart(3, '0')}`, female }
    plan.push(p)
    if (desig) desig.members += 1
    return p
  }

  // 1) every designation gets enough members (small ones get several)
  for (const d of desigs) {
    const target = d.hasChildren && d.isRoot ? MIN_SENIOR : MIN_LEAF
    while (d.members < target) newPerson(roleFor(d), d)
  }

  // 2) every role is represented at least once (existing accounts count)
  const present = new Set<string>([...users.map((u) => u.role), ...plan.map((p) => p.role)])
  const anyDesig = (re?: RegExp, pred?: (d: Desig) => boolean) => desigs.find((d) => (!re || re.test(d.name) || re.test(d.departmentName)) && (!pred || pred(d))) ?? desigs.find((d) => !pred || pred(d)) ?? desigs[0] ?? null
  for (const role of ALL_ROLES) {
    if (present.has(role)) continue
    const d =
      role === 'ACCOUNTANT' || role === 'ACCOUNTS_MANAGER' ? anyDesig(ACCOUNTS_RE)
      : role === 'HR_MANAGER' ? anyDesig(HR_RE)
      : role === 'MANAGER' ? anyDesig(undefined, (x) => x.isRoot)
      : role === 'TEAM_LEAD' ? anyDesig(undefined, (x) => !x.isRoot)
      : role === 'SUPER_ADMIN' ? null
      : anyDesig(undefined, (x) => !x.hasChildren)
    newPerson(role, d)
  }

  // ── report ──────────────────────────────────────────────────────────────────
  console.log(`\nDepartments: ${depts.length} · designations: ${desigs.length} · existing users: ${users.length}`)
  console.log(`Plan: ${plan.length} new demo account(s)\n`)
  const byDesig = new Map<string, number>()
  for (const p of plan) if (p.desig) byDesig.set(p.desig.id, (byDesig.get(p.desig.id) ?? 0) + 1)
  for (const d of desigs) console.log(`  ${d.departmentName.padEnd(18)} ${`${'  '.repeat(d.isRoot ? 0 : 1)}${d.name}`.padEnd(34)} +${byDesig.get(d.id) ?? 0}  → total ${d.members}`)
  const roleCount: Record<string, number> = {}
  for (const r of ALL_ROLES) roleCount[r] = users.filter((u) => u.role === r).length + plan.filter((p) => p.role === r).length
  console.log('\nPeople per role after this run:', roleCount)

  if (!APPLY) {
    console.log('\nDRY RUN — nothing was written. Re-run with --apply to create these accounts.')
    return
  }
  if (!plan.length) { console.log('\nNothing to add — every role and designation is already covered.'); return }

  // ── apply (one transaction) ─────────────────────────────────────────────────
  const year = new Date().getFullYear()
  const passwordHash = hashPassword(PASSWORD) // one hash for all demo accounts (same salt) — they are dummies
  await db.$transaction(async (tx) => {
    const created: { id: string; p: Planned }[] = []
    for (const p of plan) {
      const intern = /intern/i.test(p.desig?.name ?? '')
      const [lo, hi] = intern ? [25000, 40000] : SALARY[p.role]
      const base = between(lo, hi)
      const joined = new Date(Date.UTC(year - between(0, 3), between(0, 11), between(1, 28)))
      const u = await tx.user.create({
        data: {
          email: p.email, passwordHash, fullName: p.fullName, fatherName: pick(FATHER),
          gender: p.female ? 'Female' : 'Male', phone: `+92 3${between(0, 4)}${between(0, 9)} ${between(1000000, 9999999)}`,
          address: `${between(1, 99)}-${pick(['A', 'B', 'C'])} Block, ${pick(CITIES)}`,
          role: p.role, employeeCode: p.code,
          designation: p.desig?.name ?? 'System Administrator', designationId: p.desig?.id ?? null,
          departmentId: p.desig?.departmentId ?? null,
          joiningDate: joined,
          employmentStatus: intern ? 'Internship' : /associate/i.test(p.desig?.name ?? '') && rnd() < 0.4 ? 'Probation' : rnd() < 0.1 ? 'Contract' : 'Permanent',
          avatarColor: pick(COLORS), baseSalary: base, hrAllowance: Math.round(base * 0.1), utilityAllowance: Math.round(base * 0.05),
          bankName: base ? 'Demo Bank' : null,
          mustChangePassword: false, // dummy accounts: usable straight away with the shared password
        },
        select: { id: true },
      })
      created.push({ id: u.id, p })
    }

    // leave balances for the current year (all leave types)
    if (leaveTypes.length) {
      await tx.leaveBalance.createMany({ data: created.flatMap((c) => leaveTypes.map((t) => ({ userId: c.id, leaveTypeId: t.id, year }))), skipDuplicates: true })
    }

    // reporting lines — among the NEW demo people of the same department only (real accounts are never touched or re-parented)
    const inDept = (deptId: string | null, role: Role) => created.filter((c) => c.p.desig?.departmentId === deptId && c.p.role === role)
    let i = 0
    for (const c of created) {
      if (c.p.role === 'EMPLOYEE' || c.p.role === 'TEAM_LEAD' || c.p.role === 'ACCOUNTANT') {
        const dept = c.p.desig?.departmentId ?? null
        const manager = inDept(dept, 'MANAGER')[0] ?? inDept(dept, 'ACCOUNTS_MANAGER')[0]
        const leads = inDept(dept, 'TEAM_LEAD')
        const lead = c.p.role === 'EMPLOYEE' || c.p.role === 'ACCOUNTANT' ? leads[i++ % Math.max(leads.length, 1)] : undefined
        if (manager || lead) await tx.user.update({ where: { id: c.id }, data: { managerId: manager?.id ?? null, teamLeadId: lead && lead.id !== c.id ? lead.id : null } })
      }
    }
  }, { timeout: 120_000 })

  console.log(`\nCreated ${plan.length} demo account(s).`)
  console.log(`\nSign-in:  <email shown below>  /  password: ${PASSWORD}`)
  console.log('MFA: System Admin, HR Manager, Accountant, Accounts Head, Manager must enrol an authenticator app at first sign-in (server-enforced).\n')
  for (const r of ALL_ROLES) {
    const rows = plan.filter((p) => p.role === r)
    if (rows.length) console.log(`${r}\n${rows.map((p) => `   ${p.email.padEnd(40)} ${p.code}  ${p.desig?.name ?? '—'}`).join('\n')}`)
  }
}

main().catch((e) => { console.error(e); process.exit(1) }).finally(() => db.$disconnect())
