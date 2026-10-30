import { NextResponse } from 'next/server'
import { currentViewer, getDataProvider } from '@/lib/data/provider'
import { ROLES } from '@/lib/domain/roles'
import { COMPETENCY_LEVELS } from '@/lib/domain/competency'
import type { CompetencyLevel, UserRole } from '@/lib/domain/types'

/**
 * Change one person's role, record their competency, or switch their
 * account on or off.
 *
 * One route rather than three because they are one screen and one row.
 * The body says which: `role` changes the role and its operator
 * together, `competencyLevel` records an FDS-JBMP-004 assessment, and
 * `isActive` flips the switch. Sending more than one would be several
 * decisions in one request with no defined order, so it is refused.
 */
export const dynamic = 'force-dynamic'

const VALID_ROLES = new Set<string>(ROLES.map((r) => r.role))
const VALID_LEVELS = new Set<string>(COMPETENCY_LEVELS)

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
  const wantsCompetency = body.competencyLevel !== undefined
  // Exactly one. `competencyLevel: null` is a real instruction — it
  // clears an assessment — so presence is what counts, not truthiness.
  if ([wantsRole, wantsActive, wantsCompetency].filter(Boolean).length !== 1) {
    return NextResponse.json(
      { ok: false, error: 'Change the role, the competency or the switch, one at a time.' },
      { status: 400 },
    )
  }

  const provider = getDataProvider()

  if (wantsCompetency) {
    const level = body.competencyLevel
    if (level !== null && (typeof level !== 'string' || !VALID_LEVELS.has(level))) {
      return NextResponse.json({ ok: false, error: 'Unknown competency level.' }, { status: 400 })
    }
    const result = await provider.setUserCompetency(
      viewer, userId, (level as CompetencyLevel | null) ?? null,
    )
    return NextResponse.json(result, { status: result.ok ? 200 : 422 })
  }

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
