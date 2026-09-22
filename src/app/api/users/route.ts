import { NextResponse } from 'next/server'
import { currentViewer, getDataProvider } from '@/lib/data/provider'
import { ROLES } from '@/lib/domain/roles'
import type { UserRole } from '@/lib/domain/types'

/**
 * Invite somebody.
 *
 * The role check here is courtesy — `invite_user()` refuses anyone but
 * an admin, and does so in the same transaction as the insert. What this
 * layer is actually for is refusing a role string that is not a role at
 * all, which would otherwise reach Postgres as an invalid enum cast and
 * come back as a type error rather than a sentence.
 */
export const dynamic = 'force-dynamic'

const VALID_ROLES = new Set<string>(ROLES.map((r) => r.role))

export async function POST(request: Request) {
  const viewer = await currentViewer()
  if (!viewer) return NextResponse.json({ ok: false, error: 'Not signed in.' }, { status: 401 })

  let body: Record<string, unknown>
  try {
    body = (await request.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ ok: false, error: 'Malformed request.' }, { status: 400 })
  }

  const role = body.role
  if (typeof role !== 'string' || !VALID_ROLES.has(role)) {
    return NextResponse.json({ ok: false, error: 'Unknown role.' }, { status: 400 })
  }
  const email = typeof body.email === 'string' ? body.email.trim() : ''
  const fullName = typeof body.fullName === 'string' ? body.fullName.trim() : ''
  if (!email || !fullName) {
    return NextResponse.json(
      { ok: false, error: 'An invitation needs a name and an email address.' },
      { status: 400 },
    )
  }

  const result = await getDataProvider().inviteUser(viewer, {
    email,
    fullName,
    role: role as UserRole,
    clientOrgId: typeof body.clientOrgId === 'string' && body.clientOrgId
      ? body.clientOrgId : null,
  })
  return NextResponse.json(result, { status: result.ok ? 200 : 422 })
}
