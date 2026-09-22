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

/**
 * Columns of the tables this application writes to. Read off the live
 * schema, and the reason a write never fails on a field the domain carries
 * but the table does not.
 *
 * Every list here is COMPLETE for its table. A partial list would be worse
 * than no list, because `domainToRow` silently drops anything absent from
 * it — a half-written allowlist for `weld` would quietly discard the weld
 * date on every insert. Tables the application does not yet write to are
 * left out entirely rather than sketched in.
 */
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
    'current_gate', 'current_gate_at', 'work_week',
  ],
  job_book_section: [
    'id', 'job_book_id', 'section_definition_id', 'status', 'na_reason',
    'ready_for_review_by', 'ready_for_review_at', 'approved_by', 'approved_at',
    'computed_pct', 'internal_notes', 'expected_count', 'computed_at', 'collected_pct',
    'expected_by',
    // 0019 — whether the contents were read, and how much was seen.
    'ingestion_status', 'source_file_count', 'source_bytes',
  ],
  weld: [
    'id', 'weld_line_id', 'job_book_id', 'weld_number', 'sort_order', 'weld_date',
    'welder_pass_assignment', 'root_welder_id', 'hot_welder_id', 'fill_welder_id',
    'cap_welder_id', 'welder_stamp', 'welder_id', 'joint_type', 'component_description',
    'part_length', 'heat_numbers', 'cwi_initials', 'cwi_id', 'cwi_visual_result',
    'visual_inspection_date', 'ndt_company', 'xray_number', 'ndt_ticket_number',
    'ndt_method', 'ndt_result', 'ndt_report_id', 'status', 'comments',
    'construction_area', 'equipment_tag', 'isometric_number', 'pressure_test_ref',
    'pipe_size_schedule', 'pipe_grade', 'design_pressure_psi',
    'entered_at', 'entry_source', 'visual_entered_at',
  ],
  welder: [
    'id', 'full_name', 'initials', 'employer', 'active', 'name_aliases',
    'entered_at', 'entry_source',
  ],
  welder_qualification: [
    'id', 'welder_id', 'code', 'process', 'qualification_date', 'expiry_date',
    'continuity_last_verified', 'document_id', 'source', 'entered_at', 'entry_source',
  ],
  cwi: [
    'id', 'full_name', 'initials', 'employer', 'active', 'entered_at', 'entry_source',
  ],
  ndt_technician: [
    'id', 'full_name', 'initials', 'employer', 'classification', 'active',
    'entered_at', 'entry_source',
  ],
  pressure_test: [
    'id', 'job_book_id', 'test_identifier', 'line_codes', 'test_date',
    'test_medium', 'test_pressure_psi', 'duration_minutes', 'result',
    'recorder_serial', 'recorder_cert_id', 'chart_document_id',
    'witnessed_by', 'deleted_at',
    // 0014 — §11.1 needs all three instruments, and §17 needs the hold
    // data and the result document, not just a pass/fail.
    'gauge_serial', 'gauge_cert_id', 'psv_serial', 'psv_cert_id',
    'start_pressure_psi', 'end_pressure_psi', 'ambient_temp_f',
    'result_document_id',
    // 0017 — the §8.1 entry stamp.
    'entered_at', 'entry_source',
  ],
  torque_connection: [
    'id', 'job_book_id', 'iso_flange_number', 'iso_number', 'flange_pipe_size',
    'bolt_diameter', 'bolt_count', 'required_torque_ft_lb',
    'required_torque_min_ft_lb', 'required_torque_max_ft_lb',
    'actual_torque_ft_lb', 'wrench_id', 'wrench_id_raw', 'cp_test_on_flange',
    'torque_date', 'employee_initials', 'inspection_date', 'inspector_initials',
    'status', 'deleted_at',
    // 0017 — the two §8.1 entry stamps. A torque and its inspection have
    // different deadlines and different responsible parties.
    'entered_at', 'entry_source', 'inspection_entered_at',
  ],
  job_book_audit: [
    'id', 'job_book_id', 'tier', 'attempt', 'auditor_id', 'scheduled_for',
    'started_at', 'completed_at', 'outcome', 'score', 'sample_plan',
    'lot_size', 'sample_size', 'double_sample', 'notes', 'created_by',
  ],
  audit_finding: [
    'id', 'audit_id', 'classification', 'section_number', 'summary', 'detail',
    'due_at', 'resolved_at', 'resolved_by', 'resolution',
  ],
  completeness_certification: [
    'job_book_id', 'certified_by', 'certified_at', 'completion_pct',
    'sections_total', 'sections_approved', 'open_critical', 'open_major',
    'tier_2_audit_id', 'tier_3_audit_id', 'statement',
    'revoked_at', 'revoked_by', 'revoked_reason',
  ],
  timeliness_period: [
    'id', 'job_book_id', 'period_start', 'period_end', 'within_standard',
    'total_measured', 'unmeasurable', 'rate_pct', 'computed_at', 'escalated_at',
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
