'use client'

/**
 * The user directory, and the three things an admin does to it.
 *
 * Everything on this screen is already refused by the database for
 * anyone but an admin, so `canManage` governs what is rendered rather
 * than what is permitted. A View Only viewer reads the same table and
 * meets no controls, which is the honest shape: they are entitled to
 * know who has access.
 *
 * Two things stated on screen rather than left to be discovered. That an
 * invitation is an allowlist entry and not an account — the "Not signed
 * in yet" chip is the most common support question in a system like this
 * — and that an account is switched off rather than deleted, because
 * somebody will look for the delete button and should find the reason
 * instead.
 */
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, Mail, ShieldCheck, UserPlus } from 'lucide-react'
import type { DirectoryUser } from '@/lib/data/provider'
import { ROLES, orgRequirement, roleDefinition } from '@/lib/domain/roles'
import type { UserRole } from '@/lib/domain/types'
import {
  Button, Card, CardBody, CardHeader, CardTitle, Chip, Table, Td, Th, Tr,
} from '@/components/ui/primitives'

const field =
  'rounded-md border border-hairline bg-surface px-2 py-1 text-xs text-ink ' +
  'focus:border-brand-bright focus:outline-none'

export function UserAdmin({
  users, orgs, canManage, viewerId,
}: {
  users: DirectoryUser[]
  orgs: { id: string; name: string }[]
  canManage: boolean
  viewerId: string
}) {
  const router = useRouter()
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [inviting, setInviting] = useState(false)

  const [email, setEmail] = useState('')
  const [fullName, setFullName] = useState('')
  const [role, setRole] = useState<UserRole>('qaqc_tech')
  const [orgId, setOrgId] = useState('')

  const requirement = orgRequirement(role)

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

  async function invite() {
    const done = await send('/api/users', {
      method: 'POST',
      body: JSON.stringify({
        email, fullName, role,
        clientOrgId: requirement === 'forbidden' ? null : orgId || null,
      }),
    }, 'invite', `Invited ${email}.`)
    if (done) { setEmail(''); setFullName(''); setOrgId(''); setInviting(false) }
  }

  const activeAdmins = users.filter(
    (u) => u.role === 'fortress_admin' && u.isActive).length

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center justify-between gap-2">
        <CardTitle>People</CardTitle>
        {canManage && (
          <Button onClick={() => { setInviting((v) => !v); setError(null); setNote(null) }}>
            <UserPlus size={13} /> {inviting ? 'Cancel' : 'Invite somebody'}
          </Button>
        )}
      </CardHeader>
      <CardBody className="space-y-4 p-0">
        {(error || note) && (
          <div className="px-4 pt-4">
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

        {inviting && canManage && (
          <div className="mx-4 mt-4 space-y-3 rounded-md border border-hairline p-3">
            <p className="text-2xs text-ink-secondary">
              An invitation is an entry on the allowlist, not an account. The person still
              signs in with this address themselves, and the two halves link the moment
              either one appears — so inviting somebody who has already tried to sign in
              works, and so does the other order.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1 text-2xs text-ink-secondary">
                Full name
                <input className={field} value={fullName}
                       onChange={(e) => setFullName(e.target.value)}
                       placeholder="R. Vance" />
              </label>
              <label className="flex flex-col gap-1 text-2xs text-ink-secondary">
                Email
                <input className={field} type="email" value={email}
                       onChange={(e) => setEmail(e.target.value)}
                       placeholder="r.vance@fortressds.com" />
              </label>
              <label className="flex flex-col gap-1 text-2xs text-ink-secondary">
                Role
                <select className={field} value={role}
                        onChange={(e) => setRole(e.target.value as UserRole)}>
                  {ROLES.map((r) => (
                    <option key={r.role} value={r.role}>{r.label}</option>
                  ))}
                </select>
              </label>
              {requirement !== 'forbidden' && (
                <label className="flex flex-col gap-1 text-2xs text-ink-secondary">
                  Operator {requirement === 'optional' && '(optional)'}
                  <select className={field} value={orgId}
                          onChange={(e) => setOrgId(e.target.value)}>
                    <option value="">
                      {requirement === 'required' ? 'Choose one…' : 'None'}
                    </option>
                    {orgs.map((o) => (
                      <option key={o.id} value={o.id}>{o.name}</option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            <p className="text-2xs text-ink-secondary">
              {roleDefinition(role).summary}
            </p>
            <Button variant="primary" onClick={invite}
                    disabled={busy !== null || !email || !fullName
                              || (requirement === 'required' && !orgId)}>
              {busy === 'invite' ? <Loader2 size={13} className="animate-spin" />
                : <Mail size={13} />}
              Send the invitation
            </Button>
          </div>
        )}

        <div className="overflow-x-auto">
          <Table>
            <thead>
              <Tr>
                <Th>Name</Th><Th>Role</Th><Th>Sees</Th><Th>Operator</Th>
                <Th>Status</Th>{canManage && <Th className="text-right">Change</Th>}
              </Tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const def = roleDefinition(u.role)
                // The guard the database enforces, shown before it fires.
                // An admin who clicks and reads a refusal has been told
                // something they could have been told beforehand.
                const lastAdmin = u.role === 'fortress_admin'
                  && u.isActive && activeAdmins === 1
                return (
                  <Tr key={u.id}>
                    <Td>
                      <div className="font-medium text-ink">{u.fullName}</div>
                      <div className="text-2xs text-ink-muted">{u.email}</div>
                    </Td>
                    <Td>
                      <Chip tone={def.isInternal ? 'brand' : 'info'}>{def.label}</Chip>
                    </Td>
                    <Td className="text-2xs text-ink-secondary">{def.scopeLabel}</Td>
                    <Td className="text-2xs text-ink-secondary">
                      {u.clientOrgName ?? '—'}
                    </Td>
                    <Td>
                      <div className="flex flex-wrap gap-1">
                        <Chip tone={u.isActive ? 'complete' : 'idle'}>
                          {u.isActive ? 'Active' : 'Switched off'}
                        </Chip>
                        {!u.linked && (
                          <Chip tone="idle" title="Invited, but nobody has signed in with this address yet">
                            Not signed in yet
                          </Chip>
                        )}
                        {lastAdmin && (
                          <Chip tone="info" icon={<ShieldCheck size={11} />}>
                            Last admin
                          </Chip>
                        )}
                      </div>
                    </Td>
                    {canManage && (
                      <Td className="text-right">
                        <div className="flex flex-wrap items-center justify-end gap-1.5">
                          <select
                            className={field}
                            value={u.role}
                            disabled={busy !== null || lastAdmin}
                            onChange={(e) => {
                              const next = e.target.value as UserRole
                              const req = orgRequirement(next)
                              void send(`/api/users/${u.id}`, {
                                method: 'PATCH',
                                body: JSON.stringify({
                                  role: next,
                                  // Carry the operator only where the new
                                  // role may hold one; moving to a Fortress
                                  // role must drop it or the row is refused.
                                  clientOrgId: req === 'forbidden' ? null : u.clientOrgId,
                                }),
                              }, `role-${u.id}`, `${u.fullName} is now ${roleDefinition(next).label}.`)
                            }}
                          >
                            {ROLES.map((r) => (
                              <option key={r.role} value={r.role}>{r.label}</option>
                            ))}
                          </select>
                          <Button
                            variant="secondary"
                            disabled={busy !== null || lastAdmin}
                            onClick={() => void send(`/api/users/${u.id}`, {
                              method: 'PATCH',
                              body: JSON.stringify({ isActive: !u.isActive }),
                            }, `active-${u.id}`,
                              `${u.fullName} ${u.isActive ? 'switched off' : 'switched on'}.`)}
                          >
                            {busy === `active-${u.id}`
                              ? <Loader2 size={13} className="animate-spin" /> : null}
                            {u.isActive ? 'Switch off' : 'Switch on'}
                          </Button>
                        </div>
                        {u.id === viewerId && (
                          <div className="mt-1 text-2xs text-ink-muted">This is you</div>
                        )}
                      </Td>
                    )}
                  </Tr>
                )
              })}
            </tbody>
          </Table>
        </div>

        <p className="border-t border-hairline px-4 py-3 text-2xs text-ink-secondary">
          Accounts are switched off, never deleted. The audit log names a person&rsquo;s id on
          every row it has ever written, and §15 keeps those records for the retention
          period — a weld inspected in 2024 still has to name who inspected it in 2031.
          Switching an account off also withdraws any Client Inspector grants it holds,
          because a grant is checked against the book rather than against the sign-in page.
        </p>
      </CardBody>
    </Card>
  )
}
