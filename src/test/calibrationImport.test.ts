/**
 * The path from a person to a row.
 *
 * Every piece of this existed before it did: the certificate reader, the
 * schema columns, and four section 13 rules written against them. What was
 * missing was the middle, so `torque.certificate_unread` reported for
 * months that this application had not read a page it had no means of
 * being given.
 *
 * These cases drive the actual path — a PDF, the reader, the plan, the
 * provider, the flag queue — because a plan that is correct and
 * unreachable is exactly the defect being fixed here. The certificate text
 * is the text layer of the pages filed in section 13 of the Greeley
 * Crescent DP-318 book.
 */
import { deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import {
  buildCalibrationPreview, getDataProvider, readCertificates, type Viewer,
} from '@/lib/data/provider'
import { evaluateFlags } from '@/lib/domain/flags'
import type { JobBookBundle, TorqueConnection, TorqueWrench } from '@/lib/domain/types'

/**
 * A PDF carrying one text run per line.
 *
 * Built rather than checked in because what is being tested is that a real
 * file reaches the plan — an inline string handed straight to the parser
 * would skip the extraction step, which is the step that was missing.
 */
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

/** Wrench 5155's certificate, as filed. */
const CERT_5155 = [
  'CERTIFICATE OF CALIBRATION',
  'Certificate No: WH400-250502083820',
  'Manufacturer: HYTORC',
  'Model No: MW-008-250-MFRMH',
  'SERIAL #: 0125115155',
  'Range and Units: 30-250 Lb.ft',
  'Receipt Date: 05-02-2025',
  'DATE CALIBRATED: May 2, 2025',
  'Calibration Due Date: May 2, 2026',
  'Calibration Frequency: 1 Year',
  'Final Calibration Status: Pass',
]

/** Wrench 0808's, whose roster line transcribes its in-service date. */
const CERT_0808 = [
  'CERTIFICATE OF CALIBRATION',
  'Certificate No: M1-250110135605',
  'Manufacturer: HYTORC',
  'SERIAL #: 0324600808',
  'Range and Units: 200 - 1000 Lb.ft',
  'DATE CALIBRATED: January 10, 2025',
  'Calibration Due Date:',
  'Calibration Frequency: n/a',
  'Final Calibration Status: Pass',
  'DATE WRENCH PUT IN SERVICE: 2/4/25 NCC',
]

function file(name: string, pages: string[][]) {
  return { filename: name, bytes: textPdf(pages) }
}

describe('reading certificates out of real files', () => {
  it('reads one certificate from one file', () => {
    const [c] = readCertificates([file('UNEX 5155.pdf', [CERT_5155])])
    expect(c!.parsed.serialNumber).toBe('0125115155')
    expect(c!.parsed.wrenchId).toBe('5155')
    expect(c!.parsed.dateCalibrated).toBe('2025-05-02')
    expect(c!.parsed.calibrationDueDate).toBe('2026-05-02')
    expect(c!.parsed.finalStatus).toBe('pass')
  })

  it('reads a scan of the whole tab as several certificates', () => {
    // How a QA lead actually files these: one scan of section 13.
    const read = readCertificates([file('Section 13.pdf', [CERT_5155, CERT_0808])])
    expect(read).toHaveLength(2)
    expect(read.map((c) => c.parsed.wrenchId)).toEqual(['5155', '0808'])
    expect(read[0]!.filename).toMatch(/page 1/)
  })

  it('treats a repeated serial as the back of the same page', () => {
    const read = readCertificates([file('two-sided.pdf', [CERT_5155, CERT_5155])])
    expect(read).toHaveLength(1)
  })

  it('still produces a row for a file it cannot read at all', () => {
    // An unreadable page is a fact about the book. Dropping it silently is
    // how a wrench ends up with no calibration and nobody knowing why.
    const read = readCertificates([{ filename: 'photo.pdf', bytes: new Uint8Array([1, 2, 3]) }])
    expect(read).toHaveLength(1)
    expect(read[0]!.parsed.status).toBe('no_text_layer')
  })

  it('keeps the in-service date out of the calibration date', () => {
    // The roster transcribed 2/4/25 as wrench 0808's calibration. The page
    // says January 10.
    const [c] = readCertificates([file('0808.pdf', [CERT_0808])])
    expect(c!.parsed.dateCalibrated).toBe('2025-01-10')
    expect(c!.parsed.annotations.join(' ')).toMatch(/PUT IN SERVICE/)
  })
})

describe('planning a real file against a real book', () => {
  function bundleWith(
    wrenches: TorqueWrench[], connections: Partial<TorqueConnection>[],
  ): JobBookBundle {
    return {
      torqueWrenches: wrenches,
      torqueConnections: connections.map((c, i) => ({
        id: `c${i}`, jobBookId: 'b', isoFlangeNumber: `F-${i}`,
        wrenchId: null, wrenchIdRaw: '5155', torqueDate: '2025-08-01',
        enteredAt: '2025-08-01T00:00:00Z', entrySource: 'field_entry',
        ...c,
      })),
    } as unknown as JobBookBundle
  }

  it('turns a PDF into a calibration window and says what it settles', () => {
    const b = bundleWith(
      [{ id: 'w1', wrenchId: '5155', certOnFile: true, certRead: false, onRoster: true }],
      Array.from({ length: 18 }, () => ({ wrenchId: 'w1' })),
    )
    const p = buildCalibrationPreview(b, [file('UNEX 5155.pdf', [CERT_5155])])
    expect(p.ok).toBe(true)
    expect(p.counts!.calibrations).toBe(1)
    expect(p.counts!.connectionsResolved).toBe(18)
    expect(p.plan!.rows[0]!.dateCalibrated).toBe('2025-05-02')
  })

  it('refuses an empty upload rather than reporting an empty plan', () => {
    expect(buildCalibrationPreview(bundleWith([], []), []).ok).toBe(false)
  })
})

describe('committing through the provider', () => {
  const manager: Viewer = {
    id: 'u-mgr', email: 'm@fortressds.com', fullName: 'M. Ruiz',
    role: 'qaqc_manager', clientOrgId: null,
  }
  const reader: Viewer = {
    id: 'u-ro', email: 'r@fortressds.com', fullName: 'R. Ng',
    role: 'fortress_read_only', clientOrgId: null,
  }

  function certPages(wrenchId: string, calibrated: string, due: string): string[][] {
    return [[
      'CERTIFICATE OF CALIBRATION',
      'Certificate No: TEST-0001',
      'Manufacturer: HYTORC',
      `SERIAL #: 012345${wrenchId}`,
      'Range and Units: 30-250 Lb.ft',
      `DATE CALIBRATED: ${calibrated}`,
      `Calibration Due Date: ${due}`,
      'Final Calibration Status: Pass',
    ]]
  }

  it('files a certificate for a wrench that had none, and clears the criticals',
    async () => {
      const p = getDataProvider()
      const before = (await p.getBundle(manager, 'book-dp452'))!

      // The reference book carries one wrench that torqued real
      // connections with no certificate on file — a critical finding per
      // connection, and exactly what a certificate answers.
      const used = new Set(before.torqueConnections.map((c) => c.wrenchIdRaw))
      const target = before.torqueWrenches.find((w) => used.has(w.wrenchId) && !w.certOnFile)
      expect(target, 'the reference book should carry an uncertified wrench').toBeTruthy()
      const wrenchId = target!.wrenchId

      const criticalsBefore = evaluateFlags(before)
        .filter((f) => f.ruleId === 'torque.wrench_no_certificate').length
      expect(criticalsBefore).toBeGreaterThan(0)

      const res = await p.commitCalibrationImport(
        manager, 'book-dp452',
        [file('cert.pdf', certPages(wrenchId, 'January 2, 2024', 'January 2, 2027'))],
      )
      expect(res.ok).toBe(true)
      expect(res.wrenchesUpdated).toBe(1)
      expect(res.connectionsResolved).toBeGreaterThan(0)

      const after = (await p.getBundle(manager, 'book-dp452'))!
      const w = after.torqueWrenches.find((x) => x.wrenchId === wrenchId)!
      expect(w.lastCalibrationDate).toBe('2024-01-02')
      expect(w.calibrationDueDate).toBe('2027-01-02')
      expect(w.certOnFile).toBe(true)
      expect(w.certRead).toBe(true)
      expect(w.certificateNumber).toBe('TEST-0001')

      expect(evaluateFlags(after)
        .filter((f) => f.ruleId === 'torque.wrench_no_certificate').length)
        .toBeLessThan(criticalsBefore)
    })

  it('will not roll a calibration backwards through the provider either', async () => {
    // The plan refuses it; this is the check that the refusal survives the
    // round trip rather than being a preview-only nicety.
    const p = getDataProvider()
    const b = (await p.getBundle(manager, 'book-dp452'))!
    const current = b.torqueWrenches.find((w) => w.lastCalibrationDate)!

    const res = await p.commitCalibrationImport(
      manager, 'book-dp452',
      [file('old.pdf', certPages(current.wrenchId, 'January 1, 2000', 'January 1, 2001'))],
    )
    expect(res.ok).toBe(true)
    expect(res.held).toBe(1)

    const after = (await p.getBundle(manager, 'book-dp452'))!
      .torqueWrenches.find((w) => w.wrenchId === current.wrenchId)!
    expect(after.lastCalibrationDate).toBe(current.lastCalibrationDate)
  })

  it('refuses a reader', async () => {
    const res = await getDataProvider().commitCalibrationImport(
      reader, 'book-dp452',
      [file('c.pdf', certPages('0215', 'January 2, 2024', 'January 2, 2027'))],
    )
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/not permitted/i)
  })

  it('refuses a book the viewer cannot see', async () => {
    const res = await getDataProvider().commitCalibrationImport(
      manager, 'book-nope',
      [file('c.pdf', certPages('0215', 'January 2, 2024', 'January 2, 2027'))],
    )
    expect(res.ok).toBe(false)
  })
})
