'use client'

/**
 * Importing the Torque Log (§14).
 *
 * Read, then look, then commit — the same three steps as §11 and §12,
 * because the one thing a bulk import must never do is surprise the
 * person who ran it.
 *
 * What is different here is where the compliance content sits. A weld
 * log's news is its welder stamps; a torque log's news is its WRENCH
 * IDS. §11.1 makes a connection torqued with an uncalibrated wrench a
 * Critical finding, so an id the controlled register does not know is
 * not a tidy-up item — it is the finding, and it is shown before any
 * count of rows.
 *
 * A wrench id one character from a rostered one is named as a probable
 * typo and never corrected. Silently rewriting a compliance record is
 * worse than the typo, because the typo is visible.
 */
import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { AlertTriangle, FileUp, Info, Loader2, TriangleAlert, Upload } from 'lucide-react'
import type { TorqueLogImportPreview, TorqueLogImportResult } from '@/lib/data/provider'
import {
  Button, Card, CardBody, CardHeader, CardTitle, Chip, Metric, Table, Td, Th, Tr,
} from '@/components/ui/primitives'

const SEVERITY = {
  critical: { tone: 'critical' as const, icon: <AlertTriangle size={12} />, label: 'Critical' },
  warning: { tone: 'progress' as const, icon: <TriangleAlert size={12} />, label: 'Warning' },
  info: { tone: 'info' as const, icon: <Info size={12} />, label: 'Info' },
}

export function TorqueLogImport({ bookId, canUpload }: { bookId: string; canUpload: boolean }) {
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState<'preview' | 'commit' | null>(null)
  const [preview, setPreview] = useState<TorqueLogImportPreview | null>(null)
  const [result, setResult] = useState<TorqueLogImportResult | null>(null)
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
        `/api/books/${bookId}/import/torque-log${commit ? '?commit=1' : ''}`,
        { method: 'POST', body },
      )
      const json = await res.json()
      if (!json.ok) { setError(json.error ?? 'That did not go through.'); return }
      if (commit) { setResult(json as TorqueLogImportResult); router.refresh() }
      else setPreview(json as TorqueLogImportPreview)
    } catch {
      setError('Could not reach the server.')
    } finally {
      setBusy(null)
    }
  }

  const plan = preview?.plan
  const unresolved = plan?.wrenches.filter((w) => w.action === 'unresolved') ?? []
  const lapsed = plan?.wrenches.filter((w) => w.calibrationValid === false) ?? []

  return (
    <Card>
      <CardHeader><CardTitle>Import the Torque Log</CardTitle></CardHeader>
      <CardBody className="space-y-4">
        <p className="text-xs text-ink-secondary">
          Reads every flange connection — required range, applied torque, wrench, who torqued it
          and who inspected it — from a workbook or a PDF export of one. Nothing is written until
          you have seen what it found. Load the wrench register and its calibration certificates
          on §13 first: a wrench id has to resolve to something for the §11.1 check to be possible
          at all.
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
            Imported. {result.connectionsCreated} connection
            {result.connectionsCreated === 1 ? '' : 's'} created,
            {' '}{result.connectionsUpdated} updated.
          </p>
        )}

        {plan && (
          <div className="space-y-4">
            {plan.findings.length > 0 && (
              <div>
                <h4 className="mb-2 text-2xs font-semibold uppercase tracking-wide text-ink-secondary">
                  What this log says about itself ({plan.findings.length})
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

            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Metric label="Rows read" value={plan.parsedRows}
                      sub={`${plan.format.toUpperCase()} · ${plan.sheetsParsed.length || 1} sheet${plan.sheetsParsed.length === 1 ? '' : 's'}`} />
              <Metric label="Connections to create" value={plan.connectionsToCreate} />
              <Metric label="Connections to update" value={plan.connectionsToUpdate}
                      sub={plan.connectionsToUpdate > 0 ? 'matched by ISO and flange' : undefined} />
              <Metric label="Rows rejected" value={plan.rejectedRows}
                      tone={plan.rejectedRows > 0 ? 'critical' : undefined}
                      sub={plan.rejectedRows > 0 ? 'not importable' : undefined} />
            </div>

            {unresolved.length > 0 && (
              <p className="rounded-md border border-status-critical/30 bg-status-critical/10 px-3 py-2 text-xs text-status-critical">
                {unresolved.length} wrench id{unresolved.length === 1 ? '' : 's'} on this log
                {unresolved.length === 1 ? ' does' : ' do'} not resolve to the controlled register:
                {' '}{unresolved.map((w) => `${w.code} (${w.connections})`).join(', ')}. Those
                connections import with no wrench attached, and §11.1 cannot be satisfied for them
                until the register holds the wrench and its certificate.
              </p>
            )}

            <div>
              <h4 className="mb-2 text-2xs font-semibold uppercase tracking-wide text-ink-secondary">
                Wrench ids
              </h4>
              <div className="overflow-x-auto">
                <Table>
                  <thead>
                    <Tr>
                      <Th>Id on the log</Th>
                      <Th className="text-right">Connections</Th>
                      <Th>In the register</Th>
                      <Th>Calibration on the days used</Th>
                    </Tr>
                  </thead>
                  <tbody>
                    {plan.wrenches.map((w) => (
                      <Tr key={w.code}>
                        <Td className="tnum">{w.code}</Td>
                        <Td className="tnum text-right">{w.connections}</Td>
                        <Td>
                          {w.action === 'match' ? (
                            <Chip tone="complete">Matched</Chip>
                          ) : (
                            <span className="flex flex-wrap items-center gap-1.5">
                              <Chip tone="critical">Not found</Chip>
                              {w.probableTypo && (
                                <span className="text-2xs text-ink-secondary">
                                  did you mean {w.probableTypo}?
                                </span>
                              )}
                            </span>
                          )}
                        </Td>
                        <Td>
                          {w.action !== 'match' ? (
                            <span className="text-ink-muted">—</span>
                          ) : w.calibrationValid === false ? (
                            <Chip tone="critical">Lapsed on at least one</Chip>
                          ) : (
                            <Chip tone="complete">Valid</Chip>
                          )}
                        </Td>
                      </Tr>
                    ))}
                  </tbody>
                </Table>
              </div>
              {lapsed.length > 0 && (
                <p className="mt-2 text-2xs text-ink-secondary">
                  Calibration is checked against every date the wrench was used, not the latest
                  one. A wrench calibrated in March covers a connection torqued in April and does
                  not cover one torqued in January.
                </p>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2 border-t border-hairline pt-3">
              <Button onClick={() => send(true)} disabled={!canUpload || busy !== null}>
                {busy === 'commit' ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
                Import {plan.parsedRows} connection{plan.parsedRows === 1 ? '' : 's'}
              </Button>
              <span className="text-2xs text-ink-secondary">
                Connections are keyed by ISO number and flange, so re-importing a corrected log
                updates these rows rather than filing a second copy beside them.
              </span>
            </div>
          </div>
        )}
      </CardBody>
    </Card>
  )
}
