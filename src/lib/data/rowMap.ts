/**
 * Postgres rows to domain objects.
 *
 * The schema in `supabase/migrations/` is snake_case because that is what
 * Postgres reads well; the domain types are camelCase because that is what
 * TypeScript reads well. The two are otherwise the same shape, deliberately
 * — `required_torque_ft_lb` is `requiredTorqueFtLb` and nothing else — so
 * one mechanical conversion covers every table instead of thirty
 * hand-written mappers that drift one field at a time.
 *
 * Nulls are preserved rather than coerced. A null `actual_torque_ft_lb`
 * means nobody has torqued that connection yet, and turning it into 0 would
 * invent a measurement; every rule in the domain distinguishes the two.
 */

/** `required_torque_ft_lb` → `requiredTorqueFtLb`. Digits stay attached to
 *  the word they follow, so `sha256` survives and `nps` is untouched. */
export function toCamel(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase())
}

/** The inverse, for building an insert. `sha256` must not become
 *  `sha_256`, so a digit run only breaks before an uppercase letter. */
export function toSnake(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)
}

type Row = Record<string, unknown>

export function rowToDomain<T>(row: Row): T {
  const out: Row = {}
  for (const [k, v] of Object.entries(row)) out[toCamel(k)] = v
  return out as T
}

export function rowsToDomain<T>(rows: Row[] | null | undefined): T[] {
  return (rows ?? []).map((r) => rowToDomain<T>(r))
}

/**
 * Domain object to a row, dropping keys the table does not have.
 *
 * The drop is the point. Domain objects carry derived fields the database
 * does not store — a section's `collectedPct` is cached, but a bundle also
 * travels with things like `redacted` that exist only in memory — and
 * PostgREST rejects the whole statement on one unknown column rather than
 * ignoring it. Passing the table's column list makes that a silent no-op
 * instead of a 400 that surfaces as "upload failed" with no reason.
 */
export function domainToRow(
  obj: object,
  allowedColumns?: readonly string[],
): Row {
  const allowed = allowedColumns ? new Set(allowedColumns) : null
  const out: Row = {}
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue
    const col = toSnake(k)
    if (allowed && !allowed.has(col)) continue
    out[col] = v
  }
  return out
}

/** Columns of the tables this application writes to. Read off the live
 *  schema, and the reason a write never fails on a field the domain
 *  carries but the table does not. */
export const COLUMNS = {
  job_book: [
    'id', 'project_id', 'book_template_id', 'book_type', 'job_number',
    'facility_name', 'drill_pad_name', 'well_names', 'construction_company',
    'welding_company', 'cwi_names', 'pipe_size_in', 'pipe_schedule', 'pipe_grade',
    'status', 'target_turnover_date', 'construction_start', 'construction_end',
    'data_as_of_date', 'required_xray_pct', 'required_torque_inspect_pct',
    'torque_tolerance_pct', 'cert_expiry_warning_days', 'xray_credit_rule',
    'created_by', 'enabled_optional_sections', 'business_unit',
    'qaqc_representative', 'construction_areas', 'default_design_pressure_psi',
    // Governing documents (0014) and the governance spine (0015).
    'client_checklist_reference', 'client_checklist_revision',
    'piping_spec_reference', 'piping_spec_revision',
    'governing_docs_confirmed_at', 'governing_docs_confirmed_by',
    'custodian_id', 'custodian_assigned_at', 'custodian_assigned_by',
    'planned_curve', 'planned_curve_agreed_at', 'planned_curve_agreed_by',
    'current_gate', 'current_gate_at',
  ],
  job_book_section: [
    'id', 'job_book_id', 'section_definition_id', 'status', 'na_reason',
    'ready_for_review_by', 'ready_for_review_at', 'approved_by', 'approved_at',
    'computed_pct', 'internal_notes', 'expected_count', 'computed_at', 'collected_pct',
    'expected_by',
  ],
  document: [
    'id', 'job_book_id', 'section_id', 'record_type', 'record_id',
    'original_filename', 'normalized_filename', 'storage_path', 'mime_type',
    'byte_size', 'sha256', 'page_count', 'version', 'supersedes_document_id',
    'is_superseded', 'visibility', 'uploaded_by', 'uploaded_at', 'approved_by',
    'approved_at', 'deleted_at', 'deleted_by', 'delete_reason',
  ],
  weld_line: [
    'id', 'job_book_id', 'line_code', 'line_description', 'workbook', 'well_name',
    'drill_pad_name', 'facility_name', 'operator_pic', 'welding_company',
    'pipe_size', 'pipe_schedule', 'pipe_grade', 'service_type', 'sort_order',
    'expected_weld_count', 'grouping_kind',
  ],
  project: [
    'id', 'client_org_id', 'name', 'operator_pic_name', 'afe_number',
  ],
  gate_review: [
    'id', 'job_book_id', 'gate', 'attempt', 'outcome', 'chaired_by',
    'custodian_id', 'project_manager_id', 'decided_at', 'criteria_snapshot',
    'completion_pct', 'conditional_due_at', 'cleared_at', 'cleared_by',
    'override_note', 'notes',
  ],
  gate_condition: [
    'id', 'gate_review_id', 'criterion_id', 'description', 'owner_id',
    'due_at', 'closed_at', 'closed_by', 'closure_note',
  ],
  compliance_flag: [
    'id', 'job_book_id', 'rule_id', 'severity', 'title', 'detail',
    'entity_type', 'entity_id', 'section_number', 'fingerprint', 'state',
    'assigned_to', 'resolution_note', 'resolved_by', 'resolved_at',
    'due_at', 'escalated_at',
  ],
} as const
