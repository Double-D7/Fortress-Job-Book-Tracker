import { NextResponse } from 'next/server'
import { reportError } from '@/lib/errors/report'

/**
 * Failures that happened in the browser.
 *
 * `onRequestError` sees everything thrown on the server, which is most
 * of it, but a component that throws after it reaches the browser never
 * touches the server at all. Those arrive here from the error boundary.
 *
 * Unauthenticated on purpose: a failure on the sign-in screen is the one
 * most worth hearing about, and the caller there has no session. Nothing
 * in the body is trusted as identity — `report_error` reads the actor
 * from the session, or records nobody.
 */
export const dynamic = 'force-dynamic'

/** A browser can post anything. Enough for a stack, not enough to use
 *  this as storage. */
const MAX_FIELD = 4000

function text(value: unknown): string {
  return typeof value === 'string' ? value.slice(0, MAX_FIELD) : ''
}

export async function POST(request: Request) {
  let body: Record<string, unknown>
  try {
    body = (await request.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 })
  }

  const message = text(body.message)
  if (!message) return NextResponse.json({ ok: false }, { status: 400 })

  const result = await reportError({
    name: text(body.name) || 'Error',
    message,
    stack: text(body.stack) || undefined,
    route: text(body.route) || null,
  })

  // The reference goes back so the boundary could show it. Reporting
  // never fails the caller: there is nothing useful for a browser to do
  // about a failed report of a failure.
  return NextResponse.json({ ok: true, reference: result?.reference ?? null })
}
