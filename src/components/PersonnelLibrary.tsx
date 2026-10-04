'use client'

/**
 * The personnel credential library.
 *
 * Sections 7 and 8 ask whether the people who inspected this pipe were
 * qualified to. An ASNT card is the same card on every job the
 * technician works, so it is filed here once and follows them: a book
 * picks it up when they sign a weld or a report on it, including books
 * they worked before the card arrived.
 *
 * This screen is the library itself rather than any one book's
 * register. The question it answers is "do we hold a current card for
 * this person", which is asked long before anybody knows which job
 * wants it, and "who is certified for RT", which is asked when work is
 * being planned.
 */
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { AlertTriangle, Loader2, Search, Trash2, X } from 'lucide-react'
import type { PersonnelLibraryEntry } from '@/lib/data/provider'
import { evaluateCert } from '@/lib/domain/certificates'
import {
  Button, Card, CardBody, CardHeader, CardTitle, Chip, EmptyState,
  Table, Td, Th, Tr,
} from '@/components/ui/primitives'

const FIELD =
  'rounded-md border border-hairline bg-surface px-2 py-1 text-xs text-ink ' +
  'focus:border-brand-bright focus:outline-none'

/** Warn this far ahead. A card expiring inside a month is a card
 *  somebody has to chase before the next mobilisation. */
const WARN_DAYS = 45

const ROSTER_LABEL: Record<string, string> = {
  cwi: 'CWI',
  ndt_technician: 'NDT',
}

export function PersonnelLibrary({
  entries, canManage, search,
}: {
  entries: PersonnelLibraryEntry[]
  canManage: boolean
  search: string
}) {
  const router = useRouter()
  const [term, setTerm] = useState(search)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const today = new Date().toISOString().slice(0, 10)

  async function withdraw(id: string, who: string) {
    const reason = window.prompt(
      `Withdraw this credential for ${who}?\n\n`
      + 'Every book that pulled it will stop claiming it is on file. '
      + 'Say why, for the record.',
    )
    if (reason === null) return
    if (!reason.trim()) { setError('Withdrawing a credential needs a reason.'); return }

    setBusy(id); setError(null)
    try {
      const res = await fetch(`/api/credentials/${id}`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason }),
      })
      const json = (await res.json()) as { ok: boolean; error?: string }
      if (!json.ok) setError(json.error ?? 'That did not work.')
      else router.refresh()
    } catch {
      setError('Could not reach the server.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center justify-between gap-2">
        <CardTitle>Credentials on file</CardTitle>
        <form className="flex items-center gap-1.5" action="/credentials">
          <Search size={13} className="text-ink-muted" />
          <input name="q" value={term} onChange={(e) => setTerm(e.target.value)}
                 className={FIELD} placeholder="Name, certificate or method" />
          {term && (
            <Button variant="secondary" type="button"
                    onClick={() => { setTerm(''); router.push('/credentials') }}>
              <X size={12} />
            </Button>
          )}
        </form>
      </CardHeader>

      <CardBody className="p-0">
        {entries.length === 0 ? (
          <div className="p-4">
            <EmptyState
              title={search ? `Nothing on file for “${search}”` : 'No credentials on file yet'}
              detail={search
                ? 'Try the person’s surname, or a method on its own: RT, PT, MT, UT.'
                : 'File a card from any book’s Personnel screen. Each only has to be '
                  + 'filed once, however many job books that person works.'}
            />
          </div>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Person</Th><Th>Roster</Th><Th>Certificate</Th><Th>Methods</Th>
                <Th>Issued</Th><Th>Expires</Th><Th className="text-right">On books</Th>
                {canManage && <Th className="w-10" />}
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => {
                // Status against today, which is the question this
                // screen asks. Whether a card covered a report written
                // last March is the book's question, not the library's.
                const status = evaluateCert(
                  { ...e, subjectType: e.subjectType } as never, WARN_DAYS, today)
                return (
                  <Tr key={e.id}>
                    <Td className="font-medium text-ink">{e.personName}</Td>
                    <Td>
                      <Chip tone="idle">{ROSTER_LABEL[e.subjectType] ?? e.subjectType}</Chip>
                    </Td>
                    <Td className="text-ink-secondary">
                      {e.certType}
                      {e.issuingBody && (
                        <div className="text-2xs text-ink-muted">{e.issuingBody}</div>
                      )}
                    </Td>
                    <Td>
                      {e.ndtMethods && e.ndtMethods.length > 0
                        ? <span className="font-mono text-xs">{e.ndtMethods.join(', ')}</span>
                        : e.subjectType === 'ndt_technician'
                          ? <Chip tone="progress">Not recorded</Chip>
                          : <span className="text-ink-muted">—</span>}
                    </Td>
                    <Td className="tnum font-mono text-ink-secondary">{e.issueDate}</Td>
                    <Td className="tnum font-mono">
                      {e.expiryDate ?? <span className="text-ink-muted">none printed</span>}
                      {status.status === 'expired' && (
                        <Chip tone="critical" className="ml-1.5">
                          <AlertTriangle size={10} /> Expired
                        </Chip>
                      )}
                      {status.status === 'expiring_soon' && (
                        <Chip tone="progress" className="ml-1.5">
                          {status.daysUntilExpiry} d
                        </Chip>
                      )}
                    </Td>
                    <Td className="tnum text-right font-mono">{e.referencedByBooks}</Td>
                    {canManage && (
                      <Td className="text-right">
                        <Button
                          variant="ghost"
                          disabled={busy === e.id}
                          onClick={() => void withdraw(e.id, e.personName)}
                        >
                          {busy === e.id
                            ? <Loader2 size={12} className="animate-spin" />
                            : <Trash2 size={12} />}
                        </Button>
                      </Td>
                    )}
                  </Tr>
                )
              })}
            </tbody>
          </Table>
        )}
        {error && <p className="px-5 py-2 text-2xs text-status-critical">{error}</p>}
      </CardBody>

      {entries.length > 0 && (
        <CardBody className="border-t border-hairline">
          <p className="text-2xs leading-relaxed text-ink-muted">
            “On books” counts the job books that have pulled this card in, which happens
            when the person signs a weld or an NDE report. Withdrawing a card stops every
            one of them claiming it is on file; the page itself is kept, because retention
            outlives the correction.
          </p>
        </CardBody>
      )}
    </Card>
  )
}
