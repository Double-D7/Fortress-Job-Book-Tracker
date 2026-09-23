/**
 * The daily digest: what one person is told, once a day.
 *
 * Composition only. Nothing here sends anything, reads a database or
 * knows what Resend is — it takes the unread notifications and returns
 * what the message should say. That keeps the part with the judgement in
 * it testable, and leaves the delivery mechanism free to change without
 * touching a single rule.
 *
 * THE RULE INHERITED FROM 0024, AND IT MATTERS MORE HERE. A digest may
 * not carry a note to somebody the note's own read policy would withhold
 * from them. In the app a mistake shows a row to somebody on screen; in
 * an email it leaves the building and cannot be recalled. So the digest
 * never assembles its own recipient list — it is handed rows that the
 * database already scoped, and `buildDigests` refuses a row whose
 * recipient is not Fortress staff rather than trusting the caller.
 *
 * WHY A DIGEST AND NOT ONE EMAIL PER NOTE. A chatty inspector on a busy
 * week would train everybody to filter the sender, and then the Critical
 * one is filtered too. One message a day, ordered worst-first, is a
 * message people still open.
 *
 * WHY THIS FILE HAS NO IMPORTS. It is loaded by two runtimes: Next.js,
 * through the `@shared/*` alias, and the Supabase Edge Function, which
 * is Deno and resolves a relative path with an explicit extension. The
 * two disagree about how to write an import, and they agree perfectly
 * about a file that has none. So the two types it needs are restated
 * below, and `digest.test.ts` asserts they still match the originals —
 * the alternative was a second copy of the whole module, which is the
 * drift this codebase keeps paying for.
 */

/** Mirrors `UserRole` in src/lib/domain/types.ts. Pinned by a test. */
type UserRole =
  | 'fortress_admin' | 'qaqc_manager' | 'qaqc_tech'
  | 'fortress_read_only' | 'client_user' | 'third_party_inspector'

/** Mirrors `NoteSeverity` in src/lib/domain/notifications.ts. */
type NoteSeverity = 'critical' | 'warning' | 'info'

/** Mirrors `SEVERITY_LABELS`. Pinned by a test. */
const SEVERITY_LABELS: Record<NoteSeverity, string> = {
  critical: 'Critical',
  warning: 'Needs attention',
  info: 'For information',
}

export type { NoteSeverity, UserRole }

/** One unread note, as the digest query hands it over. */
export interface DigestRow {
  recipientId: string
  recipientEmail: string
  recipientName: string
  recipientRole: UserRole
  jobBookId: string
  jobNumber: string
  facilityName: string | null
  noteId: string
  severity: NoteSeverity
  sectionNumber: string | null
  authorName: string
  body: string
  createdAt: string
}

export interface DigestBook {
  jobBookId: string
  jobNumber: string
  facilityName: string | null
  notes: DigestRow[]
}

export interface Digest {
  recipientId: string
  recipientEmail: string
  recipientName: string
  subject: string
  /** Worst first, so the top of the message is the part that matters. */
  books: DigestBook[]
  critical: number
  warning: number
  info: number
  total: number
}

/** Roles a digest may be addressed to. Same set as 0024's fan-out. */
const NOTIFIABLE: ReadonlySet<UserRole> = new Set<UserRole>([
  'fortress_admin', 'qaqc_manager', 'qaqc_tech',
])

const RANK: Record<NoteSeverity, number> = { critical: 0, warning: 1, info: 2 }

/**
 * The subject line.
 *
 * Leads with the count that demands something, because a subject is all
 * most people read before deciding. "3 job books" tells them nothing;
 * "2 critical" tells them whether to open it now.
 */
export function digestSubject(
  critical: number, warning: number, info: number, books: number,
): string {
  const parts: string[] = []
  if (critical > 0) parts.push(`${critical} critical`)
  if (warning > 0) parts.push(`${warning} needing attention`)
  if (parts.length === 0 && info > 0) {
    parts.push(`${info} note${info === 1 ? '' : 's'}`)
  }
  const where = books === 1 ? 'on 1 job book' : `across ${books} job books`
  return `Job book notes — ${parts.join(', ')} ${where}`
}

/**
 * Group rows into one digest per person.
 *
 * Rows for a recipient who may not be notified are dropped rather than
 * throwing: a digest run is a batch, and one bad row must not stop
 * everybody else's mail. The count of what was dropped is returned so a
 * run that silently discards half its work is visible in the logs.
 */
export function buildDigests(rows: DigestRow[]): {
  digests: Digest[]
  skipped: number
} {
  const byPerson = new Map<string, DigestRow[]>()
  let skipped = 0

  for (const r of rows) {
    // The inherited rule, re-checked here rather than assumed. The query
    // scopes recipients; this is what catches the day somebody widens it.
    if (!NOTIFIABLE.has(r.recipientRole)) { skipped++; continue }
    if (!r.recipientEmail || !r.recipientEmail.includes('@')) { skipped++; continue }
    const list = byPerson.get(r.recipientId) ?? []
    list.push(r)
    byPerson.set(r.recipientId, list)
  }

  const digests: Digest[] = []
  for (const [recipientId, list] of byPerson) {
    const first = list[0]!
    const byBook = new Map<string, DigestRow[]>()
    for (const r of list) {
      const b = byBook.get(r.jobBookId) ?? []
      b.push(r)
      byBook.set(r.jobBookId, b)
    }

    const books: DigestBook[] = [...byBook.values()]
      .map((notes) => ({
        jobBookId: notes[0]!.jobBookId,
        jobNumber: notes[0]!.jobNumber,
        facilityName: notes[0]!.facilityName,
        // Worst first within a book, then oldest first — a Critical from
        // Tuesday outranks an observation from this morning.
        notes: [...notes].sort((a, b) =>
          RANK[a.severity] - RANK[b.severity]
          || a.createdAt.localeCompare(b.createdAt)),
      }))
      // And the book with the worst note leads the message.
      .sort((a, b) =>
        RANK[a.notes[0]!.severity] - RANK[b.notes[0]!.severity]
        || a.jobNumber.localeCompare(b.jobNumber))

    const critical = list.filter((r) => r.severity === 'critical').length
    const warning = list.filter((r) => r.severity === 'warning').length
    const info = list.filter((r) => r.severity === 'info').length

    digests.push({
      recipientId,
      recipientEmail: first.recipientEmail,
      recipientName: first.recipientName,
      subject: digestSubject(critical, warning, info, books.length),
      books,
      critical,
      warning,
      info,
      total: list.length,
    })
  }

  // Deterministic order so a run is reproducible and a test can read.
  digests.sort((a, b) => a.recipientEmail.localeCompare(b.recipientEmail))
  return { digests, skipped }
}

/** Trim a note for an email without cutting mid-word. */
export function excerpt(body: string, max = 240): string {
  const clean = body.replace(/\s+/g, ' ').trim()
  if (clean.length <= max) return clean
  const cut = clean.slice(0, max)
  const lastSpace = cut.lastIndexOf(' ')
  return `${cut.slice(0, lastSpace > max * 0.6 ? lastSpace : max)}…`
}

/** Escape for an HTML email. A note is free text somebody typed. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * The plain-text body.
 *
 * Written first and kept complete rather than treated as a fallback. A
 * digest is read on a phone in a truck, and the text part is what some
 * clients show; a reader who gets only this should still know what
 * happened and which book it happened on.
 */
export function digestText(d: Digest, appUrl: string): string {
  const lines: string[] = [
    `${d.recipientName},`,
    '',
    `${d.total} note${d.total === 1 ? '' : 's'} you have not read.`,
    '',
  ]
  for (const book of d.books) {
    lines.push(`${book.jobNumber}${book.facilityName ? ` — ${book.facilityName}` : ''}`)
    for (const n of book.notes) {
      const tag = n.severity === 'info' ? '' : `[${SEVERITY_LABELS[n.severity]}] `
      const where = n.sectionNumber ? ` (section ${n.sectionNumber})` : ''
      lines.push(`  ${tag}${n.authorName}${where}: ${excerpt(n.body, 200)}`)
    }
    lines.push(`  ${appUrl}/books/${book.jobBookId}/notes`)
    lines.push('')
  }
  lines.push(
    'A note marked critical asks Fortress to look now. It does not raise a',
    'finding or change a book\'s score — that stays a Fortress decision.',
    '',
    `${appUrl}/notifications`,
  )
  return lines.join('\n')
}

/**
 * The HTML body.
 *
 * Tables and inline styles, because email clients are not browsers:
 * Outlook renders through Word, Gmail strips <style> blocks, and flexbox
 * is not available in either. This looks like 2005 markup because that
 * is what arrives intact.
 *
 * Colour is never the only carrier of meaning here, the same rule §8
 * applies on screen — every urgent note wears its word as well as its
 * colour, because a colour-blind reader and a plain-text client have the
 * same problem.
 */
export function digestHtml(d: Digest, appUrl: string): string {
  const TONE: Record<NoteSeverity, string> = {
    critical: '#b42318',
    warning: '#b54708',
    info: '#667085',
  }

  const books = d.books.map((book) => {
    const notes = book.notes.map((n) => {
      const label = n.severity === 'info' ? '' :
        `<span style="display:inline-block;padding:1px 6px;margin-right:6px;border-radius:9px;` +
        `background:${TONE[n.severity]};color:#ffffff;font-size:11px;font-weight:600;">` +
        `${escapeHtml(SEVERITY_LABELS[n.severity])}</span>`
      const where = n.sectionNumber
        ? `<span style="color:#667085;"> &middot; section ${escapeHtml(n.sectionNumber)}</span>`
        : ''
      return `
      <tr><td style="padding:10px 0;border-bottom:1px solid #eaecf0;">
        <div style="font-size:13px;line-height:1.5;">
          ${label}<strong style="color:#101828;">${escapeHtml(n.authorName)}</strong>${where}
        </div>
        <div style="font-size:13px;line-height:1.6;color:#475467;margin-top:3px;">
          ${escapeHtml(excerpt(n.body))}
        </div>
      </td></tr>`
    }).join('')

    return `
    <tr><td style="padding:18px 0 4px;">
      <div style="font-size:14px;font-weight:600;color:#101828;">
        <a href="${appUrl}/books/${encodeURIComponent(book.jobBookId)}/notes"
           style="color:#101828;text-decoration:none;">
          ${escapeHtml(book.jobNumber)}</a>${
            book.facilityName
              ? `<span style="font-weight:400;color:#667085;"> — ${escapeHtml(book.facilityName)}</span>`
              : ''}
      </div>
    </td></tr>
    <tr><td><table width="100%" cellpadding="0" cellspacing="0" role="presentation">${notes}</table></td></tr>`
  }).join('')

  const summary = [
    d.critical > 0 ? `${d.critical} critical` : null,
    d.warning > 0 ? `${d.warning} needing attention` : null,
    d.info > 0 ? `${d.info} for information` : null,
  ].filter(Boolean).join(' &middot; ')

  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#f9fafb;">
<table width="100%" cellpadding="0" cellspacing="0" role="presentation"
       style="background:#f9fafb;padding:24px 12px;">
<tr><td align="center">
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation"
         style="max-width:560px;background:#ffffff;border:1px solid #eaecf0;border-radius:8px;padding:24px;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;">
    <tr><td>
      <div style="font-size:15px;font-weight:600;color:#101828;">Job book notes</div>
      <div style="font-size:13px;color:#475467;margin-top:2px;">${summary}</div>
    </td></tr>
    ${books}
    <tr><td style="padding-top:20px;">
      <a href="${appUrl}/notifications"
         style="display:inline-block;padding:9px 14px;border-radius:6px;background:#101828;color:#ffffff;font-size:13px;font-weight:500;text-decoration:none;">
        Open the tracker</a>
    </td></tr>
    <tr><td style="padding-top:18px;">
      <div style="font-size:11px;line-height:1.6;color:#98a2b3;border-top:1px solid #eaecf0;padding-top:12px;">
        A note marked critical asks Fortress to look now. It does not raise a finding or
        change a book&rsquo;s score &mdash; that stays a Fortress decision under the §11
        classification rules. You are receiving this because you are the Custodian of these
        books, or assigned to them.
      </div>
    </td></tr>
  </table>
</td></tr></table>
</body></html>`
}
