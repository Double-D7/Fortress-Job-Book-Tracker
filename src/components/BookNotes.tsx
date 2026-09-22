'use client'

/**
 * The note thread on a book.
 *
 * Two audiences in one list, which is why every note wears its
 * visibility rather than leaving it to be inferred. A Fortress note
 * defaults to internal; sharing it is a deliberate press. A Client
 * Inspector's note is always shared and the form says so before they
 * write it, because a thread where one side cannot tell who is reading
 * is worse than no thread.
 *
 * Notes cannot be edited or deleted — there is no UPDATE or DELETE
 * policy on the table and none is wanted. A note is somebody's
 * contemporaneous statement about a record; the way to withdraw one is
 * to write the correction underneath it.
 */
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Eye, Loader2, Lock, MessageSquarePlus } from 'lucide-react'
import type { BookNote } from '@/lib/data/provider'
import { roleLabel } from '@/lib/domain/roles'
import {
  Button, Card, CardBody, CardHeader, CardTitle, Chip, EmptyState,
} from '@/components/ui/primitives'

const field =
  'w-full rounded-md border border-hairline bg-surface px-2 py-1.5 text-xs text-ink ' +
  'focus:border-brand-bright focus:outline-none'

function when(iso: string): string {
  return iso.slice(0, 16).replace('T', ' ')
}

export function BookNotes({
  bookId, notes, canAdd, canChooseVisibility, sections, reason,
}: {
  bookId: string
  notes: BookNote[]
  canAdd: boolean
  /** Fortress staff pick; an external author is always shared. */
  canChooseVisibility: boolean
  sections: { sectionNumber: string; title: string }[]
  /** Why the form is absent, where it is. */
  reason?: string
}) {
  const router = useRouter()
  const [body, setBody] = useState('')
  const [sectionNumber, setSectionNumber] = useState('')
  const [shared, setShared] = useState(!canChooseVisibility)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    setBusy(true); setError(null)
    try {
      const res = await fetch(`/api/books/${bookId}/notes`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          body,
          sectionNumber: sectionNumber || null,
          visibility: shared ? 'client' : 'internal',
        }),
      })
      const json = await res.json()
      if (!json.ok) { setError(json.error ?? 'That did not go through.'); return }
      setBody(''); setSectionNumber(''); router.refresh()
    } catch {
      setError('Could not reach the server.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader><CardTitle>Notes</CardTitle></CardHeader>
      <CardBody className="space-y-4">
        {notes.length === 0 ? (
          <EmptyState
            title="No notes on this book yet"
            detail="A note records an observation against the book, a section or a document. It is not an edit to the record itself — raising or resolving a compliance flag is a separate act, and Fortress's."
          />
        ) : (
          <ol className="space-y-3">
            {notes.map((n) => (
              <li key={n.id} className="rounded-md border border-hairline px-3 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-medium text-ink">{n.authorName}</span>
                  <Chip tone="idle">{roleLabel(n.authorRole)}</Chip>
                  {n.visibility === 'internal'
                    ? <Chip tone="brand" icon={<Lock size={11} />}>Fortress only</Chip>
                    : <Chip tone="info" icon={<Eye size={11} />}>Shared with the client</Chip>}
                  {n.sectionNumber && (
                    <Chip tone="idle">§{n.sectionNumber}</Chip>
                  )}
                  <span className="tnum ml-auto text-2xs text-ink-muted">
                    {when(n.createdAt)}
                  </span>
                </div>
                <p className="mt-1.5 whitespace-pre-wrap text-xs leading-relaxed text-ink-secondary">
                  {n.body}
                </p>
              </li>
            ))}
          </ol>
        )}

        {canAdd ? (
          <div className="space-y-2 border-t border-hairline pt-3">
            <textarea
              className={field}
              rows={3}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="What did you observe?"
            />
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-1.5 text-2xs text-ink-secondary">
                Against
                <select
                  className="rounded-md border border-hairline bg-surface px-2 py-1 text-xs text-ink focus:border-brand-bright focus:outline-none"
                  value={sectionNumber}
                  onChange={(e) => setSectionNumber(e.target.value)}
                >
                  <option value="">The book as a whole</option>
                  {sections.map((s) => (
                    <option key={s.sectionNumber} value={s.sectionNumber}>
                      §{s.sectionNumber} {s.title}
                    </option>
                  ))}
                </select>
              </label>

              {canChooseVisibility ? (
                <label className="flex items-center gap-1.5 text-2xs text-ink-secondary">
                  <input type="checkbox" checked={shared}
                         onChange={(e) => setShared(e.target.checked)} />
                  Share this with the client
                </label>
              ) : (
                <span className="text-2xs text-ink-secondary">
                  Your notes are shared with Fortress and with the operator.
                </span>
              )}

              <Button variant="primary" className="ml-auto"
                      disabled={busy || !body.trim()} onClick={submit}>
                {busy ? <Loader2 size={13} className="animate-spin" />
                  : <MessageSquarePlus size={13} />}
                Add the note
              </Button>
            </div>

            {canChooseVisibility && (
              <p className="text-2xs text-ink-secondary">
                {shared
                  ? 'This will be visible to the operator and to any inspector holding a ' +
                    'live grant on this book.'
                  : 'This stays inside Fortress. Nobody outside will see it — which is the ' +
                    'default, so a working note is never published by accident.'}
              </p>
            )}

            {error && (
              <p className="rounded-md border border-status-critical/30 bg-status-critical/10 px-3 py-2 text-xs text-status-critical">
                {error}
              </p>
            )}
          </div>
        ) : reason ? (
          <p className="border-t border-hairline pt-3 text-2xs text-ink-secondary">
            {reason}
          </p>
        ) : null}
      </CardBody>
    </Card>
  )
}
