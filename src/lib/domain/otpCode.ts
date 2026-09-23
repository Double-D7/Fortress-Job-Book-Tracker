/**
 * The sign-in code.
 *
 * Sign-in links do not survive corporate mail. Microsoft Defender opens
 * every URL it delivers, and because a magic link is single-use, the scan
 * spends it — the auth log shows Microsoft fetching the link ninety
 * seconds before the person did, and the person then being told the link
 * was "invalid or has expired". Every operator and inspection company this
 * app sends to runs a scanner of the same kind, so this is not one tenant's
 * misconfiguration to work around.
 *
 * A number cannot be clicked. The code goes in the email, the person types
 * it into the tab they started in, and no scanner in the middle can spend
 * it on their behalf.
 *
 * ## Why the length is a range and not a number
 *
 * This first shipped assuming six digits. The project issues eight, so the
 * form would not accept the code it had just emailed — the field truncated
 * it and the button stayed disabled. The length is a server setting
 * (Supabase allows six to ten) and nothing in the browser is told what it
 * is, so a constant here is a guess that silently disagrees with the
 * email.
 *
 * Accepting the whole documented range is the fix. Getting this wrong
 * costs a person the ability to sign in at all, while accepting a range
 * costs nothing: the code is checked by the auth server, and a wrong
 * length simply fails there like any wrong code. This file is not a
 * security boundary and must not behave like one.
 *
 * Normalising the typed value matters just as much. People paste "123 456"
 * out of the mail app, or the code arrives with a stray newline, and a
 * form that answers "that code is wrong" to the right code typed correctly
 * is the most annoying possible bug.
 */

/** The shortest code the auth server will issue. */
export const OTP_MIN_LENGTH = 6
/** The longest. Beyond this the extra characters are not part of a code. */
export const OTP_MAX_LENGTH = 10

/**
 * What the person typed, reduced to what the auth server will accept.
 *
 * Digits only, capped at the longest code that can exist. Everything
 * else — spaces, hyphens, a pasted newline, an invisible character from a
 * mail client — is dropped rather than rejected, because all of it comes
 * from the email rather than from carelessness.
 */
export function normalizeOtpInput(raw: string): string {
  return raw.replace(/\D/g, '').slice(0, OTP_MAX_LENGTH)
}

/**
 * True when there is enough to be worth submitting.
 *
 * Deliberately permissive at the top end. The form cannot know whether
 * this project issues six digits or eight, so anything in range is offered
 * to the server rather than refused here — being wrong in this direction
 * produces one failed attempt, and being wrong in the other locks the
 * person out of a code that is perfectly valid.
 */
export function isCompleteOtp(value: string): boolean {
  return normalizeOtpInput(value).length >= OTP_MIN_LENGTH
}
