/**
 * Prints the DP452 seed's headline figures against the numbers stated in
 * the source brief. Run with `npm run seed:verify` when changing the
 * generator; the assertions themselves live in src/test.
 */
import { buildDp452Bundle, WELDER_TARGETS } from '../src/lib/data/seed/dp452'
import { rollupByWelder, xrayTotals } from '../src/lib/domain/welders'
import { torqueTotals, reconcileWrenches } from '../src/lib/domain/torque'
import { scoreBook } from '../src/lib/domain/scoring'
import { countBySeverity, evaluateFlags } from '../src/lib/domain/flags'

const b = buildDp452Bundle()
const line = (label: string, actual: unknown, expected?: unknown) => {
  const ok = expected === undefined || String(actual) === String(expected)
  console.log(
    `${ok ? '  ok ' : ' FAIL'} ${label.padEnd(46)} ${String(actual).padStart(12)}` +
    (expected !== undefined ? `   expected ${expected}` : ''),
  )
}

console.log('\n— Welder rollup (welder-credit basis) —')
const rollups = rollupByWelder(b.welds, b.welders, b.book)
for (const t of WELDER_TARGETS) {
  const r = rollups.find((x) => x.initials === t.initials)
  line(`${t.initials} welds`, r?.totalWelds ?? 0, t.welds)
  line(`${t.initials} x-rays`, r?.totalXrays ?? 0, t.xrays)
}
const xt = xrayTotals(b.welds, b.book, b.welders)
line('total weld credits', xt.totalWeldCredits, 2476)
line('total x-ray credits', xt.totalXrayCredits, 631)
line('overall x-ray %', xt.xrayPct.toFixed(1), '25.5')
line('joint count (both workbooks)', xt.jointCount, 2342)
line('credit overstatement %', xt.creditOverstatementPct.toFixed(1), '5.7')
line('flow-line joints', b.welds.filter((w) => w.status !== 'not_used' &&
  b.weldLines.find((l) => l.id === w.weldLineId)?.workbook === 'Flow Lines').length, 955)

console.log('\n— Torque log —')
const tt = torqueTotals(b.torqueConnections, b.book)
line('total connections', tt.totalConnections, 616)
line('inspected', tt.inspectedConnections, 118)
line('inspection %', tt.inspectionPct.toFixed(2), '19.16')
const wr = reconcileWrenches(b.torqueConnections, b.torqueWrenches)
line('wrenches on roster', wr.onRoster.length, 9)
line('wrenches in use', wr.inUse.length, 11)
line('wrenches certified', wr.certified.length, 12)
line('used ∩ certified', wr.inUse.filter((i) => wr.certified.includes(i)).length, 10)

console.log('\n— Documents —')
line('file count', b.documents.length, 315)
line('total size (MB)', (b.documents.reduce((s, d) => s + (d.byteSize ?? 0), 0) / 1_048_576).toFixed(0))
for (const [ext, want] of [['pdf', 305], ['xlsx', 4], ['zip', 3], ['docx', 1]] as const) {
  line(`${ext} files`, b.documents.filter((d) => d.originalFilename.toLowerCase().endsWith(`.${ext}`)).length, want)
}
line('image files', b.documents.filter((d) => /\.jpe?g$/i.test(d.originalFilename)).length, 2)
// The brief counts 40 NDE *files*: 39 report PDFs plus one XLSX job log.
line('NDE section files', b.documents.filter((d) => d.sectionId === 'sec-10').length, 40)
line('NDE report records', b.ndeReports.length, 39)

console.log('\n— Completion —')
const score = scoreBook(b)
line('overall %', score.overallPct)
line('weight available', score.weightAvailable, 100)
for (const s of score.sections.filter((x) => x.countsTowardTotal && x.weight > 0)) {
  console.log(`       ${s.sectionNumber.padEnd(6)} w=${String(s.weight).padStart(5)}  ${s.pct.toFixed(1).padStart(6)}%  ${s.explanation}`)
}
console.log(`       missing entirely: ${score.missingSections.map((s) => s.sectionNumber).join(', ')}`)

console.log('\n— Flags —')
const flags = evaluateFlags(b, { asOf: '2026-08-17' })
const counts = countBySeverity(flags)
line('critical', counts.critical)
line('warning', counts.warning)
line('info', counts.info)
const byRule = new Map<string, number>()
for (const f of flags) byRule.set(f.ruleId, (byRule.get(f.ruleId) ?? 0) + 1)
for (const [rule, n] of [...byRule.entries()].sort((a, c) => c[1] - a[1])) {
  console.log(`       ${String(n).padStart(4)}  ${rule}`)
}
console.log()
