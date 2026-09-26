'use client'

/**
 * Importing the Detailed Weld Log (§12).
 *
 * Same shape as the overview import and for the same reason: read, then
 * look, then commit. What differs is scale. The overview sheet is ten rows
 * and every one is a person; this is the population — twelve hundred rows
 * on a facility book — so the preview reports in aggregate and names
 * individual rows only where a row is the problem.
 *
 * The findings are shown above the counts on purpose. "1,256 welds will be
 * created" is not the news; "3 of them carry no welder stamp" is.
 */
import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { AlertTriangle, FileUp, Info, Loader2, TriangleAlert, Upload } from 'lucide-react'
import type { WeldLogImportPreview, WeldLogImportResult } from '@/lib/data/provider'
import {
  Button, Card, CardBody, CardHeader, CardTitle, Chip, Metric, Table, Td, Th, Tr,
} from '@/components/ui/primitives'

const SEVERITY = {
  critical: { tone: 'critical' as const, icon: <AlertTriangle size={12} />, label: 'Critical' },
  warning: { tone: 'progress' as const, icon: <TriangleAlert size={12} />, label: 'Warning' },
  info: { tone: 'info' as const, icon: <Info size={12} />, label: 'Info' },
}

export function WeldLogImport({ bookId, canUpload }: { bookId: string; canUpload: boolean }) {
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState<'preview' | 'commit' | null>(null)
  const [preview, setPreview] = useState<WeldLogImportPreview | null>(null)
  const [result, setResult] = useState<WeldLogImportResult | null>(null)
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
        `/api/books/${bookId}/import/weld-log${commit ? '?commit=1' : ''}`,
        { method: 'POST', body },
      )
      const json = await res.json()
      if (!json.ok) { setError(json.error ?? 'That did not go through.'); return }
      if (commit) { setResult(json as WeldLogImportResult); router.refresh() }
      else setPreview(json as WeldLogImportPreview)
    } catch {
      setError('Could not reach the server.')
    } finally {
      setBusy(null)
    }
  }

  const plan = preview?.plan
  const unresolved = plan?.stamps.filter((s) => s.action === 'unresolved') ?? []

  return (
    <Card>
      <CardHeader><CardTitle>Import the Detailed Weld Log</CardTitle></CardHeader>
      <CardBody className="space-y-4">
        <p className="text-xs text-ink-secondary">
          Reads every weld row — number, date, welder, joint type, inspection result — from a
          workbook or a PDF export of one. Both weld log templates are read: the facility log,
          which is one table however many tabs it is split across, and the flowline log, which
          is one sheet per line. Nothing is written until you have seen what it
          found. Import the overview sheet on §11 first: the welder register is what a stamp has to
          resolve to.
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
            Imported. {result.weldsCreated} weld{result.weldsCreated === 1 ? '' : 's'} created,
            {' '}{result.weldsUpdated} updated,
            {' '}{result.weldLinesCreated}
            {' '}{plan?.template === 'flowline' ? 'line' : 'construction area'}
            {result.weldLinesCreated === 1 ? '' : 's'} added.
          </p>
        )}

        {plan && (
          <div className="space-y-4">
            {/*
              Which of the two templates this was read as, and why. A
              flowline log read as a facility one used to report success
              while throwing away the line codes, so the routing decision
              is stated rather than left for somebody to infer from a
              weld count that looks plausible.
            */}
            <p className="rounded-md border border-hairline bg-surface-raised px-3 py-2 text-2xs leading-relaxed text-ink-secondary">
              <span className="font-medium text-ink">
                {plan.template === 'flowline' ? 'Flowline log' : 'Facility log'}
              </span>
              {' — '}{plan.templateReason}
            </p>

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
                      sub={`${plan.format.toUpperCase()} · ${plan.sheetsParsed.length} sheet${plan.sheetsParsed.length === 1 ? '' : 's'}`} />
              <Metric label="Welds to create" value={plan.weldsToCreate} />
              <Metric label="Welds to update" value={plan.weldsToUpdate}
                      sub={plan.weldsToUpdate === 0 ? undefined
                        : plan.template === 'flowline'
                          // Weld numbers restart on every line here, so the
                          // number alone does not identify a weld.
                          ? 'matched by line and weld number'
                          : 'matched by weld number'} />
              <Metric label="Rows rejected" value={plan.rejectedRows}
                      tone={plan.rejectedRows > 0 ? 'critical' : undefined}
                      sub={plan.rejectedRows > 0 ? 'not importable' : undefined} />
              {/*
                The heat number is the only link from a weld to the mill
                certificate for the pipe in it, so this count is what §15
                will be measured against. The facility template has no
                heat column, so it is shown only where there is one.
              */}
              {plan.proposedHeats && (
                <Metric label="Heat numbers" value={plan.proposedHeats.length}
                        sub="each owes a mill certificate in §15" />
              )}
            </div>

            {unresolved.length > 0 && (
              <p className="rounded-md border border-status-critical/30 bg-status-critical/10 px-3 py-2 text-xs text-status-critical">
                {unresolved.length}
                {plan.template === 'flowline'
                  ? ` welder${unresolved.length === 1 ? '' : 's'}`
                  : ` stamp${unresolved.length === 1 ? '' : 's'}`} on this log
                {unresolved.length === 1 ? ' does' : ' do'} not resolve to anyone in the welder
                register: {unresolved.map((s) => `${s.stamp} (${s.welds})`).join(', ')}. Those welds
                will import with no welder attached until the register has them.
              </p>
            )}

            <div>
              <h4 className="mb-2 text-2xs font-semibold uppercase tracking-wide text-ink-secondary">
                {plan.template === 'flowline' ? 'Welders' : 'Welder stamps'}
              </h4>
              <div className="flex flex-wrap gap-1.5">
                {plan.stamps.map((s) => (
                  <Chip key={s.stamp} tone={s.action === 'match' ? 'complete' : 'critical'}>
                    {s.stamp} · {s.welds}
                  </Chip>
                ))}
              </div>
            </div>

            <div>
              <h4 className="mb-2 text-2xs font-semibold uppercase tracking-wide text-ink-secondary">
                {plan.template === 'flowline' ? 'Lines' : 'Construction areas'}
              </h4>
              <div className="overflow-x-auto">
                <Table>
                  <thead>
                    <Tr>
                      <Th>{plan.template === 'flowline' ? 'Line' : 'Area'}</Th>
                      <Th className="text-right">Welds</Th><Th>Action</Th>
                    </Tr>
                  </thead>
                  <tbody>
                    {plan.areas.map((a) => (
                      <Tr key={a.code}>
                        <Td>{a.code}</Td>
                        <Td className="tnum text-right">{a.weldCount}</Td>
                        <Td>
                          <Chip tone={a.action === 'create' ? 'complete' : 'info'}>
                            {a.action === 'create' ? 'Create line' : 'Existing line'}
                          </Chip>
                        </Td>
                      </Tr>
                    ))}
                  </tbody>
                </Table>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 border-t border-hairline pt-3">
              <Button onClick={() => send(true)} disabled={!canUpload || busy !== null}>
                {busy === 'commit' ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
                Import {plan.parsedRows} weld{plan.parsedRows === 1 ? '' : 's'}
              </Button>
              <span className="text-2xs text-ink-secondary">
                {plan.template === 'flowline'
                  // Weld numbers restart on every line, so the number
                  // alone does not identify a weld here.
                  ? 'Welds are keyed by line and weld number, so re-importing a corrected log updates these rows'
                  : 'Welds are keyed by weld number, so re-importing a corrected log updates these rows'}
                {' '}rather than laying a second copy of the book beside the first.
              </span>
            </div>
          </div>
        )}
      </CardBody>
    </Card>
  )
}
