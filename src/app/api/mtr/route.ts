import { NextResponse } from 'next/server'
import { createHash } from 'node:crypto'
import { currentViewer, getDataProvider } from '@/lib/data/provider'
import { parseHeatList } from '@/lib/domain/heats'
import { pdfPageCount } from '@/lib/import/pdfPageCount'

/**
 * File a mill certificate against the heats it covers.
 *
 * Plural. A mill certificate routinely certifies several products on one
 * sheet — a real Weldbend page in this project's files covers three —
 * and filing it against one heat leaves the rest reading "missing" with
 * the evidence already in the library.
 *
 * The heats arrive from the form, not from the file. The application
 * suggests one from the filename and a person confirms and completes the
 * list — see `heats.ts` for why reading them out of the PDF is not on
 * offer.
 */
export const dynamic = 'force-dynamic'

/** A mill certificate is a scan; they run large. Beyond this it is
 *  probably a whole folder somebody merged by accident. */
const MAX_BYTES = 30 * 1024 * 1024

export async function POST(request: Request) {
  const viewer = await currentViewer()
  if (!viewer) return NextResponse.json({ ok: false, error: 'Not signed in.' }, { status: 401 })

  let form: FormData
  try {
    form = await request.formData()
  } catch {
    return NextResponse.json({ ok: false, error: 'Malformed request.' }, { status: 400 })
  }

  const file = form.get('file')
  if (!(file instanceof File)) {
    return NextResponse.json({ ok: false, error: 'No file was attached.' }, { status: 400 })
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { ok: false, error: `That file is larger than ${MAX_BYTES / 1024 / 1024} MB.` },
      { status: 400 },
    )
  }

  // Parsed here rather than in the browser, with the same function the
  // browser shows its preview from, so what was displayed and what is
  // filed cannot disagree.
  const heatNumbers = parseHeatList(String(form.get('heatNumbers') ?? ''))
  if (heatNumbers.length === 0) {
    return NextResponse.json(
      { ok: false, error: 'A certificate has to be filed against a heat number.' },
      { status: 400 },
    )
  }

  const bytes = new Uint8Array(await file.arrayBuffer())
  const sha256 = createHash('sha256').update(bytes).digest('hex')

  const text = (k: string) => {
    const v = form.get(k)
    return typeof v === 'string' && v.trim() ? v.trim() : null
  }

  const result = await getDataProvider().uploadMtr(viewer, {
    heatNumbers,
    originalFilename: file.name,
    pageCount: pdfPageCount(bytes),
    bytes,
    sha256,
    byteSize: file.size,
    mimeType: file.type || 'application/pdf',
    materialDescription: text('materialDescription'),
    nominalSize: text('nominalSize'),
    scheduleOrClass: text('scheduleOrClass'),
    grade: text('grade'),
    componentType: text('componentType'),
    millName: text('millName'),
    supplierName: text('supplierName'),
    certificateNumber: text('certificateNumber'),
    certificateDate: text('certificateDate'),
    notes: text('notes'),
  })

  return NextResponse.json(result, { status: result.ok ? 201 : 422 })
}
