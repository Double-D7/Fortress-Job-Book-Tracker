'use client'

/**
 * Filing an NDE report against a book.
 *
 * Two things have to be true on this screen at once. Every exposure the
 * vendor recorded must reach the book, because a job book is incomplete
 * if data is missing — and no radiograph may be attached to a weld
 * nobody chose, because that reports the wrong pipe as examined while
 * the weld actually shot keeps looking unexamined.
 *
 * So the preview is the whole plan, not a summary of it. Rows that
 * something corroborates are filed. Rows that nothing corroborates, rows
 * naming a weld this book does not have, and rows where several welds
 * share the number are listed with the reason, and stay for a person.
 *
 * The gaps are given the same weight as the rows. A page that would not
 * decode is not a footnote here: it is the difference between a section
 * that is evidenced and one that looks evidenced.
 */
import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  AlertTriangle, Check, FileUp, Loader2, TriangleAlert, Upload,
} from 'lucide-react'
import type { NdeImportPreview, NdeImportResult } from '@/lib/data/provider'
import type { PlannedRowStatus } from '@/lib/domain/ndePlan'
import {
  Button, Card, CardBody, CardHeader, CardTitle, Chip, Metric,
  Table, Td, Th, Tr,
} from '@/components/ui/primitives'
import { num } from '@/lib/utils'

/** What each status means, in the terms a person can act on. */
const STATUS: Record<PlannedRowStatus, { label: string; tone: 'ok' | 'warn' | 'bad' }> = {
  confirmed: { label: 'Will be filed', tone: 'ok' },
  unchecked: { label: 'Nothing to check it against', tone: 'warn' },
  unconfirmed: { label: 'Log disagrees', tone: 'bad' },
  ambiguous: { label: 'Several welds share this number', tone: 'bad' },
  unmatched: { label: 'No such weld in this book', tone: 'bad' },
}

export function NdeImport({ bookId }: { bookId: string }) {
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement>(null)

  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState<'preview' | 'commit' | null>(null)
  const [preview, setPreview] = useState<NdeImportPreview | null>(null)
  const [result, setResult] = useState<NdeImportResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function send(commit: boolean) {
    if (!file) return
    setBusy(commit ? 'commit' : 'preview')
    setError(null)
    try {
      const body = new FormData()
      body.append('file', file)
      const res = await fetch(
        `/api/books/${bookId}/import/nde${commit ? '?commit=1' : ''}`,
        { method: 'POST', body },
      )
      const json = await res.json()
      if (commit) {
        if (!json.ok) { setError(json.error ?? 'That did not go through.'); return }
        setResult(json)
        setPreview(null)
        setFile(null)
        if (inputRef.current) inputRef.current.value = ''
        router.refresh()
      } else {
        setPreview(json)
        setResult(null)
        if (!json.ok) setError(json.error ?? 'That report could not be read.')
      }
    } catch {
      setError('Could not reach the server.')
    } finally {
      setBusy(null)
    }
  }

  const counts = preview?.counts
  const gaps = preview?.plan?.gaps ?? []
  const critical = gaps.filter((g) => g.severity === 'critical')

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader><CardTitle>File an inspection report</CardTitle></CardHeader>
        <CardBody className="space-y-3">
          <p className="text-xs leading-relaxed text-ink-secondary">
            The report is read for its own details and its exposure rows, and each row is
            matched to a weld in this book. One file often holds more than one report — a
            magnetic particle sheet and a radiographic one from the same day — and both are
            read.
          </p>

          <div className="flex flex-wrap items-center gap-2">
            <input ref={inputRef} type="file" accept=".pdf,application/pdf" className="hidden"
                   onChange={(e) => {
                     setFile(e.target.files?.[0] ?? null)
                     setPreview(null); setResult(null); setError(null)
                   }} />
            <Button variant="secondary" onClick={() => inputRef.current?.click()}>
              <FileUp size={13} /> Choose a report
            </Button>
            {file && <span className="text-xs text-ink-secondary">{file.name}</span>}
            {file && !preview && (
              <Button variant="primary" disabled={busy !== null} onClick={() => void send(false)}>
                {busy === 'preview' ? <Loader2 size={13} className="animate-spin" /> : null}
                Read it
              </Button>
            )}
          </div>

          {error && (
            <p className="flex items-start gap-2 rounded-md border border-status-critical/30 bg-status-critical/10 px-3 py-2 text-xs text-status-critical">
              <AlertTriangle size={13} className="mt-px shrink-0" />{error}
            </p>
          )}

          {result && (
            <div className="rounded-md border border-status-complete/30 bg-status-complete/10 px-3 py-2 text-xs text-status-complete">
              <div className="flex items-center gap-1.5 font-medium">
                <Check size={13} />
                {result.reportsCreated} report{result.reportsCreated === 1 ? '' : 's'} filed,
                {' '}{result.linesCreated} exposure{result.linesCreated === 1 ? '' : 's'} recorded,
                {' '}{result.weldsLinked} weld{result.weldsLinked === 1 ? '' : 's'} linked.
              </div>
              {(result.rowsHeld > 0 || result.criticalGaps > 0) && (
                <div className="mt-1 text-ink-secondary">
                  {result.rowsHeld > 0 && `${result.rowsHeld} row${result.rowsHeld === 1 ? '' : 's'} not filed. `}
                  {result.criticalGaps > 0 && `${result.criticalGaps} gap${result.criticalGaps === 1 ? '' : 's'} recorded against this book.`}
                </div>
              )}
            </div>
          )}
        </CardBody>
      </Card>

      {counts && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
            <Metric label="Reports in this file" value={num(counts.reports)} />
            <Metric label="Exposure rows" value={num(counts.rows)} />
            <Metric label="Will be filed" value={num(counts.writable)} tone="complete" />
            <Metric
              label="Left for you"
              value={num(counts.rows - counts.writable)}
              tone={counts.rows - counts.writable > 0 ? 'progress' : 'complete'}
              sub="nothing is filed on a match the book cannot back up"
            />
            <Metric
              label="Could not be read"
              value={num(counts.criticalGaps)}
              tone={counts.criticalGaps > 0 ? 'critical' : 'complete'}
              sub="pages or rows this file did not give up"
            />
          </div>

          {critical.length > 0 && (
            <Card>
              <CardHeader className="flex flex-wrap items-center gap-2">
                <Chip tone="critical" icon={<TriangleAlert size={12} />}>Incomplete</Chip>
                <CardTitle>What this file did not give up</CardTitle>
              </CardHeader>
              <CardBody className="space-y-1.5">
                {critical.map((g, i) => (
                  <p key={i} className="text-xs text-ink-secondary">
                    {g.page ? <span className="text-ink">Page {g.page}: </span> : null}
                    {g.detail}
                  </p>
                ))}
                <p className="pt-1 text-2xs leading-relaxed text-ink-muted">
                  These are recorded against the book when the report is filed, so the section
                  reads as incomplete until somebody clears them. Filing is not blocked — a
                  report that covers some welds still evidences those welds.
                </p>
              </CardBody>
            </Card>
          )}

          {(preview?.evidencedButNotLogged?.length ?? 0) > 0 && (
            <Card>
              <CardBody>
                <div className="text-xs font-medium text-ink">
                  Evidenced here, not marked examined in the weld log
                </div>
                <p className="mt-1 text-2xs leading-relaxed text-ink-secondary">
                  Weld {preview!.evidencedButNotLogged!.join(', ')}. Often the report is what
                  the log gets updated from, so this is a prompt rather than a fault — but a
                  report claiming a weld nobody shot is how a book over-reports its coverage.
                </p>
              </CardBody>
            </Card>
          )}

          {preview?.plan?.reports.map((r, ri) => (
            <Card key={ri}>
              <CardHeader className="flex flex-wrap items-baseline justify-between gap-2">
                <CardTitle>
                  {r.reportNumber ?? 'Report with no number'}
                  {r.method ? <span className="ml-2 text-2xs text-ink-muted">{r.method}</span> : null}
                </CardTitle>
                <span className="text-2xs text-ink-secondary">
                  {[r.reportDate ?? 'no date', r.ndtCompany, r.technicianName,
                    r.procedureReference && `${r.procedureReference}${r.revision ? ` rev ${r.revision}` : ''}`,
                    r.acceptanceCriteria].filter(Boolean).join(' · ')}
                </span>
              </CardHeader>
              <CardBody className="p-0">
                <div className="overflow-x-auto">
                  <Table>
                    <thead>
                      <Tr>
                        <Th className="text-right">#</Th><Th>On the report</Th>
                        <Th>Weld</Th><Th>Welder</Th><Th>Finding</Th><Th>Status</Th>
                      </Tr>
                    </thead>
                    <tbody>
                      {r.rows.map((row, i) => {
                        const s = STATUS[row.status]
                        return (
                          <Tr key={i}>
                            <Td className="tnum text-right text-2xs text-ink-muted">{row.sequence ?? '—'}</Td>
                            <Td className="font-mono text-2xs">{row.printed}</Td>
                            <Td className="font-mono text-2xs">{row.weldNumber ?? '—'}</Td>
                            <Td className="text-2xs text-ink-secondary">{row.welderStamp ?? '—'}</Td>
                            <Td className="text-2xs text-ink-secondary">{row.discontinuity ?? '—'}</Td>
                            <Td className={`text-2xs ${
                              s.tone === 'ok' ? 'text-status-complete'
                                : s.tone === 'warn' ? 'text-status-progress'
                                  : 'text-status-critical'}`}>
                              {s.label}
                            </Td>
                          </Tr>
                        )
                      })}
                    </tbody>
                  </Table>
                </div>
              </CardBody>
            </Card>
          ))}

          {preview?.ok && (
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="primary" disabled={busy !== null} onClick={() => void send(true)}>
                {busy === 'commit'
                  ? <Loader2 size={13} className="animate-spin" />
                  : <Upload size={13} />}
                File {counts.reports} report{counts.reports === 1 ? '' : 's'} and {counts.writable} exposure{counts.writable === 1 ? '' : 's'}
              </Button>
              {counts.rows > counts.writable && (
                <span className="text-2xs text-ink-secondary">
                  The other {counts.rows - counts.writable} stay unfiled until somebody resolves them.
                </span>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}
