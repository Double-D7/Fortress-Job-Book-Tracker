/**
 * The capability table against the database that actually enforces it.
 *
 * `roles.ts` says in its own opening comment that it must MATCH the
 * database rather than define it, and that where the two disagree the
 * database wins. That is a promise nobody can keep by reading, because
 * the two live in different languages in different files, and the
 * disagreement that matters is the one introduced six months from now by
 * someone editing one of them.
 *
 * So these tests read the role lists straight out of the SQL text and
 * compare them to the capability table, set against set. They are
 * deliberately not "does admin have everything" — that would pass on a
 * table with every capability granted to everyone. Each test names a
 * specific predicate function in a specific migration and asserts that
 * the roles inside it are exactly the roles the table gives the matching
 * capability to. Add a role to `is_fortress_writer()` and forget the
 * table, or the reverse, and one of these fails with both sets printed.
 *
 * What these CANNOT check is the scope half. `can_write_job_book()`
 * gives a tech write access only on assigned books, and no amount of
 * reading the capability table tells you whether that filter is applied.
 * `supabase/tests/security.sql` runs that against a real Postgres with
 * real sessions. These tests cover the half that is checkable from text.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  ROLES, can, canComment, orgRequirement, roleDefinition, roleLabel, rolesWith,
} from '@/lib/domain/roles'
import type { Capability } from '@/lib/domain/roles'
import type { UserRole } from '@/lib/domain/types'

const schema = readFileSync('supabase/migrations/0001_schema.sql', 'utf8')
const rls = readFileSync('supabase/migrations/0003_rls.sql', 'utf8')
const attribution = readFileSync(
  'supabase/migrations/0021_audit_attribution.sql', 'utf8')

/** The `user_role` enum, as the database declares it. */
function enumMembers(): UserRole[] {
  const line = schema.slice(schema.indexOf('create type user_role'))
  const list = line.slice(line.indexOf('(') + 1, line.indexOf(')'))
  return [...list.matchAll(/'(\w+)'/g)].map((m) => m[1]! as UserRole)
}

/**
 * The roles named inside a SQL function body.
 *
 * Slices from the function header to the closing `$$` rather than
 * regex-ing the whole file, so a role mentioned in a neighbouring
 * function cannot leak into the answer.
 */
function rolesInFunction(sql: string, name: string): Set<string> {
  const start = sql.indexOf(`function ${name}`)
  expect(start, `no function ${name} in this migration`).toBeGreaterThan(-1)
  const open = sql.indexOf('$$', start)
  const body = sql.slice(open + 2, sql.indexOf('$$', open + 2))
  const found = new Set([...body.matchAll(/'(\w+)'/g)]
    .map((m) => m[1]!)
    .filter((s) => ALL_ROLES.has(s)))
  // A rename or a rewrite that stops naming roles literally would give an
  // empty set here, and every comparison below would quietly compare
  // nothing to nothing. Fail instead, pointing at the function.
  expect(found.size, `${name} names no roles — has it been rewritten?`)
    .toBeGreaterThan(0)
  return found
}

const ALL_ROLES = new Set<string>(enumMembers())

/** Roles the capability table grants a capability to, as plain strings. */
function tableRolesWith(capability: Capability): Set<string> {
  return new Set(rolesWith(capability).map((r) => r.role))
}

// Sorted arrays print a readable diff; raw Sets do not.
const show = (s: Set<string>) => [...s].sort()

describe('the capability table covers the enum', () => {
  it('has exactly one row per role the database knows about', () => {
    const declared = enumMembers()
    expect(show(new Set(ROLES.map((r) => r.role))))
      .toEqual(show(new Set(declared)))
    expect(ROLES).toHaveLength(declared.length)
  })

  it('gives every role a distinct label a person could say out loud', () => {
    const labels = ROLES.map((r) => r.label)
    expect(new Set(labels).size).toBe(labels.length)
    for (const r of ROLES) {
      // The enum value leaking to screen is the bug this catches: a new
      // row added without a label would read 'third_party_inspector'.
      expect(r.label).not.toBe(r.role)
      expect(r.label.length).toBeGreaterThan(3)
      expect(r.summary.length).toBeGreaterThan(20)
    }
  })

  it('keeps the two Fortress QA/QC rows recognisable as one family', () => {
    // The operator's vocabulary from the brief: one role called Fortress
    // QA/QC, split into Manager and Technician because §5 accountability
    // and the two-person approval control need them apart.
    const qaqc = ROLES.filter((r) => r.role.startsWith('qaqc_'))
    expect(qaqc).toHaveLength(2)
    for (const r of qaqc) expect(r.label).toContain('Fortress QA/QC')
    expect(roleLabel('qaqc_manager')).toContain('Manager')
    expect(roleLabel('qaqc_tech')).toContain('Technician')
  })

  it('fails closed on a role it has never heard of', () => {
    const made_up = roleDefinition('auditor_general' as UserRole)
    expect(made_up.capabilities.size).toBe(0)
    expect(can('auditor_general' as UserRole, 'view_book')).toBe(false)
  })
})

describe('the table matches the RLS predicates in 0003', () => {
  it('is_fortress_writer() names exactly the roles that may edit records', () => {
    expect(show(rolesInFunction(rls, 'is_fortress_writer')))
      .toEqual(show(tableRolesWith('edit_records')))
  })

  it('is_fortress_staff() names exactly the roles that see internal work', () => {
    // The flag queue, entry timeliness, gate reviews and the §10 audit
    // history. A client reading these would be reading Fortress's own
    // assessment of Fortress, which is a different document.
    expect(show(rolesInFunction(rls, 'is_fortress_staff')))
      .toEqual(show(tableRolesWith('view_internal')))
  })

  it('is_manager_or_admin() names exactly the roles holding every governance capability', () => {
    const governance: Capability[] = [
      'approve_section', 'create_book', 'chair_gate', 'assign_custodian',
      'record_tier3', 'certify_completeness', 'manage_inspector_grants',
    ]
    const predicate = show(rolesInFunction(rls, 'is_manager_or_admin'))
    for (const c of governance) {
      expect(show(tableRolesWith(c)), `${c} does not match is_manager_or_admin()`)
        .toEqual(predicate)
    }
  })

  it('is_external_reader() names exactly the roles the table calls external', () => {
    const external = new Set(
      ROLES.filter((r) => !r.isInternal).map((r) => r.role))
    expect(show(rolesInFunction(rls, 'is_external_reader')))
      .toEqual(show(external))
  })

  it('can_write_job_book() falls through to false for everyone else', () => {
    const writers = rolesInFunction(rls, 'can_write_job_book')
    expect(show(writers)).toEqual(show(tableRolesWith('edit_records')))
    // The roles NOT in that list must hold no writing capability at all,
    // or the interface would offer a button the database refuses.
    for (const r of ROLES) {
      if (writers.has(r.role)) continue
      for (const c of ['edit_records', 'mark_section_ready', 'resolve_flag'] as const) {
        expect(can(r.role, c), `${r.role} is offered ${c} and cannot write`).toBe(false)
      }
    }
  })

  it('can_read_job_book() reaches every role the table lets view a book', () => {
    // Read is the one predicate where every role appears — what differs
    // is the scope each branch applies, which security.sql checks live.
    const readers = rolesInFunction(rls, 'can_read_job_book')
    for (const r of ROLES) {
      expect(can(r.role, 'view_book'), `${r.role} cannot view a book`).toBe(true)
      expect(readers.has(r.role), `${r.role} has no branch in can_read_job_book`)
        .toBe(true)
    }
  })

  it('app_user_write is admin-only, and so is manage_users', () => {
    const policy = rls.slice(
      rls.indexOf('create policy app_user_write'),
      rls.indexOf('create policy project_read'))
    expect(policy).toContain("current_app_role() = 'fortress_admin'")
    expect(show(tableRolesWith('manage_users'))).toEqual(['fortress_admin'])
  })

  it('inspector_grant_write is manager-or-admin, and so is issuing a grant', () => {
    const policy = rls.slice(rls.indexOf('create policy inspector_grant_write'))
      .slice(0, 300)
    expect(policy).toContain('is_manager_or_admin()')
    expect(show(tableRolesWith('manage_inspector_grants')))
      .toEqual(show(rolesInFunction(rls, 'is_manager_or_admin')))
  })
})

describe('the table matches the audit attribution trigger in 0021', () => {
  it('names the same Fortress roles an audit may be attributed to', () => {
    // The trigger's first check: §10 is Fortress checking Fortress.
    const clause = attribution.slice(
      attribution.indexOf('if v_role not in'),
      attribution.indexOf('Tier 3 is the QA/QC Manager'))
    const named = new Set([...clause.matchAll(/'(\w+)'/g)]
      .map((m) => m[1]!).filter((s) => ALL_ROLES.has(s)))
    expect(show(named)).toEqual(show(tableRolesWith('record_audit')))
  })

  it('reserves Tier 3 to the same roles the table does', () => {
    const clause = attribution.slice(attribution.indexOf("new.tier = 'tier_3_manager'"))
      .slice(0, 400)
    const named = new Set([...clause.matchAll(/'(\w+)'/g)]
      .map((m) => m[1]!).filter((s) => ALL_ROLES.has(s)))
    expect(show(named)).toEqual(show(tableRolesWith('record_tier3')))
  })

  it('does not let a technician record the Tier 3 verification', () => {
    // The gap 0021 was written to close, stated as a fact rather than as
    // a set comparison, so the intent survives a refactor of the trigger.
    expect(can('qaqc_tech', 'record_audit')).toBe(true)
    expect(can('qaqc_tech', 'record_tier3')).toBe(false)
  })
})

describe('the Manager and Technician split', () => {
  const manager = roleDefinition('qaqc_manager')
  const tech = roleDefinition('qaqc_tech')

  it('differs by governance alone — the Technician does all the field work', () => {
    const missing = [...manager.capabilities].filter((c) => !tech.capabilities.has(c))
    expect(missing.sort()).toEqual([
      'approve_section', 'assign_custodian', 'certify_completeness',
      'chair_gate', 'create_book', 'manage_inspector_grants', 'record_tier3',
    ])
    // Nothing the other way round: a Technician holds no capability the
    // Manager lacks, or the Manager could not cover for them.
    expect([...tech.capabilities].filter((c) => !manager.capabilities.has(c)))
      .toEqual([])
  })

  it('keeps the two-person control on section approval', () => {
    // A Technician submits; somebody more accountable accepts. If this
    // ever passes with approve_section on the tech row, §10's independence
    // argument collapses and approve_section() would start raising.
    expect(can('qaqc_tech', 'mark_section_ready')).toBe(true)
    expect(can('qaqc_tech', 'approve_section')).toBe(false)
    expect(can('qaqc_manager', 'approve_section')).toBe(true)
  })

  it('scopes the Technician to assigned books and the Manager to all', () => {
    expect(tech.scope).toBe('assigned')
    expect(manager.scope).toBe('all')
  })

  it('gives the Admin everything the Manager has, and users besides', () => {
    const admin = roleDefinition('fortress_admin')
    for (const c of manager.capabilities) {
      expect(admin.capabilities.has(c), `admin lacks ${c}`).toBe(true)
    }
    expect(admin.capabilities.has('manage_users')).toBe(true)
    expect(manager.capabilities.has('manage_users')).toBe(false)
  })
})

describe('the two client-facing roles', () => {
  it('lets Client Management look and export, and nothing else', () => {
    const client = roleDefinition('client_user')
    expect(show(new Set(client.capabilities)))
      .toEqual(['export_package', 'view_book'])
    expect(client.scope).toBe('own_client_org')
    expect(can('client_user', 'view_internal')).toBe(false)
    expect(can('client_user', 'add_note')).toBe(false)
  })

  it('lets a Client Inspector add notes and change nothing else', () => {
    const inspector = roleDefinition('third_party_inspector')
    expect(show(new Set(inspector.capabilities)))
      .toEqual(['add_note', 'export_package', 'view_book'])
    expect(inspector.scope).toBe('granted')
    expect(can('third_party_inspector', 'edit_records')).toBe(false)
    expect(can('third_party_inspector', 'resolve_flag')).toBe(false)
    // Notes are a record alongside the book, never an edit to it. An
    // inspector disputing a weld writes a note; Fortress raises or
    // resolves the flag.
    expect(can('third_party_inspector', 'view_internal')).toBe(false)
  })

  it('gives View Only the internal view and no pen', () => {
    // The one internal role that is not a writer. It sees the flag queue
    // — that is the point of it — and cannot touch a single record.
    const readonly = roleDefinition('fortress_read_only')
    expect(readonly.isInternal).toBe(true)
    expect(can('fortress_read_only', 'view_internal')).toBe(true)
    for (const c of ['edit_records', 'approve_section', 'add_note',
      'record_audit', 'manage_users'] as const) {
      expect(can('fortress_read_only', c), `View Only holds ${c}`).toBe(false)
    }
  })
})

describe('canComment', () => {
  const asOf = new Date('2026-06-01T12:00:00Z')
  const live = { canComment: true, revokedAt: null, expiresAt: null }

  it('needs no grant from Fortress staff', () => {
    for (const r of ['fortress_admin', 'qaqc_manager', 'qaqc_tech'] as const) {
      expect(canComment(r, null, asOf), `${r} cannot comment`).toBe(true)
    }
  })

  it('refuses the roles that hold no add_note at all', () => {
    // Passing a live grant to a role that cannot comment must not create
    // the right — the grant is a narrowing, never a widening.
    for (const r of ['fortress_read_only', 'client_user'] as const) {
      expect(canComment(r, live, asOf), `${r} commented`).toBe(false)
    }
  })

  it('refuses an inspector with no grant at all', () => {
    expect(canComment('third_party_inspector', null, asOf)).toBe(false)
    expect(canComment('third_party_inspector', undefined, asOf)).toBe(false)
  })

  it('refuses an inspector whose grant is read-only', () => {
    // The decision the brief asked for: show a book to an inspector
    // without inviting them to annotate it.
    expect(canComment('third_party_inspector',
      { ...live, canComment: false }, asOf)).toBe(false)
  })

  it('refuses a revoked grant even where the expiry is still ahead', () => {
    expect(canComment('third_party_inspector',
      { canComment: true, revokedAt: '2026-05-01T00:00:00Z', expiresAt: null },
      asOf)).toBe(false)
  })

  it('refuses an expired grant, and treats the expiry instant as expired', () => {
    expect(canComment('third_party_inspector',
      { ...live, expiresAt: '2026-05-31T00:00:00Z' }, asOf)).toBe(false)
    // Exactly at expiry: the grant is over. The SQL predicate says
    // `expires_at > now()`, so the boundary belongs to the closed side
    // there too — the two must agree or a note would be offered and then
    // refused on save.
    expect(canComment('third_party_inspector',
      { ...live, expiresAt: asOf.toISOString() }, asOf)).toBe(false)
    expect(rls).toContain('g.expires_at is null or g.expires_at > now()')
  })

  it('allows a live, unexpired, commentable grant', () => {
    expect(canComment('third_party_inspector', live, asOf)).toBe(true)
    expect(canComment('third_party_inspector',
      { ...live, expiresAt: '2026-12-31T00:00:00Z' }, asOf)).toBe(true)
  })

  it('matches the roles inspector_comment_insert accepts without a grant', () => {
    // The policy's ungranted branch is is_fortress_writer(). Anyone else
    // the table calls internal and lets comment would be offered a note
    // box the database refuses — View Only is exactly that risk.
    const ungranted = rolesInFunction(rls, 'is_fortress_writer')
    for (const r of ROLES) {
      expect(canComment(r.role, null, asOf), `${r.role} disagrees with the policy`)
        .toBe(ungranted.has(r.role))
    }
  })
})

describe('orgRequirement', () => {
  it('requires an operator on a Client Management account', () => {
    // Without one, current_client_org_id() is null and the client_user
    // branch of can_read_job_book matches nothing — or, worse on a future
    // edit, everything.
    expect(orgRequirement('client_user')).toBe('required')
  })

  it('leaves it optional for a Client Inspector', () => {
    // They reach books by grant either way; the operator is recorded for
    // reporting. The table's own constraint permits both.
    expect(orgRequirement('third_party_inspector')).toBe('optional')
    const constraint = schema.slice(schema.indexOf('constraint client_user_has_org'))
      .slice(0, 300)
    expect(constraint).toContain('client_user')
  })

  it('forbids one on every Fortress role', () => {
    for (const r of ROLES.filter((r) => r.isInternal)) {
      expect(orgRequirement(r.role), `${r.role} may carry an org`).toBe('forbidden')
    }
  })
})
