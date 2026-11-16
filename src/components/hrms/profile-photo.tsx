'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Camera, Loader2, Trash2, Upload } from 'lucide-react'
import { toast } from 'sonner'
import { api, ApiError, avatarSrc, postForm } from '@/lib/hrms/client'
import { Avatar } from './shared'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog'

const MAX_INPUT_BYTES = 12 * 1024 * 1024 // we shrink it to ~320px before upload; the server cap (2 MB) applies to the result

/**
 * Centre-crop to a square and re-encode as JPEG in the browser. Besides keeping uploads tiny this
 * drops EXIF metadata (GPS position, camera, …) before the picture ever leaves the device.
 */
async function toSquareJpeg(file: File, size = 320): Promise<Blob> {
  const bmp = await createImageBitmap(file)
  const side = Math.min(bmp.width, bmp.height)
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas unavailable')
  ctx.fillStyle = '#ffffff' // PNG transparency → white instead of black
  ctx.fillRect(0, 0, size, size)
  ctx.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, size, size)
  bmp.close()
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode the picture'))), 'image/jpeg', 0.88))
}

/** Change or remove a profile picture. Everything else on a profile is maintained by HR / Admin. */
export function ProfilePhotoDialog({ open, onClose, person, onChanged }: {
  open: boolean
  onClose: () => void
  person: { id: string; fullName: string; avatarColor: string; avatarUploadId?: string | null }
  onChanged: () => void
}) {
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  // preview URL derived from the chosen file; released when it changes or the dialog unmounts
  const preview = useMemo(() => (file ? URL.createObjectURL(file) : null), [file])
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview) }, [preview])

  function close() { setFile(null); onClose() }

  function pick(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f) return
    if (!['image/png', 'image/jpeg'].includes(f.type)) { toast.error('Choose a PNG or JPEG picture.'); return }
    if (f.size > MAX_INPUT_BYTES) { toast.error('That picture is too large — pick one under 12 MB.'); return }
    setFile(f)
  }

  async function save() {
    if (!file) return
    setBusy(true)
    try {
      const blob = await toSquareJpeg(file)
      const form = new FormData()
      form.append('file', new File([blob], 'profile-picture.jpg', { type: 'image/jpeg' }))
      await postForm(`/api/employees/${person.id}/avatar`, form)
      toast.success('Profile picture updated')
      onChanged()
      close()
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not update the picture')
    } finally { setBusy(false) }
  }

  async function remove() {
    if (!window.confirm('Remove the profile picture?')) return
    setBusy(true)
    try {
      await api(`/api/employees/${person.id}/avatar`, { method: 'DELETE' })
      toast.success('Profile picture removed')
      onChanged()
      close()
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not remove the picture')
    } finally { setBusy(false) }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) close() }}>
      <DialogContent className="sm:max-w-sm glass-strong">
        <DialogHeader>
          <DialogTitle className="text-sm flex items-center gap-1.5"><Camera className="h-4 w-4 text-teal-600" /> Profile picture</DialogTitle>
          <DialogDescription className="text-xs">
            PNG or JPEG. It is cropped to a square. All other profile details are maintained by HR / Admin.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col items-center gap-3 py-2">
          {preview
            ? <img src={preview} alt="New picture preview" className="h-24 w-24 rounded-full object-cover shadow-inner" />
            : <Avatar name={person.fullName} color={person.avatarColor} size="xl" src={avatarSrc(person)} />}
          <input ref={input} type="file" accept="image/png,image/jpeg" onChange={pick} className="hidden" />
          <Button type="button" variant="outline" size="sm" onClick={() => input.current?.click()} disabled={busy} className="h-8 text-xs">
            <Upload className="h-3.5 w-3.5 mr-1.5" /> {file ? 'Choose a different picture' : 'Choose picture'}
          </Button>
        </div>
        <DialogFooter className="sm:justify-between">
          {person.avatarUploadId ? (
            <Button type="button" variant="outline" size="sm" onClick={remove} disabled={busy} className="text-rose-600 border-rose-200 hover:bg-rose-50">
              <Trash2 className="h-3.5 w-3.5 mr-1" /> Remove
            </Button>
          ) : <span />}
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" onClick={close}>Cancel</Button>
            <Button type="button" size="sm" onClick={save} disabled={busy || !file} className="bg-teal-600 hover:bg-teal-700 text-white">
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : null} Save picture
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
