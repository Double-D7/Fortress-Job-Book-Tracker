import { NextResponse } from 'next/server'
import { currentViewer, getDataProvider } from '@/lib/data/provider'
import type { AuditInput } from '@/lib/data/provider'
import type { AuditTier, FindingClass } from '@/lib/domain/types'

/**
 * Record a §10 audit, or sign the Completeness Certification.
 *
 * `?certify=1` signs; anything else records an audit. Both refuse before
 * the round trip and are refused again by the database, which is where
 * §10.2's independence rule and §10.4's manager-only signature actually
 * live — everything here is courtesy.
 */
export const dynamic = 'force-dynamic'

const TIERS = new Set<AuditTier>(['tier_1_self', 'tier_2_peer', 'tier_3_manager'])
const CLASSES = new Set<FindingClass>(['critical', 'major', 'minor'])

/** A finding is the evidence for a deduction. One with no sentence in it
 *  is a number with no reason, which is the thing §10.3 exists to stop. */
const MAX_FINDINGS = 200

export async function POST(
  request: Request,
  { params }: { params: Promise<{ bookId: string }> },
) {
  const { bookId } = await params
  const viewer = await currentViewer()
  if (!viewer) return NextResponse.json({ ok: false, error: 'Not signed in.' }, { status: 401 })

  let body: Record<string, unknown>
  try {
    body = (await request.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ ok: false, error: 'Malformed request.' }, { status: 400 })
  }

  const provider = getDataProvider()

  if (new URL(request.url).searchParams.get('certify') === '1') {
    const statement = typeof body.statement === 'string' ? body.statement.trim() : ''
    const result = await provider.certifyCompleteness(
      viewer, bookId, statement || null,
    )
    return NextResponse.json(result, { status: result.ok ? 200 : 422 })
  }

  const tier = body.tier as AuditTier | undefined
  if (!tier || !TIERS.has(tier)) {
    return NextResponse.json({ ok: false, error: 'Unknown audit tier.' }, { status: 400 })
  }
  const auditorId = typeof body.auditorId === 'string' ? body.auditorId : ''
  if (!auditorId) {
    return NextResponse.json(
      { ok: false, error: 'An audit needs an auditor. §10 attributes every tier to a person.' },
      { status: 400 },
    )
  }

  const raw = Array.isArray(body.findings) ? body.findings : []
  if (raw.length > MAX_FINDINGS) {
    return NextResponse.json(
      { ok: false, error: `That is more than ${MAX_FINDINGS} findings in one audit.` },
      { status: 400 },
    )
  }

  const findings: AuditInput['findings'] = []
  for (const f of raw as Record<string, unknown>[]) {
    const classification = f.classification as FindingClass
    const summary = typeof f.summary === 'string' ? f.summary.trim() : ''
    if (!CLASSES.has(classification)) {
      return NextResponse.json(
        { ok: false, error: 'Every finding is Critical, Major or Minor (§11).' },
        { status: 400 },
      )
    }
    if (!summary) {
      return NextResponse.json(
        { ok: false, error: 'Every finding needs a sentence saying what was found.' },
        { status: 400 },
      )
    }
    findings.push({
      classification,
      summary,
      sectionNumber: typeof f.sectionNumber === 'string' && f.sectionNumber.trim()
        ? f.sectionNumber.trim() : null,
      detail: typeof f.detail === 'string' && f.detail.trim() ? f.detail.trim() : null,
      dueAt: typeof f.dueAt === 'string' && f.dueAt ? f.dueAt : null,
    })
  }

  const result = await provider.recordAudit(viewer, bookId, {
    tier,
    auditorId,
    findings,
    lotSize: typeof body.lotSize === 'number' ? body.lotSize : null,
    sampleSize: typeof body.sampleSize === 'number' ? body.sampleSize : null,
    samplePlan: typeof body.samplePlan === 'string' ? body.samplePlan : null,
    doubleSample: body.doubleSample === true,
    notes: typeof body.notes === 'string' && body.notes.trim() ? body.notes.trim() : null,
  })
  return NextResponse.json(result, { status: result.ok ? 200 : 422 })
}
