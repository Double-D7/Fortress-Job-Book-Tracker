import { NextResponse } from 'next/server'
import { currentViewer, getDataProvider } from '@/lib/data/provider'

/**
 * Read a Weld Log Overview Sheet, or commit it.
 *
 * `?commit=1` writes; anything else previews. Both parse the file here,
 * server-side — the browser never sends a plan, only the bytes, because a
 * plan supplied by a client is a client asserting what is in a document it
 * also supplied.
 */
export const dynamic = 'force-dynamic'

/** Big enough for any overview sheet; small enough that a mis-drop of a
 *  830 MB book folder fails fast instead of filling a lambda. */
const MAX_BYTES = 25 * 1024 * 1024

export async function POST(
  request: Request,
  { params }: { params: Promise<{ bookId: string }> },
) {
  const { bookId } = await params
  const viewer = await currentViewer()
  if (!viewer) return NextResponse.json({ ok: false, error: 'Not signed in.' }, { status: 401 })

  const url = new URL(request.url)
  const commit = url.searchParams.get('commit') === '1'

  let file: Uint8Array
  let filename = 'overview.pdf'
  try {
    const form = await request.formData()
    const entry = form.get('file')
    if (!(entry instanceof File)) {
      return NextResponse.json({ ok: false, error: 'No file supplied.' }, { status: 400 })
    }
    if (entry.size > MAX_BYTES) {
      return NextResponse.json(
        { ok: false, error: `That file is ${(entry.size / 1e6).toFixed(1)} MB; the limit is 25 MB.` },
        { status: 413 },
      )
    }
    filename = entry.name || filename
    file = new Uint8Array(await entry.arrayBuffer())
  } catch {
    return NextResponse.json({ ok: false, error: 'Malformed upload.' }, { status: 400 })
  }

  const provider = getDataProvider()
  const result = commit
    ? await provider.commitOverviewImport(viewer, bookId, file, filename)
    : await provider.previewOverviewImport(viewer, bookId, file)

  return NextResponse.json(result, { status: result.ok ? 200 : 422 })
}
