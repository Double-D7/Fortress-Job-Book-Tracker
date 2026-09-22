/**
 * Importing the Torque Log (§14), against the real Greeley workbook.
 *
 * The parser has been correct and tested since the import work started.
 * What was missing was any path from a file a person drops on a screen to
 * a `torque_connection` row, which meant a book created in the app held
 * zero connections however many the crew filed — and every torque rule in
 * the flags engine ran over an empty set and reported nothing wrong.
 *
 * These tests are about the plan a tech reads before pressing the button:
 * that it names the wrench ids the register cannot resolve, that it
 * checks calibration against every date a wrench was used rather than
 * the last one, and that re-importing a corrected log replaces rows
 * rather than laying a second copy of the log beside the first.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseCellDump, sheetByName } from '@/lib/import/cellDump'
import { parseFacilityTorqueRows } from '@/lib/import/facilityTorqueLog'
import { planTorqueLogIngest, rowsForTorquePlan } from '@/lib/import/torqueLogIngest'
import { buildGreeleyBundle } from '@/lib/data/seed/greeley'
import type { JobBookBundle, TorqueWrench } from '@/lib/domain/types'

const REF = JSON.parse(readFileSync('greeley-crescent-import.json', 'utf8'))
const bundle = buildGreeleyBundle()

function parsed() {
  const text = readFileSync('fixtures/greeley/torque-log.dump.txt', 'utf8')
  return parseFacilityTorqueRows(sheetByName(parseCellDump(text), 'Torque Log')!.rows)
}

/** The book as it would be before any torque import: registers loaded,
 *  no connections. That is the state a real §14 import starts from. */
const emptyBook: JobBookBundle = { ...bundle, torqueConnections: [] }

describe('planning a torque import', () => {
  const plan = planTorqueLogIngest(parsed(), emptyBook)

  it('reads every connection in the log', () => {
    expect(plan.parsedRows).toBe(REF.torque.total_connections)
    expect(plan.connectionsToCreate).toBe(REF.torque.total_connections)
    expect(plan.connectionsToUpdate).toBe(0)
  })

  it('accounts for every wrench id the log uses, with the right counts', () => {
    // The reference import records each id against the number of
    // connections it torqued. The plan has to agree on both.
    const expected = REF.torque.wrench_ids_used as Record<string, number>
    const got = Object.fromEntries(plan.wrenches.map((w) => [w.code, w.connections]))
    expect(got).toEqual(expected)

    // And every connection carrying an id is attributed to exactly one.
    const attributed = plan.wrenches.reduce((a, w) => a + w.connections, 0)
    const withAnId = plan.rows.filter((r) => r.wrenchIdRaw).length
    expect(attributed).toBe(withAnId)
  })

  it('resolves every id against the loaded Greeley register', () => {
    // The register in this book holds all ten. That is the baseline the
    // next test moves away from.
    expect(plan.wrenches.filter((w) => w.action === 'unresolved')).toEqual([])
    expect(plan.findings.some(
      (f) => f.ruleId === 'torque_import.wrench_not_in_register')).toBe(false)
  })

  it('reports an id the register does not hold as Critical, not as a note', () => {
    // §11.1: a connection torqued with an uncalibrated wrench is a
    // Critical finding, and an id the register does not know cannot be
    // shown to be calibrated at all. With no register loaded, every id in
    // the log is in exactly that position.
    const p = planTorqueLogIngest(parsed(), { ...emptyBook, torqueWrenches: [] })
    expect(p.wrenches.every((w) => w.action === 'unresolved')).toBe(true)

    const f = p.findings.find(
      (x) => x.ruleId === 'torque_import.wrench_not_in_register')!
    expect(f.severity).toBe('critical')
    expect(f.detail).toMatch(/§11\.1/)
    // Names the connections at stake, not just the ids.
    const affected = p.wrenches.reduce((a, w) => a + w.connections, 0)
    expect(f.detail).toContain(String(affected))
  })

  it('finds the eight wrenches used outside their calibration window', () => {
    // A real result on this book, not a synthetic one: the Greeley
    // register's certificates do not cover every date the log records.
    const f = plan.findings.find(
      (x) => x.ruleId === 'torque_import.wrench_calibration_lapsed')!
    expect(f.severity).toBe('critical')
    expect(plan.wrenches.filter((w) => w.calibrationValid === false)).toHaveLength(8)
  })

  it('suggests a typo without correcting it', () => {
    // A register holding 5155 and a log writing 5156 is one digit apart.
    // The suggestion is offered; the code on the row stays exactly as the
    // log wrote it, because silently rewriting a compliance record is
    // worse than the typo — the typo is visible.
    const wrenches: TorqueWrench[] = [
      { id: 'w-1', wrenchId: '5156', certOnFile: true, onRoster: true },
    ]
    const p = planTorqueLogIngest(parsed(), { ...emptyBook, torqueWrenches: wrenches })

    const mistyped = p.wrenches.find((w) => w.code === '5155')!
    expect(mistyped.action).toBe('unresolved')
    expect(mistyped.probableTypo).toBe('5156')
    // Not rewritten: the row still says what the log said.
    expect(mistyped.code).toBe('5155')

    const finding = p.findings.find(
      (f) => f.ruleId === 'torque_import.wrench_not_in_register')!
    expect(finding.detail).toContain('5155 vs 5156')
    expect(finding.detail).toMatch(/will not correct them for you/)
  })

  it('says nothing about missing wrench ids when none are missing', () => {
    expect(plan.rows.filter((r) => !r.wrenchIdRaw)).toHaveLength(0)
    expect(plan.findings.some(
      (f) => f.ruleId === 'torque_import.connection_without_wrench')).toBe(false)
  })

  it('names the connections that record no wrench at all', () => {
    // Strip the id from three rows. A connection with no wrench cannot be
    // traced to a calibrated tool, so the §11.1 check cannot be made on it
    // either way — it imports with the gap visible rather than dropped.
    const base = parsed()
    const holed = {
      ...base,
      rows: base.rows.map((r, i) => (i < 3 ? { ...r, wrenchIdRaw: null } : r)),
    }
    const p = planTorqueLogIngest(holed, emptyBook)
    const f = p.findings.find(
      (x) => x.ruleId === 'torque_import.connection_without_wrench')!
    expect(f.severity).toBe('critical')
    expect(f.title).toContain('3 connections')
    expect(f.detail).toMatch(/rather than being dropped/)
    // Still imported, not silently discarded.
    expect(p.parsedRows).toBe(base.rows.length)
  })

  it('reports the log contradicting its own required range', () => {
    const outOfRange = plan.rows.filter(
      (r) =>
        r.actualTorque != null && r.requiredTorqueMin != null &&
        r.requiredTorqueMax != null &&
        (r.actualTorque < r.requiredTorqueMin || r.actualTorque > r.requiredTorqueMax),
    ).length
    expect(outOfRange).toBe(34)
    const f = plan.findings.find(
      (x) => x.ruleId === 'torque_import.torque_outside_required_range')!
    expect(f.title).toContain('34')
    // This is the log disagreeing with itself, which is worth saying
    // plainly so nobody reads it as the app second-guessing the field.
    expect(f.detail).toMatch(/contradicting itself/)
  })

  it('counts the connections carrying no inspection', () => {
    const f = plan.findings.find((x) => x.ruleId === 'torque_import.not_inspected')
    const uninspected = plan.rows.filter(
      (r) => !r.inspectionDate || !r.inspectorInitials).length
    expect(f?.title).toContain(String(uninspected))
  })
})

describe('calibration is checked against every day a wrench was used', () => {
  // A wrench calibrated in March covers a connection torqued in April and
  // does not cover one torqued in January. Checking only the most recent
  // use would pass a log that contains both, which is the whole failure.
  const base = parsed()
  const usedCode = base.rows.find((r) => r.wrenchIdRaw)!.wrenchIdRaw!

  const withWindow = (last: string, due: string): JobBookBundle => ({
    ...emptyBook,
    torqueWrenches: [{
      id: 'w-1', wrenchId: usedCode, certOnFile: true, onRoster: true,
      lastCalibrationDate: last, calibrationDueDate: due,
    }],
  })

  const datesUsed = base.rows
    .filter((r) => r.wrenchIdRaw === usedCode && r.torqueDate)
    .map((r) => r.torqueDate!)
    .sort()

  it('passes a wrench whose window covers all of them', () => {
    const p = planTorqueLogIngest(base, withWindow('2000-01-01', '2100-01-01'))
    expect(p.wrenches.find((w) => w.code === usedCode)?.calibrationValid).toBe(true)
    expect(p.findings.some(
      (f) => f.ruleId === 'torque_import.wrench_calibration_lapsed')).toBe(false)
  })

  it('fails one whose window starts after the earliest use', () => {
    // Valid from the day after the first connection was torqued: correct
    // for every later row, wrong for that one, and a fail overall.
    const day = datesUsed[0]!
    const p = planTorqueLogIngest(base, withWindow(nextDay(day), '2100-01-01'))
    expect(p.wrenches.find((w) => w.code === usedCode)?.calibrationValid).toBe(false)
    const f = p.findings.find(
      (x) => x.ruleId === 'torque_import.wrench_calibration_lapsed')
    expect(f?.severity).toBe('critical')
    expect(f?.detail).toMatch(/§11\.1/)
  })

  it('fails one whose window ends before the latest use', () => {
    const day = datesUsed[datesUsed.length - 1]!
    const p = planTorqueLogIngest(base, withWindow('2000-01-01', prevDay(day)))
    expect(p.wrenches.find((w) => w.code === usedCode)?.calibrationValid).toBe(false)
  })
})

describe('the rows an import would write', () => {
  const plan = planTorqueLogIngest(parsed(), emptyBook)
  const rows = rowsForTorquePlan(plan, emptyBook, {
    enteredAt: '2026-05-01T12:00:00Z',
    entrySource: 'field_entry',
  })

  it('writes one connection per parsed row', () => {
    expect(rows.torqueConnections).toHaveLength(plan.parsedRows)
  })

  it('gives every row a stable id, so a re-import replaces rather than doubles', () => {
    const ids = new Set(rows.torqueConnections.map((c) => c.id))
    expect(ids.size).toBe(rows.torqueConnections.length)

    // The same file again produces the same ids, which is what makes the
    // upsert an update instead of a second copy of the log.
    const again = rowsForTorquePlan(
      planTorqueLogIngest(parsed(), emptyBook), emptyBook,
      { enteredAt: '2026-06-01T12:00:00Z', entrySource: 'field_entry' },
    )
    expect(again.torqueConnections.map((c) => c.id))
      .toEqual(rows.torqueConnections.map((c) => c.id))
  })

  it('stamps the torque and the inspection separately, per §8.1', () => {
    // Two events with different deadlines and different responsible
    // parties. One stamp cannot answer both.
    for (const c of rows.torqueConnections) {
      expect(c.enteredAt).toBe('2026-05-01T12:00:00Z')
      expect(c.entrySource).toBe('field_entry')
      // An inspection stamp only where an inspection actually happened —
      // otherwise §8 would measure the timeliness of a thing nobody did.
      if (c.inspectionDate) expect(c.inspectionEnteredAt).toBe('2026-05-01T12:00:00Z')
      else expect(c.inspectionEnteredAt).toBeNull()
    }
  })

  it('carries the wrench id as written even when it resolves', () => {
    // The raw id is kept alongside the resolved foreign key. An auditor
    // comparing the book to the log compares strings, not uuids.
    const resolved = rows.torqueConnections.filter((c) => c.wrenchId)
    for (const c of resolved) expect(c.wrenchIdRaw).toBeTruthy()
  })

  it('reports an already-imported log as updates, not creates', () => {
    const loaded: JobBookBundle = {
      ...emptyBook, torqueConnections: rows.torqueConnections,
    }
    const second = planTorqueLogIngest(parsed(), loaded)
    expect(second.connectionsToCreate).toBe(0)
    expect(second.connectionsToUpdate).toBe(plan.parsedRows)
  })
})

const shift = (iso: string, days: number) => {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}
const nextDay = (iso: string) => shift(iso, 1)
const prevDay = (iso: string) => shift(iso, -1)
