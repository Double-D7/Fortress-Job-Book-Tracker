import { NextResponse } from 'next/server'
import { currentViewer, getDataProvider } from '@/lib/data/provider'
import { evaluateGate } from '@/lib/domain/gates'
import type { GateId, GateOutcome } from '@/lib/domain/types'

/**
 * Chair a gate review, or name a Custodian.
 *
 * The criteria are evaluated HERE, server-side, from the book as it stands
 * at the moment the decision is taken — never accepted from the browser.
 * A gate decision is an assertion about the book's state, and a client
 * that could supply that state could assert anything it liked about it.
 * The screen shows an evaluation; this route takes its own.
 */
export const dynamic = 'force-dynamic'

const GATES = new Set<GateId>(['G0', 'G1', 'G2', 'G3', 'G4', 'G5'])
const OUTCOMES = new Set<GateOutcome>(['pass', 'conditional_pass', 'fail'])

export async function POST(
  request: Request,
  { params }: { params: Promise<{ bookId: string }> },
) {
  const { bookId } = await params
  const viewer = await currentViewer()
  if (!viewer) return NextResponse.json({ ok: false, error: 'Not signed in.' }, { status: 401 })

  let body: {
    action?: string
    gate?: string
    outcome?: string
    userId?: string
    conditionalDueAt?: string | null
    projectManagerId?: string | null
    overrideNote?: string | null
    notes?: string | null
  }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return NextResponse.json({ ok: false, error: 'Malformed request.' }, { status: 400 })
  }

  const provider = getDataProvider()

  if (body.action === 'assign-custodian') {
    if (!body.userId) {
      return NextResponse.json({ ok: false, error: 'No user given.' }, { status: 400 })
    }
    const result = await provider.assignCustodian(viewer, bookId, body.userId)
    return NextResponse.json(result, { status: result.ok ? 200 : 422 })
  }

  const gate = body.gate as GateId | undefined
  const outcome = body.outcome as GateOutcome | undefined
  if (!gate || !GATES.has(gate)) {
    return NextResponse.json({ ok: false, error: 'Unknown gate.' }, { status: 400 })
  }
  if (!outcome || !OUTCOMES.has(outcome)) {
    return NextResponse.json({ ok: false, error: 'Unknown outcome.' }, { status: 400 })
  }

  const bundle = await provider.getBundle(viewer, bookId)
  if (!bundle) return NextResponse.json({ ok: false, error: 'Job book not found.' }, { status: 404 })

  const side = await provider.gateContext(viewer, bookId)
  const evaluation = evaluateGate(gate, bundle, {
    custodianName: side.custodianName,
    custodianCompetency: side.custodianCompetency,
  })

  const result = await provider.recordGateReview(viewer, bookId, {
    gate,
    outcome,
    criteria: evaluation.criteria,
    completionPct: evaluation.completionPct,
    projectManagerId: body.projectManagerId ?? null,
    conditionalDueAt: body.conditionalDueAt ?? null,
    overrideNote: body.overrideNote ?? null,
    notes: body.notes ?? null,
  })
  return NextResponse.json(result, { status: result.ok ? 200 : 422 })
}
