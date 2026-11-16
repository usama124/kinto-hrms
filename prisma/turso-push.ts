/**
 * Create the HRMS tables on the Turso/libSQL database named by TURSO_DATABASE_URL (+ TURSO_AUTH_TOKEN).
 *   bun run db:push:turso
 * `prisma db push` cannot talk libsql://, so the DDL is generated with `prisma migrate diff` and applied here.
 * Safe by design: if the tables already exist it does nothing (it never drops or alters data). To change the schema of
 * an existing Turso database, generate the delta yourself:  prisma migrate diff --from-schema-datamodel <old> --to-schema-datamodel prisma/turso/schema.prisma --script
 */
import { execFileSync } from 'node:child_process'
import { createClient } from '@libsql/client'

const url = process.env.TURSO_DATABASE_URL?.trim()
if (!url) { console.error('TURSO_DATABASE_URL is not set.'); process.exit(1) }
const authToken = process.env.TURSO_AUTH_TOKEN?.trim() || undefined
if (/^(libsql|wss?|https?):/.test(url) && !authToken) { console.error('TURSO_AUTH_TOKEN is required for remote databases.'); process.exit(1) }

const client = createClient({ url, authToken })
const existing = await client.execute(`SELECT name FROM sqlite_master WHERE type='table' AND name='Department'`)
if (existing.rows.length) {
  console.log('Tables already exist — nothing to do. (Existing data is never modified by this script.)')
  process.exit(0)
}

const sql = execFileSync('bunx', ['prisma', 'migrate', 'diff', '--from-empty', '--to-schema-datamodel', 'prisma/turso/schema.prisma', '--script'], { encoding: 'utf8' })
await client.executeMultiple(sql)
const n = (await client.execute(`SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)).rows[0].n
console.log(`Schema created on ${url.replace(/\/\/.*@/, '//')}: ${n} tables.`)
process.exit(0)
