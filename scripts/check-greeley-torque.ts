import { readFileSync } from 'node:fs'
import { parseCellDump, sheetByName } from '../src/lib/import/cellDump'
import { parseFacilityTorqueRows, torqueWithinRange } from '../src/lib/import/facilityTorqueLog'

const dump = readFileSync('fixtures/greeley/torque-log.dump.txt', 'utf8')
const sheets = parseCellDump(dump)
const sheet = sheetByName(sheets, 'Torque Log')!
const r = parseFacilityTorqueRows(sheet.rows)

const json = JSON.parse(readFileSync('greeley-crescent-import.json', 'utf8'))
const T = json.torque

const line = (label: string, actual: unknown, expected?: unknown) => {
  const ok = expected === undefined || String(actual) === String(expected)
  console.log(`${ok ? '  ok ' : ' FAIL'} ${label.padEnd(44)} ${String(actual).padStart(10)}` +
    (expected !== undefined ? `   expected ${expected}` : ''))
}

console.log('\n— Torque log —')
line('connections parsed', r.rows.length, T.total_connections)
const complete = r.rows.filter((x) => x.actualTorque != null).length
line('with an actual torque', complete, T.field_complete)
line('missing actual torque', r.rows.length - complete, T.missing_actual_torque)
line('rows with an inspection date', r.rows.filter((x) => x.inspectionDate).length, T.inspected_rows)
line('header block says inspected', r.headerTotals.inspected, T.inspected_per_log_header)
line('header block says total', r.headerTotals.totalFlanges, T.total_connections)
line('inspection %', ((r.rows.filter((x) => x.inspectionDate).length / r.rows.length) * 100).toFixed(1), T.inspection_pct)

console.log('\n— Required torque is a range —')
const ranges = r.rows.filter((x) => x.requiredTorqueMin !== x.requiredTorqueMax).length
line('rows with a true range', ranges)
line('rows with a point value', r.rows.filter((x) => x.requiredTorqueMin === x.requiredTorqueMax && x.requiredTorqueMin != null).length)
const outOfRange = r.rows.filter((x) => torqueWithinRange(x.actualTorque, x.requiredTorqueMin, x.requiredTorqueMax) === false).length
line('actual outside its range', outOfRange)

console.log('\n— Wrench usage —')
const usage: Record<string, number> = {}
for (const x of r.rows) if (x.wrenchIdRaw) usage[x.wrenchIdRaw] = (usage[x.wrenchIdRaw] ?? 0) + 1
const expected = T.wrench_ids_used as Record<string, number>
for (const [id, n] of Object.entries(expected).sort((a, b) => b[1] - a[1])) {
  line(`wrench ${id}`, usage[id] ?? 0, n)
}
const extra = Object.keys(usage).filter((k) => !(k in expected))
line('unexpected wrench ids', extra.length ? extra.join(', ') : 'none', 'none')
line('distinct wrenches used', Object.keys(usage).length, Object.keys(expected).length)

console.log('\n— Roster block (what the log claims) —')
for (const w of r.roster) {
  console.log(`       ${w.wrenchId}  cal ${w.lastCalibrationDate ?? '—'}  cert claimed: ${w.certClaimedSubmitted ? 'Yes' : 'No'}   [${w.rawLabel}]`)
}
const certsOnFile: string[] = T.wrench_certs_on_file
const usedWithoutCert = Object.keys(usage).filter((id) => !certsOnFile.includes(id)).sort()
line('used without a cert on file', usedWithoutCert.join(', '), (T.wrenches_used_without_cert as string[]).join(', '))
const onUncertified = r.rows.filter((x) => x.wrenchIdRaw && !certsOnFile.includes(x.wrenchIdRaw)).length
line('connections on uncertified wrenches', onUncertified, T.connections_on_uncertified_wrenches)

console.log('\n— Isometrics —')
const isos = new Set(r.rows.map((x) => x.isoNumber?.trim().toUpperCase()).filter(Boolean))
line('distinct isometrics', isos.size, T.unique_isometrics_referenced)

console.log(`\n— Import issues: ${r.issues.length} (${r.issues.filter(i=>i.severity==='error').length} error, ${r.issues.filter(i=>i.severity==='warning').length} warning, ${r.issues.filter(i=>i.severity==='info').length} info) —`)
for (const i of r.issues.filter((x) => x.row === 0)) console.log(`       [${i.severity}] ${i.message}`)
console.log()
