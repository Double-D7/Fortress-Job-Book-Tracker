/**
 * Importer round-trip.
 *
 * The strongest available check is that a workbook written in the Noble
 * template's shape, parsed back, reproduces the audited totals — 2,476
 * credits and 631 X-rays — without a human retyping 2,342 joints. Anything
 * less and the import is a data-loss risk on a compliance record.
 */
import { describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import { buildDp452Bundle } from '@/lib/data/seed/dp452'
import { parseWeldLogSheets, toWeldRecords, parseHeatNumbers } from '@/lib/import/weldLog'
import { parseTorqueLogSheets, toTorqueRecords, normalizeWrenchId } from '@/lib/import/torqueLog'
import { xrayTotals } from '@/lib/domain/welders'
import { torqueTotals } from '@/lib/domain/torque'
import { parseLooseDate } from '@/lib/domain/dates'

const bundle = buildDp452Bundle()

/** Write the seed's welds back out in the Noble template's shape: a job
 *  header block, the column header, then data — one sheet per line. */
function buildWeldWorkbook(): XLSX.WorkBook {
  const wb = XLSX.utils.book_new()
  for (const line of bundle.weldLines) {
    const welds = bundle.welds.filter((w) => w.weldLineId === line.id)
    if (!welds.length) continue
    const grid: unknown[][] = [
      ['Facility Name', line.facilityName, null, null, 'Drill Pad Name', line.drillPadName],
      ['Well Name', line.wellName, null, null, 'Noble Energy PIC', line.operatorPic],
      ['Welding Company', line.weldingCompany, null, null, 'CWI(s)', 'RA / DW'],
      ['Pipe Size (in)', line.pipeSize, null, null, 'Pipe Schedule', line.pipeSchedule],
      ['Pipe Grade', line.pipeGrade, null, null, null, null],
      [],
      ['Weld Number', 'Date', 'Welder', 'Joint Type', 'Description', 'Length',
       'Heat Number', 'CWI', 'Visual Result', 'Visual Date', 'NDT Company',
       'X-Ray', 'Ticket', 'Method', 'NDT Result', 'Comments'],
    ]
    for (const w of welds) {
      grid.push([
        w.status === 'not_used' ? 'NOT USED' : w.weldNumber,
        w.weldDate, w.welderPassAssignment, w.jointType, w.componentDescription,
        w.partLength, w.heatNumbers.join(' / '), w.cwiInitials, w.cwiVisualResult,
        w.visualInspectionDate, w.ndtCompany, w.xrayNumber, w.ndtTicketNumber,
        w.ndtMethod, w.ndtResult, w.comments,
      ])
    }
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(grid), line.lineCode.slice(0, 31))
  }
  return wb
}

function buildTorqueWorkbook(): XLSX.WorkBook {
  const wb = XLSX.utils.book_new()
  const roster = bundle.torqueWrenches.filter((w) => w.onRoster).map((w) => w.wrenchId)
  const grid: unknown[][] = [
    ['Facility Name', bundle.book.facilityName, null, 'Noble PIC', 'B. Hargrove'],
    ['Torque Wrench IDs', ...roster],
    [],
    ['ISO Flange Number', 'ISO Number', 'Flange Pipe Size', 'Bolt Diameter', 'Bolt Count',
     'Required Torque', 'Actual Torque', 'Wrench ID', 'CP Test on Flange', 'Torque Date',
     'Employee Initials', 'Inspection Date', 'Inspector Initials'],
  ]
  for (const c of bundle.torqueConnections) {
    grid.push([
      c.isoFlangeNumber, c.isoNumber, c.flangePipeSize, c.boltDiameter, c.boltCount,
      c.requiredTorqueFtLb, c.actualTorqueFtLb, c.wrenchIdRaw, c.cpTestOnFlange ? 'Y' : 'N',
      c.torqueDate, c.employeeInitials, c.inspectionDate, c.inspectorInitials,
    ])
  }
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(grid), 'Torque Log')
  return wb
}

describe('weld log import', () => {
  const parsed = parseWeldLogSheets(buildWeldWorkbook(), { welders: bundle.welders })

  it('finds every line sheet', () => {
    expect(parsed.sheetsParsed).toHaveLength(bundle.weldLines.length)
    expect(parsed.sheetsParsed).toContain('FL1')
    expect(parsed.sheetsParsed).toContain('A-1')
    expect(parsed.sheetsParsed).toContain('GL1')
  })

  it('reads the repeated job header block from each sheet', () => {
    const fl1 = parsed.lines.find((l) => l.lineCode === 'FL1')!
    expect(fl1.facilityName).toBe('DP452 Flowline')
    expect(fl1.pipeSchedule).toBe('80')
    expect(fl1.operatorPic).toBe('B. Hargrove')
  })

  it('resolves every welder against the managed roster', () => {
    expect(parsed.proposedWelders).toHaveLength(0)
  })

  it('round-trips to the audited welder-credit totals', () => {
    const welds = toWeldRecords(parsed.rows, {
      jobBookId: bundle.book.id,
      lineIdByCode: new Map(bundle.weldLines.map((l) => [l.lineCode, l.id])),
      welders: bundle.welders,
      cwiIdByInitials: new Map(bundle.cwis.map((c) => [c.initials, c.id])),
    })
    const totals = xrayTotals(welds, bundle.book, bundle.welders)
    expect(totals.totalWeldCredits).toBe(2476)
    expect(totals.totalXrayCredits).toBe(631)
    expect(totals.jointCount).toBe(2342)
  })

  it('keeps NOT USED rows without counting them', () => {
    const notUsed = parsed.rows.filter((r) => r.isNotUsed)
    expect(notUsed.length).toBeGreaterThan(0)
  })

  it('reports unresolved welder names rather than creating them', () => {
    const wb = buildWeldWorkbook()
    const sheet = wb.Sheets.FL1!
    // Simulate the source workbook's misspellings landing on a fresh book.
    XLSX.utils.sheet_add_aoa(sheet, [['9001', '2024-06-01', 'ZZ/ZZ/ZZ/ZZ', 'Butt', '3" S80 PIPE',
      "20'", 'A100000', 'RA', 'Pass', '2024-06-01', null, null, null, null, null, null]],
      { origin: -1 })
    const p = parseWeldLogSheets(wb, { welders: bundle.welders })
    expect(p.proposedWelders.map((w) => w.nameOrInitials)).toContain('ZZ')
  })

  it('rejects an unreadable date instead of guessing', () => {
    const wb = buildWeldWorkbook()
    XLSX.utils.sheet_add_aoa(wb.Sheets.FL1!, [['9002', 'sometime in June', 'HS2/HS2/HS2/HS2']],
      { origin: -1 })
    const p = parseWeldLogSheets(wb, { welders: bundle.welders })
    expect(p.rejectedCount).toBe(1)
    const issue = p.issues.find((i) => i.severity === 'error' && i.column === 'Date')
    expect(issue?.message).toContain('sometime in June')
    expect(issue?.row).toBeGreaterThan(0)
  })

  it('flags a duplicate weld number within one line', () => {
    const wb = buildWeldWorkbook()
    XLSX.utils.sheet_add_aoa(wb.Sheets.FL1!, [['1', '2024-06-01', 'HS2/HS2/HS2/HS2']], { origin: -1 })
    const p = parseWeldLogSheets(wb, { welders: bundle.welders })
    expect(p.issues.some((i) => i.severity === 'error' && /already appears/.test(i.message))).toBe(true)
  })

  it('locates the header row even when rows are inserted above it', () => {
    const wb = buildWeldWorkbook()
    const shifted = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets.FL1!, { header: 1, defval: null })
    const withNote: unknown[][] = [['REVISED 3/2025 — see note'], [], [], ...shifted]
    wb.Sheets.FL1 = XLSX.utils.aoa_to_sheet(withNote)
    const p = parseWeldLogSheets(wb, { welders: bundle.welders })
    const fl1 = p.rows.filter((r) => r.sheet === 'FL1')
    expect(fl1.length).toBeGreaterThan(0)
    expect(fl1[0]!.weldDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

describe('torque log import', () => {
  const parsed = parseTorqueLogSheets(buildTorqueWorkbook(), { wrenches: bundle.torqueWrenches })

  it('round-trips to 616 connections at 19.16% inspected', () => {
    const rows = toTorqueRecords(parsed.rows, {
      jobBookId: bundle.book.id,
      wrenchIdByCode: new Map(bundle.torqueWrenches.map((w) => [w.wrenchId, w.id])),
    })
    const totals = torqueTotals(rows, bundle.book)
    expect(totals.totalConnections).toBe(616)
    expect(totals.inspectedConnections).toBe(118)
    expect(Number(totals.inspectionPct.toFixed(2))).toBe(19.16)
  })

  it('reads the wrench roster block from the header', () => {
    expect(parsed.rosterWrenchIds).toHaveLength(9)
    expect(parsed.rosterWrenchIds).toContain('1304')
    expect(parsed.rosterWrenchIds).not.toContain('0534')
  })

  it('carries the CP TEST flag through', () => {
    expect(parsed.rows.filter((r) => r.cpTest).length).toBe(
      bundle.torqueConnections.filter((c) => c.cpTestOnFlange).length,
    )
  })

  it('reports an unknown wrench with a typo suggestion instead of creating it', () => {
    const wb = buildTorqueWorkbook()
    XLSX.utils.sheet_add_aoa(wb.Sheets['Torque Log']!,
      [['F-9999', 'ISO-1', '3"', '3/4"', 8, 225, 225, '0284', 'N', '2024-12-01', 'JD']],
      { origin: -1 })
    const p = parseTorqueLogSheets(wb, {
      wrenches: bundle.torqueWrenches.filter((w) => w.wrenchId !== '0284'),
    })
    const proposed = p.proposedWrenches.find((w) => w.wrenchId === '0284')
    expect(proposed).toBeDefined()
    expect(p.issues.some((i) => /0289/.test(i.message))).toBe(true)
  })

  it('rejects a connection recorded without a wrench', () => {
    const wb = buildTorqueWorkbook()
    XLSX.utils.sheet_add_aoa(wb.Sheets['Torque Log']!,
      [['F-8888', 'ISO-1', '3"', '3/4"', 8, 225, 225, null, 'N', '2024-12-01', 'JD']],
      { origin: -1 })
    const p = parseTorqueLogSheets(wb, { wrenches: bundle.torqueWrenches })
    expect(p.rejectedCount).toBe(1)
    expect(p.issues.some((i) => i.severity === 'error' && /no wrench/i.test(i.message))).toBe(true)
  })
})

describe('field-format tolerance', () => {
  it('reads the date formats the source workbooks actually contain', () => {
    expect(parseLooseDate('2024-06-14')).toBe('2024-06-14')
    expect(parseLooseDate('6/14/24')).toBe('2024-06-14')
    expect(parseLooseDate('6-14-2024')).toBe('2024-06-14')
    expect(parseLooseDate('10.17.24')).toBe('2024-10-17')
    expect(parseLooseDate(45457)).toBe('2024-06-14')      // Excel serial
    expect(parseLooseDate('not a date')).toBeNull()
    expect(parseLooseDate('')).toBeNull()
  })

  it('splits multi-heat cells however they are separated', () => {
    expect(parseHeatNumbers('A123 / B456')).toEqual(['A123', 'B456'])
    expect(parseHeatNumbers('A123, B456')).toEqual(['A123', 'B456'])
    expect(parseHeatNumbers('A123')).toEqual(['A123'])
    expect(parseHeatNumbers('A123 / A123')).toEqual(['A123'])
    expect(parseHeatNumbers(null)).toEqual([])
  })

  it('restores the leading zero a spreadsheet strips from a wrench id', () => {
    expect(normalizeWrenchId(245)).toBe('0245')
    expect(normalizeWrenchId('0245')).toBe('0245')
    expect(normalizeWrenchId('  1304 ')).toBe('1304')
    expect(normalizeWrenchId('')).toBeNull()
  })
})
