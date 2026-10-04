/**
 * Filing a person's credential.
 *
 * Sections 7 and 8 ask for one thing: evidence that the people who
 * inspected this pipe were qualified to. Every other section had a way
 * to get records in and these two did not, so the credentials existed
 * only as whatever somebody remembered to put in a folder.
 *
 * ## Why this is typed in rather than parsed
 *
 * Every other importer reads the original. A CWI card and an ASNT card
 * are usually a photograph of a wallet card, often at an angle, and the
 * dates that matter are printed small. An importer that guessed would
 * be guessing about whether a person was qualified on the day they
 * signed, which is the one question these sections exist to answer. So
 * a person reads the card and types what it says, and the card is filed
 * beside what they typed so the next person can check them.
 *
 * ## Why the validation lives here
 *
 * Two providers implement this and they have drifted before. Keeping
 * the rules in one pure function means the seed and the database agree
 * by construction rather than by review.
 */
import type { CertSubjectType, IsoDate, NdtMethod } from './types'

export const NDT_METHODS: readonly NdtMethod[] = ['RT', 'PT', 'MT', 'UT']

/** Which roster a credential belongs to, and where it files. */
export type CredentialSubject = Extract<CertSubjectType, 'cwi' | 'ndt_technician'>

export interface CredentialInput {
  subjectType: CredentialSubject
  /** An existing roster member, or null when adding one. */
  subjectId: string | null
  /** Required when `subjectId` is null: the person being added. */
  fullName?: string | null
  initials?: string | null
  employer?: string | null
  certType: string
  issuingBody?: string | null
  issueDate: IsoDate
  expiryDate?: IsoDate | null
  /** NDT only. Empty is rejected rather than stored, because an empty
   *  list reads as "certifies nothing" and nobody means that. */
  ndtMethods?: NdtMethod[] | null
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
/** Long enough for "Non-Destructive Testing Level II (SNT-TC-1A)". */
const MAX_TEXT = 120

function clean(v: string | null | undefined): string {
  return (v ?? '').trim()
}

export interface CredentialProblem { field: string; message: string }

/**
 * What is wrong with this credential, or nothing.
 *
 * Returns every problem rather than the first, so somebody filling a
 * form is told once what to fix instead of discovering it a field at a
 * time.
 */
export function validateCredential(input: CredentialInput): CredentialProblem[] {
  const out: CredentialProblem[] = []

  if (input.subjectType !== 'cwi' && input.subjectType !== 'ndt_technician') {
    out.push({ field: 'subjectType', message: 'Choose whether this is a CWI or an NDT technician.' })
  }

  if (!input.subjectId) {
    const name = clean(input.fullName)
    if (!name) {
      out.push({ field: 'fullName', message: 'Name the person this credential belongs to.' })
    } else if (name.length > MAX_TEXT) {
      out.push({ field: 'fullName', message: `Keep the name under ${MAX_TEXT} characters.` })
    }
  }

  const certType = clean(input.certType)
  if (!certType) {
    out.push({ field: 'certType', message: 'Say what the certificate is, as the card prints it.' })
  } else if (certType.length > MAX_TEXT) {
    out.push({ field: 'certType', message: `Keep the certificate type under ${MAX_TEXT} characters.` })
  }

  // The domain refuses to certify anything against an unread card, so a
  // credential with no issue date would file and then certify nothing.
  // Better to refuse it here, where the person can read the date off the
  // card in front of them.
  if (!ISO_DATE.test(clean(input.issueDate))) {
    out.push({ field: 'issueDate', message: 'The issue date is on the card and is required.' })
  }

  const expiry = clean(input.expiryDate)
  if (expiry && !ISO_DATE.test(expiry)) {
    out.push({ field: 'expiryDate', message: 'Write the expiry as YYYY-MM-DD, or leave it blank.' })
  }
  if (!out.some((p) => p.field === 'issueDate' || p.field === 'expiryDate')
      && expiry && expiry < clean(input.issueDate)) {
    out.push({ field: 'expiryDate', message: 'The card cannot expire before it was issued.' })
  }

  if (input.subjectType === 'ndt_technician') {
    const methods = input.ndtMethods ?? []
    if (methods.length === 0) {
      // Not optional. Leaving it blank is what the old code effectively
      // did, and it is why a PT-certified technician passed an RT report.
      out.push({
        field: 'ndtMethods',
        message: 'Tick every method this card certifies. ASNT certifies per method, '
          + 'so a card with none recorded certifies no work.',
      })
    }
    for (const m of methods) {
      if (!NDT_METHODS.includes(m)) {
        out.push({ field: 'ndtMethods', message: `${m} is not a method this book records.` })
      }
    }
  } else if ((input.ndtMethods?.length ?? 0) > 0) {
    out.push({
      field: 'ndtMethods',
      message: 'Methods belong to an NDT card. A CWI certification does not carry them.',
    })
  }

  return out
}

/**
 * What the stored file is called.
 *
 * Named for the person and the card rather than kept as whatever the
 * phone called it, so the SharePoint copy is legible to somebody who
 * never opens this application. The extension is preserved because it
 * is what decides whether a browser previews the page or downloads a
 * blob.
 */
export function credentialFilename(
  entry: { certType: string; issueDate: string }, originalFilename: string,
): string {
  const ext = originalFilename.toLowerCase().split('.').pop() ?? 'pdf'
  const safe = (s: string) => s.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '')
  return `${safe(entry.certType)}_${entry.issueDate}.${safe(ext) || 'pdf'}`
}

/**
 * Narrowing the library list.
 *
 * One function so the two providers cannot disagree about what a search
 * matches, which is the drift this codebase keeps paying for. Matches
 * the person, the certificate type, the issuer and the methods, because
 * "who is certified for RT" is a question somebody will ask.
 */
export function filterPersonnelLibrary<
  T extends {
    personName: string; certType: string
    issuingBody?: string | null; ndtMethods?: readonly string[] | null
  },
>(entries: T[], search?: string): T[] {
  const q = (search ?? '').trim().toLowerCase()
  if (!q) return entries
  return entries.filter((e) =>
    e.personName.toLowerCase().includes(q)
    || e.certType.toLowerCase().includes(q)
    || (e.issuingBody ?? '').toLowerCase().includes(q)
    || (e.ndtMethods ?? []).some((m) => m.toLowerCase() === q))
}

/** Where this credential files, by the book's own section numbering. */
export function credentialSection(subjectType: CredentialSubject): string {
  return subjectType === 'cwi' ? '7' : '8'
}

/** The default certificate type for each roster, as the cards print it.
 *  A starting point for the form, not a constraint. */
export function defaultCertType(subjectType: CredentialSubject): string {
  return subjectType === 'cwi' ? 'AWS CWI' : 'ASNT Level II'
}

/**
 * The certificate row a valid input becomes.
 *
 * Normalised here rather than at each provider: trimmed, methods
 * dropped for a CWI, and an empty method list stored as null so the
 * database never holds `{}` meaning "unrecorded" alongside null meaning
 * the same thing.
 */
export function credentialToCertificate(
  input: CredentialInput,
  subjectId: string,
): {
  subjectType: CredentialSubject
  subjectId: string
  certType: string
  issuingBody: string | null
  issueDate: IsoDate
  expiryDate: IsoDate | null
  ndtMethods: NdtMethod[] | null
} {
  const methods = input.subjectType === 'ndt_technician'
    ? [...new Set(input.ndtMethods ?? [])].sort()
    : []
  return {
    subjectType: input.subjectType,
    subjectId,
    certType: clean(input.certType),
    issuingBody: clean(input.issuingBody) || null,
    issueDate: clean(input.issueDate),
    expiryDate: clean(input.expiryDate) || null,
    ndtMethods: methods.length > 0 ? methods : null,
  }
}
