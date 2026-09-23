/**
 * The canonical-host redirect.
 *
 * Two failure modes are worth more than the rest put together, and both
 * are tested here rather than discovered in production: a rule that loops
 * forever, and a rule that drops the query string off `/auth/callback` and
 * so destroys the single-use sign-in code it was carrying.
 */
import { describe, expect, it } from 'vitest'
import { canonicalTarget, type CanonicalRequest } from '@/lib/domain/canonicalHost'

const CANONICAL = 'app.fortressqc.com'
const VERCEL = 'fortress-job-book-tracker.vercel.app'

/** A production request from the Vercel alias, unless overridden. */
function req(over: Partial<CanonicalRequest> = {}): CanonicalRequest {
  return {
    host: VERCEL,
    path: '/',
    search: '',
    canonicalHost: CANONICAL,
    isProduction: true,
    ...over,
  }
}

describe('moving a request to the canonical host', () => {
  it('sends the Vercel alias to the custom domain', () => {
    expect(canonicalTarget(req())).toBe(`https://${CANONICAL}/`)
  })

  it('does not redirect a request that is already there', () => {
    // The loop guard. If this ever returns a target, every page on the
    // live site redirects to itself until the browser gives up.
    expect(canonicalTarget(req({ host: CANONICAL }))).toBeNull()
  })

  it('ignores the case of the host header', () => {
    // Host is case-insensitive, and a capitalised one arriving here must
    // not read as "somewhere else" and bounce forever.
    expect(canonicalTarget(req({ host: 'APP.FortressQC.com' }))).toBeNull()
    expect(canonicalTarget(req({ canonicalHost: 'App.FortressQC.com' })))
      .toBe(`https://app.fortressqc.com/`)
  })

  it('carries the path across', () => {
    expect(canonicalTarget(req({ path: '/books/book-dp452/materials' })))
      .toBe(`https://${CANONICAL}/books/book-dp452/materials`)
  })

  it('carries the query across, which is what saves a sign-in link', () => {
    // `/auth/callback?code=…` is the whole reason the query is preserved.
    // The code works once; arriving without it means an error page and a
    // second email, which is the problem this file exists to end.
    const to = canonicalTarget(req({
      path: '/auth/callback', search: '?code=abc123&next=%2Fbooks',
    }))
    expect(to).toBe(`https://${CANONICAL}/auth/callback?code=abc123&next=%2Fbooks`)
  })
})

describe('when it must not act', () => {
  it('leaves preview deployments alone', () => {
    // A preview is deliberately its own origin. Sending it to production
    // would mean testing a branch silently against the live app.
    expect(canonicalTarget(req({ isProduction: false }))).toBeNull()
  })

  it('does nothing when no canonical host is declared', () => {
    // Local development and any self-hosted copy. Absence of the setting
    // has to mean "serve it here", not "guess".
    for (const v of [undefined, '', '   ']) {
      expect(canonicalTarget(req({ canonicalHost: v })), String(v)).toBeNull()
    }
  })

  it('does nothing without a host header', () => {
    for (const v of [null, '', '  ']) {
      expect(canonicalTarget(req({ host: v })), String(v)).toBeNull()
    }
  })

  it('refuses a canonical host that is not a bare hostname', () => {
    // `https://app.fortressqc.com` pasted into the setting would build
    // `https://https://app…`, which fails on every request including the
    // sign-in page. Serving normally is the safe direction.
    for (const bad of [
      'https://app.fortressqc.com',
      'app.fortressqc.com/',
      'app.fortressqc.com:443',
      'app fortressqc com',
    ]) {
      expect(canonicalTarget(req({ canonicalHost: bad })), bad).toBeNull()
    }
  })

  it('never returns a target equal to the host it was given', () => {
    // A redirect to yourself is an infinite loop however it was reached.
    // Stated once, over every case above, so a future change to the
    // normalising cannot reintroduce one quietly.
    for (const host of [VERCEL, CANONICAL, 'APP.FORTRESSQC.COM', 'other.example']) {
      const to = canonicalTarget(req({ host, path: '/books' }))
      if (to === null) continue
      expect(new URL(to).host, host).not.toBe(host.toLowerCase())
    }
  })
})
