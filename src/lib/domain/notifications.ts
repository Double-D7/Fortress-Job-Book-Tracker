/**
 * Who gets told, and how loudly.
 *
 * A note that nobody reads is worth nothing, and until now a note landed
 * in a table nobody was watching. This decides the recipients; the
 * database trigger in 0024 applies the same rule at write time so a note
 * inserted by any route still reaches people.
 *
 * TWO RULES THAT ARE NOT NEGOTIABLE, both stated here and enforced again
 * in SQL.
 *
 * A notification never carries a note to somebody who could not have
 * read it. An internal Fortress note reaching a client through a
 * notification would defeat the visibility column entirely — the
 * notification path is a second place that rule has to hold, and the
 * easy mistake is to think the first place covers it.
 *
 * A severity is a routing signal and nothing more. An inspector marking
 * their own note Critical must not move the compliance score: §11
 * classification and the findings register are Fortress's, and an
 * external party who could raise a Critical by choosing a word would be
 * driving Gate 4 from outside. So this file decides who is interrupted.
 * It never touches a score, and `scoreBook` never reads a note.
 */
import type { UserRole } from './types'

/**
 * How urgent the author says it is.
 *
 * Deliberately NOT the §11 vocabulary (Critical/Major/Minor). Those
 * words mean a classified defect on the register with a deduction
 * attached, and reusing them for a note somebody typed would invite
 * exactly the confusion the paragraph above is trying to prevent.
 */
export type NoteSeverity = 'critical' | 'warning' | 'info'

export const NOTE_SEVERITIES: readonly NoteSeverity[] = ['critical', 'warning', 'info']

export const SEVERITY_LABELS: Record<NoteSeverity, string> = {
  critical: 'Critical',
  warning: 'Needs attention',
  info: 'For information',
}

export const SEVERITY_HELP: Record<NoteSeverity, string> = {
  critical: 'Stops work or affects turnover. Everyone on the book is told at once.',
  warning: 'Wants a decision but is not stopping anything. Everyone on the book is told.',
  info: 'An observation for the record. Appears in the daily digest, interrupts nobody.',
}

/**
 * Does this severity raise the unread badge?
 *
 * Info notes go to everyone on the book — you asked for transparency and
 * it costs nothing — but they do not light anything up. A badge that
 * counts observations is a badge people stop looking at, and then the
 * Critical one is missed too.
 */
export function interrupts(severity: NoteSeverity): boolean {
  return severity !== 'info'
}

/** Somebody who might be told. */
export interface Candidate {
  userId: string
  role: UserRole
  /** Named Custodian of this book (§5). At most one. */
  isCustodian: boolean
  /** Holds a `job_assignment` row on this book. */
  isAssigned: boolean
}

export interface NoteContext {
  severity: NoteSeverity
  visibility: 'internal' | 'client'
  authorId: string
}

/** Roles a notification may reach. Fortress staff who work the book. */
const NOTIFIABLE: ReadonlySet<UserRole> = new Set<UserRole>([
  'fortress_admin', 'qaqc_manager', 'qaqc_tech',
])

/**
 * The recipients for one note.
 *
 * The Custodian is the accountable owner under §5, so they are told
 * about everything on their book. Everyone else assigned is told about
 * anything that is not merely an observation — which is the rule you
 * gave, and it keeps a busy book from paging four people over a spelling
 * correction.
 *
 * Returns ids, sorted, with no duplicates. The author is never among
 * them: being notified of your own writing is how people learn to
 * dismiss notifications without reading them.
 */
export function recipientsFor(
  note: NoteContext,
  candidates: Candidate[],
): string[] {
  const out = new Set<string>()

  for (const c of candidates) {
    if (c.userId === note.authorId) continue

    // The first non-negotiable rule. A notification is a copy of the
    // note's existence, and it may not travel further than the note.
    // Recipients are Fortress staff, so this is belt-and-braces today —
    // and it is exactly the check that would be forgotten on the day
    // somebody adds the operator to the recipient list.
    if (!NOTIFIABLE.has(c.role)) continue

    if (!c.isCustodian && !c.isAssigned) continue

    // The Custodian owns the book and hears everything on it. Everyone
    // else assigned hears what is not an observation.
    if (c.isCustodian || note.severity !== 'info') out.add(c.userId)
  }

  return [...out].sort()
}

/**
 * The unread count a badge should show.
 *
 * Counts what interrupts. An unread info note is still unread and still
 * listed; it is not what the number is for.
 */
export function badgeCount(
  unread: { severity: NoteSeverity }[],
): number {
  return unread.filter((n) => interrupts(n.severity)).length
}

/** The loudest severity in a set, for a per-book indicator. */
export function highestSeverity(
  notes: { severity: NoteSeverity }[],
): NoteSeverity | null {
  if (notes.some((n) => n.severity === 'critical')) return 'critical'
  if (notes.some((n) => n.severity === 'warning')) return 'warning'
  if (notes.length > 0) return 'info'
  return null
}
