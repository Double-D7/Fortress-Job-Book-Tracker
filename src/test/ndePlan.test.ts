/**
 * What filing an NDE report would do to a book.
 *
 * The cases here are the ones measured against the real DP-318 reports
 * and the real 1,259-row weld log, because every one of them was found
 * that way rather than imagined.
 */
import { describe, expect, it } from 'vitest'
import {
  countPlan, evidencedButNotLogged, methodFrom, planNdeImport, planReport,
} from '@/lib/domain/ndePlan'
import type { ParsedNdeDocument, ParsedNdeReport } from '@/lib/import/ndeReport'
import type { Weld } from '@/lib/domain/types'

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

/** The shape of the real log: bare numbers, welder stamp, ticket as a date. */
const LOG: Weld[] = [
  weld({ id: 'w1130', weldNumber: '1130', welderStamp: 'LC', ndtTicketNumber: '11/19/25', ndtMethod: 'RT' }),
  weld({ id: 'w675', weldNumber: '675', welderStamp: 'KT' }),
  weld({ id: 'w17', weldNumber: '17' }),
  weld({ id: 'w10', weldNumber: '10' }),
  weld({ id: 'w1', weldNumber: '1', welderStamp: 'KT' }),
]

function report(over: Partial<ParsedNdeReport> = {}): ParsedNdeReport {
  return {
    reportNumber: '111925BL-RT', reportDate: '2025-11-19',
    ndtCompany: 'American Piping Inspection, Inc', technicianName: 'Brendan LeCompte',
    procedureReference: 'API-RT-006', revision: '3', acceptanceCriteria: 'ASME B31.3',
    jobLocation: null, lines: [], unreadRows: 0, ...over,
  }
}

function line(candidates: string[], over: Record<string, unknown> = {}) {
  return {
    sequence: 1, candidates, raw: candidates.join(' '),
    discontinuity: null, welderStamp: null, ...over,
  } as ParsedNdeReport['lines'][number]
}

describe('the examination method', () => {
  it('is read from the procedure, which names it', () => {
    expect(methodFrom(report({ procedureReference: 'API-RT-006- CR ASME' }))).toBe('RT')
    expect(methodFrom(report({ procedureReference: 'API-MT-001' }))).toBe('MT')
    expect(methodFrom(report({ procedureReference: 'API-PT-001' }))).toBe('PT')
  })

  it('is null rather than guessed', () => {
    // Guessing RT because it is commonest would put a volumetric claim on
    // a surface examination.
    expect(methodFrom(report({ procedureReference: null, reportNumber: null }))).toBeNull()
  })
})

describe('a row the log corroborates', () => {
  it('is confirmed on the welder stamp', () => {
    const p = planReport(report({
      lines: [line(['FW-1130', 'B-7'], { welderStamp: 'LC' })],
    }), LOG)
    expect(p.rows[0]!.status).toBe('confirmed')
    expect(p.rows[0]!.weldNumber).toBe('1130')
  })

  it('prefers the weld column over an IQI code that shares its shape', () => {
    // B-7 keys to weld 7 exactly as FW-7 would. Both vendors print the
    // weld column first, which is the only reason this is safe.
    const p = planReport(report({
      lines: [line(['FW-1130', 'B-7'], { welderStamp: 'LC' })],
    }), LOG)
    expect(p.rows[0]!.printed).toBe('FW-1130')
  })
})

describe('a row with nothing to corroborate it', () => {
  it('is not written without somebody saying so', () => {
    // Measured, not assumed: the film sizes in the image-plate table of
    // the real 11/19/25 report — 4.5" X 17", 3.5" X 10" — resolve to
    // welds 17 and 10 with nothing to contradict them. Treating
    // "unchecked" as writable would have attached radiographs to three
    // welds nobody examined.
    const plan = planNdeImport(
      { reports: [report({ lines: [line(['X-17']), line(['X-10'])] })], gaps: [], complete: true },
      LOG,
    )
    expect(plan.reports[0]!.rows.every((r) => r.status === 'unchecked')).toBe(true)
    expect(countPlan(plan).writable).toBe(0)
  })

  it('is held apart from one that actively disagrees', () => {
    // Absence of evidence and disagreement are different, and the screen
    // needs to say which.
    const p = planReport(report({
      lines: [line(['FW-675'], { welderStamp: 'MR' })],
    }), LOG)
    // The log says KT for weld 675; the report says MR.
    expect(p.rows[0]!.status).toBe('unconfirmed')
  })
})

describe('a weld number that several welds carry', () => {
  it('is never resolved here', () => {
    const twins = [
      weld({ id: 'a', weldNumber: '42' }),
      weld({ id: 'b', weldNumber: '42' }),
    ]
    const p = planReport(report({ lines: [line(['FW-42'])] }), twins)
    expect(p.rows[0]!.status).toBe('ambiguous')
    expect(p.rows[0]!.candidateWeldIds).toEqual(['a', 'b'])
    expect(p.rows[0]!.weldId).toBeNull()
  })
})

describe('a row naming no weld this book has', () => {
  it('is reported rather than dropped', () => {
    const p = planReport(report({ lines: [line(['FW-9999'])] }), LOG)
    expect(p.rows[0]!.status).toBe('unmatched')
    expect(p.rows[0]!.printed).toBe('FW-9999')
  })
})

describe('welds evidenced by a report but not logged as examined', () => {
  it('names the real one', () => {
    // Weld 675 is on the real 11/19/25 report and carries no ticket or
    // method in the log. The report is often what the log gets updated
    // from, so this is a finding, not an error.
    const plan = planNdeImport(
      { reports: [report({ lines: [line(['FW-675'], { welderStamp: 'MR' })] })], gaps: [], complete: true },
      LOG,
    )
    expect(evidencedButNotLogged(plan, LOG)).toEqual(['675'])
  })

  it('does not invent findings from rows with nothing to check', () => {
    // X-17 and X-10 resolve to welds 17 and 10, which have no ticket
    // either. Listing them would bury the one real finding under three
    // invented ones.
    const plan = planNdeImport(
      { reports: [report({ lines: [line(['X-17']), line(['X-10'])] })], gaps: [], complete: true },
      LOG,
    )
    expect(evidencedButNotLogged(plan, LOG)).toEqual([])
  })
})

describe('the counts the screen shows', () => {
  it('adds up and carries the critical gaps through', () => {
    const doc: ParsedNdeDocument = {
      reports: [report({
        lines: [
          line(['FW-1130'], { welderStamp: 'LC' }),
          line(['FW-675'], { welderStamp: 'MR' }),
          line(['X-17']),
          line(['FW-9999']),
        ],
      })],
      gaps: [
        { kind: 'page_empty', severity: 'critical', detail: 'x', page: 2 },
        { kind: 'missing_field', severity: 'warning', detail: 'y' },
      ],
      complete: false,
    }
    const c = countPlan(planNdeImport(doc, LOG))
    expect(c).toMatchObject({
      reports: 1, rows: 4, confirmed: 1, unconfirmed: 1, unchecked: 1,
      unmatched: 1, ambiguous: 0, writable: 1, criticalGaps: 1,
    })
  })
})
