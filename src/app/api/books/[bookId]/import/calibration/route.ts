import { NextResponse } from 'next/server'
import { currentViewer, getDataProvider } from '@/lib/data/provider'

/**
 * File torque-wrench calibration certificates (§13), or preview them.
 *
 * `?commit=1` writes; anything else previews. A batch, because the
 * certificates live together in the section 13 tab and get scanned
 * together — and because filing them one at a time is why a book full of
 * them sat unread.
 *
 * Both paths parse the files server-side through the same builder, so what
 * a tech confirmed and what was written cannot differ; the browser never
 * sends back a plan.
 */
export const dynamic = 'force-dynamic'

/** A certificate is one page of laboratory letterhead. 10 MB each is
 *  generous, and 25 files covers a facility's whole wrench inventory. */
const MAX_BYTES = 10 * 1024 * 1024
const MAX_FILES = 25

export async function POST(
  request: Request,
  { params }: { params: Promise<{ bookId: string }> },
) {
  const { bookId } = await params
  const viewer = await currentViewer()
  if (!viewer) return NextResponse.json({ ok: false, error: 'Not signed in.' }, { status: 401 })

  const commit = new URL(request.url).searchParams.get('commit') === '1'

  const files: { filename: string; bytes: Uint8Array }[] = []
  try {
    const form = await request.formData()
    const entries = form.getAll('files').filter((e): e is File => e instanceof File)
    if (entries.length === 0) {
      return NextResponse.json({ ok: false, error: 'No files supplied.' }, { status: 400 })
    }
    if (entries.length > MAX_FILES) {
      return NextResponse.json(
        { ok: false, error: `${entries.length} files at once; the limit is ${MAX_FILES}.` },
        { status: 413 },
      )
    }
    for (const entry of entries) {
      if (entry.size > MAX_BYTES) {
        return NextResponse.json(
          {
            ok: false,
            error: `${entry.name} is ${(entry.size / 1e6).toFixed(1)} MB; the limit is 10 MB.`,
          },
          { status: 413 },
        )
      }
      files.push({
        filename: entry.name || 'certificate.pdf',
        bytes: new Uint8Array(await entry.arrayBuffer()),
      })
    }
  } catch {
    return NextResponse.json({ ok: false, error: 'Malformed upload.' }, { status: 400 })
  }

  const provider = getDataProvider()
  const result = commit
    ? await provider.commitCalibrationImport(viewer, bookId, files)
    : await provider.previewCalibrationImport(viewer, bookId, files)

  return NextResponse.json(result, { status: result.ok ? 200 : 422 })
}
