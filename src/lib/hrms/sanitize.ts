// ─── XSS / input sanitization (defense-in-depth; Prisma handles SQLi) ─────────

/** Strip HTML tags & control chars from a text field; cap length. */
export function cleanText(input: unknown, maxLen = 1000): string {
  if (input == null) return ''
  return String(input)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .trim()
    .slice(0, maxLen)
}

export function cleanEmail(input: unknown): string {
  return String(input ?? '').trim().toLowerCase().slice(0, 200)
}

export function cleanNumber(input: unknown, fallback = 0): number {
  const n = Number(input)
  return Number.isFinite(n) ? n : fallback
}

export function cleanDateKey(input: unknown): string | null {
  const s = String(input ?? '')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null
  // round-trip rejects impossible dates such as 2026-02-31 (Date.UTC would roll them over)
  const [y, m, d] = s.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10) === s ? s : null
}

export function cleanHhmm(input: unknown): string | null {
  const s = String(input ?? '')
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(s) ? s : null
}

/** "YYYY-MM" with a REAL month (01–12). The old /^\d{4}-\d{2}$/ checks accepted 2026-13 and 2026-00. */
export function cleanMonth(input: unknown): string | null {
  const s = String(input ?? '')
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(s) ? s : null
}
