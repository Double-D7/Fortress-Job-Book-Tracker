/**
 * Saying what is wrong with a credential without saying the credential.
 *
 * "Invalid client secret provided" is true and nearly useless. It is the
 * same message whether the box holds a Secret ID, the application ID, a
 * value with a newline stuck to the end, or a correct secret that expired
 * last week — four different problems with four different fixes, and
 * finding out which costs a round trip through the portal each time.
 *
 * Setting this up took three. First the shared trigger secret did not
 * match. Then the client secret box held a Secret ID rather than a secret
 * Value, which is an easy mistake because Entra shows both columns side
 * by side and only one of them is ever visible again after you leave the
 * page. Then the ID and the secret were pasted into each other's boxes.
 * Every one of those is identifiable from the shape of the string alone.
 *
 * ## The rule this follows
 *
 * It describes; it never quotes. No branch returns any part of the value,
 * only its length and which pattern it matches. A diagnostic that solved
 * the problem by printing the secret would be worse than the vague
 * message it replaced.
 */

/** 8-4-4-4-12 hexadecimal: an Entra object identifier. */
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Entra client secret values are around 40 characters. Anything much
 *  shorter was not one, whatever else it was. */
const PLAUSIBLE_SECRET_LENGTH = 20

export interface ShapeContext {
  /** What `GRAPH_CLIENT_ID` holds, to catch the two being swapped. */
  clientId?: string
}

/**
 * One sentence about what is in the box, for appending to an auth error.
 *
 * Returns null when the value looks like what it should be — there is
 * nothing useful to add to the real error in that case, and a diagnostic
 * that comments on every failure trains people to skip reading it.
 */
export function describeCredentialShape(
  value: string | undefined | null,
  context: ShapeContext = {},
): string | null {
  if (!value) {
    return 'The configured value is empty.'
  }

  if (value !== value.trim()) {
    return 'The configured value has whitespace at the start or end, ' +
      'which usually came along with a copy and paste. Re-paste it without ' +
      'the trailing newline.'
  }

  if (context.clientId && value === context.clientId) {
    return 'The configured value is identical to GRAPH_CLIENT_ID, so the ' +
      'same string is in both boxes.'
  }

  if (GUID.test(value)) {
    return 'The configured value is formatted as a GUID. On the Entra ' +
      '"Certificates & secrets" page that is the Secret ID column, not the ' +
      'Value column — and the Value is only shown once, when the secret is ' +
      'first created. If the Value is no longer on screen, create a new ' +
      'client secret and copy the Value column this time.'
  }

  if (value.length < PLAUSIBLE_SECRET_LENGTH) {
    return `The configured value is ${value.length} characters, which is ` +
      'shorter than any Entra client secret.'
  }

  // Looks right. Whatever is wrong is not the shape — most likely the
  // secret has expired or belongs to a different app registration.
  return null
}
