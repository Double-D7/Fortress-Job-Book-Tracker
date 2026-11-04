'use client'

/**
 * Uploading evidence into a section.
 *
 * The whole loop a QA/QC tech runs, and deliberately only that: pick files,
 * see what they will do to the section, commit. Nothing is configured here
 * and nothing is interpreted — the scope was declared when the book was
 * created, and this screen only answers "did the count move".
 *
 * The preview is not decoration. Files are sent to the server first, hashed
 * there, and checked against the whole book before anything is written, so
 * the tech is told about a duplicate or a foreign job number *before* it is
 * in the package rather than by a flag afterwards. Same code path, same
 * bytes, both times.
 */
import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { AlertTriangle, Check, FileUp, Info, Loader2, Upload, X } from 'lucide-react'
import { DEFAULT_TYPE_BY_SECTION, TYPE_CODES, type TypeCode } from '@/lib/domain/naming'
import { Button, Card, CardBody, CardHeader, CardTitle, Chip } from '@/components/ui/primitives'
import { bytes, num } from '@/lib/utils'
import type { UploadPreview } from '@/lib/domain/upload'
import { postForJson, tooLargeFor } from '@/lib/http/uploadLimits'
import { uploadDirect, type UploadTarget } from '@/lib/http/directUpload'
import { MAX_FILE_LABEL, validateStagingRequest } from '@/lib/domain/staging'

interface Props {
  bookId: string
  sectionNumber: string
  sectionTitle: string
  canUpload: boolean
  /** Keys from this section's controlled register, for the identifier
   *  field. §9.1: identity comes from a register, never from a filename. */
  registerKeys?: { value: string; label: string }[]
  registerLabel?: string | null
}

export function SectionUpload({
  bookId, sectionNumber, sectionTitle, canUpload,
  registerKeys = [], registerLabel,
}: Props) {
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement>(null)
  const [picked, setPicked] = useState<File[]>([])
  const [preview, setPreview] = useState<UploadPreview | null>(null)
  const [busy, setBusy] = useState<'preview' | 'commit' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<{ added: number; rejected: number } | null>(null)
  const [dragging, setDragging] = useState(false)

  // The three Appendix B elements that cannot be derived from a vendor's
  // filename. They apply to the whole batch, because a batch is normally
  // one document type for one register key on one date — four MTRs for
  // four heats go up as four uploads, which is also what Appendix A §15
  // requires ("one subject per file").
  const [typeCode, setTypeCode] = useState<TypeCode>(
    DEFAULT_TYPE_BY_SECTION[sectionNumber] ?? 'COC',
  )
  const [identifier, setIdentifier] = useState('')
  const [documentDate, setDocumentDate] = useState('')
  /** Set once a batch is in storage. The preview and the commit then
   *  name this instead of carrying the bytes again. */
  const [uploadId, setUploadId] = useState<string | null>(null)
  const [sending, setSending] = useState<{ done: number; total: number } | null>(null)

  const classification = {
    typeCode, identifier: identifier.trim() || null, documentDate: documentDate || null,
  }

  const base = `/api/books/${bookId}/sections/${encodeURIComponent(sectionNumber)}/documents`

  function body(files: File[]): FormData {
    const fd = new FormData()
    for (const f of files) fd.append('files', f)
    fd.append('classification', JSON.stringify(classification))
    return fd
  }

  async function choose(files: File[]) {
    if (!files.length) return
    setPicked(files)
    setPreview(null)
    setDone(null)
    setError(null)
    setUploadId(null)

    // Refused before a byte moves. One mis-scanned 400 MB file should
    // not be discovered at the end of a long upload.
    const problems = validateStagingRequest(
      files.map((f) => ({ name: f.name, size: f.size, mimeType: f.type })),
    )
    if (problems.length > 0) {
      setError(problems.map((p) => p.message).join(' '))
      return
    }

    setBusy('preview')
    const staged = await stageAndSend(files)
    if (staged === 'fallback') {
      // No object storage: post the bytes, which the demo has always
      // done and which a small batch still fits through.
      const over = tooLargeFor(files)
      if (over) {
        setError(over.message)
        setBusy(null)
        return
      }
      const res = await postForJson<{ preview: UploadPreview }>(
        base, { method: 'PUT', body: body(files) },
      )
      if (!res.ok) setError(res.error ?? 'Could not read those files.')
      else setPreview(res.data!.preview)
      setBusy(null)
      return
    }
    setBusy(null)
  }

  /**
   * Put the batch in storage, then ask what it would do to the section.
   *
   * Returns 'fallback' when there is nowhere to stage — the seed has no
   * storage — so the caller can post the bytes instead.
   */
  async function stageAndSend(files: File[]): Promise<'done' | 'fallback'> {
    const reserved = await postForJson<{ uploadId: string; targets: UploadTarget[] }>(
      `${base}/staged`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          files: files.map((f) => ({ name: f.name, size: f.size, mimeType: f.type })),
          classification,
        }),
      },
    )
    if (!reserved.ok) {
      if (/not available|does not have/i.test(reserved.error ?? '')) return 'fallback'
      setError(reserved.error ?? 'Could not prepare the upload.')
      return 'done'
    }

    const { uploadId: id, targets } = reserved.data!
    setSending({ done: 0, total: files.length })
    const sent = await uploadDirect(files, targets, (p) =>
      setSending({ done: p.done, total: p.total }))
    setSending(null)

    if (!sent.ok) {
      setError(sent.error)
      return 'done'
    }

    // The bytes are in the bucket. From here the server reads them
    // back and hashes them itself, so the duplicate check stays the
    // server's finding rather than the browser's word.
    const res = await postForJson<{ preview: UploadPreview }>(
      base,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ uploadId: id }),
      },
    )
    if (!res.ok) {
      setError(res.error ?? 'Could not read those files.')
      return 'done'
    }
    setUploadId(id)
    setPreview(res.data!.preview)
    return 'done'
  }

  async function repreview() {
    if (picked.length) await choose(picked)
  }

  async function commit() {
    // Nothing is sent again when the batch is already in storage: the
    // commit names it and the server moves the objects into the book.
    if (!uploadId) {
      const over = tooLargeFor(picked)
      if (over) {
        setError(over.message)
        return
      }
    }

    setBusy('commit')
    setError(null)
    try {
      const res = await postForJson<{ added: unknown[]; rejected: unknown[] }>(
        base,
        uploadId
          ? {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ uploadId }),
          }
          : { method: 'POST', body: body(picked) },
      )
      if (!res.ok) {
        setError(res.error ?? 'Upload failed.')
        return
      }
      setDone({ added: res.data!.added.length, rejected: res.data!.rejected.length })
      reset(false)
      // The section's score is derived, so the page it lives on has to be
      // re-fetched rather than patched — a number nudged in the browser and
      // a number computed on the server are two different numbers.
      router.refresh()
    } finally {
      setBusy(null)
    }
  }

  function reset(clearDone = true) {
    setUploadId(null)
    setSending(null)
    setPicked([])
    setPreview(null)
    setError(null)
    if (clearDone) setDone(null)
    if (inputRef.current) inputRef.current.value = ''
  }

  if (!canUpload) return null

  const addable = preview?.files.filter((f) => f.willBeAdded).length ?? 0
  const short = preview?.expectedCount != null
    ? preview.expectedCount - preview.countAfter
    : null

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center justify-between gap-2">
        <CardTitle>Add documents to section {sectionNumber}</CardTitle>
        {picked.length > 0 && (
          <Button variant="ghost" onClick={() => reset()}><X size={13} /> Clear</Button>
        )}
      </CardHeader>
      <CardBody className="space-y-3">
        {/* Appendix B needs these, and no amount of filename parsing can
            honestly supply them. Asking is the correct design, not a
            shortfall: §9.1 says identity resolves to a register entry and
            is never inferred from a filename. */}
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <label className="space-y-1">
            <span className="block text-2xs font-medium text-ink-secondary">Document type</span>
            <select
              value={typeCode}
              onChange={(e) => { setTypeCode(e.target.value as TypeCode); void repreview() }}
              className="min-w-0 w-full rounded-md border border-hairline bg-surface-raised px-2 py-1.5 text-xs text-ink"
            >
              {Object.entries(TYPE_CODES).map(([code, label]) => (
                <option key={code} value={code}>{code} — {label}</option>
              ))}
            </select>
          </label>

          <label className="space-y-1">
            <span className="block text-2xs font-medium text-ink-secondary">
              {registerLabel ?? 'Identifier'}
            </span>
            {registerKeys.length ? (
              <select
                value={identifier}
                onChange={(e) => { setIdentifier(e.target.value); void repreview() }}
                className="min-w-0 w-full rounded-md border border-hairline bg-surface-raised px-2 py-1.5 text-xs text-ink"
              >
                <option value="">— pick one —</option>
                {registerKeys.map((k) => (
                  <option key={k.value} value={k.value}>{k.label}</option>
                ))}
              </select>
            ) : (
              <input
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                onBlur={() => void repreview()}
                placeholder="register key"
                className="min-w-0 w-full rounded-md border border-hairline bg-surface-raised px-2 py-1.5 text-xs text-ink placeholder:text-ink-muted"
              />
            )}
          </label>

          <label className="space-y-1">
            <span className="block text-2xs font-medium text-ink-secondary">
              Date on the document
            </span>
            <input
              type="date" value={documentDate}
              onChange={(e) => { setDocumentDate(e.target.value); void repreview() }}
              className="min-w-0 w-full rounded-md border border-hairline bg-surface-raised px-2 py-1.5 text-xs text-ink"
            />
          </label>
        </div>
        <p className="text-2xs leading-relaxed text-ink-muted">
          The date the document itself carries — calibration, test, report or issue date — not
          today. Leave anything blank and the file still files; the name records the gap and it
          reads as a Minor finding until it is filled in.
        </p>

        <div
          onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDragging(false)
            void choose([...e.dataTransfer.files])
          }}
          className={`rounded-lg border border-dashed p-6 text-center transition-colors ${
            dragging ? 'border-brand-bright bg-brand-bright/[0.06]' : 'border-hairline'
          }`}
        >
          <FileUp size={20} className="mx-auto mb-2 text-ink-muted" />
          <p className="text-sm text-ink">Drop files for <span className="text-ink-secondary">{sectionTitle}</span></p>
          <p className="mt-0.5 text-xs text-ink-muted">
            They are checked against the rest of the book before anything is filed.
          </p>
          <p className="mt-0.5 text-2xs text-ink-muted">
            Files go straight to storage, so a batch is not limited by request size.
            Up to {MAX_FILE_LABEL} per file.
          </p>
          <input
            ref={inputRef} type="file" multiple className="hidden"
            aria-label={`Choose files for section ${sectionNumber}`}
            onChange={(e) => void choose([...(e.target.files ?? [])])}
          />
          <Button
            variant="secondary" className="mt-3"
            onClick={() => inputRef.current?.click()}
            disabled={busy !== null}
          >
            <Upload size={13} /> Choose files
          </Button>
        </div>

        {sending && (
          <div className="space-y-1.5">
            <p className="flex items-center gap-2 text-xs text-ink-secondary">
              <Loader2 size={13} className="animate-spin" />
              Uploading {num(Math.min(sending.done + 1, sending.total))} of{' '}
              {num(sending.total)}…
            </p>
            <div className="h-1 overflow-hidden rounded-full bg-hairline">
              <div
                className="h-full bg-brand-bright transition-all"
                style={{ width: `${Math.round((sending.done / sending.total) * 100)}%` }}
              />
            </div>
          </div>
        )}

        {busy === 'preview' && !sending && (
          <p className="flex items-center gap-2 text-xs text-ink-secondary">
            <Loader2 size={13} className="animate-spin" />
            Hashing {num(picked.length)} file{picked.length === 1 ? '' : 's'} and checking the book…
          </p>
        )}

        {error && (
          <p className="flex items-start gap-2 rounded-md bg-status-critical/10 p-2.5 text-xs text-status-critical">
            <AlertTriangle size={13} className="mt-px shrink-0" />{error}
          </p>
        )}

        {done && (
          <p className="flex items-start gap-2 rounded-md bg-status-complete/10 p-2.5 text-xs text-status-complete">
            <Check size={13} className="mt-px shrink-0" />
            Filed {num(done.added)} document{done.added === 1 ? '' : 's'}
            {done.rejected > 0 && `; ${num(done.rejected)} refused and not filed`}.
          </p>
        )}

        {preview && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="text-ink-secondary">
                {num(preview.countBefore)} → <span className="tnum font-medium text-ink">{num(preview.countAfter)}</span> documents
              </span>
              {preview.expectedCount != null && (
                <Chip tone={short != null && short <= 0 ? 'complete' : 'progress'}>
                  {short != null && short > 0
                    ? `${num(short)} short of the ${num(preview.expectedCount)} declared`
                    : `meets the ${num(preview.expectedCount)} declared`}
                </Chip>
              )}
              {preview.blocked > 0 && (
                <Chip tone="critical">{num(preview.blocked)} refused</Chip>
              )}
            </div>

            <ul className="divide-y divide-hairline/60 rounded-md border border-hairline">
              {preview.files.map((f) => (
                <li key={f.sha256 + f.originalFilename} className="p-2.5">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <div className="min-w-0">
                      <div className={f.willBeAdded ? 'text-sm text-ink' : 'text-sm text-ink-muted line-through'}>
                        {f.originalFilename}
                      </div>
                      {f.willBeAdded && (
                        // The name the package will ship under, shown before
                        // committing rather than discovered afterwards.
                        <div className="font-mono text-2xs text-ink-muted">
                          ships as {f.normalizedFilename}
                        </div>
                      )}
                    </div>
                    <span className="tnum shrink-0 font-mono text-2xs text-ink-muted">
                      {bytes(f.byteSize)}
                    </span>
                  </div>
                  {f.issues.map((i) => (
                    <p
                      key={i.kind}
                      className={`mt-1.5 flex items-start gap-1.5 text-2xs ${
                        i.blocking ? 'text-status-critical' : 'text-status-progress'
                      }`}
                    >
                      {i.blocking ? <AlertTriangle size={11} className="mt-px shrink-0" />
                                  : <Info size={11} className="mt-px shrink-0" />}
                      {i.message}
                    </p>
                  ))}
                </li>
              ))}
            </ul>

            <div className="flex items-center gap-2">
              <Button variant="primary" onClick={() => void commit()} disabled={busy !== null || addable === 0}>
                {busy === 'commit'
                  ? <><Loader2 size={13} className="animate-spin" /> Filing…</>
                  : <><Check size={13} /> File {num(addable)} document{addable === 1 ? '' : 's'}</>}
              </Button>
              {addable === 0 && (
                <span className="text-xs text-ink-muted">
                  Nothing here would be added.
                </span>
              )}
            </div>
          </div>
        )}
      </CardBody>
    </Card>
  )
}
