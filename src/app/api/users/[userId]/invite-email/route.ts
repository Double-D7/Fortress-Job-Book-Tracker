import { NextResponse } from 'next/server'
import { currentViewer, getDataProvider } from '@/lib/data/provider'

/**
 * Send somebody their sign-in instructions again.
 *
 * Separate from inviting because inviting is refused once the row
 * exists. Without this, everybody added before the invitation email
 * existed — and anybody whose copy went to junk — could never be sent
 * one, and an administrator's only recourse was to tell them by hand.
 *
 * Unlike the invitation itself, sending is the whole action here, so a
 * failed send is a failed request. There is nothing else that happened
 * for it to be a warning about.
 */
export const dynamic = 'force-dynamic'

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  const { userId } = await params
  const viewer = await currentViewer()
  if (!viewer) return NextResponse.json({ ok: false, error: 'Not signed in.' }, { status: 401 })

  const result = await getDataProvider().resendInvite(viewer, userId)
  return NextResponse.json(result, { status: result.ok ? 200 : 422 })
}
