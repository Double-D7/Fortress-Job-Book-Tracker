/**
 * FDS-JBMP-004 competency levels.
 *
 * A competency level is not a role. A role is what the application
 * lets somebody do; a competency level is an assessment somebody else
 * performed on them, and it is what §5.1 and §10.2 actually read.
 * The two are deliberately independent — a QA/QC Manager with no
 * assessment cannot be named Custodian, and a Technician assessed at
 * JB-3 can peer-audit a book they did not keep.
 *
 * Null means NOT ASSESSED, and the domain treats that as unqualified
 * rather than as unknown-so-allow. That is the whole point: an absent
 * assessment that passed would let an unqualified audit produce a
 * number the gate engine then believes.
 */
import type { CompetencyLevel } from './types'

export const COMPETENCY_LEVELS: readonly CompetencyLevel[] =
  ['JB-1', 'JB-2', 'JB-3', 'JB-4']

/** What each level unlocks, in the words the standard uses. Shown
 *  beside the picker so an admin is choosing a capability, not a
 *  number. */
export const COMPETENCY_SUMMARY: Record<CompetencyLevel, string> = {
  'JB-1': 'Entry. May enter records on assigned books. Cannot be named Custodian.',
  'JB-2': 'May be named §5 Custodian of a job book.',
  'JB-3': 'May be named Custodian, and may perform a §10.2 Tier 2 peer audit '
    + 'on a book they do not keep.',
  'JB-4': 'As JB-3. The senior assessment.',
}

/** The lowest level that may hold a job book as Custodian (§5.1). */
export const CUSTODIAN_MINIMUM: CompetencyLevel = 'JB-2'
/** The lowest level that may perform a Tier 2 peer audit (§10.2). */
export const PEER_AUDIT_MINIMUM: CompetencyLevel = 'JB-3'

export function meetsCustodianMinimum(level: CompetencyLevel | null): boolean {
  return level !== null && level !== 'JB-1'
}

export function meetsPeerAuditMinimum(level: CompetencyLevel | null): boolean {
  return level === 'JB-3' || level === 'JB-4'
}

/** What this level is blocked from, for the admin screen. Empty when
 *  the level unlocks everything competency gates. */
export function competencyGaps(level: CompetencyLevel | null): string[] {
  const out: string[] = []
  if (!meetsCustodianMinimum(level)) out.push('cannot be named Custodian')
  if (!meetsPeerAuditMinimum(level)) out.push('cannot perform a Tier 2 peer audit')
  return out
}
