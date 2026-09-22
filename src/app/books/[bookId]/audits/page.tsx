import { notFound, redirect } from 'next/navigation'
import { currentViewer, getDataProvider } from '@/lib/data/provider'
import {
  auditableLotSize, latestOfTier, PEER_AUDIT_PASS, PEER_AUDIT_PASS_G4,
  samplePlan, scoreAudit, selfAuditsDue, SELF_AUDIT_INTERVAL_WORKING_DAYS,
  summarizeAudits,
} from '@/lib/domain/audits'
import { scoreBook } from '@/lib/domain/scoring'
import { today } from '@/lib/domain/dates'
import type { AuditTier, JobBookAudit } from '@/lib/domain/types'
import {
  Card, CardBody, CardHeader, CardTitle, Chip, EmptyState, Metric,
  SectionHeading, Table, Td, Th, Tr,
} from '@/components/ui/primitives'

export const dynamic = 'force-dynamic'

const TIER_LABEL: Record<AuditTier, string> = {
  tier_1_self: 'Tier 1 · Self audit',
  tier_2_peer: 'Tier 2 · Peer audit',
  tier_3_manager: 'Tier 3 · QA/QC Manager',
}

const OUTCOME_TONE = {
  pass: 'complete', fail: 'critical', in_progress: 'progress',
} as const

/** Fortress's own quality record. A client reads the book, not the
 *  minutes of us checking ourselves — the same rule the gate reviews
 *  follow, and the same rule the RLS policy enforces underneath. */
const FORTRESS = new Set([
  'fortress_admin', 'qaqc_manager', 'qaqc_tech', 'fortress_read_only',
])

export default async function AuditsPage({
  params,
}: {
  params: Promise<{ bookId: string }>
}) {
  const viewer = await currentViewer()
  if (!viewer) redirect('/login')
  const { bookId } = await params

  const bundle = await getDataProvider().getBundle(viewer, bookId)
  if (!bundle) notFound()

  if (!FORTRESS.has(viewer.role)) {
    return (
      <EmptyState
        title="Not visible on this account"
        detail="The three-tier verification record is Fortress's internal quality history. The Completeness Certification that rests on it travels with the book."
      />
    )
  }

  const asOf = bundle.book.dataAsOfDate ?? today()
  const audits = bundle.audits ?? []
  const findings = bundle.auditFindings ?? []
  const summary = summarizeAudits(audits, findings)
  const due = selfAuditsDue(bundle, asOf)
  const lot = auditableLotSize(bundle)
  const plan = samplePlan(lot)
  const planG4 = samplePlan(lot, true)
  const cert = bundle.completenessCertification
  const score = scoreBook(bundle)

  const peer = latestOfTier(audits, 'tier_2_peer')
  const peerFindings = peer ? findings.filter((f) => f.auditId === peer.id) : []
  const peerVerdict = peer ? scoreAudit(peerFindings, PEER_AUDIT_PASS) : null

  const selfShortfall = due == null ? null : Math.max(0, due - summary.selfAuditsPerformed)

  const sorted = [...audits].sort((a, b) =>
    (b.completedAt ?? b.startedAt ?? '').localeCompare(a.completedAt ?? a.startedAt ?? ''),
  )

  return (
    <div className="space-y-4">
      <SectionHeading
        title="Three-tier verification"
        subtitle={
          <>
            FDS-JBMP-001 §10. Tier 1 is the Custodian on their own book, Tier 2 an
            independent Custodian at JB-3 or above, Tier 3 the QA/QC Manager at Gate 4.
            Only Tier 2 is scored.
          </>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Metric
          label="Latest peer audit"
          value={summary.latestPeerAuditScore == null ? '—' : summary.latestPeerAuditScore}
          tone={
            peerVerdict == null ? 'idle' : peerVerdict.passes ? 'complete' : 'critical'
          }
          sub={
            summary.latestPeerAuditScore == null
              ? 'none recorded'
              : `pass mark ${PEER_AUDIT_PASS}, ${PEER_AUDIT_PASS_G4} at Gate 4`
          }
        />
        <Metric
          label="Criticals in that audit"
          value={summary.latestPeerAuditCriticals ?? '—'}
          tone={
            summary.latestPeerAuditCriticals == null
              ? 'idle'
              : summary.latestPeerAuditCriticals > 0 ? 'critical' : 'complete'
          }
          sub="§10.3 fails outright on any"
        />
        <Metric
          label="Self audits"
          value={due == null ? summary.selfAuditsPerformed : `${summary.selfAuditsPerformed} / ${due}`}
          tone={
            selfShortfall == null ? 'idle' : selfShortfall > 0 ? 'progress' : 'complete'
          }
          sub={
            due == null
              ? 'schedule unknown — no construction start'
              : `one per ${SELF_AUDIT_INTERVAL_WORKING_DAYS} working days`
          }
        />
        <Metric
          label="Tier 3 verification"
          value={summary.tier3VerifiedAt ? 'Signed' : '—'}
          tone={summary.tier3VerifiedAt ? 'complete' : 'idle'}
          sub={summary.tier3VerifiedAt?.slice(0, 10) ?? 'required at Gate 4'}
        />
      </div>

      {audits.length === 0 && (
        <Card>
          <CardBody className="text-xs text-ink-secondary">
            <p>
              No §10 audit has been recorded against this book. Five gate criteria across
              Gates 1, 2 and 4 read this history, and each of them reports
              <em> indeterminate</em> while it is empty — never <em>met</em>. A chair may
              still pass a gate over an indeterminate criterion, but the database demands a
              written override to do it.
            </p>
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader><CardTitle>Sampling plan (§10.2)</CardTitle></CardHeader>
        <CardBody className="space-y-2 text-xs text-ink-secondary">
          <p>
            §10.2 samples rather than reading everything. Reading {lot.toLocaleString()} records
            twice is not a control; it is a second chance to make the same mistake while tired.
          </p>
          <Table>
            <thead>
              <Tr>
                <Th>Review</Th>
                <Th className="text-right">Lot</Th>
                <Th className="text-right">Sample</Th>
                <Th>Basis</Th>
              </Tr>
            </thead>
            <tbody>
              <Tr>
                <Td>Gates 1–3</Td>
                <Td className="tnum text-right">{plan.lotSize.toLocaleString()}</Td>
                <Td className="tnum text-right">{plan.sampleSize}</Td>
                <Td className="text-ink-secondary">{plan.description}</Td>
              </Tr>
              <Tr>
                <Td>Gate 4 (double)</Td>
                <Td className="tnum text-right">{planG4.lotSize.toLocaleString()}</Td>
                <Td className="tnum text-right">{planG4.sampleSize}</Td>
                <Td className="text-ink-secondary">{planG4.description}</Td>
              </Tr>
            </tbody>
          </Table>
          <p className="text-2xs text-ink-muted">
            The lot is every individually checkable record the book holds — welds, torque
            connections, filed documents, pressure tests, NDE reports, heats and certificates
            — excluding superseded revisions, which are history rather than the book.
          </p>
        </CardBody>
      </Card>

      {peer && peerVerdict && (
        <Card className={peerVerdict.passes ? undefined : 'border-status-critical/30'}>
          <CardHeader>
            <CardTitle>
              Latest peer audit — attempt {peer.attempt}
            </CardTitle>
          </CardHeader>
          <CardBody className="space-y-2 text-xs text-ink-secondary">
            <p className="text-ink">{peerVerdict.explanation}</p>
            {peer.samplePlan && <p>Sampled: {peer.samplePlan}</p>}
            {peerFindings.length > 0 && (
              <Table>
                <thead>
                  <Tr>
                    <Th>Class</Th>
                    <Th>Section</Th>
                    <Th>Finding</Th>
                    <Th>Due</Th>
                    <Th>Resolved</Th>
                  </Tr>
                </thead>
                <tbody>
                  {peerFindings.map((f) => (
                    <Tr key={f.id}>
                      <Td>
                        <Chip
                          tone={
                            f.classification === 'critical' ? 'critical'
                            : f.classification === 'major' ? 'progress' : 'idle'
                          }
                        >
                          {f.classification}
                        </Chip>
                      </Td>
                      <Td className="tnum text-ink-secondary">
                        {f.sectionNumber ? `§${f.sectionNumber}` : '—'}
                      </Td>
                      <Td>{f.summary}</Td>
                      <Td className="tnum text-ink-secondary">{f.dueAt ?? '—'}</Td>
                      <Td className="tnum text-ink-secondary">
                        {f.resolvedAt?.slice(0, 10) ?? '—'}
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            )}
          </CardBody>
        </Card>
      )}

      {sorted.length > 0 && (
        <Card>
          <CardHeader><CardTitle>Audit history</CardTitle></CardHeader>
          <CardBody className="overflow-x-auto p-0">
            <Table>
              <thead>
                <Tr>
                  <Th>Tier</Th>
                  <Th className="text-right">Attempt</Th>
                  <Th>Completed</Th>
                  <Th>Outcome</Th>
                  <Th className="text-right">Score</Th>
                  <Th className="text-right">Sample</Th>
                  <Th className="text-right">Findings</Th>
                </Tr>
              </thead>
              <tbody>
                {sorted.map((a: JobBookAudit) => {
                  const mine = findings.filter((f) => f.auditId === a.id)
                  const criticals = mine.filter((f) => f.classification === 'critical').length
                  return (
                    <Tr key={a.id}>
                      <Td>{TIER_LABEL[a.tier]}</Td>
                      <Td className="tnum text-right">{a.attempt}</Td>
                      <Td className="tnum text-ink-secondary">
                        {a.completedAt?.slice(0, 10) ?? '—'}
                      </Td>
                      <Td>
                        <Chip tone={OUTCOME_TONE[a.outcome]}>
                          {a.outcome === 'in_progress' ? 'in progress' : a.outcome}
                        </Chip>
                      </Td>
                      <Td className="tnum text-right">{a.score ?? '—'}</Td>
                      <Td className="tnum text-right text-ink-secondary">
                        {a.sampleSize != null && a.lotSize != null
                          ? `${a.sampleSize} / ${a.lotSize.toLocaleString()}`
                          : '—'}
                      </Td>
                      <Td className="tnum text-right">
                        {mine.length === 0 ? (
                          <span className="text-ink-muted">0</span>
                        ) : (
                          <span className={criticals > 0 ? 'text-status-critical' : undefined}>
                            {mine.length}
                            {criticals > 0 ? ` (${criticals}C)` : ''}
                          </span>
                        )}
                      </Td>
                    </Tr>
                  )
                })}
              </tbody>
            </Table>
          </CardBody>
        </Card>
      )}

      <Card className={cert && !cert.revokedAt ? 'border-status-complete/30' : undefined}>
        <CardHeader>
          <CardTitle>Completeness Certification — form FDS-JB-F07 (§10.4)</CardTitle>
        </CardHeader>
        <CardBody className="space-y-2 text-xs text-ink-secondary">
          {cert && !cert.revokedAt ? (
            <>
              <p className="text-ink">
                Signed {cert.certifiedAt.slice(0, 10)} at {cert.completionPct}% complete,
                with {cert.sectionsApproved} of {cert.sectionsTotal} sections approved and no
                open Critical or Major findings.
              </p>
              {cert.statement && <p className="italic">&ldquo;{cert.statement}&rdquo;</p>}
              <p className="text-2xs text-ink-muted">
                The figures above are the ones that stood at signature, not today&rsquo;s.
                The book now reads {score.overallPct}%. A certification that merely pointed at
                the current numbers would certify nothing.
              </p>
            </>
          ) : cert?.revokedAt ? (
            <p className="text-status-critical">
              Withdrawn {cert.revokedAt.slice(0, 10)}: {cert.revokedReason}
            </p>
          ) : (
            <p>
              Not signed. §10.4: &ldquo;No job book leaves Fortress without this
              signature.&rdquo; It requires the QA/QC Manager, zero open Critical findings and
              zero open Major findings, and the database refuses it on any of those counts.
            </p>
          )}
        </CardBody>
      </Card>
    </div>
  )
}
