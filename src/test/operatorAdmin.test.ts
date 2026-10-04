/**
 * Adding an operator, which until now meant opening a SQL editor.
 *
 * A job book cannot be created without an operator, and nothing in the
 * application could create one. That single gap meant setting up a new
 * client was an engineering task: the first field of the new-book form
 * could not be filled in.
 *
 * The rules worth holding are about the name. It is printed on every
 * book that belongs to the operator and it is what somebody picks from a
 * list, so two operators whose names differ only by case are two ways to
 * file the same client's work in two places.
 */
import { describe, expect, it } from 'vitest'
import { getDataProvider, type Viewer } from '@/lib/data/provider'

const admin: Viewer = {
  id: 'u-admin', email: 'admin@fortressds.com', fullName: 'A. Admin',
  role: 'fortress_admin', clientOrgId: null,
}
const manager: Viewer = {
  id: 'u-mgr', email: 'm@fortressds.com', fullName: 'M. Ruiz',
  role: 'qaqc_manager', clientOrgId: null,
}

/** Distinct per test: the seed provider is one mutable instance shared
 *  across this file, so a shared name would collide for the wrong
 *  reason. */
let n = 0
const unique = (stem: string) => `${stem} ${(n += 1)}`

describe('adding an operator', () => {
  it('puts it on the list a job book is created from', async () => {
    const p = getDataProvider()
    const name = unique('Caldera Resources')
    expect((await p.listClientOrgs(admin)).some((o) => o.name === name)).toBe(false)

    const res = await p.createClientOrg(admin, name)
    expect(res.ok).toBe(true)
    expect((await p.listClientOrgs(admin)).some((o) => o.name === name)).toBe(true)
  })

  it('trims, so a stray space does not make a second operator', async () => {
    const p = getDataProvider()
    const name = unique('Trimmed Energy')
    expect((await p.createClientOrg(admin, `  ${name}  `)).ok).toBe(true)
    expect((await p.listClientOrgs(admin)).some((o) => o.name === name)).toBe(true)
  })

  it('refuses a name that is only whitespace', async () => {
    const res = await getDataProvider().createClientOrg(admin, '   ')
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/needs a name/i)
  })

  it('refuses a duplicate and names the one already there', async () => {
    // The usual cause is the operator existing under a different
    // capitalisation, so the message has to show what it collided with.
    const p = getDataProvider()
    const name = unique('Redtail Midstream')
    expect((await p.createClientOrg(admin, name)).ok).toBe(true)

    const again = await p.createClientOrg(admin, name.toUpperCase())
    expect(again.ok).toBe(false)
    expect(again.error).toContain(name)
  })

  it('refuses anyone who is not an admin', async () => {
    const res = await getDataProvider().createClientOrg(manager, unique('Sneaky Oil'))
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/Fortress Admin/i)
  })

  it('does not add the operator when it refuses', async () => {
    const p = getDataProvider()
    const name = unique('Never Added')
    await p.createClientOrg(manager, name)
    expect((await p.listClientOrgs(admin)).some((o) => o.name === name)).toBe(false)
  })
})

describe('correcting an operator name', () => {
  it('renames in place rather than leaving two', async () => {
    const p = getDataProvider()
    const wrong = unique('Oxidental')
    await p.createClientOrg(admin, wrong)
    const org = (await p.listClientOrgs(admin)).find((o) => o.name === wrong)!

    const right = unique('Occidental Corrected')
    expect((await p.renameClientOrg(admin, org.id, right)).ok).toBe(true)

    const after = await p.listClientOrgs(admin)
    expect(after.some((o) => o.name === right)).toBe(true)
    expect(after.some((o) => o.name === wrong)).toBe(false)
  })

  it('refuses a name another operator already has', async () => {
    const p = getDataProvider()
    const taken = unique('Taken Energy')
    const other = unique('Other Energy')
    await p.createClientOrg(admin, taken)
    await p.createClientOrg(admin, other)
    const org = (await p.listClientOrgs(admin)).find((o) => o.name === other)!

    const res = await p.renameClientOrg(admin, org.id, taken)
    expect(res.ok).toBe(false)
    expect(res.error).toContain(taken)
  })

  it('refuses an operator that does not exist', async () => {
    const res = await getDataProvider()
      .renameClientOrg(admin, 'org-not-real', unique('Ghost'))
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/no such operator/i)
  })

  it('refuses anyone who is not an admin', async () => {
    const p = getDataProvider()
    const name = unique('Held Energy')
    await p.createClientOrg(admin, name)
    const org = (await p.listClientOrgs(admin)).find((o) => o.name === name)!

    const res = await p.renameClientOrg(manager, org.id, unique('Renamed By Manager'))
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/Fortress Admin/i)
  })
})

describe('the list the admin screen reads', () => {
  it('says how many books stand behind each operator', async () => {
    // The count is what distinguishes the real operator from a typo of
    // it, and why the answer to a wrong name is a rename.
    const operators = await getDataProvider().listOperators(admin)
    expect(operators.length).toBeGreaterThan(0)
    expect(operators.some((o) => o.bookCount > 0)).toBe(true)
  })

  it('shows a newly added operator as unused', async () => {
    const p = getDataProvider()
    const name = unique('Brand New Operator')
    await p.createClientOrg(admin, name)
    const added = (await p.listOperators(admin)).find((o) => o.name === name)
    expect(added?.bookCount).toBe(0)
  })

  it('is sorted by name, because it is a list somebody scans', async () => {
    const names = (await getDataProvider().listOperators(admin)).map((o) => o.name)
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)))
  })
})
