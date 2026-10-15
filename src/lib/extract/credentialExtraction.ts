/**
 * Reading a credential off the page.
 *
 * Roughly nine in ten credentials arrive as a scan — a photograph of a
 * wallet card, a flatbed scan of a certificate, a PDF with no text
 * layer at all. Of twenty-three uploaded on 2026-10-15, fourteen had no
 * text to parse. Every importer this application already has reads
 * structured text, so none of them could touch these, and the only way
 * in was to type each field by hand.
 *
 * ## What changed, and what did not
 *
 * The original §7/§8 design said a person reads the card and types what
 * it says, because guessing a date would be guessing about whether
 * somebody was qualified on the day they signed. That reasoning still
 * holds and nothing here overturns it.
 *
 * What this does is fill the form in. The page is shown beside it, a
 * person checks every field against the page, and what gets stored is
 * what they confirmed — not what the model said. The model's job is to
 * save the typing, not to make the judgement. Extraction writes
 * nothing to the register; it returns a draft.
 *
 * ## The one rule everything else hangs off
 *
 * Absent means null. Never inferred, never defaulted, never reasoned
 * from convention.
 *
 * This is not a general principle, it is a specific scar. An AWS CWI
 * certificate prints a certificate number and an expiration date and no
 * issue date whatsoever — all four on file are like this. AWS QC1
 * certification runs in three-year terms, so "expiry minus three years"
 * is a defensible, standard, entirely fabricated issue date, and a
 * model asked to fill in a form is under every pressure to produce one.
 * A fabricated issue date is worse than a blank, because a blank is
 * visibly unknown and a fabrication reads as evidence.
 */
// `zod/v4`, not `zod`. The SDK's `zodOutputFormat` is typed against the
// v4 implementation, which zod 3.25 ships under this subpath; a schema
// built with the classic import infers as `{}` through the helper and
// loses every field.
import { z } from 'zod/v4'
import type { CredentialInput, CredentialMethodLine } from '@/lib/domain/credentials'
import type { NdtMethod, QualificationCode } from '@/lib/domain/types'

/** The model this runs on. Named here rather than at the call site so
 *  there is one place to change it and one place to read it from. */
export const EXTRACTION_MODEL = 'claude-opus-5-5'

/**
 * One row of a certificate's method table.
 *
 * `methodAsPrinted` is kept alongside the normalised method because the
 * page rarely says "UT". It says "Ultrasonic Thickness Testing (A-Scan
 * or Digital)", or "Computed Radiography", and which of two RT lines a
 * report falls under depends on that wording. Normalising it away and
 * keeping only `RT` would lose the distinction American Piping draws
 * between film and computed radiography on different dates.
 */
export const ExtractedMethodLine = z.object({
  method: z.enum(['RT', 'PT', 'MT', 'UT']).nullable()
    .describe('The method normalised to one of RT, PT, MT, UT. Null if the '
      + 'line is a method this book does not record, or if it cannot be told.'),
  methodAsPrinted: z.string().nullable()
    .describe('The method exactly as the certificate names it, e.g. '
      + '"Computed Radiography", "Ultrasonic Thickness Testing - A-Scan".'),
  level: z.string().nullable()
    .describe('The level as printed: "II", "IIL", "Level II", "Restricted Level II".'),
  limitation: z.string().nullable()
    .describe('The limitation or technique column: "Yoke", "Gamma & X-Ray", '
      + '"Thickness Only", "Method A & C", "Unlimited". Null if there is none.'),
  certifiedDate: z.string().nullable()
    .describe('The certification date for THIS line as YYYY-MM-DD. Null if not printed.'),
  expiryDate: z.string().nullable()
    .describe('The expiration date for THIS line as YYYY-MM-DD. Null if not printed.'),
})

export const ExtractedCredential = z.object({
  documentKind: z.enum([
    'cwi_certificate', 'ndt_certification', 'welder_qualification',
    'vision_acuity', 'other',
  ]).describe('What this document is.'),

  personName: z.string().nullable()
    .describe('The full name of the person, exactly as printed.'),
  employer: z.string().nullable(),
  employeeNumber: z.string().nullable()
    .describe('An employee or EID number if the document carries one.'),
  certificateNumber: z.string().nullable()
    .describe('The certificate number if the document carries one.'),

  certType: z.string().nullable()
    .describe('What the certificate is, as it names itself: "AWS CWI", '
      + '"ASNT Level II", "WPQ".'),
  issuingBody: z.string().nullable()
    .describe('Who issued or certified: "American Welding Society", '
      + '"American Piping Inspection, Inc.", "PROtect LLC", or the '
      + 'certifying Level III if that is what the page names.'),

  issueDate: z.string().nullable()
    .describe('The date the certification began, as YYYY-MM-DD, ONLY if the '
      + 'document prints one. An AWS CWI certificate does not — it prints a '
      + 'certificate number and an expiration date and nothing else. Return '
      + 'null. Do NOT compute it from the expiry or from how long the '
      + 'certification normally runs.'),
  expiryDate: z.string().nullable()
    .describe('The expiration date as YYYY-MM-DD, if printed. For a '
      + 'certification with a per-method table, leave this null and put the '
      + 'dates on the method lines where they belong.'),

  methodLines: z.array(ExtractedMethodLine)
    .describe('One entry per row of the method table, in the order printed. '
      + 'Empty for a document that has no method table.'),

  qualificationCode: z.enum(['ASME_IX', 'API_1104']).nullable()
    .describe('For a welder qualification only: the code it is written '
      + 'against. Null for anything else.'),
  process: z.string().nullable()
    .describe('For a welder qualification only: the welding process, as '
      + 'printed, e.g. "GTAW", "GTAW/SMAW".'),

  visionAcuityExpiry: z.string().nullable()
    .describe('If this document states a vision acuity expiration, that '
      + 'date as YYYY-MM-DD. Many NDT certifications carry one.'),

  unreadable: z.array(z.string())
    .describe('Names of fields that are present on the page but could not be '
      + 'read with confidence — blurred, cut off, obscured by a stamp. A '
      + 'field that is simply absent from the document does NOT belong here.'),
  notes: z.string().nullable()
    .describe('Anything a person checking this should know: a restriction, '
      + 'two certificates on one page, a date that looks wrong, handwriting '
      + 'over print. Null if there is nothing worth saying.'),
})

export type ExtractedCredential = z.infer<typeof ExtractedCredential>
export type ExtractedMethodLine = z.infer<typeof ExtractedMethodLine>

export const EXTRACTION_PROMPT = `You are reading a personnel credential for an oil and gas
QA/QC turnover package. Transcribe what the document says. You are not
assessing anyone's qualifications.

Transcribe, do not interpret:

- Record ONLY what is printed on the page. If a field is not on the
  document, return null for it. Never infer, never default, never
  reason from what is customary.
- This matters most for issue dates. An AWS CWI certificate carries a
  certificate number and an expiration date and NO issue date. AWS
  certification runs in three-year terms, so you could compute a
  plausible start date. Do not. Return null.
- Dates on these documents are US format (M/D/YYYY). Return YYYY-MM-DD.
  If a date is genuinely ambiguous, put the field in "unreadable".
- A method table has one row per method, and each row carries its own
  certification date and its own expiration date. They are often days
  apart. Return one entry per row, with that row's own dates. Never
  merge rows, never apply one row's dates to another, even when several
  rows share a date.
- A certification may list the same method twice under different
  techniques — Radiography "Conventional - Film" and Radiography
  "Computed Radiography" — on different dates. These are two separate
  lines. Keep both.
- Transcribe names exactly, including middle initials and both parts of
  a compound surname.
- If the page is a vision acuity record rather than a certification,
  set documentKind to "vision_acuity" and fill what applies.

If you cannot read a value that is clearly present, name that field in
"unreadable" rather than guessing at it. A blank the person fills in is
cheap. A wrong date that reads as evidence is not.`

/** Whether the extraction is complete enough to be worth showing. */
export function extractionIsUsable(e: ExtractedCredential): boolean {
  return e.documentKind !== 'other' && !!e.personName
}

const ISO = /^\d{4}-\d{2}-\d{2}$/
/** A date the model returned, or null. Anything not an ISO date is
 *  dropped rather than passed on: a malformed date in a form field
 *  reads as a real one. */
function isoOrNull(v: string | null): string | null {
  return v && ISO.test(v.trim()) ? v.trim() : null
}

/** Which roster a document belongs to. `null` where the document is
 *  not a credential this form files — a vision acuity record is real
 *  and important and is not a CWI card. */
export function subjectTypeFor(
  kind: ExtractedCredential['documentKind'],
): CredentialInput['subjectType'] | null {
  switch (kind) {
    case 'cwi_certificate': return 'cwi'
    case 'ndt_certification': return 'ndt_technician'
    case 'welder_qualification': return 'welder'
    default: return null
  }
}

export interface CredentialDraft {
  subjectType: CredentialInput['subjectType'] | null
  fullName: string | null
  employer: string | null
  certType: string | null
  issuingBody: string | null
  issueDate: string | null
  expiryDate: string | null
  methodLines: CredentialMethodLine[]
  qualificationCode: QualificationCode | null
  process: string | null
  /** Shown to the person checking, never stored as fact. */
  unreadable: string[]
  notes: string | null
  certificateNumber: string | null
  visionAcuityExpiry: string | null
}

/**
 * The form this extraction fills.
 *
 * Pure, and the reason most of this file can be tested without an API
 * key: everything that decides what lands in a field happens here, and
 * the network call only produces the input.
 */
export function extractionToDraft(e: ExtractedCredential): CredentialDraft {
  const subjectType = subjectTypeFor(e.documentKind)

  const methodLines: CredentialMethodLine[] = subjectType === 'ndt_technician'
    ? e.methodLines
        // A line whose method is not one of the four this book records
        // is dropped from the form rather than offered as a blank row:
        // it is real, and nothing here can file it, and `notes` is
        // where the person is told so.
        .filter((l): l is ExtractedMethodLine & { method: NdtMethod } => !!l.method)
        .map((l) => ({
          methods: [l.method],
          issueDate: isoOrNull(l.certifiedDate),
          expiryDate: isoOrNull(l.expiryDate),
          // The printed wording beats the normalised one: "Computed
          // Radiography" is what tells two RT lines apart, and the
          // limitation column is what tells a yoke from a prod.
          limitation: [l.methodAsPrinted, l.limitation]
            .map((s) => (s ?? '').trim())
            .filter((s) => s && !/^(unlimited|n\/a|none)$/i.test(s))
            .join(' — ') || null,
        }))
    : []

  const dropped = subjectType === 'ndt_technician'
    ? e.methodLines.filter((l) => !l.method)
    : []
  const droppedNote = dropped.length > 0
    ? `Not filed, because this book records only RT, PT, MT and UT: `
      + dropped.map((l) => l.methodAsPrinted ?? 'an unnamed method').join(', ') + '.'
    : null

  return {
    subjectType,
    fullName: e.personName?.trim() || null,
    employer: e.employer?.trim() || null,
    certType: e.certType?.trim() || null,
    issuingBody: e.issuingBody?.trim() || null,
    // A certification with a method table states its dates per line.
    // Carrying a top-level date alongside them would put a date in the
    // form that no line agreed to.
    issueDate: methodLines.length > 0 ? null : isoOrNull(e.issueDate),
    expiryDate: methodLines.length > 0 ? null : isoOrNull(e.expiryDate),
    methodLines,
    qualificationCode: subjectType === 'welder' ? e.qualificationCode : null,
    process: subjectType === 'welder' ? e.process?.trim() || null : null,
    unreadable: e.unreadable.filter((u) => u.trim()),
    notes: [e.notes?.trim() || null, droppedNote].filter(Boolean).join(' ') || null,
    certificateNumber: e.certificateNumber?.trim() || null,
    visionAcuityExpiry: isoOrNull(e.visionAcuityExpiry),
  }
}

/**
 * How the page is sent.
 *
 * A PDF goes as a document block whatever is inside it — the API reads
 * a scanned page the same way it reads a text layer, which is the whole
 * reason this approach works here and an OCR engine was not needed. A
 * photograph goes as an image block.
 */
export function contentBlockFor(
  bytes: Uint8Array, filename: string,
): { type: 'document' | 'image'; mediaType: string; data: string } {
  const ext = filename.toLowerCase().split('.').pop() ?? ''
  const base64 = Buffer.from(bytes).toString('base64')
  if (ext === 'pdf') {
    return { type: 'document', mediaType: 'application/pdf', data: base64 }
  }
  const mediaType = ext === 'png' ? 'image/png'
    : ext === 'webp' ? 'image/webp'
    : ext === 'gif' ? 'image/gif'
    : 'image/jpeg'
  return { type: 'image', mediaType, data: base64 }
}
