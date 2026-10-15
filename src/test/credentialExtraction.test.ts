/**
 * Turning a read page into a filled form.
 *
 * The fixtures are transcriptions of certificates actually uploaded on
 * 2026-10-15, not invented shapes. That matters: every assumption this
 * code had to unlearn — one expiry per person, an issue date on every
 * card — survived review and a thousand tests, and only fell over when
 * real paper arrived.
 *
 * The network call is not exercised here and does not need to be.
 * Everything that decides what lands in a form field is pure.
 */
import { describe, expect, it } from 'vitest'
import {
  EXTRACTION_PROMPT, contentBlockFor, extractionIsUsable, extractionToDraft,
  subjectTypeFor, type ExtractedCredential,
} from '@/lib/extract/credentialExtraction'
import { validateCredentialLines } from '@/lib/domain/credentials'

function extracted(over: Partial<ExtractedCredential> = {}): ExtractedCredential {
  return {
    documentKind: 'ndt_certification',
    personName: 'Edgar Mercado',
    employer: null, employeeNumber: null, certificateNumber: null,
    certType: 'ASNT Level II', issuingBody: 'PROtect LLC',
    issueDate: null, expiryDate: null,
    methodLines: [],
    qualificationCode: null, process: null,
    visionAcuityExpiry: null,
    unreadable: [], notes: null,
    ...over,
  }
}

/** Edgar Mercado's certification as PROtect printed it. */
const MERCADO = extracted({
  methodLines: [
    { method: 'PT', methodAsPrinted: 'Liquid Penetrant Testing', level: 'Level II',
      limitation: null, certifiedDate: '2025-10-14', expiryDate: '2028-10-08' },
    { method: 'UT', methodAsPrinted: 'Ultrasonic Thickness Testing (A-Scan or Digital)',
      level: 'Level IIL', limitation: null,
      certifiedDate: '2025-10-14', expiryDate: '2028-10-08' },
    { method: 'MT', methodAsPrinted: 'Magnetic Particle Testing', level: 'Level II',
      limitation: null, certifiedDate: '2025-10-14', expiryDate: '2028-10-09' },
    { method: 'RT', methodAsPrinted: 'Radiographic Testing', level: 'Level II',
      limitation: null, certifiedDate: '2025-10-14', expiryDate: '2028-10-09' },
  ],
})

/** Joshua Cole's AWS card: a number, an expiry, and no issue date. */
const COLE = extracted({
  documentKind: 'cwi_certificate',
  personName: 'Joshua G. Cole',
  certType: 'AWS CWI', issuingBody: 'American Welding Society',
  certificateNumber: '19032071',
  issueDate: null, expiryDate: '2028-03-01',
})

describe('which roster a document belongs to', () => {
  it('maps the three the form files', () => {
    expect(subjectTypeFor('cwi_certificate')).toBe('cwi')
    expect(subjectTypeFor('ndt_certification')).toBe('ndt_technician')
    expect(subjectTypeFor('welder_qualification')).toBe('welder')
  })

  it('refuses to file a vision acuity record as a certification', () => {
    // It is a real document and an important one, and it is not a CWI
    // card. Guessing a roster for it would put an eye exam in section 7.
    expect(subjectTypeFor('vision_acuity')).toBeNull()
    expect(subjectTypeFor('other')).toBeNull()
  })
})

describe('a certification with a method table', () => {
  it('becomes one form line per printed row', () => {
    const draft = extractionToDraft(MERCADO)
    expect(draft.subjectType).toBe('ndt_technician')
    expect(draft.methodLines).toHaveLength(4)
    expect(draft.methodLines.map((l) => l.methods)).toEqual([['PT'], ['UT'], ['MT'], ['RT']])
  })

  it('keeps each row on its own dates', () => {
    const draft = extractionToDraft(MERCADO)
    expect(draft.methodLines.map((l) => l.expiryDate))
      .toEqual(['2028-10-08', '2028-10-08', '2028-10-09', '2028-10-09'])
  })

  it('leaves the top-level dates empty, so no date appears that no line agreed to', () => {
    const draft = extractionToDraft(extracted({
      ...MERCADO, issueDate: '2025-10-14', expiryDate: '2028-10-09',
    }))
    expect(draft.issueDate).toBeNull()
    expect(draft.expiryDate).toBeNull()
  })

  it('carries the printed wording, which is what tells two RT lines apart', () => {
    // American Piping issues Radiography twice — conventional film and
    // computed radiography — on different dates. Normalising both to
    // "RT" and dropping the wording would lose which is which.
    const draft = extractionToDraft(extracted({
      methodLines: [
        { method: 'RT', methodAsPrinted: 'Radiography', level: 'II',
          limitation: 'Conventional - Film, Gamma',
          certifiedDate: '2025-04-11', expiryDate: '2028-04-11' },
        { method: 'RT', methodAsPrinted: 'Radiography', level: 'II',
          limitation: 'Computed Radiography',
          certifiedDate: '2025-04-14', expiryDate: '2028-04-14' },
      ],
    }))
    expect(draft.methodLines[0]!.limitation).toContain('Conventional')
    expect(draft.methodLines[1]!.limitation).toContain('Computed')
    expect(draft.methodLines[0]!.limitation).not.toBe(draft.methodLines[1]!.limitation)
  })

  it('drops "Unlimited" rather than recording it as a limitation', () => {
    const draft = extractionToDraft(extracted({
      methodLines: [{
        method: 'MT', methodAsPrinted: 'Magnetic Particle', level: 'II',
        limitation: 'Unlimited', certifiedDate: '2025-04-11', expiryDate: '2028-04-11',
      }],
    }))
    expect(draft.methodLines[0]!.limitation).toBe('Magnetic Particle')
  })

  it('says so when a line names a method this book does not record', () => {
    // Visual testing is a real ASNT method and this book records four.
    // Dropping it silently would leave a technician looking less
    // qualified than they are, with nothing to say why.
    const draft = extractionToDraft(extracted({
      methodLines: [
        MERCADO.methodLines[0]!,
        { method: null, methodAsPrinted: 'Visual Testing', level: 'II',
          limitation: null, certifiedDate: '2025-10-14', expiryDate: '2028-10-08' },
      ],
    }))
    expect(draft.methodLines).toHaveLength(1)
    expect(draft.notes).toContain('Visual Testing')
  })

  it('produces a draft the filing rules accept', () => {
    // The point of the whole exercise: what comes back is fillable, not
    // merely plausible.
    const draft = extractionToDraft(MERCADO)
    expect(validateCredentialLines(
      {
        subjectType: 'ndt_technician', subjectId: null,
        fullName: draft.fullName, certType: draft.certType!,
        issuingBody: draft.issuingBody, issueDate: null, expiryDate: null,
        ndtMethods: [],
      },
      draft.methodLines,
    )).toEqual([])
  })
})

describe('a card that prints no issue date', () => {
  it('comes back with a null issue date, not a computed one', () => {
    // The fabrication this design exists to prevent. AWS QC1 runs in
    // three-year terms, so 2025-03-01 is a defensible, standard and
    // entirely invented answer — and unlike a blank it reads as
    // evidence.
    const draft = extractionToDraft(COLE)
    expect(draft.issueDate).toBeNull()
    expect(draft.expiryDate).toBe('2028-03-01')
  })

  it('tells the prompt not to compute one', () => {
    // Asserted on the prompt itself, because this instruction is the
    // only thing standing between a blank field and a plausible lie,
    // and a later edit could quietly remove it.
    expect(EXTRACTION_PROMPT).toMatch(/Do not\./)
    expect(EXTRACTION_PROMPT).toMatch(/three-year terms/)
    expect(EXTRACTION_PROMPT).toMatch(/[Nn]ever infer/)
  })

  it('keeps the certificate number for the person checking', () => {
    expect(extractionToDraft(COLE).certificateNumber).toBe('19032071')
  })

  it('files as one credential, with no method lines', () => {
    const draft = extractionToDraft(COLE)
    expect(draft.subjectType).toBe('cwi')
    expect(draft.methodLines).toEqual([])
  })
})

describe('what the form refuses to believe', () => {
  it('drops a date that is not a date', () => {
    // A model that returns "3/25/2025" or "unknown" must not put that
    // string into a date field, where it reads as read.
    const draft = extractionToDraft(extracted({
      documentKind: 'cwi_certificate',
      issueDate: '3/25/2025', expiryDate: 'unknown',
    }))
    expect(draft.issueDate).toBeNull()
    expect(draft.expiryDate).toBeNull()
  })

  it('drops a malformed date on a method line too', () => {
    const draft = extractionToDraft(extracted({
      methodLines: [{
        method: 'RT', methodAsPrinted: 'Radiography', level: 'II', limitation: null,
        certifiedDate: 'March 2025', expiryDate: '2028-10-09',
      }],
    }))
    expect(draft.methodLines[0]!.issueDate).toBeNull()
    expect(draft.methodLines[0]!.expiryDate).toBe('2028-10-09')
  })

  it('passes through what could not be read, rather than hiding it', () => {
    const draft = extractionToDraft(extracted({ unreadable: ['expiryDate', 'personName'] }))
    expect(draft.unreadable).toEqual(['expiryDate', 'personName'])
  })

  it('is unusable without a name', () => {
    expect(extractionIsUsable(extracted({ personName: null }))).toBe(false)
    expect(extractionIsUsable(extracted({ documentKind: 'other' }))).toBe(false)
    expect(extractionIsUsable(MERCADO)).toBe(true)
  })
})

describe('how the page is sent', () => {
  const bytes = new TextEncoder().encode('hello')

  it('sends a PDF as a document, whatever is inside it', () => {
    // The reason no OCR engine is needed: a scanned PDF and one with a
    // text layer go the same way.
    expect(contentBlockFor(bytes, 'cole.pdf')).toMatchObject({
      type: 'document', mediaType: 'application/pdf',
    })
  })

  it('sends a photograph as an image, by its real type', () => {
    expect(contentBlockFor(bytes, 'card.JPG').mediaType).toBe('image/jpeg')
    expect(contentBlockFor(bytes, 'card.png').mediaType).toBe('image/png')
    expect(contentBlockFor(bytes, 'scan.webp').mediaType).toBe('image/webp')
  })

  it('base64-encodes without newlines', () => {
    // A base64 string with line breaks in it is rejected by the API.
    expect(contentBlockFor(bytes, 'x.pdf').data).not.toMatch(/\s/)
  })
})
