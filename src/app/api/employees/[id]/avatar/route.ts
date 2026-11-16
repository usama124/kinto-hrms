import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireSession, guard, ok, fail } from '@/lib/hrms/api-utils'
import { isOrgAdmin, ROLES, UPLOAD_DIR } from '@/lib/hrms/constants'
import { guardRate, clientIp, RATE_LIMITS } from '@/lib/hrms/rate-limit'
import { writeAudit } from '@/lib/hrms/audit'
import { mkdir, readFile, unlink, writeFile } from 'fs/promises'
import { join } from 'path'
import { randomUUID } from 'crypto'

const MAX_AVATAR_BYTES = 2 * 1024 * 1024

/** Profile pictures are PNG / JPEG only (no PDF). */
function sniffImage(b: Buffer): { mime: string; ext: string } | null {
  if (b.length < 8) return null
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { mime: 'image/png', ext: 'png' }
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' }
  return null
}

async function readCapped(req: NextRequest, max: number): Promise<Buffer | null> {
  const reader = req.body?.getReader()
  if (!reader) return Buffer.alloc(0)
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > max) { await reader.cancel(); return null }
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}

async function dropFile(path: string) {
  try { await unlink(join(process.cwd(), path)) } catch { /* already gone */ }
}

/** Who may change this person's picture: themself (any role) or HR/Admin — an HR Manager's picture only by themself or the System Admin. */
function canChange(session: { userId: string; role: string }, target: { id: string; role: string }): boolean {
  if (session.userId === target.id) return true
  if (!isOrgAdmin(session.role)) return false
  return !(target.role === ROLES.HR_MANAGER && session.role !== ROLES.SUPER_ADMIN)
}

/** Serve a profile picture. Any signed-in user may view it (it appears in the directory, org chart, requests, timesheets). */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return guard(async () => {
    await requireSession()
    const { id } = await ctx.params
    const u = await db.user.findUnique({ where: { id }, select: { avatarUploadId: true } })
    const rec = u?.avatarUploadId ? await db.upload.findUnique({ where: { id: u.avatarUploadId } }) : null
    if (!rec) return fail('No profile picture.', 404)
    try {
      const buf = await readFile(join(process.cwd(), rec.path))
      return new Response(new Uint8Array(buf), {
        headers: {
          'Content-Type': rec.mime,
          'X-Content-Type-Options': 'nosniff',
          // the URL carries ?v=<upload id>, so a changed picture is a new URL and can be cached hard
          'Cache-Control': 'private, max-age=31536000, immutable',
          'Cross-Origin-Resource-Policy': 'same-origin',
        },
      })
    } catch {
      return fail('Picture missing on disk.', 404)
    }
  })
}

/** Upload / replace a profile picture (multipart field "file"). */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return guard(async () => {
    const session = await requireSession()
    const { id } = await ctx.params
    const target = await db.user.findUnique({ where: { id }, select: { id: true, role: true, fullName: true, avatarUploadId: true } })
    if (!target) return fail('Employee not found.', 404)
    if (!canChange(session, target)) return fail('Forbidden: you can only change your own profile picture.', 403)
    const rl = guardRate(req, 'avatar', RATE_LIMITS.UPLOAD.max, RATE_LIMITS.UPLOAD.windowMs)
    if (!rl.ok) return fail(`Too many uploads. Retry after ${rl.retryAfterSec}s.`, 429)

    const buffered = await readCapped(req, MAX_AVATAR_BYTES + 64 * 1024)
    if (!buffered) return fail('Picture exceeds the 2 MB limit.', 413)
    const form = await new Response(new Uint8Array(buffered), { headers: { 'content-type': req.headers.get('content-type') ?? '' } }).formData().catch(() => null)
    const file = form?.get('file')
    if (!(file instanceof File)) return fail('file field required.', 422)
    const bytes = Buffer.from(await file.arrayBuffer())
    if (bytes.length > MAX_AVATAR_BYTES) return fail('Picture exceeds the 2 MB limit.', 413)
    const kind = sniffImage(bytes) // magic bytes, never the browser-supplied type
    if (!kind) return fail('Only PNG or JPEG pictures are accepted.', 415)

    await mkdir(UPLOAD_DIR, { recursive: true })
    const path = join(UPLOAD_DIR, `${randomUUID()}.${kind.ext}`)
    await writeFile(join(process.cwd(), path), bytes)

    const old = target.avatarUploadId ? await db.upload.findUnique({ where: { id: target.avatarUploadId } }) : null
    const rec = await db.$transaction(async (tx) => {
      const r = await tx.upload.create({ data: { name: `profile-picture.${kind.ext}`, mime: kind.mime, size: bytes.length, path, uploadedById: session.userId } })
      await tx.user.update({ where: { id }, data: { avatarUploadId: r.id } })
      if (old) await tx.upload.deleteMany({ where: { id: old.id, requests: { none: {} } } })
      return r
    })
    if (old) await dropFile(old.path)

    await writeAudit({
      actorId: session.userId, actorName: session.fullName, actorRole: session.role,
      targetUserId: target.id, targetName: target.fullName,
      entityType: 'USER', entityId: target.id, fieldName: 'profilePicture', newValue: rec.id,
      reason: session.userId === target.id ? 'Profile picture changed by employee' : 'Profile picture changed by HR/Admin', ipAddress: clientIp(req),
    })
    return ok({ avatarUploadId: rec.id }, { status: 201 })
  })
}

/** Remove the profile picture (back to coloured initials). */
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return guard(async () => {
    const session = await requireSession()
    const { id } = await ctx.params
    const target = await db.user.findUnique({ where: { id }, select: { id: true, role: true, fullName: true, avatarUploadId: true } })
    if (!target) return fail('Employee not found.', 404)
    if (!canChange(session, target)) return fail('Forbidden: you can only change your own profile picture.', 403)
    if (!target.avatarUploadId) return ok({ ok: true })

    const old = await db.upload.findUnique({ where: { id: target.avatarUploadId } })
    await db.$transaction(async (tx) => {
      await tx.user.update({ where: { id }, data: { avatarUploadId: null } })
      if (old) await tx.upload.deleteMany({ where: { id: old.id, requests: { none: {} } } })
    })
    if (old) await dropFile(old.path)
    await writeAudit({
      actorId: session.userId, actorName: session.fullName, actorRole: session.role,
      targetUserId: target.id, targetName: target.fullName,
      entityType: 'USER', entityId: target.id, fieldName: 'profilePicture', oldValue: target.avatarUploadId, newValue: null,
      reason: 'Profile picture removed', ipAddress: clientIp(req),
    })
    return ok({ ok: true })
  })
}

export const dynamic = 'force-dynamic'
