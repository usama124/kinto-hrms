import { PrismaClient } from '@prisma/client'
import { PrismaClient as TursoPrismaClient } from '@/generated/turso-client'
import { PrismaLibSQL } from '@prisma/adapter-libsql'

/**
 * Database selection (.env):
 *   DB_PROVIDER=postgres (default) → DATABASE_URL
 *   DB_PROVIDER=turso              → TURSO_DATABASE_URL (+ TURSO_AUTH_TOKEN for remote libsql:// databases)
 * Both clients expose identical models (the Turso schema is derived from prisma/schema.prisma), so the rest of the
 * app is provider-agnostic. SQLite-incompatible query features live behind src/lib/hrms/db-compat.ts.
 */
export type DbProvider = 'postgres' | 'turso'

function resolveProvider(): DbProvider {
  const raw = (process.env.DB_PROVIDER ?? 'postgres').trim().toLowerCase()
  if (raw === 'postgres' || raw === 'postgresql') return 'postgres'
  if (raw === 'turso' || raw === 'libsql') return 'turso'
  throw new Error(`DB_PROVIDER must be "postgres" or "turso" (got "${raw}").`)
}

export const DB_PROVIDER: DbProvider = resolveProvider()

function createClient(): PrismaClient {
  const log: ['error'] = ['error']
  if (DB_PROVIDER === 'turso') {
    const url = process.env.TURSO_DATABASE_URL?.trim()
    if (!url) throw new Error('DB_PROVIDER=turso requires TURSO_DATABASE_URL (libsql://<db>-<org>.turso.io, or file:./local.db for local development).')
    const authToken = process.env.TURSO_AUTH_TOKEN?.trim() || undefined
    if (/^(libsql|wss?|https?):/.test(url) && !authToken) throw new Error('Remote Turso databases require TURSO_AUTH_TOKEN.')
    // the Turso client has the same model surface; the cast keeps one set of types across the code base
    return new TursoPrismaClient({ adapter: new PrismaLibSQL({ url, authToken }), log }) as unknown as PrismaClient
  }
  if (!process.env.DATABASE_URL) throw new Error('DB_PROVIDER=postgres requires DATABASE_URL.')
  return new PrismaClient({ log })
}

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient | undefined }

function instance(): PrismaClient {
  // created on first use so `next build` works without runtime credentials
  return (globalForPrisma.prisma ??= createClient())
}

export const db: PrismaClient = new Proxy({} as PrismaClient, {
  get: (_t, prop) => {
    const client = instance() as unknown as Record<string | symbol, unknown>
    const v = client[prop]
    return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(client) : v
  },
})
