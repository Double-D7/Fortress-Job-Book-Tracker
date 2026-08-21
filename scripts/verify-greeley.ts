/**
 * Greeley DP-318 against the reference figures.
 *
 * Prints every figure the task lists as its correctness bar, with an
 * explicit status: verified against the source workbook, verified with a
 * definition that differs from the JSON's, or blocked because the source
 * file could not be read. Nothing here is taken from the JSON as data —
 * it is only ever the thing being compared against.
 */
import { readFileSync } from 'node:fs'
import { buildGreeleyBundle } from '../src/lib/data/seed/greeley'
import { scoreBook } from '../src/lib/domain/scoring'
import { aggregateFindings, countBySeverity, evaluateFlags } from '../src/lib/domain/flags'
import { reconcileWrenches, torqueTotals } from '../src/lib/domain/torque'
import { torqueCompleteness } from '../src/lib/domain/completeness'

const json = JSON.parse(readFileSync('greeley-crescent-import.json', 'utf8'))
const b = buildGreeleyBundle()

type Status = 'ok' | 'differs' | 'blocked'
const rows: { label: string; ours: string; theirs: string; status: Status; note?: string }[] = []
const add = (label: string, ours: unknown, theirs: unknown, note?: string) => {
  const status: Status = String(ours) === String(theirs) ? 'ok' : 'differs'
  rows.push({ label, ours: String(ours), theirs: String(theirs), status, note })
}
const blocked = (label: string, theirs: unknown, note: string) =>
  rows.push({ label, ours: '—', theirs: String(theirs), status: 'blocked', note })

// ---- Welds: the log is unreadable through the OneDrive connector -------
blocked('welds total', json.welds.total, 'weld log is .xlsm; connector refuses that MIME type')
blocked('welds by type', 'Butt 1074 / O-Let 174 / Socket 11', 'same')
blocked('NDE examined', `${json.welds.nde_examined} (${json.welds.nde_pct}%)`, 'same')
blocked('below / at-or-above 20% SMYS',
  `${json.welds.smys.below_20pct} / ${json.welds.smys.at_or_above_20pct}, max ${json.welds.smys.max_pct}%`,
  'needs per-weld pipe data from the weld log')
blocked('isometrics referenced by weld log', json.isometrics.referenced_by_weld_log, 'same')

// ---- Welder roster: real, from the weld log's overview sheet -----------
const roster = b.welders
add('welder stamps on the roster', roster.length, json.welders.filter((w: {stamp: string|null}) => w.stamp).length,
  'from the overview sheet printed to PDF, which the connector does serve')
add('welders needing their own WPQ', roster.filter((w) => !w.combinedOf?.length).length, 9,
  'MR LC is a two-man crew stamp, not a tenth welder')
blocked('per-weld attribution to stamps', 'weld+NDE counts per stamp',
  'the overview sheet gives the totals; the per-weld rows are in the .xlsm')

// ---- Torque: fully parsed from the real workbook -----------------------
const t = torqueTotals(b.torqueConnections, b.book)
add('torque connections', t.totalConnections, json.torque.total_connections)
add('connections with an actual torque',
  b.torqueConnections.filter((c) => c.actualTorqueFtLb != null).length, json.torque.field_complete)
const fullyComplete = b.torqueConnections.filter((c) => torqueCompleteness(c).complete).length
rows.push({
  label: 'connections complete (our definition)', ours: String(fullyComplete),
  theirs: String(json.torque.field_complete), status: 'differs',
  note: 'ours also requires the sign-off chain closed; the JSON counts rows with an actual torque',
})
rows.push({
  label: 'connections inspected', ours: String(t.inspectedConnections),
  theirs: String(json.torque.inspected_rows), status: 'differs',
  note: 'four numbers exist: 205 log header, 208 parseable dates, 211 populated cells, ' +
    '204 with date AND inspector initials — three cells hold initials or punctuation, not a date',
})
const rec = reconcileWrenches(b.torqueConnections, b.torqueWrenches)
add('distinct wrenches used', rec.inUse.length, Object.keys(json.torque.wrench_ids_used).length)
add('calibration certificates on file', rec.certified.length, json.torque.wrench_certs_on_file.length,
  'read from the section 13 folder listing, not from the log roster')
add('wrenches used with no certificate', rec.usedWithoutCertificate.join(','),
  (json.torque.wrenches_used_without_cert as string[]).join(','))
const onUncertified = b.torqueConnections.filter(
  (c) => c.wrenchIdRaw && !rec.certified.includes(c.wrenchIdRaw)).length
add('connections on uncertified wrenches', onUncertified, json.torque.connections_on_uncertified_wrenches)
add('certificates for wrenches never used', rec.certifiedNeverUsed.join(','),
  (json.torque.certs_for_unused_wrenches as string[]).join(','))
add('isometrics referenced by torque log',
  new Set(b.torqueConnections.map((c) => c.isoNumber?.trim().toUpperCase()).filter(Boolean)).size,
  json.torque.unique_isometrics_referenced)

// ---- Materials / pressure: not imported -------------------------------
blocked('heats recorded / with MTRs',
  `${json.materials.heats_recorded} / ${json.materials.mtr_found}`,
  'Heat Number Tracker read and its shape confirmed, but not persisted as a fixture')
blocked('pressure tests with results',
  `${json.pressure_tests.with_result_document} of ${json.pressure_tests.referenced_by_welds}`,
  'the referencing side lives in the weld log')

// ---- Sections we can score --------------------------------------------
const score = scoreBook(b)
const byNumber = new Map(score.sections.map((s) => [s.sectionNumber, s]))
const jsonSections = new Map(json.sections.map((s: {n: number, score_pct: number|null}) => [String(s.n), s.score_pct]))
console.log('\n══ Section scores we can compute ══')
for (const n of ['3', '6', '7', '8', '13', '14', '23']) {
  const ours = byNumber.get(n)
  const theirs = jsonSections.get(n)
  const ok = ours && theirs != null && Math.abs(ours.pct - (theirs as number)) < 0.15
  console.log(`  ${ok ? 'ok  ' : 'diff'} §${n.padEnd(3)} ours ${ours ? ours.pct.toFixed(1).padStart(6) : '     —'}%  ` +
    `theirs ${String(theirs).padStart(6)}%`)
}

console.log('\n══ Reference figures ══')
const W = 44
for (const r of rows) {
  const mark = r.status === 'ok' ? ' ok ' : r.status === 'differs' ? 'DIFF' : 'BLKD'
  console.log(`  ${mark}  ${r.label.padEnd(W)} ours ${r.ours.padStart(10)}   ref ${r.theirs}`)
  if (r.note) console.log(`        ${' '.repeat(W)} ${r.note}`)
}

console.log('\n══ Overall ══')
console.log(`  our score with the weld log absent : ${score.overallPct}%`)
console.log(`  reference score (complete import)  : ${json.expected_overall_score_pct}%`)
console.log(`  weight reachable without the weld log: ${
  score.sections.filter((s) => s.countsTowardTotal && s.weight > 0 &&
    !['10','12','15','17','21','22'].includes(s.sectionNumber))
    .reduce((a, s) => a + s.weight, 0)} of ${score.weightAvailable}`)

const flags = countBySeverity(aggregateFindings(evaluateFlags(b, { asOf: '2026-08-21' })))
console.log(`\n══ Flags ══\n  ${flags.critical} critical, ${flags.warning} warning, ` +
  `${flags.info} info across ${flags.totalRecords} records`)
for (const f of aggregateFindings(evaluateFlags(b, { asOf: '2026-08-21' }))) {
  console.log(`  ${f.severity.padEnd(8)} ${String(f.occurrences).padStart(4)}  ${f.title}`)
}
console.log()

// ---------------------------------------------------------------------
// The bridge from what is loaded to what the book should score.
//
// Each blocked section is credited with the reference figure to show what
// the gap is made of. This is a projection for planning, never a score:
// nothing here is written into the book.
// ---------------------------------------------------------------------
console.log('\n══ Bridge: 14% → 59% ══')
const blockedSections = ['4', '9', '10', '12', '15', '17', '21', '22']
let running = score.weightApplied
const startPct = score.overallPct
console.log(`  loaded now                                        ${startPct.toFixed(2)}%`)
for (const n of blockedSections) {
  const ours = byNumber.get(n)
  const refPct = jsonSections.get(n) as number | null
  if (!ours || refPct == null) continue
  const gain = ((refPct - ours.pct) / 100) * ours.weight
  running += gain
  console.log(`  + §${n.padEnd(3)} ${String(refPct).padStart(5)}% × w${String(ours.weight).padStart(4)}` +
    ` = +${gain.toFixed(2).padStart(5)} pts   →  ${(running / score.weightAvailable * 100).toFixed(2)}%`)
}
console.log(`  reference                                         ${json.expected_overall_score_pct}%`)

// ---------------------------------------------------------------------
// What the empty sections cost, and the question they raise.
// ---------------------------------------------------------------------
const genuinelyEmpty = ['16', '18', '19']
const emptyWeight = genuinelyEmpty
  .map((n) => byNumber.get(n)?.weight ?? 0)
  .reduce((a, w) => a + w, 0)
console.log('\n══ The three empty sections ══')
for (const n of genuinelyEmpty) {
  const s = byNumber.get(n)
  console.log(`  §${n.padEnd(3)} w=${String(s?.weight).padStart(4)}  ${s?.title}`)
}
console.log(`  Together ${emptyWeight} of ${score.weightAvailable} weight points, all scoring zero.`)
console.log(`  Verified empty on disk: their folders exist and hold 0 bytes.`)
console.log(`  If these are genuinely out of scope for this facility and were marked N/A,`)
console.log(`  the same evidence would score ${
  (json.expected_overall_score_pct / (score.weightAvailable - emptyWeight) * score.weightAvailable).toFixed(1)
}% instead of ${json.expected_overall_score_pct}% — N/A leaves both sides of the division.`)
console.log()
