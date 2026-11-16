import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { requireSession, guard, ok, fail } from '@/lib/hrms/api-utils'
import { UPLOAD_DIR, MAX_UPLOAD_BYTES, ALLOWED_MIME } from '@/lib/hrms/constants'
import { writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { guardRate, RATE_LIMITS } from '@/lib/hrms/rate-limit'
import { cleanText } from '@/lib/hrms/sanitize'

/**
 * Secure file upload (medical certificates etc.):
 *  - MIME magic-byte inspection (never trusts the browser Content-Type)
 *  - hard size cap
 *  - random UUID filename (no attacker-controlled path/name)
 */
export async function POST(req: NextRequest) {
  return guard(async () => {
    const session = await requireSession() // every role may attach a document to their own leave request
    const rl = guardRate(req, 'upload', RATE_LIMITS.UPLOAD.max, RATE_LIMITS.UPLOAD.windowMs)
    if (!rl.ok) return fail(`Too many uploads. Retry after ${rl.retryAfterSec}s.`, 429)

    // Enforce the size cap while STREAMING the body: Content-Length can be absent/forged (chunked), and
    // req.formData() would otherwise buffer an arbitrarily large body before any size check ran.
    const buffered = await readCapped(req, MAX_UPLOAD_BYTES + 64 * 1024) // + multipart framing overhead
    if (!buffered) return fail('File exceeds the 5 MB limit.', 413)
    const form = await new Response(new Uint8Array(buffered), { headers: { 'content-type': req.headers.get('content-type') ?? '' } }).formData().catch(() => null)
    if (!form) return fail('multipart/form-data required.', 422)
    const file = form.get('file')
    if (!(file instanceof File)) return fail('file field required.', 422)

    if (file.size > MAX_UPLOAD_BYTES) return fail('File exceeds the 5 MB limit.', 413)
    const bytes = Buffer.from(await file.arrayBuffer())
    if (bytes.length === 0) return fail('Empty file.', 422)

    // magic-byte sniffing
    const mime = sniffMime(bytes)
    if (!mime || !ALLOWED_MIME.includes(mime)) {
      return fail('Only PDF, PNG or JPEG documents are accepted.', 415)
    }

    await mkdir(UPLOAD_DIR, { recursive: true })
    const ext = mime === 'application/pdf' ? 'pdf' : mime === 'image/png' ? 'png' : 'jpg'
    const storedName = `${randomUUID()}.${ext}`
    await writeFile(join(process.cwd(), UPLOAD_DIR, storedName), bytes)

    const rec = await db.upload.create({
      data: {
        name: cleanText(file.name, 120) || `document.${ext}`,
        mime, size: bytes.length, path: join(UPLOAD_DIR, storedName),
        uploadedById: session.userId,
      },
    })
    return ok({ upload: { id: rec.id, name: rec.name, mime: rec.mime, size: rec.size } }, { status: 201 })
  })
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

function sniffMime(b: Buffer): string | null {
  if (b.length < 8) return null
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return 'application/pdf' // %PDF
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png' // PNG
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg' // JPEG
  return null
}

export const dynamic = 'force-dynamic'
