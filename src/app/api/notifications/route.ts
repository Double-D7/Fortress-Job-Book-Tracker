import { NextResponse } from 'next/server'
import { currentViewer, getDataProvider } from '@/lib/data/provider'

/**
 * Mark this caller's notifications read.
 *
 * Takes no user id, and must not: `mark_notifications_read()` reads
 * `current_app_user_id()` itself. Accepting one here would create a
 * parameter somebody would eventually pass somebody else's value to.
 */
export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  const viewer = await currentViewer()
  if (!viewer) return NextResponse.json({ ok: false, error: 'Not signed in.' }, { status: 401 })

  let body: Record<string, unknown> = {}
  try {
    body = (await request.json()) as Record<string, unknown>
  } catch {
    // An empty body means "all of them", which is the common case.
  }

  const jobBookId = typeof body.jobBookId === 'string' && body.jobBookId
    ? body.jobBookId : undefined

  const result = await getDataProvider().markNotificationsRead(viewer, jobBookId)
  return NextResponse.json(result, { status: result.ok ? 200 : 422 })
}
