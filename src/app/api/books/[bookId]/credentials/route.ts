import { NextResponse } from 'next/server'
import { currentViewer, getDataProvider } from '@/lib/data/provider'
import { fileCredentials } from '@/lib/http/fileCredentials'
import type { CredentialInput } from '@/lib/domain/credentials'
import { MAX_CREDENTIAL_BYTES, credentialsFromForm } from '@/lib/http/credentialForm'

/**
 * File a welder, CWI or NDT technician credential (§6, §7 and §8).
 *
 * One card, one person, one page. Not a batch: unlike calibration
 * certificates, these arrive one at a time as people mobilise, and each
 * one needs dates read off it by hand.
 *
 * Nothing here is trusted. The provider re-validates the whole input
 * and checks the person is on this book's roster, because a subject id
 * from a browser is a claim about who evidence belongs to.
 */
export const dynamic = 'force-dynamic'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ bookId: string }> },
) {
  const { bookId } = await params
  const viewer = await currentViewer()
  if (!viewer) return NextResponse.json({ ok: false, error: 'Not signed in.' }, { status: 401 })

  let inputs: CredentialInput[]
  let bytes: Uint8Array
  let filename: string
  try {
    const form = await request.formData()
    const entry = form.get('file')
    if (!(entry instanceof File) || entry.size === 0) {
      return NextResponse.json(
        { ok: false, error: 'Attach the certificate. A credential with no page is a claim, not evidence.' },
        { status: 400 },
      )
    }
    if (entry.size > MAX_CREDENTIAL_BYTES) {
      return NextResponse.json(
        { ok: false, error: `${entry.name} is ${(entry.size / 1e6).toFixed(1)} MB; the limit is 10 MB.` },
        { status: 413 },
      )
    }
    bytes = new Uint8Array(await entry.arrayBuffer())
    filename = entry.name || 'certificate.pdf'

    inputs = credentialsFromForm(form)
  } catch {
    return NextResponse.json({ ok: false, error: 'Malformed upload.' }, { status: 400 })
  }

  const [body, init] = await fileCredentials(
    getDataProvider(), viewer, bookId, inputs, bytes, filename,
  )
  return NextResponse.json(body, init)
}
