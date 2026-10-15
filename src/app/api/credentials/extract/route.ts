import { NextResponse } from 'next/server'
import { currentViewer } from '@/lib/data/provider'
import { can } from '@/lib/domain/roles'
import { MAX_CREDENTIAL_BYTES } from '@/lib/http/credentialForm'
import { readCredential } from '@/lib/extract/readCredential'

/**
 * Read a certificate and hand back a draft.
 *
 * Writes nothing. This endpoint exists so somebody does not have to
 * type twelve fields off a photograph of a wallet card; what gets
 * filed is whatever they confirm afterwards through the ordinary
 * filing route, which re-validates all of it.
 *
 * Gated on `edit_records` even though it changes nothing, because it
 * spends money on an upstream API and reads whatever page it is given.
 * A read endpoint open to anyone with a session is a way to run a
 * document through somebody else's account.
 */
export const dynamic = 'force-dynamic'

/** Longer than the usual route: a scanned page is read by a model, not
 *  parsed, and a slow one should fill the form rather than time out. */
export const maxDuration = 60

export async function POST(request: Request) {
  const viewer = await currentViewer()
  if (!viewer) return NextResponse.json({ ok: false, error: 'Not signed in.' }, { status: 401 })
  if (!can(viewer.role, 'edit_records')) {
    return NextResponse.json(
      { ok: false, error: 'You do not have permission to file credentials.' },
      { status: 403 },
    )
  }

  let bytes: Uint8Array
  let filename: string
  try {
    const form = await request.formData()
    const entry = form.get('file')
    if (!(entry instanceof File) || entry.size === 0) {
      return NextResponse.json(
        { ok: false, error: 'Attach the certificate first.' },
        { status: 400 },
      )
    }
    if (entry.size > MAX_CREDENTIAL_BYTES) {
      return NextResponse.json(
        {
          ok: false,
          error: `${entry.name} is ${(entry.size / 1e6).toFixed(1)} MB; the limit is 10 MB.`,
        },
        { status: 413 },
      )
    }
    bytes = new Uint8Array(await entry.arrayBuffer())
    filename = entry.name || 'certificate.pdf'
  } catch {
    return NextResponse.json({ ok: false, error: 'Malformed upload.' }, { status: 400 })
  }

  const result = await readCredential(bytes, filename)
  if (!result.ok) {
    // 200 with ok:false for a reading that did not work. The request
    // was fine and the page is still filable by hand; the form shows
    // the reason and leaves the fields empty rather than treating it
    // as a failed upload.
    const status = result.reason === 'not_configured' ? 503 : 200
    return NextResponse.json({ ok: false, error: result.error, reason: result.reason }, { status })
  }

  return NextResponse.json({ ok: true, draft: result.draft })
}
