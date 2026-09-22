/**
 * Turning a Weld Log Overview Sheet into register records.
 *
 * This is the step the application was missing entirely: parsers existed
 * and were tested, but nothing in the running app ever wrote a record, so
 * a book could hold the weld log as a FILE and still have an empty welder
 * register. §9.1 makes those registers the backbone — "every reference to
 * a welder, an inspector, a technician, a wrench, a heat or a drawing
 * resolves to a register entry" — and an empty one makes every
 * qualification check unanswerable.
 *
 * THE PLAN IS SEPARATE FROM THE WRITE. `planOverviewIngest` is pure: it
 * takes the parsed sheet and the book as it stands, and returns exactly
 * what would change. The tech sees that before committing, which is the
 * only point at which "this will create 10 welders and match 0" is
 * information rather than an apology.
 *
 * IDENTITY IS MATCHED, NEVER INVENTED. §9.1 exists because one welder
 * appeared under four spellings across 38 sheets. A row is matched to an
 * existing welder by stamp first, then by name or a recorded alias, and
 * anything unmatched is proposed as a new entry for a person to approve —
 * never silently merged into whoever looks closest.
 */

import type {
  Cwi, IsoDate, JobBookBundle, NdtTechnician, Welder, WelderQualification,
} from '@/lib/domain/types'
import type { OverviewFinding, WeldLogOverview } from './weldLogOverview'

export interface PlannedWelder {
  stamp: string
  name: string
  /** The existing register entry this row resolves to, if any. */
  matchedWelderId: string | null
  matchedBy: 'stamp' | 'name' | 'alias' | null
  action: 'create' | 'match' | 'skip'
  /** Why a row is skipped, in words. Only ever set with action 'skip'. */
  skipReason?: string
  weldCount: number | null
  /** A qualification to record. Absent where the sheet gave no expiry —
   *  a record with neither date is not a qualification, it is a rumour. */
  qualification: { expiryDate: IsoDate } | null
}

export interface PlannedPerson {
  name: string
  qualification: string
  matchedId: string | null
  action: 'create' | 'match'
}

export interface OverviewIngestPlan {
  welders: PlannedWelder[]
  cwis: PlannedPerson[]
  ndtTechnicians: PlannedPerson[]
  findings: OverviewFinding[]
  /** Header values the sheet can fill in on the book itself. */
  bookUpdates: {
    pipingSpecReference?: string
    clientChecklistReference?: string
    qaqcRepresentative?: string
    weldingCompany?: string
  }
  summary: {
    weldersToCreate: number
    weldersMatched: number
    weldersSkipped: number
    qualificationsToRecord: number
    peopleToCreate: number
  }
}

const norm = (s: string) => s.trim().toUpperCase().replace(/\s+/g, ' ')

/**
 * A stamp naming more than one welder.
 *
 * "MR LC" is two people, and creating a register entry under it would
 * enshrine the very thing §9.1 forbids: an identity that resolves to no
 * one. The row is reported, counted and skipped, and the finding says what
 * has to happen instead.
 */
const isCombinedStamp = (stamp: string) =>
  /\s/.test(stamp.trim()) || /\b(and|&|\/|\+)\b/i.test(stamp)

export function planOverviewIngest(
  sheet: WeldLogOverview,
  bundle: Pick<JobBookBundle, 'welders' | 'welderQualifications' | 'cwis' | 'ndtTechnicians'>,
  findings: OverviewFinding[] = [],
): OverviewIngestPlan {
  const welders: PlannedWelder[] = []

  for (const row of sheet.welders) {
    const stamp = row.stamp.trim()
    const name = row.name.trim()

    if (!stamp) {
      welders.push({
        stamp, name, matchedWelderId: null, matchedBy: null, action: 'skip',
        skipReason: 'The sheet gives no stamp for this welder, and §9.1 keys the welder register on the stamp.',
        weldCount: row.weldCount, qualification: null,
      })
      continue
    }
    if (isCombinedStamp(stamp)) {
      welders.push({
        stamp, name, matchedWelderId: null, matchedBy: null, action: 'skip',
        skipReason:
          `"${stamp}" names more than one welder. Creating a register entry under it would ` +
          `enshrine an identity that resolves to no one; the two welders need separate rows ` +
          `on the source sheet before this can be imported.`,
        weldCount: row.weldCount, qualification: null,
      })
      continue
    }

    const byStamp = bundle.welders.find((w) => norm(w.initials) === norm(stamp))
    const byName = byStamp ?? bundle.welders.find((w) => norm(w.fullName) === norm(name))
    const byAlias = byName ?? bundle.welders.find(
      (w) => (w.nameAliases ?? []).some((a) => norm(a) === norm(name)),
    )
    const matched = byAlias ?? null
    const matchedBy: PlannedWelder['matchedBy'] =
      byStamp ? 'stamp' : byName ? 'name' : byAlias ? 'alias' : null

    welders.push({
      stamp,
      name,
      matchedWelderId: matched?.id ?? null,
      matchedBy,
      action: matched ? 'match' : 'create',
      weldCount: row.weldCount,
      // Only where the sheet actually gave an expiry. A qualification
      // record with no start AND no expiry asserts nothing.
      qualification: row.wpqExpires ? { expiryDate: row.wpqExpires } : null,
    })
  }

  const people = (
    quals: string[],
    existing: { id: string; fullName: string }[],
  ): PlannedPerson[] =>
    sheet.inspectors
      .filter((i) => quals.includes(i.qualification))
      .map((i) => {
        const match = existing.find((e) => norm(e.fullName) === norm(i.name))
        return {
          name: i.name,
          qualification: i.qualification,
          matchedId: match?.id ?? null,
          action: match ? ('match' as const) : ('create' as const),
        }
      })

  const cwis = people(['CWI'], bundle.cwis)
  const ndtTechnicians = people(['NDT', 'RT', 'UT', 'MT', 'PT'], bundle.ndtTechnicians)

  const bookUpdates: OverviewIngestPlan['bookUpdates'] = {}
  if (sheet.header.qaqcRepresentative) {
    bookUpdates.qaqcRepresentative = sheet.header.qaqcRepresentative
  }
  if (sheet.header.weldingCompany) bookUpdates.weldingCompany = sheet.header.weldingCompany

  return {
    welders,
    cwis,
    ndtTechnicians,
    findings,
    bookUpdates,
    summary: {
      weldersToCreate: welders.filter((w) => w.action === 'create').length,
      weldersMatched: welders.filter((w) => w.action === 'match').length,
      weldersSkipped: welders.filter((w) => w.action === 'skip').length,
      qualificationsToRecord: welders.filter((w) => w.action !== 'skip' && w.qualification).length,
      peopleToCreate:
        cwis.filter((p) => p.action === 'create').length +
        ndtTechnicians.filter((p) => p.action === 'create').length,
    },
  }
}

/**
 * The rows the plan would write, as domain objects.
 *
 * Kept separate from the plan so the same plan can be shown to a tech and
 * then executed, without the executing code re-deciding anything. Every
 * record carries the entry stamp §8 measures against.
 */
export interface OverviewIngestRows {
  welders: Welder[]
  qualifications: WelderQualification[]
  cwis: Cwi[]
  ndtTechnicians: NdtTechnician[]
}

export function rowsForPlan(
  plan: OverviewIngestPlan,
  opts: { enteredAt: string; entrySource: 'field_entry' | 'bulk_import'; newId: () => string },
): OverviewIngestRows {
  const welders: Welder[] = []
  const qualifications: WelderQualification[] = []

  for (const p of plan.welders) {
    if (p.action === 'skip') continue
    const id = p.matchedWelderId ?? opts.newId()
    if (p.action === 'create') {
      welders.push({
        id,
        fullName: p.name,
        initials: p.stamp,
        active: true,
        nameAliases: [],
        enteredAt: opts.enteredAt,
        entrySource: opts.entrySource,
      })
    }
    if (p.qualification) {
      qualifications.push({
        id: opts.newId(),
        welderId: id,
        code: 'ASME_IX',
        // The sheet gives an expiry and no start. Recording null here is
        // what keeps `qualifiedOn` from certifying anything against it.
        qualificationDate: null,
        expiryDate: p.qualification.expiryDate,
        enteredAt: opts.enteredAt,
        entrySource: opts.entrySource,
      })
    }
  }

  const cwis: Cwi[] = plan.cwis
    .filter((p) => p.action === 'create')
    .map((p) => ({
      id: opts.newId(),
      fullName: p.name,
      initials: initialsOf(p.name),
      active: true,
      enteredAt: opts.enteredAt,
      entrySource: opts.entrySource,
    }))

  const ndtTechnicians: NdtTechnician[] = plan.ndtTechnicians
    .filter((p) => p.action === 'create')
    .map((p) => ({
      id: opts.newId(),
      fullName: p.name,
      initials: initialsOf(p.name),
      classification: p.qualification,
      active: true,
      enteredAt: opts.enteredAt,
      entrySource: opts.entrySource,
    }))

  return { welders, qualifications, cwis, ndtTechnicians }
}

/** "Brendan LeCompte" → "BL". Derived, and only ever used where the source
 *  gave no stamp of its own; a welder's stamp is never derived this way. */
function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((p) => p[0]!.toUpperCase())
    .join('')
    .slice(0, 4)
}
