import { NextResponse } from 'next/server'
import { currentViewer, getDataProvider } from '@/lib/data/provider'

/**
 * Move a section through sign-off.
 *
 * Two actions on one route because they are two halves of one control:
 * `ready` records who submitted, `approve` refuses that same person. The
 * database enforces both; this only carries the request and turns a raise
 * into a sentence.
 */
export const dynamic = 'force-dynamic'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ bookId: string; sectionNumber: string }> },
) {
  const { bookId, sectionNumber } = await params
  const viewer = await currentViewer()
  if (!viewer) return NextResponse.json({ ok: false, error: 'Not signed in.' }, { status: 401 })

  let action: string
  try {
    ({ action } = (await request.json()) as { action: string })
  } catch {
    return NextResponse.json({ ok: false, error: 'Malformed request.' }, { status: 400 })
  }

  const number = decodeURIComponent(sectionNumber)
  const provider = getDataProvider()
  const result =
    action === 'ready'   ? await provider.markSectionReady(viewer, bookId, number)
  : action === 'approve' ? await provider.approveSection(viewer, bookId, number)
  : { ok: false as const, error: `Unknown action "${action}".` }

  return NextResponse.json(result, { status: result.ok ? 200 : 422 })
}
