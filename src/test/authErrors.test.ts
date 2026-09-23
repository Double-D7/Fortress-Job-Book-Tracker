/**
 * Sign-in failure messages.
 *
 * The case that prompted this file is the real one from the auth log:
 * Resend answered `535 "Invalid username"`, Supabase wrapped it as "Error
 * sending magic link email", and the screen showed that to a person who
 * could do nothing about it.
 */
import { describe, expect, it } from 'vitest'
import { signInErrorMessage } from '@/lib/domain/authErrors'

/** Verbatim from the auth log and from the Supabase client. */
const SMTP_REJECTED = 'Error sending magic link email'
const SMTP_RAW = '535 "Invalid username"'

describe('a mail server that refuses the message', () => {
  it('says it is not the person’s fault and that retrying will not help', () => {
    const msg = signInErrorMessage(SMTP_REJECTED)
    expect(msg).toMatch(/not something you did/i)
    expect(msg).toMatch(/trying again will not/i)
    // And it must not be the raw text, which is the bug being fixed.
    expect(msg).not.toBe(SMTP_REJECTED)
  })

  it('recognises the underlying SMTP rejection too', () => {
    expect(signInErrorMessage(SMTP_RAW)).toMatch(/mail server refused it/i)
  })

  it('is not mistaken for a rate limit', () => {
    // The ordering that matters. Told to "wait a minute and try again", a
    // person will do that forever against a fault waiting cannot clear.
    expect(signInErrorMessage(SMTP_REJECTED)).not.toMatch(/wait a minute/i)
  })
})

describe('the other failures keep their own wording', () => {
  it('names an uninvited address as needing an admin', () => {
    expect(signInErrorMessage('User not found')).toMatch(/has not been invited/i)
  })

  it('still reports a genuine rate limit as one worth waiting out', () => {
    for (const raw of [
      'email rate limit exceeded',
      'For security purposes, you can only request this after 47 seconds.',
    ]) {
      expect(signInErrorMessage(raw), raw).toMatch(/wait a minute/i)
    }
  })

  it('explains sign-ups being switched off', () => {
    expect(signInErrorMessage('Signups not allowed for otp'))
      .toMatch(/has not been invited|Allow new users to sign up/i)
  })
})

describe('when it does not recognise the failure', () => {
  it('passes the original text through rather than inventing a reason', () => {
    // A wrong guess in a friendly sentence is worse than the raw string,
    // which can at least be searched for.
    const odd = 'connection reset by peer while dialing upstream'
    expect(signInErrorMessage(odd)).toBe(odd)
  })

  it('never answers with an empty string', () => {
    // Blank would render as a red box with nothing in it.
    for (const raw of [SMTP_REJECTED, 'User not found', 'something unmapped']) {
      expect(signInErrorMessage(raw).trim().length, raw).toBeGreaterThan(0)
    }
  })
})
