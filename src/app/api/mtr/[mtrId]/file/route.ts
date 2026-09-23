import { NextResponse } from 'next/server'
import { currentViewer, getDataProvider } from '@/lib/data/provider'

/**
 * Hand out the certificate file.
 *
 * Redirects to a short-lived signed URL rather than streaming it, so the
 * bytes never pass through this deployment. A null back means RLS
 * returned no row — which is the same answer for "does not exist" and
 * "not yours", and deliberately so: an operator should not be able to
 * probe which heats another operator has bought.
 */
export const dynamic = 'force-dynamic'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ mtrId: string }> },
) {
  const { mtrId } = await params
  const viewer = await currentViewer()
  if (!viewer) return NextResponse.json({ ok: false, error: 'Not signed in.' }, { status: 401 })

  const url = await getDataProvider().mtrDownloadUrl(viewer, mtrId)
  if (!url) {
    return NextResponse.json(
      { ok: false, error: 'That certificate is not available to you.' }, { status: 404 },
    )
  }
  return NextResponse.redirect(url)
}
