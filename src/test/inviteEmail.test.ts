/**
 * The invitation email.
 *
 * The button said "Invite" and sent nothing. `invite_user` was a
 * permission check and one INSERT, so an administrator added somebody,
 * told them to expect an email, and both of them waited for a message
 * no code path produced.
 *
 * What the message has to carry is not "accept this invitation" — there
 * is nothing to accept, the access already exists — but the one thing
 * nobody guesses: that the sign-in code is requested rather than sent.
 * Somebody who misses that waits for a second email that is never
 * coming, which is the same failure in a new place.
 */
import { describe, expect, it } from 'vitest'
import { buildInviteEmail, firstName } from '@/lib/domain/inviteEmail'
import { roleDefinition } from '@/lib/domain/roles'

const BASE = {
  fullName: 'Rodney Ring',
  role: 'fortress_admin' as const,
  invitedBy: 'David Devitt',
  appUrl: 'https://app.fortressqc.com',
}

describe('who it is addressed to', () => {
  it('greets by first name, which is how a person writes', () => {
    expect(firstName('Rodney Ring')).toBe('Rodney')
    expect(buildInviteEmail(BASE).text).toContain('Hello Rodney,')
  })

  it('copes with one name, extra spaces, and none at all', () => {
    expect(firstName('Cher')).toBe('Cher')
    expect(firstName('  Rodney   Ring ')).toBe('Rodney')
    expect(firstName('   ')).toBe('')
    expect(buildInviteEmail({ ...BASE, fullName: '   ' }).text).toContain('Hello,')
  })
})

describe('what it tells them to do', () => {
  const mail = buildInviteEmail(BASE)

  it('says the code is asked for, not waited for', () => {
    // The whole reason this email exists. Without this line the person
    // waits for a second message that nothing sends.
    expect(mail.text).toMatch(/we will email you a sign-in code/i)
    expect(mail.html).toMatch(/send you a sign-in code/i)
  })

  it('says there is nothing to accept and no password', () => {
    for (const body of [mail.text, mail.html]) {
      expect(body).toMatch(/nothing to accept/i)
      expect(body).toMatch(/no password/i)
    }
  })

  it('points at the sign-in page, not the bare domain', () => {
    expect(mail.text).toContain('https://app.fortressqc.com/login')
    expect(mail.html).toContain('https://app.fortressqc.com/login')
  })

  it('warns that a new code cancels the last one', () => {
    // Asking twice and then using the first code is the obvious way to
    // fail, and it reads as the application being broken.
    expect(mail.text).toMatch(/cancels the one before it/i)
    expect(mail.html).toMatch(/cancels the one before/i)
  })

  it('gives them a way to say they did not expect it', () => {
    expect(mail.text).toMatch(/were not expecting this/i)
  })
})

describe('what it tells them they have', () => {
  it('names the role in the words the application uses', () => {
    const mail = buildInviteEmail(BASE)
    expect(mail.text).toContain(roleDefinition('fortress_admin').label)
    expect(mail.text).toContain(roleDefinition('fortress_admin').summary)
  })

  it('names the operator for a role scoped to one', () => {
    const mail = buildInviteEmail({
      ...BASE, role: 'third_party_inspector', fullName: 'Pat Nakamura',
      orgName: 'Chevron',
    })
    expect(mail.text).toContain('Chevron')
  })

  it('does not invent an operator for a role that has none', () => {
    expect(buildInviteEmail(BASE).text).not.toMatch(/ for null| for undefined/)
  })

  it('says who added them, so it comes from a person', () => {
    expect(buildInviteEmail(BASE).text).toContain('David Devitt')
  })
})

describe('the shape of the message', () => {
  it('has a subject that reads as access granted, not as a request', () => {
    // "You have been invited" invites a reply asking what to do. This
    // says the thing is already true.
    expect(buildInviteEmail(BASE).subject).toBe(
      'You have access to the Fortress Job Book Tracker')
  })

  it('escapes a name that would otherwise break the markup', () => {
    const mail = buildInviteEmail({
      ...BASE, fullName: '<script>alert(1)</script> Ring',
      invitedBy: 'A & B <admin@example.invalid>',
    })
    expect(mail.html).not.toContain('<script>')
    expect(mail.html).toContain('&amp;')
  })

  it('carries both a text and an html body', () => {
    const mail = buildInviteEmail(BASE)
    expect(mail.text.length).toBeGreaterThan(100)
    expect(mail.html).toContain('<a href=')
  })
})
