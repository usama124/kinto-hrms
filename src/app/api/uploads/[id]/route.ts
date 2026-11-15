import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireSession, guard, fail } from '@/lib/hrms/api-utils'
import { isOrgAdmin } from '@/lib/hrms/constants'
import { readFile } from 'fs/promises'
import { join } from 'path'

/** Download an uploaded document — owner, org admin, or anyone who can see the owner. */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return guard(async () => {
    const session = await requireSession()
    const { id } = await ctx.params
    const rec = await db.upload.findUnique({ where: { id }, include: { uploadedBy: { select: { id: true, teamLeadId: true, managerId: true } } } })
    if (!rec) return fail('File not found.', 404)

    const allowed = rec.uploadedById === session.userId
      || isOrgAdmin(session.role)
      || rec.uploadedBy.teamLeadId === session.userId
      || rec.uploadedBy.managerId === session.userId
    if (!allowed) return fail('Forbidden.', 403)

    try {
      const buf = await readFile(join(process.cwd(), rec.path))
      return new Response(new Uint8Array(buf), {
        headers: {
          'Content-Type': rec.mime,
          'Content-Disposition': `inline; filename="${rec.name.replace(/[^\w.\- ]/g, '_')}"`,
          'X-Content-Type-Options': 'nosniff',
        },
      })
    } catch {
      return fail('File missing on disk.', 404)
    }
  })
}

export const dynamic = 'force-dynamic'
