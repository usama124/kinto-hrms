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

/** May this session read this person's compensation (salary components, bank details, payslips)? */
export function canSeeCompensation(session: SessionPayload, targetId: string): boolean {
  return session.userId === targetId || isOrgAdmin(session.role) || session.role === ROLES.ACCOUNTANT
}

// ─── Approval authority (approver-id based, hierarchy enforced) ───────────────

type LeaveRequestLike = {
  userId: string
  currentStage: string
  status: string
}
type UserLite = { id: string; teamLeadId: string | null; managerId: string | null; role?: string }
type Level = 'TEAM_LEAD' | 'MANAGER' | 'HR' | 'ADMIN'

/** Requests raised by an HR Manager or the System Admin skip the normal chain and are decided by the System Admin only. */
export function isSysAdminOnlyRequester(role: string | undefined): boolean {
  return role === ROLES.HR_MANAGER || role === ROLES.SUPER_ADMIN
}

/** Role that receives the "HR stage" notification: the System Admin for an HR Manager's own request. */
export function hrStageRole(requester: { role?: string }): string {
  return requester.role === ROLES.HR_MANAGER ? ROLES.SUPER_ADMIN : ROLES.HR_MANAGER
}

/**
 * Rules that sit above the stage chain:
 *  - an HR Manager's requests (leave + attendance) can only be approved/rejected by the System Admin —
 *    never by the HR Manager themself and never by another HR Manager, team lead or manager;
 *  - the System Admin's own requests are decided by the System Admin only;
 *  - nobody else may act on their own request.
 * Returns the decision, or null to continue with the normal chain.
 */
function overrideGate(session: SessionPayload, requester: { id: string; role: string }): { allowed: boolean; level?: Level } | null {
  if (isSysAdminOnlyRequester(requester.role)) {
    return session.role === ROLES.SUPER_ADMIN ? { allowed: true, level: 'ADMIN' } : { allowed: false }
  }
  if (requester.id === session.userId) return { allowed: false }
  return null
}

/**
 * Who may act at a given stage on a leave request.
 * Chain: TEAM_LEAD -> MANAGER (-> HR fallback). Org Admins fast-track finalize any stage
 * (except on their own request / an HR Manager's request — see overrideGate).
 */
export async function canApproveLeaveAtStage(
  session: SessionPayload,
  request: LeaveRequestLike,
): Promise<{ allowed: boolean; level?: Level }> {
  if (request.status !== 'PENDING_TEAM_LEAD' && request.status !== 'PENDING_MANAGER' && request.status !== 'PENDING_HR') {
    return { allowed: false }
  }
  const requester = await db.user.findUnique({ where: { id: request.userId } })
  if (!requester) return { allowed: false }

  const override = overrideGate(session, requester)
  if (override) return override

  // Admin Fast-Track: single-step finalize from any stage
  if (isOrgAdmin(session.role)) return { allowed: true, level: 'ADMIN' }

  const stage = request.currentStage
  if (stage === 'TEAM_LEAD') {
    // The requester's assigned first approver (their Team Lead or reporting head)
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

/**
 * Who may act at a given stage on an attendance regularization request.
 * 3-tier chain: TEAM_LEAD -> MANAGER -> HR. Org Admins fast-track finalize any stage
 * (same exceptions as leave — see overrideGate).
 */
export async function canApproveAttendanceAtStage(
  session: SessionPayload,
  request: LeaveRequestLike,
): Promise<{ allowed: boolean; level?: Level }> {
  if (!['PENDING_TEAM_LEAD', 'PENDING_MANAGER', 'PENDING_HR'].includes(request.status)) return { allowed: false }
  const requester = await db.user.findUnique({ where: { id: request.userId } })
  if (!requester) return { allowed: false }

  const override = overrideGate(session, requester)
  if (override) return override

  if (isOrgAdmin(session.role)) return { allowed: true, level: 'ADMIN' }

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
  // HR Manager / System Admin requests have a single stage: decided by the System Admin
  if (isSysAdminOnlyRequester(requester.role)) return currentStage == null ? { status: 'PENDING_HR', stage: 'HR' } : null

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
