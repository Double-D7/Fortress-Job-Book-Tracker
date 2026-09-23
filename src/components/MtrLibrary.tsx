'use client'

/**
 * The MTR library.
 *
 * Two jobs on one screen: file a certificate, and find one. Finding is
 * the commoner of the two — somebody holding a heat number off a weld
 * log wants to know whether the certificate exists — so the search box
 * is above the upload, and the heat number is the first column.
 *
 * The heat number is typed, not read out of the PDF, and the form says
 * why where somebody will actually meet the question. Four of five real
 * certificates are scans with no text in them; a wrong heat number
 * silently files the wrong steel against a weld, which is worse than a
 * gap somebody can see.
 */
import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  Download, FileUp, Loader2, Search, TriangleAlert, Upload, X,
} from 'lucide-react'
import type { MtrLibraryEntry } from '@/lib/data/provider'
import { collidingHeats, heatFromFilename } from '@/lib/domain/heats'
import {
  Button, Card, CardBody, CardHeader, CardTitle, Chip, EmptyState,
  Table, Td, Th, Tr,
} from '@/components/ui/primitives'

const FIELD =
  'rounded-md border border-hairline bg-surface px-2 py-1 text-xs text-ink ' +
  'focus:border-brand-bright focus:outline-none'

export function MtrLibrary({
  entries, canUpload, search,
}: {
  entries: MtrLibraryEntry[]
  canUpload: boolean
  search: string
}) {
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement>(null)

  const [term, setTerm] = useState(search)
  const [file, setFile] = useState<File | null>(null)
  const [heat, setHeat] = useState('')
  const [description, setDescription] = useState('')
  const [mill, setMill] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  /** The one place the filename is allowed to speak. */
  function chooseFile(f: File | null) {
    setFile(f)
    setError(null)
    setNote(null)
    if (!f) return
    const suggested = heatFromFilename(f.name)
    if (suggested) setHeat(suggested)
  }

  async function upload() {
    if (!file || !heat.trim()) return
    setBusy(true); setError(null); setNote(null)
    try {
      const body = new FormData()
      body.append('file', file)
      body.append('heatNumber', heat.trim())
      if (description.trim()) body.append('materialDescription', description.trim())
      if (mill.trim()) body.append('millName', mill.trim())

      const res = await fetch('/api/mtr', { method: 'POST', body })
      const json = await res.json()
      if (!json.ok) { setError(json.error ?? 'That did not go through.'); return }

      const n = json.heatsResolved ?? 0
      setNote(n > 0
        ? `Filed against heat ${heat.trim()}. ${n} heat${n === 1 ? '' : 's'} ` +
          `${n === 1 ? 'was' : 'were'} waiting on it and now ${n === 1 ? 'reads' : 'read'} "on file".`
        : `Filed against heat ${heat.trim()}. No job book references it yet — ` +
          'it will resolve the moment one does.')
      setFile(null); setHeat(''); setDescription(''); setMill('')
      if (inputRef.current) inputRef.current.value = ''
      router.refresh()
    } catch {
      setError('Could not reach the server.')
    } finally {
      setBusy(false)
    }
  }

  const collisions = collidingHeats(entries.map((e) => e.heatNumber))

  return (
    <div className="space-y-4">
      {canUpload && (
        <Card>
          <CardHeader><CardTitle>File a mill certificate</CardTitle></CardHeader>
          <CardBody className="space-y-3">
            <p className="text-xs leading-relaxed text-ink-secondary">
              One certificate per heat number, shared by every job book. Upload it once and
              every book that references that heat resolves to it — including books that
              referenced it before it arrived.
            </p>

            <div className="flex flex-wrap items-center gap-2">
              <input ref={inputRef} type="file" accept=".pdf,application/pdf"
                     className="hidden"
                     onChange={(e) => chooseFile(e.target.files?.[0] ?? null)} />
              <Button variant="secondary" onClick={() => inputRef.current?.click()}>
                <FileUp size={13} /> Choose a certificate
              </Button>
              {file && <span className="text-xs text-ink-secondary">{file.name}</span>}
            </div>

            {file && (
              <div className="space-y-3 rounded-md border border-hairline p-3">
                <div className="grid gap-3 sm:grid-cols-3">
                  <label className="flex flex-col gap-1 text-2xs text-ink-secondary">
                    Heat number
                    <input className={FIELD} value={heat} autoFocus
                           onChange={(e) => setHeat(e.target.value)}
                           placeholder="D07821" />
                  </label>
                  <label className="flex flex-col gap-1 text-2xs text-ink-secondary">
                    Material (optional)
                    <input className={FIELD} value={description}
                           onChange={(e) => setDescription(e.target.value)}
                           placeholder="4&quot; CL900 WN flange" />
                  </label>
                  <label className="flex flex-col gap-1 text-2xs text-ink-secondary">
                    Mill (optional)
                    <input className={FIELD} value={mill}
                           onChange={(e) => setMill(e.target.value)} />
                  </label>
                </div>

                <p className="text-2xs leading-relaxed text-ink-secondary">
                  <strong className="text-ink">Check the heat number against the certificate.</strong>{' '}
                  It is suggested from the filename, not read from the document — most mill
                  certificates are scans with no text in them. A wrong heat number here files
                  this certificate against the wrong steel, and the book would report the
                  material as traceable.
                </p>

                <Button variant="primary" disabled={busy || !heat.trim()} onClick={upload}>
                  {busy ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
                  File it
                </Button>
              </div>
            )}

            {error && (
              <p className="rounded-md border border-status-critical/30 bg-status-critical/10 px-3 py-2 text-xs text-status-critical">
                {error}
              </p>
            )}
            {note && !error && (
              <p className="rounded-md border border-status-complete/30 bg-status-complete/10 px-3 py-2 text-xs text-status-complete">
                {note}
              </p>
            )}
          </CardBody>
        </Card>
      )}

      {collisions.length > 0 && (
        <Card>
          <CardBody>
            <div className="flex flex-wrap items-center gap-2">
              <Chip tone="critical" icon={<TriangleAlert size={12} />}>Ambiguous</Chip>
              <span className="text-xs font-medium text-ink">
                {collisions.length} heat number{collisions.length === 1 ? '' : 's'} filed
                more than one way
              </span>
            </div>
            <p className="mt-1 text-2xs text-ink-secondary">
              {collisions.map((g) => g.join(' / ')).join(' · ')} — these match each other once
              punctuation is ignored, so a book referencing one may resolve to the other.
              Correct the spelling on whichever is wrong.
            </p>
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>Certificates on file</CardTitle>
          <form className="flex items-center gap-1.5" action="/mtr">
            <Search size={13} className="text-ink-muted" />
            <input name="q" value={term} onChange={(e) => setTerm(e.target.value)}
                   className={FIELD} placeholder="Heat, material or mill" />
            {term && (
              <Button variant="secondary" type="button"
                      onClick={() => { setTerm(''); router.push('/mtr') }}>
                <X size={12} />
              </Button>
            )}
          </form>
        </CardHeader>
        <CardBody className="p-0">
          {entries.length === 0 ? (
            <div className="p-4">
              <EmptyState
                title={search ? `Nothing on file for “${search}”` : 'No certificates on file yet'}
                detail={search
                  ? 'Try the heat number on its own — punctuation is ignored when matching.'
                  : 'Upload a mill certificate above. It only has to be filed once, however many job books use that heat.'}
              />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <thead>
                  <Tr>
                    <Th>Heat</Th><Th>Material</Th><Th>Mill</Th>
                    <Th className="text-right">Used by</Th><Th>Filed</Th>
                    <Th className="text-right">Certificate</Th>
                  </Tr>
                </thead>
                <tbody>
                  {entries.map((m) => (
                    <Tr key={m.id}>
                      <Td className="whitespace-nowrap font-mono font-medium">{m.heatNumber}</Td>
                      <Td className="text-ink-secondary">
                        {m.materialDescription
                          ?? ([m.nominalSize, m.scheduleOrClass, m.componentType]
                              .filter(Boolean).join(' ') || '—')}
                      </Td>
                      <Td className="text-2xs text-ink-secondary">{m.millName ?? '—'}</Td>
                      <Td className="text-right text-2xs">
                        {m.referencedByHeats === 0 ? (
                          <span className="text-ink-muted">Not yet</span>
                        ) : (
                          <span className="text-ink-secondary">
                            {m.referencedByBooks} book{m.referencedByBooks === 1 ? '' : 's'}
                          </span>
                        )}
                      </Td>
                      <Td className="tnum text-2xs text-ink-muted">
                        {m.uploadedAt.slice(0, 10)}
                      </Td>
                      <Td className="text-right">
                        <a href={`/api/mtr/${m.id}/file`} target="_blank" rel="noreferrer"
                           className="inline-flex items-center gap-1 text-2xs text-brand-bright hover:underline">
                          <Download size={12} /> Open
                        </a>
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </div>
          )}
          <p className="border-t border-hairline px-4 py-3 text-2xs leading-relaxed text-ink-secondary">
            Every download is written to the audit log before the link is issued, so a
            certificate handed out is a certificate recorded. Operators and inspectors see
            only the certificates referenced by a book they can already read.
          </p>
        </CardBody>
      </Card>
    </div>
  )
}
