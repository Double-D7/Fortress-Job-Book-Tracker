/**
 * Sending one email from the web application.
 *
 * Server only, by where it is called rather than by a guard: the key is
 * read from `process.env` without a NEXT_PUBLIC prefix, so a client
 * bundle importing this would get undefined and send nothing rather
 * than leak anything. `server-only` is not a dependency of this project
 * and is not worth adding for one module.
 *
 * The digest, the alerter and the backup all send from Edge Functions,
 * where the Resend key already lives. This is the first thing the web
 * deployment itself has to send, because an invitation is a reply to
 * something an administrator just did and they should be told then and
 * there whether it went.
 *
 * ## Why it never throws
 *
 * The thing it accompanies has already happened. An invited person is
 * invited whether or not the message reached them, and a throw here
 * would unwind a successful action or tempt a retry that then fails as
 * a duplicate. So this reports, and the caller decides what to say.
 *
 * ## Why the key is read per call
 *
 * Read at module load it would be captured at build time, and a key
 * added to the deployment afterwards would appear to do nothing until
 * somebody redeployed. The cost of reading it per call is nothing.
 */

export type SendResult =
  | { ok: true }
  /** Nothing was attempted: no key is configured on this deployment. */
  | { ok: false; reason: 'not_configured'; error: string }
  /** Resend was asked and refused, or could not be reached. */
  | { ok: false; reason: 'refused'; error: string }

const FROM_FALLBACK = 'Fortress Job Book Tracker <noreply@fortressqc.com>'

export async function sendEmail(input: {
  to: string
  subject: string
  html: string
  text: string
  replyTo?: string | null
}): Promise<SendResult> {
  const key = process.env.RESEND_API_KEY
  if (!key) {
    return {
      ok: false,
      reason: 'not_configured',
      error: 'No RESEND_API_KEY is set on this deployment, so no email was sent.',
    }
  }

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: process.env.DIGEST_FROM ?? FROM_FALLBACK,
        to: [input.to],
        subject: input.subject,
        html: input.html,
        text: input.text,
        // So a reply reaches the person who sent it rather than a
        // noreply box nobody reads.
        ...(input.replyTo ? { reply_to: input.replyTo } : {}),
      }),
    })

    if (!res.ok) {
      const detail = await res.text()
      // Deliberately not redacted here: the key is never echoed by
      // Resend, and the caller shows this to an administrator who needs
      // the real reason. What it must not do is reach a stored row, and
      // nothing here writes one.
      return { ok: false, reason: 'refused', error: `Resend ${res.status}: ${detail}` }
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, reason: 'refused', error: String(e) }
  }
}
