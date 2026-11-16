// Derives the Turso/libSQL (SQLite dialect) Prisma schema from the single source of truth, prisma/schema.prisma.
// Run automatically by `db:generate`. Output: prisma/turso/schema.prisma (generated — do not edit).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

const src = readFileSync('prisma/schema.prisma', 'utf8')
const gen = `generator client {
  provider = "prisma-client-js"
  output   = "../../src/generated/turso-client"
}`
const ds = `datasource db {
  provider = "sqlite"
  url      = "file:./turso-placeholder.db" // never used at runtime: the app connects through @prisma/adapter-libsql
}`
const out = src
  .replace(/generator client \{[\s\S]*?\n\}/, gen)
  .replace(/datasource db \{[\s\S]*?\n\}/, ds)
if (out === src || !out.includes('provider = "sqlite"')) throw new Error('could not derive the Turso schema')
mkdirSync('prisma/turso', { recursive: true })
writeFileSync('prisma/turso/schema.prisma', `// GENERATED from prisma/schema.prisma by scripts/gen-turso-schema.mjs — do not edit.\n${out}`)
console.log('prisma/turso/schema.prisma written')
