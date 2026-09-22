import { NextResponse } from 'next/server'
import { redirect } from 'next/navigation'
import { createHash } from 'node:crypto'
import { currentViewer, getDataProvider } from '@/lib/data/provider'
import { previewUploads, type PrepareInput } from '@/lib/domain/upload'

/**
 * Upload documents into one section.
 *
 * Two verbs on one route because the preview and the commit must run the
 * same code over the same bytes:
 *
 *   PUT  — hash and check, change nothing. What the tech sees before
 *          committing.
 *   POST — do it.
 *
 * The hash is computed here, on the server, from the bytes that actually
 * arrived. A client-supplied hash would make the duplicate check a matter
 * of the browser's word, and the duplicate check is one of the things this
 * application exists to do.
 */
export const dynamic = 'force-dynamic'

/** Guards a single request, not a quota. A book runs to hundreds of MB. */
const MAX_FILES = 200
const MAX_TOTAL_BYTES = 512 * 1024 * 1024

async function readForm(request: Request): Promise<
  { ok: true; files: PrepareInput[] } | { ok: false; error: string }
> {
  let form: FormData
  try {
    form = await request.formData()
  } catch {
    return { ok: false, error: 'Expected a multipart form.' }
  }

  let classification: Record<string, unknown> = {}
  try {
    const raw = form.get('classification')
    if (typeof raw === 'string') classification = JSON.parse(raw)
  } catch {
    // A malformed classification is not a reason to lose the upload. The
    // name records the gap instead, which is a Minor finding and fixable.
  }

  const entries = form.getAll('files').filter((f): f is File => f instanceof File)
  if (!entries.length) return { ok: false, error: 'No files in the request.' }
  if (entries.length > MAX_FILES) {
    return { ok: false, error: `${entries.length} files in one request; the limit is ${MAX_FILES}.` }
  }

  const files: PrepareInput[] = []
  let total = 0
  for (const f of entries) {
    const buf = Buffer.from(await f.arrayBuffer())
    total += buf.byteLength
    if (total > MAX_TOTAL_BYTES) {
      return { ok: false, error: 'This batch exceeds 512 MB. Upload it in smaller batches.' }
    }
    files.push({
      originalFilename: f.name,
      byteSize: buf.byteLength,
      sha256: createHash('sha256').update(buf).digest('hex'),
      mimeType: f.type || null,
      // Carried through to the provider, which writes the object. The seed
      // provider ignores them; the persistent one cannot store a document
      // it was only told the size of.
      bytes: new Uint8Array(buf),
      classification,
    })
  }
  return { ok: true, files }
}

/** Preview: hash, check, and report. Writes nothing. */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ bookId: string; sectionNumber: string }> },
) {
  const { bookId, sectionNumber } = await params
  const number = decodeURIComponent(sectionNumber)

  const read = await readForm(request)
  if (!read.ok) return NextResponse.json({ ok: false, error: read.error }, { status: 400 })

  const viewer = await currentViewer()
  if (!viewer) return NextResponse.json({ ok: false, error: 'Not signed in.' }, { status: 401 })

  const b = await getDataProvider().getBundle(viewer, bookId)
  if (!b) return NextResponse.json({ ok: false, error: 'Job book not found.' }, { status: 404 })

  const def = b.sectionDefinitions.find((d) => d.sectionNumber === number)
  const section = def && b.sections.find((x) => x.sectionDefinitionId === def.id)
  if (!def || !section) {
    return NextResponse.json(
      { ok: false, error: `No section ${number} in this book.` }, { status: 404 },
    )
  }

  return NextResponse.json({
    ok: true,
    preview: previewUploads(read.files, {
      book: b.book, section: def, sectionId: section.id,
      existing: b.documents, expectedCount: section.expectedCount ?? null,
    }),
  })
}

/** Commit. Re-checks against the book as it is now, not as the preview saw it. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ bookId: string; sectionNumber: string }> },
) {
  const { bookId, sectionNumber } = await params
  const read = await readForm(request)
  if (!read.ok) return NextResponse.json({ ok: false, error: read.error }, { status: 400 })

  const viewer = await currentViewer()
  if (!viewer) return NextResponse.json({ ok: false, error: 'Not signed in.' }, { status: 401 })

  const result = await getDataProvider().addDocuments(
    viewer, bookId, decodeURIComponent(sectionNumber), read.files,
  )
  return NextResponse.json(result, { status: result.ok ? 201 : 422 })
}
