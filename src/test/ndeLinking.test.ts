/**
 * Tying a radiograph to the right weld.
 *
 * The case that drives this file is real and present in this project's
 * own data: weld number `W-0001` appears five times in one book. A
 * matcher that took the first row would attach a film to whichever weld
 * the query returned, reporting the wrong pipe as examined while the one
 * actually shot stays looking unexamined.
 */
import { describe, expect, it } from 'vitest'
import {
  linesNotMarkedExamined, matchWeldNumbers, parseWeldNumberList, summarise,
  ticketOf, weldNumberKey, weldsForTicket,
} from '@/lib/domain/ndeLinking'
import type { Weld } from '@/lib/domain/types'

function weld(over: Partial<Weld> & { id: string; weldNumber: string }): Weld {
  return {
    weldLineId: 'l', jobBookId: 'b', sortOrder: 0, weldDate: '2025-10-01',
    welderPassAssignment: null, rootWelderId: null, hotWelderId: null,
    fillWelderId: null, capWelderId: null, welderStamp: null, welderId: null,
    jointType: 'Butt', componentDescription: null, partLength: null,
    heatNumbers: [], cwiInitials: null, cwiId: null, cwiVisualResult: null,
    visualInspectionDate: null, ndtCompany: null, xrayNumber: null,
    ndtTicketNumber: null, ndtMethod: null, ndtResult: null, ndtReportId: null,
    status: 'visual_complete', comments: null, ...over,
  }
}

/** A book where one weld number genuinely repeats, as the live data does. */
const BOOK: Weld[] = [
  weld({ id: 'a1', weldNumber: 'W-0001', ndtMethod: 'RT', ndtTicketNumber: 'RT-1000' }),
  weld({ id: 'a2', weldNumber: 'W-0001', ndtMethod: 'RT', ndtTicketNumber: 'RT-1000' }),
  weld({ id: 'b1', weldNumber: 'W-0002', ndtMethod: 'RT', xrayNumber: 'RT-1001' }),
  weld({ id: 'c1', weldNumber: 'W-0003' }),
]

describe('a weld number that repeats in one book', () => {
  it('is reported as ambiguous, naming every candidate', () => {
    const m = matchWeldNumbers(BOOK, ['W-0001'])[0]!
    expect(m.status).toBe('ambiguous')
    expect(m.status === 'ambiguous' ? m.weldIds : null).toEqual(['a1', 'a2'])
  })

  it('never silently picks one', () => {
    // The failure this module exists to prevent. If this ever returns
    // 'matched', a film is being attached to a weld nobody chose.
    for (const m of matchWeldNumbers(BOOK, ['W-0001', 'w0001', 'W 0001'])) {
      expect(m.status, m.weldNumber).not.toBe('matched')
    }
  })
})

describe('matching a single weld number', () => {
  it('resolves an unambiguous one', () => {
    const [m] = matchWeldNumbers(BOOK, ['W-0002'])
    expect(m).toEqual({ status: 'matched', weldNumber: 'W-0002', weldId: 'b1' })
  })

  it('matches across the punctuation a report prints', () => {
    for (const printed of ['W-0002', 'W0002', 'w 0002', 'W_0002']) {
      const [m] = matchWeldNumbers(BOOK, [printed])
      expect(m!.status, printed).toBe('matched')
    }
  })

  it('does not treat leading zeros as noise', () => {
    // W-0002 and W-2 are not obviously the same weld, and guessing that
    // they are would link a report to whatever happened to be nearby.
    expect(matchWeldNumbers(BOOK, ['W-2'])[0]!.status).toBe('unknown')
  })

  it('reports a weld number this book does not have', () => {
    // Usually means the report belongs to another job book — which is
    // exactly the mis-filing the schema records referencedFacility for.
    const [m] = matchWeldNumbers(BOOK, ['W-9999'])
    expect(m).toEqual({ status: 'unknown', weldNumber: 'W-9999' })
  })

  it('keeps the order the report printed them in', () => {
    const got = matchWeldNumbers(BOOK, ['W-0003', 'W-0002'])
    expect(got.map((m) => m.weldNumber)).toEqual(['W-0003', 'W-0002'])
  })
})

describe('proposing lines from the weld log', () => {
  it('finds the welds examined under a ticket number', () => {
    expect(weldsForTicket(BOOK, 'RT-1000').map((w) => w.id)).toEqual(['a1', 'a2'])
  })

  it('reads the x-ray number when the ticket column is empty', () => {
    // Two columns carry the same fact depending on the log's vintage.
    expect(weldsForTicket(BOOK, 'RT-1001').map((w) => w.id)).toEqual(['b1'])
  })

  it('matches a ticket however it is punctuated', () => {
    expect(weldsForTicket(BOOK, 'rt1000').map((w) => w.id)).toEqual(['a1', 'a2'])
  })

  it('proposes nothing rather than guessing when the log says nothing', () => {
    // No dates, no sequence, no "probably these". An empty proposal is a
    // person typing the list; a wrong one is a film on the wrong weld.
    expect(weldsForTicket(BOOK, 'RT-9999')).toEqual([])
    expect(weldsForTicket(BOOK, '')).toEqual([])
    expect(weldsForTicket(BOOK, '---')).toEqual([])
  })

  it('reads the ticket off a weld from either column', () => {
    expect(ticketOf(BOOK[0]!)).toBe('RT-1000')
    expect(ticketOf(BOOK[2]!)).toBe('RT-1001')
    expect(ticketOf(BOOK[3]!)).toBeNull()
  })
})

describe('the pasted list', () => {
  it('takes whatever separator a person produces', () => {
    for (const raw of [
      'W-0001 W-0002', 'W-0001, W-0002', 'W-0001;W-0002', 'W-0001\nW-0002',
    ]) {
      expect(parseWeldNumberList(raw), raw).toEqual(['W-0001', 'W-0002'])
    }
  })

  it('collapses the same weld typed twice', () => {
    expect(parseWeldNumberList('W-0001 w0001 W-0002')).toEqual(['W-0001', 'W-0002'])
  })

  it('drops what is not a weld number', () => {
    expect(parseWeldNumberList('')).toEqual([])
    expect(parseWeldNumberList('  --- ')).toEqual([])
  })
})

describe('what the screen totals', () => {
  it('counts each kind and calls a clean set clean', () => {
    expect(summarise(matchWeldNumbers(BOOK, ['W-0002', 'W-0003'])))
      .toEqual({ matched: 2, ambiguous: 0, unknown: 0, clean: true })
  })

  it('is not clean when anything is unresolved', () => {
    // Filing a report whose lines do not all resolve would record
    // coverage the book cannot stand behind.
    expect(summarise(matchWeldNumbers(BOOK, ['W-0001'])).clean).toBe(false)
    expect(summarise(matchWeldNumbers(BOOK, ['W-9999'])).clean).toBe(false)
  })

  it('is clean on an empty set, which the caller gates separately', () => {
    expect(summarise([])).toEqual({ matched: 0, ambiguous: 0, unknown: 0, clean: true })
  })
})

describe('a report covering a weld the log does not call examined', () => {
  it('names it rather than blocking it', () => {
    // Legitimate: the report is often what the weld log gets updated
    // from. The reverse — a report claiming a weld nobody shot — is how a
    // book over-reports coverage, so it is shown either way.
    expect(linesNotMarkedExamined(BOOK, matchWeldNumbers(BOOK, ['W-0003'])))
      .toEqual(['W-0003'])
  })

  it('says nothing about welds the log already marks examined', () => {
    expect(linesNotMarkedExamined(BOOK, matchWeldNumbers(BOOK, ['W-0002'])))
      .toEqual([])
  })
})
