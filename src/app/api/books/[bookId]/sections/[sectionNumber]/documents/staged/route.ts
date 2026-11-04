import { NextResponse } from 'next/server'
import { currentViewer, getDataProvider } from '@/lib/data/provider'
import {
  validateStagingRequest, type StagedFileRequest, type StagingClassification,
} from '@/lib/domain/staging'

/**
 * Hand the browser somewhere to put the files.
 *
 * This is the first half of an upload. It writes no document and moves
 * no bytes: it checks the batch, reserves a staging path per file and
 * returns a signed URL the browser uploads straight to. The second
 * half is the existing PUT (preview) and POST (commit) on the parent
 * route, which are told the upload id rather than the bytes.
 *
 * Nothing about the integrity contract changes. The server still hashes
 * what actually arrived — it reads each staged object back out of
 * storage rather than reading it out of a request body — so the
 * duplicate check remains the server's finding and not the browser's
 * word.
 */
export const dynamic = 'force-dynamic'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ bookId: string; sectionNumber: string }> },
) {
  const { bookId, sectionNumber } = await params
  const number = decodeURIComponent(sectionNumber)

  const viewer = await currentViewer()
  if (!viewer) return NextResponse.json({ ok: false, error: 'Not signed in.' }, { status: 401 })

  let body: { files?: unknown; classification?: unknown }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return NextResponse.json({ ok: false, error: 'Malformed request.' }, { status: 400 })
  }

  const files: StagedFileRequest[] = Array.isArray(body.files)
    ? body.files.flatMap((f) => {
      if (typeof f !== 'object' || f === null) return []
      const r = f as Record<string, unknown>
      return [{
        name: typeof r.name === 'string' ? r.name : '',
        size: typeof r.size === 'number' ? r.size : 0,
        mimeType: typeof r.mimeType === 'string' ? r.mimeType : null,
      }]
    })
    : []

  const problems = validateStagingRequest(files)
  if (problems.length > 0) {
    return NextResponse.json(
      { ok: false, error: problems.map((p) => p.message).join(' '), problems },
      { status: 422 },
    )
  }

  const classification: StagingClassification =
    typeof body.classification === 'object' && body.classification !== null
      ? body.classification as StagingClassification
      : {}

  const result = await getDataProvider().stageUploads(
    viewer, bookId, number, files, classification,
  )
  return NextResponse.json(result, { status: result.ok ? 200 : 422 })
}
