/**
 * Filing a calibration certificate.
 *
 * The cases here are the ones the Greeley DP-318 book actually produced:
 * a wrench whose certificate sat in section 13 while eighteen connections
 * were flagged for having no readable calibration, a roster line that
 * transcribed an in-service date as a calibration date, and a page that
 * was a photograph of paper.
 */
import { describe, expect, it } from 'vitest'
import {
  countCalibrationPlan, planCalibrationImport,
} from '@/lib/domain/calibrationPlan'
import type { ParsedCalibrationCertificate } from '@/lib/import/calibrationCertificate'
import type { TorqueConnection, TorqueWrench } from '@/lib/domain/types'

function cert(
  over: Partial<ParsedCalibrationCertificate> = {},
): ParsedCalibrationCertificate {
  return {
    status: 'parsed',
    serialNumber: '0125115155', wrenchId: '5155', certificateNumber: 'C-1',
    manufacturer: 'HYTORC', model: 'AVANTI', rangeLabel: '30-250 Lb.ft',
    rangeMinFtLb: 30, rangeMaxFtLb: 250,
    dateCalibrated: '2025-01-10', calibrationDueDate: '2026-01-10',
    calibrationFrequency: '1 Year', finalStatus: 'pass',
    annotations: [], warnings: [], ...over,
  }
}

function wrench(over: Partial<TorqueWrench> & { id: string; wrenchId: string }): TorqueWrench {
  return { certOnFile: false, onRoster: true, ...over }
}

function conn(
  over: Partial<TorqueConnection> & { id: string },
): TorqueConnection {
  return {
    jobBookId: 'b', isoFlangeNumber: `F-${over.id}`, torqueDate: '2025-05-01',
    wrenchId: null, wrenchIdRaw: '5155',
    enteredAt: '2025-05-01T00:00:00Z', enteredBy: null, entrySource: 'field_entry',
    ...over,
  } as TorqueConnection
}

/** The wrench whose certificate was filed all along and never read. */
const UNREAD_WRENCH = wrench({
  id: 'w1', wrenchId: '5155', certOnFile: true, certRead: false,
})

/** Eighteen connections torqued with it, four months after calibration. */
const EIGHTEEN = Array.from({ length: 18 }, (_, i) =>
  conn({ id: `c${i}`, wrenchId: 'w1', torqueDate: '2025-05-01' }))

const ONE = [{ filename: 'UNEX 5155.pdf', parsed: cert() }]

describe('reading a certificate that was on file all along', () => {
  it('writes the calibration window off the certificate', () => {
    const [r] = planCalibrationImport(ONE, [UNREAD_WRENCH], EIGHTEEN).rows
    expect(r!.match).toBe('matched')
    expect(r!.disposition).toBe('calibration')
    expect(r!.writable).toBe(true)
    expect(r!.dateCalibrated).toBe('2025-01-10')
    expect(r!.calibrationDueDate).toBe('2026-01-10')
  })

  it('reports the findings it answers, which is the reason to file it', () => {
    // This is the whole payload: eighteen connections read
    // `certificate_unread` today and read `valid` once the page is filed.
    const c = countCalibrationPlan(planCalibrationImport(ONE, [UNREAD_WRENCH], EIGHTEEN))
    expect(c.connectionsResolved).toBe(18)
    expect(c.connectionsExposed).toBe(0)
  })

  it('reports the findings it raises, and files it anyway', () => {
    // A wrench whose calibration had lapsed torqued those flanges whether
    // or not the certificate is on file. Filing it is what lets the book
    // say so, so an exposure is never a reason to hold the import.
    const late = [conn({ id: 'late', wrenchId: 'w1', torqueDate: '2026-06-01' })]
    const [r] = planCalibrationImport(ONE, [UNREAD_WRENCH], late).rows
    expect(r!.effect.exposed).toBe(1)
    expect(r!.writable).toBe(true)
  })

  it('counts a calibration that postdates the work as an exposure', () => {
    const early = [conn({ id: 'e', wrenchId: 'w1', torqueDate: '2024-11-01' })]
    expect(planCalibrationImport(ONE, [UNREAD_WRENCH], early).rows[0]!.effect.exposed).toBe(1)
  })
})

describe('matching a certificate to a wrench', () => {
  it('matches on the serial\'s last four, which is how the log names it', () => {
    const [r] = planCalibrationImport(ONE, [UNREAD_WRENCH], []).rows
    expect(r!.wrenchId).toBe('5155')
    expect(r!.matchedWrenchId).toBe('w1')
  })

  it('refuses when two managed wrenches share the last four', () => {
    // A certificate written onto the wrong wrench certifies work it never
    // touched, which is worse than one left unfiled.
    const twins = [
      wrench({ id: 'a', wrenchId: '5155', certOnFile: true }),
      wrench({ id: 'b', wrenchId: '5155', certOnFile: true }),
    ]
    const [r] = planCalibrationImport(ONE, twins, EIGHTEEN).rows
    expect(r!.match).toBe('ambiguous')
    expect(r!.writable).toBe(false)
  })

  it('creates a wrench when connections name one with no record', () => {
    // `unknown_wrench` findings exist precisely for this: a wrench used on
    // the job that never made it into the roster block.
    const p = planCalibrationImport(ONE, [], EIGHTEEN)
    expect(p.rows[0]!.match).toBe('new_wrench')
    expect(p.rows[0]!.writable).toBe(true)
    expect(countCalibrationPlan(p).wrenchesCreated).toBe(1)
  })

  it('writes nothing for a wrench this book never used', () => {
    const p = planCalibrationImport(ONE, [], [])
    expect(p.rows[0]!.match).toBe('unused')
    expect(p.rows[0]!.writable).toBe(false)
  })
})

describe('pages that cannot support a calibration window', () => {
  it('records a photographed page as on file and unread', () => {
    // The distinction the schema was built for: unread is an ingestion gap
    // on our side, not a missing certificate in the book.
    const scan = [{
      filename: 'scan.pdf',
      parsed: cert({
        status: 'no_text_layer', serialNumber: null, wrenchId: null,
        dateCalibrated: null, calibrationDueDate: null, finalStatus: null,
      }),
    }]
    const [r] = planCalibrationImport(scan, [UNREAD_WRENCH], EIGHTEEN).rows
    expect(r!.match).toBe('no_serial')
    expect(r!.disposition).toBe('unread')
    expect(r!.notes.join(' ')).toMatch(/OCR/)
  })

  it('records a readable page with no date as on file and unread', () => {
    const noDate = [{ filename: 'x.pdf', parsed: cert({ dateCalibrated: null }) }]
    const [r] = planCalibrationImport(noDate, [UNREAD_WRENCH], EIGHTEEN).rows
    expect(r!.disposition).toBe('unread')
    expect(r!.writable).toBe(true)
    expect(r!.effect.resolved).toBe(0)
  })

  it('never writes a window for a wrench the laboratory failed', () => {
    const failed = [{ filename: 'f.pdf', parsed: cert({ finalStatus: 'fail' }) }]
    const [r] = planCalibrationImport(failed, [UNREAD_WRENCH], EIGHTEEN).rows
    expect(r!.disposition).toBe('failed')
    expect(r!.effect.resolved).toBe(0)
    expect(r!.notes.join(' ')).toMatch(/18 connections/)
  })

  it('counts every connection a failed wrench touched as uncertified', () => {
    // The worst reading this screen could give: filing the page that
    // proves the tool was out of tolerance, under a headline saying it
    // raises no findings. A failed wrench has no window for any
    // connection to fall inside.
    const failed = [{ filename: 'f.pdf', parsed: cert({ finalStatus: 'fail' }) }]
    const c = countCalibrationPlan(planCalibrationImport(failed, [UNREAD_WRENCH], EIGHTEEN))
    expect(c.connectionsExposed).toBe(18)
    expect(c.writes).toBe(1)
  })

  it('refuses a window that closes before it opens', () => {
    const bad = [{
      filename: 'b.pdf',
      parsed: cert({ dateCalibrated: '2025-06-01', calibrationDueDate: '2025-01-01' }),
    }]
    const [r] = planCalibrationImport(bad, [UNREAD_WRENCH], EIGHTEEN).rows
    expect(r!.disposition).toBe('window_reversed')
    expect(r!.writable).toBe(false)
  })
})

describe('an older certificate than the one on file', () => {
  it('is filed but never written over a newer calibration', () => {
    const current = wrench({
      id: 'w1', wrenchId: '5155', certOnFile: true, certRead: true,
      lastCalibrationDate: '2025-06-01', calibrationDueDate: '2026-06-01',
    })
    const old = [{ filename: 'old.pdf', parsed: cert({ dateCalibrated: '2025-01-10' }) }]
    const [r] = planCalibrationImport(old, [current], EIGHTEEN).rows
    expect(r!.disposition).toBe('superseded')
    expect(r!.writable).toBe(false)
    expect(r!.notes.join(' ')).toContain('2025-06-01')
  })

  it('keeps the newest when a batch holds two for one wrench', () => {
    // Uploading a folder of certificates is the point of the batch; a
    // recalibrated wrench has two pages in it.
    const batch = [
      { filename: 'new.pdf', parsed: cert({ dateCalibrated: '2025-04-01' }) },
      { filename: 'old.pdf', parsed: cert({ dateCalibrated: '2025-01-10' }) },
    ]
    const rows = planCalibrationImport(batch, [UNREAD_WRENCH], EIGHTEEN).rows
    expect(rows[0]!.disposition).toBe('calibration')
    expect(rows[1]!.disposition).toBe('superseded')
  })

  it('does not double-count the same connection across a batch', () => {
    // Both pages predate the 2025-05-01 work, so the newer one resolves
    // all eighteen and the superseded one must add nothing.
    const batch = [
      { filename: 'new.pdf', parsed: cert({ dateCalibrated: '2025-04-01' }) },
      { filename: 'old.pdf', parsed: cert({ dateCalibrated: '2025-01-10' }) },
    ]
    const c = countCalibrationPlan(planCalibrationImport(batch, [UNREAD_WRENCH], EIGHTEEN))
    expect(c.connectionsResolved).toBe(18)
  })
})

describe('the roster and the certificate disagreeing', () => {
  it('reports both rather than choosing', () => {
    // Wrench 0808: the roster transcribes the handwritten date the wrench
    // went into service, 2025-02-04, against a certificate calibrated
    // 2025-01-10.
    const claimed = wrench({
      id: 'w1', wrenchId: '5155', certOnFile: true,
      rosterClaimedCalibrationDate: '2025-02-04',
    })
    const [r] = planCalibrationImport(ONE, [claimed], EIGHTEEN).rows
    expect(r!.rosterDisagrees).toEqual({ claimed: '2025-02-04', certificate: '2025-01-10' })
    expect(r!.writable).toBe(true)
    expect(r!.notes.join(' ')).toMatch(/certificate is the calibration record/)
  })

  it('says nothing when they agree', () => {
    const agrees = wrench({
      id: 'w1', wrenchId: '5155', certOnFile: true,
      rosterClaimedCalibrationDate: '2025-01-10',
    })
    expect(planCalibrationImport(ONE, [agrees], EIGHTEEN).rows[0]!.rosterDisagrees).toBeNull()
  })
})

describe('the summary a person presses the button on', () => {
  it('separates what will be written from what is held back', () => {
    const batch = [
      { filename: 'good.pdf', parsed: cert() },
      { filename: 'scan.pdf', parsed: cert({ serialNumber: null, wrenchId: null, dateCalibrated: null }) },
      { filename: 'bad.pdf', parsed: cert({ wrenchId: '9999', serialNumber: '9999' }) },
    ]
    const c = countCalibrationPlan(planCalibrationImport(batch, [UNREAD_WRENCH], EIGHTEEN))
    expect(c.files).toBe(3)
    expect(c.calibrations).toBe(1)
    expect(c.held).toBe(2)
    // What the button files, which is not the same as the number of
    // calibration windows: a failed wrench is written too, as a failure.
    expect(c.writes).toBe(1)
  })

  it('never counts a page it will not file as one it will', () => {
    // A page with no serial reads as `unread`, which is honest, but there
    // is no wrench to write it against. Counting it under "will be filed"
    // told a person a page was filed when it was not.
    const orphan = [{
      filename: 'photo.pdf',
      parsed: cert({ serialNumber: null, wrenchId: null, dateCalibrated: null }),
    }]
    const c = countCalibrationPlan(planCalibrationImport(orphan, [UNREAD_WRENCH], EIGHTEEN))
    expect(c.writes).toBe(0)
    expect(c.unread).toBe(0)
    expect(c.held).toBe(1)
  })

  it('carries the reader\'s own warnings through to the person', () => {
    // A parser warning nobody ever sees is a parser warning that does not
    // exist.
    const warned = [{
      filename: 'w.pdf',
      parsed: cert({ calibrationDueDate: null, warnings: ['no due date; the window has no stated end'] }),
    }]
    const [r] = planCalibrationImport(warned, [UNREAD_WRENCH], EIGHTEEN).rows
    expect(r!.notes.join(' ')).toMatch(/no stated end/)
  })
})
