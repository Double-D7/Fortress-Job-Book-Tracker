/**
 * The stored completion percentage must equal the computed one.
 *
 * `job_book_section.computed_pct` is a cache, and the client-facing view
 * returns it verbatim. The Fortress screens run the scoring engine on every
 * request, so they are right by construction; the stored column is not, and
 * for a while it was zero on every row of every book. Staff opened DP452 at
 * 80.64% while an operator querying the same data through their own view
 * would have been told 0%.
 *
 * These tests exist so that never silently returns. A percentage that
 * depends on who is asking is not a record.
 */
import { describe, expect, it } from 'vitest'
import {
  applyComputedScores, scoreBook, staleComputedScores,
} from '@/lib/domain/scoring'
import { buildDp452Bundle } from '@/lib/data/seed/dp452'
import { buildGreeleyBundle } from '@/lib/data/seed/greeley'
import { getDataProvider, type Viewer } from '@/lib/data/provider'
import type { JobBookBundle } from '@/lib/domain/types'

const BOOKS: [string, () => JobBookBundle][] = [
  ['DP452', buildDp452Bundle],
  ['DP-318', buildGreeleyBundle],
]

describe('the stored score is a cache, not a second opinion', () => {
  for (const [name, build] of BOOKS) {
    it(`${name}: raw seed rows are unstamped, and that is detectable`, () => {
      const raw = build()
      // The seeds carry the schema default. The point is not that this is
      // wrong to write — it is that serving it unstamped is.
      expect(raw.sections.every((s) => s.computedAt == null)).toBe(true)
      const stale = staleComputedScores(raw)
      expect(stale.length).toBeGreaterThan(0)
    })

    it(`${name}: every stored percentage matches the engine once stamped`, () => {
      const stamped = applyComputedScores(build())
      expect(staleComputedScores(stamped)).toEqual([])
    })

    it(`${name}: stamping changes only the cache, never the score`, () => {
      const before = scoreBook(build())
      const after = scoreBook(applyComputedScores(build()))
      expect(after.overallPct).toBe(before.overallPct)
      expect(after.sections.map((s) => s.pct)).toEqual(before.sections.map((s) => s.pct))
    })

    it(`${name}: a stamped percentage carries the time it was worked out`, () => {
      const stamped = applyComputedScores(build())
      for (const s of stamped.sections) {
        expect(s.computedAt).toBeTruthy()
        expect(Number.isNaN(Date.parse(s.computedAt!))).toBe(false)
      }
    })
  }

  it('names the section, the stored figure and the computed one', () => {
    const b = applyComputedScores(buildDp452Bundle())
    // A section that is neither 0 nor 100, so overwriting it with 100 is
    // unambiguously a change.
    const target = b.sections.find((s) => s.computedPct > 0 && s.computedPct < 100)!
    const tampered: JobBookBundle = {
      ...b,
      sections: b.sections.map((s) => (s === target ? { ...s, computedPct: 100 } : s)),
    }
    const stale = staleComputedScores(tampered)
    expect(stale).toHaveLength(1)
    expect(stale[0]!.stored).toBe(100)
    expect(stale[0]!.computed).toBe(target.computedPct)
    expect(stale[0]!.sectionNumber).toBeTruthy()
  })
})

describe('nothing leaves the provider carrying a stale figure', () => {
  const viewer: Viewer = {
    id: 'user-test', email: 'qa@fortressds.com', fullName: 'Test Manager',
    role: 'qaqc_manager', clientOrgId: null,
  }

  it('serves both seeded books already stamped', async () => {
    const p = getDataProvider()
    for (const summary of await p.listJobBooks(viewer)) {
      const bundle = await p.getBundle(viewer, summary.id)
      expect(bundle).not.toBeNull()
      expect(staleComputedScores(bundle!)).toEqual([])
    }
  })

  it('agrees with the figure the dashboard prints', async () => {
    const p = getDataProvider()
    for (const summary of await p.listJobBooks(viewer)) {
      const bundle = await p.getBundle(viewer, summary.id)
      // The dashboard's headline and the per-section cache are two reads of
      // one number, and they are checked against each other rather than
      // trusted to agree.
      expect(scoreBook(bundle!).overallPct).toBe(summary.overallPct)
    }
  })

  it('a client viewer reads the same percentages as staff', async () => {
    const p = getDataProvider()
    const staff = await p.getBundle(viewer, 'book-dp452')
    const client = await p.getBundle(
      {
        id: 'user-client', email: 'ops@noble.example', fullName: 'Client User',
        role: 'client_user', clientOrgId: staff!.clientOrg.id,
      },
      'book-dp452',
    )
    expect(client).not.toBeNull()
    expect(client!.redacted).toBe(true)

    // Redaction removes identities and internal commentary. It must not
    // move a number — in either direction.
    expect(client!.sections.map((s) => s.computedPct))
      .toEqual(staff!.sections.map((s) => s.computedPct))
    expect(scoreBook(client!).overallPct).toBe(scoreBook(staff!).overallPct)
    expect(scoreBook(client!).sections.map((s) => s.pct))
      .toEqual(scoreBook(staff!).sections.map((s) => s.pct))
  })

  it('does not let redaction flatter the book', async () => {
    const p = getDataProvider()
    const staff = (await p.getBundle(viewer, 'book-dp452'))!
    const client = (await p.getBundle(
      {
        id: 'user-client', email: 'ops@noble.example', fullName: 'Client User',
        role: 'client_user', clientOrgId: staff.clientOrg.id,
      },
      'book-dp452',
    ))!

    // What re-deriving from the reduced payload *would* have said. Section
    // 6 rises to 100% because the redacted welds no longer name the welder
    // whose qualification had lapsed, and section 12 falls to 0% because
    // its documents were filtered out. Neither is the book.
    const naive = scoreBook({ ...client, redacted: false })
    const truth = scoreBook(staff)
    const s6 = (b: ReturnType<typeof scoreBook>) =>
      b.sections.find((x) => x.sectionNumber === '6')!.pct
    expect(s6(naive)).toBeGreaterThan(s6(truth))
    expect(s6(scoreBook(client))).toBe(s6(truth))
  })

  it('refuses to check a redacted bundle against itself', async () => {
    const p = getDataProvider()
    const staff = (await p.getBundle(viewer, 'book-dp452'))!
    const client = (await p.getBundle(
      {
        id: 'user-client', email: 'ops@noble.example', fullName: 'Client User',
        role: 'client_user', clientOrgId: staff.clientOrg.id,
      },
      'book-dp452',
    ))!
    expect(() => staleComputedScores(client)).toThrow(/complete record/)
  })

  it('refuses to serve a figure for a payload redacted before it was scored', () => {
    const raw = buildDp452Bundle()
    expect(() => scoreBook({ ...raw, redacted: true })).toThrow(/before it was scored/)
  })

  it('stamps a book created through the wizard', async () => {
    const p = getDataProvider()
    const created = await p.createJobBook(viewer, {
      clientOrgId: 'org-noble', projectId: 'proj-score-test', bookTemplateId: 'tpl-flowline-v1',
      jobNumber: 'DP999', bookType: 'flowline',
      facilityName: 'DP999 Flowline', wellNames: ['CC99-01'],
      constructionCompany: 'Fortress DS', weldingCompany: 'Fortress DS',
      cwiNames: ['B. Hargrove'],
    })
    expect(created.ok).toBe(true)
    const bundle = await p.getBundle(viewer, created.jobBookId!)
    // A brand-new book is genuinely at zero — but it says so with a
    // timestamp, which is what separates "scored, and empty" from
    // "never scored".
    expect(staleComputedScores(bundle!)).toEqual([])
    expect(bundle!.sections.every((s) => s.computedAt)).toBe(true)
  })
})
