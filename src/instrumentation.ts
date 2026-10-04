/**
 * Where every server-side failure is caught.
 *
 * `onRequestError` is the framework's one hook that sees everything
 * thrown on the server: server components, route handlers, the
 * rendering of a page. Before this existed, nothing in the application
 * observed a throw at all — the person who hit it saw a generic screen
 * and was the only one who knew.
 *
 * Node runtime only. The edge runtime has no access to the reporting
 * path and would fail differently on a path that is already failing.
 */
import type { Instrumentation } from 'next'

export const onRequestError: Instrumentation.onRequestError = async (
  err, request, context,
) => {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return

  try {
    const { reportError } = await import('@/lib/errors/report')
    const error = err as { name?: string; message?: string; stack?: string }

    await reportError({
      name: error.name ?? 'Error',
      message: error.message ?? String(err),
      stack: error.stack,
      // The matched route rather than the URL: `/books/[bookId]/nde`
      // groups every book together, where the URL would make one fault
      // per book and bury the pattern.
      route: context.routePath ?? request.path ?? null,
    })
  } catch {
    // Reporting is best effort. Throwing here would replace a failed
    // page with a failed error handler.
  }
}
