import { NextResponse } from 'next/server'
import { currentViewer, getDataProvider } from '@/lib/data/provider'

/**
 * Add an operator, or correct one's name.
 *
 * The role check here is courtesy — `create_client_org()` and
 * `rename_client_org()` both refuse anyone but an admin, and do so in
 * the same transaction as the write. What this layer is for is turning a
 * missing or malformed body into a sentence rather than a type error
 * from Postgres.
 */
export const dynamic = 'force-dynamic'

async function nameFrom(request: Request): Promise<
  { ok: true; name: string; id?: string } | { ok: false; error: string }
> {
  let body: Record<string, unknown>
  try {
    body = (await request.json()) as Record<string, unknown>
  } catch {
    return { ok: false, error: 'Malformed request.' }
  }
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!name) return { ok: false, error: 'An operator needs a name.' }
  // Long enough for any real operator, short enough that the list stays
  // readable and a paste accident is caught here rather than in a column.
  if (name.length > 120) {
    return { ok: false, error: 'That name is longer than 120 characters.' }
  }
  const id = typeof body.id === 'string' && body.id ? body.id : undefined
  return { ok: true, name, id }
}

export async function POST(request: Request) {
  const viewer = await currentViewer()
  if (!viewer) return NextResponse.json({ ok: false, error: 'Not signed in.' }, { status: 401 })

  const parsed = await nameFrom(request)
  if (!parsed.ok) return NextResponse.json(parsed, { status: 400 })

  const result = await getDataProvider().createClientOrg(viewer, parsed.name)
  return NextResponse.json(result, { status: result.ok ? 200 : 422 })
}

export async function PATCH(request: Request) {
  const viewer = await currentViewer()
  if (!viewer) return NextResponse.json({ ok: false, error: 'Not signed in.' }, { status: 401 })

  const parsed = await nameFrom(request)
  if (!parsed.ok) return NextResponse.json(parsed, { status: 400 })
  if (!parsed.id) {
    return NextResponse.json(
      { ok: false, error: 'Which operator should be renamed?' }, { status: 400 },
    )
  }

  const result = await getDataProvider().renameClientOrg(viewer, parsed.id, parsed.name)
  return NextResponse.json(result, { status: result.ok ? 200 : 422 })
}
