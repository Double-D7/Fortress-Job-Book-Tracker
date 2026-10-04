/**
 * Turning a thrown error into something that can be counted.
 *
 * Until now a failure in this application was invisible. There is no
 * error-reporting service, no error boundary, and nothing logs
 * deliberately, so a page that threw showed the framework's generic
 * "a server-side exception has occurred" and the person who hit it was
 * the only one who knew. That is exactly how the NDE outage surfaced:
 * somebody opened a book, the page died, and it was reported by hand.
 * With one user that is survivable. With a crew it means silent
 * failures and a tool nobody trusts.
 *
 * Recording every throw is not enough on its own, because a broken page
 * does not throw once. It throws every time anybody opens it, which on a
 * busy morning is hundreds of identical reports and, if each one sends
 * an email, hundreds of emails nobody reads. So errors are grouped
 * before they are counted, and the group is what gets reported.
 *
 * ## What makes two errors the same
 *
 * The same fault reached from different data: `weld 4471 not found` and
 * `weld 5120 not found` are one bug, not two. So the message is
 * normalised — identifiers, numbers and quoted values replaced with
 * placeholders — before it is hashed together with the route and the
 * top stack frame. What is left is the shape of the failure rather than
 * the particular row that provoked it.
 *
 * This module decides; it stores nothing and sends nothing. That keeps
 * the grouping rules testable without a database, which matters because
 * grouping too hard hides a second bug behind the first, and grouping
 * too softly brings back the flood it exists to prevent.
 */
import { createHash } from 'node:crypto'

/** Patterns that are the data rather than the fault, longest first so a
 *  UUID is not first mangled into a run of hex. */
const VARIABLE_PARTS: readonly [RegExp, string][] = [
  // UUIDs: record identifiers, nearly always the thing that differs.
  [/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>'],
  // Long hex: sha256 of a document, a storage path.
  [/\b[0-9a-f]{16,}\b/gi, '<hash>'],
  // ISO dates and timestamps.
  [/\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?Z?)?/g, '<date>'],
  // Anything quoted: filenames, weld numbers, heat numbers, job numbers.
  [/'[^']{0,120}'/g, "'<value>'"],
  [/"[^"]{0,120}"/g, '"<value>"'],
  // Unquoted identifiers that mix letters and digits: heat numbers
  // (A104932), wrench serials (0125115155), report numbers (RT-031),
  // weld stamps. These are the particulars more often than not, and a
  // bare-number rule misses them because the digits carry no word
  // boundary once a letter is stuck to the front.
  [/\b(?=[A-Za-z0-9-]*\d)(?=[A-Za-z0-9-]*[A-Za-z])[A-Za-z0-9][A-Za-z0-9-]{2,}\b/g, '<ref>'],
  // Bare numbers last, so the patterns above keep their digits.
  [/\b\d+(?:\.\d+)?\b/g, '<n>'],
]

/**
 * The message with the particulars taken out.
 *
 * Exported because it is the rule most likely to need adjusting as real
 * failures arrive, and adjusting it blind is how grouping goes wrong.
 */
export function normalizeMessage(message: string): string {
  let out = message
  for (const [pattern, replacement] of VARIABLE_PARTS) {
    out = out.replace(pattern, replacement)
  }
  // Collapse whitespace so a stack-wrapped message matches an inline one.
  return out.replace(/\s+/g, ' ').trim().slice(0, 500)
}

/**
 * The first line of the stack that belongs to this application.
 *
 * Framework frames are the same for every error and say nothing about
 * which fault this is; the first frame inside `src` or a route handler
 * is the one that distinguishes them. Null when the stack is absent or
 * entirely framework, in which case the message carries the grouping on
 * its own.
 */
export function topAppFrame(stack: string | undefined): string | null {
  if (!stack) return null
  for (const raw of stack.split('\n').slice(1)) {
    const line = raw.trim()
    if (!line.startsWith('at ')) continue
    if (/node_modules|node:internal|\/\.next\/|webpack-internal/.test(line)) continue
    // Strip the absolute prefix: the same frame has a different path on
    // a build machine and in a lambda, and that must not split a group.
    return line.replace(/\(?\/.*?(?=(?:src|app|supabase)\/)/, '(').slice(0, 200)
  }
  return null
}

export interface ErrorShape {
  name: string
  message: string
  stack?: string
  /** The route the request was for, when there was one. */
  route?: string | null
}

/**
 * A stable identifier for the fault, not the occurrence.
 *
 * Twelve hex characters: enough that two genuinely different faults will
 * not collide in a system this size, short enough to read out.
 */
export function fingerprintError(error: ErrorShape): string {
  const parts = [
    error.name || 'Error',
    normalizeMessage(error.message || ''),
    topAppFrame(error.stack) ?? '',
    error.route ?? '',
  ]
  return createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 12)
}

/**
 * Characters that survive being read down a radio or written on a glove.
 *
 * No I, O, 0, 1 or U: a reference code is quoted back by somebody
 * standing in a field, and the pairs that get confused are worth losing.
 */
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTVWXYZ'

/**
 * The short code shown to the person who hit the error.
 *
 * Derived from the fingerprint, so the code somebody reads out leads
 * straight to the group rather than to one occurrence of it. Six
 * characters, which is enough to find a row and short enough to say.
 */
export function referenceCode(fingerprint: string): string {
  let out = ''
  for (let i = 0; i < 6; i += 1) {
    const byte = parseInt(fingerprint.slice(i * 2, i * 2 + 2) || '0', 16)
    out += ALPHABET[byte % ALPHABET.length]
  }
  return out
}

export interface NotifyDecision {
  /** When this group was last emailed, null if never. */
  lastNotifiedAt: string | null
  now: Date
  /** How long a group stays quiet after being reported. */
  windowMinutes?: number
}

/**
 * Whether this group is worth an email right now.
 *
 * A new fault always is. A fault already reported is not, until the
 * window has passed — otherwise a page broken for everybody sends one
 * email per page view, and the volume is precisely what stops anybody
 * reading them. The count keeps rising either way, so nothing is lost
 * by staying quiet; the next email says how many times it happened.
 */
export function shouldNotify(
  { lastNotifiedAt, now, windowMinutes = 60 }: NotifyDecision,
): boolean {
  if (!lastNotifiedAt) return true
  const last = Date.parse(lastNotifiedAt)
  if (Number.isNaN(last)) return true
  return now.getTime() - last >= windowMinutes * 60_000
}
