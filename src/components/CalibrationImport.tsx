'use client'

/**
 * Filing torque-wrench calibration certificates.
 *
 * What this screen has to make obvious is that filing a certificate
 * changes the verdict on work already recorded. The connections torqued
 * with a wrench read `certificate unread` until its page is filed and
 * then read valid, or expired, or — the case worth the whole feature —
 * calibrated after the work it is supposed to certify.
 *
 * So the headline is not how many files were read. It is how many
 * findings the batch answers and how many it raises, because that is what
 * a person is deciding about. The per-file table underneath says why each
 * page landed the way it did, in the words somebody would use to go and
 * fix it.
 */
import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { AlertTriangle, Check, FileUp, Loader2, Wrench } from 'lucide-react'
import type {
  CalibrationImportPreview, CalibrationImportResult,
} from '@/lib/data/provider'
import type { CertDisposition, CertMatch } from '@/lib/domain/calibrationPlan'
import {
  Button, Card, CardBody, CardHeader, CardTitle, Chip, Metric,
  Table, Td, Th, Tr,
} from '@/components/ui/primitives'
import { num } from '@/lib/utils'

type Tone = 'complete' | 'progress' | 'critical' | 'idle'

/** What each outcome means, in the terms a person can act on. */
const DISPOSITION: Record<CertDisposition, { label: string; tone: Tone }> = {
  calibration: { label: 'Calibration recorded', tone: 'complete' },
  unread: { label: 'Filed, dates unread', tone: 'progress' },
  failed: { label: 'Laboratory failed it', tone: 'critical' },
  window_reversed: { label: 'Dates out of order', tone: 'critical' },
  superseded: { label: 'Older than the one on file', tone: 'idle' },
}

/** Why a page cannot be attributed to a wrench. */
const MATCH: Record<CertMatch, string> = {
  matched: '',
  new_wrench: 'new wrench record',
  unused: 'not used on this job',
  ambiguous: 'two wrenches share this number',
  no_serial: 'no serial read',
}

/**
 * The outcome chip, which must never overstate what the commit will do.
 *
 * A page with no serial reads as `unread` — that is the honest disposition
 * for a photograph of paper — but nothing is written for it, because there
 * is no wrench to write it against. Showing "filed, dates unread" there
 * told a person a page had been filed when it had not.
 */
function outcome(r: { writable: boolean; disposition: CertDisposition; match: CertMatch }) {
  if (r.writable) return DISPOSITION[r.disposition]
  if (r.match === 'no_serial') return { label: 'Nothing to file it against', tone: 'idle' as Tone }
  if (r.match === 'ambiguous') return { label: 'Cannot tell which wrench', tone: 'critical' as Tone }
  if (r.match === 'unused') return { label: 'Not a wrench this job used', tone: 'idle' as Tone }
  return DISPOSITION[r.disposition]
}

export function CalibrationImport({ bookId }: { bookId: string }) {
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement>(null)

  const [files, setFiles] = useState<File[]>([])
  const [busy, setBusy] = useState<'preview' | 'commit' | null>(null)
  const [preview, setPreview] = useState<CalibrationImportPreview | null>(null)
  const [result, setResult] = useState<CalibrationImportResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  function reset() {
    setPreview(null)
    setResult(null)
    setError(null)
  }

  async function send(commit: boolean) {
    if (files.length === 0) return
    setBusy(commit ? 'commit' : 'preview')
    setError(null)
    try {
      const body = new FormData()
      for (const f of files) body.append('files', f)
      const res = await fetch(
        `/api/books/${bookId}/import/calibration${commit ? '?commit=1' : ''}`,
        { method: 'POST', body },
      )
      const json = await res.json()
      if (commit) {
        if (!json.ok) { setError(json.error ?? 'That did not go through.'); return }
        setResult(json)
        setPreview(null)
        setFiles([])
        if (inputRef.current) inputRef.current.value = ''
        router.refresh()
      } else {
        setPreview(json)
        setResult(null)
        if (!json.ok) setError(json.error ?? 'Those certificates could not be read.')
      }
    } catch {
      setError('Could not reach the server.')
    } finally {
      setBusy(null)
    }
  }

  const counts = preview?.counts
  const rows = preview?.plan?.rows ?? []

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader><CardTitle>File calibration certificates</CardTitle></CardHeader>
        <CardBody className="space-y-3">
          <p className="text-xs leading-relaxed text-ink-secondary">
            The certificate is the calibration record. Each page is read for its serial, its
            calibration and due dates and the laboratory&rsquo;s verdict, and matched to a
            wrench by the last four digits of the serial — the way the torque log names them.
            Choose the whole section 13 tab at once; a scan holding several certificates is
            read page by page.
          </p>

          <div className="flex flex-wrap items-center gap-2">
            <input ref={inputRef} type="file" multiple accept=".pdf,application/pdf"
                   className="hidden"
                   onChange={(e) => {
                     setFiles(Array.from(e.target.files ?? []))
                     reset()
                   }} />
            <Button variant="secondary" onClick={() => inputRef.current?.click()}>
              <FileUp size={13} /> Choose certificates
            </Button>
            {files.length > 0 && (
              <span className="text-xs text-ink-secondary">
                {files.length === 1 ? files[0]!.name : `${files.length} files`}
              </span>
            )}
            {files.length > 0 && !preview && (
              <Button variant="primary" disabled={busy !== null} onClick={() => void send(false)}>
                {busy === 'preview' ? <Loader2 size={13} className="animate-spin" /> : null}
                Read them
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
                {result.wrenchesUpdated + result.wrenchesCreated} wrench
                {result.wrenchesUpdated + result.wrenchesCreated === 1 ? '' : 'es'} updated
                {result.wrenchesCreated > 0 && `, ${result.wrenchesCreated} newly recorded`}.
              </div>
              <div className="mt-1 text-ink-secondary">
                {result.connectionsResolved > 0 &&
                  `${result.connectionsResolved} connection${result.connectionsResolved === 1 ? '' : 's'} can now be checked against a calibration window. `}
                {result.connectionsExposed > 0 &&
                  `${result.connectionsExposed} are left uncertified — they are in the flag queue. `}
                {result.held > 0 &&
                  `${result.held} certificate${result.held === 1 ? '' : 's'} wrote nothing and need you.`}
              </div>
            </div>
          )}
        </CardBody>
      </Card>

      {counts && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
            <Metric label="Certificates read" value={num(counts.files)} />
            <Metric
              label="Calibration windows" value={num(counts.calibrations)} tone="complete"
              sub={counts.wrenchesCreated > 0
                ? `${counts.wrenchesCreated} wrench record${counts.wrenchesCreated === 1 ? '' : 's'} created`
                : undefined}
            />
            <Metric
              label="Findings this answers"
              value={num(counts.connectionsResolved)}
              tone={counts.connectionsResolved > 0 ? 'complete' : 'idle'}
              sub="connections whose calibration can now be checked"
            />
            <Metric
              label="Findings this raises"
              value={num(counts.connectionsExposed)}
              tone={counts.connectionsExposed > 0 ? 'critical' : 'complete'}
              sub="connections these pages leave uncertified"
            />
            <Metric
              label="Left for you"
              value={num(counts.held)}
              tone={counts.held > 0 ? 'progress' : 'complete'}
              sub="pages that write nothing as they stand"
            />
          </div>

          {counts.connectionsExposed > 0 && (
            <Card>
              <CardBody>
                <div className="text-xs font-medium text-ink">
                  Filing these raises {num(counts.connectionsExposed)} finding
                  {counts.connectionsExposed === 1 ? '' : 's'}, and that is the right outcome
                </div>
                <p className="mt-1 text-2xs leading-relaxed text-ink-secondary">
                  Those connections were torqued outside a calibration window — or with a
                  wrench the laboratory failed — whether or not the certificate is on file.
                  Filing it is what lets the book say so, in time to re-torque rather than at
                  an operator&rsquo;s audit.
                </p>
              </CardBody>
            </Card>
          )}

          <Card>
            <CardHeader className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle>Each certificate, and what it does</CardTitle>
              <span className="text-2xs text-ink-muted">
                Nothing is written on a wrench this book cannot identify
              </span>
            </CardHeader>
            <CardBody className="p-0">
              <Table>
                <thead>
                  <tr>
                    <Th>File</Th><Th>Wrench</Th><Th>Calibrated</Th><Th>Due</Th>
                    <Th className="text-right">Connections</Th><Th>Outcome</Th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => {
                    const d = outcome(r)
                    const qualifier = MATCH[r.match]
                    return (
                      <Tr key={i}>
                        <Td className="max-w-[18rem] truncate text-ink-secondary" title={r.filename}>
                          {r.filename}
                        </Td>
                        <Td className="whitespace-nowrap">
                          <span className="tnum font-mono font-medium">{r.wrenchId ?? '—'}</span>
                          {r.serialNumber && r.serialNumber !== r.wrenchId && (
                            <div className="tnum font-mono text-2xs text-ink-muted">
                              serial {r.serialNumber}
                            </div>
                          )}
                        </Td>
                        <Td className="tnum whitespace-nowrap font-mono text-ink-secondary">
                          {r.dateCalibrated ?? '—'}
                        </Td>
                        <Td className="tnum whitespace-nowrap font-mono text-ink-secondary">
                          {r.calibrationDueDate ?? '—'}
                        </Td>
                        <Td className="whitespace-nowrap text-right">
                          <span className="tnum font-mono text-ink-secondary">
                            {r.effect.connections > 0 ? num(r.effect.connections) : '—'}
                          </span>
                          {r.effect.resolved > 0 && (
                            <div className="text-2xs text-status-complete">
                              {num(r.effect.resolved)} settled
                            </div>
                          )}
                          {r.effect.exposed > 0 && (
                            <div className="text-2xs text-status-critical">
                              {num(r.effect.exposed)} uncertified
                            </div>
                          )}
                        </Td>
                        <Td>
                          <Chip tone={d.tone}>{d.label}</Chip>
                          {qualifier && (
                            <div className="mt-0.5 text-2xs text-ink-muted">{qualifier}</div>
                          )}
                        </Td>
                      </Tr>
                    )
                  })}
                </tbody>
              </Table>
            </CardBody>
          </Card>

          {rows.some((r) => r.notes.length > 0) && (
            <Card>
              <CardHeader><CardTitle>What each page needs</CardTitle></CardHeader>
              <CardBody className="space-y-2.5">
                {rows.filter((r) => r.notes.length > 0).map((r, i) => (
                  <div key={i}>
                    <div className="text-xs font-medium text-ink">{r.filename}</div>
                    {r.notes.map((n, j) => (
                      <p key={j} className="mt-0.5 text-2xs leading-relaxed text-ink-secondary">
                        {n}
                      </p>
                    ))}
                  </div>
                ))}
              </CardBody>
            </Card>
          )}

          {counts.writes > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="primary" disabled={busy !== null} onClick={() => void send(true)}>
                {busy === 'commit'
                  ? <Loader2 size={13} className="animate-spin" />
                  : <Wrench size={13} />}
                File {num(counts.writes)} certificate{counts.writes === 1 ? '' : 's'}
              </Button>
              {counts.held > 0 && (
                <span className="text-2xs text-ink-muted">
                  {num(counts.held)} held back — nothing is written for them
                </span>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}
