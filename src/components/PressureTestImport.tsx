'use client'

/**
 * Importing the pressure test hold sheet (§17).
 *
 * §17 is the section the baseline review found in the worst state: 13 of
 * 21 facility packages held instrument certificates and no result
 * document, and the book could not tell, because a pressure test existed
 * only as a folder of PDFs.
 *
 * Two things this preview says that the others do not need to. First,
 * that the reader does not decide pass or fail — a hold ending below
 * where it started is reported and left for the result document to
 * settle, because ambient temperature moves a reading. Second, which
 * numbered rows it refused to import, because a template ships blank
 * rows pre-numbered and importing them would invent tests that never
 * happened.
 */
import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { FileUp, Loader2, TriangleAlert, Upload } from 'lucide-react'
import type {
  PressureTestImportCommit, PressureTestImportPreview,
} from '@/lib/data/provider'
import {
  Button, Card, CardBody, CardHeader, CardTitle, Chip, Metric, Table, Td, Th, Tr,
} from '@/components/ui/primitives'

export function PressureTestImport({
  bookId, canUpload,
}: { bookId: string; canUpload: boolean }) {
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState<'preview' | 'commit' | null>(null)
  const [preview, setPreview] = useState<PressureTestImportPreview | null>(null)
  const [result, setResult] = useState<PressureTestImportCommit | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function send(commit: boolean) {
    if (!file) return
    setBusy(commit ? 'commit' : 'preview')
    setError(null)
    if (!commit) { setPreview(null); setResult(null) }
    try {
      const body = new FormData()
      body.append('file', file)
      const res = await fetch(
        `/api/books/${bookId}/import/pressure-tests${commit ? '?commit=1' : ''}`,
        { method: 'POST', body },
      )
      const json = await res.json()
      if (!json.ok) { setError(json.error ?? 'That did not go through.'); return }
      if (commit) { setResult(json as PressureTestImportCommit); router.refresh() }
      else setPreview(json as PressureTestImportPreview)
    } catch {
      setError('Could not reach the server.')
    } finally {
      setBusy(null)
    }
  }

  const plan = preview?.plan

  return (
    <Card>
      <CardHeader><CardTitle>Import the pressure test hold sheet</CardTitle></CardHeader>
      <CardBody className="space-y-4">
        <p className="text-xs text-ink-secondary">
          Reads one row per test — the date, the hold duration, the start and end pressures and
          the ambient temperature — from a workbook or a PDF export of one. It does not decide
          pass or fail and does not attach a certificate it has not seen; those come from the
          result document and §13, and the book reports the gap until they do.
        </p>

        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={inputRef}
            type="file"
            accept=".xlsx,.xlsm,.xls,.pdf,application/pdf"
            className="hidden"
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null)
              setPreview(null); setResult(null); setError(null)
            }}
          />
          <Button variant="secondary" onClick={() => inputRef.current?.click()} disabled={!canUpload}>
            <FileUp size={13} /> Choose a workbook or PDF
          </Button>
          {file && <span className="text-xs text-ink-secondary">{file.name}</span>}
          <Button onClick={() => send(false)} disabled={!file || !canUpload || busy !== null}>
            {busy === 'preview' ? <Loader2 size={13} className="animate-spin" /> : null}
            Read it
          </Button>
        </div>

        {error && (
          <p className="rounded-md border border-status-critical/30 bg-status-critical/10 px-3 py-2 text-xs text-status-critical">
            {error}
          </p>
        )}

        {result && (
          <p className="rounded-md border border-status-complete/30 bg-status-complete/10 px-3 py-2 text-xs text-status-complete">
            Imported. {result.testsCreated} test{result.testsCreated === 1 ? '' : 's'} created,
            {' '}{result.testsUpdated} updated.
          </p>
        )}

        {plan && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Metric label="Tests read" value={plan.parsedRows}
                      sub={`${plan.format.toUpperCase()} · ${plan.sheetsParsed.length || 1} sheet${plan.sheetsParsed.length === 1 ? '' : 's'}`} />
              <Metric label="To create" value={plan.testsToCreate} />
              <Metric label="To update" value={plan.testsToUpdate}
                      sub={plan.testsToUpdate > 0 ? 'matched by test number' : undefined} />
              <Metric label="Without a date" value={plan.undated}
                      tone={plan.undated > 0 ? 'critical' : undefined}
                      sub={plan.undated > 0 ? '§11.1 cannot check these' : undefined} />
            </div>

            {plan.emptyRows.length > 0 && (
              <div className="rounded-md border border-hairline px-3 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Chip tone="info" icon={<TriangleAlert size={12} />}>Not imported</Chip>
                  <p className="text-xs font-medium text-ink">
                    {plan.emptyRows.length} numbered row
                    {plan.emptyRows.length === 1 ? '' : 's'} record no test
                  </p>
                </div>
                <p className="mt-1 text-2xs text-ink-secondary">
                  Rows {plan.emptyRows.map((e) => e.testIdentifier).join(', ')} are numbered in
                  the sheet but carry no date and no pressure — template placeholders rather than
                  tests that happened. Importing them would add
                  {' '}{plan.emptyRows.length} test{plan.emptyRows.length === 1 ? '' : 's'} to
                  this book that nobody performed, so they are named here and left out.
                </p>
              </div>
            )}

            {plan.pressureDropped > 0 && (
              <div className="rounded-md border border-hairline px-3 py-2">
                <p className="text-xs font-medium text-ink">
                  {plan.pressureDropped} hold{plan.pressureDropped === 1 ? '' : 's'} ended below
                  the starting pressure
                </p>
                <p className="mt-1 text-2xs text-ink-secondary">
                  Reported, not judged. Ambient temperature moves a reading, and §17&rsquo;s
                  acceptance criteria belong to the test procedure rather than to arithmetic on
                  two numbers. The result document in each pack settles it.
                </p>
              </div>
            )}

            {plan.issues.length > 0 && (
              <div>
                <h4 className="mb-2 text-2xs font-semibold uppercase tracking-wide text-ink-secondary">
                  Rows worth a look ({plan.issues.length})
                </h4>
                <ul className="space-y-1">
                  {plan.issues.slice(0, 20).map((i, n) => (
                    <li key={`${i.row}-${n}`} className="text-2xs text-ink-secondary">
                      {i.message}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="overflow-x-auto">
              <Table>
                <thead>
                  <Tr>
                    <Th>Test</Th>
                    <Th>Date</Th>
                    <Th className="text-right">Hold (min)</Th>
                    <Th className="text-right">Start psi</Th>
                    <Th className="text-right">End psi</Th>
                    <Th className="text-right">Temp °F</Th>
                  </Tr>
                </thead>
                <tbody>
                  {plan.rows.slice(0, 60).map((r) => (
                    <Tr key={`${r.rowNumber}-${r.testIdentifier}`}>
                      <Td>{r.testIdentifier}</Td>
                      <Td className="tnum">
                        {r.testDate ?? <span className="text-status-critical">none</span>}
                      </Td>
                      <Td className="tnum text-right">{r.durationMinutes ?? '—'}</Td>
                      <Td className="tnum text-right">{r.startPressurePsi ?? '—'}</Td>
                      <Td className="tnum text-right">
                        {r.endPressurePsi ?? '—'}
                        {r.startPressurePsi != null && r.endPressurePsi != null &&
                          r.endPressurePsi < r.startPressurePsi
                          ? <span className="ml-1 text-ink-muted">↓</span> : null}
                      </Td>
                      <Td className="tnum text-right">{r.ambientTempF ?? '—'}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
              {plan.rows.length > 60 && (
                <p className="px-1 py-2 text-2xs text-ink-muted">
                  Showing 60 of {plan.rows.length}.
                </p>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2 border-t border-hairline pt-3">
              <Button onClick={() => send(true)} disabled={!canUpload || busy !== null}>
                {busy === 'commit' ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
                Import {plan.parsedRows} test{plan.parsedRows === 1 ? '' : 's'}
              </Button>
              <span className="text-2xs text-ink-secondary">
                Tests are keyed by their identifier, so re-importing a corrected sheet updates
                these rows rather than filing a second copy beside them.
              </span>
            </div>
          </div>
        )}
      </CardBody>
    </Card>
  )
}
