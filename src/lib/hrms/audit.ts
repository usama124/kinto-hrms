import 'server-only'
import { db } from '@/lib/db'

/**
 * Immutable field-level audit trail.
 * Every privileged mutation (salary edits, quota increments, shift changes,
 * regularization applications, rule changes, security events) writes here.
 */

export type AuditEntry = {
  actorId?: string | null
  actorName?: string | null
  actorRole?: string | null
  targetUserId?: string | null
  targetName?: string | null
  entityType: string
  entityId?: string | null
  fieldName?: string | null
  oldValue?: string | null
  newValue?: string | null
  reason?: string | null
  ipAddress?: string | null
  meta?: string | null
}

export async function writeAudit(entry: AuditEntry): Promise<void> {
  await db.auditLog.create({
    data: {
      actorId: entry.actorId ?? null,
      actorName: entry.actorName ?? null,
      actorRole: entry.actorRole ?? null,
      targetUserId: entry.targetUserId ?? null,
      targetName: entry.targetName ?? null,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      fieldName: entry.fieldName ?? null,
      oldValue: entry.oldValue != null ? String(entry.oldValue).slice(0, 2000) : null,
      newValue: entry.newValue != null ? String(entry.newValue).slice(0, 2000) : null,
      reason: entry.reason ?? null,
      ipAddress: entry.ipAddress ?? null,
      meta: entry.meta ?? null,
    },
  })
}

/** Write one row per changed field. */
export async function writeAuditDiff(
  base: Omit<AuditEntry, 'fieldName' | 'oldValue' | 'newValue'>,
  changes: { fieldName: string; oldValue: unknown; newValue: unknown }[],
): Promise<void> {
  for (const c of changes) {
    if (String(c.oldValue ?? '') === String(c.newValue ?? '')) continue
    await writeAudit({
      ...base,
      fieldName: c.fieldName,
      oldValue: c.oldValue != null ? String(c.oldValue) : null,
      newValue: c.newValue != null ? String(c.newValue) : null,
    })
  }
}
