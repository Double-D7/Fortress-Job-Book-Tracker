/**
 * Reading a filed credential off the form.
 *
 * Two routes accept this upload and they used to parse it twice. That
 * is how the methods field reached one route and not the other, so the
 * parser is one function now and this is what holds it to its shape.
 * Nothing here decides whether an input is acceptable — that is
 * `validateCredential`, and these tests check what reaches it.
 */
import { describe, expect, it } from 'vitest'
import { credentialFromForm, credentialSubjectFrom, qualificationCodeFrom } from '@/lib/http/credentialForm'
import { validateCredential } from '@/lib/domain/credentials'

function form(entries: Record<string, string | string[]>): FormData {
  const f = new FormData()
  for (const [k, v] of Object.entries(entries)) {
    if (Array.isArray(v)) for (const x of v) f.append(k, x)
    else f.set(k, v)
  }
  return f
}

const welder = {
  subjectType: 'welder', fullName: 'Marcus Teale', certType: 'WPQ',
  issueDate: '2025-03-04', qualificationCode: 'ASME_IX', process: 'GTAW/SMAW',
}

describe('which roster the form names', () => {
  it('reads all three', () => {
    expect(credentialSubjectFrom('welder')).toBe('welder')
    expect(credentialSubjectFrom('cwi')).toBe('cwi')
    expect(credentialSubjectFrom('ndt_technician')).toBe('ndt_technician')
  })

  it('does not silently turn something unknown into a CWI', () => {
    // A field nobody recognises must not quietly become the roster with
    // the loosest rules; it becomes the one the form opens on, and the
    // rest of the input still has to pass validation.
    expect(credentialSubjectFrom('welder ')).toBe('ndt_technician')
    expect(credentialSubjectFrom('')).toBe('ndt_technician')
  })
})

describe('which code the form names', () => {
  it('reads the two it models', () => {
    expect(qualificationCodeFrom('ASME_IX')).toBe('ASME_IX')
    expect(qualificationCodeFrom('API_1104')).toBe('API_1104')
  })

  it('refuses to pick a code on the welder\'s behalf', () => {
    // Null reaches validation, which says so. Defaulting to ASME IX
    // would record a qualification against a code nobody tested to.
    expect(qualificationCodeFrom('AWS D1.1')).toBeNull()
    expect(qualificationCodeFrom('')).toBeNull()
  })
})

describe('what the parser hands the domain', () => {
  it('carries a welder WPQ through whole', () => {
    const input = credentialFromForm(form(welder))
    expect(input).toMatchObject({
      subjectType: 'welder', subjectId: null, fullName: 'Marcus Teale',
      certType: 'WPQ', issueDate: '2025-03-04',
      qualificationCode: 'ASME_IX', process: 'GTAW/SMAW',
    })
    expect(validateCredential(input)).toEqual([])
  })

  it('carries an NDT card with its methods', () => {
    const input = credentialFromForm(form({
      subjectType: 'ndt_technician', fullName: 'Dale Whitcomb',
      certType: 'ASNT Level II', issueDate: '2025-01-15',
      ndtMethods: ['RT', 'UT'],
    }))
    expect(input.ndtMethods).toEqual(['RT', 'UT'])
    expect(validateCredential(input)).toEqual([])
  })

  it('drops a method it does not model rather than filing it', () => {
    const input = credentialFromForm(form({
      subjectType: 'ndt_technician', fullName: 'X', certType: 'ASNT Level II',
      issueDate: '2025-01-15', ndtMethods: ['RT', 'VT'],
    }))
    expect(input.ndtMethods).toEqual(['RT'])
  })

  it('does not let a stale field from another roster through', () => {
    // The browser keeps state. A form switched from NDT to welder must
    // not file a WPQ carrying radiographic methods, and the other way
    // round must not give an inspector a welding process.
    const asWelder = credentialFromForm(form({ ...welder, ndtMethods: ['RT'] }))
    expect(asWelder.ndtMethods).toBeNull()
    expect(validateCredential(asWelder)).toEqual([])

    const asCard = credentialFromForm(form({
      subjectType: 'cwi', fullName: 'C. Ruiz', certType: 'AWS CWI',
      issueDate: '2025-01-15', qualificationCode: 'ASME_IX', process: 'GTAW',
    }))
    expect(asCard.qualificationCode).toBeNull()
    expect(asCard.process).toBeNull()
    expect(validateCredential(asCard)).toEqual([])
  })

  it('turns blanks into null rather than empty strings', () => {
    const input = credentialFromForm(form({
      subjectType: 'cwi', fullName: 'C. Ruiz', certType: 'AWS CWI',
      issueDate: '2025-01-15', subjectId: '  ', issuingBody: '', expiryDate: '',
    }))
    expect(input.subjectId).toBeNull()
    expect(input.issuingBody).toBeNull()
    expect(input.expiryDate).toBeNull()
  })

  it('trims what somebody pasted', () => {
    const input = credentialFromForm(form({ ...welder, process: '  GTAW  ' }))
    expect(input.process).toBe('GTAW')
  })
})
