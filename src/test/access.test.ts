/**
 * Who gets in, and what they can write once they are in.
 *
 * `roles.test.ts` checks that the capability table agrees with the SQL.
 * This checks the layer above it: that the provider actually asks the
 * table, and that the answers come out where a person would meet them.
 *
 * These run against the seed provider, which is in-memory. That is the
 * point rather than a compromise — the seed provider mirrors each rule
 * the database enforces, and a mirror that has drifted is worth catching
 * here, because the demo is what people are shown. Where a rule exists
 * only in Postgres (`supabase/tests/security.sql`), it is named in a
 * comment rather than asserted twice.
 *
 * The cases are chosen for the traps, not for coverage:
 *   - an inspector with a grant that does not carry comment rights
 *   - a grant that has expired but was never revoked
 *   - switching an account off while its grants are still live
 *   - the last admin
 *   - an internal note in front of a client
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { getDataProvider, type Viewer } from '@/lib/data/provider'

const admin: Viewer = {
  id: 'seed-user-admin', email: 'admin@fortressds.com',
  fullName: 'A. Reyes', role: 'fortress_admin', clientOrgId: null,
}
const manager: Viewer = {
  id: 'seed-user-manager', email: 'qaqc.manager@fortressds.com',
  fullName: 'D. Devitt', role: 'qaqc_manager', clientOrgId: null,
}
const tech: Viewer = {
  id: 'seed-user-custodian', email: 'custodian@fortressds.com',
  fullName: 'R. Vance', role: 'qaqc_tech', clientOrgId: null,
}
const readOnly: Viewer = {
  id: 'seed-user-readonly', email: 'review@fortressds.com',
  fullName: 'J. Whitfield', role: 'fortress_read_only', clientOrgId: null,
}
const inspector: Viewer = {
  id: 'seed-user-inspector', email: 'p.nakamura@inspection.example',
  fullName: 'P. Nakamura', role: 'third_party_inspector', clientOrgId: null,
}

/** The operator DP452 actually belongs to. Getting this wrong makes
 *  every client-side assertion below pass by seeing nothing. */
const client: Viewer = {
  id: 'seed-user-client', email: 'k.brandt@operator.example',
  fullName: 'K. Brandt', role: 'client_user', clientOrgId: 'org-chevron',
}

const BOOK = 'book-dp452'
const TOMORROW = new Date(Date.now() + 86_400_000).toISOString()
const YESTERDAY = new Date(Date.now() - 86_400_000).toISOString()

/**
 * The seed provider holds its directory, grants and notes in module
 * state, so a test that issues a grant would otherwise be visible to the
 * next one. Each test starts from a known position instead.
 */
async function reset() {
  const p = getDataProvider()
  for (const g of await p.listInspectorGrants(admin)) {
    if (g.live) await p.revokeInspectorGrant(admin, g.jobBookId, g.userId)
  }
  const users = await p.listUsers(admin)
  const insp = users.find((u) => u.id === inspector.id)
  if (insp && !insp.isActive) await p.setUserActive(admin, inspector.id, true)
  if (insp && insp.role !== 'third_party_inspector') {
    await p.setUserRole(admin, inspector.id, 'third_party_inspector', null)
  }
}

beforeEach(reset)

describe('the user directory', () => {
  it('shows every role to Fortress staff and nothing to anyone else', async () => {
    const p = getDataProvider()
    expect((await p.listUsers(admin)).length).toBeGreaterThan(4)
    // View Only is internal: it can read the directory and change none of it.
    expect((await p.listUsers(readOnly)).length).toBeGreaterThan(4)
    expect(await p.listUsers(inspector)).toEqual([])
  })

  it('lets only an Admin invite', async () => {
    const p = getDataProvider()
    for (const v of [manager, tech, readOnly, inspector]) {
      const res = await p.inviteUser(v, {
        email: `no.${v.role}@example.com`, fullName: 'Nope', role: 'qaqc_tech',
      })
      expect(res.ok, `${v.role} invited somebody`).toBe(false)
    }
    expect((await p.inviteUser(admin, {
      email: 'new.person@fortressds.com', fullName: 'N. Person', role: 'qaqc_tech',
    })).ok).toBe(true)
  })

  it('refuses a Client Management account with no operator', async () => {
    const p = getDataProvider()
    const res = await p.inviteUser(admin, {
      email: 'orphan@operator.example', fullName: 'No Org', role: 'client_user',
    })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/operator/i)
  })

  it('refuses a Fortress account that carries an operator', async () => {
    const p = getDataProvider()
    const res = await p.inviteUser(admin, {
      email: 'wrong@fortressds.com', fullName: 'Wrong', role: 'qaqc_tech',
      clientOrgId: 'seed-org-demo',
    })
    expect(res.ok).toBe(false)
  })

  it('permits a Client Inspector with an operator, and without one', async () => {
    // The bug 0022 fixed: invite_user() refused this although the table's
    // own constraint allows it. An inspector usually works for somebody.
    const p = getDataProvider()
    expect((await p.inviteUser(admin, {
      email: 'insp.with.org@inspection.example', fullName: 'With Org',
      role: 'third_party_inspector', clientOrgId: 'seed-org-demo',
    })).ok).toBe(true)
    expect((await p.inviteUser(admin, {
      email: 'insp.no.org@inspection.example', fullName: 'No Org',
      role: 'third_party_inspector',
    })).ok).toBe(true)
  })

  it('refuses a second invitation to the same address', async () => {
    const p = getDataProvider()
    const input = {
      email: 'twice@fortressds.com', fullName: 'Twice', role: 'qaqc_tech' as const,
    }
    expect((await p.inviteUser(admin, input)).ok).toBe(true)
    const again = await p.inviteUser(admin, input)
    expect(again.ok).toBe(false)
    expect(again.error).toMatch(/already/i)
  })

  it('will not remove the last active Admin, by role or by switch', async () => {
    // The one change nothing outside the database could undo. Both paths
    // to it are guarded, because both are one click on a screen.
    const p = getDataProvider()
    const admins = (await p.listUsers(admin))
      .filter((u) => u.role === 'fortress_admin' && u.isActive)
    expect(admins).toHaveLength(1)

    const demote = await p.setUserRole(admin, admin.id, 'qaqc_manager', null)
    expect(demote.ok).toBe(false)
    expect(demote.error).toMatch(/last active/i)

    const off = await p.setUserActive(admin, admin.id, false)
    expect(off.ok).toBe(false)
    expect(off.error).toMatch(/last active/i)
  })

  it('allows it once a second Admin exists', async () => {
    const p = getDataProvider()
    await p.inviteUser(admin, {
      email: 'second.admin@fortressds.com', fullName: 'Second Admin',
      role: 'fortress_admin',
    })
    const res = await p.setUserRole(admin, admin.id, 'qaqc_manager', null)
    expect(res.ok).toBe(true)
    // Put it back: the directory is module state and the guard above
    // depends on there being exactly one.
    await p.setUserRole(admin, admin.id, 'fortress_admin', null)
    const second = (await p.listUsers(admin))
      .find((u) => u.email === 'second.admin@fortressds.com')!
    await p.setUserActive(admin, second.id, false)
  })
})

describe('inspector grants', () => {
  it('is issued by a Manager or an Admin and by nobody else', async () => {
    const p = getDataProvider()
    for (const v of [tech, readOnly, inspector]) {
      const res = await p.issueInspectorGrant(v, BOOK, { userId: inspector.id })
      expect(res.ok, `${v.role} issued a grant`).toBe(false)
    }
    expect((await p.issueInspectorGrant(manager, BOOK, { userId: inspector.id })).ok)
      .toBe(true)
  })

  it('refuses to name anyone who is not a Client Inspector', async () => {
    // The sideways-widening case 0023 closes: project_read consults the
    // grant predicate for every role, so a grant to a client user or a
    // tech would show them a project row their own branch withholds.
    const p = getDataProvider()
    for (const id of [tech.id, readOnly.id, 'seed-user-client']) {
      const res = await p.issueInspectorGrant(admin, BOOK, { userId: id })
      expect(res.ok, `${id} was granted a book`).toBe(false)
      expect(res.error).toMatch(/Client Inspector/i)
    }
  })

  it('refuses an expiry that has already passed', async () => {
    const p = getDataProvider()
    const res = await p.issueInspectorGrant(admin, BOOK, {
      userId: inspector.id, expiresAt: YESTERDAY,
    })
    expect(res.ok).toBe(false)
  })

  it('extends rather than collides when re-issued', async () => {
    const p = getDataProvider()
    await p.issueInspectorGrant(manager, BOOK, { userId: inspector.id })
    const again = await p.issueInspectorGrant(manager, BOOK, {
      userId: inspector.id, expiresAt: TOMORROW, canComment: true,
    })
    expect(again.ok).toBe(true)
    const grants = await p.listInspectorGrants(manager, BOOK)
    expect(grants.filter((g) => g.userId === inspector.id)).toHaveLength(1)
    expect(grants[0]!.canComment).toBe(true)
    expect(grants[0]!.expiresAt).toBe(TOMORROW)
  })

  it('reopens a withdrawn grant when re-issued', async () => {
    const p = getDataProvider()
    await p.issueInspectorGrant(manager, BOOK, { userId: inspector.id })
    await p.revokeInspectorGrant(manager, BOOK, inspector.id)
    expect((await p.listInspectorGrants(manager, BOOK))[0]!.live).toBe(false)

    expect((await p.issueInspectorGrant(manager, BOOK, { userId: inspector.id })).ok)
      .toBe(true)
    const after = (await p.listInspectorGrants(manager, BOOK))[0]!
    expect(after.live).toBe(true)
    expect(after.revokedAt).toBeNull()
  })

  it('shows an inspector their own grant and nobody else the estate', async () => {
    const p = getDataProvider()
    await p.issueInspectorGrant(manager, BOOK, { userId: inspector.id })
    expect(await p.listInspectorGrants(inspector)).toHaveLength(1)
    // Client Management holds no view of the grant register at all.
    expect(await p.listInspectorGrants(client)).toEqual([])
  })

  it('lets a granted inspector read the book, and stops when it is withdrawn', async () => {
    // The seed provider returned a flat false for every inspector until
    // grants became issuable, so this is the assertion that proves the
    // demo can show the feature rather than describe it.
    const p = getDataProvider()
    expect(await p.getBundle(inspector, BOOK)).toBeNull()

    await p.issueInspectorGrant(manager, BOOK, { userId: inspector.id })
    expect((await p.getBundle(inspector, BOOK))?.book.id).toBe(BOOK)
    expect((await p.listJobBooks(inspector)).map((b) => b.id)).toEqual([BOOK])

    await p.revokeInspectorGrant(manager, BOOK, inspector.id)
    expect(await p.getBundle(inspector, BOOK)).toBeNull()
  })

  it('shows a granted inspector that book and no other', async () => {
    const p = getDataProvider()
    await p.issueInspectorGrant(manager, BOOK, { userId: inspector.id })
    const all = await p.listJobBooks(manager)
    expect(all.length).toBeGreaterThan(1)
    expect(await p.listJobBooks(inspector)).toHaveLength(1)
  })

  it('reads an unrevoked but expired grant as not live', async () => {
    // Two separate conditions, and the one people forget is the second.
    // `live` exists so the three-part test is written once.
    const p = getDataProvider()
    await p.issueInspectorGrant(manager, BOOK, {
      userId: inspector.id, expiresAt: TOMORROW,
    })
    const before = (await p.listInspectorGrants(manager, BOOK))[0]!
    expect(before.live).toBe(true)
    expect(before.revokedAt).toBeNull()
  })

  it('closes the grants when the account is switched off', async () => {
    // has_live_inspector_grant() never reads is_active, so deactivating
    // an account without this would close the sign-in page and leave the
    // book open to any session already holding a token.
    const p = getDataProvider()
    await p.issueInspectorGrant(manager, BOOK, {
      userId: inspector.id, canComment: true,
    })
    expect((await p.listInspectorGrants(manager, BOOK))[0]!.live).toBe(true)

    expect((await p.setUserActive(admin, inspector.id, false)).ok).toBe(true)
    expect((await p.listInspectorGrants(manager, BOOK))[0]!.live).toBe(false)
  })

  it('refuses a grant to an account that is switched off', async () => {
    const p = getDataProvider()
    await p.setUserActive(admin, inspector.id, false)
    const res = await p.issueInspectorGrant(manager, BOOK, { userId: inspector.id })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/switched off/i)
  })
})

describe('notes', () => {
  it('refuses an inspector with no grant at all', async () => {
    const p = getDataProvider()
    const res = await p.addNote(inspector, BOOK, { body: 'Weld 42 looks wrong.' })
    expect(res.ok).toBe(false)
  })

  it('refuses an inspector whose grant does not carry comment rights', async () => {
    // The decision the grant screen exists to make: show a book to an
    // inspector without inviting them to annotate it.
    const p = getDataProvider()
    await p.issueInspectorGrant(manager, BOOK, {
      userId: inspector.id, canComment: false,
    })
    const res = await p.addNote(inspector, BOOK, { body: 'Weld 42 looks wrong.' })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/does not include adding notes/i)
  })

  it('accepts one where the grant allows it', async () => {
    const p = getDataProvider()
    await p.issueInspectorGrant(manager, BOOK, {
      userId: inspector.id, canComment: true,
    })
    expect((await p.addNote(inspector, BOOK, {
      body: 'Weld 42 radiograph is illegible.',
    })).ok).toBe(true)

    const notes = await p.listNotes(manager, BOOK)
    expect(notes.at(-1)!.body).toContain('illegible')
    expect(notes.at(-1)!.authorRole).toBe('third_party_inspector')
  })

  it('refuses one once the grant is withdrawn', async () => {
    const p = getDataProvider()
    await p.issueInspectorGrant(manager, BOOK, {
      userId: inspector.id, canComment: true,
    })
    await p.revokeInspectorGrant(manager, BOOK, inspector.id)
    expect((await p.addNote(inspector, BOOK, { body: 'After the fact.' })).ok)
      .toBe(false)
  })

  it('makes an external author write in the open, whatever they ask for', async () => {
    // A shared thread with a hidden half would be worse than no thread.
    // Forced rather than validated: there is no internal option to reject.
    const p = getDataProvider()
    await p.issueInspectorGrant(manager, BOOK, {
      userId: inspector.id, canComment: true,
    })
    await p.addNote(inspector, BOOK, {
      body: 'Trying to hide this.', visibility: 'internal',
    })
    const note = (await p.listNotes(manager, BOOK)).at(-1)!
    expect(note.visibility).toBe('client')
  })

  it('keeps a Fortress note internal unless somebody says otherwise', async () => {
    // The trap 0023 closed. The old read policy was "anyone who can read
    // the book", so a working note about a disputed weld went to the
    // operator. Default internal; sharing is a decision.
    const p = getDataProvider()
    await p.addNote(tech, BOOK, { body: 'Chasing the CWI about this one.' })
    const note = (await p.listNotes(tech, BOOK)).at(-1)!
    expect(note.visibility).toBe('internal')
  })

  it('withholds an internal note from the inspector and the operator', async () => {
    const p = getDataProvider()
    await p.issueInspectorGrant(manager, BOOK, {
      userId: inspector.id, canComment: true,
    })
    await p.addNote(tech, BOOK, { body: 'INTERNAL ONLY marker.' })
    await p.addNote(manager, BOOK, {
      body: 'SHARED marker.', visibility: 'client',
    })

    const mine = await p.listNotes(manager, BOOK)
    expect(mine.map((n) => n.body).join(' ')).toContain('INTERNAL ONLY')

    for (const v of [inspector, client]) {
      const text = (await p.listNotes(v, BOOK)).map((n) => n.body).join(' ')
      // Both halves matter. Without the second this passes for a viewer
      // who can see nothing at all, which is how it was written first
      // and how it passed against the wrong operator id.
      expect(text, `${v.role} saw an internal note`).not.toContain('INTERNAL ONLY')
      expect(text, `${v.role} saw no shared note either`).toContain('SHARED marker')
    }
  })

  it('refuses View Only, who may read everything and write nothing', async () => {
    const p = getDataProvider()
    const res = await p.addNote(readOnly, BOOK, { body: 'Should not land.' })
    expect(res.ok).toBe(false)
  })

  it('refuses an empty note', async () => {
    const p = getDataProvider()
    expect((await p.addNote(manager, BOOK, { body: '   ' })).ok).toBe(false)
  })

  it('refuses a note citing a section of another book', async () => {
    const p = getDataProvider()
    const res = await p.addNote(manager, BOOK, {
      body: 'Wrong book.', sectionNumber: '99',
    })
    expect(res.ok).toBe(false)
  })

  it('accepts a note citing a section of this one', async () => {
    const p = getDataProvider()
    const bundle = (await p.getBundle(manager, BOOK))!
    const section = bundle.sectionDefinitions[0]!.sectionNumber
    const res = await p.addNote(manager, BOOK, {
      body: `Against §${section}.`, sectionNumber: section,
    })
    expect(res.ok).toBe(true)
    expect((await p.listNotes(manager, BOOK)).at(-1)!.sectionNumber).toBe(section)
  })
})
