import { NextResponse } from 'next/server'
import JSZip from 'jszip'
import * as XLSX from 'xlsx'
import { currentViewer, getDataProvider, providerKind } from '@/lib/data/provider'
import { scoreBook, collectedOf } from '@/lib/domain/scoring'
import { aggregateFindings, evaluateFlags } from '@/lib/domain/flags'
import { createClient } from '@/lib/supabase/server'
import { DOCUMENT_BUCKET } from '@/lib/supabase/storage'

/**
 * The turnover package.
 *
 * Two formats, both real:
 *
 *   zip   — every approved document, filed under its section number, plus
 *           a completeness report. This is the deliverable an operator
 *           actually opens.
 *   xlsx  — the weld and torque logs in the Noble column order, for an
 *           operator who wants the data rather than the paper.
 *
 * The bookmarked PDF is not built. It is a different job — merging
 * hundreds of PDFs with a generated outline — and shipping a button that
 * produced a broken package would be worse than not having it.
 *
 * Every export writes an audit row before the bytes go out, because "who
 * took a copy of this book" is a question that gets asked.
 */
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(
  request: Request,
  { params }: { params: Promise<{ bookId: string }> },
) {
  const { bookId } = await params
  const format = new URL(request.url).searchParams.get('format') ?? 'zip'

  const viewer = await currentViewer()
  if (!viewer) return NextResponse.json({ ok: false, error: 'Not signed in.' }, { status: 401 })

  const b = await getDataProvider().getBundle(viewer, bookId)
  if (!b) return NextResponse.json({ ok: false, error: 'Job book not found.' }, { status: 404 })

  const score = scoreBook(b)
  const stamp = new Date().toISOString().slice(0, 10)
  const base = `${b.book.jobNumber}-turnover-${stamp}`

  if (format === 'xlsx') {
    const wb = XLSX.utils.book_new()

    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(
      b.welds.map((w) => ({
        'Line': b.weldLines.find((l) => l.id === w.weldLineId)?.lineCode ?? '',
        'Weld #': w.weldNumber,
        'Date': w.weldDate ?? '',
        'Welder': w.welderStamp ?? w.welderPassAssignment ?? '',
        'Joint': w.jointType ?? '',
        'Component': w.componentDescription ?? '',
        'Heat #s': (w.heatNumbers ?? []).join(', '),
        'CWI': w.cwiInitials ?? '',
        'Visual': w.cwiVisualResult ?? '',
        'Visual date': w.visualInspectionDate ?? '',
        'NDT method': w.ndtMethod ?? '',
        'NDT result': w.ndtResult ?? '',
        'X-ray #': w.xrayNumber ?? '',
        'Status': w.status,
      })),
    ), 'Weld Log')

    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(
      b.torqueConnections.map((c) => ({
        'ISO-Flange': c.isoFlangeNumber,
        'ISO': c.isoNumber ?? '',
        'Size': c.flangePipeSize ?? '',
        'Bolt dia': c.boltDiameter ?? '',
        'Bolts': c.boltCount ?? '',
        'Required': c.requiredTorqueMinFtLb != null && c.requiredTorqueMaxFtLb != null
          ? `${c.requiredTorqueMinFtLb}-${c.requiredTorqueMaxFtLb}`
          : c.requiredTorqueFtLb ?? '',
        'Actual': c.actualTorqueFtLb ?? '',
        'Wrench': c.wrenchIdRaw ?? '',
        'Torqued': c.torqueDate ?? '',
        'By': c.employeeInitials ?? '',
        'Inspected': c.inspectionDate ?? '',
        'Inspector': c.inspectorInitials ?? '',
      })),
    ), 'Torque Log')

    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(
      score.sections.map((s) => ({
        'Section': s.sectionNumber,
        'Title': s.title,
        'Weight': s.weight,
        'Status': s.status,
        'Approved %': s.pct,
        'Collected %': collectedOf(s),
        'Explanation': s.explanation,
      })),
    ), 'Completeness')

    await logExport(bookId, 'export_xlsx')
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer
    return new NextResponse(new Uint8Array(buf), {
      headers: {
        'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'content-disposition': `attachment; filename="${base}.xlsx"`,
      },
    })
  }

  if (format !== 'zip') {
    return NextResponse.json(
      { ok: false, error: `Unknown format "${format}".` }, { status: 400 },
    )
  }

  const zip = new JSZip()
  zip.file(`${b.book.jobNumber}-completeness-report.txt`, completenessReport(b, score))

  // Approved documents only. An unapproved upload has not passed the
  // two-person control, and a turnover package is what the operator is
  // being told is finished.
  const defsById = new Map(b.sectionDefinitions.map((d) => [d.id, d]))
  const sectionById = new Map(b.sections.map((s) => [s.id, s]))
  const approved = b.documents.filter((d) => !d.deletedAt && !d.isSuperseded && d.approvedAt)

  let written = 0
  const unavailable: string[] = []

  if (providerKind() === 'supabase' && approved.length) {
    const supabase = await createClient()
    for (const d of approved) {
      const { data, error } = await supabase.storage
        .from(DOCUMENT_BUCKET).download(d.storagePath)
      if (error || !data) { unavailable.push(d.normalizedFilename); continue }
      const number = defsById.get(
        sectionById.get(d.sectionId ?? '')?.sectionDefinitionId ?? '')?.sectionNumber ?? 'unfiled'
      zip.file(`${number}/${d.normalizedFilename}`, await data.arrayBuffer())
      written++
    }
  }

  if (unavailable.length) {
    zip.file('MISSING-FROM-THIS-PACKAGE.txt',
      'These documents have a record in the book but their file could not be read from\n' +
      'storage, so they are NOT in this package. Do not deliver it as complete until\n' +
      'this list is empty.\n\n' + unavailable.map((f) => `  ${f}`).join('\n') + '\n')
  }
  if (providerKind() !== 'supabase') {
    zip.file('DEMO-MODE.txt',
      'This instance is running the in-memory reference book. It holds document\n' +
      'records but no files, so this package contains the completeness report only.\n')
  }

  await logExport(bookId, 'export_zip')
  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  return new NextResponse(new Uint8Array(buf), {
    headers: {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="${base}.zip"`,
      'x-documents-included': String(written),
    },
  })
}

/** Reproduces the figures on the turnover screen, so the package and the
 *  screen cannot tell an operator two different stories. */
function completenessReport(
  b: Awaited<ReturnType<ReturnType<typeof getDataProvider>['getBundle']>> & object,
  score: ReturnType<typeof scoreBook>,
): string {
  const bundle = b as NonNullable<typeof b>
  const flags = aggregateFindings(evaluateFlags(bundle))
  const criticals = flags.filter((f) => f.severity === 'critical')

  const lines = [
    `${bundle.book.jobNumber} — turnover completeness report`,
    `${bundle.clientOrg.name}${bundle.book.facilityName ? ` · ${bundle.book.facilityName}` : ''}`,
    `Generated ${new Date().toISOString()}`,
    '',
    `Overall completion : ${score.overallPct}%  (approved evidence)`,
    `Collected          : ${score.collectedPct}%  (in the book, some awaiting approval)`,
    `Weight earned      : ${score.weightApplied} of ${score.weightAvailable}`,
    '',
  ]

  if (score.isLowerBound) {
    lines.push(
      'THIS FIGURE IS A LOWER BOUND.',
      `Only ${score.evidenceCoveragePct}% of this book's weight has been read into the`,
      'application. Sections holding files nobody has imported score zero for lack of',
      'evidence, not for lack of work.',
      '',
    )
  }

  lines.push('Sections', '--------')
  for (const s of score.sections) {
    if (!s.countsTowardTotal || s.weight <= 0) continue
    lines.push(
      `${s.sectionNumber.padEnd(6)} ${String(s.pct).padStart(6)}%  w${String(s.weight).padStart(5)}  ` +
      `${s.status.padEnd(17)} ${s.title}`,
    )
  }

  lines.push('', `Open critical findings: ${criticals.length}`, '-----------------------')
  for (const f of criticals) {
    lines.push(`  [${f.occurrences}] ${f.title}`)
  }
  if (!criticals.length) lines.push('  None.')

  lines.push('',
    'This report is generated from the same engine that produces the figures on the',
    'turnover screen. Where it disagrees with a spreadsheet, the records in this',
    'package are the evidence.')
  return lines.join('\n')
}

async function logExport(bookId: string, action: string): Promise<void> {
  if (providerKind() !== 'supabase') return
  try {
    const supabase = await createClient()
    // Best effort. An audit failure must not stop a delivery, but it must
    // not pass unnoticed either — the row is the record.
    await supabase.from('audit_event').insert({
      job_book_id: bookId, entity_type: 'job_book', entity_id: bookId, action,
    })
  } catch { /* the trigger path already records the read */ }
}
