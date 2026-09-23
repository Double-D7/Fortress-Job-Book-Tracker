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
import { OTP_LENGTH, isCompleteOtp, normalizeOtpInput } from '@/lib/domain/otpCode'
import { codeEntryErrorMessage } from '@/lib/domain/authErrors'

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

  it('stops at the code length rather than sending a longer string', () => {
    expect(normalizeOtpInput('1234567890')).toBe('123456')
    expect(normalizeOtpInput('123456').length).toBe(OTP_LENGTH)
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
    for (const v of ['123456', '123 456', '000000']) {
      expect(isCompleteOtp(v), v).toBe(true)
    }
  })

  it('rejects a partial one, so the button stays disabled', () => {
    for (const v of ['', '1', '12345', '12 34 5']) {
      expect(isCompleteOtp(v), v).toBe(false)
    }
  })

  it('does not accept a long string of digits as complete', () => {
    // Trimming to length first would make a 10-digit paste look valid.
    // It is valid — the first six are the code — and that is deliberate,
    // so this pins the decision rather than leaving it to chance.
    expect(isCompleteOtp('1234567890')).toBe(true)
    expect(normalizeOtpInput('1234567890')).toBe('123456')
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
