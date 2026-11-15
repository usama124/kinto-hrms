import { NextRequest, NextResponse } from 'next/server'
import { guard, ok } from '@/lib/hrms/api-utils'
import { revokeFamilyOf, ACCESS_COOKIE, REFRESH_COOKIE } from '@/lib/hrms/tokens'

export async function POST(req: NextRequest) {
  return guard(async () => {
    const body = await req.json().catch(() => ({}))
    const presented = body?.refreshToken ? String(body.refreshToken) : (req.cookies.get(REFRESH_COOKIE)?.value ?? null)
    await revokeFamilyOf(presented)
    const res = ok({ ok: true }) as NextResponse
    res.cookies.set(ACCESS_COOKIE, '', { httpOnly: true, path: '/', maxAge: 0 })
    res.cookies.set(REFRESH_COOKIE, '', { httpOnly: true, path: '/', maxAge: 0 })
    return res
  })
}

export const dynamic = 'force-dynamic'
