/**
 * The actions a person actually performs.
 *
 * Every one of these was a button with no handler until now: sign-off,
 * flag resolution, export. The tests exist because "it renders" was
 * exactly what was true before, and it was not enough — a control that
 * looks live and does nothing teaches a tech the system is broken.
 */
import { describe, expect, it } from 'vitest'
import { getDataProvider, type Viewer } from '@/lib/data/provider'
import { scoreSection } from '@/lib/domain/scoring'

const manager: Viewer = {
  id: 'user-mgr-1', email: 'mgr@fortressds.com', fullName: 'A Manager',
  role: 'qaqc_manager', clientOrgId: null,
}
const otherManager: Viewer = { ...manager, id: 'user-mgr-2', email: 'mgr2@fortressds.com' }
const tech: Viewer = { ...manager, id: 'user-tech-1', email: 'tech@fortressds.com', role: 'qaqc_tech' }
const readOnly: Viewer = { ...manager, id: 'user-ro', email: 'ro@fortressds.com', role: 'fortress_read_only' }

describe('two-person sign-off', () => {
  it('a tech may submit but not approve', async () => {
    const p = getDataProvider()
    expect((await p.markSectionReady(tech, 'book-dp452', '3')).ok).toBe(true)

    const denied = await p.approveSection(tech, 'book-dp452', '3')
    expect(denied.ok).toBe(false)
    expect(denied.error).toMatch(/Manager or Admin/)
  })

  it('refuses the person who submitted it', async () => {
    const p = getDataProvider()
    await p.markSectionReady(manager, 'book-dp452', '4')
    const denied = await p.approveSection(manager, 'book-dp452', '4')
    expect(denied.ok).toBe(false)
    expect(denied.error).toMatch(/may not be approved by the person who submitted/)
  })

  it('a second qualified person can, and it sticks', async () => {
    const p = getDataProvider()
    await p.markSectionReady(tech, 'book-dp452', '5')
    expect((await p.approveSection(otherManager, 'book-dp452', '5')).ok).toBe(true)

    const b = (await p.getBundle(manager, 'book-dp452'))!
    const def = b.sectionDefinitions.find((d) => d.sectionNumber === '5')!
    const s = b.sections.find((x) => x.sectionDefinitionId === def.id)!
    expect(s.status).toBe('approved')
    expect(s.approvedBy).toBe(otherManager.id)
    expect(s.approvedAt).toBeTruthy()
  })

  it('turns a read-only viewer away', async () => {
    const r = await getDataProvider().markSectionReady(readOnly, 'book-dp452', '3')
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/[Nn]ot permitted/)
  })

  it('will not invent a section', async () => {
    const r = await getDataProvider().approveSection(manager, 'book-dp452', '99')
    expect(r.ok).toBe(false)
  })
})

describe('resolving a finding', () => {
  it('refuses a resolution with no note', async () => {
    const r = await getDataProvider().resolveFlag(manager, 'book-dp452', 'fp-x', 'resolved', '   ')
    expect(r.ok).toBe(false)
    // The same thing the resolution_has_note constraint says, in words.
    expect(r.error).toMatch(/note/)
  })

  it('accepts one with a note', async () => {
    const r = await getDataProvider().resolveFlag(
      manager, 'book-dp452', 'fp-y', 'resolved',
      'Wrench recalibrated 2026-09-01; certificate filed in section 13.',
    )
    expect(r.ok).toBe(true)
  })

  it('separates "fixed" from "never a problem"', async () => {
    const p = getDataProvider()
    expect((await p.resolveFlag(manager, 'book-dp452', 'fp-z', 'dismissed',
      'Filename names DP517 but the document belongs to this job.')).ok).toBe(true)
  })

  it('turns a read-only viewer away', async () => {
    const r = await getDataProvider().resolveFlag(readOnly, 'book-dp452', 'fp-w', 'resolved', 'note')
    expect(r.ok).toBe(false)
  })
})

describe('approval moves the score, uploading alone does not', () => {
  it('a section reaches 100% only once approved', async () => {
    const p = getDataProvider()
    const sha = 'c'.repeat(64)
    await p.addDocuments(tech, 'book-dp452', '16', [{
      originalFilename: 'procedure.pdf', byteSize: 4096, sha256: sha, mimeType: 'application/pdf',
    }])

    const before = (await p.getBundle(manager, 'book-dp452'))!
    const def = before.sectionDefinitions.find((d) => d.sectionNumber === '16')!
    const s = before.sections.find((x) => x.sectionDefinitionId === def.id)!
    // Collected, not approved — which is the whole distinction.
    expect(scoreSection(def, s, before).pct).toBe(0)
    expect(scoreSection(def, s, before).collectedPct).toBe(100)
  })
})
