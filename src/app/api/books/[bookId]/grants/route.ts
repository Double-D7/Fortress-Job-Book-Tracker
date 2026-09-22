import { NextResponse } from 'next/server'
import { currentViewer, getDataProvider } from '@/lib/data/provider'

/**
 * Give a Client Inspector this book, or take it back.
 *
 * POST issues or extends; DELETE withdraws. Both are refused again by
 * `issue_inspector_grant()` and `revoke_inspector_grant()`, which are
 * where the manager check and the rule that a grant may only name an
 * inspector actually live.
 */
export const dynamic = 'force-dynamic'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ bookId: string }> },
) {
  const { bookId } = await params
  const viewer = await currentViewer()
  if (!viewer) return NextResponse.json({ ok: false, error: 'Not signed in.' }, { status: 401 })

  let body: Record<string, unknown>
  try {
    body = (await request.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ ok: false, error: 'Malformed request.' }, { status: 400 })
  }

  const userId = typeof body.userId === 'string' ? body.userId : ''
  if (!userId) {
    return NextResponse.json({ ok: false, error: 'Name the inspector.' }, { status: 400 })
  }

  // A date arrives from a date input as YYYY-MM-DD, which parses as
  // midnight UTC. Pushed to the end of that day so "until the 30th"
  // means through the 30th rather than as it begins.
  let expiresAt: string | null = null
  if (typeof body.expiresAt === 'string' && body.expiresAt.trim()) {
    const raw = body.expiresAt.trim()
    const parsed = /^\d{4}-\d{2}-\d{2}$/.test(raw)
      ? new Date(`${raw}T23:59:59.999Z`)
      : new Date(raw)
    if (Number.isNaN(parsed.getTime())) {
      return NextResponse.json({ ok: false, error: 'That is not a date.' }, { status: 400 })
    }
    expiresAt = parsed.toISOString()
  }

  const result = await getDataProvider().issueInspectorGrant(viewer, bookId, {
    userId,
    expiresAt,
    canComment: body.canComment === true,
  })
  return NextResponse.json(result, { status: result.ok ? 200 : 422 })
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ bookId: string }> },
) {
  const { bookId } = await params
  const viewer = await currentViewer()
  if (!viewer) return NextResponse.json({ ok: false, error: 'Not signed in.' }, { status: 401 })

  const userId = new URL(request.url).searchParams.get('userId') ?? ''
  if (!userId) {
    return NextResponse.json({ ok: false, error: 'Name the inspector.' }, { status: 400 })
  }

  const result = await getDataProvider().revokeInspectorGrant(viewer, bookId, userId)
  return NextResponse.json(result, { status: result.ok ? 200 : 422 })
}
