import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireSession, guard, ok, fail } from '@/lib/hrms/api-utils'
import { isOrgAdmin, DEFAULT_RULES, POLICY_KEYS } from '@/lib/hrms/constants'
import { writeAudit } from '@/lib/hrms/audit'
import { cleanDateKey, cleanText } from '@/lib/hrms/sanitize'
import { clientIp } from '@/lib/hrms/rate-limit'

/** Admin-configurable HR rules + leave caps + holiday calendar. */
export async function GET() {
  return guard(async () => {
    const session = await requireSession()
    if (!isOrgAdmin(session.role)) return fail('Forbidden: Rules & Settings is Admin / HR only.', 403)

    const [rules, leaveTypes, holidays, shift] = await Promise.all([
      db.policyRule.findMany({ orderBy: { key: 'asc' } }),
      db.leaveType.findMany({ orderBy: { name: 'asc' } }),
      db.holiday.findMany({ orderBy: { date: 'asc' } }),
      db.shift.findFirst(),
    ])
    return ok({ rules, leaveTypes, holidays, shift })
  })
}

// Allowed range per rule — bad values here silently corrupt payroll and attendance maths for everyone.
const RANGES: Record<string, { min: number; max: number; int?: boolean }> = {
  [POLICY_KEYS.SHIFT_DURATION]: { min: 60, max: 1440, int: true },
  [POLICY_KEYS.GRACE_MINUTES]: { min: 0, max: 120, int: true },
  [POLICY_KEYS.WEEKLY_OFF_DAY]: { min: 0, max: 6, int: true },
  [POLICY_KEYS.SHORT_CONVERSION_MINUTES]: { min: 60, max: 1440, int: true },
  [POLICY_KEYS.SHORT_LEAVE_MAX_HOURS]: { min: 0.5, max: 12 },
  [POLICY_KEYS.OVERTIME_RATE]: { min: 0, max: 100000 },
}

function checkRule(key: string, value: unknown): string | null {
  if (key === POLICY_KEYS.SHORT_DEDUCTION_MODE) return value === 'LEAVE_FIRST' || value === 'PRORATED' ? null : 'must be LEAVE_FIRST or PRORATED'
  const r = RANGES[key]
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN
  if (!Number.isFinite(n) || n < r.min || n > r.max || (r.int && !Number.isInteger(n))) return `must be ${r.int ? 'a whole number ' : 'a number '}between ${r.min} and ${r.max}`
  return null
}

/** Update rule values and leave-type caps (Admin only). */
export async function PUT(req: NextRequest) {
  return guard(async () => {
    const session = await requireSession()
    if (!isOrgAdmin(session.role)) return fail('Forbidden: only Admin / HR can edit policy rules.', 403)

    const body = await req.json().catch(() => null)
    if (!body) return fail('Invalid payload.', 422)

    // validate EVERYTHING first so a bad entry can't leave a half-applied update
    const updates: { key: string; value: string }[] = []
    for (const u of Array.isArray(body.rules) ? body.rules : []) {
      const key = String(u?.key ?? '')
      if (!(key in DEFAULT_RULES)) return fail(`Unknown rule "${cleanText(key, 60)}".`, 422)
      const problem = checkRule(key, u?.value)
      if (problem) return fail(`${DEFAULT_RULES[key].label} ${problem}.`, 422)
      updates.push({ key, value: String(u.value).trim() })
    }

    const caps: { id: string; monthlyCap: number | null; attachmentThreshold: number | null; annualQuota: number }[] = []
    for (const c of Array.isArray(body.leaveCaps) ? body.leaveCaps : []) {
      const n = (v: unknown) => (v == null || v === '' ? null : Number(v))
      const monthly = n(c?.monthlyCap), threshold = n(c?.attachmentThreshold), quota = Number(c?.annualQuota)
      if (typeof c?.leaveTypeId !== 'string') return fail('leaveTypeId required.', 422)
      if ((monthly !== null && !Number.isFinite(monthly)) || (threshold !== null && !Number.isFinite(threshold))) return fail('Leave caps must be numbers.', 422)
      if (!Number.isFinite(quota) || quota < 0 || quota > 365) return fail('Annual quota must be between 0 and 365.', 422)
      if ((monthly ?? 0) > 31 || (threshold ?? 0) > 31) return fail('Monthly cap / attachment threshold cannot exceed 31 days.', 422)
      caps.push({
        id: c.leaveTypeId,
        monthlyCap: monthly === null || monthly < 1 ? null : Math.floor(monthly),
        attachmentThreshold: threshold === null || threshold < 1 ? null : Math.floor(threshold),
        annualQuota: quota,
      })
    }

    let holidayAdd: { date: string; name: string } | null = null
    if (body.holiday?.date || body.holiday?.name) {
      const date = cleanDateKey(body.holiday?.date), name = cleanText(body.holiday?.name, 80)
      if (!date || !name) return fail('Holiday needs a valid date (YYYY-MM-DD) and a name.', 422)
      holidayAdd = { date, name }
    }
    let holidayRemove: string | null = null
    if (body.removeHoliday) {
      holidayRemove = cleanDateKey(body.removeHoliday)
      if (!holidayRemove) return fail('removeHoliday must be YYYY-MM-DD.', 422)
    }

    await db.$transaction(async (tx) => {
      for (const u of updates) {
        const d = DEFAULT_RULES[u.key]
        await tx.policyRule.upsert({ where: { key: u.key }, update: { value: u.value }, create: { key: u.key, value: u.value, label: d.label, category: d.category } })
      }
      for (const c of caps) {
        await tx.leaveType.updateMany({ where: { id: c.id }, data: { monthlyCap: c.monthlyCap, attachmentThreshold: c.attachmentThreshold, annualQuota: c.annualQuota } })
      }
      if (holidayAdd) await tx.holiday.upsert({ where: { date: holidayAdd.date }, update: { name: holidayAdd.name }, create: holidayAdd })
      if (holidayRemove) await tx.holiday.deleteMany({ where: { date: holidayRemove } })
    })

    await writeAudit({
      actorId: session.userId, actorName: session.fullName, actorRole: session.role,
      entityType: 'RULE', entityId: '-', ipAddress: clientIp(req),
      reason: 'Policy / leave-cap update', meta: JSON.stringify({ rules: updates, leaveCaps: caps.length, holidayAdd, holidayRemove }).slice(0, 400),
    })

    const [rules, leaveTypes, holidays] = await Promise.all([
      db.policyRule.findMany({ orderBy: { key: 'asc' } }),
      db.leaveType.findMany({ orderBy: { name: 'asc' } }),
      db.holiday.findMany({ orderBy: { date: 'asc' } }),
    ])
    return ok({ rules, leaveTypes, holidays })
  })
}
