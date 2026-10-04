/**
 * Certified for what, not just certified.
 *
 * ASNT SNT-TC-1A certifies per method. A technician holds PT Level II
 * and RT Level II as separate qualifications and plenty hold one
 * without the other, so "has a current card" is not the question. The
 * question is whether the card covers the method on the report.
 *
 * The application asked the weaker question for its whole life: a
 * technician certified for PT alone passed an RT report, and every
 * gate criterion downstream agreed. Nothing here existed to catch it,
 * which is why it survived. These tests are the reason it cannot come
 * back.
 */
import { describe, expect, it } from 'vitest'
import { certValidOn, ndtMethodCoverage } from '@/lib/domain/certificates'
import { evaluateFlags, ruleNdeTechnicianNotCertified } from '@/lib/domain/flags'
import { buildDp452Bundle } from '@/lib/data/seed/dp452'
import type { Certificate, JobBookBundle, NdtMethod } from '@/lib/domain/types'

/** A technician card covering 2025, for the methods given. */
function card(over: Partial<Certificate> = {}): Certificate {
  return {
    id: 'c1',
    subjectType: 'ndt_technician',
    subjectId: 't1',
    certType: 'ASNT Level II',
    issueDate: '2025-01-01',
    expiryDate: '2025-12-31',
    ndtMethods: ['RT'],
    ...over,
  } as Certificate
}

const ON_DATE = '2025-06-01'

describe('a card covers a method only when it says so', () => {
  it('passes the method it names', () => {
    expect(certValidOn([card({ ndtMethods: ['RT'] })], 'ndt_technician', 't1', ON_DATE,
      { method: 'RT' })).not.toBeNull()
  })

  it('refuses a method it does not name, however current it is', () => {
    // The bug, stated plainly. A PT card does not qualify anybody to
    // interpret an RT film, and the card being in date is irrelevant.
    expect(certValidOn([card({ ndtMethods: ['PT'] })], 'ndt_technician', 't1', ON_DATE,
      { method: 'RT' })).toBeNull()
  })

  it('passes when the card carries several methods and one matches', () => {
    expect(certValidOn([card({ ndtMethods: ['PT', 'MT', 'RT'] })], 'ndt_technician', 't1',
      ON_DATE, { method: 'RT' })).not.toBeNull()
  })

  it('refuses an unrecorded method list rather than treating it as all', () => {
    // Null is "nobody has read the card", not "every method". Treating
    // it as every method is how an unread page certifies everything,
    // which is the same mistake a null issue date would make.
    expect(certValidOn([card({ ndtMethods: null })], 'ndt_technician', 't1', ON_DATE,
      { method: 'RT' })).toBeNull()
    expect(certValidOn([card({ ndtMethods: [] })], 'ndt_technician', 't1', ON_DATE,
      { method: 'RT' })).toBeNull()
  })

  it('still answers the method-free question for subjects that have no method', () => {
    // A CWI card and a wrench calibration have no method. Asking
    // without one must behave exactly as it always did.
    expect(certValidOn([card({ ndtMethods: null })], 'ndt_technician', 't1', ON_DATE))
      .not.toBeNull()
  })

  it('checks the date as well as the method', () => {
    expect(certValidOn([card({ ndtMethods: ['RT'] })], 'ndt_technician', 't1', '2026-06-01',
      { method: 'RT' })).toBeNull()
  })

  it('refuses an unread card even when the method matches', () => {
    expect(certValidOn([card({ issueDate: null, ndtMethods: ['RT'] })], 'ndt_technician', 't1',
      ON_DATE, { method: 'RT' })).toBeNull()
  })
})

describe('telling somebody which of the three things is wrong', () => {
  it('reports no certificate when nothing covers the date', () => {
    expect(ndtMethodCoverage([], 't1', ON_DATE, 'RT').state).toBe('no_cert')
    expect(ndtMethodCoverage([card({ expiryDate: '2025-02-01' })], 't1', '2025-06-01', 'RT').state)
      .toBe('no_cert')
  })

  it('reports unrecorded methods separately from a genuine mismatch', () => {
    // These are different problems with different remedies: read the
    // card you have, versus stop this person signing this method.
    expect(ndtMethodCoverage([card({ ndtMethods: null })], 't1', ON_DATE, 'RT').state)
      .toBe('methods_unrecorded')
    expect(ndtMethodCoverage([card({ ndtMethods: ['PT'] })], 't1', ON_DATE, 'RT').state)
      .toBe('method_not_covered')
  })

  it('says what the card does cover, so the gap is legible', () => {
    const c = ndtMethodCoverage([card({ ndtMethods: ['PT', 'MT'] })], 't1', ON_DATE, 'RT')
    expect(c.state === 'method_not_covered' && c.covers).toEqual(['MT', 'PT'])
  })

  it('prefers a matching card over an unrecorded one', () => {
    const c = ndtMethodCoverage(
      [card({ id: 'unread', ndtMethods: null }), card({ id: 'good', ndtMethods: ['RT'] })],
      't1', ON_DATE, 'RT',
    )
    expect(c.state).toBe('covered')
    expect(c.state === 'covered' && c.certificate.id).toBe('good')
  })

  it('prefers unrecorded over mismatch when both are on file', () => {
    // An unread card might well cover RT. Reporting a mismatch here
    // would accuse somebody on the strength of a blank field.
    const c = ndtMethodCoverage(
      [card({ id: 'pt', ndtMethods: ['PT'] }), card({ id: 'unread', ndtMethods: null })],
      't1', ON_DATE, 'RT',
    )
    expect(c.state).toBe('methods_unrecorded')
  })

  it('pools methods across several cards covering the same date', () => {
    // A technician with two cards is certified for the union, not for
    // whichever row the query returned first.
    expect(certValidOn(
      [card({ id: 'a', ndtMethods: ['PT'] }), card({ id: 'b', ndtMethods: ['RT'] })],
      'ndt_technician', 't1', ON_DATE, { method: 'RT' },
    )).not.toBeNull()
  })

  it('does not read one technician\'s card for another', () => {
    expect(ndtMethodCoverage([card({ subjectId: 't2', ndtMethods: ['RT'] })], 't1', ON_DATE, 'RT')
      .state).toBe('no_cert')
  })
})

describe('the finding a person actually reads', () => {
  function bundle(method: NdtMethod, certs: Certificate[]): JobBookBundle {
    const b = buildDp452Bundle()
    return {
      ...b,
      certificates: certs,
      ndtTechnicians: [{
        id: 't1', fullName: 'Brendan LeCompte', initials: 'BL', employer: null,
        classification: null, active: true,
      }] as JobBookBundle['ndtTechnicians'],
      ndeReports: [{
        ...b.ndeReports[0]!, id: 'r1', reportNumber: '111925BL-RT',
        isSuperseded: false, technicianId: 't1', reportDate: ON_DATE, method,
      }],
    }
  }

  it('is critical, and names the method, when the card does not cover it', () => {
    const f = ruleNdeTechnicianNotCertified(bundle('RT', [card({ ndtMethods: ['PT'] })]))
    expect(f).toHaveLength(1)
    expect(f[0]!.ruleId).toBe('nde.technician_not_certified_for_method')
    expect(f[0]!.severity).toBe('critical')
    expect(f[0]!.sectionNumber).toBe('8')
    expect(f[0]!.title).toContain('RT')
    expect(f[0]!.detail).toContain('PT')
  })

  it('is only a warning when the methods were never recorded', () => {
    // We do not know anything is wrong, only that we cannot show it is
    // right. Calling that critical would cry wolf on our own paperwork.
    const f = ruleNdeTechnicianNotCertified(bundle('RT', [card({ ndtMethods: null })]))
    expect(f).toHaveLength(1)
    expect(f[0]!.ruleId).toBe('nde.technician_cert_methods_unrecorded')
    expect(f[0]!.severity).toBe('warning')
  })

  it('keeps the original finding when no card covers the date at all', () => {
    const f = ruleNdeTechnicianNotCertified(bundle('RT', []))
    expect(f).toHaveLength(1)
    expect(f[0]!.ruleId).toBe('nde.technician_not_certified_on_report_date')
    expect(f[0]!.severity).toBe('critical')
  })

  it('stays quiet when the card covers the method', () => {
    expect(ruleNdeTechnicianNotCertified(bundle('RT', [card({ ndtMethods: ['RT'] })]))).toEqual([])
  })

  it('ignores a superseded report', () => {
    const b = bundle('RT', [card({ ndtMethods: ['PT'] })])
    const superseded = { ...b, ndeReports: [{ ...b.ndeReports[0]!, isSuperseded: true }] }
    expect(ruleNdeTechnicianNotCertified(superseded)).toEqual([])
  })

  it('runs as part of the book, not just on its own', () => {
    // A rule nothing calls is a rule that does not run.
    const findings = evaluateFlags(bundle('RT', [card({ ndtMethods: ['PT'] })]))
    expect(findings.some((f) => f.ruleId === 'nde.technician_not_certified_for_method')).toBe(true)
  })
})
