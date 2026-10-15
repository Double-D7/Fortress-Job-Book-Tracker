/**
 * Reading a filed credential off a multipart form.
 *
 * Two routes accept one: `/api/credentials` for the library, and the
 * book-scoped one that also rescores the book it was filed from. They
 * are the same upload and they had the same parser written out twice,
 * which is how the NDT methods field reached one route and not the
 * other. One function now, so adding a field cannot reach half the
 * application.
 *
 * Nothing here decides anything. It narrows strings to the unions the
 * domain uses and hands the result to `validateCredential`, which is
 * the only place that says whether an input is acceptable.
 */
import {
  NDT_METHODS, QUALIFICATION_CODES, expandCredentialLines,
  type CredentialInput, type CredentialMethodLine, type CredentialSubject,
} from '@/lib/domain/credentials'
import type { NdtMethod, QualificationCode } from '@/lib/domain/types'

/** A wallet card photographed at full resolution. Generous for a page,
 *  mean enough that nobody files a scanned binder through this form. */
export const MAX_CREDENTIAL_BYTES = 10 * 1024 * 1024

function text(form: FormData, key: string): string {
  const v = form.get(key)
  return typeof v === 'string' ? v.trim() : ''
}

/** The roster a form names, defaulting to the one it opens on. An
 *  unrecognised value is not silently a CWI: it is the default, and
 *  `validateCredential` still has to accept everything else about it. */
export function credentialSubjectFrom(raw: string): CredentialSubject {
  if (raw === 'cwi' || raw === 'welder') return raw
  return 'ndt_technician'
}

/** The code a WPQ names, or null when it names none. Null reaches
 *  `validateCredential`, which refuses a welder without one — rather
 *  than this picking a code on the welder's behalf. */
export function qualificationCodeFrom(raw: string): QualificationCode | null {
  return (QUALIFICATION_CODES as readonly string[]).includes(raw)
    ? (raw as QualificationCode)
    : null
}

/** The methods a form ticked, dropping anything that is not one. A
 *  method this book does not record certifies nothing, so passing it
 *  through to be rejected by name would only be noise. */
export function ndtMethodsFrom(form: FormData): NdtMethod[] {
  return form.getAll('ndtMethods')
    .filter((m): m is string => typeof m === 'string')
    .filter((m): m is NdtMethod => (NDT_METHODS as readonly string[]).includes(m))
}

/**
 * The method table a form submitted, if it submitted one.
 *
 * Sent as JSON in a single field rather than as indexed form keys
 * (`line.0.methods`), because the rows are a list of objects and
 * reassembling that from flat keys is where off-by-one bugs live.
 * Anything unparseable yields no lines, and the credential falls back
 * to the single-line shape — which validation then judges on its own
 * merits rather than filing something half-read.
 */
export function methodLinesFrom(form: FormData): CredentialMethodLine[] {
  const raw = form.get('methodLines')
  if (typeof raw !== 'string' || !raw.trim()) return []
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return [] }
  if (!Array.isArray(parsed)) return []

  const out: CredentialMethodLine[] = []
  for (const row of parsed) {
    if (typeof row !== 'object' || row === null) continue
    const r = row as Record<string, unknown>
    const methods = Array.isArray(r.methods)
      ? r.methods.filter((m): m is NdtMethod =>
          typeof m === 'string' && (NDT_METHODS as readonly string[]).includes(m))
      : []
    const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
    out.push({
      methods,
      issueDate: str(r.issueDate) || null,
      expiryDate: str(r.expiryDate) || null,
      limitation: str(r.limitation) || null,
    })
  }
  return out
}

/**
 * Every credential this upload becomes.
 *
 * One for a CWI card or a welder's WPQ. One per method line for an NDT
 * certification, because each line expires on its own date.
 */
export function credentialsFromForm(form: FormData): CredentialInput[] {
  return expandCredentialLines(credentialFromForm(form), methodLinesFrom(form))
}

export function credentialFromForm(form: FormData): CredentialInput {
  const subjectType = credentialSubjectFrom(text(form, 'subjectType'))
  const welder = subjectType === 'welder'
  return {
    subjectType,
    subjectId: text(form, 'subjectId') || null,
    fullName: text(form, 'fullName') || null,
    initials: text(form, 'initials') || null,
    employer: text(form, 'employer') || null,
    certType: text(form, 'certType'),
    issuingBody: text(form, 'issuingBody') || null,
    issueDate: text(form, 'issueDate') || null,
    expiryDate: text(form, 'expiryDate') || null,
    // Each field is read only for the roster it belongs to. A welder
    // form that carried methods, or a CWI form that carried a process,
    // is refused by `validateCredential` rather than quietly trimmed —
    // but neither can arrive by a stale field left in the browser.
    ndtMethods: subjectType === 'ndt_technician' ? ndtMethodsFrom(form) : null,
    qualificationCode: welder ? qualificationCodeFrom(text(form, 'qualificationCode')) : null,
    process: welder ? text(form, 'process') || null : null,
  }
}
