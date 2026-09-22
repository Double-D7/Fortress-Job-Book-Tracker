/**
 * Reading the Weld Log Overview Sheet — Appendix A §11.
 *
 * Every assertion below runs against the real DP-318 sheet in
 * `fixtures/greeley/`, because a parser tested only on input it was
 * written for is a parser tested on nothing. The sheet is a PDF export of
 * a spreadsheet and it contains, on one page, at least four genuine
 * defects — which is the other reason to use it: the interesting cases in
 * this file are all real.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { baselineTolerance, extractPdfText } from '@/lib/import/pdfText'
import {
  checkWeldLogOverview, parseWeldLogOverview, parseWeldLogOverviewPdf,
} from '@/lib/import/weldLogOverview'
import { planOverviewIngest, rowsForPlan } from '@/lib/import/overviewIngest'
import { qualifiedOn } from '@/lib/domain/welders'

const PDF = readFileSync('fixtures/greeley/DP-318_Weld_Log_Overview.pdf')
const sheet = parseWeldLogOverviewPdf(PDF)

describe('the PDF gives up its table geometry', () => {
  it('finds the one page that carries text, and no font streams', () => {
    const x = extractPdfText(PDF)
    expect(x.pages).toHaveLength(1)
    expect(x.undecodable).toBe(0)
    expect(x.pages[0]!.lines.length).toBeGreaterThan(40)
  })

  it('groups runs into rows by baseline, left to right', () => {
    const line = extractPdfText(PDF).pages[0]!.lines
      .find((l) => l.text.startsWith('TYLER WALKER'))!
    expect(line.runs.map((r) => r.x)).toEqual([...line.runs.map((r) => r.x)].sort((a, b) => a - b))
    // The welder table occupies x < 450; a caption belonging to the block
    // on the right shares this baseline and is left to the column split
    // rather than to the row grouping. Row grouping answers "what is on
    // this line"; only the column cutoff can answer "what is in this
    // table", because the two tables genuinely share baselines.
    const row = line.runs.filter((r) => r.x < 450).map((r) => r.text.trim()).join(' ')
    expect(row).toBe('TYLER WALKER TW3 11/7/2026 Submitted 128 100.0% 18.8% -- 0')
  })

  it('takes the row pitch from the spacing the page is mostly made of', () => {
    // Not the median (5.1 here, which is between the two clusters and
    // wrong in both directions) and not the modal count (under 0.1pt,
    // because intra-row jitter is the commonest gap on the page).
    const ys = extractPdfText(PDF).pages[0]!.lines.flatMap((l) => l.runs.map((r) => r.y))
    expect(baselineTolerance(ys)).toBeGreaterThan(3.5)
    expect(baselineTolerance(ys)).toBeLessThan(5)
  })

  it('keeps a cell drawn low in its own row', () => {
    // Alex Emig's "Submitted" is drawn 2.6pt below its row. A tolerance
    // tuned any tighter reports a qualified CWI as having filed nothing —
    // an accusation produced by a rounding error.
    const line = extractPdfText(PDF).pages[0]!.lines.find((l) => l.text.includes('Alex Emig'))!
    expect(line.text).toMatch(/Alex Emig CWI Submitted$/)
  })

  it('reports an unreadable PDF rather than returning confident nonsense', () => {
    const parsed = parseWeldLogOverview({ pages: [], emptyStreams: 0, undecodable: 3 })
    expect(parsed.welders).toHaveLength(0)
    expect(parsed.parseIssues[0]).toMatch(/scan or uses an encoding/i)
  })
})

describe('the header', () => {
  it('reads each label’s own cell, not the joined line', () => {
    expect(sheet.header.locationName).toBe('DP-318')
    expect(sheet.header.date).toBe('2025-09-01')
    expect(sheet.header.qaqcRepresentative).toBe('ANTONIO BRITO')
    expect(sheet.header.weldingCompany).toBe('FORTRESS')
    expect(sheet.header.facilityType).toBe('FACILITY')
  })

  it('keeps the operator branding exactly as the sheet writes it', () => {
    // Normalising this away would destroy the evidence for the §3 finding.
    expect(sheet.header.operatorLabel).toBe('Noble Energy')
    expect(sheet.header.operatorPic).toBe('SCOTT GREEN')
  })

  it('reads the stated requirement even though it wraps across two lines', () => {
    expect(sheet.requirement.visualPct).toBe(100)
    expect(sheet.requirement.ndePct).toBe(10)
    expect(sheet.requirement.statedAs).toBe('100% visual & 10% NDE')
  })

  it('takes the WPS and PQR values from under their headers, not the header row', () => {
    expect(sheet.wpsReference).toBe('ASME Procedure Rev 1 WPS')
    expect(sheet.pqrReference).toBe('ASME Procedure Rev 1')
  })
})

describe('the welder roster', () => {
  it('reads all ten welders and their stamps verbatim', () => {
    expect(sheet.welders).toHaveLength(10)
    expect(sheet.welders.map((w) => w.stamp)).toEqual(
      ['TW3', 'JAP', 'MH', 'JP', 'EC', 'LC', 'MR', 'KT', 'MR LC', 'AG'],
    )
  })

  it('sums to the stated project total', () => {
    const total = sheet.welders.reduce((a, w) => a + (w.weldCount ?? 0), 0)
    expect(total).toBe(1256)
    expect(sheet.projectTotals?.weldCount).toBe(1256)
  })

  it('leaves a missing WPQ expiry missing, rather than shifting the row', () => {
    // This is the case that breaks a parser that counts columns: with no
    // date cell, every value after it moves one column left and "no
    // qualification on file" silently becomes "expires: Submitted".
    const w = sheet.welders.find((x) => x.stamp === 'MR LC')!
    expect(w.wpqExpires).toBeNull()
    expect(w.weldCount).toBe(27)
    expect(w.ndtPct).toBe(11.1)
    expect(w.failedNdt).toBe(0)
  })

  it('reads a dash as "not recorded", never as zero', () => {
    expect(sheet.welders.every((w) => w.failedVisuals === null)).toBe(true)
    expect(sheet.welders.find((w) => w.stamp === 'JP')!.failedNdt).toBe(1)
  })

  it('reads percentages as numbers', () => {
    const w = sheet.welders.find((x) => x.stamp === 'TW3')!
    expect(w.visualPct).toBe(100)
    expect(w.ndtPct).toBe(18.8)
  })
})

describe('the inspector block beside it', () => {
  it('is kept separate from the welder table sharing its baselines', () => {
    expect(sheet.inspectors).toHaveLength(6)
    expect(sheet.inspectors.filter((i) => i.qualification === 'CWI')).toHaveLength(2)
    expect(sheet.inspectors.every((i) => i.documentationSubmitted)).toBe(true)
  })
})

describe('what the sheet says about itself, checked against itself', () => {
  const findings = checkWeldLogOverview(sheet, {
    constructionStart: '2025-01-06',
    constructionEnd: '2026-06-30',
    recordedOperator: 'Chevron',
  })
  const byRule = (id: string) => findings.filter((f) => f.ruleId === id)

  it('catches the three welds attributed to no welder', () => {
    const f = byRule('overview.rollups_disagree')
    expect(f).toHaveLength(1)
    expect(f[0]!.severity).toBe('critical')
    expect(f[0]!.title).toBe('3 welds on this sheet are attributed to no welder')
    expect(f[0]!.detail).toContain('1259')
    expect(f[0]!.detail).toContain('1256')
  })

  it('catches the 100.2% visual coverage, and explains it as the same three welds', () => {
    const f = byRule('overview.coverage_above_100')
    expect(f).toHaveLength(1)
    expect(f[0]!.severity).toBe('critical')
    expect(f[0]!.detail).toContain('1259 visual inspections')
    expect(f[0]!.detail).toContain('3 more than there are welds')
  })

  it('catches the welder with 27 welds and no qualification expiry', () => {
    const f = byRule('overview.welder_without_wpq_expiry')
    expect(f).toHaveLength(1)
    expect(f[0]!.title).toContain('MIGUEL RODRIGUEZ LEO C')
    expect(f[0]!.title).toContain('27 welds')
  })

  it('catches the combined stamp', () => {
    const f = byRule('overview.combined_stamp')
    expect(f).toHaveLength(1)
    expect(f[0]!.severity).toBe('critical')
    expect(f[0]!.title).toContain('"MR LC"')
  })

  it('catches the socket welds falling short of the sheet’s own NDE requirement', () => {
    // 1 of 11 is 9.1%, and 10% of 11 needs 2. The project average of
    // 17.5% does not discharge it.
    const f = byRule('overview.nde_below_requirement')
    expect(f).toHaveLength(1)
    expect(f[0]!.title).toContain('Socket Welds')
    expect(f[0]!.detail).toContain('1 of 11 welds examined; 2 are required')
  })

  it('forecasts the three qualifications that lapse inside the work window', () => {
    const f = byRule('overview.wpq_expires_in_window')
    expect(f.map((x) => x.subject)).toEqual([
      'MITCH HOFFMEN (MH)', 'LEONEL CARBAJAL (LC)', 'KEITH TAYLOR (KT)',
    ])
  })

  it('notices the sheet is still branded to the previous operator', () => {
    const f = byRule('overview.operator_branding_stale')
    expect(f).toHaveLength(1)
    expect(f[0]!.title).toContain('Noble Energy')
    expect(f[0]!.title).toContain('Chevron')
  })

  it('says nothing about branding when the operator matches', () => {
    expect(
      checkWeldLogOverview(sheet, { recordedOperator: 'Noble Energy' })
        .filter((f) => f.ruleId === 'overview.operator_branding_stale'),
    ).toHaveLength(0)
  })

  it('raises no expiry forecast without a work window to forecast against', () => {
    expect(
      checkWeldLogOverview(sheet, {})
        .filter((f) => f.ruleId === 'overview.wpq_expires_in_window'),
    ).toHaveLength(0)
  })

  it('finds nine findings on this sheet in total', () => {
    expect(findings).toHaveLength(9)
    expect(findings.filter((f) => f.severity === 'critical')).toHaveLength(5)
  })
})

describe('planning the import', () => {
  const empty = { welders: [], welderQualifications: [], cwis: [], ndtTechnicians: [] }

  it('proposes every welder on an empty register, and skips the combined stamp', () => {
    const plan = planOverviewIngest(sheet, empty)
    expect(plan.summary.weldersToCreate).toBe(9)
    expect(plan.summary.weldersSkipped).toBe(1)
    expect(plan.summary.qualificationsToRecord).toBe(9)
    const skipped = plan.welders.find((w) => w.action === 'skip')!
    expect(skipped.stamp).toBe('MR LC')
    expect(skipped.skipReason).toMatch(/resolves to no one/)
  })

  it('matches by stamp rather than creating a second entry for the same welder', () => {
    const plan = planOverviewIngest(sheet, {
      ...empty,
      welders: [{ id: 'w-kt', fullName: 'KEITH TAYLOR', initials: 'KT', active: true, nameAliases: [] }],
    })
    const kt = plan.welders.find((w) => w.stamp === 'KT')!
    expect(kt.action).toBe('match')
    expect(kt.matchedBy).toBe('stamp')
    expect(kt.matchedWelderId).toBe('w-kt')
    expect(plan.summary.weldersToCreate).toBe(8)
  })

  it('matches a recorded alias, which is what the register exists for', () => {
    // §9.1: one welder appeared under four spellings across 38 sheets.
    const plan = planOverviewIngest(sheet, {
      ...empty,
      welders: [{
        id: 'w-mh', fullName: 'MITCHELL HOFFMAN', initials: 'MHX', active: true,
        nameAliases: ['MITCH HOFFMEN'],
      }],
    })
    const mh = plan.welders.find((w) => w.name === 'MITCH HOFFMEN')!
    expect(mh.action).toBe('match')
    expect(mh.matchedBy).toBe('alias')
  })

  it('records an expiry with no qualification date, and never invents one', () => {
    const plan = planOverviewIngest(sheet, empty)
    const rows = rowsForPlan(plan, {
      enteredAt: '2026-09-22T12:00:00Z', entrySource: 'field_entry',
      newId: (() => { let n = 0; return () => `id-${(n += 1)}` })(),
    })
    expect(rows.qualifications).toHaveLength(9)
    // The sheet gives "Date WPQ Expires" and nothing else. A fabricated
    // start date would silently qualify every weld after it.
    expect(rows.qualifications.every((q) => q.qualificationDate === null)).toBe(true)
    expect(rows.qualifications.map((q) => q.expiryDate)).toContain('2025-12-30')
    expect(rows.welders.every((w) => w.entrySource === 'field_entry')).toBe(true)
    expect(rows.welders.every((w) => w.enteredAt === '2026-09-22T12:00:00Z')).toBe(true)
  })

  it('a qualification with an unknown start certifies nothing', () => {
    const plan = planOverviewIngest(sheet, empty)
    const rows = rowsForPlan(plan, {
      enteredAt: '2026-09-22T12:00:00Z', entrySource: 'field_entry',
      newId: (() => { let n = 0; return () => `id-${(n += 1)}` })(),
    })
    const kt = rows.welders.find((w) => w.initials === 'KT')!
    // Expiry 2025-12-30, so a naive window test would pass any earlier
    // date. It must not.
    expect(qualifiedOn(kt.id, '2025-06-01', rows.qualifications)).toBe(false)
    expect(qualifiedOn(kt.id, '2026-06-01', rows.qualifications)).toBe(false)
  })

  it('creates the inspectors, and matches them by name on a second run', () => {
    const first = planOverviewIngest(sheet, empty)
    expect(first.summary.peopleToCreate).toBe(6)
    const second = planOverviewIngest(sheet, {
      ...empty,
      cwis: [{ id: 'c1', fullName: 'Alex Emig', initials: 'AE', active: true }],
      ndtTechnicians: [{ id: 'n1', fullName: 'Jose Flores', active: true }],
    })
    expect(second.summary.peopleToCreate).toBe(4)
  })

  it('re-importing the same sheet changes nothing', () => {
    const plan = planOverviewIngest(sheet, empty)
    const rows = rowsForPlan(plan, {
      enteredAt: '2026-09-22T12:00:00Z', entrySource: 'field_entry',
      newId: (() => { let n = 0; return () => `id-${(n += 1)}` })(),
    })
    const again = planOverviewIngest(sheet, {
      welders: rows.welders,
      welderQualifications: rows.qualifications,
      cwis: rows.cwis,
      ndtTechnicians: rows.ndtTechnicians,
    })
    expect(again.summary.weldersToCreate).toBe(0)
    expect(again.summary.weldersMatched).toBe(9)
    expect(again.summary.peopleToCreate).toBe(0)
  })
})
