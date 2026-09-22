'use client'

/**
 * Recording a §10 audit.
 *
 * The score is not typed. It is derived from the findings, live, as they
 * are entered — because a score somebody types and a list of reasons
 * somebody writes can disagree, and when they do there is no way to tell
 * which one is the audit. Here there is only one number and it always
 * has its reasons attached.
 *
 * §10.3's rule is shown as it applies rather than explained afterwards:
 * the moment a Critical is added the verdict flips to Fail and says why,
 * whatever the arithmetic says. An auditor should meet that rule while
 * deciding how to classify a finding, not after submitting.
 */
import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, Plus, ShieldCheck, Trash2 } from 'lucide-react'
import type { AuditTier, FindingClass } from '@/lib/domain/types'
import type { StaffMember } from '@/lib/data/provider'
import { PEER_AUDIT_PASS, scoreAudit, type SamplePlan } from '@/lib/domain/audits'
import {
  Button, Card, CardBody, CardHeader, CardTitle, Chip,
} from '@/components/ui/primitives'

interface DraftFinding {
  key: string
  classification: FindingClass
  sectionNumber: string
  summary: string
  dueAt: string
}

const TIER_LABEL: Record<AuditTier, string> = {
  tier_1_self: 'Tier 1 — self audit',
  tier_2_peer: 'Tier 2 — peer audit',
  tier_3_manager: 'Tier 3 — QA/QC Manager',
}

const CLASS_TONE = {
  critical: 'critical', major: 'progress', minor: 'idle',
} as const

const field =
  'rounded-md border border-hairline bg-surface px-2 py-1 text-xs text-ink ' +
  'focus:border-brand-bright focus:outline-none'

export function RecordAudit({
  bookId, staff, custodianId, plan, planDoubled, canRecord, canCertify,
}: {
  bookId: string
  staff: StaffMember[]
  custodianId: string | null
  plan: SamplePlan
  planDoubled: SamplePlan
  canRecord: boolean
  canCertify: boolean
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [tier, setTier] = useState<AuditTier>('tier_2_peer')
  const [auditorId, setAuditorId] = useState('')
  const [doubleSample, setDoubleSample] = useState(false)
  const [notes, setNotes] = useState('')
  const [findings, setFindings] = useState<DraftFinding[]>([])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const [statement, setStatement] = useState('')

  const verdict = useMemo(
    () => scoreAudit(findings.filter((f) => f.summary.trim())),
    [findings],
  )
  const active = doubleSample ? planDoubled : plan

  /**
   * §10.2: a peer audit is by somebody who is not this book's Custodian,
   * at JB-3 or above. Shown as the reason the name is unavailable rather
   * than as a shorter list, so an auditor can see why they are not on it.
   */
  const eligible = (s: StaffMember): string | null => {
    if (tier !== 'tier_2_peer') return null
    if (s.id === custodianId) return 'this book’s Custodian'
    if (s.competencyLevel !== 'JB-3' && s.competencyLevel !== 'JB-4') {
      return s.competencyLevel ?? 'not assessed'
    }
    return null
  }

  const add = () =>
    setFindings((xs) => [...xs, {
      key: `f${Date.now()}${xs.length}`,
      classification: 'minor', sectionNumber: '', summary: '', dueAt: '',
    }])

  const update = (key: string, patch: Partial<DraftFinding>) =>
    setFindings((xs) => xs.map((f) => (f.key === key ? { ...f, ...patch } : f)))

  async function submit() {
    setBusy(true)
    setMessage(null)
    try {
      const res = await fetch(`/api/books/${bookId}/audits`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          tier,
          auditorId,
          notes,
          doubleSample,
          lotSize: tier === 'tier_2_peer' ? active.lotSize : null,
          sampleSize: tier === 'tier_2_peer' ? active.sampleSize : null,
          samplePlan: tier === 'tier_2_peer' ? active.description : null,
          findings: findings
            .filter((f) => f.summary.trim())
            .map((f) => ({
              classification: f.classification,
              sectionNumber: f.sectionNumber || null,
              summary: f.summary.trim(),
              dueAt: f.dueAt || null,
            })),
        }),
      })
      const json = await res.json()
      if (!json.ok) { setMessage({ ok: false, text: json.error ?? 'That did not go through.' }); return }
      setMessage({ ok: true, text: 'Audit recorded.' })
      setFindings([]); setNotes(''); setOpen(false)
      router.refresh()
    } catch {
      setMessage({ ok: false, text: 'Could not reach the server.' })
    } finally {
      setBusy(false)
    }
  }

  async function certify() {
    setBusy(true)
    setMessage(null)
    try {
      const res = await fetch(`/api/books/${bookId}/audits?certify=1`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ statement }),
      })
      const json = await res.json()
      setMessage({
        ok: json.ok,
        text: json.ok ? 'Completeness Certification signed.' : (json.error ?? 'Refused.'),
      })
      if (json.ok) { setStatement(''); router.refresh() }
    } catch {
      setMessage({ ok: false, text: 'Could not reach the server.' })
    } finally {
      setBusy(false)
    }
  }

  if (!canRecord && !canCertify) return null

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center justify-between gap-2">
        <CardTitle>Record an audit</CardTitle>
        {canRecord && (
          <Button variant="secondary" onClick={() => setOpen((v) => !v)}>
            {open ? 'Close' : 'New audit'}
          </Button>
        )}
      </CardHeader>
      <CardBody className="space-y-3">
        {message && (
          <p
            className={
              message.ok
                ? 'rounded-md border border-status-complete/30 bg-status-complete/10 px-3 py-2 text-xs text-status-complete'
                : 'rounded-md border border-status-critical/30 bg-status-critical/10 px-3 py-2 text-xs text-status-critical'
            }
          >
            {message.text}
          </p>
        )}

        {open && canRecord && (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2">
              <label className="flex flex-col gap-1 text-2xs text-ink-secondary">
                Tier
                <select
                  className={field}
                  value={tier}
                  onChange={(e) => { setTier(e.target.value as AuditTier); setAuditorId('') }}
                >
                  {(Object.keys(TIER_LABEL) as AuditTier[]).map((t) => (
                    <option key={t} value={t}>{TIER_LABEL[t]}</option>
                  ))}
                </select>
              </label>

              <label className="flex flex-col gap-1 text-2xs text-ink-secondary">
                Auditor
                <select
                  className={field}
                  value={auditorId}
                  onChange={(e) => setAuditorId(e.target.value)}
                >
                  <option value="">Choose…</option>
                  {staff.map((s) => {
                    const why = eligible(s)
                    return (
                      <option key={s.id} value={s.id} disabled={why != null}>
                        {s.fullName}
                        {why ? ` — ${why}` : s.competencyLevel ? ` (${s.competencyLevel})` : ''}
                      </option>
                    )
                  })}
                </select>
              </label>

              {tier === 'tier_2_peer' && (
                <label className="flex items-end gap-1.5 pb-1 text-2xs text-ink-secondary">
                  <input
                    type="checkbox"
                    checked={doubleSample}
                    onChange={(e) => setDoubleSample(e.target.checked)}
                  />
                  Gate 4 double sample
                </label>
              )}
            </div>

            {tier === 'tier_2_peer' && (
              <p className="rounded-md border border-hairline px-3 py-2 text-2xs text-ink-secondary">
                Sample to draw: <span className="text-ink">{active.sampleSize}</span> of{' '}
                {active.lotSize.toLocaleString()}. {active.description}
              </p>
            )}

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <h4 className="text-2xs font-semibold uppercase tracking-wide text-ink-secondary">
                  Findings ({findings.length})
                </h4>
                <Button variant="secondary" onClick={add}>
                  <Plus size={13} /> Add finding
                </Button>
              </div>

              {findings.map((f) => (
                <div key={f.key} className="flex flex-wrap items-end gap-2 rounded-md border border-hairline p-2">
                  <label className="flex flex-col gap-1 text-2xs text-ink-secondary">
                    Class
                    <select
                      className={field}
                      value={f.classification}
                      onChange={(e) =>
                        update(f.key, { classification: e.target.value as FindingClass })}
                    >
                      <option value="critical">Critical</option>
                      <option value="major">Major</option>
                      <option value="minor">Minor</option>
                    </select>
                  </label>
                  <label className="flex flex-col gap-1 text-2xs text-ink-secondary">
                    Section
                    <input
                      className={`${field} w-16`}
                      value={f.sectionNumber}
                      placeholder="12"
                      onChange={(e) => update(f.key, { sectionNumber: e.target.value })}
                    />
                  </label>
                  <label className="flex min-w-[14rem] flex-1 flex-col gap-1 text-2xs text-ink-secondary">
                    What was found
                    <input
                      className={field}
                      value={f.summary}
                      placeholder="Heat register not reconciled against installed heats"
                      onChange={(e) => update(f.key, { summary: e.target.value })}
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-2xs text-ink-secondary">
                    Correct by
                    <input
                      type="date"
                      className={field}
                      value={f.dueAt}
                      onChange={(e) => update(f.key, { dueAt: e.target.value })}
                    />
                  </label>
                  <Button
                    variant="ghost"
                    onClick={() => setFindings((xs) => xs.filter((x) => x.key !== f.key))}
                  >
                    <Trash2 size={13} />
                  </Button>
                </div>
              ))}
            </div>

            <label className="flex flex-col gap-1 text-2xs text-ink-secondary">
              Notes
              <textarea
                className={`${field} min-h-[3rem]`}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </label>

            {tier === 'tier_2_peer' && (
              <div className="flex flex-wrap items-center gap-2 rounded-md border border-hairline px-3 py-2">
                <Chip tone={verdict.passes ? 'complete' : 'critical'}>
                  {verdict.passes ? 'Pass' : 'Fail'} · {verdict.score}
                </Chip>
                <span className="text-2xs text-ink-secondary">{verdict.explanation}</span>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2 border-t border-hairline pt-3">
              <Button onClick={submit} disabled={busy || !auditorId}>
                {busy ? <Loader2 size={13} className="animate-spin" /> : null}
                Record {TIER_LABEL[tier].split('—')[0]!.trim()}
              </Button>
              <span className="text-2xs text-ink-secondary">
                {tier === 'tier_2_peer'
                  ? `The score is derived from the findings, never typed, and any Critical fails the audit outright whatever it comes to. Pass mark ${PEER_AUDIT_PASS}.`
                  : 'Tiers 1 and 3 are counted and signed rather than scored.'}
              </span>
            </div>
          </div>
        )}

        {canCertify && (
          <div className="space-y-2 border-t border-hairline pt-3">
            <h4 className="text-2xs font-semibold uppercase tracking-wide text-ink-secondary">
              Completeness Certification (§10.4)
            </h4>
            <textarea
              className={`${field} min-h-[3rem] w-full`}
              value={statement}
              placeholder="Optional statement to travel with the signature."
              onChange={(e) => setStatement(e.target.value)}
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={certify} disabled={busy}>
                {busy ? <Loader2 size={13} className="animate-spin" /> : <ShieldCheck size={13} />}
                Sign the certification
              </Button>
              <span className="text-2xs text-ink-secondary">
                The figures are taken from the book as it stands right now and stored with the
                signature. Refused while any Critical or Major finding is open.
              </span>
            </div>
          </div>
        )}
      </CardBody>
    </Card>
  )
}
