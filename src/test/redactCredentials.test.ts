/**
 * A failed backup run says why it failed, without saying the password.
 *
 * These cases are written from a real one. During setup the Entra client
 * ID and client secret were pasted into each other's boxes, and Microsoft
 * replied by quoting the identifier it had been given — which was the
 * secret. That text went straight into `backup_run.error`, where it sat
 * in clear text for anyone with database access to read.
 *
 * The fix has to hold two things at once. The credential must come out,
 * and everything that makes the message diagnosable must stay in,
 * because a run that failed and cannot say why leaves the backup broken
 * just as surely as one that never ran.
 */
import { describe, expect, it } from 'vitest'
import { REDACTED, redactCredentials } from '../../supabase/functions/_shared/redact'

/** Shaped like the real one, and not a real credential. */
const SECRET = 'Kpr7Q~aa11bb22cc33dd44ee55ff66gg77hh88ii9'
const TRIGGER_SECRET = 'f3c9a1d7e5b20486af19c73de8205b64'

describe('the message Microsoft sends back', () => {
  it('does not keep a client secret quoted inside it', () => {
    const entra =
      `AADSTS700016: Application with identifier '${SECRET}' was not found ` +
      `in the directory 'b67c798f-470b-4f22-8627-e812fcde75c7'.`
    const safe = redactCredentials(entra, [SECRET, TRIGGER_SECRET])

    expect(safe).not.toContain(SECRET)
    expect(safe).toContain(REDACTED)
  })

  it('still says what went wrong and where', () => {
    // The half that makes it actionable: the error code, the tenant, and
    // the sentence explaining the cause.
    const entra =
      `AADSTS700016: Application with identifier '${SECRET}' was not found ` +
      `in the directory 'b67c798f-470b-4f22-8627-e812fcde75c7'. This can happen ` +
      `if the application has not been installed by the administrator.`
    const safe = redactCredentials(entra, [SECRET])

    expect(safe).toContain('AADSTS700016')
    expect(safe).toContain('b67c798f-470b-4f22-8627-e812fcde75c7')
    expect(safe).toContain('has not been installed by the administrator')
  })

  it('removes the credential everywhere it appears, not just the first time', () => {
    const twice = `sent ${SECRET} and retried with ${SECRET}`
    expect(redactCredentials(twice, [SECRET]).split(REDACTED)).toHaveLength(3)
  })

  it('removes the trigger secret too', () => {
    // A different credential, from a different source, in the same run.
    const text = `called with x-backup-secret ${TRIGGER_SECRET}`
    expect(redactCredentials(text, [SECRET, TRIGGER_SECRET]))
      .not.toContain(TRIGGER_SECRET)
  })
})

describe('what it leaves alone', () => {
  it('keeps the job and heat numbers a failure is diagnosed by', () => {
    // The reason this matches known values instead of a pattern: anything
    // loose enough to catch a 40-character secret also catches these.
    const text = 'DP-318: heat D07821 weld 12 failed at 15. MTRs/UNEX 5155.pdf'
    expect(redactCredentials(text, [SECRET, TRIGGER_SECRET])).toBe(text)
  })

  it('does not redact everything when nothing is configured', () => {
    // An unset secret is the empty string, and matching on it would
    // replace between every character of the message.
    const text = 'Not configured: GRAPH_CLIENT_SECRET is not set.'
    expect(redactCredentials(text, [undefined, null, ''])).toBe(text)
  })

  it('ignores a value too short to be a credential', () => {
    expect(redactCredentials('status ok', ['ok'])).toBe('status ok')
  })

  it('handles a credential containing regular-expression syntax', () => {
    // Client secrets carry ~ . * + and friends. A pattern-based
    // implementation would either throw here or match the wrong span.
    const awkward = 'a+b.c*d(e)f[g]~h$i^j'
    expect(redactCredentials(`gave ${awkward} away`, [awkward]))
      .toBe(`gave ${REDACTED} away`)
  })
})
