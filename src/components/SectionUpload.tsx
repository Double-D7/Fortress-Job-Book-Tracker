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
import { Button, Card, CardBody, CardHeader, CardTitle, Chip } from '@/components/ui/primitives'
import { bytes, num } from '@/lib/utils'
import type { UploadPreview } from '@/lib/domain/upload'

interface Props {
  bookId: string
  sectionNumber: string
  sectionTitle: string
  canUpload: boolean
}

export function SectionUpload({ bookId, sectionNumber, sectionTitle, canUpload }: Props) {
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement>(null)
  const [picked, setPicked] = useState<File[]>([])
  const [preview, setPreview] = useState<UploadPreview | null>(null)
  const [busy, setBusy] = useState<'preview' | 'commit' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<{ added: number; rejected: number } | null>(null)
  const [dragging, setDragging] = useState(false)

  const base = `/api/books/${bookId}/sections/${encodeURIComponent(sectionNumber)}/documents`

  function body(files: File[]): FormData {
    const fd = new FormData()
    for (const f of files) fd.append('files', f)
    return fd
  }

  async function choose(files: File[]) {
    if (!files.length) return
    setPicked(files)
    setPreview(null)
    setDone(null)
    setError(null)
    setBusy('preview')
    try {
      const res = await fetch(base, { method: 'PUT', body: body(files) })
      const json = await res.json()
      if (!json.ok) setError(json.error ?? 'Could not read those files.')
      else setPreview(json.preview as UploadPreview)
    } catch {
      setError('Could not reach the server.')
    } finally {
      setBusy(null)
    }
  }

  async function commit() {
    setBusy('commit')
    setError(null)
    try {
      const res = await fetch(base, { method: 'POST', body: body(picked) })
      const json = await res.json()
      if (!json.ok) {
        setError(json.error ?? 'Upload failed.')
        return
      }
      setDone({ added: json.added.length, rejected: json.rejected.length })
      reset(false)
      // The section's score is derived, so the page it lives on has to be
      // re-fetched rather than patched — a number nudged in the browser and
      // a number computed on the server are two different numbers.
      router.refresh()
    } catch {
      setError('Could not reach the server.')
    } finally {
      setBusy(null)
    }
  }

  function reset(clearDone = true) {
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

        {busy === 'preview' && (
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
