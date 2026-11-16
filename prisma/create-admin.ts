/**
 * NovaTech HRMS — bootstrap the first SUPER_ADMIN account.
 *
 * Use this on a FRESH environment (empty database) where you do not want the
 * full demo seed. It provisions exactly one admin and nothing else.
 *
 * Usage:
 *   bun prisma/create-admin.ts \
 *     --email admin@yourcompany.com \
 *     --password 'Strong@Pass123' \
 *     --name 'System Administrator' \
 *     --code NT-000            # optional, auto-assigned when omitted
 *
 * Flags can also be provided via env vars: ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_NAME, ADMIN_CODE.
 * Password policy: min 10 chars, upper + lower + digit + symbol.
 */
import { db as sharedDb } from '../src/lib/db' // honours DB_PROVIDER (postgres | turso)
import { randomBytes, scryptSync } from 'crypto'

const db = sharedDb

function parseArgs(): Record<string, string | undefined> {
  const out: Record<string, string> = {}
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--email' || a === '--password' || a === '--name' || a === '--code') {
      const v = argv[i + 1]
      if (!v || v.startsWith('--')) { console.error(`Missing value for ${a}`); process.exit(1) }
      out[a.slice(2)] = v
      i++
    }
  }
  return out
}

function validatePassword(pw: string): string | null {
  if (pw.length < 10) return 'Password must be at least 10 characters.'
  if (!/[A-Z]/.test(pw)) return 'Password must contain an uppercase letter.'
  if (!/[a-z]/.test(pw)) return 'Password must contain a lowercase letter.'
  if (!/[0-9]/.test(pw)) return 'Password must contain a digit.'
  if (!/[^A-Za-z0-9]/.test(pw)) return 'Password must contain a symbol.'
  return null
}

function hashPassword(plain: string): string {
  const salt = randomBytes(16).toString('hex')
  return `${salt}:${scryptSync(plain, salt, 64).toString('hex')}`
}

async function nextEmployeeCode(explicit?: string): Promise<string> {
  if (explicit) {
    const dup = await db.user.findUnique({ where: { employeeCode: explicit } })
    if (dup) { console.error(`Employee code "${explicit}" is already taken by ${dup.fullName}.`); process.exit(1) }
    return explicit
  }
  // reserve the low range for seeded/staff codes; bootstrap admins get 900+
  for (let n = 900; n < 9999; n++) {
    const code = `NT-${String(n).padStart(3, '0')}`
    const dup = await db.user.findUnique({ where: { employeeCode: code } })
    if (!dup) return code
  }
  console.error('Exhausted employee code pool.')
  process.exit(1)
}

async function main() {
  const args = parseArgs()
  const email = (args.email ?? process.env.ADMIN_EMAIL ?? 'admin@hrms.local').toLowerCase().trim()
  const password = args.password ?? process.env.ADMIN_PASSWORD ?? 'Admin@123'
  const name = args.name ?? process.env.ADMIN_NAME ?? 'System Administrator'
  const code = args.code ?? process.env.ADMIN_CODE

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { console.error(`Invalid email: ${email}`); process.exit(1) }
  const pwError = validatePassword(password)
  if (pwError) { console.error(`Weak password: ${pwError}`); process.exit(1) }

  const existingUser = await db.user.findUnique({ where: { email } })
  if (existingUser) { console.error(`A user with email ${email} already exists (${existingUser.fullName}, ${existingUser.role}).`); process.exit(1) }

  const employeeCode = await nextEmployeeCode(code)
  const existingAdmins = await db.user.count({ where: { role: 'SUPER_ADMIN' } })

  const admin = await db.user.create({
    data: {
      email,
      passwordHash: hashPassword(password),
      fullName: name,
      role: 'SUPER_ADMIN',
      employeeCode,
      designation: 'System Administrator',
      avatarColor: '#334155',
      joiningDate: new Date(),
      baseSalary: 0,
    },
  })

  await db.auditLog.create({
    data: {
      actorId: admin.id, actorName: admin.fullName, actorRole: 'SUPER_ADMIN',
      entityType: 'SECURITY', entityId: admin.id,
      fieldName: 'bootstrap', newValue: `SUPER_ADMIN ${email} provisioned via create-admin script`,
      reason: existingAdmins === 0 ? 'First admin bootstrap on fresh environment' : 'Additional admin provisioned',
    },
  })

  console.log('Admin account created.')
  console.log(`  email:    ${email}`)
  console.log(`  password: (as provided on the command line — never stored in plain text)`)
  console.log(`  role:     SUPER_ADMIN`)
  console.log(`  code:     ${employeeCode} (also their ZKTeco PIN, set it on the device)`)
  console.log('')
  console.log('First login: sign in with email + password. TOTP MFA enrollment is forced')
  console.log('immediately after (required for SUPER_ADMIN). Scan the QR with an authenticator app.')
}

main()
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(() => db.$disconnect())