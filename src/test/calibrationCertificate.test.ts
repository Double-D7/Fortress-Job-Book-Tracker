/**
 * Calibration certificate parsing.
 *
 * The fixtures below are the text layers of the certificates actually filed
 * in section 13 of the Greeley Crescent DP-318 book, abridged to the fields
 * the parser reads. They exist because this application once reported a
 * wrench as having no calibration on record while its certificate sat in
 * the book — the certificate *is* the calibration record, and reading it is
 * this module's whole job.
 */
import { describe, expect, it } from 'vitest'
import {
  parseCalibrationCertificate, parseRangeLabel,
} from '@/lib/import/calibrationCertificate'
import { parseLooseDate, parseNamedMonthDate } from '@/lib/domain/dates'

const CERT_3282 = `
CERTIFICATE OF CALIBRATION
Certificate No: WH400-241206090106
Customer: ATLAS ENERGY SERVICES - GREELEY
Manufacturer: Gearwrench
Model No: 85066
SERIAL #: 608243282
Range and Units: 30-250 Lb.ft
DATE CALIBRATED: December 6, 2024
Calibration Due Date: December 6, 2025
Calibration Frequency: 1 Year
Final Calibration Status: Pass
`

const CERT_0808 = `
CERTIFICATE OF CALIBRATION
Certificate No: M1-250110135605
Manufacturer: HYTORC
Model No: MW-006-100-MFRMH
SERIAL #: 0324600808
Range and Units: 200 - 1000 Lb.ft
ISSUE DATE: January 10 2025
DATE CALIBRATED: January 10, 2025
Calibration Due Date:
Calibration Frequency: n/a
Final Calibration Status: Pass
DATE WRENCH PUT IN SERVICE: 2/4/25 NCC
`

const CERT_5155 = `
CERTIFICATE OF CALIBRATION
Certificate No: WH400-250502083820
Manufacturer: HYTORC
Model No: MW-008-250-MFRMH
SERIAL #: 0125115155
Range and Units: 30-250 Lb.ft
Receipt Date: 05-02-2025
DATE CALIBRATED: May 2, 2025
Calibration Due Date: May 2, 2026
Calibration Frequency: 1 Year
Final Calibration Status: Pass
`

describe('named-month dates', () => {
  it('reads the formats certificates actually print', () => {
    expect(parseNamedMonthDate('December 6, 2024')).toBe('2024-12-06')
    expect(parseNamedMonthDate('May 2 2026')).toBe('2026-05-02')
    expect(parseNamedMonthDate('6 Dec 2024')).toBe('2024-12-06')
    expect(parseNamedMonthDate('Sept 1, 2025')).toBe('2025-09-01')
    expect(parseNamedMonthDate('1st March 2025')).toBe('2025-03-01')
  })

  it('refuses what is not a date rather than guessing', () => {
    expect(parseNamedMonthDate('Pass')).toBeNull()
    expect(parseNamedMonthDate('Smarch 4, 2025')).toBeNull()
    expect(parseNamedMonthDate('n/a')).toBeNull()
    expect(parseNamedMonthDate('December 2024')).toBeNull()
  })

  it('is reachable through the shared loose parser', () => {
    expect(parseLooseDate('December 6, 2024')).toBe('2024-12-06')
    // Without breaking the slash formats the workbooks use.
    expect(parseLooseDate('2/4/25')).toBe('2025-02-04')
  })
})

describe('range labels', () => {
  it('reads both the hyphenated and spaced forms', () => {
    expect(parseRangeLabel('30-250 Lb.ft')).toEqual({ min: 30, max: 250 })
    expect(parseRangeLabel('200 - 1000 Lb.ft')).toEqual({ min: 200, max: 1000 })
    expect(parseRangeLabel('30 to 250 ft.lbs')).toEqual({ min: 30, max: 250 })
    expect(parseRangeLabel('1,000-5,000 Lb.ft')).toEqual({ min: 1000, max: 5000 })
  })

  it('returns nothing for a label with no range in it', () => {
    expect(parseRangeLabel('Lb.ft')).toEqual({ min: null, max: null })
    expect(parseRangeLabel(null)).toEqual({ min: null, max: null })
  })
})

describe('calibration certificates', () => {
  it('reads a complete certificate', () => {
    const c = parseCalibrationCertificate(CERT_3282)
    expect(c.status).toBe('parsed')
    expect(c.serialNumber).toBe('608243282')
    // The torque log names wrenches by the last four of the serial.
    expect(c.wrenchId).toBe('3282')
    expect(c.certificateNumber).toBe('WH400-241206090106')
    expect(c.dateCalibrated).toBe('2024-12-06')
    expect(c.calibrationDueDate).toBe('2025-12-06')
    expect(c.rangeMinFtLb).toBe(30)
    expect(c.rangeMaxFtLb).toBe(250)
    expect(c.finalStatus).toBe('pass')
    expect(c.warnings).toHaveLength(0)
  })

  it('takes the printed calibration date, never the handwritten one beside it', () => {
    const c = parseCalibrationCertificate(CERT_0808)
    // This is the correction the whole module exists for. The Greeley
    // torque log's roster transcribes 2/4/25 — the handwritten date the
    // wrench went into service — as this wrench's calibration date. The
    // wrench was calibrated on the 10th of January, 25 days earlier.
    expect(c.dateCalibrated).toBe('2025-01-10')
    expect(c.annotations.some((a) => /PUT IN SERVICE/i.test(a))).toBe(true)
    expect(c.annotations.some((a) => /2\/4\/25/.test(a))).toBe(true)
  })

  it('leaves a blank due date blank instead of inferring a year', () => {
    const c = parseCalibrationCertificate(CERT_0808)
    expect(c.calibrationDueDate).toBeNull()
    expect(c.calibrationFrequency).toBe('n/a')
    // Inventing a due date invents an expiry, and an invented expiry
    // condemns real connections.
    expect(c.warnings.join(' ')).toMatch(/no stated end/)
  })

  it('keeps a receipt date out of the calibration date', () => {
    const c = parseCalibrationCertificate(CERT_5155)
    expect(c.dateCalibrated).toBe('2025-05-02')
    expect(c.calibrationDueDate).toBe('2026-05-02')
    expect(c.annotations.some((a) => /Receipt Date/i.test(a))).toBe(true)
  })

  it('reports a page with no text layer as unread, not as empty', () => {
    const c = parseCalibrationCertificate('')
    expect(c.status).toBe('no_text_layer')
    expect(c.dateCalibrated).toBeNull()
    expect(c.serialNumber).toBeNull()
  })

  it('warns rather than dropping a date field it cannot read', () => {
    const c = parseCalibrationCertificate(
      'SERIAL #: 0125115155\nDATE CALIBRATED: illegible\nCalibration Due Date: ---',
    )
    expect(c.dateCalibrated).toBeNull()
    expect(c.status).toBe('partial')
    expect(c.warnings.join(' ')).toMatch(/illegible/)
  })
})
