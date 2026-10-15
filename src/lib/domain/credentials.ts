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
import type { CertSubjectType, IsoDate, NdtMethod, QualificationCode } from './types'

export const NDT_METHODS: readonly NdtMethod[] = ['RT', 'PT', 'MT', 'UT']

/**
 * Which roster a credential belongs to, and where it files.
 *
 * A welder is here too, but their credential is not a `Certificate`: it
 * is a `WelderQualification`, because a welder already has a register
 * and that is it. What the three share is the act of filing — a person,
 * a page, and the dates read off it — which is why one form and one set
 * of rules covers all three.
 */
export type CredentialSubject =
  Extract<CertSubjectType, 'cwi' | 'ndt_technician' | 'welder'>

/** The codes a WPQ is written against. */
export const QUALIFICATION_CODES: readonly QualificationCode[] = ['ASME_IX', 'API_1104']

/** How each code reads on screen. */
export const QUALIFICATION_CODE_LABEL: Record<QualificationCode, string> = {
  ASME_IX: 'ASME IX',
  API_1104: 'API 1104',
}

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
  /**
   * The date the term began. Null is allowed only where the certificate
   * prints none — see `printsNoIssueDate`. An NDT method line and a
   * welder's WPQ both state theirs, and are refused without it.
   */
  issueDate: IsoDate | null
  expiryDate?: IsoDate | null
  /** NDT only. Empty is rejected rather than stored, because an empty
   *  list reads as "certifies nothing" and nobody means that. */
  ndtMethods?: NdtMethod[] | null
  /** Welder only: the code the WPQ is written against. */
  qualificationCode?: QualificationCode | null
  /** Welder only: the welding process, as the certificate prints it. */
  process?: string | null
}

/**
 * Whether this credential may be filed with no issue date.
 *
 * Only a CWI card. Every AWS QC1 certificate examined — Emig, Kidd,
 * Cole, Hayman — prints a certificate number and an expiration date and
 * nothing else; AWS does not issue one with a start date on it. An ASNT
 * method line and a welder's WPQ both print theirs, so for those the
 * absence is an unread page rather than a fact about the document.
 *
 * Permission to omit it is not permission to assume it. An undated card
 * certifies no work date; it is on file, and visible, and that is all.
 */
export function printsNoIssueDate(subjectType: CredentialSubject): boolean {
  return subjectType === 'cwi'
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

  if (!['cwi', 'ndt_technician', 'welder'].includes(input.subjectType)) {
    out.push({
      field: 'subjectType',
      message: 'Choose whether this is a welder, a CWI or an NDT technician.',
    })
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

  const issue = clean(input.issueDate)
  const expiry = clean(input.expiryDate)

  // The domain refuses to certify anything against an unread card, so a
  // credential with no issue date would file and then certify nothing.
  // Refused here, where the person can read the date off the card in
  // front of them — unless the card genuinely prints none.
  if (issue && !ISO_DATE.test(issue)) {
    out.push({ field: 'issueDate', message: 'Write the issue date as YYYY-MM-DD.' })
  } else if (!issue && !printsNoIssueDate(input.subjectType)) {
    out.push({
      field: 'issueDate',
      message: input.subjectType === 'welder'
        // The one fact the overview sheet never carries, and the reason
        // every imported qualification reads `unverifiable`. Filing a
        // certificate without it would change nothing.
        ? 'The date the welder qualified is on the WPQ and is required. '
          + 'It is the date the overview sheet does not carry, and without it '
          + 'the qualification stays unverifiable.'
        : 'Each method line carries the date it was certified, and it is required.',
    })
  }

  if (expiry && !ISO_DATE.test(expiry)) {
    out.push({ field: 'expiryDate', message: 'Write the expiry as YYYY-MM-DD, or leave it blank.' })
  }

  // A credential with neither date answers nothing the register asks.
  // Reachable only for a CWI card, which is the one allowed to omit the
  // issue date — and then the expiry is what makes it evidence.
  if (!issue && !expiry) {
    out.push({
      field: 'expiryDate',
      message: 'A card with no issue date must at least carry the expiry it prints. '
        + 'With neither, there is nothing to check a work date against.',
    })
  }

  if (!out.some((p) => p.field === 'issueDate' || p.field === 'expiryDate')
      && issue && expiry && expiry < issue) {
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
      message: 'Methods belong to an NDT card. No other credential carries them.',
    })
  }

  if (input.subjectType === 'welder') {
    if (!input.qualificationCode
        || !QUALIFICATION_CODES.includes(input.qualificationCode)) {
      out.push({
        field: 'qualificationCode',
        message: 'Say which code the WPQ is written against: ASME IX or API 1104.',
      })
    }
    if (!clean(input.process)) {
      out.push({
        field: 'process',
        message: 'Name the welding process the WPQ covers, as the certificate prints it.',
      })
    }
  } else if (input.qualificationCode || clean(input.process)) {
    out.push({
      field: 'qualificationCode',
      message: 'A qualification code and process belong to a welder\'s WPQ.',
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
  entry: {
    certType: string
    issueDate: string | null
    expiryDate?: string | null
    ndtMethods?: readonly string[] | null
  },
  originalFilename: string,
): string {
  const ext = originalFilename.toLowerCase().split('.').pop() ?? 'pdf'
  const safe = (s: string) => s.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '')
  // The method belongs in the name now that one certificate files as
  // several lines: four files called `ASNT_Level_II_2025-10-14` in one
  // SharePoint folder tell a reader nothing.
  const methods = (entry.ndtMethods ?? []).join('')
  // An undated card is named for the expiry it does print, so the file
  // still sorts and still says which term it covers.
  const when = entry.issueDate ?? (entry.expiryDate ? `exp_${entry.expiryDate}` : 'undated')
  return [safe(entry.certType), methods && safe(methods), when]
    .filter(Boolean).join('_') + `.${safe(ext) || 'pdf'}`
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

/**
 * Narrowing the credentials screen.
 *
 * One function over the merged list, so a welder and a CWI answer the
 * same search in the same way. Matches the person, what the credential
 * is, the issuer, an NDT method, and a welding process — because
 * "who can run a 6G" is a question somebody will ask of this screen.
 */
export function filterCredentials<
  T extends {
    personName: string; certType: string
    issuingBody?: string | null
    ndtMethods?: readonly string[] | null
    process?: string | null
  },
>(rows: T[], search?: string): T[] {
  const q = (search ?? '').trim().toLowerCase()
  if (!q) return rows
  return rows.filter((r) =>
    r.personName.toLowerCase().includes(q)
    || r.certType.toLowerCase().includes(q)
    || (r.issuingBody ?? '').toLowerCase().includes(q)
    || (r.process ?? '').toLowerCase().includes(q)
    || (r.ndtMethods ?? []).some((m) => m.toLowerCase() === q))
}

/** Where this credential files, by the book's own section numbering. */
export function credentialSection(subjectType: CredentialSubject): string {
  if (subjectType === 'welder') return '6'
  return subjectType === 'cwi' ? '7' : '8'
}

/** The default certificate type for each roster, as the cards print it.
 *  A starting point for the form, not a constraint. */
export function defaultCertType(subjectType: CredentialSubject): string {
  if (subjectType === 'welder') return 'WPQ'
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
/** The two subjects whose credential IS a certificate. A welder's is a
 *  qualification and never travels through here. */
export type CardSubject = Exclude<CredentialSubject, 'welder'>

export function credentialToCertificate(
  input: CredentialInput,
  subjectId: string,
): {
  subjectType: CardSubject
  subjectId: string
  certType: string
  issuingBody: string | null
  issueDate: IsoDate | null
  expiryDate: IsoDate | null
  ndtMethods: NdtMethod[] | null
} {
  // A welder's credential is a qualification row, not a certificate, and
  // the two are not interchangeable. Thrown rather than coerced: a
  // caller that reached here with a welder has a bug, and quietly
  // filing one as a card would create the second source of truth this
  // whole design exists to avoid.
  if (input.subjectType === 'welder') {
    throw new Error(
      'a welder credential is a qualification, not a certificate; '
      + 'file it against welder_qualification',
    )
  }

  const methods = input.subjectType === 'ndt_technician'
    ? [...new Set(input.ndtMethods ?? [])].sort()
    : []

  return {
    subjectType: input.subjectType,
    subjectId,
    certType: clean(input.certType),
    issuingBody: clean(input.issuingBody) || null,
    issueDate: clean(input.issueDate) || null,
    expiryDate: clean(input.expiryDate) || null,
    ndtMethods: methods.length > 0 ? methods : null,
  }
}

/**
 * The qualification row a valid welder input becomes.
 *
 * The mirror of `credentialToCertificate`, and here for the same
 * reason: both providers write this row, and when they each built it
 * themselves they disagreed about whether a blank process was `''` or
 * null. Throws for anybody but a welder, because a CWI card is not a
 * qualification and coercing one into this shape would invent a
 * welding process for an inspector.
 */
export function credentialToQualification(
  input: CredentialInput,
  welderId: string,
): {
  welderId: string
  code: QualificationCode
  process: string | null
  qualificationDate: IsoDate
  expiryDate: IsoDate | null
} {
  if (input.subjectType !== 'welder' || !input.qualificationCode) {
    throw new Error(
      'only a welder credential is a qualification, and it must name a code',
    )
  }
  return {
    welderId,
    code: input.qualificationCode,
    process: clean(input.process) || null,
    qualificationDate: clean(input.issueDate),
    expiryDate: clean(input.expiryDate) || null,
  }
}

/**
 * The qualification a filed WPQ completes, if there is one.
 *
 * A Weld Log Overview Sheet carries "Date WPQ Expires" and never the
 * date the welder qualified, so every imported qualification reads
 * `unverifiable` — not expired, not valid, unknown. The certificate is
 * what supplies the missing date. Completing that row is the whole
 * point of filing it; adding a second row beside it would leave the
 * first unverifiable for ever and give two answers to one question.
 *
 * Only a row with no start date is a candidate. A dated qualification
 * is a different qualification — a requalification files alongside,
 * because a welder really does hold more than one over a career.
 */
export function openQualificationId<
  T extends {
    id: string; welderId: string; code: string
    qualificationDate?: string | null; deletedAt?: string | null
  },
>(qualifications: readonly T[], welderId: string, code: QualificationCode): string | null {
  const open = qualifications.find((q) =>
    q.welderId === welderId
    && q.code === code
    && !q.qualificationDate
    && !q.deletedAt)
  return open?.id ?? null
}

/**
 * One line of a certificate's method table.
 *
 * ASNT-derived certifications do not certify a person; they certify a
 * person for a method, and each method carries its own dates. Every
 * certification read on 2026-10-15 stated them separately, and they
 * were rarely the same day:
 *
 *   Castaneda-Quezadas  MT 2/7/2028   PT 2/7/2028    RT 2/8/2028
 *   LeCompte            RT 5/2/2028   MT 5/4/2028    PT 5/10/2028
 *   Mercado             PT 2028-10-08 UTT 2028-10-08 MT/RT 2028-10-09
 *
 * The form used to take one pair of dates and apply it to every ticked
 * method, which could only be right by luck. A line is what the page
 * actually prints, and each one files as its own credential.
 */
export interface CredentialMethodLine {
  methods: NdtMethod[]
  issueDate: IsoDate | null
  expiryDate?: IsoDate | null
  /** As the card prints it: "Yoke", "Gamma & X-Ray", "Thickness Only".
   *  Recorded on the certificate type so the register says which of two
   *  RT lines — film or computed radiography — is meant. */
  limitation?: string | null
}

/**
 * The credentials one filed certificate becomes.
 *
 * A CWI card and a welder's WPQ are one each. An NDT certification is
 * one per method line, sharing the person, the issuer and the page, and
 * differing in methods and dates. They file as separate rows because
 * they expire separately, and a register that could not say so would be
 * claiming a technician was covered for RT on the strength of their MT.
 */
export function expandCredentialLines(
  base: CredentialInput,
  lines: readonly CredentialMethodLine[],
): CredentialInput[] {
  if (base.subjectType !== 'ndt_technician') return [base]
  if (lines.length === 0) return [base]
  return lines.map((line) => ({
    ...base,
    ndtMethods: line.methods,
    issueDate: line.issueDate,
    expiryDate: line.expiryDate ?? null,
    // The limitation rides on the certificate type, which is the field
    // the register already shows and searches. "ASNT Level II (Gamma &
    // X-Ray)" distinguishes the two RT lines American Piping issues.
    certType: line.limitation?.trim()
      ? `${base.certType.trim()} (${line.limitation.trim()})`
      : base.certType,
  }))
}

/** Every problem across every line, each tagged with the line it came
 *  from so a form can show it in the right row. */
export function validateCredentialLines(
  base: CredentialInput,
  lines: readonly CredentialMethodLine[],
): (CredentialProblem & { line?: number })[] {
  const inputs = expandCredentialLines(base, lines)
  const out: (CredentialProblem & { line?: number })[] = []
  inputs.forEach((input, i) => {
    for (const p of validateCredential(input)) {
      out.push(inputs.length > 1 ? { ...p, line: i } : p)
    }
  })

  // Two lines for the same method on the same dates are one line typed
  // twice; they would collide in the library and silently become one.
  const seen = new Map<string, number>()
  inputs.forEach((input, i) => {
    const key = `${[...(input.ndtMethods ?? [])].sort().join(',')}|${input.issueDate ?? ''}`
    const first = seen.get(key)
    if (first === undefined) seen.set(key, i)
    else {
      out.push({
        field: 'ndtMethods',
        line: i,
        message: `This is the same method and date as line ${first + 1}.`,
      })
    }
  })
  return out
}
