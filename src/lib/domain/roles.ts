/**
 * Who may do what.
 *
 * ONE RULE ABOUT THIS FILE. Nothing here is a security control. Every
 * capability below is already enforced by Row Level Security or by a
 * `SECURITY DEFINER` function, and `supabase/tests/security.sql` proves
 * it against a real Postgres. This table exists so the interface can
 * stop offering people buttons whose writes the database would refuse —
 * which is a courtesy to the person, not a barrier to an attacker.
 *
 * So the table has to MATCH the database rather than define it. Where
 * the two disagree, the database wins and this file is the bug. The
 * `roles.test.ts` suite checks the rows that are checkable from the
 * schema text, and the comment on each capability names what enforces
 * it, so a future change has somewhere to look.
 *
 * THE LABELS ARE THE OPERATOR'S VOCABULARY, NOT THE SCHEMA'S. The enum
 * values are frozen — `client_user` is in the database, in the RLS
 * predicates and in a check constraint, and renaming it would be a
 * migration across a dozen policies for no gain. What a person reads on
 * screen is a different question, and it should be the words Fortress
 * actually uses.
 */
import type { UserRole } from './types'

/** Every capability the interface gates on. */
export type Capability =
  // -- Reading -----------------------------------------------------------
  /** See a job book at all. Scope differs per role; see `BookScope`. */
  | 'view_book'
  /**
   * See Fortress's own working material: the flag queue, entry
   * timeliness, gate reviews and the §10 audit history.
   *
   * Enforced by: RLS on gate_review and job_book_audit (is_fortress_staff),
   * and by the page guards on /timeliness and /audits.
   */
  | 'view_internal'
  /** Download the turnover package. */
  | 'export_package'

  // -- Writing records ---------------------------------------------------
  /** Upload documents and run the §11/§12/§14/§17 imports.
   *  Enforced by: `can_write_job_book()` in every table's RLS policy. */
  | 'edit_records'
  /** Submit a section for a second person to approve.
   *  Enforced by: RLS on job_book_section via can_write_job_book. */
  | 'mark_section_ready'
  /** Approve a section. Never the person who submitted it — that half of
   *  the control is by identity, not by role.
   *  Enforced by: `approve_section()`, which raises on both counts. */
  | 'approve_section'
  /** Resolve, dismiss or acknowledge a compliance flag.
   *  Enforced by: RLS on compliance_flag via can_write_job_book. */
  | 'resolve_flag'

  // -- Governance --------------------------------------------------------
  /** Create a job book. Enforced by: `job_book_insert` policy. */
  | 'create_book'
  /** Chair a §7 gate review. Enforced by: `record_gate_review()`. */
  | 'chair_gate'
  /** Name the §5 Custodian. Enforced by: `assign_custodian()`. */
  | 'assign_custodian'
  /** Record a §10 Tier 1 or Tier 2 audit. Tier 2 additionally requires
   *  JB-3 and independence, which `record_peer_audit()` enforces. */
  | 'record_audit'
  /** Record the §10 Tier 3 QA/QC Manager verification.
   *  Enforced by: the `job_book_audit_attribution` trigger (0021). */
  | 'record_tier3'
  /** Sign the §10.4 Completeness Certification.
   *  Enforced by: `certify_completeness()`. */
  | 'certify_completeness'

  // -- Administration ----------------------------------------------------
  /** Invite people, change roles, deactivate accounts.
   *  Enforced by: `app_user_write` policy and `invite_user()`. */
  | 'manage_users'
  /** Issue and revoke a Client Inspector's access to one book.
   *  Enforced by: `inspector_grant_write` policy (is_manager_or_admin). */
  | 'manage_inspector_grants'

  // -- Notes -------------------------------------------------------------
  /**
   * Add a note against a book, a section or a document.
   *
   * Fortress staff may always. A Client Inspector may only where their
   * grant on that book carries `can_comment` — so this capability being
   * present is necessary and not sufficient, and `canComment()` below is
   * what the inspector path actually asks.
   *
   * Enforced by: `inspector_comment_insert` policy.
   */
  | 'add_note'

/** How much of the estate a role can see. */
export type BookScope =
  /** Every book in the system. */
  | 'all'
  /** Only books this person is assigned to (§5). */
  | 'assigned'
  /** Only books belonging to this person's operator. */
  | 'own_client_org'
  /** Only books carrying a live, unexpired grant to this person. */
  | 'granted'

export interface RoleDefinition {
  role: UserRole
  /** What a person reads on screen. Fortress's vocabulary. */
  label: string
  /** One line for a picker or a table. */
  summary: string
  scope: BookScope
  scopeLabel: string
  capabilities: ReadonlySet<Capability>
  /** True for the roles that belong to Fortress rather than to a client. */
  isInternal: boolean
}

const caps = (...xs: Capability[]) => new Set(xs) as ReadonlySet<Capability>

/**
 * The full set a Fortress writer holds. Named so the Manager and the
 * Technician rows differ by exactly the governance capabilities, and the
 * difference is legible rather than buried in two long lists.
 */
const FIELD_WORK: Capability[] = [
  'view_book', 'view_internal', 'export_package',
  'edit_records', 'mark_section_ready', 'resolve_flag',
  'record_audit', 'add_note',
]

/**
 * The acts §5, §7 and §10 reserve to the QA/QC Manager.
 *
 * Kept separate from the Technician on purpose. `approve_section` is the
 * two-person control: a Technician submits, somebody senior accepts. The
 * gate chair, the Custodian appointment, the Tier 3 verification and the
 * Completeness Certification are all the same shape — a second, more
 * accountable person putting their name to the first person's work.
 */
const GOVERNANCE: Capability[] = [
  'approve_section', 'create_book', 'chair_gate', 'assign_custodian',
  'record_tier3', 'certify_completeness', 'manage_inspector_grants',
]

export const ROLES: readonly RoleDefinition[] = [
  {
    role: 'fortress_admin',
    label: 'Admin',
    summary: 'Everything, plus user accounts and roles.',
    scope: 'all',
    scopeLabel: 'Every book, every operator',
    isInternal: true,
    capabilities: caps(...FIELD_WORK, ...GOVERNANCE, 'manage_users'),
  },
  {
    role: 'qaqc_manager',
    label: 'Fortress QA/QC — Manager',
    summary:
      'Every Fortress book. Approves sections, chairs gate reviews, ' +
      'names Custodians and signs the Completeness Certification.',
    scope: 'all',
    scopeLabel: 'Every Fortress book',
    isInternal: true,
    capabilities: caps(...FIELD_WORK, ...GOVERNANCE),
  },
  {
    role: 'qaqc_tech',
    label: 'Fortress QA/QC — Technician',
    summary:
      'Books they are assigned to. Enters records, uploads evidence and ' +
      'submits sections for review — a second person approves them.',
    scope: 'assigned',
    scopeLabel: 'Assigned books only',
    isInternal: true,
    capabilities: caps(...FIELD_WORK),
  },
  {
    role: 'fortress_read_only',
    label: 'View Only',
    summary: 'Sees every Fortress book and changes nothing.',
    scope: 'all',
    scopeLabel: 'Every Fortress book',
    isInternal: true,
    capabilities: caps('view_book', 'view_internal', 'export_package'),
  },
  {
    role: 'client_user',
    label: 'Client Management',
    summary:
      'Their own company’s books. Sees completion and approved ' +
      'documents; none of Fortress’s internal working material.',
    scope: 'own_client_org',
    scopeLabel: 'Their operator’s books',
    isInternal: false,
    capabilities: caps('view_book', 'export_package'),
  },
  {
    role: 'third_party_inspector',
    label: 'Client Inspector',
    summary:
      'One book at a time, by grant, optionally time-limited. May add ' +
      'notes where the grant allows it. Every document view is logged.',
    scope: 'granted',
    scopeLabel: 'Books granted to them',
    isInternal: false,
    capabilities: caps('view_book', 'export_package', 'add_note'),
  },
]

const BY_ROLE = new Map(ROLES.map((r) => [r.role, r]))

export function roleDefinition(role: UserRole): RoleDefinition {
  const found = BY_ROLE.get(role)
  // Every enum member has a row above, and the test suite asserts it. A
  // throw here would be a deploy-time crash on an unknown role; falling
  // back to the least privileged shape fails closed instead.
  return found ?? {
    role,
    label: role,
    summary: 'Unknown role. Treated as no access.',
    scope: 'granted',
    scopeLabel: 'Nothing',
    isInternal: false,
    capabilities: caps(),
  }
}

export function roleLabel(role: UserRole): string {
  return roleDefinition(role).label
}

/**
 * May a person in this role do this thing, anywhere?
 *
 * Deliberately not book-specific. Scope is a separate question — a
 * Technician holds `edit_records` but only on their assigned books, and
 * the database is what applies that. Using this to decide whether to
 * render a button is right; using it to decide whether a write is
 * allowed is not, and the write would be refused anyway.
 */
export function can(role: UserRole, capability: Capability): boolean {
  return roleDefinition(role).capabilities.has(capability)
}

/** Roles holding a capability. For "who can approve this?" copy. */
export function rolesWith(capability: Capability): RoleDefinition[] {
  return ROLES.filter((r) => r.capabilities.has(capability))
}

/**
 * May this person add a note to this book?
 *
 * The one capability whose answer depends on more than the role. A
 * Client Inspector's grant carries `can_comment` separately from the
 * grant itself, so access to a book and permission to write on it are
 * two decisions — which is what lets you show a book to an inspector
 * without inviting them to annotate it.
 */
export function canComment(
  role: UserRole,
  grant?: { canComment?: boolean; revokedAt?: string | null; expiresAt?: string | null } | null,
  asOf: Date = new Date(),
): boolean {
  if (!can(role, 'add_note')) return false
  // Fortress staff need no grant; the book assignment is their authority.
  if (roleDefinition(role).isInternal) return true

  if (!grant || !grant.canComment) return false
  if (grant.revokedAt) return false
  if (grant.expiresAt && new Date(grant.expiresAt) <= asOf) return false
  return true
}

/**
 * Does a role require an operator on its `app_user` row?
 *
 * The table's own check constraint: a Client Management user without an
 * operator would see every operator's books, and a Fortress user with
 * one would be filtered down to a single client. A Client Inspector may
 * carry one or not — they reach books by grant either way, and the
 * operator is recorded for reporting.
 */
export function orgRequirement(role: UserRole): 'required' | 'optional' | 'forbidden' {
  if (role === 'client_user') return 'required'
  if (role === 'third_party_inspector') return 'optional'
  return 'forbidden'
}
