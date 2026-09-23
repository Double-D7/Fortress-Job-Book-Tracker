'use client'

/**
 * The MTR library.
 *
 * Two jobs on one screen: file certificates, and find one. Finding is the
 * commoner of the two — somebody holding a heat number off a weld log
 * wants to know whether the certificate exists — so the search box is
 * above the upload, and the heat number is the first column.
 *
 * The heat number is typed, not read out of the PDF, and the form says
 * why where somebody will actually meet the question. Four of five real
 * certificates are scans with no text in them; a wrong heat number
 * silently files the wrong steel against a weld, which is worse than a
 * gap somebody can see.
 *
 * Filing is a batch. A facility turnover arrives as a folder of scans, and
 * doing them one at a time is an afternoon — but "file all" with no review
 * would throw away the confirmation the whole design rests on. So the
 * whole batch is confirmed as a list: every suggested heat on screen,
 * editable, next to the filename it came from. `mtrBatch` decides which
 * rows are safe to send.
 *
 * Uploads run one at a time rather than in parallel. These are large scans
 * going out over whatever signal a yard has, and a serial queue gives an
 * honest running count and leaves the failures attributable — six
 * simultaneous uploads that half-fail tell you much less.
 */
import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  Check, Download, FileUp, Loader2, Search, TriangleAlert, Upload, X,
} from 'lucide-react'
import type { MtrLibraryEntry } from '@/lib/data/provider'
import { collidingHeats, heatFromFilename } from '@/lib/domain/heats'
import {
  ISSUE_LABELS, batchCounts, classifyBatch, fileButtonLabel, heldBackSummary,
} from '@/lib/domain/mtrBatch'
import {
  Button, Card, CardBody, CardHeader, CardTitle, Chip, EmptyState,
  Table, Td, Th, Tr,
} from '@/components/ui/primitives'

const FIELD =
  'rounded-md border border-hairline bg-surface px-2 py-1 text-xs text-ink ' +
  'focus:border-brand-bright focus:outline-none'

type RowState = 'pending' | 'uploading' | 'filed' | 'failed'

type QueuedFile = {
  /** Stable across re-renders and edits; the array index is not. */
  id: string
  file: File
  heat: string
  material: string
  state: RowState
  /** The server's word on this row, success or failure. */
  message?: string
}

let nextId = 0

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
  const [queue, setQueue] = useState<QueuedFile[]>([])
  const [mill, setMill] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /** The one place a filename is allowed to speak. */
  function addFiles(chosen: FileList | null) {
    if (!chosen || chosen.length === 0) return
    setError(null)
    setQueue((prev) => {
      // Picking the same folder twice is an easy slip, and a file already
      // in the list is not a second certificate.
      const already = new Set(prev.map((q) => `${q.file.name}:${q.file.size}`))
      const added: QueuedFile[] = []
      for (const file of Array.from(chosen)) {
        if (already.has(`${file.name}:${file.size}`)) continue
        added.push({
          id: `q${nextId++}`,
          file,
          heat: heatFromFilename(file.name) ?? '',
          material: '',
          state: 'pending',
        })
      }
      return [...prev, ...added]
    })
    if (inputRef.current) inputRef.current.value = ''
  }

  function edit(id: string, patch: Partial<QueuedFile>) {
    setQueue((prev) => prev.map((q) => (q.id === id ? { ...q, ...patch } : q)))
  }

  function remove(id: string) {
    setQueue((prev) => prev.filter((q) => q.id !== id))
  }

  /** Rows the server has accepted have nothing left to do. */
  function clearFiled() {
    setQueue((prev) => prev.filter((q) => q.state !== 'filed'))
  }

  // Only rows still waiting are judged. A row already filed should not
  // start reading as a duplicate of the row that failed beside it.
  const pending = queue.filter((q) => q.state === 'pending' || q.state === 'failed')
  const batchRows = pending.map((q) => ({ filename: q.file.name, heat: q.heat }))
  const issues = classifyBatch(batchRows)
  const issueById = new Map(pending.map((q, i) => [q.id, issues[i] ?? null]))
  const counts = batchCounts(batchRows)

  async function fileBatch() {
    const sendable = pending.filter((q) => issueById.get(q.id) === null)
    if (sendable.length === 0) return
    setBusy(true); setError(null)

    for (const row of sendable) {
      edit(row.id, { state: 'uploading', message: undefined })
      try {
        const body = new FormData()
        body.append('file', row.file)
        body.append('heatNumber', row.heat.trim())
        if (row.material.trim()) body.append('materialDescription', row.material.trim())
        if (mill.trim()) body.append('millName', mill.trim())

        const res = await fetch('/api/mtr', { method: 'POST', body })
        const json = await res.json()

        if (json.ok) {
          const n = json.heatsResolved ?? 0
          edit(row.id, {
            state: 'filed',
            message: n > 0
              ? `Filed — ${n} heat${n === 1 ? '' : 's'} now reads “on file”`
              : 'Filed — no job book references it yet',
          })
        } else {
          edit(row.id, { state: 'failed', message: json.error ?? 'That did not go through.' })
        }
      } catch {
        // One failure does not stop the queue. The rest of the folder is
        // still worth filing, and this row keeps its reason.
        edit(row.id, { state: 'failed', message: 'Could not reach the server.' })
      }
    }

    setBusy(false)
    router.refresh()
  }

  const filed = queue.filter((q) => q.state === 'filed').length
  const failed = queue.filter((q) => q.state === 'failed').length
  const collisions = collidingHeats(entries.map((e) => e.heatNumber))

  return (
    <div className="space-y-4">
      {canUpload && (
        <Card>
          <CardHeader><CardTitle>File mill certificates</CardTitle></CardHeader>
          <CardBody className="space-y-3">
            <p className="text-xs leading-relaxed text-ink-secondary">
              One certificate per heat number, shared by every job book. Choose a whole folder
              at once — each heat number is suggested from its filename for you to check.
              Upload a certificate once and every book that references that heat resolves to
              it, including books that referenced it before it arrived.
            </p>

            <div className="flex flex-wrap items-center gap-2">
              <input ref={inputRef} type="file" accept=".pdf,application/pdf" multiple
                     className="hidden"
                     onChange={(e) => addFiles(e.target.files)} />
              <Button variant="secondary" onClick={() => inputRef.current?.click()}>
                <FileUp size={13} /> {queue.length > 0 ? 'Add more' : 'Choose certificates'}
              </Button>
              {queue.length > 0 && (
                <label className="flex items-center gap-1.5 text-2xs text-ink-secondary">
                  Mill (optional, applies to all)
                  <input className={FIELD} value={mill} disabled={busy}
                         onChange={(e) => setMill(e.target.value)} />
                </label>
              )}
            </div>

            {queue.length > 0 && (
              <div className="space-y-3 rounded-md border border-hairline p-3">
                <p className="text-2xs leading-relaxed text-ink-secondary">
                  <strong className="text-ink">Check each heat number against its certificate.</strong>{' '}
                  They are suggested from filenames, not read from the documents — most mill
                  certificates are scans with no text in them. A wrong heat number files that
                  certificate against the wrong steel, and the book would report the material
                  as traceable.
                </p>

                <div className="overflow-x-auto">
                  <Table>
                    <thead>
                      <Tr>
                        <Th>File</Th><Th>Heat number</Th><Th>Material (optional)</Th>
                        <Th>Status</Th><Th />
                      </Tr>
                    </thead>
                    <tbody>
                      {queue.map((q) => {
                        const issue = issueById.get(q.id) ?? null
                        return (
                          <Tr key={q.id}>
                            <Td className="max-w-[16rem] truncate text-2xs text-ink-secondary"
                                title={q.file.name}>
                              {q.file.name}
                            </Td>
                            <Td>
                              <input
                                className={`${FIELD} w-32 font-mono ${
                                  issue ? 'border-status-critical/60' : ''
                                }`}
                                value={q.heat}
                                disabled={busy || q.state === 'filed'}
                                onChange={(e) => edit(q.id, { heat: e.target.value })}
                                // An example heat here reads as a value
                                // that was entered and refused, since the
                                // placeholder is only ever visible on a
                                // row that is blocked for being empty.
                                placeholder="Read it off"
                              />
                            </Td>
                            <Td>
                              <input
                                className={`${FIELD} w-40`}
                                value={q.material}
                                disabled={busy || q.state === 'filed'}
                                onChange={(e) => edit(q.id, { material: e.target.value })}
                                // No example: the column heading already
                                // says what this is, and the same hint
                                // repeated down every row is noise in a
                                // table somebody is scanning for problems.
                              />
                            </Td>
                            <Td className="text-2xs">
                              <RowStatus state={q.state} issue={issue} message={q.message} />
                            </Td>
                            <Td className="text-right">
                              {q.state !== 'uploading' && (
                                <button type="button" onClick={() => remove(q.id)}
                                        disabled={busy}
                                        aria-label={`Remove ${q.file.name}`}
                                        className="text-ink-muted hover:text-ink">
                                  <X size={13} />
                                </button>
                              )}
                            </Td>
                          </Tr>
                        )
                      })}
                    </tbody>
                  </Table>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <Button variant="primary" disabled={busy || counts.ready === 0}
                          onClick={() => void fileBatch()}>
                    {busy ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
                    {busy ? 'Filing…' : fileButtonLabel(counts)}
                  </Button>
                  {filed > 0 && !busy && (
                    <Button variant="ghost" onClick={clearFiled}>
                      Clear {filed} filed
                    </Button>
                  )}
                  {heldBackSummary(counts) && (
                    <span className="text-2xs text-ink-secondary">{heldBackSummary(counts)}</span>
                  )}
                </div>

                {!busy && (filed > 0 || failed > 0) && (
                  <p className="text-2xs text-ink-secondary">
                    {filed > 0 && `${filed} filed.`}{' '}
                    {failed > 0 && `${failed} did not go through — the reason is on each row.`}
                  </p>
                )}
              </div>
            )}

            {error && (
              <p className="rounded-md border border-status-critical/30 bg-status-critical/10 px-3 py-2 text-xs text-status-critical">
                {error}
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
                  : 'Upload mill certificates above. Each only has to be filed once, however many job books use that heat.'}
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

/** One row's state, in the fewest words that still say what to do next. */
function RowStatus({
  state, issue, message,
}: {
  state: RowState
  issue: ReturnType<typeof classifyBatch>[number]
  message?: string
}) {
  if (state === 'uploading') {
    return (
      <span className="inline-flex items-center gap-1 text-ink-secondary">
        <Loader2 size={12} className="animate-spin" /> Filing…
      </span>
    )
  }
  if (state === 'filed') {
    return (
      <span className="inline-flex items-center gap-1 text-status-complete">
        <Check size={12} /> {message ?? 'Filed'}
      </span>
    )
  }
  if (state === 'failed') {
    return <span className="text-status-critical">{message ?? 'Did not go through'}</span>
  }
  if (issue) {
    return (
      <span className="inline-flex items-center gap-1 text-status-critical">
        <TriangleAlert size={12} /> {ISSUE_LABELS[issue]}
      </span>
    )
  }
  return <span className="text-ink-muted">Ready</span>
}
