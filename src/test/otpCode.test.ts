/**
 * The typed sign-in code.
 *
 * Every case here is something a real person does with a code they were
 * emailed: paste it with the spaces, paste it with a trailing newline,
 * type it into a field that already had a stale one in it. A form that
 * answers "that code is wrong" to the right code entered one of those ways
 * is worse than no autofill at all, because the person has no way to tell
 * which of them is lying.
 */
import { describe, expect, it } from 'vitest'
import {
  OTP_MAX_LENGTH, OTP_MIN_LENGTH, isCompleteOtp, normalizeOtpInput,
} from '@/lib/domain/otpCode'
import { codeEntryErrorMessage } from '@/lib/domain/authErrors'

/**
 * The lengths a project can actually be configured to issue. This one
 * issues eight, which is what broke the first version of this module.
 */
const ISSUABLE_LENGTHS = [6, 7, 8, 9, 10]

describe('cleaning up what was typed or pasted', () => {
  it('takes a plain code unchanged', () => {
    expect(normalizeOtpInput('123456')).toBe('123456')
  })

  it('survives the ways a code gets pasted out of a mail app', () => {
    for (const pasted of [
      '123 456', '123-456', ' 123456 ', '123456\n', '\t123456', '1 2 3 4 5 6',
    ]) {
      expect(normalizeOtpInput(pasted), JSON.stringify(pasted)).toBe('123456')
    }
  })

  it('keeps leading zeros, which are part of the code', () => {
    // Anything that treated this as a number would drop them and submit a
    // four-digit code that can never match.
    expect(normalizeOtpInput('007123')).toBe('007123')
    expect(normalizeOtpInput('000000')).toBe('000000')
  })

  it('keeps a code of every length this server could issue', () => {
    // The bug this replaces: the field truncated to six, so the eight-digit
    // code the project had just emailed could not be entered at all.
    for (const len of ISSUABLE_LENGTHS) {
      const code = '1'.repeat(len)
      expect(normalizeOtpInput(code), `${len} digits`).toBe(code)
    }
  })

  it('stops beyond the longest code that can exist', () => {
    expect(normalizeOtpInput('1'.repeat(20))).toBe('1'.repeat(OTP_MAX_LENGTH))
  })

  it('drops letters rather than passing them to the server', () => {
    expect(normalizeOtpInput('code: 123456')).toBe('123456')
  })

  it('gives an empty string when there is nothing usable', () => {
    for (const junk of ['', '   ', 'abcdef', '---']) {
      expect(normalizeOtpInput(junk), junk).toBe('')
    }
  })
})

describe('knowing when there is a whole code to submit', () => {
  it('accepts a full code however it was pasted', () => {
    for (const v of ['123456', '123 456', '000000', '12345678', '1234 5678']) {
      expect(isCompleteOtp(v), v).toBe(true)
    }
  })

  it('enables the button for every length this server could issue', () => {
    // The whole point. A form that only accepts six digits cannot sign
    // anyone in on a project configured for eight, and the browser is
    // never told which it is.
    for (const len of ISSUABLE_LENGTHS) {
      expect(isCompleteOtp('1'.repeat(len)), `${len} digits`).toBe(true)
    }
  })

  it('rejects a partial one, so the button stays disabled', () => {
    for (const v of ['', '1', '12345', '12 34 5']) {
      expect(isCompleteOtp(v), v).toBe(false)
    }
    expect(isCompleteOtp('1'.repeat(OTP_MIN_LENGTH - 1))).toBe(false)
  })
})

describe('what a rejected code tells the person', () => {
  it('explains that a newer email cancels the older code', () => {
    // The commonest real cause: two codes requested, the older one typed.
    const msg = codeEntryErrorMessage('Token has expired or is invalid')
    expect(msg).toMatch(/most recent email/i)
    expect(msg).not.toBe('Token has expired or is invalid')
  })

  it('keeps a rate limit distinct from a wrong code', () => {
    expect(codeEntryErrorMessage('email rate limit exceeded')).toMatch(/wait a minute/i)
  })

  it('passes an unrecognised failure through verbatim', () => {
    const odd = 'upstream connect error'
    expect(codeEntryErrorMessage(odd)).toBe(odd)
  })
})
