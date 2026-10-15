import { NextResponse } from 'next/server'
import { currentViewer, getDataProvider } from '@/lib/data/provider'
import type { CredentialInput } from '@/lib/domain/credentials'
import { MAX_CREDENTIAL_BYTES, credentialFromForm } from '@/lib/http/credentialForm'

/**
 * File a welder, CWI or NDT technician credential into the library.
 *
 * No job book in the path, because a card belongs to the person rather
 * than to a job. Which books show it is decided by migration 0043, from
 * who has signed what. The book-scoped route still exists for filing
 * from a book's Personnel screen, where rescoring that book immediately
 * is worth the extra argument.
 *
 * Nothing here is trusted. The provider re-validates the whole input and
 * checks the person is on the roster, because a subject id from a
 * browser is a claim about who evidence belongs to.
 */
export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  const viewer = await currentViewer()
  if (!viewer) return NextResponse.json({ ok: false, error: 'Not signed in.' }, { status: 401 })

  let input: CredentialInput
  let bytes: Uint8Array
  let filename: string
  try {
    const form = await request.formData()
    const entry = form.get('file')
    if (!(entry instanceof File) || entry.size === 0) {
      return NextResponse.json(
        {
          ok: false,
          error: 'Attach the certificate. A credential with no page is a claim, not evidence.',
        },
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

    input = credentialFromForm(form)
  } catch {
    return NextResponse.json({ ok: false, error: 'Malformed upload.' }, { status: 400 })
  }

  const result = await getDataProvider().fileCredential(viewer, null, input, bytes, filename)
  return NextResponse.json(result, { status: result.ok ? 200 : 422 })
}
