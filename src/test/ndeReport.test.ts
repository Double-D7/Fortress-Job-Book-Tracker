/**
 * Reading a radiographic inspection report.
 *
 * The lines here are the real shapes from the five DP-318 reports, which
 * come from two inspection companies with different templates. Both were
 * unreadable before the CMap work and both are parsed by the same code
 * now, so the cases that matter are the ones where they differ.
 */
import { describe, expect, it } from 'vitest'
import { isoDate, parseNdeReport, weldTokensOnLine } from '@/lib/import/ndeReport'
import type { PdfExtraction } from '@/lib/import/pdfText'

/** Wrap lines as the extractor would hand them over. */
function extraction(...texts: string[]): PdfExtraction {
  return {
    pages: [{ index: 0, lines: texts.map((t) => ({ y: 0, runs: [], text: t })) }],
    emptyStreams: 0,
    undecodable: 0,
  }
}

describe('weld numbers, whatever the prefix', () => {
  it('reads a field weld', () => {
    expect(weldTokensOnLine('12 FW-1130 0,1,2 3.5 D')[0]).toBe('FW-1130')
  })

  it('offers every token on a row it does not recognise', () => {
    // A real report row reads "(CW-1) DRTI-001P". Matching FW only found
    // nothing there and returned a report covering no welds, with no
    // rows flagged unread — a failure that looks like a success.
    //
    // What CW means is not this module's business and it must not
    // guess: in AWS terminology CW is Certified Welder, so that row may
    // name no weld at all. Both tokens are offered and the weld log
    // decides, which is the only place the answer actually exists.
    const got = weldTokensOnLine('1 (CW-1) DRTI-001P 0,1,2 3.1')
    expect(got).toContain('CW-1')
    expect(got).toContain('DRTI-001P')
  })

  it('offers the field weld and the line identifier both', () => {
    // "(FW-850)DSFB-850" is a field weld and the line it sits on, not one
    // weld written twice — an earlier reading here assumed the latter and
    // threw the line identifier away. Which of the two the log keys on is
    // the log's business, so both are offered.
    expect(weldTokensOnLine('1 (FW-850)DSFB-850 0,1,2 6.625'))
      .toEqual(['FW-850', 'DSFB-850'])
  })

  it('returns an identical token only once', () => {
    // Dedup is on the exact token, so a row repeating one identifier
    // does not double that weld's count.
    expect(weldTokensOnLine('1 FW-850 FW-850 6.625')).toEqual(['FW-850'])
  })

  it('keeps a letter suffix, which distinguishes a weld', () => {
    expect(weldTokensOnLine('2 (FW-851P)DSFB-851P')[0]).toBe('FW-851P')
  })

  it('puts the weld before the IQI codes that share its shape', () => {
    // The selection rule downstream is "first candidate that matches the
    // log". That only works if the weld is printed first, which it is on
    // both vendors' sheets.
    const got = weldTokensOnLine('12 FW-1130 0,1,2 3.5 D N/A 0.250 B7 0.028 LC')
    expect(got[0]).toBe('FW-1130')
    expect(got).toContain('B-7')
  })
})

describe('the report date', () => {
  it('takes the report date, not the procedure revision date', () => {
    // Three of five real reports came back with the wrong date because
    // "REV. DATE:" matches a bare /DATE/ first, and one was two years
    // out. A reviewer uses this to decide whether the examination
    // preceded the pressure test.
    const r = parseNdeReport(extraction(
      'PROCEDURE # API-MT-001 REVISION # 24 REV. DATE: 1/7/2024',
      'DATE 2/23/2026 DESCRIPTION: DP-318 REPORT NUMBER: 022326BL-RT',
    ))
    expect(r.reportDate).toBe('2026-02-23')
  })

  it('is not fooled by a calibration date', () => {
    const r = parseNdeReport(extraction(
      'Light Intensity Meter Cal Date: 4/6/2026',
      'DATE 6/5/2026 REPORT NUMBER: 060526JF-CR',
    ))
    expect(r.reportDate).toBe('2026-06-05')
  })

  it('refuses a date it cannot read rather than inventing one', () => {
    expect(isoDate('13/45/2026')).toBeNull()
    expect(isoDate(null)).toBeNull()
    expect(isoDate('sometime in March')).toBeNull()
  })

  it('expands a two-digit year', () => {
    expect(isoDate('6/5/26')).toBe('2026-06-05')
  })
})

describe('header fields printed on one line', () => {
  const r = parseNdeReport(extraction(
    'PROCEDURE # API-RT-006- CR ASME REVISION # 3 REV. DATE: 2/28/2025',
    'APPLICABLE CODE ASME ACCEPTANCE CRITERIA ASME B31.3',
    'Technician Name (Printed) Brendan LeCompte Customer Printed: Antonio Brito',
    'DATE 6/5/2026 DESCRIPTION: Bill to Fortress REPORT NUMBER: 060526JF-CR',
  ))

  it('stops a value where the next label starts', () => {
    // The first version reported the procedure as "API-RT-006- CR ASME
    // REVISION # 3 REV. DATE: 2/28/2025" — three fields in one.
    expect(r.procedureReference).toBe('API-RT-006- CR ASME')
    expect(r.revision).toBe('3')
  })

  it('does not take the customer as the technician', () => {
    expect(r.technicianName).toBe('Brendan LeCompte')
  })

  it('reads the acceptance criteria and report number', () => {
    expect(r.acceptanceCriteria).toBe('ASME B31.3')
    expect(r.reportNumber).toBe('060526JF-CR')
  })
})

describe('the exposure table', () => {
  const r = parseNdeReport(extraction(
    '1 FW-1080 0,1,2 4.5 D N/A 0.337 B7 0.023 2.9 #S KT',
    '2 FW-1079 0,1,2 4.5 D N/A 0.250 B7 0.023 2.8 #S KT',
    '3 FW-851P 0,1,2 6.625 D N/A 0.280 B7 Porosity/ESI (0-1) JP',
    'American Piping Inspection, Inc. 17110 East Pine St, Tulsa, OK 74116',
  ))

  it('keeps one row per exposure', () => {
    expect(r.lines).toHaveLength(3)
    expect(r.lines.map((l) => l.candidates[0]))
      .toEqual(['FW-1080', 'FW-1079', 'FW-851P'])
  })

  it('orders by the row number the vendor printed', () => {
    // Pages drawn with a flipped transform come out of the extractor
    // bottom to top; the printed number is the reliable order.
    expect(r.lines.map((l) => l.sequence)).toEqual([1, 2, 3])
  })

  it('carries the discontinuity as text without judging it', () => {
    // "Porosity/ESI (0-1)" is a finding a person reads. Turning it into a
    // pass or a fail here would put a verdict in the record that no
    // inspector wrote.
    expect(r.lines[2]!.discontinuity).toMatch(/Porosity/)
    expect(r.lines[0]!.discontinuity).toBeNull()
  })

  it('reads the welder stamp off the end of the row', () => {
    expect(r.lines[0]!.welderStamp).toBe('KT')
  })

  it('does not take letterhead as an exposure', () => {
    // An address contains "OK-74116", which is weld-shaped. Table rows
    // are numbered; letterhead is not.
    expect(r.lines.some((l) => l.candidates.includes('OK-74116'))).toBe(false)
  })

  it('reads the company off its letterhead', () => {
    expect(r.ndtCompany).toBe('American Piping Inspection, Inc')
  })
})

describe('a table that did not parse', () => {
  it('counts rows it could not read rather than reporting no welds', () => {
    // The dangerous shape: a report that covers welds arriving as one
    // that covers none, with nothing to say it failed.
    const r = parseNdeReport(extraction(
      '9   mm      m L /-   E-  o -   a row of decode noise with no token',
    ))
    expect(r.lines).toHaveLength(0)
    expect(r.unreadRows).toBeGreaterThan(0)
  })
})
