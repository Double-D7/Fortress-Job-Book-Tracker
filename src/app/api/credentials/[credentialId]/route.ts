import { NextResponse } from 'next/server'
import { currentViewer, getDataProvider } from '@/lib/data/provider'

/**
 * Withdraw a personnel credential.
 *
 * A soft delete in the library, which the trigger from 0043 turns into
 * every book that pulled the card no longer claiming it is on file.
 * The page itself is kept: retention outlives the correction, and a
 * withdrawn card is what shows a report written last year was covered
 * at the time.
 */
export const dynamic = 'force-dynamic'

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ credentialId: string }> },
) {
  const { credentialId } = await params
  const viewer = await currentViewer()
  if (!viewer) return NextResponse.json({ ok: false, error: 'Not signed in.' }, { status: 401 })

  let reason = ''
  try {
    const body = (await request.json()) as { reason?: unknown }
    reason = typeof body.reason === 'string' ? body.reason : ''
  } catch {
    return NextResponse.json({ ok: false, error: 'Malformed request.' }, { status: 400 })
  }

  const result = await getDataProvider()
    .withdrawPersonnelCredential(viewer, credentialId, reason)
  return NextResponse.json(result, { status: result.ok ? 200 : 422 })
}
