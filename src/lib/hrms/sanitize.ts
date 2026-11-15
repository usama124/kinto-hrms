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
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null
}

export function cleanHhmm(input: unknown): string | null {
  const s = String(input ?? '')
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(s) ? s : null
}
