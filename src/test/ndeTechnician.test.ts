/**
 * Who examined the pipe.
 *
 * Section 8 exists to evidence that the people who inspected these welds
 * were qualified to. A report signed by somebody with no record defeats
 * that completely — there is no certificate to check, no level, nothing
 * to expire — and the existing "not certified on the report date" rule
 * cannot see it, because that rule needs a technician id and there is
 * none.
 */
import { describe, expect, it } from 'vitest'
import { resolveTechnician } from '@/lib/domain/welders'
import { evaluateFlags, ruleNdeTechnicianUnknown } from '@/lib/domain/flags'
import { buildDp452Bundle } from '@/lib/data/seed/dp452'
import type { JobBookBundle, NdtTechnician } from '@/lib/domain/types'

function tech(over: Partial<NdtTechnician> & { id: string; fullName: string }): NdtTechnician {
  return {
    initials: null, employer: null, classification: null, active: true,
    enteredAt: '2025-01-01T00:00:00Z', enteredBy: null, entrySource: 'field_entry',
    ...over,
  } as NdtTechnician
}

/** The names the real DP-318 reports print. */
const ROSTER: NdtTechnician[] = [
  tech({ id: 't1', fullName: 'Brendan LeCompte', initials: 'BL' }),
  tech({ id: 't2', fullName: 'Jose Flores', initials: 'JF' }),
]

describe('resolving a name off a report', () => {
  it('matches the real technicians exactly', () => {
    expect(resolveTechnician('Brendan LeCompte', ROSTER)?.id).toBe('t1')
    expect(resolveTechnician('Jose Flores', ROSTER)?.id).toBe('t2')
  })

  it('ignores case and collapsed spacing, which is not guessing', () => {
    // "Brendan  LeCompte" is the same string written carelessly, not a
    // second reading of the name.
    expect(resolveTechnician('brendan lecompte', ROSTER)?.id).toBe('t1')
    expect(resolveTechnician('  Brendan   LeCompte ', ROSTER)?.id).toBe('t1')
  })

  it('matches on initials when the name is not printed', () => {
    expect(resolveTechnician('BL', ROSTER)?.id).toBe('t1')
  })

  it('refuses a near miss rather than attributing the work', () => {
    // A radiograph credited to the wrong person is worse than one
    // credited to nobody. The resolution is to add the record or correct
    // the spelling, both done knowingly.
    expect(resolveTechnician('Brendan Lecomte', ROSTER)).toBeNull()
    expect(resolveTechnician('B. LeCompte', ROSTER)).toBeNull()
    expect(resolveTechnician('Brendan', ROSTER)).toBeNull()
  })

  it('refuses when two technicians share the name', () => {
    // Not hypothetical: this project's own database holds duplicate
    // technician rows. Picking one attributes the examination to
    // whichever the query returned first.
    const twins = [
      tech({ id: 'a', fullName: 'Marco Delgado' }),
      tech({ id: 'b', fullName: 'Marco Delgado' }),
    ]
    expect(resolveTechnician('Marco Delgado', twins)).toBeNull()
  })

  it('refuses an empty name', () => {
    expect(resolveTechnician('', ROSTER)).toBeNull()
    expect(resolveTechnician('   ', ROSTER)).toBeNull()
  })
})

describe('a report nobody on the roster signed', () => {
  function withReport(over: Record<string, unknown>): JobBookBundle {
    const b = buildDp452Bundle()
    return {
      ...b,
      ndeReports: [{
        ...b.ndeReports[0]!, id: 'r1', reportNumber: '111925BL-RT',
        isSuperseded: false, technicianId: null, ...over,
      }],
    }
  }

  it('is a critical finding against section 8', () => {
    const f = ruleNdeTechnicianUnknown(withReport({ technicianName: 'Brendan LeCompte' }))
    expect(f).toHaveLength(1)
    expect(f[0]!.severity).toBe('critical')
    expect(f[0]!.sectionNumber).toBe('8')
  })

  it('names the person, so somebody can add or correct the record', () => {
    const f = ruleNdeTechnicianUnknown(withReport({ technicianName: 'Brendan LeCompte' }))
    expect(f[0]!.title).toContain('Brendan LeCompte')
  })

  it('says so differently when no name was printed at all', () => {
    const f = ruleNdeTechnicianUnknown(withReport({ technicianName: null }))
    expect(f[0]!.title).toMatch(/names no technician/i)
  })

  it('stays quiet once the report resolves to a technician', () => {
    expect(ruleNdeTechnicianUnknown(withReport({
      technicianId: 't1', technicianName: 'Brendan LeCompte',
    }))).toEqual([])
  })

  it('ignores a superseded report', () => {
    expect(ruleNdeTechnicianUnknown(withReport({
      technicianName: 'Brendan LeCompte', isSuperseded: true,
    }))).toEqual([])
  })

  it('runs as part of the book, not just on its own', () => {
    // A rule nothing calls is a rule that does not run.
    const findings = evaluateFlags(withReport({ technicianName: 'Brendan LeCompte' }))
    expect(findings.some((f) => f.ruleId === 'nde.technician_unknown')).toBe(true)
  })
})
