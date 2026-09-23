/**
 * The daily digest.
 *
 * The case that matters most is the last block: a digest leaving the
 * building with somebody's internal note in it cannot be recalled. In
 * the app a mistake shows a row on a screen; in an email it is gone.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  buildDigests, digestSubject, digestText, escapeHtml, excerpt,
  type DigestRow,
} from '@shared/digest'
import {
  NOTE_SEVERITIES, SEVERITY_LABELS, type NoteSeverity,
} from '@/lib/domain/notifications'
import { ROLES } from '@/lib/domain/roles'

const APP = 'https://app.fortressqc.com'

let seq = 0
function row(over: Partial<DigestRow> = {}): DigestRow {
  seq += 1
  return {
    recipientId: 'u-cust',
    recipientEmail: 'custodian@fortressds.com',
    recipientName: 'R. Vance',
    recipientRole: 'qaqc_tech',
    jobBookId: 'book-1',
    jobNumber: 'DP452',
    facilityName: 'Greeley',
    noteId: `n-${seq}`,
    severity: 'info',
    sectionNumber: null,
    authorName: 'P. Nakamura',
    body: 'Something was observed.',
    createdAt: `2026-09-2${(seq % 9) + 1}T08:00:00.000Z`,
    ...over,
  }
}

describe('grouping', () => {
  it('gives each person one digest however many books they are on', () => {
    const { digests } = buildDigests([
      row({ jobBookId: 'book-1', jobNumber: 'DP452' }),
      row({ jobBookId: 'book-2', jobNumber: 'DP318' }),
      row({ jobBookId: 'book-2', jobNumber: 'DP318' }),
    ])
    expect(digests).toHaveLength(1)
    expect(digests[0]!.books).toHaveLength(2)
    expect(digests[0]!.total).toBe(3)
  })

  it('keeps two people’s mail apart', () => {
    const { digests } = buildDigests([
      row({ recipientId: 'a', recipientEmail: 'a@fortressds.com' }),
      row({ recipientId: 'b', recipientEmail: 'b@fortressds.com' }),
    ])
    expect(digests).toHaveLength(2)
    expect(digests.map((d) => d.recipientEmail))
      .toEqual(['a@fortressds.com', 'b@fortressds.com'])
  })

  it('leads with the book carrying the worst note', () => {
    const { digests } = buildDigests([
      row({ jobBookId: 'quiet', jobNumber: 'AAA', severity: 'info' }),
      row({ jobBookId: 'loud', jobNumber: 'ZZZ', severity: 'critical' }),
    ])
    // Alphabetically AAA comes first; severity has to beat that.
    expect(digests[0]!.books[0]!.jobNumber).toBe('ZZZ')
  })

  it('orders notes worst-first inside a book, then oldest first', () => {
    const { digests } = buildDigests([
      row({ severity: 'info', createdAt: '2026-09-22T09:00:00.000Z', body: 'C' }),
      row({ severity: 'critical', createdAt: '2026-09-22T10:00:00.000Z', body: 'A' }),
      row({ severity: 'warning', createdAt: '2026-09-21T08:00:00.000Z', body: 'B' }),
    ])
    expect(digests[0]!.books[0]!.notes.map((n) => n.body)).toEqual(['A', 'B', 'C'])
  })

  it('counts each severity', () => {
    const { digests } = buildDigests([
      row({ severity: 'critical' }), row({ severity: 'critical' }),
      row({ severity: 'warning' }), row({ severity: 'info' }),
    ])
    const d = digests[0]!
    expect([d.critical, d.warning, d.info, d.total]).toEqual([2, 1, 1, 4])
  })

  it('returns nothing at all when there is nothing unread', () => {
    // No digest rather than an empty one. "You have 0 notes" every
    // morning is how a daily email becomes a filter rule.
    expect(buildDigests([]).digests).toEqual([])
  })
})

describe('the rule a digest must not break', () => {
  it('never addresses a digest to the operator or an inspector', () => {
    const { digests, skipped } = buildDigests([
      row({ recipientId: 'c', recipientRole: 'client_user',
            recipientEmail: 'ops@operator.example' }),
      row({ recipientId: 'i', recipientRole: 'third_party_inspector',
            recipientEmail: 'insp@inspection.example' }),
      row({ recipientId: 'r', recipientRole: 'fortress_read_only',
            recipientEmail: 'ro@fortressds.com' }),
    ])
    expect(digests).toEqual([])
    expect(skipped).toBe(3)
  })

  it('drops a bad row without losing everybody else’s mail', () => {
    // A batch must not be stopped by one row. The count is returned so
    // a run that quietly discards half its work is visible.
    const { digests, skipped } = buildDigests([
      row({ recipientId: 'good', recipientEmail: 'good@fortressds.com' }),
      row({ recipientId: 'noemail', recipientEmail: '' }),
      row({ recipientId: 'notanemail', recipientEmail: 'nonsense' }),
    ])
    expect(digests).toHaveLength(1)
    expect(digests[0]!.recipientEmail).toBe('good@fortressds.com')
    expect(skipped).toBe(2)
  })

  it('escapes a note that contains markup', () => {
    // A note is free text somebody typed, and it lands in an HTML email.
    const nasty = '<script>alert(1)</script> & "quotes"'
    const safe = escapeHtml(nasty)
    expect(safe).not.toContain('<script>')
    expect(safe).toContain('&lt;script&gt;')
    expect(safe).toContain('&amp;')
    expect(safe).toContain('&quot;')
  })
})

describe('the subject line', () => {
  const cases: [number, number, number, number, string][] = [
    [2, 0, 0, 1, '2 critical on 1 job book'],
    [0, 3, 0, 2, '3 needing attention across 2 job books'],
    [1, 2, 5, 3, '1 critical, 2 needing attention across 3 job books'],
    [0, 0, 1, 1, '1 note on 1 job book'],
    [0, 0, 4, 2, '4 notes across 2 job books'],
  ]

  it('leads with what demands something', () => {
    for (const [c, w, i, b, expected] of cases) {
      expect(digestSubject(c, w, i, b)).toBe(`Job book notes — ${expected}`)
    }
  })

  it('does not mention observations when something is urgent', () => {
    // The subject is all most people read before deciding whether to
    // open it now. Burying "2 critical" behind "and 40 observations"
    // wastes the only line that gets read.
    expect(digestSubject(2, 0, 40, 1)).not.toContain('40')
  })
})

describe('the plain-text body', () => {
  const build = (severity: NoteSeverity, over: Partial<DigestRow> = {}) =>
    buildDigests([row({ severity, ...over })]).digests[0]!

  it('names the book, the author and a link to the notes', () => {
    const text = digestText(build('critical'), APP)
    expect(text).toContain('DP452')
    expect(text).toContain('Greeley')
    expect(text).toContain('P. Nakamura')
    expect(text).toContain(`${APP}/books/book-1/notes`)
  })

  it('tags what is urgent and leaves an observation untagged', () => {
    expect(digestText(build('critical'), APP)).toContain('[Critical]')
    expect(digestText(build('warning'), APP)).toContain('[Needs attention]')
    const info = digestText(build('info'), APP)
    expect(info).not.toContain('[For information]')
  })

  it('names the section where there is one', () => {
    expect(digestText(build('warning', { sectionNumber: '12' }), APP))
      .toContain('section 12')
  })

  it('says what a critical note does not mean', () => {
    // The governance point, in the email as well as on screen: an
    // inspector cannot move the score by choosing a word.
    const text = digestText(build('critical'), APP)
    expect(text).toMatch(/does not raise a/i)
    expect(text).toMatch(/Fortress decision/i)
  })
})

describe('excerpt', () => {
  it('leaves a short note alone', () => {
    expect(excerpt('Short enough.')).toBe('Short enough.')
  })

  it('collapses the whitespace a paste brings with it', () => {
    expect(excerpt('two\n\n  lines')).toBe('two lines')
  })

  it('cuts on a word boundary and marks the cut', () => {
    const long = 'word '.repeat(100)
    const short = excerpt(long, 40)
    expect(short.length).toBeLessThanOrEqual(41)
    expect(short.endsWith('…')).toBe(true)
    expect(short).not.toMatch(/wor…$/)
  })

  it('still truncates a single unbroken run of characters', () => {
    // No space to break on. The word-boundary rule must not fall through
    // to returning the whole thing.
    const wall = 'x'.repeat(500)
    expect(excerpt(wall, 40).length).toBe(41)
  })
})

describe('the shared module has not drifted from the app', () => {
  // digest.ts is loaded by two runtimes and so carries no imports, which
  // means it restates two things the app defines elsewhere. These are
  // what stop the restatement becoming a second opinion.
  const sharedSource = readFileSync(
    'supabase/functions/_shared/digest.ts', 'utf8')

  it('restates UserRole exactly as the app declares it', () => {
    const appRoles = new Set(ROLES.map((r) => r.role))
    const block = sharedSource.slice(
      sharedSource.indexOf('type UserRole ='),
      sharedSource.indexOf('/** Mirrors `NoteSeverity`'))
    const restated = new Set(
      [...block.matchAll(/'(\w+)'/g)].map((m) => m[1]!))
    expect([...restated].sort()).toEqual([...appRoles].sort())
  })

  it('restates the severity labels exactly as the app shows them', () => {
    // A label that differs between the screen and the email is the kind
    // of thing nobody notices until a client quotes one back.
    for (const s of NOTE_SEVERITIES) {
      expect(sharedSource).toContain(`${s}: '${SEVERITY_LABELS[s]}'`)
    }
  })

  it('carries no imports at all, which is what lets Deno load it', () => {
    expect(sharedSource).not.toMatch(/^\s*import\s/m)
  })
})
