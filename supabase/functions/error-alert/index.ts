/**
 * Telling somebody a page is broken.
 *
 * The application records every failure it meets, grouped so a page
 * broken all morning is one row with a count. That solved half the
 * problem: the faults are written down. This is the other half, because
 * a record nobody looks at is only marginally better than no record,
 * and the whole reason this exists is that the last outage was found by
 * the one person who happened to hit it.
 *
 * ## Why it batches rather than firing on every throw
 *
 * A broken page throws for everybody who opens it. Alerting per
 * occurrence would send a hundred emails for one bug, and a hundred
 * emails is read exactly as often as none. Instead this runs on a
 * schedule, collects every group that is due, and sends one message.
 * `report_error` has already decided what "due" means: a fault nobody
 * has been told about, or one last mentioned longer ago than the
 * quiet window.
 *
 * ## Why it stamps after sending, not before
 *
 * `notified_at` is what suppresses the next alert. Stamping before the
 * send would mean a failed email silences the fault for an hour, which
 * is the one outcome worse than a duplicate.
 */
import { createClient } from 'jsr:@supabase/supabase-js@2'

const APP_URL = Deno.env.get('APP_URL') ?? 'https://app.fortressqc.com'
const FROM = Deno.env.get('DIGEST_FROM')
  ?? 'Fortress Job Book Tracker <noreply@fortressqc.com>'
const RESEND_KEY = Deno.env.get('RESEND_API_KEY')
/** Shared secret so only pg_cron can trigger a run. */
const ALERT_SECRET = Deno.env.get('ALERT_SECRET')

/** How long a group stays quiet after being mentioned. Matches the
 *  default the application passes to `report_error`. */
const QUIET_MINUTES = 60

/** Enough faults to show the shape of a bad morning without producing a
 *  message nobody finishes. */
const MAX_IN_EMAIL = 20

interface Row {
  id: string
  fingerprint: string
  reference: string
  error_name: string
  message: string
  route: string | null
  occurrences: number
  first_seen_at: string
  last_seen_at: string
  notified_at: string | null
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] ?? c))
}

function when(iso: string): string {
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hours = Math.round(mins / 60)
  return hours < 24 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`
}

function subjectFor(rows: Row[]): string {
  if (rows.length === 1) {
    const r = rows[0]!
    return `Job Book Tracker error: ${r.error_name} (${r.reference})`
  }
  return `Job Book Tracker: ${rows.length} errors need attention`
}

function bodyFor(rows: Row[]): { html: string; text: string } {
  const lines = rows.map((r) => {
    const times = r.occurrences === 1 ? 'once' : `${r.occurrences} times`
    return {
      head: `${r.reference} · ${r.error_name}`,
      detail: r.message,
      meta: `${r.route ?? 'no route'} · ${times} · last ${when(r.last_seen_at)}`,
    }
  })

  const text = [
    'The Job Book Tracker recorded these failures.',
    '',
    ...lines.flatMap((l) => [l.head, `  ${l.detail}`, `  ${l.meta}`, '']),
    `Full list: ${APP_URL}/admin`,
    '',
    'A person who hit one of these can quote the reference. Closing a',
    'fault records that it was dealt with; it reopens by itself if it',
    'happens again.',
  ].join('\n')

  const html = `
<div style="font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif;max-width:640px">
  <p style="font-size:14px;color:#3C4C66;margin:0 0 16px">
    The Job Book Tracker recorded ${rows.length === 1 ? 'a failure' : `${rows.length} failures`}.
  </p>
  ${lines.map((l) => `
  <div style="border-left:3px solid #A62F1C;background:#F8F9FB;padding:10px 14px;margin:0 0 10px">
    <div style="font-family:ui-monospace,monospace;font-size:13px;font-weight:700;color:#16243A">
      ${escapeHtml(l.head)}
    </div>
    <div style="font-size:13px;color:#3C4C66;margin-top:4px">${escapeHtml(l.detail)}</div>
    <div style="font-size:11px;color:#6C7B91;margin-top:6px">${escapeHtml(l.meta)}</div>
  </div>`).join('')}
  <p style="font-size:13px;margin:16px 0 0">
    <a href="${APP_URL}/admin" style="color:#5B4BE0">Open the error list</a>
  </p>
  <p style="font-size:11px;color:#6C7B91;line-height:1.5;margin:14px 0 0">
    Somebody who hit one of these can quote the reference. Closing a fault records that it
    was dealt with; it reopens by itself if it happens again.
  </p>
</div>`.trim()

  return { html, text }
}

Deno.serve(async (req: Request) => {
  // Fail closed. An unset secret must never mean "let anybody run it":
  // this is a public URL, and the same rule the digest and the backup
  // follow.
  if (!ALERT_SECRET) {
    console.error('ALERT_SECRET is not set; refusing to run')
    return new Response('ALERT_SECRET is not set; refusing to run.', { status: 503 })
  }
  if (req.headers.get('x-alert-secret') !== ALERT_SECRET) {
    return new Response('Forbidden', { status: 403 })
  }
  if (!RESEND_KEY) {
    console.error('RESEND_API_KEY is not set; refusing to run')
    return new Response('RESEND_API_KEY is not set.', { status: 503 })
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  const quietBefore = new Date(Date.now() - QUIET_MINUTES * 60_000).toISOString()

  // Open faults either never mentioned or last mentioned before the
  // window. Ordered by most recent so a message truncated at the limit
  // keeps what is happening now.
  const { data, error } = await supabase
    .from('error_report')
    .select('*')
    .is('resolved_at', null)
    // The timestamp is quoted because it carries dots and colons, which
    // are what PostgREST splits a filter on. Unquoted it parses as far
    // as the seconds and drops the rest.
    .or(`notified_at.is.null,notified_at.lt."${quietBefore}"`)
    .order('last_seen_at', { ascending: false })
    .limit(MAX_IN_EMAIL)

  if (error) {
    console.error('could not read error_report:', error.message)
    return Response.json({ ok: false, error: error.message }, { status: 500 })
  }

  const rows = (data ?? []) as Row[]
  if (rows.length === 0) return Response.json({ ok: true, sent: 0, faults: 0 })

  // Everyone who can act on it. Reading the directory rather than a
  // configured address means somebody made an admin tomorrow starts
  // receiving these without anybody remembering to add them.
  const { data: admins } = await supabase
    .from('app_user')
    .select('email')
    .eq('role', 'fortress_admin')
    .eq('is_active', true)
    .is('deleted_at', null)

  const to = (admins ?? []).map((a) => a.email as string).filter(Boolean)
  if (to.length === 0) {
    console.error('no active admin to alert')
    return Response.json({ ok: false, error: 'no active admin to alert' }, { status: 500 })
  }

  const { html, text } = bodyFor(rows)
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${RESEND_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ from: FROM, to, subject: subjectFor(rows), html, text }),
  })

  if (!res.ok) {
    const detail = await res.text()
    console.error('Resend refused the alert:', res.status, detail)
    // Deliberately no stamp. A failed send must not silence the fault
    // for an hour; the next run will try again.
    return Response.json(
      { ok: false, error: `Resend ${res.status}: ${detail}` }, { status: 502 },
    )
  }

  // Stamped only now that it is away.
  for (const r of rows) {
    await supabase.rpc('mark_error_notified', { p_fingerprint: r.fingerprint })
  }

  return Response.json({ ok: true, sent: to.length, faults: rows.length })
})
