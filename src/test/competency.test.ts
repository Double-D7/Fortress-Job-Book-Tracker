/**
 * Competency assessments.
 *
 * `app_user.competency_level` has gated §5.1 and §10.2 since 0015 and
 * nothing could ever set it, so every real account carried null —
 * correctly read as unqualified, with the result that no book could be
 * given a Custodian and no Tier 2 audit could be recorded by anybody.
 * These cover the half that was missing.
 */
import { describe, expect, it } from 'vitest'
import {
  COMPETENCY_LEVELS, COMPETENCY_SUMMARY, competencyGaps,
  meetsCustodianMinimum, meetsPeerAuditMinimum,
} from '@/lib/domain/competency'
import { getDataProvider, type Viewer } from '@/lib/data/provider'
import { canPeerAudit } from '@/lib/domain/audits'

const admin: Viewer = {
  id: 'seed-user-admin', email: 'admin@fortressds.com',
  fullName: 'A. Reyes', role: 'fortress_admin', clientOrgId: null,
}
const manager: Viewer = {
  id: 'seed-user-manager', email: 'manager@fortressds.com',
  fullName: 'M. Okafor', role: 'qaqc_manager', clientOrgId: null,
}

describe('what each level unlocks', () => {
  it('has a summary for every level', () => {
    for (const l of COMPETENCY_LEVELS) expect(COMPETENCY_SUMMARY[l]).toBeTruthy()
  })

  it('puts the Custodian floor at JB-2 and the peer-audit floor at JB-3', () => {
    expect(meetsCustodianMinimum('JB-1')).toBe(false)
    expect(meetsCustodianMinimum('JB-2')).toBe(true)
    expect(meetsPeerAuditMinimum('JB-2')).toBe(false)
    expect(meetsPeerAuditMinimum('JB-3')).toBe(true)
    expect(meetsPeerAuditMinimum('JB-4')).toBe(true)
  })

  it('treats not assessed as unqualified, never as unknown-so-allow', () => {
    // The reason the column exists. An absent assessment that passed
    // would let an unqualified audit produce a number the gate engine
    // then believes.
    expect(meetsCustodianMinimum(null)).toBe(false)
    expect(meetsPeerAuditMinimum(null)).toBe(false)
    expect(competencyGaps(null)).toHaveLength(2)
  })

  it('agrees with the rule the audit path actually enforces', () => {
    // Two statements of one fact; this is where they are held together.
    for (const level of [...COMPETENCY_LEVELS, null]) {
      const bundle = { book: { custodianId: 'someone-else' } } as never
      expect(canPeerAudit(bundle, 'auditor', level).ok)
        .toBe(meetsPeerAuditMinimum(level))
    }
  })

  it('reports nothing left blocked at JB-3', () => {
    expect(competencyGaps('JB-3')).toEqual([])
    expect(competencyGaps('JB-2')).toEqual(['cannot perform a Tier 2 peer audit'])
  })
})

describe('recording an assessment', () => {
  it('is admin-only', async () => {
    const p = getDataProvider()
    const res = await p.setUserCompetency(manager, 'seed-user-new', 'JB-3')
    expect(res.ok).toBe(false)
  })

  it('records a level and shows it in the directory', async () => {
    const p = getDataProvider()
    const res = await p.setUserCompetency(admin, 'seed-user-custodian', 'JB-3')
    expect(res.ok).toBe(true)
    const them = (await p.listUsers(admin)).find((u) => u.id === 'seed-user-custodian')
    expect(them?.competencyLevel).toBe('JB-3')
  })

  it('refuses an admin assessing themselves', async () => {
    // An assessment is performed on somebody, not claimed by them. A
    // self-recorded JB-3 would defeat the §10.2 independence the level
    // unlocks, in the same way peer-auditing your own book would.
    const p = getDataProvider()
    const res = await p.setUserCompetency(admin, admin.id, 'JB-4')
    expect(res.ok).toBe(false)
    expect(res.ok === false && res.error).toMatch(/somebody else/)
  })

  it('refuses a level on a client role', async () => {
    const p = getDataProvider()
    const res = await p.setUserCompetency(admin, 'seed-user-client', 'JB-3')
    expect(res.ok).toBe(false)
    expect(res.ok === false && res.error).toMatch(/client role/)
  })

  it('clears an assessment when passed null', async () => {
    const p = getDataProvider()
    await p.setUserCompetency(admin, 'seed-user-new', 'JB-4')
    expect(await p.setUserCompetency(admin, 'seed-user-new', null))
      .toEqual({ ok: true })
    const them = (await p.listUsers(admin)).find((u) => u.id === 'seed-user-new')
    expect(them?.competencyLevel).toBeNull()
  })

  it('unblocks a peer audit that the same person could not perform before', async () => {
    // End to end, and the thing a QA/QC Manager actually hit: the role
    // was never the problem.
    const p = getDataProvider()
    const target = 'seed-user-custodian'
    await p.setUserCompetency(admin, target, 'JB-2')
    const bundle = { book: { custodianId: 'another-person' } } as never
    expect(canPeerAudit(bundle, target, 'JB-2').ok).toBe(false)

    await p.setUserCompetency(admin, target, 'JB-3')
    expect(canPeerAudit(bundle, target, 'JB-3').ok).toBe(true)
  })
})
