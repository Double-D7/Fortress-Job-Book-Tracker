/**
 * Who gets told.
 *
 * The routing rule lives twice — once in `notifications.ts` for the
 * interface, once in 0024's trigger for the write path — so these tests
 * do two jobs. They check the TypeScript behaves, and they read the SQL
 * text to check the trigger states the same rule, the way roles.test.ts
 * pins the capability table to the RLS predicates.
 *
 * The case worth caring about is the last describe block: a notification
 * must never carry a note to somebody the note's own read policy would
 * withhold it from. That is the side channel this feature could open,
 * and it is the one that would not be visible from either file alone.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  NOTE_SEVERITIES, SEVERITY_HELP, SEVERITY_LABELS, badgeCount,
  highestSeverity, interrupts, recipientsFor,
  type Candidate, type NoteSeverity,
} from '@/lib/domain/notifications'

const sql = readFileSync(
  'supabase/migrations/0024_note_severity_and_notifications.sql', 'utf8')

const custodian: Candidate = {
  userId: 'u-custodian', role: 'qaqc_tech', isCustodian: true, isAssigned: true,
}
const otherTech: Candidate = {
  userId: 'u-tech-2', role: 'qaqc_tech', isCustodian: false, isAssigned: true,
}
const manager: Candidate = {
  userId: 'u-manager', role: 'qaqc_manager', isCustodian: false, isAssigned: true,
}
/** On the estate but not on this book. */
const unrelated: Candidate = {
  userId: 'u-elsewhere', role: 'qaqc_tech', isCustodian: false, isAssigned: false,
}
const readOnly: Candidate = {
  userId: 'u-readonly', role: 'fortress_read_only', isCustodian: false, isAssigned: true,
}
const client: Candidate = {
  userId: 'u-client', role: 'client_user', isCustodian: false, isAssigned: true,
}
const inspector: Candidate = {
  userId: 'u-inspector', role: 'third_party_inspector',
  isCustodian: false, isAssigned: true,
}

const EVERYONE = [custodian, otherTech, manager, unrelated, readOnly, client, inspector]

const note = (severity: NoteSeverity, over: Partial<{
  visibility: 'internal' | 'client'; authorId: string
}> = {}) => ({
  severity,
  visibility: over.visibility ?? ('client' as const),
  authorId: over.authorId ?? 'u-inspector',
})

describe('who is told', () => {
  it('tells everyone on the book about a Critical note', () => {
    expect(recipientsFor(note('critical'), EVERYONE))
      .toEqual(['u-custodian', 'u-manager', 'u-tech-2'])
  })

  it('tells everyone on the book about a warning too', () => {
    // The rule you gave: critical and warning both reach the whole book.
    expect(recipientsFor(note('warning'), EVERYONE))
      .toEqual(recipientsFor(note('critical'), EVERYONE))
  })

  it('tells only the Custodian about an observation', () => {
    // §5 makes them the accountable owner, so everything on their book
    // reaches them. Nobody else is interrupted for an observation.
    expect(recipientsFor(note('info'), EVERYONE)).toEqual(['u-custodian'])
  })

  it('never tells somebody who is not on the book', () => {
    for (const s of NOTE_SEVERITIES) {
      expect(recipientsFor(note(s), EVERYONE), s)
        .not.toContain('u-elsewhere')
    }
  })

  it('never tells the author about their own note', () => {
    // The tech who wrote it is the Custodian here, so without the check
    // they would be the first recipient.
    const mine = note('critical', { authorId: 'u-custodian' })
    expect(recipientsFor(mine, EVERYONE)).toEqual(['u-manager', 'u-tech-2'])
  })

  it('does not tell View Only, who has nothing to do about it', () => {
    // They can read every book and change none of it. A to-do marker for
    // somebody who cannot act is noise.
    for (const s of NOTE_SEVERITIES) {
      expect(recipientsFor(note(s), EVERYONE), s).not.toContain('u-readonly')
    }
  })

  it('returns each person once however many ways they qualify', () => {
    // The Custodian is also assigned, so a Critical note reaches them
    // down both branches.
    const twice = recipientsFor(note('critical'), [custodian, custodian])
    expect(twice).toEqual(['u-custodian'])
  })

  it('tells nobody when the book has no Custodian and nobody assigned', () => {
    // A real state: a book created this morning. Silence is correct, and
    // the note is still on the book for whoever opens it.
    expect(recipientsFor(note('critical'), [unrelated])).toEqual([])
  })
})

describe('the rule a notification must not break', () => {
  it('never carries any note to the operator or the inspector', () => {
    // Both are "assigned" in this fixture precisely so the assignment
    // branch cannot be what excludes them — the role check has to be.
    for (const s of NOTE_SEVERITIES) {
      for (const v of ['internal', 'client'] as const) {
        const to = recipientsFor(note(s, { visibility: v, authorId: 'x' }), EVERYONE)
        expect(to, `${s}/${v} reached the operator`).not.toContain('u-client')
        expect(to, `${s}/${v} reached the inspector`).not.toContain('u-inspector')
      }
    }
  })

  it('states the visibility rule once in SQL, not once and a half', () => {
    // The first version of 0024 filtered recipients to Fortress roles
    // and then "re-checked" the visibility against those same roles — a
    // tautology that read like a safeguard. A check that cannot fail is
    // worse than none, because the next person trusts it.
    expect(sql).toContain('may_be_notified_of(u.role, new.visibility)')
    const fanOut = sql.slice(
      sql.indexOf('function fan_out_note_notifications'),
      sql.indexOf('create trigger note_notifies_the_book'))
    // The role list belongs in the helper, and nowhere else in the query.
    expect(fanOut).not.toContain("'qaqc_tech'")
  })

  it('keeps the SQL recipient rule in step with this file', () => {
    const fanOut = sql.slice(
      sql.indexOf('function fan_out_note_notifications'),
      sql.indexOf('create trigger note_notifies_the_book'))
    expect(fanOut).toContain('u.id = b.custodian_id')
    expect(fanOut).toContain("new.severity <> 'info'")
    expect(fanOut).toContain('u.id <> new.author_id')
    // Switched-off accounts are not told; the grant path already learned
    // that is_active has to be read explicitly.
    expect(fanOut).toContain('u.is_active')
  })

  it('carries no copy of the note body', () => {
    // The notification is a pointer. The note is read through
    // inspector_comment under its own policy, so a notification can
    // never show more than the note would.
    const whole = sql.slice(sql.indexOf('create table notification'))
    const table = whole.slice(0, whole.indexOf(');'))
    // Column names, not a substring search: the first version of this
    // matched the word "somebody" in a comment and failed a correct
    // migration, which is its own small lesson about loose assertions.
    const columns = table.split('\n').slice(1)
      .map((l) => l.trim().split(/\s+/)[0])
      .filter((w): w is string => !!w && !w.startsWith('--'))
    expect(columns).toContain('note_id')
    expect(columns).not.toContain('body')
    expect(columns).not.toContain('severity')
  })

  it('gives notification no INSERT policy', () => {
    // Rows arrive only from the trigger. An INSERT policy would let a
    // caller manufacture somebody else's to-do list.
    expect(sql).toContain('create policy notification_read')
    expect(sql).not.toMatch(/create policy \w+ on notification for insert/)
  })

  it('shows a person only their own', () => {
    const policy = sql.slice(sql.indexOf('create policy notification_read'))
      .slice(0, 200)
    expect(policy).toContain('user_id = current_app_user_id()')
  })
})

describe('how loudly', () => {
  it('lets Critical and warning interrupt, and not an observation', () => {
    expect(interrupts('critical')).toBe(true)
    expect(interrupts('warning')).toBe(true)
    expect(interrupts('info')).toBe(false)
  })

  it('counts only what interrupts, so the badge stays worth looking at', () => {
    const unread = [
      { severity: 'info' as const }, { severity: 'info' as const },
      { severity: 'warning' as const }, { severity: 'critical' as const },
    ]
    expect(badgeCount(unread)).toBe(2)
    expect(badgeCount([{ severity: 'info' }])).toBe(0)
    expect(badgeCount([])).toBe(0)
  })

  it('reports the loudest severity present', () => {
    expect(highestSeverity([{ severity: 'info' }, { severity: 'critical' }]))
      .toBe('critical')
    expect(highestSeverity([{ severity: 'info' }, { severity: 'warning' }]))
      .toBe('warning')
    expect(highestSeverity([{ severity: 'info' }])).toBe('info')
    expect(highestSeverity([])).toBeNull()
  })

  it('labels every severity, and the enum matches the database', () => {
    const inSql = sql.slice(sql.indexOf('create type note_severity'))
    for (const s of NOTE_SEVERITIES) {
      expect(SEVERITY_LABELS[s].length).toBeGreaterThan(3)
      expect(SEVERITY_HELP[s].length).toBeGreaterThan(20)
      expect(inSql.slice(0, 120), `${s} missing from the enum`).toContain(`'${s}'`)
    }
    expect(NOTE_SEVERITIES).toHaveLength(3)
  })

  it('does not borrow the §11 vocabulary', () => {
    // Critical/Major/Minor mean a classified defect on the findings
    // register with a deduction attached. Reusing those words for
    // something an inspector typed would invite the belief that typing
    // one changes the score — which is exactly what must not happen.
    expect(NOTE_SEVERITIES).not.toContain('major' as never)
    expect(NOTE_SEVERITIES).not.toContain('minor' as never)
  })
})
