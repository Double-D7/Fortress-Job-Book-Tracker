/**
 * How much can go in one upload request, and what to say when it cannot.
 *
 * ## The gap this closes
 *
 * The section upload route guards a batch at 512 MB, with a comment
 * saying a book runs to hundreds of megabytes. That is true of a book
 * and false of a request: the platform this is deployed on refuses a
 * function request body far smaller than that, and it refuses it at the
 * edge, before any of our code runs.
 *
 * So the route's own limit was never the one that applied. A QA/QC
 * Manager uploading marked-up isometrics — large scans, and there are
 * 89 of them on one section — hit the platform ceiling instead.
 *
 * ## Why the message was wrong
 *
 * Every uploader in this application does the same thing:
 *
 *     const res = await fetch(...)
 *     const json = await res.json()      // throws on a non-JSON body
 *     ...
 *     } catch { setError('Could not reach the server.') }
 *
 * A platform rejection is an HTML error page, not JSON, so `res.json()`
 * throws and lands in the same catch as a dropped connection. The
 * person is told the server was unreachable when the server answered
 * immediately and said the upload was too big. That sends somebody
 * looking at their wifi instead of at the file size.
 *
 * `describeUploadFailure` separates the two, and `tooLargeFor` catches
 * it in the browser first — a request that cannot succeed should not be
 * sent, and a 60 MB upload should fail in the instant it is chosen
 * rather than after it has been pushed up a site connection.
 */

/**
 * The most this application will put in one request body.
 *
 * Set below the platform's own ceiling rather than at it. Multipart
 * framing, the field names, the boundary markers and the classification
 * JSON all ride along with the files, so a batch measured at exactly
 * the limit arrives over it. The headroom is what stops a guard that
 * passes and a platform that refuses.
 */
export const MAX_REQUEST_BYTES = 4 * 1024 * 1024

/** The same number in the words a person uses. */
export const MAX_REQUEST_LABEL = '4 MB'

function mb(n: number): string {
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export interface Oversize {
  /** Total of the batch, so the message can say how far over it is. */
  totalBytes: number
  /** Files that are over the limit on their own. These cannot be fixed
   *  by batching and need a different route entirely. */
  individuallyOversize: string[]
  message: string
}

/**
 * Whether this batch can be sent at all, and what to say if not.
 *
 * Returns null when it fits. The distinction that matters is between a
 * batch that is too big — split it — and a single file that is too big,
 * which no amount of splitting will fix and which needs saying plainly
 * rather than leaving somebody to discover it one file at a time.
 */
export function tooLargeFor(
  files: readonly { name: string; size: number }[],
  limit: number = MAX_REQUEST_BYTES,
): Oversize | null {
  const totalBytes = files.reduce((sum, f) => sum + f.size, 0)
  if (totalBytes <= limit) return null

  const individuallyOversize = files.filter((f) => f.size > limit).map((f) => f.name)

  if (individuallyOversize.length > 0) {
    const names = individuallyOversize.slice(0, 3).join(', ')
    const more = individuallyOversize.length > 3
      ? ` and ${individuallyOversize.length - 3} more`
      : ''
    return {
      totalBytes,
      individuallyOversize,
      message:
        `${names}${more} ${individuallyOversize.length === 1 ? 'is' : 'are'} over `
        + `${MAX_REQUEST_LABEL} on its own, which is the most this upload can carry in `
        + `one request. Splitting the batch will not help. Reduce the scan resolution, `
        + `or send it to a QA/QC administrator to file another way.`,
    }
  }

  return {
    totalBytes,
    individuallyOversize: [],
    message:
      `That batch is ${mb(totalBytes)}; one upload can carry ${MAX_REQUEST_LABEL}. `
      + `Choose fewer files at a time — the section keeps everything already filed, `
      + `so several smaller batches land exactly the same as one large one.`,
  }
}

/**
 * What actually went wrong with an upload response.
 *
 * Called instead of a bare `catch`, so a size rejection, a timeout and
 * a genuinely dropped connection stop sharing one sentence.
 *
 * `response` is null when `fetch` itself threw, which is the only case
 * that really is a connection problem.
 */
export function describeUploadFailure(
  response: { status: number; ok: boolean } | null,
  parseFailed: boolean,
): string {
  // "Nothing was filed" is said ONLY where it is certainly true.
  //
  // A request refused for its size never reached the route, so nothing
  // can have been written. A timeout or a dropped connection is a
  // different matter: the function may have been part way through a
  // commit when the answer stopped coming back. Telling somebody
  // nothing landed, when something may have, is how a duplicate gets
  // filed deliberately.
  const CHECK_FIRST = 'Check the documents list below before sending it again, '
    + 'in case some of it landed.'

  if (!response) {
    return `Could not reach the server. ${CHECK_FIRST}`
  }

  if (response.status === 413) {
    return `That upload is over ${MAX_REQUEST_LABEL}, which is the most one request `
      + `can carry. Choose fewer files at a time — nothing was filed.`
  }

  // A gateway timeout, or a function that ran out of its allotted time.
  // Large uploads reach this one by being slow rather than by being
  // refused, and the answer is the same: send less at once.
  if (response.status === 504 || response.status === 502) {
    return `The upload took too long and was cut off. Choose fewer files at a time. `
      + CHECK_FIRST
  }

  if (response.status === 401 || response.status === 403) {
    return 'Your session has expired. Sign in again and the files will be here.'
  }

  if (parseFailed) {
    // An answer arrived and was not ours. Almost always the platform
    // refusing the request before the route ran — but "almost always"
    // is not "certainly", so this does not claim nothing was written.
    return `The server refused the upload before it reached the application `
      + `(HTTP ${response.status}). If the batch is large, choose fewer files at a `
      + `time. ${CHECK_FIRST}`
  }

  return `The upload failed (HTTP ${response.status}). ${CHECK_FIRST}`
}

export interface JsonResult<T> {
  ok: boolean
  data?: T
  error?: string
}

/**
 * Send a request and read a JSON answer, without the two failure modes
 * collapsing into one message.
 */
export async function postForJson<T>(
  url: string, init: RequestInit,
): Promise<JsonResult<T>> {
  let response: Response
  try {
    response = await fetch(url, init)
  } catch {
    return { ok: false, error: describeUploadFailure(null, false) }
  }

  // An expired session is bounced to the sign-in page by the
  // middleware, which answers 200 with HTML. Without this the generic
  // branch below reports "the server refused the upload (HTTP 200)",
  // which reads as nonsense and hides the one thing the person needs
  // to do. Checked before parsing, because HTML never parses as JSON
  // and the failure would otherwise be indistinguishable from a
  // platform error page.
  if (response.redirected && new URL(response.url).pathname.startsWith('/login')) {
    return {
      ok: false,
      error: 'Your session has expired. Sign in again and choose the files once more — '
        + 'nothing was filed.',
    }
  }

  let parsed: unknown
  let parseFailed = false
  try {
    parsed = await response.json()
  } catch {
    parseFailed = true
  }

  if (parseFailed || !response.ok) {
    // The application's own refusals are JSON and carry their own
    // wording, which is better than anything derivable from a status.
    const fromApp = (parsed as { error?: string } | undefined)?.error
    return {
      ok: false,
      error: fromApp ?? describeUploadFailure(response, parseFailed),
    }
  }

  const body = parsed as { ok?: boolean; error?: string }
  if (body?.ok === false) return { ok: false, error: body.error ?? 'That did not work.' }
  return { ok: true, data: parsed as T }
}
