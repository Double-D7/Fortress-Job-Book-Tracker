/**
 * Taking credentials back out of a message before it is stored.
 *
 * A failed backup run records why it failed, and that is the whole point
 * of the row: an absence of runs is the alarm, and a run that failed
 * without saying why is not much better than no run at all. But the text
 * comes from Microsoft, and Microsoft quotes the values it was handed
 * back at you.
 *
 * During setup that turned out to matter. A configuration where the
 * client ID and the client secret had been pasted into each other's boxes
 * produced:
 *
 *   AADSTS700016: Application with identifier 'Jgm8Q~...' was not found
 *
 * — the client secret, in clear text, written into `backup_run.error`,
 * where it is readable by anyone with database access and by every later
 * reader of the audit trail. The misconfiguration was fixed in minutes;
 * the credential sitting in a table was the part that would have lasted.
 *
 * ## Why this matches against known values rather than a pattern
 *
 * A regular expression loose enough to catch a client secret — a run of
 * forty-odd characters of mixed case and punctuation — also catches heat
 * numbers, weld identifiers, storage paths and job numbers. Redacting
 * those would gut the half of the message that makes a failure
 * diagnosable, and a message nobody can act on is how a backup stays
 * broken. So this is told exactly what the secrets are and removes those.
 */

/** Below this, a value is not a credential, and treating it as one would
 *  turn ordinary messages into a row of placeholders. */
const MIN_CREDENTIAL_LENGTH = 8

export const REDACTED = '[redacted credential]'

/**
 * Replace every occurrence of each credential with a marker.
 *
 * Empty, absent and implausibly short values are ignored rather than
 * matched, so an unconfigured deployment does not redact everything.
 */
export function redactCredentials(
  text: string,
  credentials: readonly (string | undefined | null)[],
): string {
  let out = text
  for (const credential of credentials) {
    if (!credential || credential.length < MIN_CREDENTIAL_LENGTH) continue
    // split/join rather than a regular expression: a credential is
    // arbitrary text and may contain characters a pattern would read as
    // syntax, which would either throw or match the wrong thing.
    out = out.split(credential).join(REDACTED)
  }
  return out
}
