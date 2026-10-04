import { NextResponse } from 'next/server'
import { currentViewer, getDataProvider } from '@/lib/data/provider'

/**
 * Close a recorded fault.
 *
 * The role check is the database's — `resolve_error_report()` refuses
 * anyone but a manager or admin in the same transaction as the update.
 */
export const dynamic = 'force-dynamic'

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ reportId: string }> },
) {
  const viewer = await currentViewer()
  if (!viewer) return NextResponse.json({ ok: false, error: 'Not signed in.' }, { status: 401 })

  const { reportId } = await params
  const result = await getDataProvider().resolveErrorReport(viewer, reportId)
  return NextResponse.json(result, { status: result.ok ? 200 : 422 })
}
