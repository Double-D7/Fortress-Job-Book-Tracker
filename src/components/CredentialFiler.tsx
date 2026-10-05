'use client'

/**
 * Filing a CWI or NDT technician credential.
 *
 * Sections 7 and 8 ask whether the people who inspected this pipe were
 * qualified to. Every other section had a way to get records in and
 * these two did not, so the answer lived in a folder somewhere and the
 * book scored zero regardless.
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
 * ## Why methods are not optional
 *
 * ASNT certifies per method. A card with no methods recorded certifies
 * no work, and leaving the field blank is what let a PT-qualified
 * technician pass an RT report for the life of this application.
 */
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, Paperclip, Plus } from 'lucide-react'
import { NDT_METHODS, defaultCertType, type CredentialSubject } from '@/lib/domain/credentials'
import type { NdtMethod } from '@/lib/domain/types'
import type { RosterMember } from '@/lib/data/provider'
import { Button, Card, CardBody, CardHeader, CardTitle } from '@/components/ui/primitives'

const field =
  'rounded-md border border-hairline bg-surface px-2 py-1 text-xs text-ink ' +
  'focus:border-brand-bright focus:outline-none'

const NEW_PERSON = '__new__'

export function CredentialFiler({
  bookId, cwis, technicians,
}: {
  /** The book to rescore afterwards, when filing from one. Absent when
   *  filing from the library, which is where a card normally starts:
   *  it belongs to the person, not to a job. */
  bookId?: string
  cwis: RosterMember[]
  technicians: RosterMember[]
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
  const [methods, setMethods] = useState<NdtMethod[]>([])
  const [file, setFile] = useState<File | null>(null)

  const roster = subjectType === 'cwi' ? cwis : technicians
  const addingPerson = subjectId === NEW_PERSON

  function switchRoster(next: CredentialSubject) {
    setSubjectType(next)
    // The person and the methods belong to the roster that was chosen,
    // so neither survives the switch. Carrying them over is how a CWI
    // ends up filed with radiographic methods.
    setSubjectId(NEW_PERSON)
    setMethods([])
    setCertType(defaultCertType(next))
  }

  function reset() {
    setFullName(''); setInitials(''); setEmployer('')
    setIssuingBody(''); setIssueDate(''); setExpiryDate('')
    setMethods([]); setFile(null); setSubjectId(NEW_PERSON)
    setCertType(defaultCertType(subjectType))
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
      for (const m of methods) form.append('ndtMethods', m)
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

  const ready = !!file && !!issueDate && !!certType.trim()
    && (addingPerson ? !!fullName.trim() : !!subjectId)
    && (subjectType === 'cwi' || methods.length > 0)

  if (!open) {
    return (
      <Card>
        <CardBody className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="text-xs font-medium text-ink">File a credential</div>
            <p className="mt-0.5 text-2xs text-ink-muted">
              A CWI card into section 7, an NDT technician card into section 8.
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
            className={`${field} min-w-[12rem] flex-1`} placeholder="Certificate type"
            value={certType} maxLength={120} onChange={(e) => setCertType(e.target.value)}
          />
          <input
            className={`${field} min-w-[10rem] flex-1`} placeholder="Issuing body"
            value={issuingBody} maxLength={120} onChange={(e) => setIssuingBody(e.target.value)}
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <label className="text-2xs text-ink-secondary">Issued</label>
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
            Blank expiry means the card prints none.
          </span>
        </div>

        {subjectType === 'ndt_technician' && (
          <div>
            <div className="flex flex-wrap items-center gap-3">
              <label className="text-2xs text-ink-secondary">Methods</label>
              {NDT_METHODS.map((m) => (
                <label key={m} className="flex items-center gap-1 text-xs text-ink">
                  <input
                    type="checkbox"
                    checked={methods.includes(m)}
                    onChange={(e) => setMethods((prev) =>
                      e.target.checked ? [...prev, m] : prev.filter((x) => x !== m))}
                  />
                  {m}
                </label>
              ))}
            </div>
            <p className="mt-1 text-2xs text-ink-muted">
              ASNT certifies per method. Tick only what this card covers: a technician
              certified for PT is not thereby certified to interpret an RT film.
            </p>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-ink-secondary">
            <Paperclip size={12} />
            <span className="underline">{file ? file.name : 'Attach the card'}</span>
            <input
              type="file" className="hidden" accept=".pdf,.png,.jpg,.jpeg"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </label>
          <span className="text-2xs text-ink-muted">Required. Up to 10 MB.</span>
        </div>

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
