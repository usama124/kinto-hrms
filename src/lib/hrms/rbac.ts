import 'server-only'
import { db } from '@/lib/db'
import type { SessionPayload } from '@/lib/auth'
import { ROLES, isOrgAdmin } from '@/lib/hrms/constants'

/**
 * Zero-trust hierarchy scoping — repository-level query filter.
 *
 * SUPER_ADMIN / HR_MANAGER -> entire org
 * ACCOUNTANT               -> entire org (payroll context; module access gated per endpoint)
 * MANAGER                  -> self + Team Leads reporting to them + employees under those leads
 * TEAM_LEAD                -> self + direct reports
 * EMPLOYEE                 -> self only
 */
export async function visibleUserIds(session: SessionPayload): Promise<string[]> {
  const me = session.userId
  if (session.role === ROLES.SUPER_ADMIN || session.role === ROLES.HR_MANAGER || session.role === ROLES.ACCOUNTANT) {
    const users = await db.user.findMany({ where: { isActive: true }, select: { id: true } })
    return users.map((u) => u.id)
  }

  if (session.role === ROLES.MANAGER) {
    const leads = await db.user.findMany({
      where: { managerId: me, isActive: true },
      select: { id: true },
    })
    const leadIds = leads.map((l) => l.id)
    const employees = leadIds.length
      ? await db.user.findMany({ where: { teamLeadId: { in: leadIds }, isActive: true }, select: { id: true } })
      : []
    return Array.from(new Set([me, ...leadIds, ...employees.map((e) => e.id)]))
  }

  if (session.role === ROLES.TEAM_LEAD) {
    const directs = await db.user.findMany({ where: { teamLeadId: me, isActive: true }, select: { id: true } })
    return [me, ...directs.map((d) => d.id)]
  }

  return [me]
}

export async function canAccessUser(session: SessionPayload, targetId: string): Promise<boolean> {
  if (targetId === session.userId) return true
  const visible = await visibleUserIds(session)
  return visible.includes(targetId)
}

// ─── Approval authority (approver-id based, hierarchy enforced) ───────────────

type LeaveRequestLike = {
  userId: string
  currentStage: string
  status: string
}
type UserLite = { id: string; teamLeadId: string | null; managerId: string | null }

/**
 * Who may act at a given stage on a leave request.
 * Chain: TEAM_LEAD -> MANAGER (-> HR fallback). Org Admins fast-track finalize any stage.
 */
export async function canApproveLeaveAtStage(
  session: SessionPayload,
  request: LeaveRequestLike,
): Promise<{ allowed: boolean; level?: 'TEAM_LEAD' | 'MANAGER' | 'HR' | 'ADMIN' }> {
  if (request.status !== 'PENDING_TEAM_LEAD' && request.status !== 'PENDING_MANAGER' && request.status !== 'PENDING_HR') {
    return { allowed: false }
  }
  // Admin Fast-Track: single-step finalize from any stage
  if (isOrgAdmin(session.role)) return { allowed: true, level: 'ADMIN' }

  const requester = await db.user.findUnique({ where: { id: request.userId } })
  if (!requester) return { allowed: false }

  const stage = request.currentStage
  if (stage === 'TEAM_LEAD') {
    // The requester's assigned first approver (their Team Lead or reporting head)
    if (session.userId === requester.teamLeadId) return { allowed: true, level: 'TEAM_LEAD' }
    return { allowed: false }
  }
  if (stage === 'MANAGER') {
    if (session.userId === requester.managerId) return { allowed: true, level: 'MANAGER' }
    // No manager assigned → HR acts as the fallback final approver
    if (!requester.managerId && session.role === ROLES.HR_MANAGER) return { allowed: true, level: 'HR' }
    return { allowed: false }
  }
  if (stage === 'HR') {
    if (session.role === ROLES.HR_MANAGER) return { allowed: true, level: 'HR' }
    return { allowed: false }
  }
  return { allowed: false }
}

/**
 * Who may act at a given stage on an attendance regularization request.
 * 3-tier chain: TEAM_LEAD -> MANAGER -> HR. Org Admins fast-track finalize any stage.
 */
export async function canApproveAttendanceAtStage(
  session: SessionPayload,
  request: LeaveRequestLike,
): Promise<{ allowed: boolean; level?: 'TEAM_LEAD' | 'MANAGER' | 'HR' | 'ADMIN' }> {
  if (!['PENDING_TEAM_LEAD', 'PENDING_MANAGER', 'PENDING_HR'].includes(request.status)) return { allowed: false }
  if (isOrgAdmin(session.role)) return { allowed: true, level: 'ADMIN' }

  const requester = await db.user.findUnique({ where: { id: request.userId } })
  if (!requester) return { allowed: false }

  const stage = request.currentStage
  if (stage === 'TEAM_LEAD') {
    if (session.userId === requester.teamLeadId) return { allowed: true, level: 'TEAM_LEAD' }
    return { allowed: false }
  }
  if (stage === 'MANAGER') {
    if (session.userId === requester.managerId) return { allowed: true, level: 'MANAGER' }
    return { allowed: false }
  }
  if (stage === 'HR') {
    if (session.role === ROLES.HR_MANAGER) return { allowed: true, level: 'HR' }
    return { allowed: false }
  }
  return { allowed: false }
}

/** Resolve the next pending stage + approver ids for notifications. */
export function nextStageOf(kind: 'LEAVE' | 'ATTENDANCE', requester: UserLite, currentStage: string | null): { status: string; stage: string } | null {
  const chainLeave = ['TEAM_LEAD', 'MANAGER', 'HR']
  const chainAtt = ['TEAM_LEAD', 'MANAGER', 'HR']
  const chain = kind === 'LEAVE' ? chainLeave : chainAtt
  const startIdx = currentStage == null ? 0 : chain.indexOf(currentStage) + 1
  for (let i = Math.max(startIdx, 0); i < chain.length; i++) {
    const stage = chain[i]
    const approverId = stage === 'TEAM_LEAD' ? requester.teamLeadId : stage === 'MANAGER' ? requester.managerId : null
    // TEAM_LEAD/MANAGER stages require an assigned approver; HR is the org-wide fallback
    if (stage === 'TEAM_LEAD' || stage === 'MANAGER') {
      if (approverId) return { status: `PENDING_${stage}`, stage }
      continue // skip to next tier when unassigned
    }
    return { status: 'PENDING_HR', stage: 'HR' }
  }
  return null
}

/** First pending stage for a fresh submission based on the requester's chain. */
export function initialStageOf(kind: 'LEAVE' | 'ATTENDANCE', requester: UserLite): { status: string; stage: string } {
  return nextStageOf(kind, requester, null) ?? { status: 'PENDING_HR', stage: 'HR' }
}
