import 'server-only'
import { db } from '@/lib/db'

/** Notify EVERY active holder of a role (e.g. all System Admins / all HR Managers), not just the first one found. */
export async function notifyRole(role: string, data: { title: string; body: string; type?: string }): Promise<void> {
  const users = await db.user.findMany({ where: { role, isActive: true }, select: { id: true } })
  if (!users.length) return
  await db.notification.createMany({ data: users.map((u) => ({ userId: u.id, title: data.title, body: data.body, type: data.type ?? 'APPROVAL' })) })
}
