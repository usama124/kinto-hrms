import { randomInt } from 'crypto'

/** Same policy as prisma/create-admin.ts: 10+ chars with upper, lower, digit and symbol. */
export function passwordPolicyError(pw: string): string | null {
  if (pw.length < 10) return 'Password must be at least 10 characters.'
  if (pw.length > 128) return 'Password must be at most 128 characters.'
  if (!/[A-Z]/.test(pw)) return 'Password must contain an uppercase letter.'
  if (!/[a-z]/.test(pw)) return 'Password must contain a lowercase letter.'
  if (!/[0-9]/.test(pw)) return 'Password must contain a digit.'
  if (!/[^A-Za-z0-9]/.test(pw)) return 'Password must contain a symbol.'
  return null
}

const pick = (set: string, n: number) => Array.from({ length: n }, () => set[randomInt(set.length)])

/** Random 12-char temporary password that satisfies the policy (replaces the shared default password). */
export function generateTempPassword(): string {
  const chars = [
    ...pick('ABCDEFGHJKLMNPQRSTUVWXYZ', 4), ...pick('abcdefghijkmnopqrstuvwxyz', 4),
    ...pick('23456789', 3), ...pick('!@#$%*?', 1),
  ]
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1)
    ;[chars[i], chars[j]] = [chars[j], chars[i]]
  }
  return chars.join('')
}
