import { NextResponse } from 'next/server'
import { currentViewer, getDataProvider } from '@/lib/data/provider'

/**
 * Read an NDE report PDF (§10), or commit it.
 *
 * `?commit=1` writes; anything else previews. Both parse the file
 * server-side through the same builder, so what a tech confirmed and what
 * was written cannot differ — the browser never sends back a plan.
 */
export const dynamic = 'force-dynamic'

/** These are a few pages of vendor letterhead and a table. 25 MB is
 *  generous for that and still fails fast on a mis-dropped folder. */
const MAX_BYTES = 25 * 1024 * 1024

export async function POST(
  request: Request,
  { params }: { params: Promise<{ bookId: string }> },
) {
  const { bookId } = await params
  const viewer = await currentViewer()
  if (!viewer) return NextResponse.json({ ok: false, error: 'Not signed in.' }, { status: 401 })

  const commit = new URL(request.url).searchParams.get('commit') === '1'

  let file: Uint8Array
  let filename = 'nde-report.pdf'
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
    ? await provider.commitNdeImport(viewer, bookId, file, filename)
    : await provider.previewNdeImport(viewer, bookId, file, filename)

  return NextResponse.json(result, { status: result.ok ? 200 : 422 })
}
