/**
 * The daily digest, sent from inside Supabase.
 *
 * WHY HERE RATHER THAN A VERCEL CRON. The digest reads every
 * recipient's unread notes to send each of them their own, so it cannot
 * run under any one person's session — it needs the service role. And
 * DEPLOY.md says, of the web deployment: "If a SUPABASE_SERVICE_ROLE_KEY
 * is already set on the deployment from an earlier setup, clear it. An
 * unused secret is still a secret sitting somewhere it is not needed."
 *
 * Running here keeps that true. Supabase injects the service role into
 * its own functions, Vercel never holds it, and the Resend key lives
 * beside it rather than in a third place.
 *
 * The composition — who gets what, in what order, worded how — is in
 * ../_shared/digest.ts, which the Next.js app imports too. One file,
 * two runtimes, so the email and the screen cannot disagree about what
 * a Critical note is called.
 *
 * FAILURE BEHAVIOUR, WHICH IS THE PART WORTH READING. Each recipient is
 * sent and then marked, one at a time. A run that dies in the middle
 * therefore re-sends nobody and drops nobody: whoever was sent is
 * marked, whoever was not is still pending and goes tomorrow. The
 * alternative — mark the batch, then send — loses somebody's mail
 * silently the first time the provider has a bad minute.
 */
import { createClient } from 'jsr:@supabase/supabase-js@2'
import {
  buildDigests, digestHtml, digestText, type DigestRow,
} from '../_shared/digest.ts'

const APP_URL = Deno.env.get('APP_URL') ?? 'https://app.fortressqc.com'
const FROM = Deno.env.get('DIGEST_FROM') ?? 'Fortress Job Book Tracker <noreply@fortressqc.com>'
const RESEND_KEY = Deno.env.get('RESEND_API_KEY')
/** Shared secret so only pg_cron can trigger a run. */
const DIGEST_SECRET = Deno.env.get('DIGEST_SECRET')

/**
 * How old a note must be before it is emailed.
 *
 * An hour by default: somebody reading the app right now does not need
 * a message about a note they are looking at, and `read_at` will have
 * been set by the time the next run comes round.
 */
const MIN_AGE_MINUTES = Number(Deno.env.get('DIGEST_MIN_AGE_MINUTES') ?? '60')

/**
 * What the provider said.
 *
 * `id` is Resend's message id, which is the only handle that lets
 * somebody look a message up afterwards and ask why it did not arrive.
 * The first version of this discarded it and recorded a count of
 * failures — enough to know something was wrong, useless for knowing
 * what, and it cost a round of blind guessing the first time a digest
 * was accepted and never delivered.
 *
 * ACCEPTANCE IS NOT DELIVERY. A 200 from Resend means the message was
 * queued, not that it reached a mailbox; it can still bounce, or be
 * filed as spam. The run log now carries the id so the difference is
 * checkable rather than assumed.
 */
interface SendResult { ok: boolean; id?: string; error?: string }

/**
 * Constant-time string comparison.
 *
 * Written out rather than reached for: Deno's global `crypto` is the Web
 * Crypto API, which has no `timingSafeEqual` — that is Node's. Using it
 * here would have thrown on the first request and failed closed, which
 * is the safe direction but would have meant no digest ever went out.
 */
function secretMatches(given: string | null, expected: string): boolean {
  if (given === null || given.length !== expected.length) return false
  let diff = 0
  for (let i = 0; i < expected.length; i++) {
    diff |= given.charCodeAt(i) ^ expected.charCodeAt(i)
  }
  return diff === 0
}

async function sendEmail(
  to: string, subject: string, html: string, text: string,
): Promise<SendResult> {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${RESEND_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ from: FROM, to: [to], subject, html, text }),
  })
  const body = await res.text()
  if (!res.ok) return { ok: false, error: `${res.status} ${body}` }
  try {
    return { ok: true, id: (JSON.parse(body) as { id?: string }).id }
  } catch {
    // Accepted, but the body was not what we expected. Worth recording
    // rather than throwing: the mail is away either way.
    return { ok: true, id: undefined }
  }
}

Deno.serve(async (req: Request) => {
  // Only pg_cron, holding the shared secret. An Edge Function is a
  // public URL; without this, anyone who learned it could make the
  // digest go out at three in the morning.
  if (!DIGEST_SECRET) {
    // Fail closed. An unset secret must not mean "let anybody run it" —
    // that is the configuration mistake this check exists to survive.
    console.error('DIGEST_SECRET is not set; refusing to run')
    return new Response('not configured', { status: 503 })
  }
  if (!secretMatches(req.headers.get('x-digest-secret'), DIGEST_SECRET)) {
    return new Response('forbidden', { status: 403 })
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  const started = Date.now()
  let recipients = 0
  let notes = 0
  let failed = 0
  let runError: string | null = null
  const detail: Record<string, unknown>[] = []

  try {
    if (!RESEND_KEY) throw new Error('RESEND_API_KEY is not set')

    const { data, error } = await supabase.rpc('digest_rows', {
      p_min_age_minutes: MIN_AGE_MINUTES,
    })
    if (error) throw new Error(`digest_rows: ${error.message}`)

    // snake_case from Postgres, camelCase in the shared module. Mapped
    // here rather than aliased in SQL so the column names stay readable
    // in psql, where somebody will eventually go looking.
    const rows: DigestRow[] = (data ?? []).map((r: Record<string, unknown>) => ({
      recipientId: r.recipient_id as string,
      recipientEmail: r.recipient_email as string,
      recipientName: r.recipient_name as string,
      recipientRole: r.recipient_role as DigestRow['recipientRole'],
      jobBookId: r.job_book_id as string,
      jobNumber: r.job_number as string,
      facilityName: (r.facility_name as string | null) ?? null,
      noteId: r.note_id as string,
      severity: r.severity as DigestRow['severity'],
      sectionNumber: (r.section_number as string | null) ?? null,
      authorName: r.author_name as string,
      body: r.body as string,
      createdAt: r.created_at as string,
    }))

    const { digests, skipped } = buildDigests(rows)

    for (const d of digests) {
      const sent = await sendEmail(
        d.recipientEmail,
        d.subject,
        digestHtml(d, APP_URL),
        digestText(d, APP_URL),
      )

      if (!sent.ok) {
        // Left unmarked on purpose: it goes out on the next run rather
        // than being lost because the provider had a bad minute.
        failed++
        detail.push({
          to: d.recipientEmail, notes: d.total, accepted: false,
          error: sent.error,
        })
        console.error(`digest to ${d.recipientEmail} failed: ${sent.error}`)
        continue
      }

      detail.push({
        to: d.recipientEmail, notes: d.total, accepted: true,
        // Look this up in the provider's dashboard to see whether it was
        // actually delivered. Acceptance is not delivery.
        message_id: sent.id ?? null,
        from: FROM,
      })

      const noteIds = d.books.flatMap((b) => b.notes.map((n) => n.noteId))
      const { error: markError } = await supabase.rpc('mark_digested', {
        p_user_id: d.recipientId,
        p_note_ids: noteIds,
      })
      if (markError) {
        // The mail is already away. Failing to mark means somebody gets
        // it twice tomorrow, which is worth a loud log and not worth
        // failing the run over.
        console.error(`mark_digested for ${d.recipientId}: ${markError.message}`)
      }

      recipients++
      notes += d.total
    }

    await supabase.from('digest_run').insert({
      recipients, notes, skipped, failed, error: null, detail,
    })

    return Response.json({
      ok: true, recipients, notes, skipped, failed, detail,
      ms: Date.now() - started,
    })
  } catch (e) {
    runError = e instanceof Error ? e.message : String(e)
    console.error(`digest run failed: ${runError}`)
    // Recorded rather than swallowed: "did the digest go out" should
    // have an answer that is not "ask people whether they got one".
    await supabase.from('digest_run').insert({
      recipients, notes, skipped: 0, failed, error: runError, detail,
    })
    return Response.json({ ok: false, error: runError }, { status: 500 })
  }
})
