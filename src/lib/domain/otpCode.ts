/**
 * The six-digit sign-in code.
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
 * Normalising the typed value matters more than it looks. People paste
 * "123 456" out of the mail app, or the code arrives with a stray newline,
 * and a form that answers "that code is wrong" to the right code typed
 * correctly is the most annoying possible bug.
 */

export const OTP_LENGTH = 6

/**
 * What the person typed, reduced to what Supabase will accept.
 *
 * Digits only, capped at the code length. Everything else — spaces,
 * hyphens, a pasted newline, an invisible character from a mail client —
 * is dropped rather than rejected, because all of it comes from the email
 * rather than from carelessness.
 */
export function normalizeOtpInput(raw: string): string {
  return raw.replace(/\D/g, '').slice(0, OTP_LENGTH)
}

/** True when there is a whole code to submit. */
export function isCompleteOtp(value: string): boolean {
  return normalizeOtpInput(value).length === OTP_LENGTH
}
