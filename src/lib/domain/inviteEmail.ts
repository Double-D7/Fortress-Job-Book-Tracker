/**
 * The message somebody gets when they are given access.
 *
 * The button said "Invite" and sent nothing. An administrator added
 * Rodney Ring, both of them waited for an email, and the invite function
 * was a permission check and one INSERT. Nothing in that path had ever
 * sent anything.
 *
 * ## What this has to explain
 *
 * Not "click here to accept". There is nothing to accept: the row in
 * `app_user` is what grants access, and it already exists by the time
 * this is sent. What the person actually needs is the one non-obvious
 * thing about signing in — that they ask for a code themselves, rather
 * than waiting to be sent one. Somebody who does not know that waits
 * for a second email that is never coming, which is the exact failure
 * this message exists to end.
 *
 * ## Why the role is named
 *
 * An administrator can see every book for every client. Somebody should
 * learn that from the message that granted it rather than by noticing
 * it later, and the person who sent it should see it quoted back.
 *
 * Pure: it builds text and returns it. The sending is somebody else's
 * job, so the wording can be tested without a network or a key.
 */
import { roleDefinition } from './roles'
import type { UserRole } from './types'

export interface InviteEmail {
  subject: string
  html: string
  text: string
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] ?? c))
}

/** First name where there is one, for the greeting. A message that opens
 *  "Hello Rodney" reads as written by a person; one that opens with a
 *  full legal name reads as sent by a system. */
export function firstName(fullName: string): string {
  return fullName.trim().split(/\s+/)[0] ?? ''
}

export function buildInviteEmail(input: {
  fullName: string
  role: UserRole
  /** Who added them, so the message is from somebody rather than from
   *  an application. */
  invitedBy: string
  appUrl: string
  /** The operator a client-side role is scoped to, where there is one. */
  orgName?: string | null
}): InviteEmail {
  const def = roleDefinition(input.role)
  const greeting = firstName(input.fullName)
  const scope = input.orgName
    ? `${def.label} for ${input.orgName}`
    : def.label
  const signIn = `${input.appUrl}/login`

  const lines = [
    greeting ? `Hello ${greeting},` : 'Hello,',
    '',
    `${input.invitedBy} has given you access to the Fortress Job Book Tracker `
      + `as ${scope}.`,
    '',
    def.summary,
    '',
    'To sign in:',
    '',
    `  1. Go to ${signIn}`,
    '  2. Enter this email address',
    '  3. We will email you a sign-in code; enter it',
    '',
    'There is nothing to accept and no password to set. Your access is '
      + 'already in place, and the code is how you prove the address is '
      + 'yours. Ask for a new code any time you need one; each new code '
      + 'cancels the one before it.',
    '',
    'If you were not expecting this, reply and tell us, and we will '
      + 'remove the access.',
  ]

  const html = `
<div style="font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif;max-width:560px;color:#16243A">
  <p style="font-size:14px;margin:0 0 14px">
    ${greeting ? `Hello ${escapeHtml(greeting)},` : 'Hello,'}
  </p>
  <p style="font-size:14px;line-height:1.5;margin:0 0 14px">
    ${escapeHtml(input.invitedBy)} has given you access to the
    <strong>Fortress Job Book Tracker</strong> as ${escapeHtml(scope)}.
  </p>
  <p style="font-size:13px;line-height:1.5;color:#3C4C66;margin:0 0 18px">
    ${escapeHtml(def.summary)}
  </p>

  <a href="${escapeHtml(signIn)}"
     style="display:inline-block;background:#5B4BE0;color:#fff;text-decoration:none;
            font-size:14px;font-weight:600;padding:10px 18px;border-radius:6px">
    Sign in
  </a>

  <p style="font-size:13px;line-height:1.6;color:#3C4C66;margin:18px 0 0">
    Enter this email address and we will send you a sign-in code. There is
    nothing to accept and no password to set: your access is already in
    place, and the code is how you prove the address is yours. Ask for a
    new code whenever you need one, and use the most recent email, because
    each new code cancels the one before it.
  </p>
  <p style="font-size:11px;color:#6C7B91;line-height:1.5;margin:16px 0 0">
    If you were not expecting this, reply and tell us, and we will remove
    the access.
  </p>
</div>`.trim()

  return {
    subject: `You have access to the Fortress Job Book Tracker`,
    html,
    text: lines.join('\n'),
  }
}
