'use client'

/**
 * The operator list, and the two things an admin does to it.
 *
 * A job book cannot be created without an operator, and until this
 * screen existed the only way to add one was to open a SQL editor
 * against the production database. That made setting up a new client an
 * engineering task rather than an administrative one.
 *
 * Both actions are already refused by the database for anyone but an
 * admin, so `canManage` governs what is rendered rather than what is
 * permitted. A manager reads the same list and meets no controls, which
 * is the honest shape: they are entitled to know which operators exist,
 * because they pick from this list when they create a book.
 *
 * The book count is on screen for a reason. It is what tells somebody
 * that "Oxy" with four books is the real one and the empty "OXY" they
 * just made is the mistake — and it is why the answer to a misspelled
 * operator is to correct it rather than add another.
 */
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Building2, Check, Loader2, Pencil, Plus, X } from 'lucide-react'
import type { Operator } from '@/lib/data/provider'
import {
  Button, Card, CardBody, CardHeader, CardTitle, Chip, Table, Td, Th, Tr,
} from '@/components/ui/primitives'

const field =
  'rounded-md border border-hairline bg-surface px-2 py-1 text-xs text-ink ' +
  'focus:border-brand-bright focus:outline-none'

export function OperatorAdmin({
  operators, canManage,
}: {
  operators: Operator[]
  canManage: boolean
}) {
  const router = useRouter()
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const [adding, setAdding] = useState(false)
  const [newName, setNewName] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')

  async function send(init: RequestInit, key: string, ok: string) {
    setBusy(key); setError(null); setNote(null)
    try {
      const res = await fetch('/api/client-orgs', {
        headers: { 'content-type': 'application/json' }, ...init,
      })
      const json = (await res.json()) as { ok: boolean; error?: string }
      if (!json.ok) { setError(json.error ?? 'That did not work.'); return false }
      setNote(ok)
      router.refresh()
      return true
    } catch {
      setError('Could not reach the server.')
      return false
    } finally {
      setBusy(null)
    }
  }

  async function add() {
    const done = await send(
      { method: 'POST', body: JSON.stringify({ name: newName }) },
      'add', `${newName.trim()} added.`,
    )
    if (done) { setNewName(''); setAdding(false) }
  }

  async function rename(id: string) {
    const done = await send(
      { method: 'PATCH', body: JSON.stringify({ id, name: editName }) },
      id, 'Name corrected.',
    )
    if (done) setEditingId(null)
  }

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center justify-between gap-2">
        <CardTitle>Operators</CardTitle>
        <span className="text-2xs text-ink-muted">
          Every job book belongs to one. Pick from this list when creating a book.
        </span>
      </CardHeader>

      {canManage && (
        <CardBody className="border-b border-hairline">
          {adding ? (
            <div className="flex flex-wrap items-center gap-2">
              <input
                className={`${field} min-w-[16rem] flex-1`}
                placeholder="Operator name, as it should appear on a book"
                value={newName}
                autoFocus
                maxLength={120}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && newName.trim()) void add() }}
              />
              <Button
                variant="primary"
                disabled={!newName.trim() || busy === 'add'}
                onClick={() => void add()}
              >
                {busy === 'add'
                  ? <Loader2 size={12} className="animate-spin" />
                  : <Check size={12} />}
                Add operator
              </Button>
              <Button
                variant="ghost"
                onClick={() => { setAdding(false); setNewName(''); setError(null) }}
              >
                Cancel
              </Button>
            </div>
          ) : (
            <Button variant="secondary" onClick={() => { setAdding(true); setNote(null) }}>
              <Plus size={12} /> Add an operator
            </Button>
          )}

          {error && <p className="mt-2 text-2xs text-status-critical">{error}</p>}
          {note && <p className="mt-2 text-2xs text-status-complete">{note}</p>}
        </CardBody>
      )}

      <CardBody className="p-0">
        {operators.length === 0 ? (
          <p className="px-5 py-4 text-xs text-ink-secondary">
            No operators yet. A job book cannot be created until there is one.
          </p>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Operator</Th>
                <Th className="text-right">Job books</Th>
                {canManage && <Th className="w-24" />}
              </tr>
            </thead>
            <tbody>
              {operators.map((o) => (
                <Tr key={o.id}>
                  <Td>
                    {editingId === o.id ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <input
                          className={`${field} min-w-[14rem]`}
                          value={editName}
                          autoFocus
                          maxLength={120}
                          onChange={(e) => setEditName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && editName.trim()) void rename(o.id)
                            if (e.key === 'Escape') setEditingId(null)
                          }}
                        />
                        <Button
                          variant="primary"
                          disabled={!editName.trim() || busy === o.id}
                          onClick={() => void rename(o.id)}
                        >
                          {busy === o.id
                            ? <Loader2 size={12} className="animate-spin" />
                            : <Check size={12} />}
                          Save
                        </Button>
                        <Button variant="ghost" onClick={() => setEditingId(null)}>
                          <X size={12} />
                        </Button>
                      </div>
                    ) : (
                      <span className="flex items-center gap-2">
                        <Building2 size={12} className="text-ink-muted" />
                        {o.name}
                      </span>
                    )}
                  </Td>
                  <Td className="tnum text-right font-mono text-ink-secondary">
                    {o.bookCount > 0
                      ? o.bookCount
                      : <Chip tone="progress">Unused</Chip>}
                  </Td>
                  {canManage && (
                    <Td className="text-right">
                      {editingId !== o.id && (
                        <Button
                          variant="ghost"
                          onClick={() => {
                            setEditingId(o.id); setEditName(o.name)
                            setError(null); setNote(null)
                          }}
                        >
                          <Pencil size={12} /> Rename
                        </Button>
                      )}
                    </Td>
                  )}
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </CardBody>

      {canManage && (
        <CardBody className="border-t border-hairline">
          <p className="text-2xs leading-relaxed text-ink-muted">
            An operator cannot be deleted. One with books behind it cannot be removed
            without orphaning them, and one with none costs nothing to leave. If a name
            is wrong, correct it here rather than adding a second operator: the name
            shown here is the name printed on every book that belongs to it.
          </p>
        </CardBody>
      )}
    </Card>
  )
}
