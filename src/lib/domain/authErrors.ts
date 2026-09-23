/**
 * Turning a sign-in failure into something the person reading it can act on.
 *
 * These messages are read by someone standing in a yard who wants to get
 * into a job book, so each one has to answer two questions: is this my
 * fault, and what do I do now. "Error sending magic link email" — which is
 * what Supabase returns when its mail server rejects the connection —
 * answers neither, and reads like the address was typed wrong.
 *
 * That one is worth naming precisely because it is a system fault that
 * looks like a user fault. Retrying cannot fix it and re-typing the
 * address cannot fix it; somebody with the Supabase dashboard has to.
 * Telling the person that saves them ten minutes of trying.
 *
 * Unrecognised failures fall through unchanged. A wrong guess dressed up
 * in a friendly sentence is worse than the raw text, because the raw text
 * can at least be searched for.
 */

/** What the database trigger raises, repeated here so both layers agree. */
const NOT_INVITED =
  'That address has not been invited to this system. Ask a Fortress admin to add you.'

export function signInErrorMessage(raw: string): string {
  if (/not been invited|signups not allowed|not found/i.test(raw)) return NOT_INVITED

  // Ordered before the rate-limit check on purpose: Supabase wraps an SMTP
  // rejection in the same generic 500 whatever caused it, and a person told
  // to "wait a minute and try again" will do exactly that, forever, on a
  // fault that waiting does not touch.
  if (/error sending|unexpected_failure|smtp|535|550|invalid username/i.test(raw)) {
    return 'The sign-in email could not be sent — this system’s mail server refused it. ' +
      'That is a fault in the setup, not something you did, and trying again will not ' +
      'clear it. Tell a Fortress admin.'
  }

  if (/rate limit|too many|only request this after/i.test(raw)) {
    return 'Too many sign-in emails have gone out recently. Wait a minute and try again.'
  }

  if (/signups? (are )?(not allowed|disabled)/i.test(raw)) {
    return 'Sign-ups are switched off for this project. Turn "Allow new users to sign up" ' +
      'back on in Supabase — the invitation list is what restricts access, and it is ' +
      'enforced in the database.'
  }

  return raw
}
