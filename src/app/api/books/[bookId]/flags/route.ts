import { NextResponse } from 'next/server'
import { currentViewer, getDataProvider } from '@/lib/data/provider'

/** Resolve, dismiss or acknowledge a finding. */
export const dynamic = 'force-dynamic'

const STATES = new Set(['resolved', 'dismissed', 'acknowledged'])

export async function POST(
  request: Request,
  { params }: { params: Promise<{ bookId: string }> },
) {
  const { bookId } = await params
  const viewer = await currentViewer()
  if (!viewer) return NextResponse.json({ ok: false, error: 'Not signed in.' }, { status: 401 })

  let body: { fingerprint?: string; state?: string; note?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'Malformed request.' }, { status: 400 })
  }

  if (!body.fingerprint) {
    return NextResponse.json({ ok: false, error: 'Which finding?' }, { status: 400 })
  }
  if (!body.state || !STATES.has(body.state)) {
    return NextResponse.json({ ok: false, error: 'Unknown state.' }, { status: 400 })
  }

  const result = await getDataProvider().resolveFlag(
    viewer, bookId, body.fingerprint,
    body.state as 'resolved' | 'dismissed' | 'acknowledged',
    body.note ?? '',
  )
  return NextResponse.json(result, { status: result.ok ? 200 : 422 })
}
