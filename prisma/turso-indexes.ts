/**
 * Add the performance indexes to an EXISTING Turso/libSQL database (TURSO_DATABASE_URL + TURSO_AUTH_TOKEN from .env).
 *   bun run db:indexes:turso
 * prisma/turso-indexes.sql holds only `CREATE INDEX IF NOT EXISTS` statements: no table or row is touched, re-running is a no-op.
 */
import { readFileSync } from 'node:fs'
import { createClient } from '@libsql/client'

const url = process.env.TURSO_DATABASE_URL?.trim()
if (!url) { console.error('TURSO_DATABASE_URL is not set.'); process.exit(1) }
const authToken = process.env.TURSO_AUTH_TOKEN?.trim() || undefined
if (/^(libsql|wss?|https?):/.test(url) && !authToken) { console.error('TURSO_AUTH_TOKEN is required for remote databases.'); process.exit(1) }

const client = createClient({ url, authToken })
const count = async () => Number((await client.execute(`SELECT count(*) AS n FROM sqlite_master WHERE type='index' AND name LIKE '%\\_idx' ESCAPE '\\'`)).rows[0].n)
if (!(await client.execute(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='Department'`)).rows.length) {
  console.error('No HRMS tables found — run `bun run db:push:turso` first (it already creates these indexes).'); process.exit(1)
}
const before = await count()
await client.executeMultiple(readFileSync(new URL('./turso-indexes.sql', import.meta.url), 'utf8'))
console.log(`Indexes on ${url.replace(/\/\/.*@/, '//')}: ${before} → ${await count()}`)
process.exit(0)
