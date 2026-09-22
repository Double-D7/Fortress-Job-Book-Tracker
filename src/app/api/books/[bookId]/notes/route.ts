import { NextResponse } from 'next/server'
import { currentViewer, getDataProvider } from '@/lib/data/provider'

/**
 * Add a note to a book.
 *
 * Whether this person may is not decided here. For a Client Inspector it
 * depends on a grant row, which `inspector_comment_insert` reads in the
 * same statement as the insert — asking first would be a second copy of
 * the rule and a window between the two answers.
 */
export const dynamic = 'force-dynamic'

/** Long enough for a paragraph about a weld, short enough that a runaway
 *  paste does not become a record nobody can read. */
const MAX_BODY = 4000

export async function POST(
  request: Request,
  { params }: { params: Promise<{ bookId: string }> },
) {
  const { bookId } = await params
  const viewer = await currentViewer()
  if (!viewer) return NextResponse.json({ ok: false, error: 'Not signed in.' }, { status: 401 })

  let body: Record<string, unknown>
  try {
    body = (await request.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ ok: false, error: 'Malformed request.' }, { status: 400 })
  }

  const text = typeof body.body === 'string' ? body.body.trim() : ''
  if (!text) {
    return NextResponse.json(
      { ok: false, error: 'A note needs something in it.' }, { status: 400 },
    )
  }
  if (text.length > MAX_BODY) {
    return NextResponse.json(
      { ok: false, error: `That is longer than ${MAX_BODY} characters.` },
      { status: 400 },
    )
  }

  const visibility = body.visibility === 'client' ? 'client' as const
    : body.visibility === 'internal' ? 'internal' as const
    : undefined

  const result = await getDataProvider().addNote(viewer, bookId, {
    body: text,
    visibility,
    sectionNumber: typeof body.sectionNumber === 'string' && body.sectionNumber.trim()
      ? body.sectionNumber.trim() : null,
  })
  return NextResponse.json(result, { status: result.ok ? 200 : 422 })
}
