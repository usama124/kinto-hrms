/**
 * Tiny in-process TTL cache for rarely-changing reference data (policy rules, holidays) that is read on most
 * attendance / payroll / dashboard paths. Writers call {@link invalidateConfig} so this instance sees changes at once;
 * other instances (if the app is ever scaled out) converge within the TTL. Never cache anything security-sensitive here.
 */
const store = new Map<string, { exp: number; val: unknown }>()
const TTL_MS = 30_000

export async function memo<T>(key: string, load: () => Promise<T>, ttlMs = TTL_MS): Promise<T> {
  const hit = store.get(key)
  if (hit && hit.exp > Date.now()) return hit.val as T
  const val = await load()
  store.set(key, { exp: Date.now() + ttlMs, val })
  return val
}

export function invalidateConfig(): void {
  store.clear()
}
