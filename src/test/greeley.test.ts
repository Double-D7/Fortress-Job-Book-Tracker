/**
 * Greeley Crescent DP-318 — facility book support, verified against the
 * torque workbook that could actually be read.
 *
 * The weld log is a macro-enabled .xlsm that the OneDrive connector
 * refuses to serve, so the weld-side figures are not asserted here. What
 * is asserted is everything the torque log, the section 13 folder and the
 * weld log's printed overview sheet can prove.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildGreeleyBundle } from '@/lib/data/seed/greeley'
import { buildDp452Bundle } from '@/lib/data/seed/dp452'
import { parseCellDump, sheetByName } from '@/lib/import/cellDump'
import {
  parseFacilityTorqueRows, parseTorqueRange, toFacilityTorqueRecords, torqueWithinRange,
} from '@/lib/import/facilityTorqueLog'
import { diffImport, describeDiff } from '@/lib/import/idempotent'
import { scoreBook } from '@/lib/domain/scoring'
import { aggregateFindings, countBySeverity, evaluateFlags } from '@/lib/domain/flags'
import { reconcileWrenches, torqueTotals, torqueWithinTolerance } from '@/lib/domain/torque'
import { buildTemplateSections } from '@/lib/domain/checklist'
import { scaffoldJobBook } from '@/lib/domain/scaffold'

const REF = JSON.parse(readFileSync('greeley-crescent-import.json', 'utf8'))
const bundle = buildGreeleyBundle()

function parsedTorque() {
  const text = readFileSync('fixtures/greeley/torque-log.dump.txt', 'utf8')
  return parseFacilityTorqueRows(sheetByName(parseCellDump(text), 'Torque Log')!.rows)
}

describe('torque log import, against the real workbook', () => {
  const r = parsedTorque()

  it('reads 718 connections', () => {
    expect(r.rows).toHaveLength(REF.torque.total_connections)
  })

  it('keeps decimal sub-numbered flanges, which a numeric column would lose', () => {
    // 39 connections are numbered 74.1, 299.1 … — extra connections on one
    // isometric. Flange numbers are text for the same reason weld numbers
    // are: the field does not restrict itself to integers.
    expect(r.rows.filter((x) => /\d\.\d/.test(x.isoFlangeNumber)).length).toBe(39)
  })

  it('finds the two connections with no actual torque', () => {
    expect(r.rows.filter((x) => x.actualTorque == null)).toHaveLength(
      REF.torque.missing_actual_torque)
  })

  it('reproduces the per-wrench usage counts exactly', () => {
    const usage: Record<string, number> = {}
    for (const x of r.rows) if (x.wrenchIdRaw) usage[x.wrenchIdRaw] = (usage[x.wrenchIdRaw] ?? 0) + 1
    expect(usage).toEqual(REF.torque.wrench_ids_used)
  })

  it('reads the wrench roster block, letter-O for zero and all', () => {
    // The log writes one wrench as `O480` with a letter O. Identity comes
    // from the managed record, never from that string.
    expect(r.roster.map((w) => w.wrenchId)).toContain('0480')
    expect(r.roster).toHaveLength(6)
  })

  it('finds 196 distinct isometrics', () => {
    const isos = new Set(r.rows.map((x) => x.isoNumber?.trim().toUpperCase()).filter(Boolean))
    expect(isos.size).toBe(REF.torque.unique_isometrics_referenced)
  })

  it('reports the three inspection cells that hold initials rather than a date', () => {
    // 211 cells populated, 208 parse as dates. The other three are a data
    // entry error, and dropping them in silence is how a book quietly
    // loses three inspections.
    const malformed = r.issues.filter((i) => i.column === 'Inspection Date')
    expect(malformed).toHaveLength(3)
    expect(r.rows.filter((x) => x.inspectionDate)).toHaveLength(208)
  })

  it('flags the log header as stale against its own rows', () => {
    expect(r.headerTotals.inspected).toBe(REF.torque.inspected_per_log_header)
    expect(r.issues.some((i) => /header reports 205/.test(i.message))).toBe(true)
  })
})

describe('required torque as a range', () => {
  it('parses a range and a point value into one shape', () => {
    expect(parseTorqueRange('130-260')).toMatchObject({ min: 130, max: 260 })
    expect(parseTorqueRange('130 - 260')).toMatchObject({ min: 130, max: 260 })
    expect(parseTorqueRange('260')).toMatchObject({ min: 260, max: 260 })
    expect(parseTorqueRange('')).toMatchObject({ min: null, max: null })
  })

  it('treats anything inside the range as in spec', () => {
    expect(torqueWithinRange(260, 130, 260)).toBe(true)
    expect(torqueWithinRange(130, 130, 260)).toBe(true)
    expect(torqueWithinRange(195, 130, 260)).toBe(true)
    expect(torqueWithinRange(261, 130, 260)).toBe(false)
  })

  it('does not measure a range against a percentage tolerance from its floor', () => {
    // Doing so flagged 710 of 718 Greeley connections — the signature of a
    // wrong question, not a mis-torqued facility.
    const c = {
      id: 'x', jobBookId: 'b', isoFlangeNumber: '1', cpTestOnFlange: false, status: 'recorded',
      requiredTorqueFtLb: 130, requiredTorqueMinFtLb: 130, requiredTorqueMaxFtLb: 260,
      actualTorqueFtLb: 260,
    }
    expect(torqueWithinTolerance(c, 5)).toBe(true)
  })

  it('keeps the percentage tolerance for a point value', () => {
    const c = {
      id: 'x', jobBookId: 'b', isoFlangeNumber: '1', cpTestOnFlange: false, status: 'recorded',
      requiredTorqueFtLb: 200, requiredTorqueMinFtLb: 200, requiredTorqueMaxFtLb: 200,
      actualTorqueFtLb: 230,
    }
    expect(torqueWithinTolerance(c, 5)).toBe(false)
    expect(torqueWithinTolerance({ ...c, actualTorqueFtLb: 205 }, 5)).toBe(true)
  })

  it('finds 34 connections outside their range in the real log', () => {
    const r = parsedTorque()
    expect(r.rows.filter(
      (x) => torqueWithinRange(x.actualTorque, x.requiredTorqueMin, x.requiredTorqueMax) === false,
    )).toHaveLength(34)
  })
})

describe('imports are idempotent', () => {
  const r = parsedTorque()
  const ctx = { jobBookId: 'book-dp318', wrenchIdByCode: new Map<string, string>() }
  const first = toFacilityTorqueRecords(r.rows, ctx)

  it('adds nothing on a second run of the same workbook', () => {
    const again = toFacilityTorqueRecords(r.rows, ctx)
    const diff = diffImport(first, again, (c) => `Connection ${c.isoFlangeNumber}`)
    expect(diff.isNoOp).toBe(true)
    expect(diff.summary.added).toBe(0)
    expect(diff.summary.updated).toBe(0)
    expect(diff.summary.unchanged).toBe(718)
    expect(describeDiff(diff, 'connection')).toMatch(/^No change/)
  })

  it('reports a changed field rather than a row count', () => {
    const revised = first.map((c, i) =>
      i === 0 ? { ...c, actualTorqueFtLb: 999 } : c)
    const diff = diffImport(first, revised, (c) => `Connection ${c.isoFlangeNumber}`)
    expect(diff.isNoOp).toBe(false)
    expect(diff.summary.updated).toBe(1)
    expect(diff.updated[0]!.changes).toEqual([
      { field: 'actualTorqueFtLb', before: 260, after: 999 },
    ])
  })

  it('never proposes deleting a record the workbook stopped mentioning', () => {
    const diff = diffImport(first, first.slice(0, 700), (c) => `Connection ${c.isoFlangeNumber}`)
    expect(diff.summary.removed).toBe(18)
    // Removals are reported but not applied: a compliance record is not
    // deleted because a spreadsheet was edited.
    expect(diff.isNoOp).toBe(true)
    expect(describeDiff(diff, 'connection')).toMatch(/left in place/)
  })
})

describe('the Greeley book', () => {
  it('is a facility book with sections 19-22 active', () => {
    expect(bundle.book.bookType).toBe('facility')
    for (const n of ['19', '20', '21', '22']) {
      const def = bundle.sectionDefinitions.find((d) => d.sectionNumber === n)!
      expect(bundle.sections.find((s) => s.sectionDefinitionId === def.id)!.status).not.toBe('na')
    }
    // The flowline combined map does not exist on a facility template.
    expect(bundle.sectionDefinitions.some((d) => d.sectionNumber === '19-22')).toBe(false)
  })

  it('enables the off-checklist coating section', () => {
    const def = bundle.sectionDefinitions.find((d) => d.sectionNumber === '23')!
    expect(def.isOptional).toBe(true)
    expect(bundle.sections.find((s) => s.sectionDefinitionId === def.id)!.status).not.toBe('na')
  })

  it('reproduces the reference section scores it has data for', () => {
    const score = scoreBook(bundle)
    const at = (n: string) => score.sections.find((s) => s.sectionNumber === n)!.pct
    expect(at('13')).toBeCloseTo(40, 1)     // 4 of 10 used wrenches have a certificate
    expect(at('23')).toBeCloseTo(7.1, 1)    // 1 of 14 construction areas
    expect(at('6')).toBeCloseTo(100, 1)     // 9 of 9 welders hold a WPQ
    expect(at('7')).toBeCloseTo(100, 1)
    expect(at('8')).toBeCloseTo(100, 1)
  })

  it('treats the combined crew stamp as neither a welder nor a gap', () => {
    const combined = bundle.welders.find((w) => w.initials === 'MR LC')!
    expect(combined.combinedOf).toHaveLength(2)
    expect(bundle.welders.filter((w) => !w.combinedOf?.length)).toHaveLength(9)
  })

  it('raises the uncertified-wrench finding on exactly 289 connections', () => {
    const agg = aggregateFindings(evaluateFlags(bundle, { asOf: '2026-08-21' }))
    const f = agg.find((x) => x.ruleId === 'torque.wrench_no_certificate')!
    expect(f.severity).toBe('critical')
    expect(f.occurrences).toBe(REF.torque.connections_on_uncertified_wrenches)
  })

  it('does not hold an unread certificate against the book', () => {
    const agg = aggregateFindings(evaluateFlags(bundle, { asOf: '2026-08-21' }))
    // Wrench 9125's calibration certificate is filed in section 13. It is a
    // scan with no text layer, so this application has not read its dates —
    // which is our gap, not the book's. Charging it to the crew produced 18
    // findings against connections torqued with a calibrated wrench.
    expect(agg.find((x) => x.ruleId === 'torque.wrench_certificate_unread')).toBeUndefined()
    const unread = agg.find((x) => x.ruleId === 'torque.certificate_unread')!
    expect(unread.severity).toBe('info')
    // 1583, 5125 and 9125 are photographs or unscanned pages.
    expect(unread.occurrences).toBe(3)
  })

  it('reads the certificate, not the roster line that summarises it', () => {
    const w = bundle.torqueWrenches.find((x) => x.wrenchId === '0808')!
    // The roster block transcribes the handwritten "DATE WRENCH PUT IN
    // SERVICE" (2/4/25) as the calibration date. The certificate itself is
    // dated 2025-01-10, and the certificate is the calibration record.
    expect(w.rosterClaimedCalibrationDate).toBe('2025-02-04')
    expect(w.lastCalibrationDate).toBe('2025-01-10')

    const agg = aggregateFindings(evaluateFlags(bundle, { asOf: '2026-08-21' }))
    const f = agg.find((x) => x.ruleId === 'torque.roster_contradicts_certificate')!
    expect(f.severity).toBe('warning')
    expect(f.occurrences).toBe(1)
  })

  it('warns that the most-used wrench lapses before construction ends', () => {
    const w = bundle.torqueWrenches.find((x) => x.wrenchId === '5155')!
    expect(w.calibrationDueDate).toBe('2026-05-02')
    expect(bundle.book.constructionEnd).toBe('2026-06-05')
    const findings = evaluateFlags(bundle, { asOf: '2026-08-21' })
      .filter((f) => f.ruleId === 'certificate.expires_during_job')
    const wrench = findings.find((f) => f.title.includes('5155'))!
    // Named, not `wrench-dp318-5155`: a finding an auditor cannot read is
    // a finding nobody acts on.
    expect(wrench.title).toContain('Torque wrench 5155')
    expect(wrench.title).toContain('2026-05-02')
    // Nothing was torqued after it lapsed, so it is a warning, not a
    // failure — but every further connection on this job would be one.
    expect(wrench.severity).toBe('warning')
    expect(wrench.sectionNumber).toBe('13')
    expect(wrench.detail).toContain('connection')
  })

  it('reconciles roster, usage and certificates as three different sets', () => {
    const rec = reconcileWrenches(bundle.torqueConnections, bundle.torqueWrenches)
    expect(rec.inUse).toHaveLength(10)
    expect(rec.certified).toHaveLength(6)
    expect(rec.usedWithoutCertificate.sort())
      .toEqual([...REF.torque.wrenches_used_without_cert].sort())
    expect(rec.certifiedNeverUsed.sort())
      .toEqual([...REF.torque.certs_for_unused_wrenches].sort())
  })

  it('carries 718 connections at the inspection rate the rows support', () => {
    const t = torqueTotals(bundle.torqueConnections, bundle.book)
    expect(t.totalConnections).toBe(718)
    // Stricter than the reference, which counts populated cells: this
    // requires a parseable date AND an inspector.
    expect(t.inspectedConnections).toBe(204)
  })

  it('does not invent a turnover date, so it cannot read as overdue', () => {
    expect(bundle.book.targetTurnoverDate).toBeNull()
  })
})

describe('optional sections change the denominator, not the numerator', () => {
  const base = {
    jobNumber: 'TEST-1', bookType: 'facility' as const, projectId: 'p',
    clientOrgId: 'o', bookTemplateId: 't',
  }

  it('is N/A and weightless when a job does not enable it', () => {
    const r = scaffoldJobBook(base, (k, key) => `${k}-${key}`)
    const def = r.sectionDefinitions.find((d) => d.sectionNumber === '23')!
    const sec = r.sections.find((s) => s.sectionDefinitionId === def.id)!
    expect(sec.status).toBe('na')
    expect(sec.naReason).toMatch(/not enabled/)
  })

  it('carries real weight when a job does enable it', () => {
    const r = scaffoldJobBook(
      { ...base, enabledOptionalSections: ['23'] }, (k, key) => `${k}-${key}`)
    const def = r.sectionDefinitions.find((d) => d.sectionNumber === '23')!
    expect(def.weight).toBe(4)
    expect(r.sections.find((s) => s.sectionDefinitionId === def.id)!.status).toBe('not_started')
  })

  it('sums to 100 with the optional section and 96 without', () => {
    const defs = buildTemplateSections('facility', 't')
    expect(defs.reduce((a, d) => a + d.weight, 0)).toBe(100)
    expect(defs.filter((d) => !d.isOptional).reduce((a, d) => a + d.weight, 0)).toBe(96)
  })
})

describe('flag aggregation on DP452', () => {
  const b = buildDp452Bundle()
  const raw = evaluateFlags(b, { asOf: '2026-08-21' })
  const agg = aggregateFindings(raw)

  it('collapses a wall of per-record criticals into a handful of findings', () => {
    const counts = countBySeverity(agg)
    expect(raw.length).toBeGreaterThan(900)
    // The number that matters is the ratio: ~1,000 per-record criticals
    // become something a manager can read in one screen.
    expect(counts.critical).toBeLessThan(15)
    // The records are not thrown away, only grouped.
    expect(counts.totalRecords).toBe(raw.length)
  })

  it('leads with the count, not with the first record', () => {
    const future = agg.find((f) => f.ruleId === 'record.future_dated')!
    expect(future.occurrences).toBeGreaterThan(100)
    expect(future.title).toMatch(/^\d+ records are dated after/)
  })

  it('keeps per-record detail available on drill-down', () => {
    const future = agg.find((f) => f.ruleId === 'record.future_dated')!
    expect(future.records.length).toBeGreaterThan(0)
    expect(future.records[0]!.title).toMatch(/is dated/)
    expect(future.recordsTruncated).toBe(true)
  })

  it('leaves a single-occurrence finding worded as itself', () => {
    const wrongJob = agg.find((f) => f.ruleId === 'document.wrong_job')!
    expect(wrongJob.occurrences).toBe(1)
    expect(wrongJob.title).toContain('DP425')
  })
})

describe('unread is not the same as empty', () => {
  /**
   * The most dangerous thing this application can report is that a section
   * is missing when it is merely unread. DP-318 holds 41 MB of pressure
   * test packs in section 17 — every pack carrying the recorder
   * calibration certificate the section is named for — and the book said
   * "section absent" because nothing had walked the folder. A crew sent to
   * re-do that work would be re-doing work that was already done.
   */
  const score = scoreBook(bundle)
  const at = (n: string) => score.sections.find((s) => s.sectionNumber === n)!

  it('reports a section holding unread files as unread, not absent', () => {
    const s17 = at('17')
    expect(s17.ingestionStatus).toBe('not_imported')
    expect(s17.explanation).toMatch(/Not yet imported/)
    expect(s17.explanation).toMatch(/lack of evidence, not for lack of work/)
    expect(s17.explanation).not.toMatch(/absent/)
  })

  it('reports a genuinely empty section as empty', () => {
    for (const n of ['16', '18', '19']) {
      expect(at(n).ingestionStatus).toBe('verified_empty')
    }
  })

  it('never lists an unread section among the missing ones', () => {
    const missing = score.missingSections.map((s) => s.sectionNumber).sort()
    expect(missing).toEqual(['16', '18', '19'])
    expect(missing).not.toContain('17')
    expect(missing).not.toContain('21')
  })

  it('marks the overall figure as a lower bound while weight is unread', () => {
    expect(score.isLowerBound).toBe(true)
    expect(score.weightNotImported).toBeGreaterThan(50)
    expect(score.evidenceCoveragePct).toBeLessThan(100)
    // Coverage and unread weight must agree with each other.
    expect(score.evidenceCoveragePct).toBeCloseTo(
      ((score.weightAvailable - score.weightNotImported) / score.weightAvailable) * 100, 1)
  })

  it('drops the caveat once every section has been read', () => {
    const fully = {
      ...bundle,
      sections: bundle.sections.map((s) => ({ ...s, ingestionStatus: 'imported' as const })),
    }
    const s = scoreBook(fully)
    expect(s.isLowerBound).toBe(false)
    expect(s.evidenceCoveragePct).toBe(100)
  })

  it('does not let the unread state change the arithmetic', () => {
    // The caveat is about how the number is presented, not what it is.
    const unread = scoreBook(bundle).overallPct
    const asImported = scoreBook({
      ...bundle,
      sections: bundle.sections.map((s) =>
        s.ingestionStatus === 'not_imported' ? { ...s, ingestionStatus: 'unknown' as const } : s),
    }).overallPct
    expect(unread).toBe(asImported)
  })
})
