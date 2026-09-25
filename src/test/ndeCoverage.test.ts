/**
 * Required, examined, evidenced.
 *
 * A book passes its own arithmetic on what the log says was examined and
 * fails an audit on what it can evidence, because an auditor asks for the
 * report. Every case here is about keeping those two apart.
 */
import { describe, expect, it } from 'vitest'
import { ndeCoverage, requiredNdePct } from '@/lib/domain/ndeCoverage'
import type { JobBook, NdeReport, Weld } from '@/lib/domain/types'

function weld(over: Partial<Weld> & { id: string; weldNumber: string }): Weld {
  return {
    weldLineId: 'l', jobBookId: 'b', sortOrder: 0, weldDate: null,
    welderPassAssignment: null, rootWelderId: null, hotWelderId: null,
    fillWelderId: null, capWelderId: null, welderStamp: null, welderId: null,
    jointType: 'Butt', componentDescription: null, partLength: null,
    heatNumbers: [], cwiInitials: null, cwiId: null, cwiVisualResult: null,
    visualInspectionDate: null, ndtCompany: null, xrayNumber: null,
    ndtTicketNumber: null, ndtMethod: null, ndtResult: null, ndtReportId: null,
    status: 'visual_complete', comments: null, ...over,
  }
}

function report(weldIds: (string | null)[], over: Partial<NdeReport> = {}): NdeReport {
  return {
    id: 'r1', jobBookId: 'b', reportNumber: 'R-1', reportDate: '2025-11-19',
    method: 'RT', isSuperseded: false,
    lines: weldIds.map((weldId, i) => ({ id: `l${i}`, ndeReportId: 'r1', weldId })),
    enteredAt: '2025-11-19T00:00:00Z', enteredBy: null, entrySource: 'field_entry',
    ...over,
  } as NdeReport
}

/** DP-318's own rule, read off the log: 100% visual and 10% NDE. */
const FLAT: Pick<JobBook, 'inspectionRule'> = {
  inspectionRule: { kind: 'flat', requiredVisualPct: 100, requiredNdePct: 10 },
}

/** Ten welds; four the log calls examined. */
const WELDS: Weld[] = [
  weld({ id: 'w1', weldNumber: '1', ndtMethod: 'RT' }),
  weld({ id: 'w2', weldNumber: '2', ndtMethod: 'RT' }),
  weld({ id: 'w3', weldNumber: '3', xrayNumber: 'RT-3' }),
  weld({ id: 'w4', weldNumber: '4', ndtMethod: 'RT' }),
  ...Array.from({ length: 6 }, (_, i) =>
    weld({ id: `p${i}`, weldNumber: `${10 + i}` })),
]

describe('the gap between examined and evidenced', () => {
  it('reports both, and does not let the log stand in for a report', () => {
    // The state this exists for: the log claims four examinations and no
    // report evidences any of them.
    const c = ndeCoverage(WELDS, [], FLAT)
    expect(c.examined).toBe(4)
    expect(c.evidenced).toBe(0)
    expect(c.unevidenced).toEqual(['1', '2', '3', '4'])
  })

  it('counts a weld as evidenced only when a report line names it', () => {
    const c = ndeCoverage(WELDS, [report(['w1', 'w2'])], FLAT)
    expect(c.evidenced).toBe(2)
    expect(c.unevidenced).toEqual(['3', '4'])
  })

  it('passes on the log and fails on the evidence', () => {
    // Ten countable welds, 10% required: one weld. The log says four; a
    // report evidences none. Both answers are true and only one survives
    // an audit.
    const c = ndeCoverage(WELDS, [], FLAT)
    expect(c.meetsOnExamined).toBe(true)
    expect(c.meetsOnEvidenced).toBe(false)
  })

  it('names welds a report covers that the log does not mark examined', () => {
    // Usually the log lagging the report, which is how weld 675 looks on
    // the real DP-318 book.
    const c = ndeCoverage(WELDS, [report(['p0'])], FLAT)
    expect(c.unlogged).toEqual(['10'])
  })
})

describe('superseded reports', () => {
  it('do not evidence anything', () => {
    // Their successor carries the current reading; counting both would
    // evidence a weld twice off one examination.
    const c = ndeCoverage(WELDS, [report(['w1'], { isSuperseded: true })], FLAT)
    expect(c.evidenced).toBe(0)
  })
})

describe('the requirement', () => {
  it('rounds the required count up', () => {
    // 10% of 10 is 1. 10% of 1,259 is 125.9, and 125 examinations does
    // not satisfy a 10% rule.
    const many = Array.from({ length: 1259 }, (_, i) =>
      weld({ id: `m${i}`, weldNumber: `${i + 1}` }))
    expect(ndeCoverage(many, [], FLAT).requiredWelds).toBe(126)
  })

  it('compares whole welds, not the rounded percentage', () => {
    // 125 of 1,259 is 9.92%, which displays as 9.9 and must not pass a
    // 10% rule by rounding.
    const many = Array.from({ length: 1259 }, (_, i) =>
      weld({ id: `m${i}`, weldNumber: `${i + 1}`, ndtMethod: i < 125 ? 'RT' : null }))
    const c = ndeCoverage(many, [], FLAT)
    expect(c.examined).toBe(125)
    expect(c.meetsOnExamined).toBe(false)
  })

  it('says nothing rather than guessing on a tiered rule', () => {
    // A tiered rule owes different percentages to different welds and
    // cannot be reduced to one number. Reporting the flat answer for a
    // job that is not flat is how 90 welds came to be flagged for
    // examinations nothing required.
    const tiered: Pick<JobBook, 'inspectionRule'> = {
      inspectionRule: { kind: 'tiered', confirmed: true },
    }
    expect(requiredNdePct(tiered)).toBeNull()
    const c = ndeCoverage(WELDS, [], tiered)
    expect(c.requiredWelds).toBeNull()
    expect(c.meetsOnEvidenced).toBeNull()
  })

  it('says nothing when the book states no rule at all', () => {
    const c = ndeCoverage(WELDS, [], {})
    expect(c.requiredPct).toBeNull()
    expect(c.meetsOnExamined).toBeNull()
  })
})

describe('welds that count', () => {
  it('excludes NOT USED numbers from every figure', () => {
    // Gaps in the sequence by design; counting them would dilute the
    // percentage and understate coverage.
    const withGaps = [
      ...WELDS,
      weld({ id: 'nu', weldNumber: '99', status: 'not_used' }),
    ]
    expect(ndeCoverage(withGaps, [], FLAT).countableWelds).toBe(WELDS.length)
  })

  it('reports zero percent on an empty book without dividing by zero', () => {
    const c = ndeCoverage([], [], FLAT)
    expect(c.examinedPct).toBe(0)
    expect(c.evidencedPct).toBe(0)
    expect(c.countableWelds).toBe(0)
  })
})

describe('the lists a person checks against the log', () => {
  it('are in weld number order, not database order', () => {
    // Unsorted these came out as "15, 19, 25, 4, 20, 9" and read as
    // noise. They are scanned against a weld log by eye.
    const shuffled: Weld[] = ['15', '4', '25', '9', '20'].map((n, i) =>
      weld({ id: `s${i}`, weldNumber: n, ndtMethod: 'RT' }))
    expect(ndeCoverage(shuffled, [], FLAT).unevidenced)
      .toEqual(['4', '9', '15', '20', '25'])
  })

  it('sorts a decimal repair beside its parent weld', () => {
    const repairs: Weld[] = ['124', '124.2', '124.1', '125'].map((n, i) =>
      weld({ id: `r${i}`, weldNumber: n, ndtMethod: 'RT' }))
    expect(ndeCoverage(repairs, [], FLAT).unevidenced)
      .toEqual(['124', '124.1', '124.2', '125'])
  })
})
