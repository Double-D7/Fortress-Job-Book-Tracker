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
 */
import type { UserRole } from './types'
import { SEVERITY_LABELS, type NoteSeverity } from './notifications'

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
