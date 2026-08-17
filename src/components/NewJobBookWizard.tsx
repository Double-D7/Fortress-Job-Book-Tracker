'use client'

/**
 * New job book setup.
 *
 * Four steps, and the third is the one that earns its place. Steps 1 and 2
 * are the header block the Noble weld log repeats on every line sheet plus
 * the operator's compliance thresholds — necessary, but ordinary. Step 3 is
 * where the tech declares how big the job is, and that number becomes the
 * denominator of every percentage on the dashboard from then on.
 *
 * The reason it comes first, before a single weld is typed: without it the
 * book scores against the rows already entered, so 100 complete joints out
 * of a real 2,342 reads as 100%. The wizard says so out loud rather than
 * hoping the tech infers it.
 */
import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  AlertTriangle, ArrowLeft, ArrowRight, Check, Info, Plus, Trash2,
} from 'lucide-react'
import type { ScopePrompt } from '@/lib/domain/scaffold'
import {
  Button, Card, CardBody, CardHeader, CardTitle, Chip, SectionHeading,
} from '@/components/ui/primitives'
import { cn, num } from '@/lib/utils'

interface Org { id: string; name: string }
interface LineRow { lineCode: string; wellName: string; expectedWeldCount: string; serviceType: string }

const STEPS = ['Job identity', 'Dates & thresholds', 'Scope', 'Review'] as const

const FIELD =
  'w-full rounded-md border border-hairline bg-surface-raised px-2.5 py-1.5 text-xs ' +
  'text-ink placeholder:text-ink-muted'

function Field({
  label, hint, children,
}: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-2xs font-medium uppercase tracking-wide text-ink-muted">
        {label}
      </span>
      {children}
      {hint && <span className="mt-1 block text-2xs leading-relaxed text-ink-muted">{hint}</span>}
    </label>
  )
}

export function NewJobBookWizard({
  orgs, flowlinePrompts, facilityPrompts, canCreate,
}: {
  orgs: Org[]
  flowlinePrompts: ScopePrompt[]
  facilityPrompts: ScopePrompt[]
  canCreate: boolean
}) {
  const router = useRouter()
  const [step, setStep] = useState(0)
  const [submitting, setSubmitting] = useState(false)
  const [serverErrors, setServerErrors] = useState<{ field: string; message: string }[]>([])

  const [bookType, setBookType] = useState<'flowline' | 'facility'>('flowline')
  const [jobNumber, setJobNumber] = useState('')
  const [clientOrgId, setClientOrgId] = useState(orgs[0]?.id ?? '')
  const [facilityName, setFacilityName] = useState('')
  const [drillPadName, setDrillPadName] = useState('')
  const [wellNames, setWellNames] = useState('')
  const [operatorPicName, setOperatorPicName] = useState('')
  const [constructionCompany, setConstructionCompany] = useState('')
  const [weldingCompany, setWeldingCompany] = useState('')
  const [cwiNames, setCwiNames] = useState('')
  const [pipeSizeIn, setPipeSizeIn] = useState('')
  const [pipeSchedule, setPipeSchedule] = useState('')
  const [pipeGrade, setPipeGrade] = useState('')

  const [constructionStart, setConstructionStart] = useState('')
  const [constructionEnd, setConstructionEnd] = useState('')
  const [targetTurnoverDate, setTargetTurnoverDate] = useState('')
  const [requiredXrayPct, setRequiredXrayPct] = useState('10')
  const [requiredTorqueInspectPct, setRequiredTorqueInspectPct] = useState('10')
  const [torqueTolerancePct, setTorqueTolerancePct] = useState('5')
  const [certExpiryWarningDays, setCertExpiryWarningDays] = useState('60')
  const [xrayCreditRule, setXrayCreditRule] =
    useState<'all_passes' | 'root_welder' | 'cap_welder'>('all_passes')

  const [scope, setScope] = useState<Record<string, string>>({})
  const [lines, setLines] = useState<LineRow[]>([])

  const prompts = bookType === 'flowline' ? flowlinePrompts : facilityPrompts

  const lineTotal = useMemo(
    () => lines.reduce((t, l) => t + (Number(l.expectedWeldCount) || 0), 0),
    [lines],
  )
  const scopedCount = useMemo(
    () => Object.values(scope).filter((v) => v !== '' && Number(v) > 0).length,
    [scope],
  )

  const localErrors = useMemo(() => {
    const e: string[] = []
    if (!jobNumber.trim()) e.push('A job number is required.')
    if (!clientOrgId) e.push('Select the operator this book belongs to.')
    if (constructionStart && constructionEnd && constructionStart > constructionEnd) {
      e.push('Construction cannot end before it starts.')
    }
    const codes = lines.map((l) => l.lineCode.trim().toUpperCase()).filter(Boolean)
    if (codes.some((c, i) => codes.indexOf(c) !== i)) e.push('Two lines share a code.')
    return e
  }, [jobNumber, clientOrgId, constructionStart, constructionEnd, lines])

  const weldScope = Number(scope['12'] ?? '') || 0
  const scopeMismatch =
    lineTotal > 0 && weldScope > 0 && Math.abs(lineTotal - weldScope) / weldScope > 0.1

  async function submit() {
    setSubmitting(true)
    setServerErrors([])
    const payload = {
      jobNumber, bookType, clientOrgId,
      projectId: `proj-${jobNumber.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      bookTemplateId: `tpl-${bookType}-v1`,
      facilityName, drillPadName,
      wellNames: wellNames.split(',').map((w) => w.trim()).filter(Boolean),
      constructionCompany, weldingCompany,
      cwiNames: cwiNames.split(',').map((c) => c.trim()).filter(Boolean),
      operatorPicName, pipeSizeIn, pipeSchedule, pipeGrade,
      constructionStart: constructionStart || undefined,
      constructionEnd: constructionEnd || undefined,
      targetTurnoverDate: targetTurnoverDate || undefined,
      requiredXrayPct: Number(requiredXrayPct) || 10,
      requiredTorqueInspectPct: Number(requiredTorqueInspectPct) || 10,
      torqueTolerancePct: Number(torqueTolerancePct) || 5,
      certExpiryWarningDays: Number(certExpiryWarningDays) || 60,
      xrayCreditRule,
      scope: Object.entries(scope)
        .filter(([, v]) => v !== '')
        .map(([sectionNumber, v]) => ({ sectionNumber, expectedCount: Number(v) })),
      weldLines: lines.filter((l) => l.lineCode.trim()).map((l) => ({
        lineCode: l.lineCode.trim(),
        wellName: l.wellName.trim() || undefined,
        serviceType: l.serviceType.trim() || undefined,
        expectedWeldCount: Number(l.expectedWeldCount) || null,
      })),
    }
    const res = await fetch('/api/job-books', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const body = await res.json()
    setSubmitting(false)
    if (body.ok && body.jobBookId) {
      router.push(`/books/${body.jobBookId}`)
      router.refresh()
    } else {
      setServerErrors(body.errors ?? [{ field: '', message: 'Could not create the job book.' }])
      setStep(0)
    }
  }

  return (
    <>
      <SectionHeading
        title="New job book"
        subtitle="Scaffolds all 22 checklist sections; facility-only sections are marked N/A automatically."
      />

      {!canCreate && (
        <Card className="mb-4 border-status-progress/40 bg-status-progress/[0.06]">
          <CardBody className="text-xs text-status-progress">
            Creating a job book requires a QA/QC Manager or Admin. This is enforced in the database,
            so the form below will be rejected on submit.
          </CardBody>
        </Card>
      )}

      <ol className="mb-5 flex flex-wrap gap-2" aria-label="Setup steps">
        {STEPS.map((s, i) => (
          <li key={s}>
            <button
              onClick={() => setStep(i)}
              aria-current={step === i ? 'step' : undefined}
              className={cn(
                'rounded-md border px-3 py-1.5 text-xs font-medium transition-colors',
                step === i
                  ? 'border-brand-bright/50 bg-brand-bright/[0.12] text-ink'
                  : i < step
                    ? 'border-hairline bg-surface text-ink-secondary'
                    : 'border-hairline bg-surface text-ink-muted',
              )}
            >
              <span className="tnum mr-1.5 text-ink-muted">{i + 1}</span>{s}
              {i < step && <Check size={12} className="ml-1.5 inline text-status-complete" />}
            </button>
          </li>
        ))}
      </ol>

      {serverErrors.length > 0 && (
        <Card className="mb-4 border-status-critical/40 bg-status-critical/[0.07]">
          <CardBody className="space-y-1">
            {serverErrors.map((e, i) => (
              <p key={i} className="text-xs text-status-critical">{e.message}</p>
            ))}
          </CardBody>
        </Card>
      )}

      {/* ---------------------------------------------------------------- */}
      {step === 0 && (
        <Card>
          <CardHeader><CardTitle>Job identity</CardTitle></CardHeader>
          <CardBody className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <Field label="Book type">
                <select value={bookType} onChange={(e) => setBookType(e.target.value as typeof bookType)}
                        className={FIELD}>
                  <option value="flowline">Flowline</option>
                  <option value="facility">Facility</option>
                </select>
              </Field>
              <Field label="Job number" hint="Identifies the book everywhere, e.g. DP452.">
                <input value={jobNumber} onChange={(e) => setJobNumber(e.target.value)}
                       placeholder="DP452" className={FIELD} />
              </Field>
              <Field label="Operator">
                <select value={clientOrgId} onChange={(e) => setClientOrgId(e.target.value)}
                        className={FIELD}>
                  {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                </select>
              </Field>
            </div>

            <div className="rounded-md border border-hairline bg-surface-raised/40 p-4">
              <p className="mb-3 text-2xs uppercase tracking-wide text-ink-muted">
                Header block — repeated on every weld log line sheet
              </p>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                <Field label="Facility name">
                  <input value={facilityName} onChange={(e) => setFacilityName(e.target.value)}
                         placeholder="DP452 Flowline" className={FIELD} />
                </Field>
                <Field label="Drill pad name">
                  <input value={drillPadName} onChange={(e) => setDrillPadName(e.target.value)}
                         placeholder="CC19-03" className={FIELD} />
                </Field>
                <Field label="Well names" hint="Comma separated.">
                  <input value={wellNames} onChange={(e) => setWellNames(e.target.value)}
                         placeholder="CC19-03, CC16-24, CC20-18" className={FIELD} />
                </Field>
                <Field label="Operator PIC">
                  <input value={operatorPicName} onChange={(e) => setOperatorPicName(e.target.value)}
                         placeholder="B. Hargrove" className={FIELD} />
                </Field>
                <Field label="Construction company">
                  <input value={constructionCompany} onChange={(e) => setConstructionCompany(e.target.value)}
                         className={FIELD} />
                </Field>
                <Field label="Welding company">
                  <input value={weldingCompany} onChange={(e) => setWeldingCompany(e.target.value)}
                         className={FIELD} />
                </Field>
                <Field label="CWI(s)" hint="Comma separated.">
                  <input value={cwiNames} onChange={(e) => setCwiNames(e.target.value)}
                         placeholder="R. Alvarez, D. Whitfield" className={FIELD} />
                </Field>
                <Field label="Pipe size (in)">
                  <input value={pipeSizeIn} onChange={(e) => setPipeSizeIn(e.target.value)}
                         placeholder="3" className={FIELD} />
                </Field>
                <Field label="Pipe schedule">
                  <input value={pipeSchedule} onChange={(e) => setPipeSchedule(e.target.value)}
                         placeholder="80" className={FIELD} />
                </Field>
                <Field label="Pipe grade">
                  <input value={pipeGrade} onChange={(e) => setPipeGrade(e.target.value)}
                         placeholder="X42" className={FIELD} />
                </Field>
              </div>
            </div>
          </CardBody>
        </Card>
      )}

      {/* ---------------------------------------------------------------- */}
      {step === 1 && (
        <Card>
          <CardHeader><CardTitle>Dates and compliance thresholds</CardTitle></CardHeader>
          <CardBody className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Construction start">
                <input type="date" value={constructionStart}
                       onChange={(e) => setConstructionStart(e.target.value)} className={FIELD} />
              </Field>
              <Field label="Construction end">
                <input type="date" value={constructionEnd}
                       onChange={(e) => setConstructionEnd(e.target.value)} className={FIELD} />
              </Field>
              <Field label="Target turnover">
                <input type="date" value={targetTurnoverDate}
                       onChange={(e) => setTargetTurnoverDate(e.target.value)} className={FIELD} />
              </Field>
            </div>
            <p className="text-2xs leading-relaxed text-ink-muted">
              The construction window is what lets the application flag a report dated outside this
              job — the single cheapest way to catch a document filed into the wrong book.
            </p>

            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="Required X-ray %" hint="Per the operator's spec; commonly 10 or 20.">
                <input type="number" min="0" max="100" value={requiredXrayPct}
                       onChange={(e) => setRequiredXrayPct(e.target.value)} className={FIELD} />
              </Field>
              <Field label="Required torque inspection %">
                <input type="number" min="0" max="100" value={requiredTorqueInspectPct}
                       onChange={(e) => setRequiredTorqueInspectPct(e.target.value)} className={FIELD} />
              </Field>
              <Field label="Torque tolerance %" hint="Deviation from required before a flag.">
                <input type="number" min="0" max="100" value={torqueTolerancePct}
                       onChange={(e) => setTorqueTolerancePct(e.target.value)} className={FIELD} />
              </Field>
              <Field label="Cert expiry warning (days)">
                <input type="number" min="0" value={certExpiryWarningDays}
                       onChange={(e) => setCertExpiryWarningDays(e.target.value)} className={FIELD} />
              </Field>
            </div>

            <Field
              label="X-ray credit on a split-pass joint"
              hint="Who gets credit when two welders share a joint's four passes. Conventions differ by operator; this changes every per-welder percentage in the book."
            >
              <select value={xrayCreditRule}
                      onChange={(e) => setXrayCreditRule(e.target.value as typeof xrayCreditRule)}
                      className={cn(FIELD, 'max-w-md')}>
                <option value="all_passes">Every welder on the joint</option>
                <option value="root_welder">Root pass welder only</option>
                <option value="cap_welder">Cap pass welder only</option>
              </select>
            </Field>
          </CardBody>
        </Card>
      )}

      {/* ---------------------------------------------------------------- */}
      {step === 2 && (
        <div className="space-y-4">
          <Card className="border-brand-bright/30 bg-brand-bright/[0.04]">
            <CardBody className="flex gap-3">
              <Info size={15} className="mt-0.5 shrink-0 text-brand-bright" />
              <div className="space-y-1.5 text-xs leading-relaxed text-ink-secondary">
                <p className="font-medium text-ink">
                  These quantities become the denominator of every percentage on the dashboard.
                </p>
                <p>
                  Declare them from the drawing set now, before any data is entered. Without them a
                  section scores against the rows already typed — so 100 complete joints out of a
                  real 2,342 would read as 100% complete, and the book would look finished when it
                  had barely started.
                </p>
                <p className="text-ink-muted">
                  Estimates are fine and all of them stay editable. They set a floor, not a cap:
                  enter more than scoped and the denominator follows the real count upward.
                  Leave one blank to score that section against whatever gets entered; enter 0 and
                  the section is marked N/A.
                </p>
              </div>
            </CardBody>
          </Card>

          <Card>
            <CardHeader className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle>Expected quantities</CardTitle>
              <span className="text-2xs text-ink-muted">
                {scopedCount} of {prompts.length} sections scoped
              </span>
            </CardHeader>
            <CardBody className="p-0">
              <ul className="divide-y divide-hairline/60">
                {prompts.map((p) => (
                  <li key={p.sectionNumber} className="flex flex-wrap items-center gap-3 px-5 py-3">
                    <span className="tnum w-10 shrink-0 font-mono text-xs text-ink-muted">
                      {p.sectionNumber}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-xs text-ink">{p.title}</div>
                      <div className="mt-0.5 text-2xs text-ink-muted">From {p.source}</div>
                    </div>
                    <div className="flex items-center gap-2">
                      <input
                        type="number" min="0" inputMode="numeric"
                        value={scope[p.sectionNumber] ?? ''}
                        onChange={(e) => setScope({ ...scope, [p.sectionNumber]: e.target.value })}
                        placeholder="—"
                        aria-label={`Expected ${p.unit} for section ${p.sectionNumber}`}
                        className="tnum w-28 rounded-md border border-hairline bg-surface-raised px-2.5 py-1.5 text-right font-mono text-xs text-ink placeholder:text-ink-muted"
                      />
                      <span className="w-36 shrink-0 text-2xs text-ink-muted">{p.unit}</span>
                    </div>
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>

          <Card>
            <CardHeader className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle>Weld lines (optional)</CardTitle>
              <div className="flex items-center gap-3">
                {lineTotal > 0 && (
                  <span className="tnum text-2xs text-ink-muted">
                    {num(lineTotal)} joints across {lines.length} lines
                  </span>
                )}
                <Button
                  variant="secondary"
                  onClick={() => setLines([...lines, { lineCode: '', wellName: '', expectedWeldCount: '', serviceType: '' }])}
                >
                  <Plus size={13} /> Add line
                </Button>
              </div>
            </CardHeader>
            <CardBody className="space-y-3">
              <p className="text-2xs leading-relaxed text-ink-muted">
                If you have the isometrics, enter joints per line — FL1, FL2, FWT and so on. The sum
                takes precedence over the single figure for section 12, because it is measured
                rather than estimated, and it scaffolds the line sheets so the weld log is ready to
                type into.
              </p>
              {scopeMismatch && (
                <div className="flex gap-2 rounded-md border border-status-progress/40 bg-status-progress/[0.07] px-3 py-2">
                  <AlertTriangle size={13} className="mt-0.5 shrink-0 text-status-progress" />
                  <p className="text-2xs leading-relaxed text-status-progress">
                    Per-line joints total {num(lineTotal)} but section 12 is scoped to{' '}
                    {num(weldScope)}. The larger ({num(Math.max(lineTotal, weldScope))}) will be
                    used, so neither figure can flatter the score — but check which is right, and
                    add the remaining lines if this list is incomplete.
                  </p>
                </div>
              )}
              {lines.length > 0 && (
                <div className="space-y-2">
                  {lines.map((l, i) => (
                    <div key={i} className="grid grid-cols-[1fr_1fr_1fr_100px_36px] items-center gap-2">
                      <input value={l.lineCode} placeholder="FL1"
                             onChange={(e) => setLines(lines.map((x, k) => k === i ? { ...x, lineCode: e.target.value } : x))}
                             aria-label={`Line ${i + 1} code`} className={cn(FIELD, 'font-mono')} />
                      <input value={l.wellName} placeholder="Well"
                             onChange={(e) => setLines(lines.map((x, k) => k === i ? { ...x, wellName: e.target.value } : x))}
                             aria-label={`Line ${i + 1} well`} className={FIELD} />
                      <input value={l.serviceType} placeholder="Service, e.g. Production"
                             onChange={(e) => setLines(lines.map((x, k) => k === i ? { ...x, serviceType: e.target.value } : x))}
                             aria-label={`Line ${i + 1} service`} className={FIELD} />
                      <input type="number" min="0" value={l.expectedWeldCount} placeholder="joints"
                             onChange={(e) => setLines(lines.map((x, k) => k === i ? { ...x, expectedWeldCount: e.target.value } : x))}
                             aria-label={`Line ${i + 1} expected joints`}
                             className={cn(FIELD, 'tnum text-right font-mono')} />
                      <button onClick={() => setLines(lines.filter((_, k) => k !== i))}
                              aria-label={`Remove line ${i + 1}`}
                              className="flex h-7 w-7 items-center justify-center rounded-md text-ink-muted hover:bg-surface-raised hover:text-status-critical">
                        <Trash2 size={13} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </CardBody>
          </Card>
        </div>
      )}

      {/* ---------------------------------------------------------------- */}
      {step === 3 && (
        <div className="space-y-4">
          <Card>
            <CardHeader><CardTitle>Review</CardTitle></CardHeader>
            <CardBody className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {[
                  ['Job number', jobNumber || '—'],
                  ['Book type', bookType === 'flowline' ? 'Flowline' : 'Facility'],
                  ['Operator', orgs.find((o) => o.id === clientOrgId)?.name ?? '—'],
                  ['Facility', facilityName || '—'],
                  ['Drill pad', drillPadName || '—'],
                  ['Construction', constructionStart && constructionEnd
                    ? `${constructionStart} → ${constructionEnd}` : '—'],
                  ['Target turnover', targetTurnoverDate || '—'],
                  ['X-ray minimum', `${requiredXrayPct}%`],
                ].map(([k, v]) => (
                  <div key={k}>
                    <div className="text-2xs uppercase tracking-wide text-ink-muted">{k}</div>
                    <div className="mt-0.5 text-xs text-ink">{v}</div>
                  </div>
                ))}
              </div>

              <div>
                <div className="mb-2 text-2xs uppercase tracking-wide text-ink-muted">
                  Declared scope
                </div>
                {scopedCount === 0 ? (
                  <div className="flex gap-2 rounded-md border border-status-progress/40 bg-status-progress/[0.07] px-3 py-2">
                    <AlertTriangle size={13} className="mt-0.5 shrink-0 text-status-progress" />
                    <p className="text-2xs leading-relaxed text-status-progress">
                      No quantities declared. The book will score against whatever gets entered, so
                      partly-entered sections will read as complete. You can add quantities later
                      from each section, but the percentages will be misleading until you do.
                    </p>
                  </div>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {prompts.filter((p) => scope[p.sectionNumber]).map((p) => (
                      <Chip key={p.sectionNumber}
                            tone={Number(scope[p.sectionNumber]) === 0 ? 'idle' : 'brand'}>
                        <span className="font-mono">{p.sectionNumber}</span>
                        <span className="ml-1">
                          {Number(scope[p.sectionNumber]) === 0
                            ? 'N/A'
                            : `${num(Number(scope[p.sectionNumber]))} ${p.unit}`}
                        </span>
                      </Chip>
                    ))}
                  </div>
                )}
              </div>

              {lines.length > 0 && (
                <div>
                  <div className="mb-2 text-2xs uppercase tracking-wide text-ink-muted">
                    Weld lines — {num(lineTotal)} joints across {lines.length} lines
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {lines.filter((l) => l.lineCode.trim()).map((l, i) => (
                      <Chip key={i} tone="idle">
                        <span className="font-mono">{l.lineCode}</span>
                        {l.expectedWeldCount && <span className="ml-1">{l.expectedWeldCount}</span>}
                      </Chip>
                    ))}
                  </div>
                </div>
              )}

              <p className="rounded-md border border-hairline bg-surface-raised px-3 py-2 text-2xs leading-relaxed text-ink-secondary">
                Creating this book scaffolds all 22 checklist sections at once.
                {bookType === 'flowline'
                  ? ' Sections 19–22 are marked N/A automatically — a flowline book delivers the combined weld, X-ray, heat number and torque map instead.'
                  : ' Sections 19–22 are active for a facility book.'}
                {' '}Sections scoped to 0 are marked N/A with the reason recorded, so nothing is
                silently absent from the checklist the operator audits against.
              </p>

              {localErrors.length > 0 && (
                <div className="space-y-1">
                  {localErrors.map((e, i) => (
                    <p key={i} className="text-xs text-status-critical">{e}</p>
                  ))}
                </div>
              )}
            </CardBody>
          </Card>
        </div>
      )}

      <div className="mt-4 flex items-center justify-between">
        <Button variant="ghost" onClick={() => setStep(Math.max(0, step - 1))} disabled={step === 0}>
          <ArrowLeft size={13} /> Back
        </Button>
        {step < STEPS.length - 1 ? (
          <Button variant="primary" onClick={() => setStep(step + 1)}>
            Next <ArrowRight size={13} />
          </Button>
        ) : (
          <Button variant="primary" onClick={submit}
                  disabled={submitting || localErrors.length > 0}>
            {submitting ? 'Creating…' : 'Create job book'} <Check size={13} />
          </Button>
        )}
      </div>
    </>
  )
}
