/**
 * Structural checks on the migrations.
 *
 * These do not replace running the policies against a live Postgres — §9
 * calls for RLS policy tests, and those belong in a Supabase test harness
 * with real sessions. What these catch is the failure mode that actually
 * happens: a table added later that nobody remembered to protect. A new
 * record type inheriting isolation is worth more than a hundred assertions
 * about the tables that already had it.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const schema = readFileSync('supabase/migrations/0001_schema.sql', 'utf8')
const audit = readFileSync('supabase/migrations/0002_audit.sql', 'utf8')
const rls = readFileSync('supabase/migrations/0003_rls.sql', 'utf8')

/** Every table created in the schema migration. */
function tablesIn(sql: string): string[] {
  return [...sql.matchAll(/create table (\w+)/g)].map((m) => m[1]!)
}

const SCHEMA_TABLES = tablesIn(schema)

describe('Row Level Security', () => {
  it('creates the tables the domain needs', () => {
    expect(SCHEMA_TABLES).toContain('job_book')
    expect(SCHEMA_TABLES).toContain('weld')
    expect(SCHEMA_TABLES).toContain('torque_connection')
    expect(SCHEMA_TABLES.length).toBeGreaterThan(25)
  })

  it('enables and FORCEs RLS on every table carrying job data', () => {
    // FORCE matters as much as ENABLE: without it, the table owner — which
    // is what a migration or a SECURITY DEFINER function runs as — bypasses
    // every policy.
    const enabled = new Set(
      [...rls.matchAll(/'([\w]+)'/g)].map((m) => m[1]!),
    )
    expect(rls).toMatch(/alter table %I enable row level security/)
    expect(rls).toMatch(/alter table %I force row level security/)
    for (const t of SCHEMA_TABLES) {
      expect(enabled.has(t), `table ${t} is not in the RLS enable list`).toBe(true)
    }
  })

  it('protects the audit log too', () => {
    const enabled = new Set([...rls.matchAll(/'([\w]+)'/g)].map((m) => m[1]!))
    expect(enabled.has('audit_event')).toBe(true)
  })

  it('scopes client users by their own org and nothing else', () => {
    expect(rls).toContain("when 'client_user' then exists (")
    expect(rls).toContain('p.client_org_id = current_client_org_id()')
  })

  it('scopes inspectors to a live, unrevoked, unexpired grant', () => {
    expect(rls).toContain('g.revoked_at is null')
    expect(rls).toContain('g.expires_at is null or g.expires_at > now()')
  })

  it('scopes techs to their assignments rather than to every book', () => {
    expect(rls).toMatch(/when 'qaqc_tech' then exists \(\s*select 1 from job_assignment/)
  })

  it('never lets a read-only role, client or inspector write', () => {
    // can_write_job_book falls through to false for every role that is not
    // admin, manager or an assigned tech.
    const start = rls.indexOf('function can_write_job_book')
    const open = rls.indexOf('$$', start)
    const body = rls.slice(open + 2, rls.indexOf('$$', open + 2))
    expect(body).toContain('else false')
    expect(body).toContain("when 'fortress_admin' then true")
  })

  it('withholds unapproved documents from clients and inspectors', () => {
    const policy = rls.slice(rls.indexOf('create policy document_read'))
    expect(policy).toContain('approved_at is not null')
    expect(policy).toContain("visibility in ('client')")
  })

  it('keeps the raw flag queue internal to Fortress', () => {
    const policy = rls.slice(
      rls.indexOf('create policy compliance_flag_read'),
      rls.indexOf('create policy inspector_comment_read'),
    )
    expect(policy).toContain('is_fortress_staff()')
    expect(policy).not.toContain('client_user')
  })

  it('gives no INSERT policy on the audit log', () => {
    // Rows arrive only through SECURITY DEFINER triggers. An INSERT policy
    // would let a caller forge history.
    expect(rls).toContain('create policy audit_read on audit_event for select')
    expect(rls).not.toMatch(/create policy \w+ on audit_event for insert/)
  })

  it('projects internal columns out of the client-facing views server-side', () => {
    const view = rls.slice(rls.indexOf('create view client_weld_v'))
    expect(view).toContain('security_invoker = true')
    // The internal comments column and the per-pass welder identities are
    // absent from the projection, not hidden in the browser.
    const columns = view.slice(0, view.indexOf('from weld'))
    expect(columns).not.toContain('comments')
    expect(columns).not.toContain('root_welder_id')
  })
})

describe('append-only audit log', () => {
  it('revokes update and delete from every API role', () => {
    expect(audit).toMatch(/revoke update, delete, truncate on audit_event from anon, authenticated/)
  })

  it('rewrites update and delete to no-ops at the rule level', () => {
    expect(audit).toContain('create rule audit_event_no_update as on update to audit_event do instead nothing')
    expect(audit).toContain('create rule audit_event_no_delete as on delete to audit_event do instead nothing')
  })

  it('attaches the audit trigger to every table carrying compliance data', () => {
    const block = audit.slice(audit.indexOf('foreach t in array array['))
    const attached = new Set([...block.matchAll(/'(\w+)'/g)].map((m) => m[1]!))
    const exempt = new Set(['audit_event', 'score_snapshot'])
    for (const t of SCHEMA_TABLES) {
      if (exempt.has(t)) continue
      expect(attached.has(t), `table ${t} has no audit trigger`).toBe(true)
    }
  })

  it('records a soft delete as its own action rather than as an update', () => {
    expect(audit).toContain("then 'soft_delete'")
  })

  it('logs document reads, which leave no row behind otherwise', () => {
    expect(audit).toContain('function log_document_access')
  })
})

describe('two-person control on section approval', () => {
  it('refuses approval by a tech', () => {
    expect(audit).toContain("if v_actor.role not in ('fortress_admin','qaqc_manager') then")
    expect(audit).toContain('section approval requires QA/QC Manager or Admin')
  })

  it('refuses approval by whoever submitted the section', () => {
    expect(audit).toContain('if v_section.ready_for_review_by = v_actor.id then')
    expect(audit).toContain('may not be approved by the user who submitted it')
  })

  it('backs the rule with a table constraint, not only the function', () => {
    expect(schema).toContain('constraint approver_is_not_submitter')
    expect(schema).toContain('constraint approval_is_attributed')
  })
})

describe('soft delete and traceability', () => {
  it('gives every compliance table a deleted_at rather than relying on DELETE', () => {
    const tablesWithoutSoftDelete = ['job_assignment', 'nde_report_line', 'compliance_flag',
      'inspector_comment', 'score_snapshot', 'audit_event', 'book_template', 'section_definition',
      'job_book_section', 'inspector_grant']
    for (const t of SCHEMA_TABLES) {
      if (tablesWithoutSoftDelete.includes(t)) continue
      const body = schema.slice(schema.indexOf(`create table ${t} (`))
      expect(body.slice(0, body.indexOf(');')), `${t} has no deleted_at`).toContain('deleted_at')
    }
  })

  it('requires a resolution note before a flag can be closed', () => {
    expect(schema).toContain('constraint resolution_has_note')
  })

  it('keeps a document version chain instead of overwriting', () => {
    expect(schema).toContain('supersedes_document_id uuid references document(id)')
    expect(schema).toContain('normalized_filename    text not null')
    expect(schema).toContain('original_filename      text not null')
  })
})
