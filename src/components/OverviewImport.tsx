'use client'

/**
 * Importing the Weld Log Overview Sheet.
 *
 * The screen is built around the gap between what a file says and what it
 * would change. A tech drops the sheet in; before anything is written they
 * see three things: what the application read off it, what it would do to
 * the registers, and what it found wrong. Only then is there a button.
 *
 * The findings are not a footnote. On the DP-318 sheet this reads nine of
 * them off a single page — three welds attributed to no welder, a coverage
 * figure above 100%, a welder with no qualification expiry — and every one
 * is worth more than the import itself.
 */
import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { AlertTriangle, FileUp, Info, Loader2, TriangleAlert, Upload } from 'lucide-react'
import type { OverviewImportPreview, OverviewImportResult } from '@/lib/data/provider'
import {
  Button, Card, CardBody, CardHeader, CardTitle, Chip, Table, Td, Th, Tr,
} from '@/components/ui/primitives'
import { cn } from '@/lib/utils'

const SEVERITY = {
  critical: { tone: 'critical' as const, icon: <AlertTriangle size={12} />, label: 'Critical' },
  warning: { tone: 'progress' as const, icon: <TriangleAlert size={12} />, label: 'Warning' },
  info: { tone: 'info' as const, icon: <Info size={12} />, label: 'Info' },
}

export function OverviewImport({ bookId, canUpload }: { bookId: string; canUpload: boolean }) {
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState<'preview' | 'commit' | null>(null)
  const [preview, setPreview] = useState<OverviewImportPreview | null>(null)
  const [result, setResult] = useState<OverviewImportResult | null>(null)
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
        `/api/books/${bookId}/import/overview${commit ? '?commit=1' : ''}`,
        { method: 'POST', body },
      )
      const json = await res.json()
      if (!json.ok) { setError(json.error ?? 'That did not go through.'); return }
      if (commit) { setResult(json as OverviewImportResult); router.refresh() }
      else setPreview(json as OverviewImportPreview)
    } catch {
      setError('Could not reach the server.')
    } finally {
      setBusy(null)
    }
  }

  const sheet = preview?.sheet
  const plan = preview?.plan

  return (
    <Card>
      <CardHeader>
        <CardTitle>Import the Weld Log Overview Sheet</CardTitle>
      </CardHeader>
      <CardBody className="space-y-4">
        <p className="text-xs text-ink-secondary">
          Reads the welder roster, stamps, WPQ expiry dates and inspection percentages off the
          sheet and files them in the controlled registers (§9.1). Nothing is written until you
          have seen what it found.
        </p>

        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={inputRef}
            type="file"
            accept="application/pdf,.pdf"
            className="hidden"
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null)
              setPreview(null); setResult(null); setError(null)
            }}
          />
          <Button variant="secondary" onClick={() => inputRef.current?.click()} disabled={!canUpload}>
            <FileUp size={13} /> Choose a PDF
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
          <div className="rounded-md border border-status-complete/30 bg-status-complete/10 px-3 py-2 text-xs text-status-complete">
            Imported. {result.weldersCreated} welder{result.weldersCreated === 1 ? '' : 's'} created,
            {' '}{result.weldersMatched} matched to existing register entries,
            {' '}{result.qualificationsRecorded} qualification
            {result.qualificationsRecorded === 1 ? '' : 's'} recorded,
            {' '}{result.peopleCreated} inspector{result.peopleCreated === 1 ? '' : 's'} added.
            {result.skipped.length > 0 && (
              <ul className="mt-2 space-y-1 text-ink-secondary">
                {result.skipped.map((s) => (
                  <li key={s.stamp}>Skipped {s.stamp}: {s.reason}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        {sheet && plan && (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Location" value={sheet.header.locationName} />
              <Field label="Sheet date" value={sheet.header.date} />
              <Field label="Welding company" value={sheet.header.weldingCompany} />
              <Field label="QA/QC representative" value={sheet.header.qaqcRepresentative} />
              <Field label="Operator field on the sheet"
                     value={sheet.header.operatorLabel ? `${sheet.header.operatorLabel} — ${sheet.header.operatorPic ?? ''}` : null} />
              <Field label="Stated requirement" value={sheet.requirement.statedAs} />
            </div>

            {plan.findings.length > 0 && (
              <div>
                <h4 className="mb-2 text-2xs font-semibold uppercase tracking-wide text-ink-secondary">
                  What this sheet says about itself ({plan.findings.length})
                </h4>
                <ul className="space-y-2">
                  {plan.findings.map((f, i) => {
                    const meta = SEVERITY[f.severity]
                    return (
                      <li key={`${f.ruleId}-${i}`} className="rounded-md border border-hairline px-3 py-2">
                        <div className="flex flex-wrap items-start gap-2">
                          <Chip tone={meta.tone} icon={meta.icon}>{meta.label}</Chip>
                          <p className="min-w-[12rem] flex-1 text-xs font-medium text-ink">{f.title}</p>
                        </div>
                        <p className="mt-1 text-2xs text-ink-secondary">{f.detail}</p>
                      </li>
                    )
                  })}
                </ul>
              </div>
            )}

            <div>
              <h4 className="mb-2 text-2xs font-semibold uppercase tracking-wide text-ink-secondary">
                Welder register — {plan.summary.weldersToCreate} to create,
                {' '}{plan.summary.weldersMatched} already on file,
                {' '}{plan.summary.weldersSkipped} skipped
              </h4>
              <div className="overflow-x-auto">
                <Table>
                  <thead>
                    <Tr>
                      <Th>Welder</Th><Th>Stamp</Th><Th>WPQ expires</Th>
                      <Th className="text-right">Welds</Th><Th>Action</Th>
                    </Tr>
                  </thead>
                  <tbody>
                    {plan.welders.map((w) => (
                      <Tr key={`${w.stamp}-${w.name}`}>
                        <Td>{w.name}</Td>
                        <Td className="font-mono">{w.stamp || <span className="text-ink-muted">none</span>}</Td>
                        <Td className="tnum">
                          {w.qualification?.expiryDate ?? (
                            <span className="text-status-critical">not on the sheet</span>
                          )}
                        </Td>
                        <Td className="tnum text-right">{w.weldCount ?? ''}</Td>
                        <Td>
                          <Chip tone={w.action === 'create' ? 'complete' : w.action === 'match' ? 'info' : 'critical'}>
                            {w.action === 'create' ? 'Create'
                              : w.action === 'match' ? `Matched by ${w.matchedBy}` : 'Skip'}
                          </Chip>
                          {w.skipReason && (
                            <p className="mt-1 max-w-sm text-2xs text-ink-secondary">{w.skipReason}</p>
                          )}
                        </Td>
                      </Tr>
                    ))}
                  </tbody>
                </Table>
              </div>
            </div>

            {(plan.cwis.length > 0 || plan.ndtTechnicians.length > 0) && (
              <p className="text-xs text-ink-secondary">
                Inspectors on the sheet: {[...plan.cwis, ...plan.ndtTechnicians]
                  .map((p) => `${p.name} (${p.qualification}${p.action === 'match' ? ', on file' : ''})`)
                  .join(', ')}.
              </p>
            )}

            <ImportAction
              newRecords={plan.summary.weldersToCreate + plan.summary.peopleToCreate}
              qualifications={plan.summary.qualificationsToRecord}
              canUpload={canUpload}
              busy={busy === 'commit'}
              onImport={() => send(true)}
            />
          </div>
        )}
      </CardBody>
    </Card>
  )
}

/**
 * The commit button, and the one case worth wording carefully.
 *
 * Importing the same sheet twice is a no-op by design — every welder
 * matches an existing register entry, so nothing is created. "Import 0
 * records" is technically true and reads like a failure. Saying what
 * actually happened, and why there is nothing to do, is the difference
 * between a tech trusting the import and re-running it three times.
 */
function ImportAction({
  newRecords, qualifications, canUpload, busy, onImport,
}: {
  newRecords: number
  qualifications: number
  canUpload: boolean
  busy: boolean
  onImport: () => void
}) {
  const nothingToDo = newRecords === 0 && qualifications === 0
  return (
    <div className={cn('flex flex-wrap items-center gap-2 border-t border-hairline pt-3')}>
      <Button onClick={onImport} disabled={!canUpload || busy || nothingToDo}>
        {busy ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
        {nothingToDo
          ? 'Already imported'
          : newRecords === 0
            ? `Record ${qualifications} qualification${qualifications === 1 ? '' : 's'}`
            : `Import ${newRecords} record${newRecords === 1 ? '' : 's'}`}
      </Button>
      <span className="text-2xs text-ink-secondary">
        {nothingToDo
          ? 'Every person on this sheet is already in the registers, so importing it again would change nothing.'
          : 'Re-checked against the book as it stands when you press this, not as it stood when this preview was drawn.'}
      </span>
    </div>
  )
}

function Field({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div>
      <div className="text-2xs uppercase tracking-wide text-ink-muted">{label}</div>
      <div className="text-xs text-ink">{value || <span className="text-ink-muted">not on the sheet</span>}</div>
    </div>
  )
}
