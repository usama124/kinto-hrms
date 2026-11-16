/**
 * Pure helpers for the designation hierarchy (no DB, no server-only) — shared by the API (validation)
 * and the UI (indented lists), and unit-tested.
 */
export type DesignationNode = {
  id: string
  name: string
  departmentId: string
  parentDesignationId: string | null
  levelRank: number
}

/** Deepest nesting allowed (root = depth 0). Keeps the tree readable and the walks bounded. */
export const MAX_DESIGNATION_DEPTH = 8

/** Optional 1–99 seniority rank from user input. `undefined` = not provided, 'invalid' = reject. */
export function parseLevelRank(v: unknown): number | undefined | 'invalid' {
  if (v === undefined || v === null || v === '') return undefined
  const n = Number(v)
  return Number.isInteger(n) && n >= 1 && n <= 99 ? n : 'invalid'
}

const byId = <T extends DesignationNode>(list: T[]) => new Map(list.map((d) => [d.id, d]))

/** Ancestor ids from the direct parent upwards. Bounded, so even corrupt data cannot loop forever. */
export function ancestorsOf(list: DesignationNode[], id: string): string[] {
  const map = byId(list)
  const out: string[] = []
  let cur = map.get(id)?.parentDesignationId ?? null
  while (cur && out.length <= list.length) {
    out.push(cur)
    cur = map.get(cur)?.parentDesignationId ?? null
  }
  return out
}

export function descendantsOf(list: DesignationNode[], id: string): Set<string> {
  const kids = new Map<string, string[]>()
  for (const d of list) if (d.parentDesignationId) kids.set(d.parentDesignationId, [...(kids.get(d.parentDesignationId) ?? []), d.id])
  const out = new Set<string>()
  const stack = [...(kids.get(id) ?? [])]
  while (stack.length) {
    const n = stack.pop()!
    if (out.has(n)) continue
    out.add(n)
    stack.push(...(kids.get(n) ?? []))
  }
  return out
}

/** Making `id` a child of `newParentId` would create a loop (parent is itself or one of its descendants). */
export function wouldCreateCycle(list: DesignationNode[], id: string, newParentId: string | null): boolean {
  if (!newParentId) return false
  return newParentId === id || descendantsOf(list, id).has(newParentId)
}

export const depthOf = (list: DesignationNode[], id: string) => ancestorsOf(list, id).length

/** Number of levels below `id` (a leaf has height 0). */
export function subtreeHeight(list: DesignationNode[], id: string): number {
  const kids = list.filter((d) => d.parentDesignationId === id)
  return kids.length ? 1 + Math.max(...kids.map((k) => subtreeHeight(list, k.id))) : 0
}

/** Would placing `id` under `newParentId` push any branch past MAX_DESIGNATION_DEPTH? (`id` null = a brand-new leaf.) */
export function exceedsMaxDepth(list: DesignationNode[], id: string | null, newParentId: string | null): boolean {
  const parentDepth = newParentId ? depthOf(list, newParentId) + 1 : 0
  return parentDepth + (id ? subtreeHeight(list, id) : 0) > MAX_DESIGNATION_DEPTH
}

/**
 * Depth-first ordering for display: roots first (levelRank, then name), each followed by its children.
 * A node whose parent is missing from `list` is treated as a root, so filtered lists still render.
 */
export function orderedTree<T extends DesignationNode>(list: T[]): (T & { depth: number })[] {
  const ids = new Set(list.map((d) => d.id))
  const kids = new Map<string | null, T[]>()
  for (const d of list) {
    const key = d.parentDesignationId && ids.has(d.parentDesignationId) ? d.parentDesignationId : null
    kids.set(key, [...(kids.get(key) ?? []), d])
  }
  const cmp = (a: T, b: T) => a.levelRank - b.levelRank || a.name.localeCompare(b.name)
  const out: (T & { depth: number })[] = []
  const seen = new Set<string>()
  const walk = (parent: string | null, depth: number) => {
    for (const d of (kids.get(parent) ?? []).sort(cmp)) {
      if (seen.has(d.id)) continue // corrupt cyclic data can't recurse forever
      seen.add(d.id)
      out.push({ ...d, depth })
      walk(d.id, depth + 1)
    }
  }
  walk(null, 0)
  return out
}
