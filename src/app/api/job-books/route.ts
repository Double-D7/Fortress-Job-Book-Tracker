import { NextResponse } from 'next/server'
import { redirect } from 'next/navigation'
import { currentViewer, getDataProvider } from '@/lib/data/provider'
import type { NewJobBookInput } from '@/lib/domain/scaffold'

/**
 * Create a job book.
 *
 * The role check lives in the provider and, for the persistent provider,
 * in `create_job_book()` itself — this route does not decide who may
 * create a book, it only carries the request.
 */
export async function POST(request: Request) {
  let input: NewJobBookInput
  try {
    input = (await request.json()) as NewJobBookInput
  } catch {
    return NextResponse.json(
      { ok: false, errors: [{ field: 'body', message: 'Malformed request.' }] },
      { status: 400 },
    )
  }

  const viewer = await currentViewer()
  if (!viewer) {
    return NextResponse.json(
      { ok: false, errors: [{ field: 'auth', message: 'Not signed in.' }] }, { status: 401 },
    )
  }

  const result = await getDataProvider().createJobBook(viewer, input)
  return NextResponse.json(result, { status: result.ok ? 201 : 422 })
}
