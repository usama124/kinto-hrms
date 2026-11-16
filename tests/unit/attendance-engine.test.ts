// Run: bun test tests/unit   (no DB needed: only the pure shift math is exercised)
import { expect, mock, test } from 'bun:test'

mock.module('server-only', () => ({})) // Next provides this guard internally; it isn't an installed package
const { computeFromPunches, DEFAULT_SHIFT } = await import('@/lib/hrms/attendance-engine')
const { dateTimeFor } = await import('@/lib/hrms/dates')

const MON = '2026-11-16' // working day, default shift 09:00–18:00, grace 15, expected 540
const day = (inT: string | null, outT?: string) =>
  computeFromPunches(
    MON,
    [...(inT ? [{ ts: dateTimeFor(MON, inT), status: 0 }] : []), ...(outT ? [{ ts: dateTimeFor(MON, outT), status: 1 }] : [])],
    DEFAULT_SHIFT,
    new Set(),
  )

test('full day is PRESENT with no short minutes', () => {
  expect(day('09:00', '18:00')).toMatchObject({ status: 'PRESENT', shortMinutes: 0, lateMinutes: 0 })
})
test('arrival inside the grace window is forgiven', () => {
  expect(day('09:10', '18:00')).toMatchObject({ status: 'PRESENT', shortMinutes: 0, lateMinutes: 0 })
})
test('late arrival beyond grace now produces short minutes (regression: used Math.min)', () => {
  expect(day('10:00', '18:00')).toMatchObject({ status: 'SHORT_DURATION', workedMinutes: 480, shortMinutes: 60, lateMinutes: 45 })
})
test('early leave still counts as short', () => {
  expect(day('09:00', '17:00')).toMatchObject({ status: 'SHORT_DURATION', shortMinutes: 60 })
})
test('single punch is MISSING', () => {
  expect(day('09:00').status).toBe('MISSING')
})
