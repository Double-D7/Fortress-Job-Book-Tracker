/**
 * How long a calibration stands when the certificate does not say.
 *
 * Only one of the three instrument certificate styles in a pressure test
 * package prints an expiry date. A PSS gauge certificate prints DATE
 * CALIBRATED and EXPIRATION DATE; a Crystal nVision certificate prints a
 * calibration date and a certificate issue date and stops; a PSV repair
 * report prints a test date. The application read a blank expiry as an
 * unbounded one, so an nVision calibrated in April 2025 certified a
 * pressure test in any later year.
 *
 * Fortress recalibrates on a twelve-month cycle unless a client requires
 * shorter — some require six — so the interval lives on the job book.
 *
 * The dates here are the ones printed on the certificates this was built
 * against.
 */
import { describe, expect, it } from 'vitest'
import {
  addMonths, certValidOn, effectiveExpiry, expiryIsDerived, isCalibration,
  DEFAULT_CALIBRATION_INTERVAL_MONTHS,
} from '@/lib/domain/certificates'
import { calibrationRegisterEntry } from '@/lib/domain/calibrationPlan'
import type { Certificate } from '@/lib/domain/types'

function cert(over: Partial<Certificate>): Certificate {
  return {
    id: 'c1', subjectType: 'pressure_recorder', subjectId: 's1',
    certType: 'Chart recorder calibration', issueDate: '2025-04-23',
    expiryDate: null, ...over,
  } as Certificate
}

/** Crystal nVision 10KPSI, serial 506738. Calibrated 23 April 2025, no
 *  expiry printed anywhere on the page. */
const NVISION = cert({ issueDate: '2025-04-23', expiryDate: null })

/** PSS liquid filled gauge, serial 38000Z2IF29. Both dates printed. */
const PSS_GAUGE = cert({
  subjectType: 'torque_wrench', certType: 'Calibration',
  issueDate: '2025-09-30', expiryDate: '2026-09-30',
})

describe('an expiry the laboratory printed', () => {
  it('is used exactly as printed', () => {
    expect(effectiveExpiry(PSS_GAUGE)).toBe('2026-09-30')
  })

  it('is never shortened by the job interval', () => {
    // The certificate is the record. A six-month house rule does not
    // overrule a laboratory that certified twelve.
    expect(effectiveExpiry(PSS_GAUGE, 6)).toBe('2026-09-30')
  })

  it('is not reported as derived', () => {
    expect(expiryIsDerived(PSS_GAUGE)).toBe(false)
  })
})

describe('a calibration with no expiry printed', () => {
  it('closes at the job interval rather than never', () => {
    expect(effectiveExpiry(NVISION, 12)).toBe('2026-04-23')
  })

  it('honours a client who requires six months', () => {
    expect(effectiveExpiry(NVISION, 6)).toBe('2025-10-23')
  })

  it('defaults to twelve months', () => {
    expect(DEFAULT_CALIBRATION_INTERVAL_MONTHS).toBe(12)
    expect(effectiveExpiry(NVISION)).toBe('2026-04-23')
  })

  it('is reported as derived, so a screen can say so', () => {
    expect(expiryIsDerived(NVISION)).toBe(true)
  })

  it('no longer certifies a test ten years later', () => {
    // The defect, stated as a test.
    expect(certValidOn([NVISION], 'pressure_recorder', 's1', '2035-01-01')).toBeNull()
    expect(certValidOn([NVISION], 'pressure_recorder', 's1', '2025-11-19')).not.toBeNull()
  })

  it('stops covering work the day after the interval runs out', () => {
    expect(certValidOn([NVISION], 'pressure_recorder', 's1', '2026-04-23')).not.toBeNull()
    expect(certValidOn([NVISION], 'pressure_recorder', 's1', '2026-04-24')).toBeNull()
  })
})

describe('a person is not an instrument', () => {
  it('never has an expiry inferred for them', () => {
    // A welder's qualification runs on continuity rather than a date, and
    // a CWI card prints its own expiry. Inventing twelve months for
    // either would raise findings out of thin air.
    for (const subjectType of ['welder', 'cwi', 'ndt_technician'] as const) {
      const c = cert({ subjectType, expiryDate: null })
      expect(isCalibration(subjectType)).toBe(false)
      expect(effectiveExpiry(c, 12)).toBeNull()
      expect(certValidOn([c], subjectType, 's1', '2035-01-01')).not.toBeNull()
    }
  })

  it('treats both instrument subjects as calibrations', () => {
    expect(isCalibration('torque_wrench')).toBe(true)
    expect(isCalibration('pressure_recorder')).toBe(true)
  })
})

describe('a certificate nobody has read', () => {
  it('certifies nothing, interval or no interval', () => {
    // No issue date means the page is on file and unread. An interval
    // measured from nothing is not a window.
    const unread = cert({ issueDate: null, expiryDate: null })
    expect(effectiveExpiry(unread, 12)).toBeNull()
    expect(certValidOn([unread], 'pressure_recorder', 's1', '2025-11-19')).toBeNull()
  })
})

describe('adding months to a date', () => {
  it('lands on the same day of the month', () => {
    expect(addMonths('2025-04-23', 12)).toBe('2026-04-23')
    expect(addMonths('2025-09-30', 6)).toBe('2026-03-30')
  })

  it('clamps rather than rolling into the next month', () => {
    // 31 August plus six months is the end of February, not 3 March.
    expect(addMonths('2025-08-31', 6)).toBe('2026-02-28')
    expect(addMonths('2024-08-31', 6)).toBe('2025-02-28')
  })

  it('crosses a year end', () => {
    expect(addMonths('2025-10-01', 12)).toBe('2026-10-01')
    expect(addMonths('2025-12-15', 1)).toBe('2026-01-15')
  })
})

describe('the register entry a filed certificate produces', () => {
  const parsed = {
    dateCalibrated: '2025-05-02', calibrationDueDate: '2026-05-02',
    manufacturer: 'HYTORC',
  } as never

  it('carries the certificate\'s own dates', () => {
    const e = calibrationRegisterEntry('5155', parsed, 'calibration')!
    expect(e.subjectType).toBe('torque_wrench')
    expect(e.issueDate).toBe('2025-05-02')
    expect(e.expiryDate).toBe('2026-05-02')
    expect(e.issuingBody).toBe('HYTORC')
  })

  it('records an unread page with no dates at all', () => {
    // On file, unread — the state the schema was built for. An expiry
    // with no issue date is half a window and the database refuses it.
    const e = calibrationRegisterEntry('5155', parsed, 'unread')!
    expect(e.issueDate).toBeNull()
    expect(e.expiryDate).toBeNull()
  })

  it('produces nothing for a wrench the laboratory failed', () => {
    // A register entry asserts a credential. A failure is not one.
    expect(calibrationRegisterEntry('5155', parsed, 'failed')).toBeNull()
  })

  it('produces nothing for a superseded or reversed page', () => {
    expect(calibrationRegisterEntry('5155', parsed, 'superseded')).toBeNull()
    expect(calibrationRegisterEntry('5155', parsed, 'window_reversed')).toBeNull()
  })
})
