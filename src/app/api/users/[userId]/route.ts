import { NextResponse } from 'next/server'
import { currentViewer, getDataProvider } from '@/lib/data/provider'
import { ROLES } from '@/lib/domain/roles'
import type { UserRole } from '@/lib/domain/types'

/**
 * Change one person's role, or switch their account on or off.
 *
 * One route rather than two because they are one screen and one row. The
 * body says which: `role` changes the role and its operator together,
 * `isActive` flips the switch. Sending both would be two decisions in
 * one request with no defined order, so it is refused.
 */
export const dynamic = 'force-dynamic'

const VALID_ROLES = new Set<string>(ROLES.map((r) => r.role))

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  const { userId } = await params
  const viewer = await currentViewer()
  if (!viewer) return NextResponse.json({ ok: false, error: 'Not signed in.' }, { status: 401 })

  let body: Record<string, unknown>
  try {
    body = (await request.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ ok: false, error: 'Malformed request.' }, { status: 400 })
  }

  const wantsRole = body.role !== undefined
  const wantsActive = body.isActive !== undefined
  if (wantsRole === wantsActive) {
    return NextResponse.json(
      { ok: false, error: 'Change the role or the switch, one at a time.' },
      { status: 400 },
    )
  }

  const provider = getDataProvider()

  if (wantsActive) {
    if (typeof body.isActive !== 'boolean') {
      return NextResponse.json({ ok: false, error: 'Malformed request.' }, { status: 400 })
    }
    const result = await provider.setUserActive(viewer, userId, body.isActive)
    return NextResponse.json(result, { status: result.ok ? 200 : 422 })
  }

  const role = body.role
  if (typeof role !== 'string' || !VALID_ROLES.has(role)) {
    return NextResponse.json({ ok: false, error: 'Unknown role.' }, { status: 400 })
  }
  const result = await provider.setUserRole(
    viewer,
    userId,
    role as UserRole,
    typeof body.clientOrgId === 'string' && body.clientOrgId ? body.clientOrgId : null,
  )
  return NextResponse.json(result, { status: result.ok ? 200 : 422 })
}
