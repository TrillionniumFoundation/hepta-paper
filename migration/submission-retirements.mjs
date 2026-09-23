const PUBLIC_SYMBOLS = {
  "paperctl_modules/external_submission_handoff_bundle.py": [
    "abs_path",
    "file_record",
    "artifact_record",
    "paper_entry",
    "add_check",
    "build_external_submission_handoff_bundle",
    "write_upload_manifest",
    "write_evidence_manifest",
    "markdown",
    "create_zip"
  ],
  "paperctl_modules/paper_production_external_auth_boundary.py": [
    "build_boundary_packet"
  ],
  "paperctl_modules/paper_production_external_lifecycle_capstone.py": [
    "build_external_lifecycle_capstone",
    "markdown"
  ],
  "paperctl_modules/paper_production_external_lifecycle_predispatch_authoring_surface_matrix.py": [
    "build_external_lifecycle_predispatch_authoring_surface_matrix",
    "markdown"
  ],
  "paperctl_modules/paper_production_external_lifecycle_readiness_matrix.py": [
    "build_external_lifecycle_readiness_matrix",
    "markdown"
  ],
  "paperctl_modules/paper_production_post_action_runtime_chain_regression.py": [
    "build_post_action_runtime_chain_regression",
    "markdown"
  ],
  "paperctl_modules/paper_production_referee_repair_packet_evidence_candidate_handoff_preflight_capstone.py": [
    "build_referee_repair_packet_evidence_candidate_handoff_preflight_capstone",
    "markdown"
  ],
  "paperctl_modules/paper_production_referee_repair_packet_operator_real_source_human_input_artifact_completeness_value_lint_handoff_intake_signature_marker_verifier_capstone.py": [
    "build_referee_repair_packet_operator_real_source_human_input_artifact_completeness_value_lint_handoff_intake_signature_marker_verifier_capstone",
    "markdown"
  ],
  "paperctl_modules/paper_production_referee_repair_packet_operator_real_source_human_input_artifact_manifest_checksum_handoff_signature_quarantine_capstone.py": [
    "build_referee_repair_packet_operator_real_source_human_input_artifact_manifest_checksum_handoff_signature_quarantine_capstone",
    "markdown"
  ],
  "paperctl_modules/paper_production_referee_repair_packet_operator_real_source_human_input_artifact_source_value_packet_handoff_receipt_identity_verifier_capstone.py": [
    "build_referee_repair_packet_operator_real_source_human_input_artifact_source_value_packet_handoff_receipt_identity_verifier_capstone",
    "markdown"
  ],
  "paperctl_modules/paper_production_referee_repair_packet_operator_real_source_human_input_manifest_field_completeness_payload_checksum_handoff_signature_binding_verifier_capstone.py": [
    "build_referee_repair_packet_operator_real_source_human_input_manifest_field_completeness_payload_checksum_handoff_signature_binding_verifier_capstone",
    "markdown"
  ],
  "paperctl_modules/paper_production_referee_repair_source_artifact_quarantine_handoff_workflow_matrix.py": [
    "build_referee_repair_source_artifact_quarantine_handoff_workflow_matrix",
    "markdown"
  ],
  "paperctl_modules/paper_production_release_lock.py": [
    "build_release_lock"
  ],
  "paperctl_modules/paper_production_remaining_input_autopilot.py": [
    "build_attestation_template",
    "build_source_artifact_operator_closure_rows",
    "build_source_artifact_operator_closure_packet",
    "ready_command_count",
    "build_fresh_target_intake_rows",
    "bind_approval_authorizations_to_generated_artifacts",
    "rebind_report_authorization_inputs",
    "build_expanded_manual_decision_import_rows",
    "build_ready_commands",
    "build_remaining_input_autopilot"
  ],
  "paperctl_modules/paper_production_repair_executor.py": [
    "entry_id_for_request",
    "source_path_for_request",
    "evidence_path_for_request",
    "scope_keys_for_entry",
    "insertion_index",
    "apply_scope_paragraphs",
    "source_has_scope",
    "scan_claim_rows",
    "scan_theorem_rows",
    "discover_evidence_records",
    "build_artifact",
    "execute_request"
  ],
  "paperctl_modules/paper_production_reviewed_target_evidence_autofill.py": [
    "build_autofill_draft_rows",
    "autofill_placeholder_issues"
  ],
  "paperctl_modules/paper_production_runtime_dry_run_harness.py": [
    "build_runtime_dry_run_harness",
    "markdown"
  ],
  "paperctl_modules/paper_production_stale_pass_invalidation_audit.py": [
    "build_stale_pass_invalidation_audit",
    "markdown"
  ],
  "paperctl_modules/paper_production_strict_ordered_refresh_gate.py": [
    "command_to_event_type",
    "build_strict_ordered_refresh_gate",
    "markdown"
  ],
  "paperctl_modules/paper_production_submission_action_manifest_prerequisite_surface_matrix.py": [
    "build_submission_action_manifest_prerequisite_surface_matrix",
    "markdown"
  ],
  "paperctl_modules/paper_production_submission_decision_template.py": [
    "build_decision_template",
    "sheet_markdown",
    "markdown"
  ],
  "paperctl_modules/paper_production_submission_evidence_intake_quarantine_workflow_matrix.py": [
    "build_submission_evidence_intake_quarantine_workflow_matrix",
    "markdown"
  ],
  "paperctl_modules/paper_production_submission_evidence_real_intake_acceptance_gate.py": [
    "expected_operator_input_paths",
    "build_submission_evidence_real_intake_acceptance_gate",
    "markdown"
  ],
  "paperctl_modules/paper_production_submission_handoff.py": [
    "build_submission_handoff"
  ],
  "paperctl_modules/paper_production_submission_intake_lint.py": [
    "build_submission_intake_lint"
  ],
  "paperctl_modules/paper_production_submission_lifecycle.py": [
    "build_submission_approval_packet",
    "build_fresh_venue_evidence_bundle",
    "build_submission_action_manifest",
    "build_submission_replay_guard",
    "build_submission_dispatch_authorization",
    "build_external_executor_handoff_outbox",
    "build_external_executor_response_intake",
    "build_external_executor_response_redrive_plan",
    "build_external_executor_response_redrive_attempt_ledger",
    "build_external_submission_receipt",
    "build_venue_state_proof",
    "build_submission_audit_archive"
  ],
  "paperctl_modules/paper_production_target_scope_audit.py": [
    "build_target_scope_audit",
    "target_scope_markdown",
    "target_scope_report_copy"
  ],
  "paperctl_modules/paper_production_terminal_chain_generic_validator.py": [
    "FailClosedSummary",
    "FailClosedReport",
    "as_path_text",
    "scan_paths",
    "family_key",
    "role",
    "path_record",
    "build_terminal_chain_inventory",
    "build_terminal_chain_generic_validator_report",
    "blocked_terminal_chain_report"
  ],
  "paperctl_modules/paper_production_terminal_chain_sprawl_capstone.py": [
    "build_terminal_chain_sprawl_capstone",
    "markdown"
  ],
  "paperctl_modules/paper_production_v2_semantic_release_lock.py": [
    "build_semantic_release_lock"
  ]
};

const CLASSIFICATIONS = Object.freeze({
  'paperctl_modules/external_submission_handoff_bundle.py': 'retired_legacy_local_handoff_bundle_writer',
  'paperctl_modules/paper_production_repair_executor.py': 'retired_legacy_direct_source_mutation_executor',
  'paperctl_modules/paper_production_remaining_input_autopilot.py': 'retired_synthetic_submission_input_authority',
  'paperctl_modules/paper_production_reviewed_target_evidence_autofill.py': 'retired_synthetic_submission_input_authority',
  'paperctl_modules/paper_production_external_auth_boundary.py': 'retired_legacy_submission_schema_superseded_by_native_lifecycle',
  'paperctl_modules/paper_production_release_lock.py': 'retired_legacy_submission_schema_superseded_by_native_lifecycle',
  'paperctl_modules/paper_production_submission_handoff.py': 'retired_legacy_submission_schema_superseded_by_native_lifecycle',
  'paperctl_modules/paper_production_submission_intake_lint.py': 'retired_legacy_submission_schema_superseded_by_native_lifecycle',
  'paperctl_modules/paper_production_submission_lifecycle.py': 'retired_legacy_submission_schema_superseded_by_native_lifecycle',
  'paperctl_modules/paper_production_v2_semantic_release_lock.py': 'retired_legacy_submission_schema_superseded_by_native_lifecycle',
});

export const SUBMISSION_EXPLICIT_RETIREMENTS = Object.freeze(
  Object.entries(PUBLIC_SYMBOLS).map(([sourcePath, publicSymbols]) => Object.freeze({
    sourcePath,
    publicSymbols: Object.freeze([...publicSymbols]),
    disposition: CLASSIFICATIONS[sourcePath] || 'retired_generated_submission_control_evidence_surface',
    reason: CLASSIFICATIONS[sourcePath]
      ? 'Legacy submission authority, mutation, local bundling, or schema is explicitly excluded from the hepta-native fail-closed lifecycle.'
      : 'Generated report, matrix, template, capstone, or terminal-chain logic is not a hepta-native submission executor capability.',
  })),
);

export function submissionRetirementDisposition(sourcePath) {
  return SUBMISSION_EXPLICIT_RETIREMENTS.find((entry) => entry.sourcePath === sourcePath) || null;
}
