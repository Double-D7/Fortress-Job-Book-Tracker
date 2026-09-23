/**
 * One front door.
 *
 * This application answers on more than one hostname. `app.fortressqc.com`
 * and the Vercel-assigned `fortress-job-book-tracker.vercel.app` serve the
 * same deployment, backed by the same database, and until now neither
 * redirected to the other.
 *
 * A session cookie belongs to an origin. Sign in on one hostname and open
 * the other and the browser has nothing to send, so the middleware sees an
 * anonymous visitor and shows the sign-in page — on an app where nothing
 * has expired and the previous session is still alive and refreshable.
 * `auth.sessions` bears this out: every session ever created on this
 * project still carries a live refresh token, and one of them refreshed
 * cleanly across a ten-hour overnight gap. The sessions were never the
 * problem, which is why lengthening them would have fixed nothing.
 *
 * So the rule is that there is one canonical hostname and everything else
 * moves to it. Path and query come along, which matters most for
 * `/auth/callback?code=…` — the sign-in code is single-use, and a redirect
 * that dropped the query would burn it.
 *
 * Kept as a pure function rather than written inline in the middleware for
 * the usual reason in this codebase: a redirect rule that can only be
 * exercised by deploying it is a redirect rule nobody checks, and the
 * failure mode of getting it wrong is an infinite loop on the front page.
 */

export type CanonicalRequest = {
  /** The `Host` header as sent. May carry a port in development. */
  host: string | null
  /** Path only, leading slash. */
  path: string
  /** Query string including `?`, or empty. */
  search: string
  /** `CANONICAL_HOST`. Unset means no canonical hostname is declared. */
  canonicalHost: string | undefined
  /**
   * Production only. Preview deployments are *meant* to be separate
   * origins — collapsing them onto production would defeat the point of
   * having them, and would send someone testing a branch to the live app
   * without telling them.
   */
  isProduction: boolean
}

/**
 * The absolute URL to redirect to, or null to serve the request here.
 *
 * Null whenever anything is unclear rather than guessing. A wrong answer
 * here does not degrade gracefully — it either loops forever or sends
 * people off the app entirely.
 */
export function canonicalTarget(req: CanonicalRequest): string | null {
  const canonical = req.canonicalHost?.trim().toLowerCase()
  if (!canonical || !req.isProduction) return null

  // A host header with no value is not something to act on; some probes
  // send none at all.
  const host = req.host?.trim().toLowerCase()
  if (!host) return null

  // Already home. This is the check that stops the loop, so it compares
  // the same normalised form that is written into the target below.
  if (host === canonical) return null

  // A canonical host carrying a scheme or a path is a misconfiguration.
  // Redirecting to `https://https://app…` would fail on every request,
  // including the sign-in page, so refuse it and keep serving.
  if (/[/:\s]/.test(canonical)) return null

  return `https://${canonical}${req.path}${req.search}`
}
