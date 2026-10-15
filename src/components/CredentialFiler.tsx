'use client'

/**
 * Filing a welder, CWI or NDT technician credential.
 *
 * Sections 6, 7 and 8 ask whether the people who welded and inspected
 * this pipe were qualified to. Every other section had a way to get
 * records in and these did not, so the answer lived in a folder
 * somewhere and the book scored zero regardless.
 *
 * ## Why this is typed in rather than read off the page
 *
 * Every other importer parses the original. A CWI card and an ASNT
 * card are usually a photograph of a wallet card, at an angle, with
 * the dates printed small. Guessing them would be guessing about
 * whether somebody was qualified on the day they signed. So a person
 * reads the card and types what it says, and the card is filed beside
 * what they typed so the next person can check them.
 *
 * ## Why an NDT card is a table rather than a row
 *
 * ASNT certifies per method, and each method carries its own dates.
 * Every real certification read on 2026-10-15 proved it — Mercado's PT
 * and UT expire 2028-10-08, his MT and RT 2028-10-09 — and the form
 * used to take one pair of dates and apply them to every ticked method,
 * which could only ever be right by luck. So the methods are a table
 * now, one line per line of the certificate, and each files as its own
 * credential.
 *
 * Methods are still not optional. A card with no methods recorded
 * certifies no work, and leaving the field blank is what let a
 * PT-qualified technician pass an RT report for the life of this
 * application.
 *
 * ## Why a CWI card may have no issue date
 *
 * Because AWS does not print one. All four certificates on file carry a
 * certificate number and an expiration date and nothing else. The field
 * is optional for a CWI and required everywhere else, and an undated
 * card certifies no work date — it is on file, and visible, and that is
 * all until somebody records when the term began.
 *
 * ## Why a welder's dates read differently
 *
 * A welder is not issued a card; they qualify on a test coupon, on a
 * date, against a code and a process. The Weld Log Overview Sheet
 * carries the expiry and never the qualification date, which is why
 * every imported qualification reads `unverifiable`. Filing the WPQ is
 * how that date arrives, so the field is labelled for what the
 * certificate actually prints.
 */
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { AlertTriangle, Loader2, Paperclip, Plus, ScanLine, X } from 'lucide-react'
import {
  NDT_METHODS, QUALIFICATION_CODES, QUALIFICATION_CODE_LABEL,
  defaultCertType, printsNoIssueDate, validateCredentialLines,
  type CredentialMethodLine, type CredentialSubject,
} from '@/lib/domain/credentials'
import type { NdtMethod, QualificationCode } from '@/lib/domain/types'
import type { RosterMember } from '@/lib/data/provider'
import type { CredentialDraft } from '@/lib/extract/credentialExtraction'
import { Button, Card, CardBody, CardHeader, CardTitle } from '@/components/ui/primitives'

const field =
  'rounded-md border border-hairline bg-surface px-2 py-1 text-xs text-ink ' +
  'focus:border-brand-bright focus:outline-none'

const NEW_PERSON = '__new__'

export function CredentialFiler({
  bookId, cwis, technicians, welders,
}: {
  /** The book to rescore afterwards, when filing from one. Absent when
   *  filing from the library, which is where a card normally starts:
   *  it belongs to the person, not to a job. */
  bookId?: string
  cwis: RosterMember[]
  technicians: RosterMember[]
  welders: RosterMember[]
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [subjectType, setSubjectType] = useState<CredentialSubject>('ndt_technician')
  const [subjectId, setSubjectId] = useState(NEW_PERSON)
  const [fullName, setFullName] = useState('')
  const [initials, setInitials] = useState('')
  const [employer, setEmployer] = useState('')
  const [certType, setCertType] = useState(defaultCertType('ndt_technician'))
  const [issuingBody, setIssuingBody] = useState('')
  const [issueDate, setIssueDate] = useState('')
  const [expiryDate, setExpiryDate] = useState('')
  const [lines, setLines] = useState<CredentialMethodLine[]>(
    [{ methods: [], issueDate: '', expiryDate: '', limitation: '' }],
  )
  const [qualificationCode, setQualificationCode] = useState<QualificationCode>('ASME_IX')
  const [process, setProcess] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [reading, setReading] = useState(false)
  /** What the page was read as, kept so the person checking can be
   *  told which fields came off the certificate and which did not. */
  const [readFrom, setReadFrom] = useState<CredentialDraft | null>(null)
  const [readNote, setReadNote] = useState<string | null>(null)

  const isTech = subjectType === 'ndt_technician'
  const isWelder = subjectType === 'welder'
  const issueOptional = printsNoIssueDate(subjectType)
  const roster = subjectType === 'cwi' ? cwis : isWelder ? welders : technicians
  const addingPerson = subjectId === NEW_PERSON

  function switchRoster(next: CredentialSubject) {
    setSubjectType(next)
    // The person and the methods belong to the roster that was chosen,
    // so neither survives the switch. Carrying them over is how a CWI
    // ends up filed with radiographic methods.
    setSubjectId(NEW_PERSON)
    setLines([{ methods: [], issueDate: '', expiryDate: '', limitation: '' }])
    setProcess('')
    setQualificationCode('ASME_IX')
    setCertType(defaultCertType(next))
  }

  function reset() {
    setFullName(''); setInitials(''); setEmployer('')
    setIssuingBody(''); setIssueDate(''); setExpiryDate('')
    setLines([{ methods: [], issueDate: '', expiryDate: '', limitation: '' }])
    setProcess(''); setQualificationCode('ASME_IX')
    setFile(null); setSubjectId(NEW_PERSON)
    setReadFrom(null); setReadNote(null)
    setCertType(defaultCertType(subjectType))
  }

  /**
   * Read the attached certificate and fill the form in.
   *
   * Fills; does not file. Nothing reaches the register until somebody
   * presses "File it", and the fields stay editable throughout — the
   * person checking the page is the one whose answer gets stored.
   *
   * A failed read is not an error state. It leaves the form exactly as
   * it was, which is empty and typeable, and says so.
   */
  async function readPage(f: File) {
    setReading(true); setError(null); setReadNote(null)
    try {
      const form = new FormData()
      form.set('file', f)
      const res = await fetch('/api/credentials/extract', { method: 'POST', body: form })
      const json = (await res.json()) as
        { ok: boolean; draft?: CredentialDraft; error?: string }

      if (!json.ok || !json.draft) {
        setReadNote(json.error ?? 'The certificate could not be read. Type the fields in.')
        return
      }

      const d = json.draft
      setReadFrom(d)
      if (d.subjectType) switchRosterKeepingFile(d.subjectType)
      // Every field stays editable. These are a starting point for
      // somebody reading the page, not an answer.
      if (d.fullName) setFullName(d.fullName)
      if (d.employer) setEmployer(d.employer)
      if (d.certType) setCertType(d.certType)
      if (d.issuingBody) setIssuingBody(d.issuingBody)
      setIssueDate(d.issueDate ?? '')
      setExpiryDate(d.expiryDate ?? '')
      if (d.qualificationCode) setQualificationCode(d.qualificationCode)
      if (d.process) setProcess(d.process)
      if (d.methodLines.length > 0) {
        setLines(d.methodLines.map((l) => ({
          methods: l.methods,
          issueDate: l.issueDate ?? '',
          expiryDate: l.expiryDate ?? '',
          limitation: l.limitation ?? '',
        })))
      }
    } catch {
      setReadNote('Could not reach the server to read the certificate. Type the fields in.')
    } finally {
      setReading(false)
    }
  }

  /** `switchRoster` clears the form, which would throw away a reading
   *  the instant it was applied. */
  function switchRosterKeepingFile(next: CredentialSubject) {
    setSubjectType(next)
    setSubjectId(NEW_PERSON)
    setCertType(defaultCertType(next))
  }

  async function submit() {
    setBusy(true); setError(null)
    try {
      const form = new FormData()
      form.set('subjectType', subjectType)
      if (!addingPerson) form.set('subjectId', subjectId)
      else {
        form.set('fullName', fullName)
        form.set('initials', initials)
        form.set('employer', employer)
      }
      form.set('certType', certType)
      form.set('issuingBody', issuingBody)
      form.set('issueDate', issueDate)
      form.set('expiryDate', expiryDate)
      if (isTech) form.set('methodLines', JSON.stringify(lines))
      if (isWelder) {
        form.set('qualificationCode', qualificationCode)
        form.set('process', process)
      }
      if (file) form.set('file', file)

      const res = await fetch(
        bookId ? `/api/books/${bookId}/credentials` : '/api/credentials',
        { method: 'POST', body: form },
      )
      const json = (await res.json()) as { ok: boolean; error?: string }
      if (!json.ok) setError(json.error ?? 'That did not work.')
      else { reset(); setOpen(false); router.refresh() }
    } catch {
      setError('Could not reach the server.')
    } finally {
      setBusy(false)
    }
  }

  // The same rules the server applies, so the button is disabled for
  // the reasons the server would reject it rather than for its own.
  const problems = validateCredentialLines(
    {
      subjectType, subjectId: addingPerson ? null : subjectId,
      fullName, certType, issuingBody,
      issueDate: issueDate || null, expiryDate: expiryDate || null,
      ndtMethods: isTech ? [] : null,
      qualificationCode: isWelder ? qualificationCode : null,
      process: isWelder ? process : null,
    },
    isTech ? lines : [],
  )
  const ready = !!file && problems.length === 0

  if (!open) {
    return (
      <Card>
        <CardBody className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="text-xs font-medium text-ink">File a credential</div>
            <p className="mt-0.5 text-2xs text-ink-muted">
              A welder WPQ into section 6, a CWI card into section 7, an NDT
              technician card into section 8. Attach the page and it is read for
              you; you check it before it files.
            </p>
          </div>
          <Button variant="primary" onClick={() => setOpen(true)}>
            <Plus size={12} /> File a credential
          </Button>
        </CardBody>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader><CardTitle>File a credential</CardTitle></CardHeader>
      <CardBody className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-2xs text-ink-secondary">Credential</label>
          <select
            className={field}
            value={subjectType}
            onChange={(e) => switchRoster(e.target.value as CredentialSubject)}
          >
            <option value="ndt_technician">NDT technician (section 8)</option>
            <option value="cwi">CWI (section 7)</option>
            <option value="welder">Welder (section 6)</option>
          </select>

          <label className="ml-2 text-2xs text-ink-secondary">Person</label>
          <select
            className={`${field} min-w-[12rem]`}
            value={subjectId}
            onChange={(e) => setSubjectId(e.target.value)}
          >
            <option value={NEW_PERSON}>Add somebody new</option>
            {roster.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
          </select>
        </div>

        {addingPerson && (
          <div className="flex flex-wrap gap-2">
            <input
              className={`${field} min-w-[14rem] flex-1`} placeholder="Full name, as the card prints it"
              value={fullName} maxLength={120} onChange={(e) => setFullName(e.target.value)}
            />
            <input
              className={`${field} w-24`} placeholder="Initials"
              value={initials} maxLength={8} onChange={(e) => setInitials(e.target.value)}
            />
            <input
              className={`${field} min-w-[10rem] flex-1`} placeholder="Employer"
              value={employer} maxLength={120} onChange={(e) => setEmployer(e.target.value)}
            />
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <input
            className={`${field} min-w-[12rem] flex-1`}
            placeholder={isWelder ? 'What the certificate is called' : 'Certificate type'}
            value={certType} maxLength={120} onChange={(e) => setCertType(e.target.value)}
          />
          <input
            className={`${field} min-w-[10rem] flex-1`}
            placeholder={isWelder ? 'Who performed the test' : 'Issuing body'}
            value={issuingBody} maxLength={120} onChange={(e) => setIssuingBody(e.target.value)}
          />
        </div>

        {isWelder && (
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <label className="text-2xs text-ink-secondary">Code</label>
              <select
                className={field}
                value={qualificationCode}
                onChange={(e) => setQualificationCode(e.target.value as QualificationCode)}
              >
                {QUALIFICATION_CODES.map((c) => (
                  <option key={c} value={c}>{QUALIFICATION_CODE_LABEL[c]}</option>
                ))}
              </select>
              <label className="ml-2 text-2xs text-ink-secondary">Process</label>
              <input
                className={`${field} min-w-[8rem]`} placeholder="GTAW, SMAW, GTAW/SMAW"
                value={process} maxLength={120} onChange={(e) => setProcess(e.target.value)}
              />
            </div>
            <p className="mt-1 text-2xs text-ink-muted">
              As the WPQ prints them. A welder qualified under one code and process
              is not thereby qualified under another.
            </p>
          </div>
        )}

        <div className={`flex flex-wrap items-center gap-2 ${isTech ? 'hidden' : ''}`}>
          <label className="text-2xs text-ink-secondary">
            {isWelder ? 'Qualified on' : 'Issued'}
          </label>
          <input
            type="date" className={field} value={issueDate}
            onChange={(e) => setIssueDate(e.target.value)}
          />
          <label className="ml-2 text-2xs text-ink-secondary">Expires</label>
          <input
            type="date" className={field} value={expiryDate}
            onChange={(e) => setExpiryDate(e.target.value)}
          />
          <span className="text-2xs text-ink-muted">
            {isWelder
              ? 'The qualification date is the one the overview sheet never carries.'
              : issueOptional
                ? 'An AWS card prints no issue date. Leave it blank and the expiry stands alone.'
                : 'Blank expiry means the card prints none.'}
          </span>
        </div>

        {isTech && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-2xs text-ink-secondary">Methods</label>
              <Button
                variant="ghost"
                onClick={() => setLines((prev) => [
                  ...prev, { methods: [], issueDate: '', expiryDate: '', limitation: '' },
                ])}
              >
                <Plus size={11} /> Add a method line
              </Button>
            </div>

            {lines.map((line, i) => (
              <div
                key={i}
                className="rounded-md border border-hairline bg-surface-raised p-2 space-y-1.5"
              >
                <div className="flex flex-wrap items-center gap-3">
                  {NDT_METHODS.map((m) => (
                    <label key={m} className="flex items-center gap-1 text-xs text-ink">
                      <input
                        type="checkbox"
                        checked={line.methods.includes(m)}
                        onChange={(e) => setLines((prev) => prev.map((l, j) =>
                          j !== i ? l : {
                            ...l,
                            methods: e.target.checked
                              ? [...l.methods, m]
                              : l.methods.filter((x) => x !== m),
                          }))}
                      />
                      {m}
                    </label>
                  ))}
                  <input
                    className={`${field} ml-1 min-w-[9rem] flex-1`}
                    placeholder="Limited to — Yoke, Gamma & X-Ray, Thickness Only"
                    value={line.limitation ?? ''}
                    maxLength={80}
                    onChange={(e) => setLines((prev) => prev.map((l, j) =>
                      j !== i ? l : { ...l, limitation: e.target.value }))}
                  />
                  {lines.length > 1 && (
                    <button
                      type="button"
                      aria-label={`Remove method line ${i + 1}`}
                      className="text-ink-muted hover:text-status-critical"
                      onClick={() => setLines((prev) => prev.filter((_, j) => j !== i))}
                    >
                      <X size={12} />
                    </button>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <label className="text-2xs text-ink-secondary">Certified</label>
                  <input
                    type="date" className={field} value={line.issueDate ?? ''}
                    onChange={(e) => setLines((prev) => prev.map((l, j) =>
                      j !== i ? l : { ...l, issueDate: e.target.value }))}
                  />
                  <label className="ml-2 text-2xs text-ink-secondary">Expires</label>
                  <input
                    type="date" className={field} value={line.expiryDate ?? ''}
                    onChange={(e) => setLines((prev) => prev.map((l, j) =>
                      j !== i ? l : { ...l, expiryDate: e.target.value }))}
                  />
                </div>
              </div>
            ))}

            <p className="text-2xs text-ink-muted">
              One line per line of the certificate. ASNT certifies each method on its
              own dates and they are often days apart, so each line files as its own
              credential and expires on its own.
            </p>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-ink-secondary">
            <Paperclip size={12} />
            <span className="underline">
              {file ? file.name : isWelder ? 'Attach the WPQ' : 'Attach the card'}
            </span>
            <input
              type="file" className="hidden" accept=".pdf,.png,.jpg,.jpeg,.webp"
              onChange={(e) => {
                const f = e.target.files?.[0] ?? null
                setFile(f)
                setReadFrom(null); setReadNote(null)
                // Read it straight away. Attaching the page is the
                // moment somebody wants the form filled in; making
                // them press a second button is a step with no
                // decision in it.
                if (f) void readPage(f)
              }}
            />
          </label>
          {file && (
            <Button variant="ghost" disabled={reading} onClick={() => void readPage(file)}>
              {reading
                ? <Loader2 size={12} className="animate-spin" />
                : <ScanLine size={12} />}
              {reading ? 'Reading the page' : 'Read it again'}
            </Button>
          )}
          <span className="text-2xs text-ink-muted">Required. Up to 10 MB.</span>
        </div>

        {readNote && (
          <p className="text-2xs text-ink-secondary">{readNote}</p>
        )}

        {readFrom && (
          <div className="rounded-md border border-brand-bright/40 bg-brand-bright/5 p-2">
            <div className="flex items-start gap-1.5 text-2xs text-ink-secondary">
              <ScanLine size={12} className="mt-0.5 shrink-0 text-brand-bright" />
              <div className="space-y-1">
                <p>
                  <span className="font-medium text-ink">Filled in from the page.</span>{' '}
                  Check every date against the certificate before filing — what gets
                  stored is what you confirm here, not what was read.
                </p>
                {readFrom.certificateNumber && (
                  <p>
                    Certificate number{' '}
                    <span className="font-mono text-ink">{readFrom.certificateNumber}</span>
                    {' '}— not stored, but worth checking it is the right person.
                  </p>
                )}
                {readFrom.subjectType === 'cwi' && !readFrom.issueDate && (
                  <p>
                    No issue date, because an AWS card does not print one. Left blank
                    deliberately. Fill it in only if you know when the term began.
                  </p>
                )}
                {readFrom.visionAcuityExpiry && (
                  <p className="text-status-progress">
                    This page also states a vision acuity expiry of{' '}
                    <span className="font-mono">{readFrom.visionAcuityExpiry}</span>.
                    The application does not record that yet; file the eye exam
                    separately.
                  </p>
                )}
                {readFrom.notes && <p>{readFrom.notes}</p>}
                {readFrom.unreadable.length > 0 && (
                  <p className="flex items-center gap-1 text-status-critical">
                    <AlertTriangle size={11} />
                    Could not be read with confidence: {readFrom.unreadable.join(', ')}.
                    Type {readFrom.unreadable.length > 1 ? 'those' : 'that'} in from the page.
                  </p>
                )}
              </div>
            </div>
          </div>
        )}

        {error && <p className="text-2xs text-status-critical">{error}</p>}

        <div className="flex items-center gap-2">
          <Button variant="primary" disabled={!ready || busy} onClick={() => void submit()}>
            {busy ? <Loader2 size={12} className="animate-spin" /> : null} File it
          </Button>
          <Button variant="ghost" disabled={busy} onClick={() => { reset(); setOpen(false) }}>
            Cancel
          </Button>
        </div>
      </CardBody>
    </Card>
  )
}
