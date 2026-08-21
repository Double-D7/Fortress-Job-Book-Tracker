#!/usr/bin/env tsx
/**
 * Ingest a job book from a local folder.
 *
 * Run this where the files actually are — a synced OneDrive folder on a
 * workstation — rather than through a cloud connector. Locally there is no
 * MIME allow-list, so a macro-enabled .xlsm is just a file; there is no
 * per-folder API call, so a four-deep tree costs nothing; and the whole
 * book is read in one pass instead of three hundred round trips.
 *
 *   npx tsx scripts/ingest-job-book.ts "<path to job book root>" [--out DIR]
 *
 * Writes fixtures the application reads, and prints what it found. It
 * never writes to the source folder.
 */
import {
  existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync,
} from 'node:fs'
import { join, relative, sep } from 'node:path'
import * as XLSX from 'xlsx'
import { importFolderTree, type TreeEntry } from '../src/lib/import/folderTree'
import { parseFacilityWeldRows } from '../src/lib/import/facilityWeldLog'
import { parseFacilityTorqueRows } from '../src/lib/import/facilityTorqueLog'
import { buildTemplateSections } from '../src/lib/domain/checklist'
import { rollupTiers } from '../src/lib/domain/engineering'

const args = process.argv.slice(2)
const root = args.find((a) => !a.startsWith('--'))
const outIdx = args.indexOf('--out')
const outDir = outIdx >= 0 ? args[outIdx + 1]! : 'fixtures/ingested'
const bookType = args.includes('--flowline') ? 'flowline' : 'facility'

if (!root) {
  console.error(`
Usage: npx tsx scripts/ingest-job-book.ts "<path to job book root>" [--out DIR] [--flowline]

  <path>   The folder holding the numbered section folders, e.g.
           "C:/Users/you/OneDrive - Gusher Oil Field Services/05 - Projects/Fortress Job Book Tracker/1. Greeley Crescent Job book"
  --out    Where to write fixtures (default: fixtures/ingested)
`)
  process.exit(1)
}
if (!existsSync(root)) {
  console.error(`Not found: ${root}`)
  process.exit(1)
}

// ---------------------------------------------------------------------
// 1. Walk the tree
// ---------------------------------------------------------------------
const entries: TreeEntry[] = []
function walk(dir: string) {
  let items: string[]
  try {
    items = readdirSync(dir)
  } catch (e) {
    console.warn(`  ! cannot read ${dir}: ${(e as Error).message}`)
    return
  }
  for (const name of items) {
    const full = join(dir, name)
    let st
    try { st = statSync(full) } catch { continue }
    const rel = relative(root!, full).split(sep).join('/')
    if (st.isDirectory()) {
      entries.push({ path: rel, isFolder: true, sizeBytes: 0 })
      walk(full)
    } else {
      entries.push({
        path: rel, isFolder: false, sizeBytes: st.size,
        modified: st.mtime.toISOString(),
      })
    }
  }
}

console.log(`\nWalking ${root} …`)
walk(root)
const files = entries.filter((e) => !e.isFolder)
console.log(`  ${files.length} files, ${entries.length - files.length} folders, ` +
  `${(files.reduce((a, e) => a + (e.sizeBytes ?? 0), 0) / 1_048_576).toFixed(0)} MB`)

const known = buildTemplateSections(bookType, 'tpl').map((d) => d.sectionNumber)
const tree = importFolderTree(entries, { jobBookId: 'ingest', knownSectionNumbers: known })

console.log('\nFiles by section')
for (const n of Object.keys(tree.countsBySection).sort((a, b) => Number(a) - Number(b))) {
  const c = tree.countsBySection[n]!
  console.log(`  §${n.padEnd(4)} ${String(c.files).padStart(5)} files  ` +
    `${(c.bytes / 1_048_576).toFixed(1).padStart(8)} MB`)
}
if (tree.emptySections.length) {
  console.log(`\n  Section folders present but empty: ${tree.emptySections.join(', ')}`)
}
if (tree.supplementalFolders.length) {
  console.log(`  Off-checklist top-level folders: ${tree.supplementalFolders.join(', ')}`)
}

// ---------------------------------------------------------------------
// 2. Find and read the workbooks
//
// Located by content rather than by exact filename: these get renamed
// ("UPDATED 6.16", "Revised") on every revision, and an importer keyed to
// a literal name breaks the first time somebody saves a new copy.
// ---------------------------------------------------------------------
const WORKBOOK_RE = /\.(xlsx|xlsm|xls)$/i
const workbooks = files.filter((f) => WORKBOOK_RE.test(f.path))
const find = (re: RegExp) => workbooks.find((f) => re.test(f.path))

const weldLog = find(/weld\s*log/i)
const torqueLog = find(/torque\s*log/i)
const heatTracker = find(/heat\s*number|heat\s*tracker/i)
const pressureBook = find(/testing\s*times|pressure/i)

console.log('\nWorkbooks')
for (const [label, f] of [
  ['weld log', weldLog], ['torque log', torqueLog],
  ['heat tracker', heatTracker], ['pressure holds', pressureBook],
] as const) {
  console.log(`  ${label.padEnd(15)} ${f ? f.path : '— not found'}`)
}

mkdirSync(outDir, { recursive: true })

/** Read a sheet as rows. SheetJS treats .xlsm as the OOXML package it is,
 *  so the macro-enabled weld log needs no special handling here. */
function sheetRows(path: string, sheetHint?: RegExp): { name: string; rows: unknown[][] } | null {
  const wb = XLSX.read(readFileSync(join(root!, path)), { type: 'buffer', cellDates: true })
  const name = (sheetHint && wb.SheetNames.find((n) => sheetHint.test(n))) || wb.SheetNames[0]
  if (!name) return null
  const sheet = wb.Sheets[name]
  if (!sheet) return null
  return { name, rows: XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true, defval: null }) }
}

const report: Record<string, unknown> = { root, files: files.length, bookType }

// ---- weld log -------------------------------------------------------
if (weldLog) {
  const s = sheetRows(weldLog.path, /weld\s*log/i)
  if (s) {
    const parsed = parseFacilityWeldRows(s.rows, { sheetName: s.name })
    console.log(`\nWeld log — sheet "${s.name}"`)
    console.log(`  ${parsed.rows.length} welds`)
    console.log(`  welder stamps: ${parsed.welderStamps.map((w) => `${w.stamp}(${w.welds})`).join(', ')}`)
    console.log(`  construction areas: ${parsed.constructionAreas.join(', ') || '—'}`)
    console.log(`  isometrics referenced: ${parsed.isometrics.length}`)
    const tiers = rollupTiers(parsed.rows.map((r) => ({ smys: r.smys, hasNde: !!r.ndtMethod })))
    console.log(`  % SMYS: ${tiers.belowThreshold} below threshold, ` +
      `${tiers.atOrAboveThreshold} at or above, max ` +
      `${tiers.maxPctSmys == null ? '—' : (tiers.maxPctSmys * 100).toFixed(2) + '%'}` +
      `, ${tiers.uncomputable} uncomputable`)
    console.log(`  tier: ${tiers.tierRequired} require NDE, ${tiers.tierMet} met, ` +
      `${tiers.tierShortfall} short`)
    if (parsed.tierDisagreements.length) {
      console.log(`  ! ${parsed.tierDisagreements.length} rows where the recomputed tier ` +
        `disagrees with the workbook's own column`)
    }
    const errs = parsed.issues.filter((i) => i.severity === 'error')
    if (errs.length) console.log(`  ! ${errs.length} rows rejected — first: ${errs[0]!.message}`)
    // If the header did not map, say so loudly: everything downstream is
    // wrong in a way that looks like missing data rather than a bad parse.
    if (parsed.rows.length === 0) {
      console.log(`  !! No rows parsed. The column headers on "${s.name}" did not match. ` +
        `Send the header row and the mapping can be extended.`)
      console.log(`     First 40 cells of each of the first 30 rows are in ` +
        `${outDir}/weld-log-headers.json for that purpose.`)
      writeFileSync(join(outDir, 'weld-log-headers.json'),
        JSON.stringify(s.rows.slice(0, 30).map((r) => r.slice(0, 40)), null, 2))
    }
    writeFileSync(join(outDir, 'weld-log.json'), JSON.stringify(parsed.rows, null, 2))
    report.welds = parsed.rows.length
  }
}

// ---- torque log -----------------------------------------------------
if (torqueLog) {
  const s = sheetRows(torqueLog.path, /torque\s*log/i)
  if (s) {
    const parsed = parseFacilityTorqueRows(s.rows as (string | null)[][], s.name)
    console.log(`\nTorque log — sheet "${s.name}"`)
    console.log(`  ${parsed.rows.length} connections, ` +
      `${parsed.rows.filter((r) => r.inspectionDate).length} with an inspection date`)
    console.log(`  roster: ${parsed.roster.map((r) => r.wrenchId).join(', ') || '—'}`)
    writeFileSync(join(outDir, 'torque-log.json'), JSON.stringify(parsed.rows, null, 2))
    report.torqueConnections = parsed.rows.length
  }
}

// ---- the remaining workbooks are written raw for now ----------------
for (const [label, f] of [['heat-tracker', heatTracker], ['pressure-holds', pressureBook]] as const) {
  if (!f) continue
  const s = sheetRows(f.path)
  if (!s) continue
  writeFileSync(join(outDir, `${label}.json`),
    JSON.stringify({ sheet: s.name, rows: s.rows }, null, 2))
  console.log(`\n${label} — sheet "${s.name}", ${s.rows.length} rows written`)
}

// ---- the tree itself ------------------------------------------------
writeFileSync(join(outDir, 'folder-tree.tsv'),
  files.map((f) => `${f.path}\t${f.sizeBytes ?? 0}`).join('\n'))
writeFileSync(join(outDir, 'ingest-report.json'), JSON.stringify({
  ...report,
  countsBySection: tree.countsBySection,
  emptySections: tree.emptySections,
  supplementalFolders: tree.supplementalFolders,
  issues: tree.issues,
}, null, 2))

console.log(`\nWrote fixtures to ${outDir}/`)
console.log(`  folder-tree.tsv       every file and its size`)
console.log(`  ingest-report.json    counts, empty sections, issues`)
if (weldLog) console.log(`  weld-log.json         parsed weld rows`)
if (torqueLog) console.log(`  torque-log.json       parsed torque rows`)
console.log(`\nCommit that folder and the app will read it.\n`)
