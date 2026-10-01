/**
 * An import keeps the document it read.
 *
 * Every importer in this application used to parse its file and drop it.
 * Nothing on any screen looked wrong, because the screens read the rows
 * the import produced. The absence only surfaces when somebody asks to
 * see the original — which, on a job book that gets submitted, is the
 * question the whole package exists to answer. "Our system says the
 * technician examined weld 12" is not evidence; the report with the
 * vendor's letterhead on it is.
 *
 * It had a second cost that was invisible for the same reason. The
 * nightly backup copies rows from `document`, so a file that was never
 * filed was never backed up. The archive could not have held an NDE
 * report, because no NDE report was ever filed to begin with.
 *
 * These cases drive the real commit paths and then look for the file.
 * They are deliberately about retention rather than parsing: an import
 * may legitimately read nothing useful out of a page, and must still keep
 * the page.
 */
import { deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { getDataProvider, type Viewer } from '@/lib/data/provider'
import { SOURCE_SECTION } from '@/lib/domain/sourceFiling'

const manager: Viewer = {
  id: 'u-manager', email: 'manager@fortressds.com', fullName: 'Manager',
  role: 'qaqc_manager', clientOrgId: null,
}

/** A PDF with real text in it, the same builder the calibration tests use. */
function textPdf(pages: string[][]): Uint8Array {
  let pdf = '%PDF-1.4\n'
  const kids = pages.map((_, i) => `${3 + i * 2} 0 R`).join(' ')
  pdf += `1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`
  pdf += `2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>\nendobj\n`
  pages.forEach((lines, i) => {
    let content = ''
    let y = 760
    for (const l of lines) {
      const safe = l.replace(/([()\\])/g, '\\$1')
      content += `BT /F1 10 Tf 1 0 0 1 60 ${y} Tm (${safe}) Tj ET\n`
      y -= 14
    }
    const s = deflateSync(Buffer.from(content, 'latin1'))
    pdf += `${3 + i * 2} 0 obj\n<< /Type /Page /Parent 2 0 R /Contents ${4 + i * 2} 0 R >>\nendobj\n`
    pdf += `${4 + i * 2} 0 obj\n<< /Length ${s.length} /Filter /FlateDecode >>\n` +
      `stream\n${s.toString('latin1')}\nendstream\nendobj\n`
  })
  pdf += `trailer\n<< /Root 1 0 R >>\n%%EOF\n`
  return new Uint8Array(Buffer.from(pdf, 'latin1'))
}

/**
 * A report, distinct per caller.
 *
 * Filing deduplicates on the bytes, and the seed provider is one mutable
 * instance shared by every test in this file — so two tests sharing a
 * document would have the second one file nothing and fail for a reason
 * that has nothing to do with what it is checking.
 */
function reportPage(tag: string) {
  return [
  'RADIOGRAPHIC EXAMINATION REPORT',
  `Report No: ${tag}-RT`,
  'Date: 02/23/2026',
  'Procedure #: API-RT-006',
  'Acceptance Criteria: API 1104',
  'Technician: J FLORES',
  ]
}

/**
 * A wrench calibration certificate, in the shape the real ones take.
 *
 * Kept full rather than abbreviated: the parser reads the serial out of
 * this, and a page it cannot read produces no certificate row — which
 * would make a test about linking pass or fail for reasons that have
 * nothing to do with linking.
 */
function certPage(wrenchId: string, certNo: string, calibrated: string, due: string) {
  return [
    'CERTIFICATE OF CALIBRATION',
    `Certificate No: ${certNo}`,
    'Manufacturer: HYTORC',
    'Model No: MW-008-250-MFRMH',
    // The wrench is identified by the last four digits of the serial.
    `SERIAL #: 01251${wrenchId}`,
    'Range and Units: 30-250 Lb.ft',
    `DATE CALIBRATED: ${calibrated}`,
    `Calibration Due Date: ${due}`,
    'Calibration Frequency: 1 Year',
    'Final Calibration Status: Pass',
  ]
}

const BOOK = 'book-dp452'

async function documentsIn(sectionNumber: string) {
  const b = (await getDataProvider().getBundle(manager, BOOK))!
  const def = b.sectionDefinitions.find((d) => d.sectionNumber === sectionNumber)
  const section = b.sections.find((s) => s.sectionDefinitionId === def?.id)
  return b.documents.filter((d) => d.sectionId === section?.id)
}

describe('an NDE report that has been imported', () => {
  it('is filed into section 10, not just parsed', async () => {
    const TAG = 'A1'
    const before = (await documentsIn(SOURCE_SECTION.nde_report)).length

    const res = await getDataProvider().commitNdeImport(
      manager, BOOK, textPdf([reportPage(TAG)]), '6 - 02.23.26 Chevron DP-318.pdf',
    )
    expect(res.ok).toBe(true)

    const after = await documentsIn(SOURCE_SECTION.nde_report)
    expect(after.length).toBe(before + 1)
    expect(after.some((d) => d.originalFilename === '6 - 02.23.26 Chevron DP-318.pdf')).toBe(true)
  })

  it('is reachable from the report, so the page can offer the original', async () => {
    const TAG = 'A2'
    // The NDE page already renders the filename of `documentId`. Until
    // the import filed anything, it was rendering a document that did not
    // exist, which is the quietest way for evidence to be absent.
    const b0 = (await getDataProvider().getBundle(manager, BOOK))!
    const countBefore = b0.ndeReports.length

    await getDataProvider().commitNdeImport(
      manager, BOOK, textPdf([reportPage(TAG)]), 'RT-031.pdf',
    )

    const b = (await getDataProvider().getBundle(manager, BOOK))!
    const added = b.ndeReports.slice(countBefore)
    expect(added.length).toBeGreaterThan(0)
    for (const r of added) {
      expect(r.documentId, `report ${r.reportNumber} should name its source`).toBeTruthy()
      expect(b.documents.some((d) => d.id === r.documentId)).toBe(true)
    }
  })

  it('keeps the bytes, not merely the filename', async () => {
    const TAG = 'A3'
    // `source_filename` was already recorded before any of this, and a
    // name is not a document.
    await getDataProvider().commitNdeImport(
      manager, BOOK, textPdf([reportPage(TAG)]), 'RT-031.pdf',
    )
    const [doc] = (await documentsIn(SOURCE_SECTION.nde_report))
      .filter((d) => d.originalFilename === 'RT-031.pdf')
    expect(doc?.storagePath).toBeTruthy()
    expect(doc?.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(doc?.byteSize).toBeGreaterThan(0)
  })
})

describe('the same report imported twice', () => {
  it('is filed once', async () => {
    const TAG = 'B1'
    // Re-running a report after a weld number is corrected is ordinary.
    // Two copies of one document in a retention folder is not.
    const pdf = textPdf([reportPage(TAG)])
    const before = (await documentsIn(SOURCE_SECTION.nde_report)).length

    await getDataProvider().commitNdeImport(manager, BOOK, pdf, 'RT-031.pdf')
    const afterFirst = (await documentsIn(SOURCE_SECTION.nde_report)).length
    // Asserted, so this does not pass by filing nothing twice.
    expect(afterFirst).toBe(before + 1)

    await getDataProvider().commitNdeImport(manager, BOOK, pdf, 'RT-031.pdf')
    expect((await documentsIn(SOURCE_SECTION.nde_report)).length).toBe(afterFirst)
  })

  it('files a genuinely different report separately', async () => {
    const TAG = 'B2'
    const before = (await documentsIn(SOURCE_SECTION.nde_report)).length
    await getDataProvider().commitNdeImport(
      manager, BOOK, textPdf([reportPage(TAG)]), 'RT-031.pdf')
    await getDataProvider().commitNdeImport(
      manager, BOOK, textPdf([[...reportPage(TAG), 'Weld 14 Accept']]), 'RT-032.pdf')
    expect((await documentsIn(SOURCE_SECTION.nde_report)).length).toBe(before + 2)
  })
})

describe('a calibration certificate that has been imported', () => {
  /**
   * A wrench this book actually torqued with, and has no certificate for.
   *
   * The plan only writes a certificate for a wrench the book used — an
   * unused wrench's page is held, correctly, so a test built on one would
   * be asserting against a row the importer deliberately does not write.
   */
  async function usedWrench(opts: { uncertified?: boolean } = {}): Promise<string> {
    const b = (await getDataProvider().getBundle(manager, BOOK))!
    const used = new Set(b.torqueConnections.map((c) => c.wrenchIdRaw))
    const w = b.torqueWrenches.find(
      (x) => used.has(x.wrenchId) && (!opts.uncertified || !x.certOnFile))
    expect(w, 'the reference book should carry a wrench it torqued with').toBeTruthy()
    return w!.wrenchId
  }

  it('is filed into section 13', async () => {
    const wrenchId = await usedWrench({ uncertified: true })
    const before = (await documentsIn(SOURCE_SECTION.calibration_certificate)).length

    const res = await getDataProvider().commitCalibrationImport(
      manager, BOOK,
      [{
        filename: 'UNEX cert.pdf',
        bytes: textPdf([certPage(wrenchId, 'WH400-250502083820', 'May 2, 2025', 'May 2, 2026')]),
      }],
    )
    expect(res.ok).toBe(true)

    const after = await documentsIn(SOURCE_SECTION.calibration_certificate)
    expect(after.length).toBe(before + 1)
    expect(after.some((d) => d.originalFilename === 'UNEX cert.pdf')).toBe(true)
  })

  it('is reachable from the certificate it produced', async () => {
    // Scoped to the document this import filed. The seed book already
    // holds certificates with documents behind them, so asserting that
    // "some certificate has a documentId" passes whether or not this
    // import filed anything at all.
    // Any wrench the book torqued with; a later calibration of one that
    // already has a certificate is still a certificate worth filing, and
    // the previous test may have taken the last uncertified one.
    const wrenchId = await usedWrench()
    await getDataProvider().commitCalibrationImport(
      manager, BOOK,
      [{
        filename: 'UNEX recal.pdf',
        bytes: textPdf([certPage(wrenchId, 'M1-250902135605', 'September 2, 2025', 'September 2, 2026')]),
      }],
    )
    const b = (await getDataProvider().getBundle(manager, BOOK))!

    const doc = b.documents.find((d) => d.originalFilename === 'UNEX recal.pdf')
    expect(doc, 'the certificate page should have been filed').toBeTruthy()

    const certs = b.certificates.filter((c) => c.documentId === doc!.id)
    expect(certs.length, 'a certificate should name the page it came from')
      .toBeGreaterThan(0)
  })

  it('keeps a page it could not use', async () => {
    // An unreadable or unmatched certificate is still a document somebody
    // filed. Dropping it because this application could not use it would
    // lose the page and the problem with it together.
    const before = (await documentsIn(SOURCE_SECTION.calibration_certificate)).length
    const res = await getDataProvider().commitCalibrationImport(
      manager, BOOK,
      [{ filename: 'unreadable scan.pdf', bytes: textPdf([['nothing a parser can use']]) }],
    )
    expect(res.ok).toBe(true)
    expect((await documentsIn(SOURCE_SECTION.calibration_certificate)).length)
      .toBe(before + 1)
  })
})
