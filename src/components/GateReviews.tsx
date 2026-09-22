'use client'

/**
 * Gate reviews — FDS-JBMP-001 §7.
 *
 * The screen is built around one idea: a gate is a decision somebody
 * signs, so the chair has to be able to see what they are signing. Every
 * criterion shows the program's own sentence, the verdict, and what the
 * application actually found — never a tick with nothing behind it.
 *
 * The three states are drawn differently on purpose. "Cannot evaluate" is
 * not a softer kind of failure and it is not a pass; it is the app saying
 * it does not know, and a chair passing the gate anyway has to write down
 * why. The database refuses the decision without that note.
 */
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  AlertTriangle, Check, CircleHelp, Loader2, Minus, ShieldCheck, UserCheck,
} from 'lucide-react'
import type {
  CriterionResult, GateEvaluation, GateId, GateOutcome, GateReview,
} from '@/lib/domain/types'
import type { StaffMember } from '@/lib/data/provider'
import {
  Button, Card, CardBody, CardHeader, CardTitle, Chip,
} from '@/components/ui/primitives'
import { cn } from '@/lib/utils'

const STATE_META = {
  met: { tone: 'complete' as const, icon: <Check size={12} />, label: 'Met' },
  not_met: { tone: 'critical' as const, icon: <AlertTriangle size={12} />, label: 'Not met' },
  indeterminate: { tone: 'progress' as const, icon: <CircleHelp size={12} />, label: 'Cannot evaluate' },
  not_applicable: { tone: 'idle' as const, icon: <Minus size={12} />, label: 'N/A' },
}

const OUTCOME_LABEL: Record<GateOutcome, string> = {
  pass: 'Pass',
  conditional_pass: 'Conditional Pass',
  fail: 'Fail',
}

export function GateReviews({
  bookId, evaluations, reviews, custodianName, custodianCompetency, staff, canChair,
}: {
  bookId: string
  evaluations: GateEvaluation[]
  reviews: GateReview[]
  custodianName: string | null
  custodianCompetency: string | null
  staff: StaffMember[]
  canChair: boolean
}) {
  const router = useRouter()
  const [open, setOpen] = useState<GateId | null>(
    evaluations.find((e) => !reviews.some((r) => r.gate === e.gate))?.gate ?? 'G0',
  )
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const [overrideNote, setOverrideNote] = useState('')
  const [dueAt, setDueAt] = useState('')

  async function post(body: Record<string, unknown>) {
    setBusy(true); setMessage(null)
    try {
      const res = await fetch(`/api/books/${bookId}/gates`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const json = (await res.json()) as { ok: boolean; error?: string }
      setMessage({ ok: json.ok, text: json.ok ? 'Recorded.' : json.error ?? 'That did not go through.' })
      if (json.ok) { setOverrideNote(''); setDueAt(''); router.refresh() }
    } catch {
      setMessage({ ok: false, text: 'Could not reach the server.' })
    } finally {
      setBusy(false)
    }
  }

  // The ten-day ceiling of §7, offered as the default rather than left to
  // arithmetic at the desk.
  const tenDaysOut = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10)

  return (
    <div className="space-y-4">
      <CustodianCard
        custodianName={custodianName}
        custodianCompetency={custodianCompetency}
        staff={staff}
        canAssign={canChair}
        busy={busy}
        onAssign={(userId) => post({ action: 'assign-custodian', userId })}
      />

      {message && (
        <p className={cn(
          'rounded-md border px-3 py-2 text-xs',
          message.ok
            ? 'border-status-complete/30 bg-status-complete/10 text-status-complete'
            : 'border-status-critical/30 bg-status-critical/10 text-status-critical',
        )}>
          {message.text}
        </p>
      )}

      {evaluations.map((e) => {
        const gateReviews = reviews.filter((r) => r.gate === e.gate)
        const latest = gateReviews[0]
        const expanded = open === e.gate
        const blocked = e.notMet + e.indeterminate
        return (
          <Card key={e.gate}>
            <button
              type="button"
              onClick={() => setOpen(expanded ? null : e.gate)}
              aria-expanded={expanded}
              className="flex w-full flex-wrap items-center gap-3 px-4 py-3 text-left hover:bg-surface-raised"
            >
              <span className="font-mono text-xs font-semibold text-ink-secondary">{e.gate}</span>
              <span className="flex-1 text-sm font-medium text-ink">{e.title}</span>
              {latest && (
                <Chip tone={latest.outcome === 'pass' ? 'complete' : latest.outcome === 'fail' ? 'critical' : 'progress'}>
                  {OUTCOME_LABEL[latest.outcome]}
                  {gateReviews.length > 1 ? ` · attempt ${latest.attempt}` : ''}
                </Chip>
              )}
              <Chip tone={e.notMet > 0 ? 'critical' : e.indeterminate > 0 ? 'progress' : 'complete'}>
                {e.met}/{e.criteria.length - e.notApplicable} met
              </Chip>
            </button>

            {expanded && (
              <CardBody className="space-y-4 border-t border-hairline pt-4">
                <p className="text-2xs uppercase tracking-wide text-ink-secondary">
                  When: {e.when}
                </p>

                <ul className="space-y-2">
                  {e.criteria.map((c) => <Criterion key={c.id} c={c} />)}
                </ul>

                {gateReviews.length > 0 && (
                  <div className="space-y-2 border-t border-hairline pt-3">
                    <h4 className="text-2xs font-semibold uppercase tracking-wide text-ink-secondary">
                      Decisions on record
                    </h4>
                    {gateReviews.map((r) => (
                      <div key={r.id} className="rounded-md bg-surface-raised px-3 py-2 text-xs">
                        <div className="flex flex-wrap items-center gap-2">
                          <Chip tone={r.outcome === 'pass' ? 'complete' : r.outcome === 'fail' ? 'critical' : 'progress'}>
                            {OUTCOME_LABEL[r.outcome]}
                          </Chip>
                          <span className="text-ink-secondary">
                            attempt {r.attempt} · {new Date(r.decidedAt).toLocaleDateString()}
                            {r.completionPct != null ? ` · ${r.completionPct}% complete` : ''}
                          </span>
                        </div>
                        {r.conditionalDueAt && (
                          <p className="mt-1 text-ink-secondary">
                            Action list due {r.conditionalDueAt}
                            {r.clearedAt ? ' · cleared' : ''}
                          </p>
                        )}
                        {r.overrideNote && (
                          <p className="mt-1 text-ink">
                            <span className="text-ink-secondary">Override: </span>{r.overrideNote}
                          </p>
                        )}
                        {r.notes && <p className="mt-1 text-ink-secondary">{r.notes}</p>}
                      </div>
                    ))}
                  </div>
                )}

                {canChair && (
                  <div className="space-y-3 border-t border-hairline pt-3">
                    {blocked > 0 && (
                      <>
                        <p className="text-xs text-ink-secondary">
                          {e.notMet > 0 && `${e.notMet} criteri${e.notMet === 1 ? 'on is' : 'a are'} not met`}
                          {e.notMet > 0 && e.indeterminate > 0 && ' and '}
                          {e.indeterminate > 0 && `${e.indeterminate} cannot be evaluated`}
                          . Passing this gate anyway is recorded as an override, in your name.
                        </p>
                        <textarea
                          value={overrideNote}
                          onChange={(ev) => setOverrideNote(ev.target.value)}
                          rows={2}
                          placeholder="Why this gate may pass regardless — required."
                          className="w-full rounded-md border border-hairline bg-surface px-3 py-2 text-xs text-ink placeholder:text-ink-secondary"
                        />
                      </>
                    )}
                    <div className="flex flex-wrap items-end gap-2">
                      <Button
                        onClick={() => post({ gate: e.gate, outcome: 'pass', overrideNote })}
                        disabled={busy || (blocked > 0 && !overrideNote.trim())}
                      >
                        {busy ? <Loader2 size={13} className="animate-spin" /> : <ShieldCheck size={13} />}
                        Pass
                      </Button>
                      <div className="flex items-end gap-2">
                        <label className="text-2xs text-ink-secondary">
                          Action list due
                          <input
                            type="date"
                            value={dueAt}
                            max={tenDaysOut}
                            onChange={(ev) => setDueAt(ev.target.value)}
                            className="mt-1 block rounded-md border border-hairline bg-surface px-2 py-1 text-xs text-ink"
                          />
                        </label>
                        <Button
                          variant="secondary"
                          onClick={() => post({
                            gate: e.gate, outcome: 'conditional_pass',
                            conditionalDueAt: dueAt || tenDaysOut, overrideNote,
                          })}
                          disabled={busy || (blocked > 0 && !overrideNote.trim())}
                        >
                          Conditional Pass
                        </Button>
                      </div>
                      <Button
                        variant="secondary"
                        onClick={() => post({ gate: e.gate, outcome: 'fail' })}
                        disabled={busy}
                      >
                        Fail
                      </Button>
                    </div>
                    <p className="text-2xs text-ink-secondary">
                      §7: a Conditional Pass carries a maximum of ten calendar days and may be
                      issued once per gate. Uncleared, it becomes a Fail and escalates to the
                      VP of Operations the same day.
                    </p>
                  </div>
                )}
              </CardBody>
            )}
          </Card>
        )
      })}
    </div>
  )
}

function Criterion({ c }: { c: CriterionResult }) {
  const meta = STATE_META[c.state]
  return (
    <li className="rounded-md border border-hairline px-3 py-2">
      <div className="flex flex-wrap items-start gap-2">
        <Chip tone={meta.tone} icon={meta.icon}>{meta.label}</Chip>
        {c.source === 'attested' && <Chip tone="idle">Attested</Chip>}
        <p className="min-w-[12rem] flex-1 text-xs text-ink">{c.text}</p>
      </div>
      <p className="mt-1 text-2xs text-ink-secondary">{c.detail}</p>
      {c.evidence && c.evidence.length > 0 && (
        <p className="mt-1 font-mono text-2xs text-ink-secondary">
          {c.evidence.slice(0, 12).join(' · ')}
          {c.evidence.length > 12 ? ` · +${c.evidence.length - 12} more` : ''}
        </p>
      )}
    </li>
  )
}

function CustodianCard({
  custodianName, custodianCompetency, staff, canAssign, busy, onAssign,
}: {
  custodianName: string | null
  custodianCompetency: string | null
  staff: StaffMember[]
  canAssign: boolean
  busy: boolean
  onAssign: (userId: string) => void
}) {
  const [picked, setPicked] = useState('')
  // §5.1 refuses below JB-2, and null is "not assessed", which is not the
  // same as JB-1 — so the list says which it is rather than hiding either.
  const eligible = staff.filter((s) => s.competencyLevel && s.competencyLevel !== 'JB-1')
  const ineligible = staff.filter((s) => !s.competencyLevel || s.competencyLevel === 'JB-1')

  return (
    <Card>
      <CardHeader>
        <CardTitle>Job Book Custodian</CardTitle>
      </CardHeader>
      <CardBody className="space-y-3">
        {custodianName ? (
          <p className="flex flex-wrap items-center gap-2 text-sm text-ink">
            <UserCheck size={14} className="text-status-complete" />
            {custodianName}
            <Chip tone={custodianCompetency ? 'complete' : 'progress'}>
              {custodianCompetency ?? 'No assessed competency'}
            </Chip>
          </p>
        ) : (
          <p className="text-xs text-ink-secondary">
            No Custodian is named on this book. §5 gives every job book exactly one, named at
            Gate 0 and accountable for every record in it.
          </p>
        )}

        {canAssign && (
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-2xs text-ink-secondary">
              Assign
              <select
                value={picked}
                onChange={(e) => setPicked(e.target.value)}
                className="mt-1 block min-w-[14rem] rounded-md border border-hairline bg-surface px-2 py-1 text-xs text-ink"
              >
                <option value="">Choose a person…</option>
                {eligible.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.fullName} — {s.competencyLevel}
                  </option>
                ))}
                {ineligible.length > 0 && (
                  <optgroup label="Not eligible (§5.1 requires JB-2 or above)">
                    {ineligible.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.fullName} — {s.competencyLevel ?? 'not assessed'}
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
            </label>
            <Button onClick={() => picked && onAssign(picked)} disabled={busy || !picked}>
              {busy ? <Loader2 size={13} className="animate-spin" /> : null}
              Name Custodian
            </Button>
          </div>
        )}
      </CardBody>
    </Card>
  )
}
