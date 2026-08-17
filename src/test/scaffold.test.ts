/**
 * Creating a book, and the scoping that makes its percentages mean
 * anything mid-job.
 *
 * The central case is the first one: a section holding a hundred perfectly
 * complete welds out of a real two thousand must not read as complete.
 * Before declared scope existed, it did.
 */
import { describe, expect, it } from 'vitest'
import { scaffoldJobBook, scopePrompts, validateNewJobBook } from '@/lib/domain/scaffold'
import { scoreBook, scoreSection } from '@/lib/domain/scoring'
import { buildDp452Bundle } from '@/lib/data/seed/dp452'
import type { JobBookBundle, Weld } from '@/lib/domain/types'

const idFor = (kind: string, key: string) => `${kind}-${key.replace(/[^a-zA-Z0-9]+/g, '-')}`

const BASE = {
  jobNumber: 'DP517',
  bookType: 'flowline' as const,
  projectId: 'proj-dp517',
  clientOrgId: 'org-chevron',
  bookTemplateId: 'tpl-flowline-v1',
  facilityName: 'DP517 Flowline',
  drillPadName: 'CC22-11',
  constructionStart: '2026-03-01',
  constructionEnd: '2026-09-30',
}

/** An empty bundle wearing a scaffolded book, so a section can be scored
 *  with a controlled number of records in it. */
function bundleFor(scope: { sectionNumber: string; expectedCount: number | null }[], welds: Weld[] = []): JobBookBundle {
  const { book, sections, weldLines, sectionDefinitions } =
    scaffoldJobBook({ ...BASE, scope }, idFor)
  return {
    book, sections, sectionDefinitions, weldLines,
    project: { id: BASE.projectId, clientOrgId: BASE.clientOrgId, name: 'DP517' },
    clientOrg: { id: BASE.clientOrgId, name: 'Chevron' },
    documents: [], welds, welders: [], welderQualifications: [], cwis: [],
    ndtTechnicians: [], torqueWrenches: [], torqueConnections: [], certificates: [],
    ndeReports: [], materialHeats: [], pressureTests: [], cpTestPoints: [], utReadings: [],
  }
}

function completeWeld(i: number, lineId: string): Weld {
  return {
    id: `w${i}`, weldLineId: lineId, jobBookId: 'book-DP517', weldNumber: String(i),
    sortOrder: i, weldDate: '2026-04-01', welderPassAssignment: 'AA/AA/AA/AA',
    rootWelderId: 'w-a', hotWelderId: 'w-a', fillWelderId: 'w-a', capWelderId: 'w-a',
    jointType: 'Butt', componentDescription: '3" S80 PIPE', partLength: "20'",
    heatNumbers: ['H1'], cwiInitials: 'RA', cwiId: 'cwi-1', cwiVisualResult: 'Pass',
    visualInspectionDate: '2026-04-01', ndtCompany: null, xrayNumber: null,
    ndtTicketNumber: null, ndtMethod: null, ndtResult: null, ndtReportId: null,
    status: 'visual_complete', comments: null,
  }
}

describe('the bug declared scope exists to fix', () => {
  it('does NOT report a section complete when only part of the scope is entered', () => {
    const b = bundleFor([{ sectionNumber: '12', expectedCount: 2000 }])
    const welds = Array.from({ length: 100 }, (_, i) => completeWeld(i, 'line-x'))
    const scoped = { ...b, welds }
    const def = scoped.sectionDefinitions.find((d) => d.sectionNumber === '12')!
    const section = scoped.sections.find((s) => s.sectionDefinitionId === def.id)!

    const score = scoreSection(def, section, scoped)
    // 100 complete welds against a declared 2,000 — 5%, not 100%.
    expect(score.pct).toBeCloseTo(5, 1)
    expect(score.explanation).toContain('100 of 2,000 expected joints entered')
  })

  it('would have read 100% without a declared scope — the regression this guards', () => {
    const b = bundleFor([{ sectionNumber: '12', expectedCount: null }])
    const welds = Array.from({ length: 100 }, (_, i) => completeWeld(i, 'line-x'))
    const scoped = { ...b, welds }
    const def = scoped.sectionDefinitions.find((d) => d.sectionNumber === '12')!
    const section = scoped.sections.find((s) => s.sectionDefinitionId === def.id)!
    expect(scoreSection(def, section, scoped).pct).toBe(100)
  })

  it('treats the declared quantity as a floor, never a cap', () => {
    // The job ran bigger than scoped. The section must not exceed 100%.
    const b = bundleFor([{ sectionNumber: '12', expectedCount: 50 }])
    const welds = Array.from({ length: 100 }, (_, i) => completeWeld(i, 'line-x'))
    const scoped = { ...b, welds }
    const def = scoped.sectionDefinitions.find((d) => d.sectionNumber === '12')!
    const section = scoped.sections.find((s) => s.sectionDefinitionId === def.id)!
    expect(scoreSection(def, section, scoped).pct).toBe(100)
  })

  it('lets per-line joint counts scope the weld log', () => {
    const { book, sections, weldLines, sectionDefinitions } = scaffoldJobBook({
      ...BASE,
      weldLines: [
        { lineCode: 'FL1', expectedWeldCount: 300 },
        { lineCode: 'FL2', expectedWeldCount: 200 },
      ],
    }, idFor)
    const b = { ...bundleFor([]), book, sections, weldLines, sectionDefinitions }
    const welds = Array.from({ length: 125 }, (_, i) => completeWeld(i, weldLines[0]!.id))
    const def = sectionDefinitions.find((d) => d.sectionNumber === '12')!
    const section = sections.find((s) => s.sectionDefinitionId === def.id)!
    // 125 complete against 500 expected across the two lines.
    expect(scoreSection(def, section, { ...b, welds }).pct).toBeCloseTo(25, 1)
  })

  it('never lets a partial line list shrink a declared book-wide scope', () => {
    // Two of thirty lines scaffolded, summing 215, against a declared 1,400.
    // The larger figure must hold, or adding a line would raise the score.
    const { book, sections, weldLines, sectionDefinitions } = scaffoldJobBook({
      ...BASE,
      scope: [{ sectionNumber: '12', expectedCount: 1400 }],
      weldLines: [
        { lineCode: 'FL1', expectedWeldCount: 120 },
        { lineCode: 'FL2', expectedWeldCount: 95 },
      ],
    }, idFor)
    const b = { ...bundleFor([]), book, sections, weldLines, sectionDefinitions }
    const welds = Array.from({ length: 140 }, (_, i) => completeWeld(i, weldLines[0]!.id))
    const def = sectionDefinitions.find((d) => d.sectionNumber === '12')!
    const section = sections.find((s) => s.sectionDefinitionId === def.id)!
    expect(scoreSection(def, section, { ...b, welds }).pct).toBeCloseTo(10, 1)
  })
})

describe('scaffolding a new book', () => {
  const { book, sections, sectionDefinitions } = scaffoldJobBook(BASE, idFor)

  it('creates every checklist section, none omitted', () => {
    expect(sections).toHaveLength(sectionDefinitions.length)
    for (const n of ['1', '12', '17', '18', '19', '22', '19-22']) {
      const def = sectionDefinitions.find((d) => d.sectionNumber === n)
      expect(def, `section ${n} missing`).toBeDefined()
      expect(sections.some((s) => s.sectionDefinitionId === def!.id)).toBe(true)
    }
  })

  it('marks facility-only sections N/A on a flowline book, with a reason', () => {
    for (const n of ['19', '20', '21', '22']) {
      const def = sectionDefinitions.find((d) => d.sectionNumber === n)!
      const s = sections.find((x) => x.sectionDefinitionId === def.id)!
      expect(s.status).toBe('na')
      expect(s.naReason).toBeTruthy()
    }
  })

  it('activates 19–22 on a facility book instead', () => {
    const f = scaffoldJobBook({ ...BASE, bookType: 'facility' }, idFor)
    for (const n of ['19', '20', '21', '22']) {
      const def = f.sectionDefinitions.find((d) => d.sectionNumber === n)!
      expect(f.sections.find((x) => x.sectionDefinitionId === def.id)!.status).toBe('not_started')
    }
    expect(f.sectionDefinitions.some((d) => d.sectionNumber === '19-22')).toBe(false)
  })

  it('marks a section scoped to zero as N/A rather than parking it at 0%', () => {
    const { sections: s2, sectionDefinitions: d2 } = scaffoldJobBook(
      { ...BASE, scope: [{ sectionNumber: '18', expectedCount: 0 }] }, idFor)
    const def = d2.find((d) => d.sectionNumber === '18')!
    const section = s2.find((x) => x.sectionDefinitionId === def.id)!
    expect(section.status).toBe('na')
    expect(section.naReason).toContain('Scoped to zero')
    expect(section.expectedCount).toBeNull()
  })

  it('starts a new book at 0%, not at 100% for having nothing in it', () => {
    const b = bundleFor([
      { sectionNumber: '12', expectedCount: 1400 },
      { sectionNumber: '14', expectedCount: 380 },
      { sectionNumber: '15', expectedCount: 150 },
      { sectionNumber: '6', expectedCount: 6 },
      { sectionNumber: '13', expectedCount: 8 },
      { sectionNumber: '10', expectedCount: 30 },
      { sectionNumber: '17', expectedCount: 12 },
      { sectionNumber: '18', expectedCount: 40 },
    ])
    expect(scoreBook(b).overallPct).toBe(0)
  })

  it('opens in setup status with today as its own as-of date', () => {
    expect(book.status).toBe('setup')
    expect(book.dataAsOfDate).toBeNull()
  })

  it('carries the operator thresholds onto the book', () => {
    const b = scaffoldJobBook({ ...BASE, requiredXrayPct: 20, torqueTolerancePct: 3 }, idFor)
    expect(b.book.requiredXrayPct).toBe(20)
    expect(b.book.torqueTolerancePct).toBe(3)
    // Unspecified thresholds fall back to the documented defaults.
    expect(b.book.requiredTorqueInspectPct).toBe(10)
    expect(b.book.certExpiryWarningDays).toBe(60)
  })
})

describe('setup validation', () => {
  it('requires a job number and an operator', () => {
    const { errors } = validateNewJobBook({ ...BASE, jobNumber: '', clientOrgId: '' })
    expect(errors.map((e) => e.field)).toContain('jobNumber')
    expect(errors.map((e) => e.field)).toContain('clientOrgId')
  })

  it('rejects a construction window that ends before it starts', () => {
    const { errors } = validateNewJobBook({
      ...BASE, constructionStart: '2026-09-01', constructionEnd: '2026-03-01',
    })
    expect(errors.some((e) => e.field === 'constructionEnd')).toBe(true)
  })

  it('rejects duplicate line codes', () => {
    const { errors } = validateNewJobBook({
      ...BASE, weldLines: [{ lineCode: 'FL1' }, { lineCode: 'fl1' }],
    })
    expect(errors.some((e) => /Duplicate line code/.test(e.message))).toBe(true)
  })

  it('warns — but does not block — when no scope is declared', () => {
    const { errors, warnings } = validateNewJobBook(BASE)
    expect(errors).toHaveLength(0)
    expect(warnings.some((w) => w.field === 'scope')).toBe(true)
  })

  it('warns when the per-line total disagrees with the section figure', () => {
    const { warnings } = validateNewJobBook({
      ...BASE,
      scope: [{ sectionNumber: '12', expectedCount: 1400 }],
      weldLines: [{ lineCode: 'FL1', expectedWeldCount: 215 }],
    })
    expect(warnings.some((w) => w.field === 'weldLines')).toBe(true)
  })
})

describe('what the wizard asks for', () => {
  const prompts = scopePrompts('flowline')

  it('asks for a quantity on every scoring section', () => {
    for (const n of ['2', '6', '10', '12', '13', '14', '15', '17', '18']) {
      expect(prompts.map((p) => p.sectionNumber)).toContain(n)
    }
  })

  it('never asks for a quantity on a derived section, which would double-count', () => {
    expect(prompts.map((p) => p.sectionNumber)).not.toContain('11')
  })

  it('never asks on the generated checklist section', () => {
    expect(prompts.map((p) => p.sectionNumber)).not.toContain('1')
  })

  it('asks in the units a QA/QC tech would use, and says where each comes from', () => {
    expect(prompts.find((p) => p.sectionNumber === '12')!.unit).toBe('joints')
    expect(prompts.find((p) => p.sectionNumber === '14')!.unit).toBe('flanged connections')
    expect(prompts.find((p) => p.sectionNumber === '15')!.unit).toBe('heat numbers')
    for (const p of prompts) expect(p.source.length).toBeGreaterThan(0)
  })

  it('offers the facility-only sections on a facility book only', () => {
    expect(scopePrompts('facility').map((p) => p.sectionNumber)).toContain('19')
    expect(prompts.map((p) => p.sectionNumber)).not.toContain('19')
    expect(prompts.map((p) => p.sectionNumber)).toContain('19-22')
  })
})

describe('the delivered DP452 book is unaffected', () => {
  it('still scores 80.64% with no scope declared', () => {
    expect(scoreBook(buildDp452Bundle()).overallPct).toBe(80.64)
  })
})

describe('an empty book reports nothing as reassuring', () => {
  /**
   * "0 of 0" is vacuously 100%, and a brand-new book is full of zero-over-
   * zero. Every headline figure must read as absent rather than as
   * achieved, or the setup screen would contradict the whole point of
   * declaring scope.
   */
  const empty = bundleFor([
    { sectionNumber: '12', expectedCount: 1400 },
    { sectionNumber: '15', expectedCount: 150 },
    { sectionNumber: '6', expectedCount: 6 },
    { sectionNumber: '13', expectedCount: 8 },
  ])

  it('does not claim MTR coverage when no weld references a heat', () => {
    const def = empty.sectionDefinitions.find((d) => d.sectionNumber === '15')!
    const section = empty.sections.find((s) => s.sectionDefinitionId === def.id)!
    const score = scoreSection(def, section, empty)
    expect(score.pct).toBe(0)
    expect(score.explanation).toContain('No welds reference a heat yet')
    // The declared scope must never be described as already referenced.
    expect(score.explanation).not.toMatch(/150 heat numbers referenced/)
  })

  it('does not claim personnel or equipment coverage before any work is recorded', () => {
    for (const n of ['6', '13']) {
      const def = empty.sectionDefinitions.find((d) => d.sectionNumber === n)!
      const section = empty.sections.find((s) => s.sectionDefinitionId === def.id)!
      const score = scoreSection(def, section, empty)
      expect(score.pct).toBe(0)
      expect(score.explanation).toMatch(/None of the \d+ expected/)
    }
  })

  it('scores the whole book at zero rather than at a vacuous hundred', () => {
    expect(scoreBook(empty).overallPct).toBe(0)
  })
})
