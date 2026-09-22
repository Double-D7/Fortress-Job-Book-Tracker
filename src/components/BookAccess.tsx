'use client'

/**
 * Who outside Fortress can see this book.
 *
 * The grant is per-book and per-person, optionally until a date, with
 * the right to add notes as a separate switch — so showing a book to an
 * inspector and inviting them to annotate it are two decisions. That
 * separation is the reason this screen exists rather than a checkbox on
 * the user record.
 *
 * Withdrawn and expired grants stay in the table. Who used to be able to
 * read this book is a question an auditor asks, and a register that
 * quietly drops the answer is worse than no register.
 */
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { KeyRound, Loader2, MessageSquare, ShieldOff } from 'lucide-react'
import type { DirectoryUser, InspectorGrant } from '@/lib/data/provider'
import {
  Button, Card, CardBody, CardHeader, CardTitle, Chip, EmptyState,
  Table, Td, Th, Tr,
} from '@/components/ui/primitives'

const field =
  'rounded-md border border-hairline bg-surface px-2 py-1 text-xs text-ink ' +
  'focus:border-brand-bright focus:outline-none'

function day(iso: string | null): string {
  return iso ? iso.slice(0, 10) : '—'
}

export function BookAccess({
  bookId, grants, inspectors, canManage,
}: {
  bookId: string
  grants: InspectorGrant[]
  inspectors: DirectoryUser[]
  canManage: boolean
}) {
  const router = useRouter()
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const [userId, setUserId] = useState('')
  const [expiresAt, setExpiresAt] = useState('')
  const [canComment, setCanComment] = useState(false)

  async function send(url: string, init: RequestInit, key: string, ok: string) {
    setBusy(key); setError(null); setNote(null)
    try {
      const res = await fetch(url, {
        headers: { 'content-type': 'application/json' }, ...init,
      })
      const json = await res.json()
      if (!json.ok) { setError(json.error ?? 'That did not go through.'); return false }
      setNote(ok); router.refresh(); return true
    } catch {
      setError('Could not reach the server.'); return false
    } finally {
      setBusy(null)
    }
  }

  const chosen = inspectors.find((i) => i.id === userId)
  const existing = grants.find((g) => g.userId === userId && g.live)

  return (
    <Card>
      <CardHeader><CardTitle>Client Inspector access</CardTitle></CardHeader>
      <CardBody className="space-y-4 p-0">
        <p className="px-4 pt-4 text-xs leading-relaxed text-ink-secondary">
          A Client Inspector reaches one book at a time, by grant. They see the approved
          contents and none of Fortress&rsquo;s internal working material — not the flag
          queue, not entry timeliness, not the §10 audit history — and every document they
          open is written to the audit log. Adding notes is a separate switch, so a book can
          be shown without being opened to annotation.
        </p>

        {(error || note) && (
          <div className="px-4">
            {error && (
              <p className="rounded-md border border-status-critical/30 bg-status-critical/10 px-3 py-2 text-xs text-status-critical">
                {error}
              </p>
            )}
            {note && !error && (
              <p className="rounded-md border border-status-complete/30 bg-status-complete/10 px-3 py-2 text-xs text-status-complete">
                {note}
              </p>
            )}
          </div>
        )}

        {canManage && (
          <div className="mx-4 space-y-3 rounded-md border border-hairline p-3">
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="flex flex-col gap-1 text-2xs text-ink-secondary">
                Inspector
                <select className={field} value={userId}
                        onChange={(e) => setUserId(e.target.value)}>
                  <option value="">Choose one…</option>
                  {inspectors.map((i) => (
                    <option key={i.id} value={i.id}>{i.fullName} · {i.email}</option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-2xs text-ink-secondary">
                Until (optional)
                <input className={field} type="date" value={expiresAt}
                       onChange={(e) => setExpiresAt(e.target.value)} />
              </label>
              <label className="flex items-end gap-1.5 pb-1 text-2xs text-ink-secondary">
                <input type="checkbox" checked={canComment}
                       onChange={(e) => setCanComment(e.target.checked)} />
                May add notes
              </label>
            </div>

            {inspectors.length === 0 && (
              <p className="text-2xs text-ink-secondary">
                No Client Inspector accounts exist yet. An Admin invites one from the
                administration screen; a grant can only name a Client Inspector, because
                every other role already reaches books by assignment or by operator and a
                grant would widen that rather than describe it.
              </p>
            )}

            {existing && (
              <p className="text-2xs text-ink-secondary">
                {chosen?.fullName} already has this book
                {existing.expiresAt ? ` until ${day(existing.expiresAt)}` : ', open-ended'}.
                Issuing again replaces those terms rather than adding a second grant.
              </p>
            )}

            <p className="text-2xs text-ink-secondary">
              {expiresAt
                ? `Access ends at the close of ${expiresAt}, with no further action needed.`
                : 'With no date, the grant stays open until somebody withdraws it. A date ' +
                  'is the safer default for an inspector engaged for one turnover.'}
            </p>

            <Button variant="primary" disabled={!userId || busy !== null}
                    onClick={() => void send(`/api/books/${bookId}/grants`, {
                      method: 'POST',
                      body: JSON.stringify({ userId, expiresAt: expiresAt || null, canComment }),
                    }, 'issue', `${chosen?.fullName ?? 'The inspector'} now has this book.`)}>
              {busy === 'issue' ? <Loader2 size={13} className="animate-spin" />
                : <KeyRound size={13} />}
              {existing ? 'Replace the grant' : 'Grant access'}
            </Button>
          </div>
        )}

        {grants.length === 0 ? (
          <div className="px-4 pb-4">
            <EmptyState
              title="Nobody outside Fortress has been given this book"
              detail="Client Management sees their own operator's books without a grant. This register is for Client Inspectors, who reach one book at a time."
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <thead>
                <Tr>
                  <Th>Inspector</Th><Th>Notes</Th><Th>Until</Th>
                  <Th>Granted</Th><Th>Status</Th>
                  {canManage && <Th className="text-right">Withdraw</Th>}
                </Tr>
              </thead>
              <tbody>
                {grants.map((g) => (
                  <Tr key={`${g.jobBookId}-${g.userId}`}>
                    <Td>
                      <div className="font-medium text-ink">{g.userName}</div>
                      <div className="text-2xs text-ink-muted">{g.userEmail}</div>
                    </Td>
                    <Td>
                      {g.canComment
                        ? <Chip tone="info" icon={<MessageSquare size={11} />}>May add notes</Chip>
                        : <span className="text-2xs text-ink-secondary">Read only</span>}
                    </Td>
                    <Td className="tnum text-2xs text-ink-secondary">
                      {g.expiresAt ? day(g.expiresAt) : 'Open-ended'}
                    </Td>
                    <Td className="text-2xs text-ink-secondary">
                      {day(g.grantedAt)}
                      {g.grantedByName && <> · {g.grantedByName}</>}
                    </Td>
                    <Td>
                      {g.live ? <Chip tone="complete">Live</Chip>
                        : g.revokedAt ? <Chip tone="idle">Withdrawn {day(g.revokedAt)}</Chip>
                        : <Chip tone="idle">Expired</Chip>}
                    </Td>
                    {canManage && (
                      <Td className="text-right">
                        {g.live && (
                          <Button
                            variant="secondary"
                            disabled={busy !== null}
                            onClick={() => void send(
                              `/api/books/${bookId}/grants?userId=${encodeURIComponent(g.userId)}`,
                              { method: 'DELETE' },
                              `revoke-${g.userId}`,
                              `${g.userName}'s access has been withdrawn.`)}
                          >
                            {busy === `revoke-${g.userId}`
                              ? <Loader2 size={13} className="animate-spin" />
                              : <ShieldOff size={13} />}
                            Withdraw
                          </Button>
                        )}
                      </Td>
                    )}
                  </Tr>
                ))}
              </tbody>
            </Table>
          </div>
        )}

        <p className="border-t border-hairline px-4 py-3 text-2xs text-ink-secondary">
          Withdrawing access takes effect at once and leaves the inspector&rsquo;s notes in
          place: they were true when written, and §15 keeps the record. Expired grants are
          not deleted either — who used to be able to read this book is a question an
          auditor asks.
        </p>
      </CardBody>
    </Card>
  )
}
