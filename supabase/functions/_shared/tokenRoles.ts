/**
 * What an app-only token is actually allowed to do.
 *
 * `Sites.Selected` takes two separate grants and fails identically when
 * either is missing:
 *
 *   1. An administrator consents to `Sites.Selected` on the app
 *      registration, which puts the role in every token the app gets.
 *   2. Somebody grants that app access to one named site, which is a
 *      different object entirely, created by POSTing to that site.
 *
 * Both have to be in place. Graph answers a request missing either one
 * with `accessDenied` and nothing else, so from the outside "the app was
 * never consented" and "the app was consented but has no grant on this
 * site" look exactly the same — and the obvious thing to check, the site
 * permission, is the one more likely to already be correct, because it is
 * the step somebody remembers doing.
 *
 * The token itself says which of the two is missing. A JWT's payload is
 * not encrypted, only signed, so the `roles` claim can be read without
 * any secret: an empty `roles` is a consent that never happened, and
 * `roles: ["Sites.Selected"]` with a denial is a grant on the wrong site.
 *
 * ## What is safe to report
 *
 * The role names, and nothing else. They are the names of permissions, no
 * more sensitive than the documentation that lists them. The token they
 * came from is a bearer credential and must never be recorded — this
 * module returns no part of it.
 */

/** Permission the backup needs in the token for a site grant to mean
 *  anything. */
export const REQUIRED_ROLE = 'Sites.Selected'

function decodeSegment(segment: string): unknown {
  // JWTs use base64url, which differs from base64 in two characters and
  // in dropping the padding.
  const base64 = segment.replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
  return JSON.parse(atob(padded))
}

/**
 * The application roles a token carries.
 *
 * Returns null when the token cannot be read at all, which is different
 * from an empty list: the first means we learned nothing, the second
 * means we learned that the app was granted nothing.
 */
export function rolesFromAccessToken(token: string): string[] | null {
  const segments = token.split('.')
  const payload = segments.length === 3 ? segments[1] : undefined
  if (!payload) return null

  try {
    const claims = decodeSegment(payload)
    if (typeof claims !== 'object' || claims === null) return null
    const roles = (claims as { roles?: unknown }).roles
    if (!Array.isArray(roles)) return []
    return roles.filter((r): r is string => typeof r === 'string')
  } catch {
    // A token we cannot parse is not worth an error of its own; the
    // caller still has the real failure to report.
    return null
  }
}

/**
 * One sentence about why a denial happened, for appending to a 403.
 *
 * Returns null when the token holds the role it needs — in that case the
 * permission really is the site grant, and the caller's own message
 * already says so.
 */
export function describeTokenRoles(
  token: string,
  required: string = REQUIRED_ROLE,
): string | null {
  const roles = rolesFromAccessToken(token)
  if (roles === null) return null

  if (roles.length === 0) {
    return `The access token carries no application roles at all, so ` +
      `${required} was never consented. A site permission cannot help ` +
      `until it is: in Entra, open the app registration, go to API ` +
      `permissions, and use "Grant admin consent". Adding the permission ` +
      `is not the same as consenting to it, and an unconsented one sits ` +
      `in that list looking much like a granted one.`
  }

  if (!roles.includes(required)) {
    return `The access token carries ${roles.join(', ')} but not ` +
      `${required}, so the site grant has nothing to attach to.`
  }

  return null
}
