import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireSession, guard, ok } from '@/lib/hrms/api-utils'

export async function GET() {
  return guard(async () => {
    const session = await requireSession()
    const [items, unread] = await Promise.all([
      db.notification.findMany({ where: { userId: session.userId }, orderBy: { createdAt: 'desc' }, take: 30 }),
      db.notification.count({ where: { userId: session.userId, read: false } }),
    ])
    return ok({ items, unread })
  })
}

export async function POST(req: NextRequest) {
  return guard(async () => {
    const session = await requireSession()
    const body = await req.json().catch(() => ({}))
    if (body?.all) {
      await db.notification.updateMany({ where: { userId: session.userId, read: false }, data: { read: true } })
    } else if (Array.isArray(body?.ids) && body.ids.length) {
      const ids = (body.ids as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, 200)
      if (ids.length) await db.notification.updateMany({ where: { id: { in: ids }, userId: session.userId }, data: { read: true } })
    }
    const unread = await db.notification.count({ where: { userId: session.userId, read: false } })
    return ok({ ok: true, unread })
  })
}
