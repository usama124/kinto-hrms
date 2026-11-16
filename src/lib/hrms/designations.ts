import 'server-only'
import { db } from '@/lib/db'

/**
 * Company-defined designation list (Setting `org.designations`, a JSON string array).
 * Employees can only be given a designation from this list; HR/Admin maintain it.
 */
const KEY = 'org.designations'
export const MAX_DESIGNATIONS = 200

const tidy = (names: string[]) =>
  Array.from(new Set(names.map((n) => n.trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b))

export async function getDesignations(): Promise<string[]> {
  const row = await db.setting.findUnique({ where: { key: KEY } })
  if (row) {
    try {
      const parsed = JSON.parse(row.value)
      if (Array.isArray(parsed)) return tidy(parsed.filter((x): x is string => typeof x === 'string'))
    } catch { /* fall through to re-seed */ }
  }
  // First use: seed from the titles already in use so every existing employee stays valid.
  const used = await db.user.findMany({ distinct: ['designation'], select: { designation: true } })
  const list = tidy(used.map((u) => u.designation))
  await saveDesignations(list)
  return list
}

export async function saveDesignations(list: string[]): Promise<void> {
  const value = JSON.stringify(tidy(list))
  await db.setting.upsert({ where: { key: KEY }, create: { key: KEY, value }, update: { value } })
}

/** Case-insensitive lookup → the canonical spelling stored in the list, or null when not defined. */
export function findDesignation(list: string[], name: string): string | null {
  const n = name.trim().toLowerCase()
  return list.find((d) => d.toLowerCase() === n) ?? null
}
