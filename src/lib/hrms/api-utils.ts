import 'server-only'
import { NextResponse } from 'next/server'
import { getSession, type SessionPayload } from '@/lib/auth'
import { visibleUserIds } from '@/lib/hrms/rbac'
import { ROLES, isOrgAdmin } from '@/lib/hrms/constants'

export function ok(data: unknown, init?: ResponseInit) {
  return NextResponse.json(data, init)
}
export function fail(message: string, code = 400, extra?: Record<string, unknown>) {
  return NextResponse.json({ error: message, ...extra }, { status: code })
}

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message) }
}

/** Handler-level auth guard (middleware equivalent). Throws HttpError. */
export async function requireSession(): Promise<SessionPayload> {
  const s = await getSession()
  if (!s) throw new HttpError(401, 'Not authenticated. Please sign in.')
  // Elevated roles must finish TOTP enrollment before ANY feature endpoint works (server-side, not just the UI gate)
  if (s.mfaPending) throw new HttpError(403, 'Two-factor enrollment is required for your role before you can use the system.')
  return s
}

export async function requireRoles(session: SessionPayload, roles: string[]): Promise<void> {
  if (!roles.includes(session.role)) throw new HttpError(403, 'You do not have permission to access this resource.')
}

/** Runs a handler, mapping HttpError to JSON responses. */
export async function guard(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn()
  } catch (e) {
    if (e instanceof HttpError) return fail(e.message, e.status)
    console.error('[api]', e)
    return fail('Internal server error', 500)
  }
}

export async function scopedUsers(session: SessionPayload): Promise<string[]> {
  return visibleUserIds(session)
}

export function canSeePeopleModule(role: string) {
  return isOrgAdmin(role) || [ROLES.MANAGER, ROLES.TEAM_LEAD, ROLES.EMPLOYEE].includes(role)
}
