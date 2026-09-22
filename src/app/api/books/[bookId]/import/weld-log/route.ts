import { NextResponse } from 'next/server'
import { currentViewer, getDataProvider } from '@/lib/data/provider'

/**
 * Read a Detailed Weld Log (§12), or commit it.
 *
 * `?commit=1` writes; anything else previews. Accepts a workbook or a PDF
 * export of one — both are parsed here, server-side, by the same parser.
 */
export const dynamic = 'force-dynamic'

/** A weld log runs to thousands of rows and tens of pages. 50 MB holds any
 *  of them and still fails fast on a mis-dropped book folder. */
const MAX_BYTES = 50 * 1024 * 1024

export async function POST(
  request: Request,
  { params }: { params: Promise<{ bookId: string }> },
) {
  const { bookId } = await params
  const viewer = await currentViewer()
  if (!viewer) return NextResponse.json({ ok: false, error: 'Not signed in.' }, { status: 401 })

  const commit = new URL(request.url).searchParams.get('commit') === '1'

  let file: Uint8Array
  let filename = 'weld-log'
  try {
    const form = await request.formData()
    const entry = form.get('file')
    if (!(entry instanceof File)) {
      return NextResponse.json({ ok: false, error: 'No file supplied.' }, { status: 400 })
    }
    if (entry.size > MAX_BYTES) {
      return NextResponse.json(
        { ok: false, error: `That file is ${(entry.size / 1e6).toFixed(1)} MB; the limit is 50 MB.` },
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
    ? await provider.commitWeldLogImport(viewer, bookId, file, filename)
    : await provider.previewWeldLogImport(viewer, bookId, file, filename)

  return NextResponse.json(result, { status: result.ok ? 200 : 422 })
}
