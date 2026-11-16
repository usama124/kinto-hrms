import { DB_PROVIDER } from '@/lib/db'

/** True when running on Turso/libSQL (SQLite dialect). */
export const isSqlite = DB_PROVIDER === 'turso'

/**
 * `createMany({ skipDuplicates })` is not supported by SQLite. Fast path: one createMany; if a duplicate makes the
 * batch fail, fall back to row-by-row inserts that skip unique-constraint violations (P2002). Returns the inserted count.
 */
export async function createManySkipDuplicates(
  model: { createMany(args: { data: never[]; skipDuplicates?: boolean }): Promise<{ count: number }>; create(args: { data: never }): Promise<unknown> },
  data: unknown[],
): Promise<{ count: number }> {
  if (!data.length) return { count: 0 }
  if (!isSqlite) return model.createMany({ data: data as never[], skipDuplicates: true })
  try {
    return await model.createMany({ data: data as never[] })
  } catch (e) {
    if ((e as { code?: string })?.code !== 'P2002') throw e
  }
  let count = 0
  for (const row of data) {
    try { await model.create({ data: row as never }); count++ } catch (e) { if ((e as { code?: string })?.code !== 'P2002') throw e }
  }
  return { count }
}

/**
 * Where-fragment that finds a name regardless of case. Postgres: `mode: 'insensitive'`. SQLite: `equals` is
 * case-sensitive and `mode` is rejected, so match a superset with `contains` (LIKE) — always pair with {@link sameName}.
 */
export function nameLike(name: string) {
  return isSqlite ? { contains: name } : { equals: name, mode: 'insensitive' as const }
}
export const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()
