import { NextResponse } from 'next/server'
import { currentViewer, getDataProvider } from '@/lib/data/provider'
import type { CredentialInput } from '@/lib/domain/credentials'
import type { NdtMethod } from '@/lib/domain/types'

/**
 * File a CWI or NDT technician credential (§7 and §8).
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

/** A wallet card photographed at full resolution. Generous for a page,
 *  mean enough that nobody files a scanned binder through this form. */
const MAX_BYTES = 10 * 1024 * 1024

function text(form: FormData, key: string): string {
  const v = form.get(key)
  return typeof v === 'string' ? v.trim() : ''
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ bookId: string }> },
) {
  const { bookId } = await params
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
        { ok: false, error: 'Attach the certificate. A credential with no page is a claim, not evidence.' },
        { status: 400 },
      )
    }
    if (entry.size > MAX_BYTES) {
      return NextResponse.json(
        { ok: false, error: `${entry.name} is ${(entry.size / 1e6).toFixed(1)} MB; the limit is 10 MB.` },
        { status: 413 },
      )
    }
    bytes = new Uint8Array(await entry.arrayBuffer())
    filename = entry.name || 'certificate.pdf'

    const subjectType = text(form, 'subjectType')
    input = {
      subjectType: subjectType === 'cwi' ? 'cwi' : 'ndt_technician',
      subjectId: text(form, 'subjectId') || null,
      fullName: text(form, 'fullName') || null,
      initials: text(form, 'initials') || null,
      employer: text(form, 'employer') || null,
      certType: text(form, 'certType'),
      issuingBody: text(form, 'issuingBody') || null,
      issueDate: text(form, 'issueDate'),
      expiryDate: text(form, 'expiryDate') || null,
      ndtMethods: form.getAll('ndtMethods')
        .filter((m): m is string => typeof m === 'string') as NdtMethod[],
    }
  } catch {
    return NextResponse.json({ ok: false, error: 'Malformed upload.' }, { status: 400 })
  }

  const result = await getDataProvider().fileCredential(viewer, bookId, input, bytes, filename)
  return NextResponse.json(result, { status: result.ok ? 200 : 422 })
}
