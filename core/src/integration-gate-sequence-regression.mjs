import { digest } from './hash-utils.mjs';

export const INTEGRATION_GATE_SEQUENCE_REGRESSION_VERSION = 1;

export const INTEGRATION_GATE_SEQUENCE_REGRESSION_REPORT_FILE_ID = 'integration-gate-sequence-regression-latest.json';

const EXPECTED_ORDER = Object.freeze([
  'report_freshness_regression_export',
  'report_retention_regression_export',
  'integration_gate_sequence_regression_export',
  'report_inventory_consistency_export',
  'report_bootstrap_seed_export',
  'report_schema_contract_export',
  'report_lineage_topology_export',
  'report_hash_stability_regression_export',
  'report_output_pairing_export',
  'report_artifact_reproducibility_export',
  'report_self_reference_boundary_regression_export',
  'report_contract_manifest_export',
  'report_contract_required_coverage_regression_export',
  'report_contract_doc_coverage_regression_export',
  'report_contract_syntax_coverage_regression_export',
  'report_contract_source_derivation_regression_export',
  'report_contract_summary_key_regression_export',
  'report_contract_audit_forwarding_regression_export',
  'report_contract_checkpoint_binding_shape_regression_export',
  'report_contract_gate_summary_shape_regression_export',
  'report_contract_exporter_stdout_shape_regression_export',
  'report_contract_safety_flag_regression_export',
  'report_contract_artifact_binding_regression_export',
  'report_contract_doc_index_anchor_regression_export',
  'report_contract_doc_page_latest_detail_regression_export',
  'report_contract_doc_page_command_section_regression_export',
  'report_contract_doc_page_safety_section_detail_regression_export',
  'report_contract_doc_page_strict_gate_section_regression_export',
  'report_contract_doc_page_output_section_regression_export',
  'report_contract_doc_page_cross_report_section_regression_export',
  'report_contract_doc_page_closeout_section_regression_export',
  'report_contract_doc_page_post_gate_writer_section_regression_export',
  'report_contract_doc_page_retention_section_regression_export',
  'report_contract_doc_page_freshness_hash_section_regression_export',
  'report_contract_doc_page_checkpoint_hash_section_regression_export',
  'report_contract_doc_page_bootstrap_seed_section_regression_export',
  'report_contract_doc_page_clean_rerun_section_regression_export',
  'report_contract_doc_page_final_settlement_section_regression_export',
  'report_contract_doc_page_closeout_index_section_regression_export',
  'report_contract_doc_page_closeout_evidence_section_regression_export',
  'report_contract_doc_page_closeout_ledger_section_regression_export',
  'report_contract_doc_page_closeout_retention_proof_section_regression_export',
  'report_contract_doc_page_closeout_probe_bundle_section_regression_export',
  'report_contract_doc_page_closeout_signoff_section_regression_export',
  'report_contract_doc_page_closeout_release_manifest_section_regression_export',
  'report_contract_doc_page_release_archive_index_section_regression_export',
  'report_contract_doc_page_release_handoff_ledger_section_regression_export',
  'report_contract_doc_page_release_delivery_readiness_section_regression_export',
  'report_contract_doc_page_release_execution_denial_section_regression_export',
  'report_contract_doc_page_release_operator_approval_section_regression_export',
  'report_contract_doc_page_release_approval_ledger_section_regression_export',
  'report_contract_doc_page_release_action_queue_section_regression_export',
  'report_contract_doc_page_release_runner_dispatch_denial_section_regression_export',
  'report_contract_doc_page_release_live_action_preflight_section_regression_export',
  'report_contract_doc_page_release_execution_intent_capture_section_regression_export',
  'report_contract_doc_page_release_execution_approval_boundary_section_regression_export',
  'report_contract_doc_page_release_runner_execution_gate_section_regression_export',
  'report_contract_doc_page_release_dispatch_implementation_denial_section_regression_export',
  'report_contract_doc_page_release_platform_state_snapshot_denial_section_regression_export',
  'report_contract_doc_page_release_dry_run_replay_denial_section_regression_export',
  'report_contract_doc_page_release_proof_bundle_denial_section_regression_export',
  'report_contract_doc_page_release_ledger_denial_section_regression_export',
  'report_contract_doc_page_release_audit_evidence_denial_section_regression_export',
  'report_contract_doc_page_release_receipt_evidence_denial_section_regression_export',
  'report_contract_doc_page_release_post_action_receipt_denial_section_regression_export',
  'report_contract_doc_page_release_post_action_audit_denial_section_regression_export',
  'report_contract_doc_page_release_post_action_reconciliation_denial_section_regression_export',
  'report_contract_doc_page_release_post_action_settlement_denial_section_regression_export',
  'report_contract_doc_page_release_post_action_acceptance_denial_section_regression_export',
  'report_contract_doc_page_release_post_action_payment_denial_section_regression_export',
  'report_contract_doc_page_release_post_action_deployment_denial_section_regression_export',
  'report_contract_doc_page_release_post_action_provider_spend_denial_section_regression_export',
  'report_contract_doc_page_release_post_action_state_transition_denial_section_regression_export',
  'report_contract_doc_page_release_post_action_queue_consumption_denial_section_regression_export',
  'report_contract_doc_page_release_post_action_background_runner_denial_section_regression_export',
  'report_contract_doc_page_release_post_action_dispatch_completion_denial_section_regression_export',
  'report_manifest_drift_regression_export',
  'report_latest_recovery_regression_export',
  'report_bootstrap_seed_regression_export',
  'report_gate_clean_rerun_regression_export',
  'report_clean_gate_idempotence_regression_export',
  'report_final_settlement_regression_export',
  'report_post_final_drift_regression_export',
  'report_closeout_drift_classification_regression_export',
  'report_closeout_command_inventory_regression_export',
  'report_runner_contract_regression_export',
  'runtime_dry_run_harness_export',
  'post_action_evidence_matrix_export',
  'post_action_audit_bundle_matrix_export',
  'post_action_audit_archive_matrix_export',
  'post_action_replay_guard_matrix_export',
  'post_action_dispatch_envelope_matrix_export',
  'post_action_dispatch_completion_matrix_export',
  'post_action_reconciliation_matrix_export',
  'post_action_runtime_status_export',
  'report_freshness_export_pre_tooling',
  'integration_gate_tooling_export',
  'selftest',
  'selftest_lanes',
  'integration_dependency_audit_strict',
  'report_contract_doc_page_release_post_action_receipt_denial_section_regression_export_final',
  'report_contract_doc_page_release_post_action_audit_denial_section_regression_export_final',
  'integration_gate_tooling_export_final',
  'report_schema_contract_export_final',
  'report_hash_stability_regression_export_final',
  'report_artifact_reproducibility_export_final',
  'report_output_pairing_export_final',
  'report_freshness_export',
]);

const REQUIRED_STEP_ARGS = Object.freeze({
  syntax_integration_gate_sequence_regression: Object.freeze(['--check', 'src/integration-gate-sequence-regression.mjs']),
  syntax_integration_gate_sequence_regression_export: Object.freeze(['--check', 'src/export-integration-gate-sequence-regression.mjs']),
  integration_gate_sequence_regression_export: Object.freeze(['src/export-integration-gate-sequence-regression.mjs', '--strict']),
  syntax_report_inventory_consistency: Object.freeze(['--check', 'src/report-inventory-consistency.mjs']),
  syntax_report_inventory_consistency_export: Object.freeze(['--check', 'src/export-report-inventory-consistency.mjs']),
  report_inventory_consistency_export: Object.freeze(['src/export-report-inventory-consistency.mjs', '--strict']),
  syntax_report_schema_contract: Object.freeze(['--check', 'src/report-schema-contract.mjs']),
  syntax_report_schema_contract_export: Object.freeze(['--check', 'src/export-report-schema-contract.mjs']),
  report_schema_contract_export: Object.freeze(['src/export-report-schema-contract.mjs', '--strict']),
  report_schema_contract_export_final: Object.freeze(['src/export-report-schema-contract.mjs', '--strict']),
  syntax_report_lineage_topology: Object.freeze(['--check', 'src/report-lineage-topology.mjs']),
  syntax_report_lineage_topology_export: Object.freeze(['--check', 'src/export-report-lineage-topology.mjs']),
  report_lineage_topology_export: Object.freeze(['src/export-report-lineage-topology.mjs', '--strict']),
  syntax_report_hash_stability_regression: Object.freeze(['--check', 'src/report-hash-stability-regression.mjs']),
  syntax_report_hash_stability_regression_export: Object.freeze(['--check', 'src/export-report-hash-stability-regression.mjs']),
  report_hash_stability_regression_export: Object.freeze(['src/export-report-hash-stability-regression.mjs', '--strict']),
  report_hash_stability_regression_export_final: Object.freeze(['src/export-report-hash-stability-regression.mjs', '--strict']),
  syntax_report_output_pairing: Object.freeze(['--check', 'src/report-output-pairing.mjs']),
  syntax_report_output_pairing_export: Object.freeze(['--check', 'src/export-report-output-pairing.mjs']),
  report_output_pairing_export: Object.freeze(['src/export-report-output-pairing.mjs', '--strict']),
  report_output_pairing_export_final: Object.freeze(['src/export-report-output-pairing.mjs', '--strict']),
  syntax_report_artifact_reproducibility: Object.freeze(['--check', 'src/report-artifact-reproducibility.mjs']),
  syntax_report_artifact_reproducibility_export: Object.freeze(['--check', 'src/export-report-artifact-reproducibility.mjs']),
  report_artifact_reproducibility_export: Object.freeze(['src/export-report-artifact-reproducibility.mjs', '--strict']),
  report_artifact_reproducibility_export_final: Object.freeze(['src/export-report-artifact-reproducibility.mjs', '--strict']),
  syntax_report_self_reference_boundary_regression: Object.freeze(['--check', 'src/report-self-reference-boundary-regression.mjs']),
  syntax_report_self_reference_boundary_regression_export: Object.freeze(['--check', 'src/export-report-self-reference-boundary-regression.mjs']),
  report_self_reference_boundary_regression_export: Object.freeze(['src/export-report-self-reference-boundary-regression.mjs', '--strict']),
  syntax_report_contract_manifest: Object.freeze(['--check', 'src/report-contract-manifest.mjs']),
  syntax_report_contract_manifest_export: Object.freeze(['--check', 'src/export-report-contract-manifest.mjs']),
  report_contract_manifest_export: Object.freeze(['src/export-report-contract-manifest.mjs', '--strict']),
  syntax_report_contract_required_coverage_regression: Object.freeze(['--check', 'src/report-contract-required-coverage-regression.mjs']),
  syntax_report_contract_required_coverage_regression_export: Object.freeze(['--check', 'src/export-report-contract-required-coverage-regression.mjs']),
  report_contract_required_coverage_regression_export: Object.freeze(['src/export-report-contract-required-coverage-regression.mjs', '--strict']),
  syntax_report_contract_doc_coverage_regression: Object.freeze(['--check', 'src/report-contract-doc-coverage-regression.mjs']),
  syntax_report_contract_doc_coverage_regression_export: Object.freeze(['--check', 'src/export-report-contract-doc-coverage-regression.mjs']),
  report_contract_doc_coverage_regression_export: Object.freeze(['src/export-report-contract-doc-coverage-regression.mjs', '--strict']),
  syntax_report_contract_syntax_coverage_regression: Object.freeze(['--check', 'src/report-contract-syntax-coverage-regression.mjs']),
  syntax_report_contract_syntax_coverage_regression_export: Object.freeze(['--check', 'src/export-report-contract-syntax-coverage-regression.mjs']),
  report_contract_syntax_coverage_regression_export: Object.freeze(['src/export-report-contract-syntax-coverage-regression.mjs', '--strict']),
  syntax_report_contract_source_derivation_regression: Object.freeze(['--check', 'src/report-contract-source-derivation-regression.mjs']),
  syntax_report_contract_source_derivation_regression_export: Object.freeze(['--check', 'src/export-report-contract-source-derivation-regression.mjs']),
  report_contract_source_derivation_regression_export: Object.freeze(['src/export-report-contract-source-derivation-regression.mjs', '--strict']),
  syntax_report_contract_summary_key_regression: Object.freeze(['--check', 'src/report-contract-summary-key-regression.mjs']),
  syntax_report_contract_summary_key_regression_export: Object.freeze(['--check', 'src/export-report-contract-summary-key-regression.mjs']),
  report_contract_summary_key_regression_export: Object.freeze(['src/export-report-contract-summary-key-regression.mjs', '--strict']),
  syntax_report_contract_audit_forwarding_regression: Object.freeze(['--check', 'src/report-contract-audit-forwarding-regression.mjs']),
  syntax_report_contract_audit_forwarding_regression_export: Object.freeze(['--check', 'src/export-report-contract-audit-forwarding-regression.mjs']),
  report_contract_audit_forwarding_regression_export: Object.freeze(['src/export-report-contract-audit-forwarding-regression.mjs', '--strict']),
  syntax_report_contract_checkpoint_binding_shape_regression: Object.freeze(['--check', 'src/report-contract-checkpoint-binding-shape-regression.mjs']),
  syntax_report_contract_checkpoint_binding_shape_regression_export: Object.freeze(['--check', 'src/export-report-contract-checkpoint-binding-shape-regression.mjs']),
  report_contract_checkpoint_binding_shape_regression_export: Object.freeze(['src/export-report-contract-checkpoint-binding-shape-regression.mjs', '--strict']),
  syntax_report_contract_gate_summary_shape_regression: Object.freeze(['--check', 'src/report-contract-gate-summary-shape-regression.mjs']),
  syntax_report_contract_gate_summary_shape_regression_export: Object.freeze(['--check', 'src/export-report-contract-gate-summary-shape-regression.mjs']),
  report_contract_gate_summary_shape_regression_export: Object.freeze(['src/export-report-contract-gate-summary-shape-regression.mjs', '--strict']),
  syntax_report_contract_exporter_stdout_shape_regression: Object.freeze(['--check', 'src/report-contract-exporter-stdout-shape-regression.mjs']),
  syntax_report_contract_exporter_stdout_shape_regression_export: Object.freeze(['--check', 'src/export-report-contract-exporter-stdout-shape-regression.mjs']),
  report_contract_exporter_stdout_shape_regression_export: Object.freeze(['src/export-report-contract-exporter-stdout-shape-regression.mjs', '--strict']),
  syntax_report_contract_safety_flag_regression: Object.freeze(['--check', 'src/report-contract-safety-flag-regression.mjs']),
  syntax_report_contract_safety_flag_regression_export: Object.freeze(['--check', 'src/export-report-contract-safety-flag-regression.mjs']),
  report_contract_safety_flag_regression_export: Object.freeze(['src/export-report-contract-safety-flag-regression.mjs', '--strict']),
  syntax_report_contract_artifact_binding_regression: Object.freeze(['--check', 'src/report-contract-artifact-binding-regression.mjs']),
  syntax_report_contract_artifact_binding_regression_export: Object.freeze(['--check', 'src/export-report-contract-artifact-binding-regression.mjs']),
  report_contract_artifact_binding_regression_export: Object.freeze(['src/export-report-contract-artifact-binding-regression.mjs', '--strict']),
  syntax_report_contract_doc_index_anchor_regression: Object.freeze(['--check', 'src/report-contract-doc-index-anchor-regression.mjs']),
  syntax_report_contract_doc_index_anchor_regression_export: Object.freeze(['--check', 'src/export-report-contract-doc-index-anchor-regression.mjs']),
  report_contract_doc_index_anchor_regression_export: Object.freeze(['src/export-report-contract-doc-index-anchor-regression.mjs', '--strict']),
  syntax_report_contract_doc_page_latest_detail_regression: Object.freeze(['--check', 'src/report-contract-doc-page-latest-detail-regression.mjs']),
  syntax_report_contract_doc_page_latest_detail_regression_export: Object.freeze(['--check', 'src/export-report-contract-doc-page-latest-detail-regression.mjs']),
  report_contract_doc_page_latest_detail_regression_export: Object.freeze(['src/export-report-contract-doc-page-latest-detail-regression.mjs', '--strict']),
  syntax_report_contract_doc_page_command_section_regression: Object.freeze(['--check', 'src/report-contract-doc-page-command-section-regression.mjs']),
  syntax_report_contract_doc_page_command_section_regression_export: Object.freeze(['--check', 'src/export-report-contract-doc-page-command-section-regression.mjs']),
  report_contract_doc_page_command_section_regression_export: Object.freeze(['src/export-report-contract-doc-page-command-section-regression.mjs', '--strict']),
  syntax_report_contract_doc_page_safety_section_detail_regression: Object.freeze(['--check', 'src/report-contract-doc-page-safety-section-detail-regression.mjs']),
  syntax_report_contract_doc_page_safety_section_detail_regression_export: Object.freeze(['--check', 'src/export-report-contract-doc-page-safety-section-detail-regression.mjs']),
  report_contract_doc_page_safety_section_detail_regression_export: Object.freeze(['src/export-report-contract-doc-page-safety-section-detail-regression.mjs', '--strict']),
  syntax_report_contract_doc_page_strict_gate_section_regression: Object.freeze(['--check', 'src/report-contract-doc-page-strict-gate-section-regression.mjs']),
  syntax_report_contract_doc_page_strict_gate_section_regression_export: Object.freeze(['--check', 'src/export-report-contract-doc-page-strict-gate-section-regression.mjs']),
  report_contract_doc_page_strict_gate_section_regression_export: Object.freeze(['src/export-report-contract-doc-page-strict-gate-section-regression.mjs', '--strict']),
  syntax_report_contract_doc_page_output_section_regression: Object.freeze(['--check', 'src/report-contract-doc-page-output-section-regression.mjs']),
  syntax_report_contract_doc_page_output_section_regression_export: Object.freeze(['--check', 'src/export-report-contract-doc-page-output-section-regression.mjs']),
  report_contract_doc_page_output_section_regression_export: Object.freeze(['src/export-report-contract-doc-page-output-section-regression.mjs', '--strict']),
  syntax_report_contract_doc_page_cross_report_section_regression: Object.freeze(['--check', 'src/report-contract-doc-page-cross-report-section-regression.mjs']),
  syntax_report_contract_doc_page_cross_report_section_regression_export: Object.freeze(['--check', 'src/export-report-contract-doc-page-cross-report-section-regression.mjs']),
  report_contract_doc_page_cross_report_section_regression_export: Object.freeze(['src/export-report-contract-doc-page-cross-report-section-regression.mjs', '--strict']),
  syntax_report_contract_doc_page_closeout_section_regression: Object.freeze(['--check', 'src/report-contract-doc-page-closeout-section-regression.mjs']),
  syntax_report_contract_doc_page_closeout_section_regression_export: Object.freeze(['--check', 'src/export-report-contract-doc-page-closeout-section-regression.mjs']),
  report_contract_doc_page_closeout_section_regression_export: Object.freeze(['src/export-report-contract-doc-page-closeout-section-regression.mjs', '--strict']),
  syntax_report_contract_doc_page_post_gate_writer_section_regression: Object.freeze(['--check', 'src/report-contract-doc-page-post-gate-writer-section-regression.mjs']),
  syntax_report_contract_doc_page_post_gate_writer_section_regression_export: Object.freeze(['--check', 'src/export-report-contract-doc-page-post-gate-writer-section-regression.mjs']),
  report_contract_doc_page_post_gate_writer_section_regression_export: Object.freeze(['src/export-report-contract-doc-page-post-gate-writer-section-regression.mjs', '--strict']),
  syntax_report_contract_doc_page_retention_section_regression: Object.freeze(['--check', 'src/report-contract-doc-page-retention-section-regression.mjs']),
  syntax_report_contract_doc_page_retention_section_regression_export: Object.freeze(['--check', 'src/export-report-contract-doc-page-retention-section-regression.mjs']),
  report_contract_doc_page_retention_section_regression_export: Object.freeze(['src/export-report-contract-doc-page-retention-section-regression.mjs', '--strict']),
  syntax_report_contract_doc_page_freshness_hash_section_regression: Object.freeze(['--check', 'src/report-contract-doc-page-freshness-hash-section-regression.mjs']),
  syntax_report_contract_doc_page_freshness_hash_section_regression_export: Object.freeze(['--check', 'src/export-report-contract-doc-page-freshness-hash-section-regression.mjs']),
  report_contract_doc_page_freshness_hash_section_regression_export: Object.freeze(['src/export-report-contract-doc-page-freshness-hash-section-regression.mjs', '--strict']),
  syntax_report_contract_doc_page_checkpoint_hash_section_regression: Object.freeze(['--check', 'src/report-contract-doc-page-checkpoint-hash-section-regression.mjs']),
  syntax_report_contract_doc_page_checkpoint_hash_section_regression_export: Object.freeze(['--check', 'src/export-report-contract-doc-page-checkpoint-hash-section-regression.mjs']),
  report_contract_doc_page_checkpoint_hash_section_regression_export: Object.freeze(['src/export-report-contract-doc-page-checkpoint-hash-section-regression.mjs', '--strict']),
  syntax_report_contract_doc_page_bootstrap_seed_section_regression: Object.freeze(['--check', 'src/report-contract-doc-page-bootstrap-seed-section-regression.mjs']),
  syntax_report_contract_doc_page_bootstrap_seed_section_regression_export: Object.freeze(['--check', 'src/export-report-contract-doc-page-bootstrap-seed-section-regression.mjs']),
  report_contract_doc_page_bootstrap_seed_section_regression_export: Object.freeze(['src/export-report-contract-doc-page-bootstrap-seed-section-regression.mjs', '--strict']),
  syntax_report_contract_doc_page_clean_rerun_section_regression: Object.freeze(['--check', 'src/report-contract-doc-page-clean-rerun-section-regression.mjs']),
  syntax_report_contract_doc_page_clean_rerun_section_regression_export: Object.freeze(['--check', 'src/export-report-contract-doc-page-clean-rerun-section-regression.mjs']),
  report_contract_doc_page_clean_rerun_section_regression_export: Object.freeze(['src/export-report-contract-doc-page-clean-rerun-section-regression.mjs', '--strict']),
  syntax_report_contract_doc_page_final_settlement_section_regression: Object.freeze(['--check', 'src/report-contract-doc-page-final-settlement-section-regression.mjs']),
  syntax_report_contract_doc_page_final_settlement_section_regression_export: Object.freeze(['--check', 'src/export-report-contract-doc-page-final-settlement-section-regression.mjs']),
  report_contract_doc_page_final_settlement_section_regression_export: Object.freeze(['src/export-report-contract-doc-page-final-settlement-section-regression.mjs', '--strict']),
  syntax_report_contract_doc_page_closeout_index_section_regression: Object.freeze(['--check', 'src/report-contract-doc-page-closeout-index-section-regression.mjs']),
  syntax_report_contract_doc_page_closeout_index_section_regression_export: Object.freeze(['--check', 'src/export-report-contract-doc-page-closeout-index-section-regression.mjs']),
  report_contract_doc_page_closeout_index_section_regression_export: Object.freeze(['src/export-report-contract-doc-page-closeout-index-section-regression.mjs', '--strict']),
  syntax_report_contract_doc_page_closeout_evidence_section_regression: Object.freeze(['--check', 'src/report-contract-doc-page-closeout-evidence-section-regression.mjs']),
  syntax_report_contract_doc_page_closeout_evidence_section_regression_export: Object.freeze(['--check', 'src/export-report-contract-doc-page-closeout-evidence-section-regression.mjs']),
  report_contract_doc_page_closeout_evidence_section_regression_export: Object.freeze(['src/export-report-contract-doc-page-closeout-evidence-section-regression.mjs', '--strict']),
  syntax_report_contract_doc_page_closeout_ledger_section_regression: Object.freeze(['--check', 'src/report-contract-doc-page-closeout-ledger-section-regression.mjs']),
  syntax_report_contract_doc_page_closeout_ledger_section_regression_export: Object.freeze(['--check', 'src/export-report-contract-doc-page-closeout-ledger-section-regression.mjs']),
  report_contract_doc_page_closeout_ledger_section_regression_export: Object.freeze(['src/export-report-contract-doc-page-closeout-ledger-section-regression.mjs', '--strict']),
  syntax_report_contract_doc_page_closeout_retention_proof_section_regression: Object.freeze(['--check', 'src/report-contract-doc-page-closeout-retention-proof-section-regression.mjs']),
  syntax_report_contract_doc_page_closeout_retention_proof_section_regression_export: Object.freeze(['--check', 'src/export-report-contract-doc-page-closeout-retention-proof-section-regression.mjs']),
  report_contract_doc_page_closeout_retention_proof_section_regression_export: Object.freeze(['src/export-report-contract-doc-page-closeout-retention-proof-section-regression.mjs', '--strict']),
  syntax_report_contract_doc_page_closeout_probe_bundle_section_regression: Object.freeze(['--check', 'src/report-contract-doc-page-closeout-probe-bundle-section-regression.mjs']),
  syntax_report_contract_doc_page_closeout_probe_bundle_section_regression_export: Object.freeze(['--check', 'src/export-report-contract-doc-page-closeout-probe-bundle-section-regression.mjs']),
  report_contract_doc_page_closeout_probe_bundle_section_regression_export: Object.freeze(['src/export-report-contract-doc-page-closeout-probe-bundle-section-regression.mjs', '--strict']),
  syntax_report_contract_doc_page_closeout_signoff_section_regression: Object.freeze(['--check', 'src/report-contract-doc-page-closeout-signoff-section-regression.mjs']),
  syntax_report_contract_doc_page_closeout_signoff_section_regression_export: Object.freeze(['--check', 'src/export-report-contract-doc-page-closeout-signoff-section-regression.mjs']),
  report_contract_doc_page_closeout_signoff_section_regression_export: Object.freeze(['src/export-report-contract-doc-page-closeout-signoff-section-regression.mjs', '--strict']),
  syntax_report_contract_doc_page_closeout_release_manifest_section_regression: Object.freeze(['--check', 'src/report-contract-doc-page-closeout-release-manifest-section-regression.mjs']),
  syntax_report_contract_doc_page_closeout_release_manifest_section_regression_export: Object.freeze(['--check', 'src/export-report-contract-doc-page-closeout-release-manifest-section-regression.mjs']),
  report_contract_doc_page_closeout_release_manifest_section_regression_export: Object.freeze(['src/export-report-contract-doc-page-closeout-release-manifest-section-regression.mjs', '--strict']),
  syntax_report_contract_doc_page_release_archive_index_section_regression: Object.freeze(['--check', 'src/report-contract-doc-page-release-archive-index-section-regression.mjs']),
  syntax_report_contract_doc_page_release_archive_index_section_regression_export: Object.freeze(['--check', 'src/export-report-contract-doc-page-release-archive-index-section-regression.mjs']),
  report_contract_doc_page_release_archive_index_section_regression_export: Object.freeze(['src/export-report-contract-doc-page-release-archive-index-section-regression.mjs', '--strict']),
  syntax_report_contract_doc_page_release_handoff_ledger_section_regression: Object.freeze(['--check', 'src/report-contract-doc-page-release-handoff-ledger-section-regression.mjs']),
  syntax_report_contract_doc_page_release_handoff_ledger_section_regression_export: Object.freeze(['--check', 'src/export-report-contract-doc-page-release-handoff-ledger-section-regression.mjs']),
  report_contract_doc_page_release_handoff_ledger_section_regression_export: Object.freeze(['src/export-report-contract-doc-page-release-handoff-ledger-section-regression.mjs', '--strict']),
  syntax_report_contract_doc_page_release_delivery_readiness_section_regression: Object.freeze(['--check', 'src/report-contract-doc-page-release-delivery-readiness-section-regression.mjs']),
  syntax_report_contract_doc_page_release_delivery_readiness_section_regression_export: Object.freeze(['--check', 'src/export-report-contract-doc-page-release-delivery-readiness-section-regression.mjs']),
  report_contract_doc_page_release_delivery_readiness_section_regression_export: Object.freeze(['src/export-report-contract-doc-page-release-delivery-readiness-section-regression.mjs', '--strict']),
  syntax_report_contract_doc_page_release_execution_denial_section_regression: Object.freeze(['--check', 'src/report-contract-doc-page-release-execution-denial-section-regression.mjs']),
  syntax_report_contract_doc_page_release_execution_denial_section_regression_export: Object.freeze(['--check', 'src/export-report-contract-doc-page-release-execution-denial-section-regression.mjs']),
  report_contract_doc_page_release_execution_denial_section_regression_export: Object.freeze(['src/export-report-contract-doc-page-release-execution-denial-section-regression.mjs', '--strict']),
  syntax_report_contract_doc_page_release_operator_approval_section_regression: Object.freeze(['--check', 'src/report-contract-doc-page-release-operator-approval-section-regression.mjs']),
  syntax_report_contract_doc_page_release_operator_approval_section_regression_export: Object.freeze(['--check', 'src/export-report-contract-doc-page-release-operator-approval-section-regression.mjs']),
  report_contract_doc_page_release_operator_approval_section_regression_export: Object.freeze(['src/export-report-contract-doc-page-release-operator-approval-section-regression.mjs', '--strict']),
  syntax_report_contract_doc_page_release_approval_ledger_section_regression: Object.freeze(['--check', 'src/report-contract-doc-page-release-approval-ledger-section-regression.mjs']),
  syntax_report_contract_doc_page_release_approval_ledger_section_regression_export: Object.freeze(['--check', 'src/export-report-contract-doc-page-release-approval-ledger-section-regression.mjs']),
  report_contract_doc_page_release_approval_ledger_section_regression_export: Object.freeze(['src/export-report-contract-doc-page-release-approval-ledger-section-regression.mjs', '--strict']),
  syntax_report_contract_doc_page_release_action_queue_section_regression: Object.freeze(['--check', 'src/report-contract-doc-page-release-action-queue-section-regression.mjs']),
  syntax_report_contract_doc_page_release_action_queue_section_regression_export: Object.freeze(['--check', 'src/export-report-contract-doc-page-release-action-queue-section-regression.mjs']),
  report_contract_doc_page_release_action_queue_section_regression_export: Object.freeze(['src/export-report-contract-doc-page-release-action-queue-section-regression.mjs', '--strict']),
  syntax_report_contract_doc_page_release_runner_dispatch_denial_section_regression: Object.freeze(['--check', 'src/report-contract-doc-page-release-runner-dispatch-denial-section-regression.mjs']),
  syntax_report_contract_doc_page_release_runner_dispatch_denial_section_regression_export: Object.freeze(['--check', 'src/export-report-contract-doc-page-release-runner-dispatch-denial-section-regression.mjs']),
  report_contract_doc_page_release_runner_dispatch_denial_section_regression_export: Object.freeze(['src/export-report-contract-doc-page-release-runner-dispatch-denial-section-regression.mjs', '--strict']),
  syntax_report_contract_doc_page_release_live_action_preflight_section_regression: Object.freeze(['--check', 'src/report-contract-doc-page-release-live-action-preflight-section-regression.mjs']),
  syntax_report_contract_doc_page_release_live_action_preflight_section_regression_export: Object.freeze(['--check', 'src/export-report-contract-doc-page-release-live-action-preflight-section-regression.mjs']),
  report_contract_doc_page_release_live_action_preflight_section_regression_export: Object.freeze(['src/export-report-contract-doc-page-release-live-action-preflight-section-regression.mjs', '--strict']),
  syntax_report_contract_doc_page_release_execution_intent_capture_section_regression: Object.freeze(['--check', 'src/report-contract-doc-page-release-execution-intent-capture-section-regression.mjs']),
  syntax_report_contract_doc_page_release_execution_intent_capture_section_regression_export: Object.freeze(['--check', 'src/export-report-contract-doc-page-release-execution-intent-capture-section-regression.mjs']),
  report_contract_doc_page_release_execution_intent_capture_section_regression_export: Object.freeze(['src/export-report-contract-doc-page-release-execution-intent-capture-section-regression.mjs', '--strict']),
  syntax_report_contract_doc_page_release_execution_approval_boundary_section_regression: Object.freeze(['--check', 'src/report-contract-doc-page-release-execution-approval-boundary-section-regression.mjs']),
  syntax_report_contract_doc_page_release_execution_approval_boundary_section_regression_export: Object.freeze(['--check', 'src/export-report-contract-doc-page-release-execution-approval-boundary-section-regression.mjs']),
  report_contract_doc_page_release_execution_approval_boundary_section_regression_export: Object.freeze(['src/export-report-contract-doc-page-release-execution-approval-boundary-section-regression.mjs', '--strict']),
  syntax_report_contract_doc_page_release_runner_execution_gate_section_regression: Object.freeze(['--check', 'src/report-contract-doc-page-release-runner-execution-gate-section-regression.mjs']),
  syntax_report_contract_doc_page_release_runner_execution_gate_section_regression_export: Object.freeze(['--check', 'src/export-report-contract-doc-page-release-runner-execution-gate-section-regression.mjs']),
  report_contract_doc_page_release_runner_execution_gate_section_regression_export: Object.freeze(['src/export-report-contract-doc-page-release-runner-execution-gate-section-regression.mjs', '--strict']),
  syntax_report_contract_doc_page_release_dispatch_implementation_denial_section_regression: Object.freeze(['--check', 'src/report-contract-doc-page-release-dispatch-implementation-denial-section-regression.mjs']),
  syntax_report_contract_doc_page_release_dispatch_implementation_denial_section_regression_export: Object.freeze(['--check', 'src/export-report-contract-doc-page-release-dispatch-implementation-denial-section-regression.mjs']),
  report_contract_doc_page_release_dispatch_implementation_denial_section_regression_export: Object.freeze(['src/export-report-contract-doc-page-release-dispatch-implementation-denial-section-regression.mjs', '--strict']),
  syntax_report_contract_doc_page_release_platform_state_snapshot_denial_section_regression: Object.freeze(['--check', 'src/report-contract-doc-page-release-platform-state-snapshot-denial-section-regression.mjs']),
  syntax_report_contract_doc_page_release_platform_state_snapshot_denial_section_regression_export: Object.freeze(['--check', 'src/export-report-contract-doc-page-release-platform-state-snapshot-denial-section-regression.mjs']),
  report_contract_doc_page_release_platform_state_snapshot_denial_section_regression_export: Object.freeze(['src/export-report-contract-doc-page-release-platform-state-snapshot-denial-section-regression.mjs', '--strict']),
  syntax_report_contract_doc_page_release_dry_run_replay_denial_section_regression: Object.freeze(['--check', 'src/report-contract-doc-page-release-dry-run-replay-denial-section-regression.mjs']),
  syntax_report_contract_doc_page_release_dry_run_replay_denial_section_regression_export: Object.freeze(['--check', 'src/export-report-contract-doc-page-release-dry-run-replay-denial-section-regression.mjs']),
  report_contract_doc_page_release_dry_run_replay_denial_section_regression_export: Object.freeze(['src/export-report-contract-doc-page-release-dry-run-replay-denial-section-regression.mjs', '--strict']),
  syntax_report_contract_doc_page_release_proof_bundle_denial_section_regression: Object.freeze(['--check', 'src/report-contract-doc-page-release-proof-bundle-denial-section-regression.mjs']),
  syntax_report_contract_doc_page_release_proof_bundle_denial_section_regression_export: Object.freeze(['--check', 'src/export-report-contract-doc-page-release-proof-bundle-denial-section-regression.mjs']),
  report_contract_doc_page_release_proof_bundle_denial_section_regression_export: Object.freeze(['src/export-report-contract-doc-page-release-proof-bundle-denial-section-regression.mjs', '--strict']),
  syntax_report_contract_doc_page_release_ledger_denial_section_regression: Object.freeze(['--check', 'src/report-contract-doc-page-release-ledger-denial-section-regression.mjs']),
  syntax_report_contract_doc_page_release_ledger_denial_section_regression_export: Object.freeze(['--check', 'src/export-report-contract-doc-page-release-ledger-denial-section-regression.mjs']),
  report_contract_doc_page_release_ledger_denial_section_regression_export: Object.freeze(['src/export-report-contract-doc-page-release-ledger-denial-section-regression.mjs', '--strict']),
  syntax_report_contract_doc_page_release_audit_evidence_denial_section_regression: Object.freeze(['--check', 'src/report-contract-doc-page-release-audit-evidence-denial-section-regression.mjs']),
  syntax_report_contract_doc_page_release_audit_evidence_denial_section_regression_export: Object.freeze(['--check', 'src/export-report-contract-doc-page-release-audit-evidence-denial-section-regression.mjs']),
  report_contract_doc_page_release_audit_evidence_denial_section_regression_export: Object.freeze(['src/export-report-contract-doc-page-release-audit-evidence-denial-section-regression.mjs', '--strict']),
  syntax_report_contract_doc_page_release_receipt_evidence_denial_section_regression: Object.freeze(['--check', 'src/report-contract-doc-page-release-receipt-evidence-denial-section-regression.mjs']),
  syntax_report_contract_doc_page_release_receipt_evidence_denial_section_regression_export: Object.freeze(['--check', 'src/export-report-contract-doc-page-release-receipt-evidence-denial-section-regression.mjs']),
  report_contract_doc_page_release_receipt_evidence_denial_section_regression_export: Object.freeze(['src/export-report-contract-doc-page-release-receipt-evidence-denial-section-regression.mjs', '--strict']),
  syntax_report_contract_doc_page_release_post_action_receipt_denial_section_regression: Object.freeze(['--check', 'src/report-contract-doc-page-release-post-action-receipt-denial-section-regression.mjs']),
  syntax_report_contract_doc_page_release_post_action_receipt_denial_section_regression_export: Object.freeze(['--check', 'src/export-report-contract-doc-page-release-post-action-receipt-denial-section-regression.mjs']),
  report_contract_doc_page_release_post_action_receipt_denial_section_regression_export: Object.freeze(['src/export-report-contract-doc-page-release-post-action-receipt-denial-section-regression.mjs', '--strict']),
  report_contract_doc_page_release_post_action_receipt_denial_section_regression_export_final: Object.freeze(['src/export-report-contract-doc-page-release-post-action-receipt-denial-section-regression.mjs', '--strict']),
  syntax_report_contract_doc_page_release_post_action_audit_denial_section_regression: Object.freeze(['--check', 'src/report-contract-doc-page-release-post-action-audit-denial-section-regression.mjs']),
  syntax_report_contract_doc_page_release_post_action_audit_denial_section_regression_export: Object.freeze(['--check', 'src/export-report-contract-doc-page-release-post-action-audit-denial-section-regression.mjs']),
  report_contract_doc_page_release_post_action_audit_denial_section_regression_export: Object.freeze(['src/export-report-contract-doc-page-release-post-action-audit-denial-section-regression.mjs', '--strict']),
  report_contract_doc_page_release_post_action_audit_denial_section_regression_export_final: Object.freeze(['src/export-report-contract-doc-page-release-post-action-audit-denial-section-regression.mjs', '--strict']),
  syntax_report_contract_doc_page_release_post_action_reconciliation_denial_section_regression: Object.freeze(['--check', 'src/report-contract-doc-page-release-post-action-reconciliation-denial-section-regression.mjs']),
  syntax_report_contract_doc_page_release_post_action_reconciliation_denial_section_regression_export: Object.freeze(['--check', 'src/export-report-contract-doc-page-release-post-action-reconciliation-denial-section-regression.mjs']),
  report_contract_doc_page_release_post_action_reconciliation_denial_section_regression_export: Object.freeze(['src/export-report-contract-doc-page-release-post-action-reconciliation-denial-section-regression.mjs', '--strict']),
  syntax_report_contract_doc_page_release_post_action_settlement_denial_section_regression: Object.freeze(['--check', 'src/report-contract-doc-page-release-post-action-settlement-denial-section-regression.mjs']),
  syntax_report_contract_doc_page_release_post_action_settlement_denial_section_regression_export: Object.freeze(['--check', 'src/export-report-contract-doc-page-release-post-action-settlement-denial-section-regression.mjs']),
  report_contract_doc_page_release_post_action_settlement_denial_section_regression_export: Object.freeze(['src/export-report-contract-doc-page-release-post-action-settlement-denial-section-regression.mjs', '--strict']),
  syntax_report_contract_doc_page_release_post_action_acceptance_denial_section_regression: Object.freeze(['--check', 'src/report-contract-doc-page-release-post-action-acceptance-denial-section-regression.mjs']),
  syntax_report_contract_doc_page_release_post_action_acceptance_denial_section_regression_export: Object.freeze(['--check', 'src/export-report-contract-doc-page-release-post-action-acceptance-denial-section-regression.mjs']),
  report_contract_doc_page_release_post_action_acceptance_denial_section_regression_export: Object.freeze(['src/export-report-contract-doc-page-release-post-action-acceptance-denial-section-regression.mjs', '--strict']),
  syntax_report_contract_doc_page_release_post_action_payment_denial_section_regression: Object.freeze(['--check', 'src/report-contract-doc-page-release-post-action-payment-denial-section-regression.mjs']),
  syntax_report_contract_doc_page_release_post_action_payment_denial_section_regression_export: Object.freeze(['--check', 'src/export-report-contract-doc-page-release-post-action-payment-denial-section-regression.mjs']),
  report_contract_doc_page_release_post_action_payment_denial_section_regression_export: Object.freeze(['src/export-report-contract-doc-page-release-post-action-payment-denial-section-regression.mjs', '--strict']),
  syntax_report_contract_doc_page_release_post_action_deployment_denial_section_regression: Object.freeze(['--check', 'src/report-contract-doc-page-release-post-action-deployment-denial-section-regression.mjs']),
  syntax_report_contract_doc_page_release_post_action_deployment_denial_section_regression_export: Object.freeze(['--check', 'src/export-report-contract-doc-page-release-post-action-deployment-denial-section-regression.mjs']),
  report_contract_doc_page_release_post_action_deployment_denial_section_regression_export: Object.freeze(['src/export-report-contract-doc-page-release-post-action-deployment-denial-section-regression.mjs', '--strict']),
  syntax_report_contract_doc_page_release_post_action_provider_spend_denial_section_regression: Object.freeze(['--check', 'src/report-contract-doc-page-release-post-action-provider-spend-denial-section-regression.mjs']),
  syntax_report_contract_doc_page_release_post_action_provider_spend_denial_section_regression_export: Object.freeze(['--check', 'src/export-report-contract-doc-page-release-post-action-provider-spend-denial-section-regression.mjs']),
  report_contract_doc_page_release_post_action_provider_spend_denial_section_regression_export: Object.freeze(['src/export-report-contract-doc-page-release-post-action-provider-spend-denial-section-regression.mjs', '--strict']),
  syntax_report_contract_doc_page_release_post_action_state_transition_denial_section_regression: Object.freeze(['--check', 'src/report-contract-doc-page-release-post-action-state-transition-denial-section-regression.mjs']),
  syntax_report_contract_doc_page_release_post_action_state_transition_denial_section_regression_export: Object.freeze(['--check', 'src/export-report-contract-doc-page-release-post-action-state-transition-denial-section-regression.mjs']),
  report_contract_doc_page_release_post_action_state_transition_denial_section_regression_export: Object.freeze(['src/export-report-contract-doc-page-release-post-action-state-transition-denial-section-regression.mjs', '--strict']),
  syntax_report_contract_doc_page_release_post_action_queue_consumption_denial_section_regression: Object.freeze(['--check', 'src/report-contract-doc-page-release-post-action-queue-consumption-denial-section-regression.mjs']),
  syntax_report_contract_doc_page_release_post_action_queue_consumption_denial_section_regression_export: Object.freeze(['--check', 'src/export-report-contract-doc-page-release-post-action-queue-consumption-denial-section-regression.mjs']),
  report_contract_doc_page_release_post_action_queue_consumption_denial_section_regression_export: Object.freeze(['src/export-report-contract-doc-page-release-post-action-queue-consumption-denial-section-regression.mjs', '--strict']),
  syntax_report_contract_doc_page_release_post_action_background_runner_denial_section_regression: Object.freeze(['--check', 'src/report-contract-doc-page-release-post-action-background-runner-denial-section-regression.mjs']),
  syntax_report_contract_doc_page_release_post_action_background_runner_denial_section_regression_export: Object.freeze(['--check', 'src/export-report-contract-doc-page-release-post-action-background-runner-denial-section-regression.mjs']),
  report_contract_doc_page_release_post_action_background_runner_denial_section_regression_export: Object.freeze(['src/export-report-contract-doc-page-release-post-action-background-runner-denial-section-regression.mjs', '--strict']),
  syntax_report_contract_doc_page_release_post_action_dispatch_completion_denial_section_regression: Object.freeze(['--check', 'src/report-contract-doc-page-release-post-action-dispatch-completion-denial-section-regression.mjs']),
  syntax_report_contract_doc_page_release_post_action_dispatch_completion_denial_section_regression_export: Object.freeze(['--check', 'src/export-report-contract-doc-page-release-post-action-dispatch-completion-denial-section-regression.mjs']),
  report_contract_doc_page_release_post_action_dispatch_completion_denial_section_regression_export: Object.freeze(['src/export-report-contract-doc-page-release-post-action-dispatch-completion-denial-section-regression.mjs', '--strict']),
  syntax_report_manifest_drift_regression: Object.freeze(['--check', 'src/report-manifest-drift-regression.mjs']),
  syntax_report_manifest_drift_regression_export: Object.freeze(['--check', 'src/export-report-manifest-drift-regression.mjs']),
  report_manifest_drift_regression_export: Object.freeze(['src/export-report-manifest-drift-regression.mjs', '--strict']),
  syntax_report_latest_recovery_regression: Object.freeze(['--check', 'src/report-latest-recovery-regression.mjs']),
  syntax_report_latest_recovery_regression_export: Object.freeze(['--check', 'src/export-report-latest-recovery-regression.mjs']),
  report_latest_recovery_regression_export: Object.freeze(['src/export-report-latest-recovery-regression.mjs', '--strict']),
  syntax_report_bootstrap_seed_regression: Object.freeze(['--check', 'src/report-bootstrap-seed-regression.mjs']),
  syntax_report_bootstrap_seed_regression_export: Object.freeze(['--check', 'src/export-report-bootstrap-seed-regression.mjs']),
  report_bootstrap_seed_regression_export: Object.freeze(['src/export-report-bootstrap-seed-regression.mjs', '--strict']),
  syntax_report_gate_clean_rerun_regression: Object.freeze(['--check', 'src/report-gate-clean-rerun-regression.mjs']),
  syntax_report_gate_clean_rerun_regression_export: Object.freeze(['--check', 'src/export-report-gate-clean-rerun-regression.mjs']),
  report_gate_clean_rerun_regression_export: Object.freeze(['src/export-report-gate-clean-rerun-regression.mjs', '--strict']),
  syntax_report_clean_gate_idempotence_regression: Object.freeze(['--check', 'src/report-clean-gate-idempotence-regression.mjs']),
  syntax_report_clean_gate_idempotence_regression_export: Object.freeze(['--check', 'src/export-report-clean-gate-idempotence-regression.mjs']),
  report_clean_gate_idempotence_regression_export: Object.freeze(['src/export-report-clean-gate-idempotence-regression.mjs', '--strict']),
  syntax_report_final_settlement_regression: Object.freeze(['--check', 'src/report-final-settlement-regression.mjs']),
  syntax_report_final_settlement_regression_export: Object.freeze(['--check', 'src/export-report-final-settlement-regression.mjs']),
  report_final_settlement_regression_export: Object.freeze(['src/export-report-final-settlement-regression.mjs', '--strict']),
  syntax_report_post_final_drift_regression: Object.freeze(['--check', 'src/report-post-final-drift-regression.mjs']),
  syntax_report_post_final_drift_regression_export: Object.freeze(['--check', 'src/export-report-post-final-drift-regression.mjs']),
  report_post_final_drift_regression_export: Object.freeze(['src/export-report-post-final-drift-regression.mjs', '--strict']),
  syntax_report_closeout_drift_classification_regression: Object.freeze(['--check', 'src/report-closeout-drift-classification-regression.mjs']),
  syntax_report_closeout_drift_classification_regression_export: Object.freeze(['--check', 'src/export-report-closeout-drift-classification-regression.mjs']),
  report_closeout_drift_classification_regression_export: Object.freeze(['src/export-report-closeout-drift-classification-regression.mjs', '--strict']),
  syntax_report_closeout_command_inventory_regression: Object.freeze(['--check', 'src/report-closeout-command-inventory-regression.mjs']),
  syntax_report_closeout_command_inventory_regression_export: Object.freeze(['--check', 'src/export-report-closeout-command-inventory-regression.mjs']),
  report_closeout_command_inventory_regression_export: Object.freeze(['src/export-report-closeout-command-inventory-regression.mjs', '--strict']),
  syntax_report_bootstrap_seeds_export: Object.freeze(['--check', 'src/export-report-bootstrap-seeds.mjs']),
  report_bootstrap_seed_export: Object.freeze(['src/export-report-bootstrap-seeds.mjs']),
  syntax_report_runner_contract_regression: Object.freeze(['--check', 'src/report-runner-contract-regression.mjs']),
  syntax_report_runner_contract_regression_export: Object.freeze(['--check', 'src/export-report-runner-contract-regression.mjs']),
  report_runner_contract_regression_export: Object.freeze(['src/export-report-runner-contract-regression.mjs', '--strict']),
  syntax_runtime_dry_run_harness: Object.freeze(['--check', 'src/runtime-dry-run-harness.mjs']),
  syntax_runtime_dry_run_harness_export: Object.freeze(['--check', 'src/export-runtime-dry-run-harness.mjs']),
  runtime_dry_run_harness_export: Object.freeze(['src/export-runtime-dry-run-harness.mjs', '--strict']),
  syntax_channel_runner_coverage_matrix: Object.freeze(['--check', 'src/channel-runner-coverage-matrix.mjs']),
  syntax_channel_runner_coverage_matrix_export: Object.freeze(['--check', 'src/export-channel-runner-coverage-matrix.mjs']),
  channel_runner_coverage_matrix_export: Object.freeze(['src/export-channel-runner-coverage-matrix.mjs', '--strict']),
  syntax_post_action_evidence_matrix: Object.freeze(['--check', 'src/post-action-evidence-matrix.mjs']),
  syntax_post_action_evidence_matrix_export: Object.freeze(['--check', 'src/export-post-action-evidence-matrix.mjs']),
  post_action_evidence_matrix_export: Object.freeze(['src/export-post-action-evidence-matrix.mjs', '--strict']),
  syntax_post_action_audit_bundle_matrix: Object.freeze(['--check', 'src/post-action-audit-bundle-matrix.mjs']),
  syntax_post_action_audit_bundle_matrix_export: Object.freeze(['--check', 'src/export-post-action-audit-bundle-matrix.mjs']),
  post_action_audit_bundle_matrix_export: Object.freeze(['src/export-post-action-audit-bundle-matrix.mjs', '--strict']),
  syntax_post_action_audit_archive_matrix: Object.freeze(['--check', 'src/post-action-audit-archive-matrix.mjs']),
  syntax_post_action_audit_archive_matrix_export: Object.freeze(['--check', 'src/export-post-action-audit-archive-matrix.mjs']),
  post_action_audit_archive_matrix_export: Object.freeze(['src/export-post-action-audit-archive-matrix.mjs', '--strict']),
  syntax_post_action_replay_guard_matrix: Object.freeze(['--check', 'src/post-action-replay-guard-matrix.mjs']),
  syntax_post_action_replay_guard_matrix_export: Object.freeze(['--check', 'src/export-post-action-replay-guard-matrix.mjs']),
  post_action_replay_guard_matrix_export: Object.freeze(['src/export-post-action-replay-guard-matrix.mjs', '--strict']),
  syntax_post_action_dispatch_envelope_matrix: Object.freeze(['--check', 'src/post-action-dispatch-envelope-matrix.mjs']),
  syntax_post_action_dispatch_envelope_matrix_export: Object.freeze(['--check', 'src/export-post-action-dispatch-envelope-matrix.mjs']),
  post_action_dispatch_envelope_matrix_export: Object.freeze(['src/export-post-action-dispatch-envelope-matrix.mjs', '--strict']),
  syntax_post_action_dispatch_completion_matrix: Object.freeze(['--check', 'src/post-action-dispatch-completion-matrix.mjs']),
  syntax_post_action_dispatch_completion_matrix_export: Object.freeze(['--check', 'src/export-post-action-dispatch-completion-matrix.mjs']),
  post_action_dispatch_completion_matrix_export: Object.freeze(['src/export-post-action-dispatch-completion-matrix.mjs', '--strict']),
  syntax_post_action_reconciliation_matrix: Object.freeze(['--check', 'src/post-action-reconciliation-matrix.mjs']),
  syntax_post_action_reconciliation_matrix_export: Object.freeze(['--check', 'src/export-post-action-reconciliation-matrix.mjs']),
  post_action_reconciliation_matrix_export: Object.freeze(['src/export-post-action-reconciliation-matrix.mjs', '--strict']),
  syntax_post_action_runtime_status: Object.freeze(['--check', 'src/post-action-runtime-status.mjs']),
  syntax_post_action_runtime_status_export: Object.freeze(['--check', 'src/export-post-action-runtime-status.mjs']),
  post_action_runtime_status_export: Object.freeze(['src/export-post-action-runtime-status.mjs', '--strict']),
  report_freshness_export_pre_tooling: Object.freeze(['src/export-report-freshness.mjs', '--strict', '--skip-gate']),
  report_freshness_export: Object.freeze(['src/export-report-freshness.mjs', '--strict', '--skip-gate']),
});

const NEGATIVE_SCENARIOS = Object.freeze([
  Object.freeze({
    scenarioId: 'missing_pre_tooling_freshness',
    label: 'Pre-tooling child freshness step is missing',
    expectedBlockerCode: 'integration_gate_sequence_required_step_missing',
    mutate(steps) {
      return steps.filter((step) => step.stepId !== 'report_freshness_export_pre_tooling');
    },
  }),
  Object.freeze({
    scenarioId: 'missing_bootstrap_seed_export',
    label: 'Bootstrap seed export step is missing',
    expectedBlockerCode: 'integration_gate_sequence_required_step_missing',
    mutate(steps) {
      return steps.filter((step) => step.stepId !== 'report_bootstrap_seed_export');
    },
  }),
  Object.freeze({
    scenarioId: 'sequence_regression_after_freshness',
    label: 'Sequence regression export moved after child freshness',
    expectedBlockerCode: 'integration_gate_sequence_order_mismatch',
    mutate(steps) {
      return moveAfter(steps, 'integration_gate_sequence_regression_export', 'report_freshness_export_pre_tooling');
    },
  }),
  Object.freeze({
    scenarioId: 'pre_tooling_after_tooling',
    label: 'Pre-tooling child freshness moved after tooling metadata',
    expectedBlockerCode: 'integration_gate_sequence_order_mismatch',
    mutate(steps) {
      return moveAfter(steps, 'report_freshness_export_pre_tooling', 'integration_gate_tooling_export');
    },
  }),
  Object.freeze({
    scenarioId: 'inventory_after_freshness',
    label: 'Report inventory consistency moved after child freshness',
    expectedBlockerCode: 'integration_gate_sequence_order_mismatch',
    mutate(steps) {
      return moveAfter(steps, 'report_inventory_consistency_export', 'report_freshness_export_pre_tooling');
    },
  }),
  Object.freeze({
    scenarioId: 'bootstrap_seed_after_schema_contract',
    label: 'Bootstrap seed export moved after latest schema contract',
    expectedBlockerCode: 'integration_gate_sequence_order_mismatch',
    mutate(steps) {
      return moveAfter(steps, 'report_bootstrap_seed_export', 'report_schema_contract_export');
    },
  }),
  Object.freeze({
    scenarioId: 'schema_contract_after_freshness',
    label: 'Report schema contract moved after child freshness',
    expectedBlockerCode: 'integration_gate_sequence_order_mismatch',
    mutate(steps) {
      return moveAfter(steps, 'report_schema_contract_export', 'report_freshness_export_pre_tooling');
    },
  }),
  Object.freeze({
    scenarioId: 'lineage_topology_after_freshness',
    label: 'Report lineage topology moved after child freshness',
    expectedBlockerCode: 'integration_gate_sequence_order_mismatch',
    mutate(steps) {
      return moveAfter(steps, 'report_lineage_topology_export', 'report_freshness_export_pre_tooling');
    },
  }),
  Object.freeze({
    scenarioId: 'hash_stability_after_freshness',
    label: 'Report hash stability regression moved after child freshness',
    expectedBlockerCode: 'integration_gate_sequence_order_mismatch',
    mutate(steps) {
      return moveAfter(steps, 'report_hash_stability_regression_export', 'report_freshness_export_pre_tooling');
    },
  }),
  Object.freeze({
    scenarioId: 'output_pairing_after_freshness',
    label: 'Report output pairing moved after child freshness',
    expectedBlockerCode: 'integration_gate_sequence_order_mismatch',
    mutate(steps) {
      return moveAfter(steps, 'report_output_pairing_export', 'report_freshness_export_pre_tooling');
    },
  }),
  Object.freeze({
    scenarioId: 'artifact_reproducibility_after_freshness',
    label: 'Report artifact reproducibility moved after child freshness',
    expectedBlockerCode: 'integration_gate_sequence_order_mismatch',
    mutate(steps) {
      return moveAfter(steps, 'report_artifact_reproducibility_export', 'report_freshness_export_pre_tooling');
    },
  }),
  Object.freeze({
    scenarioId: 'self_reference_boundary_after_freshness',
    label: 'Report self-reference boundary regression moved after child freshness',
    expectedBlockerCode: 'integration_gate_sequence_order_mismatch',
    mutate(steps) {
      return moveAfter(steps, 'report_self_reference_boundary_regression_export', 'report_freshness_export_pre_tooling');
    },
  }),
  Object.freeze({
    scenarioId: 'manifest_drift_after_freshness',
    label: 'Report manifest drift regression moved after child freshness',
    expectedBlockerCode: 'integration_gate_sequence_order_mismatch',
    mutate(steps) {
      return moveAfter(steps, 'report_manifest_drift_regression_export', 'report_freshness_export_pre_tooling');
    },
  }),
  Object.freeze({
    scenarioId: 'contract_required_coverage_after_freshness',
    label: 'Report contract required coverage regression moved after child freshness',
    expectedBlockerCode: 'integration_gate_sequence_order_mismatch',
    mutate(steps) {
      return moveAfter(steps, 'report_contract_required_coverage_regression_export', 'report_freshness_export_pre_tooling');
    },
  }),
  Object.freeze({
    scenarioId: 'contract_doc_coverage_after_freshness',
    label: 'Report contract doc coverage regression moved after child freshness',
    expectedBlockerCode: 'integration_gate_sequence_order_mismatch',
    mutate(steps) {
      return moveAfter(steps, 'report_contract_doc_coverage_regression_export', 'report_freshness_export_pre_tooling');
    },
  }),
  Object.freeze({
    scenarioId: 'contract_syntax_coverage_after_freshness',
    label: 'Report contract syntax coverage regression moved after child freshness',
    expectedBlockerCode: 'integration_gate_sequence_order_mismatch',
    mutate(steps) {
      return moveAfter(steps, 'report_contract_syntax_coverage_regression_export', 'report_freshness_export_pre_tooling');
    },
  }),
  Object.freeze({
    scenarioId: 'contract_source_derivation_after_freshness',
    label: 'Report contract source derivation regression moved after child freshness',
    expectedBlockerCode: 'integration_gate_sequence_order_mismatch',
    mutate(steps) {
      return moveAfter(steps, 'report_contract_source_derivation_regression_export', 'report_freshness_export_pre_tooling');
    },
  }),
  Object.freeze({
    scenarioId: 'contract_summary_key_after_freshness',
    label: 'Report contract summary key regression moved after child freshness',
    expectedBlockerCode: 'integration_gate_sequence_order_mismatch',
    mutate(steps) {
      return moveAfter(steps, 'report_contract_summary_key_regression_export', 'report_freshness_export_pre_tooling');
    },
  }),
  Object.freeze({
    scenarioId: 'contract_audit_forwarding_after_freshness',
    label: 'Report contract audit forwarding regression moved after child freshness',
    expectedBlockerCode: 'integration_gate_sequence_order_mismatch',
    mutate(steps) {
      return moveAfter(steps, 'report_contract_audit_forwarding_regression_export', 'report_freshness_export_pre_tooling');
    },
  }),
  Object.freeze({
    scenarioId: 'contract_checkpoint_binding_shape_after_freshness',
    label: 'Report contract checkpoint binding shape regression moved after child freshness',
    expectedBlockerCode: 'integration_gate_sequence_order_mismatch',
    mutate(steps) {
      return moveAfter(steps, 'report_contract_checkpoint_binding_shape_regression_export', 'report_freshness_export_pre_tooling');
    },
  }),
  Object.freeze({
    scenarioId: 'contract_gate_summary_shape_after_freshness',
    label: 'Report contract gate summary shape regression moved after child freshness',
    expectedBlockerCode: 'integration_gate_sequence_order_mismatch',
    mutate(steps) {
      return moveAfter(steps, 'report_contract_gate_summary_shape_regression_export', 'report_freshness_export_pre_tooling');
    },
  }),
  Object.freeze({
    scenarioId: 'contract_exporter_stdout_shape_after_freshness',
    label: 'Report contract exporter stdout shape regression moved after child freshness',
    expectedBlockerCode: 'integration_gate_sequence_order_mismatch',
    mutate(steps) {
      return moveAfter(steps, 'report_contract_exporter_stdout_shape_regression_export', 'report_freshness_export_pre_tooling');
    },
  }),
  Object.freeze({
    scenarioId: 'contract_safety_flag_after_freshness',
    label: 'Report contract safety flag regression moved after child freshness',
    expectedBlockerCode: 'integration_gate_sequence_order_mismatch',
    mutate(steps) {
      return moveAfter(steps, 'report_contract_safety_flag_regression_export', 'report_freshness_export_pre_tooling');
    },
  }),
  Object.freeze({
    scenarioId: 'contract_artifact_binding_after_freshness',
    label: 'Report contract artifact binding regression moved after child freshness',
    expectedBlockerCode: 'integration_gate_sequence_order_mismatch',
    mutate(steps) {
      return moveAfter(steps, 'report_contract_artifact_binding_regression_export', 'report_freshness_export_pre_tooling');
    },
  }),
  Object.freeze({
    scenarioId: 'contract_doc_index_anchor_after_freshness',
    label: 'Report contract doc index anchor regression moved after child freshness',
    expectedBlockerCode: 'integration_gate_sequence_order_mismatch',
    mutate(steps) {
      return moveAfter(steps, 'report_contract_doc_index_anchor_regression_export', 'report_freshness_export_pre_tooling');
    },
  }),
  Object.freeze({
    scenarioId: 'contract_doc_page_latest_detail_after_freshness',
    label: 'Report contract doc page latest detail regression moved after child freshness',
    expectedBlockerCode: 'integration_gate_sequence_order_mismatch',
    mutate(steps) {
      return moveAfter(steps, 'report_contract_doc_page_latest_detail_regression_export', 'report_freshness_export_pre_tooling');
    },
  }),
  Object.freeze({
    scenarioId: 'contract_doc_page_command_section_after_freshness',
    label: 'Report contract doc page command section regression moved after child freshness',
    expectedBlockerCode: 'integration_gate_sequence_order_mismatch',
    mutate(steps) {
      return moveAfter(steps, 'report_contract_doc_page_command_section_regression_export', 'report_freshness_export_pre_tooling');
    },
  }),
  Object.freeze({
    scenarioId: 'contract_doc_page_safety_section_detail_after_freshness',
    label: 'Report contract doc page safety section detail regression moved after child freshness',
    expectedBlockerCode: 'integration_gate_sequence_order_mismatch',
    mutate(steps) {
      return moveAfter(steps, 'report_contract_doc_page_safety_section_detail_regression_export', 'report_freshness_export_pre_tooling');
    },
  }),
  Object.freeze({
    scenarioId: 'contract_doc_page_strict_gate_section_after_freshness',
    label: 'Report contract doc page strict gate section regression moved after child freshness',
    expectedBlockerCode: 'integration_gate_sequence_order_mismatch',
    mutate(steps) {
      return moveAfter(steps, 'report_contract_doc_page_strict_gate_section_regression_export', 'report_freshness_export_pre_tooling');
    },
  }),
  Object.freeze({
    scenarioId: 'contract_doc_page_output_section_after_freshness',
    label: 'Report contract doc page output section regression moved after child freshness',
    expectedBlockerCode: 'integration_gate_sequence_order_mismatch',
    mutate(steps) {
      return moveAfter(steps, 'report_contract_doc_page_output_section_regression_export', 'report_freshness_export_pre_tooling');
    },
  }),
  Object.freeze({
    scenarioId: 'contract_doc_page_cross_report_section_after_freshness',
    label: 'Report contract doc page cross-report section regression moved after child freshness',
    expectedBlockerCode: 'integration_gate_sequence_order_mismatch',
    mutate(steps) {
      return moveAfter(steps, 'report_contract_doc_page_cross_report_section_regression_export', 'report_freshness_export_pre_tooling');
    },
  }),
  Object.freeze({
    scenarioId: 'contract_doc_page_closeout_section_after_freshness',
    label: 'Report contract doc page closeout section regression moved after child freshness',
    expectedBlockerCode: 'integration_gate_sequence_order_mismatch',
    mutate(steps) {
      return moveAfter(steps, 'report_contract_doc_page_closeout_section_regression_export', 'report_freshness_export_pre_tooling');
    },
  }),
  Object.freeze({
    scenarioId: 'contract_doc_page_post_gate_writer_section_after_freshness',
    label: 'Report contract doc page post-gate writer section regression moved after child freshness',
    expectedBlockerCode: 'integration_gate_sequence_order_mismatch',
    mutate(steps) {
      return moveAfter(steps, 'report_contract_doc_page_post_gate_writer_section_regression_export', 'report_freshness_export_pre_tooling');
    },
  }),
  Object.freeze({
    scenarioId: 'contract_doc_page_retention_section_after_freshness',
    label: 'Report contract doc page retention section regression moved after child freshness',
    expectedBlockerCode: 'integration_gate_sequence_order_mismatch',
    mutate(steps) {
      return moveAfter(steps, 'report_contract_doc_page_retention_section_regression_export', 'report_freshness_export_pre_tooling');
    },
  }),
  Object.freeze({
    scenarioId: 'contract_doc_page_freshness_hash_section_after_freshness',
    label: 'Report contract doc page freshness hash section regression moved after child freshness',
    expectedBlockerCode: 'integration_gate_sequence_order_mismatch',
    mutate(steps) {
      return moveAfter(steps, 'report_contract_doc_page_freshness_hash_section_regression_export', 'report_freshness_export_pre_tooling');
    },
  }),
  Object.freeze({
    scenarioId: 'contract_doc_page_checkpoint_hash_section_after_freshness',
    label: 'Report contract doc page checkpoint hash section regression moved after child freshness',
    expectedBlockerCode: 'integration_gate_sequence_order_mismatch',
    mutate(steps) {
      return moveAfter(steps, 'report_contract_doc_page_checkpoint_hash_section_regression_export', 'report_freshness_export_pre_tooling');
    },
  }),
  Object.freeze({
    scenarioId: 'contract_doc_page_clean_rerun_section_after_freshness',
    label: 'Report contract doc page clean rerun section regression moved after child freshness',
    expectedBlockerCode: 'integration_gate_sequence_order_mismatch',
    mutate(steps) {
      return moveAfter(steps, 'report_contract_doc_page_clean_rerun_section_regression_export', 'report_freshness_export_pre_tooling');
    },
  }),
  Object.freeze({
    scenarioId: 'latest_recovery_after_freshness',
    label: 'Report latest recovery regression moved after child freshness',
    expectedBlockerCode: 'integration_gate_sequence_order_mismatch',
    mutate(steps) {
      return moveAfter(steps, 'report_latest_recovery_regression_export', 'report_freshness_export_pre_tooling');
    },
  }),
  Object.freeze({
    scenarioId: 'bootstrap_seed_after_freshness',
    label: 'Report bootstrap seed regression moved after child freshness',
    expectedBlockerCode: 'integration_gate_sequence_order_mismatch',
    mutate(steps) {
      return moveAfter(steps, 'report_bootstrap_seed_regression_export', 'report_freshness_export_pre_tooling');
    },
  }),
  Object.freeze({
    scenarioId: 'gate_clean_rerun_after_freshness',
    label: 'Report gate clean rerun regression moved after child freshness',
    expectedBlockerCode: 'integration_gate_sequence_order_mismatch',
    mutate(steps) {
      return moveAfter(steps, 'report_gate_clean_rerun_regression_export', 'report_freshness_export_pre_tooling');
    },
  }),
  Object.freeze({
    scenarioId: 'clean_gate_idempotence_after_freshness',
    label: 'Report clean gate idempotence regression moved after child freshness',
    expectedBlockerCode: 'integration_gate_sequence_order_mismatch',
    mutate(steps) {
      return moveAfter(steps, 'report_clean_gate_idempotence_regression_export', 'report_freshness_export_pre_tooling');
    },
  }),
  Object.freeze({
    scenarioId: 'final_settlement_after_freshness',
    label: 'Report final settlement regression moved after child freshness',
    expectedBlockerCode: 'integration_gate_sequence_order_mismatch',
    mutate(steps) {
      return moveAfter(steps, 'report_final_settlement_regression_export', 'report_freshness_export_pre_tooling');
    },
  }),
  Object.freeze({
    scenarioId: 'post_final_drift_after_freshness',
    label: 'Report post-final drift regression moved after child freshness',
    expectedBlockerCode: 'integration_gate_sequence_order_mismatch',
    mutate(steps) {
      return moveAfter(steps, 'report_post_final_drift_regression_export', 'report_freshness_export_pre_tooling');
    },
  }),
  Object.freeze({
    scenarioId: 'closeout_drift_classification_after_freshness',
    label: 'Report closeout drift classification regression moved after child freshness',
    expectedBlockerCode: 'integration_gate_sequence_order_mismatch',
    mutate(steps) {
      return moveAfter(steps, 'report_closeout_drift_classification_regression_export', 'report_freshness_export_pre_tooling');
    },
  }),
  Object.freeze({
    scenarioId: 'closeout_command_inventory_after_freshness',
    label: 'Report closeout command inventory regression moved after child freshness',
    expectedBlockerCode: 'integration_gate_sequence_order_mismatch',
    mutate(steps) {
      return moveAfter(steps, 'report_closeout_command_inventory_regression_export', 'report_freshness_export_pre_tooling');
    },
  }),
  Object.freeze({
    scenarioId: 'runner_contract_after_freshness',
    label: 'Report runner contract regression moved after child freshness',
    expectedBlockerCode: 'integration_gate_sequence_order_mismatch',
    mutate(steps) {
      return moveAfter(steps, 'report_runner_contract_regression_export', 'report_freshness_export_pre_tooling');
    },
  }),
  Object.freeze({
    scenarioId: 'contract_manifest_after_freshness',
    label: 'Report contract manifest moved after child freshness',
    expectedBlockerCode: 'integration_gate_sequence_order_mismatch',
    mutate(steps) {
      return moveAfter(steps, 'report_contract_manifest_export', 'report_freshness_export_pre_tooling');
    },
  }),
  Object.freeze({
    scenarioId: 'final_child_before_audit',
    label: 'Final child freshness moved before strict audit',
    expectedBlockerCode: 'integration_gate_sequence_order_mismatch',
    mutate(steps) {
      return moveBefore(steps, 'report_freshness_export', 'integration_dependency_audit_strict');
    },
  }),
  Object.freeze({
    scenarioId: 'final_child_without_skip_gate',
    label: 'Final child freshness loses skip-gate flag',
    expectedBlockerCode: 'integration_gate_sequence_required_step_arg_missing',
    mutate(steps) {
      return steps.map((step) => (step.stepId === 'report_freshness_export'
        ? { ...step, args: step.args.filter((arg) => arg !== '--skip-gate') }
        : step));
    },
  }),
  Object.freeze({
    scenarioId: 'syntax_export_after_runner',
    label: 'Sequence regression syntax check moved after export runner',
    expectedBlockerCode: 'integration_gate_sequence_order_mismatch',
    mutate(steps) {
      return moveAfter(steps, 'syntax_integration_gate_sequence_regression_export', 'integration_gate_sequence_regression_export');
    },
  }),
]);

const SOURCE_NEGATIVE_SCENARIOS = Object.freeze([
  Object.freeze({
    scenarioId: 'lock_release_after_stdout',
    label: 'Integration gate lock release moved after stdout',
    expectedBlockerCode: 'integration_gate_sequence_lock_release_before_stdout_missing',
    mutateSource(sourceText) {
      return String(sourceText)
        .replace(
          '    lockReleased = releaseIntegrationDependencyGateLock(lock);\n    const summary = {',
          '    const summary = {',
        )
        .replace(
          '    process.stdout.write(`${JSON.stringify(summary, null, 2)}\\n`);\n    if (strict',
          '    process.stdout.write(`${JSON.stringify(summary, null, 2)}\\n`);\n    lockReleased = releaseIntegrationDependencyGateLock(lock);\n    if (strict',
        );
    },
  }),
  Object.freeze({
    scenarioId: 'lock_busy_writes_report',
    label: 'Integration gate busy lock branch writes latest reports',
    expectedBlockerCode: 'integration_gate_sequence_lock_busy_writes_report',
    mutateSource(sourceText) {
      return String(sourceText).replace(
        '  if (!lock.ok) {\n',
        '  if (!lock.ok) {\n    writeReports({ ok: false });\n',
      );
    },
  }),
  Object.freeze({
    scenarioId: 'lock_finally_release_fallback_removed',
    label: 'Integration gate finally release fallback removed',
    expectedBlockerCode: 'integration_gate_sequence_lock_finally_release_fallback_missing',
    mutateSource(sourceText) {
      return String(sourceText).replace(
        '    if (!lockReleased) releaseIntegrationDependencyGateLock(lock);',
        '    // release fallback removed by regression fixture',
      );
    },
  }),
]);

function moveAfter(steps, movingStepId, anchorStepId) {
  const moving = steps.find((step) => step.stepId === movingStepId);
  if (!moving) return steps;
  const withoutMoving = steps.filter((step) => step.stepId !== movingStepId);
  const anchorIndex = withoutMoving.findIndex((step) => step.stepId === anchorStepId);
  if (anchorIndex < 0) return withoutMoving;
  return [
    ...withoutMoving.slice(0, anchorIndex + 1),
    moving,
    ...withoutMoving.slice(anchorIndex + 1),
  ];
}

function moveBefore(steps, movingStepId, anchorStepId) {
  const moving = steps.find((step) => step.stepId === movingStepId);
  if (!moving) return steps;
  const withoutMoving = steps.filter((step) => step.stepId !== movingStepId);
  const anchorIndex = withoutMoving.findIndex((step) => step.stepId === anchorStepId);
  if (anchorIndex < 0) return withoutMoving;
  return [
    ...withoutMoving.slice(0, anchorIndex),
    moving,
    ...withoutMoving.slice(anchorIndex),
  ];
}

function stringLiterals(value = '') {
  return [...String(value).matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

export function extractIntegrationGateStepSpecs(sourceText = '') {
  const specs = [];
  const stepBlockPattern = /runNodeStep\(\{\s*stepId:\s*'([^']+)'([\s\S]*?)\}\),/g;
  for (const match of String(sourceText).matchAll(stepBlockPattern)) {
    const [, stepId, body] = match;
    const argsMatch = body.match(/args:\s*\[([\s\S]*?)\]/);
    specs.push({
      stepId,
      args: argsMatch ? stringLiterals(argsMatch[1]) : [],
      parseJsonOutput: /parseJsonOutput:\s*true/.test(body),
    });
  }
  return specs;
}

function stepIndexById(steps) {
  return Object.fromEntries(steps.map((step, index) => [step.stepId, index]));
}

export function analyzeIntegrationGateSequence(steps = []) {
  const indexById = stepIndexById(steps);
  const duplicates = steps
    .map((step) => step.stepId)
    .filter((stepId, index, values) => values.indexOf(stepId) !== index)
    .filter((stepId, index, values) => values.indexOf(stepId) === index);
  const requiredStepIds = [
    ...Object.keys(REQUIRED_STEP_ARGS),
    ...EXPECTED_ORDER,
  ].filter((stepId, index, values) => values.indexOf(stepId) === index);
  const blockers = [
    ...(!steps.length ? [{
      code: 'integration_gate_sequence_no_steps_extracted',
      notes: 'No runNodeStep definitions were extracted from integration-dependency-gate.mjs.',
    }] : []),
    ...duplicates.map((stepId) => ({
      code: 'integration_gate_sequence_duplicate_step_id',
      stepId,
      notes: `${stepId} appears more than once in the integration gate sequence.`,
    })),
    ...requiredStepIds
      .filter((stepId) => indexById[stepId] == null)
      .map((stepId) => ({
        code: 'integration_gate_sequence_required_step_missing',
        stepId,
        notes: `${stepId} is required in the integration gate sequence.`,
      })),
  ];

  for (let index = 1; index < EXPECTED_ORDER.length; index += 1) {
    const previousStepId = EXPECTED_ORDER[index - 1];
    const stepId = EXPECTED_ORDER[index];
    if (indexById[previousStepId] == null || indexById[stepId] == null) continue;
    if (indexById[previousStepId] >= indexById[stepId]) {
      blockers.push({
        code: 'integration_gate_sequence_order_mismatch',
        stepId,
        previousStepId,
        notes: `${previousStepId} must run before ${stepId}.`,
      });
    }
  }

  const syntaxStepId = 'syntax_integration_gate_sequence_regression';
  const syntaxExportStepId = 'syntax_integration_gate_sequence_regression_export';
  const exportStepId = 'integration_gate_sequence_regression_export';
  for (const [previousStepId, stepId] of [
    [syntaxStepId, syntaxExportStepId],
    [syntaxExportStepId, exportStepId],
    ['syntax_report_inventory_consistency', 'syntax_report_inventory_consistency_export'],
    ['syntax_report_inventory_consistency_export', 'report_inventory_consistency_export'],
    ['syntax_report_schema_contract', 'syntax_report_schema_contract_export'],
    ['syntax_report_schema_contract_export', 'report_schema_contract_export'],
    ['syntax_report_lineage_topology', 'syntax_report_lineage_topology_export'],
    ['syntax_report_lineage_topology_export', 'report_lineage_topology_export'],
    ['syntax_report_hash_stability_regression', 'syntax_report_hash_stability_regression_export'],
    ['syntax_report_hash_stability_regression_export', 'report_hash_stability_regression_export'],
    ['syntax_report_output_pairing', 'syntax_report_output_pairing_export'],
    ['syntax_report_output_pairing_export', 'report_output_pairing_export'],
    ['syntax_report_artifact_reproducibility', 'syntax_report_artifact_reproducibility_export'],
    ['syntax_report_artifact_reproducibility_export', 'report_artifact_reproducibility_export'],
    ['syntax_report_self_reference_boundary_regression', 'syntax_report_self_reference_boundary_regression_export'],
    ['syntax_report_self_reference_boundary_regression_export', 'report_self_reference_boundary_regression_export'],
    ['syntax_report_contract_manifest', 'syntax_report_contract_manifest_export'],
    ['syntax_report_contract_manifest_export', 'report_contract_manifest_export'],
    ['syntax_report_contract_required_coverage_regression', 'syntax_report_contract_required_coverage_regression_export'],
    ['syntax_report_contract_required_coverage_regression_export', 'report_contract_required_coverage_regression_export'],
    ['syntax_report_contract_doc_coverage_regression', 'syntax_report_contract_doc_coverage_regression_export'],
    ['syntax_report_contract_doc_coverage_regression_export', 'report_contract_doc_coverage_regression_export'],
    ['syntax_report_contract_syntax_coverage_regression', 'syntax_report_contract_syntax_coverage_regression_export'],
    ['syntax_report_contract_syntax_coverage_regression_export', 'report_contract_syntax_coverage_regression_export'],
    ['syntax_report_contract_source_derivation_regression', 'syntax_report_contract_source_derivation_regression_export'],
    ['syntax_report_contract_source_derivation_regression_export', 'report_contract_source_derivation_regression_export'],
    ['syntax_report_contract_summary_key_regression', 'syntax_report_contract_summary_key_regression_export'],
    ['syntax_report_contract_summary_key_regression_export', 'report_contract_summary_key_regression_export'],
    ['syntax_report_contract_audit_forwarding_regression', 'syntax_report_contract_audit_forwarding_regression_export'],
    ['syntax_report_contract_audit_forwarding_regression_export', 'report_contract_audit_forwarding_regression_export'],
    ['syntax_report_contract_checkpoint_binding_shape_regression', 'syntax_report_contract_checkpoint_binding_shape_regression_export'],
    ['syntax_report_contract_checkpoint_binding_shape_regression_export', 'report_contract_checkpoint_binding_shape_regression_export'],
    ['syntax_report_contract_gate_summary_shape_regression', 'syntax_report_contract_gate_summary_shape_regression_export'],
    ['syntax_report_contract_gate_summary_shape_regression_export', 'report_contract_gate_summary_shape_regression_export'],
    ['syntax_report_contract_exporter_stdout_shape_regression', 'syntax_report_contract_exporter_stdout_shape_regression_export'],
    ['syntax_report_contract_exporter_stdout_shape_regression_export', 'report_contract_exporter_stdout_shape_regression_export'],
    ['syntax_report_contract_safety_flag_regression', 'syntax_report_contract_safety_flag_regression_export'],
    ['syntax_report_contract_safety_flag_regression_export', 'report_contract_safety_flag_regression_export'],
    ['syntax_report_contract_artifact_binding_regression', 'syntax_report_contract_artifact_binding_regression_export'],
    ['syntax_report_contract_artifact_binding_regression_export', 'report_contract_artifact_binding_regression_export'],
    ['syntax_report_contract_doc_index_anchor_regression', 'syntax_report_contract_doc_index_anchor_regression_export'],
    ['syntax_report_contract_doc_index_anchor_regression_export', 'report_contract_doc_index_anchor_regression_export'],
    ['syntax_report_contract_doc_page_latest_detail_regression', 'syntax_report_contract_doc_page_latest_detail_regression_export'],
    ['syntax_report_contract_doc_page_latest_detail_regression_export', 'report_contract_doc_page_latest_detail_regression_export'],
    ['syntax_report_contract_doc_page_command_section_regression', 'syntax_report_contract_doc_page_command_section_regression_export'],
    ['syntax_report_contract_doc_page_command_section_regression_export', 'report_contract_doc_page_command_section_regression_export'],
    ['syntax_report_contract_doc_page_safety_section_detail_regression', 'syntax_report_contract_doc_page_safety_section_detail_regression_export'],
    ['syntax_report_contract_doc_page_safety_section_detail_regression_export', 'report_contract_doc_page_safety_section_detail_regression_export'],
    ['syntax_report_contract_doc_page_strict_gate_section_regression', 'syntax_report_contract_doc_page_strict_gate_section_regression_export'],
    ['syntax_report_contract_doc_page_strict_gate_section_regression_export', 'report_contract_doc_page_strict_gate_section_regression_export'],
    ['syntax_report_contract_doc_page_output_section_regression', 'syntax_report_contract_doc_page_output_section_regression_export'],
    ['syntax_report_contract_doc_page_output_section_regression_export', 'report_contract_doc_page_output_section_regression_export'],
    ['syntax_report_contract_doc_page_cross_report_section_regression', 'syntax_report_contract_doc_page_cross_report_section_regression_export'],
    ['syntax_report_contract_doc_page_cross_report_section_regression_export', 'report_contract_doc_page_cross_report_section_regression_export'],
    ['syntax_report_contract_doc_page_closeout_section_regression', 'syntax_report_contract_doc_page_closeout_section_regression_export'],
    ['syntax_report_contract_doc_page_closeout_section_regression_export', 'report_contract_doc_page_closeout_section_regression_export'],
    ['syntax_report_contract_doc_page_post_gate_writer_section_regression', 'syntax_report_contract_doc_page_post_gate_writer_section_regression_export'],
    ['syntax_report_contract_doc_page_post_gate_writer_section_regression_export', 'report_contract_doc_page_post_gate_writer_section_regression_export'],
    ['syntax_report_contract_doc_page_retention_section_regression', 'syntax_report_contract_doc_page_retention_section_regression_export'],
    ['syntax_report_contract_doc_page_retention_section_regression_export', 'report_contract_doc_page_retention_section_regression_export'],
    ['syntax_report_contract_doc_page_freshness_hash_section_regression', 'syntax_report_contract_doc_page_freshness_hash_section_regression_export'],
    ['syntax_report_contract_doc_page_freshness_hash_section_regression_export', 'report_contract_doc_page_freshness_hash_section_regression_export'],
    ['syntax_report_contract_doc_page_checkpoint_hash_section_regression', 'syntax_report_contract_doc_page_checkpoint_hash_section_regression_export'],
    ['syntax_report_contract_doc_page_checkpoint_hash_section_regression_export', 'report_contract_doc_page_checkpoint_hash_section_regression_export'],
    ['syntax_report_contract_doc_page_bootstrap_seed_section_regression', 'syntax_report_contract_doc_page_bootstrap_seed_section_regression_export'],
    ['syntax_report_contract_doc_page_bootstrap_seed_section_regression_export', 'report_contract_doc_page_bootstrap_seed_section_regression_export'],
    ['syntax_report_contract_doc_page_clean_rerun_section_regression', 'syntax_report_contract_doc_page_clean_rerun_section_regression_export'],
    ['syntax_report_contract_doc_page_clean_rerun_section_regression_export', 'report_contract_doc_page_clean_rerun_section_regression_export'],
    ['syntax_report_contract_doc_page_closeout_retention_proof_section_regression', 'syntax_report_contract_doc_page_closeout_retention_proof_section_regression_export'],
    ['syntax_report_contract_doc_page_closeout_retention_proof_section_regression_export', 'report_contract_doc_page_closeout_retention_proof_section_regression_export'],
    ['syntax_report_contract_doc_page_closeout_probe_bundle_section_regression', 'syntax_report_contract_doc_page_closeout_probe_bundle_section_regression_export'],
    ['syntax_report_contract_doc_page_closeout_probe_bundle_section_regression_export', 'report_contract_doc_page_closeout_probe_bundle_section_regression_export'],
    ['syntax_report_contract_doc_page_closeout_signoff_section_regression', 'syntax_report_contract_doc_page_closeout_signoff_section_regression_export'],
    ['syntax_report_contract_doc_page_closeout_signoff_section_regression_export', 'report_contract_doc_page_closeout_signoff_section_regression_export'],
    ['syntax_report_contract_doc_page_closeout_release_manifest_section_regression', 'syntax_report_contract_doc_page_closeout_release_manifest_section_regression_export'],
    ['syntax_report_contract_doc_page_closeout_release_manifest_section_regression_export', 'report_contract_doc_page_closeout_release_manifest_section_regression_export'],
    ['syntax_report_contract_doc_page_release_archive_index_section_regression', 'syntax_report_contract_doc_page_release_archive_index_section_regression_export'],
    ['syntax_report_contract_doc_page_release_archive_index_section_regression_export', 'report_contract_doc_page_release_archive_index_section_regression_export'],
    ['syntax_report_contract_doc_page_release_live_action_preflight_section_regression', 'syntax_report_contract_doc_page_release_live_action_preflight_section_regression_export'],
    ['syntax_report_contract_doc_page_release_live_action_preflight_section_regression_export', 'report_contract_doc_page_release_live_action_preflight_section_regression_export'],
    ['syntax_report_contract_doc_page_release_execution_intent_capture_section_regression', 'syntax_report_contract_doc_page_release_execution_intent_capture_section_regression_export'],
    ['syntax_report_contract_doc_page_release_execution_intent_capture_section_regression_export', 'report_contract_doc_page_release_execution_intent_capture_section_regression_export'],
    ['syntax_report_contract_doc_page_release_execution_approval_boundary_section_regression', 'syntax_report_contract_doc_page_release_execution_approval_boundary_section_regression_export'],
    ['syntax_report_contract_doc_page_release_execution_approval_boundary_section_regression_export', 'report_contract_doc_page_release_execution_approval_boundary_section_regression_export'],
    ['syntax_report_contract_doc_page_release_post_action_settlement_denial_section_regression', 'syntax_report_contract_doc_page_release_post_action_settlement_denial_section_regression_export'],
    ['syntax_report_contract_doc_page_release_post_action_settlement_denial_section_regression_export', 'report_contract_doc_page_release_post_action_settlement_denial_section_regression_export'],
    ['syntax_report_contract_doc_page_release_post_action_acceptance_denial_section_regression', 'syntax_report_contract_doc_page_release_post_action_acceptance_denial_section_regression_export'],
    ['syntax_report_contract_doc_page_release_post_action_acceptance_denial_section_regression_export', 'report_contract_doc_page_release_post_action_acceptance_denial_section_regression_export'],
    ['syntax_report_contract_doc_page_release_post_action_payment_denial_section_regression', 'syntax_report_contract_doc_page_release_post_action_payment_denial_section_regression_export'],
    ['syntax_report_contract_doc_page_release_post_action_payment_denial_section_regression_export', 'report_contract_doc_page_release_post_action_payment_denial_section_regression_export'],
    ['syntax_report_contract_doc_page_release_post_action_deployment_denial_section_regression', 'syntax_report_contract_doc_page_release_post_action_deployment_denial_section_regression_export'],
    ['syntax_report_contract_doc_page_release_post_action_deployment_denial_section_regression_export', 'report_contract_doc_page_release_post_action_deployment_denial_section_regression_export'],
    ['syntax_report_contract_doc_page_release_post_action_provider_spend_denial_section_regression', 'syntax_report_contract_doc_page_release_post_action_provider_spend_denial_section_regression_export'],
    ['syntax_report_contract_doc_page_release_post_action_provider_spend_denial_section_regression_export', 'report_contract_doc_page_release_post_action_provider_spend_denial_section_regression_export'],
    ['syntax_report_contract_doc_page_release_post_action_state_transition_denial_section_regression', 'syntax_report_contract_doc_page_release_post_action_state_transition_denial_section_regression_export'],
    ['syntax_report_contract_doc_page_release_post_action_state_transition_denial_section_regression_export', 'report_contract_doc_page_release_post_action_state_transition_denial_section_regression_export'],
    ['syntax_report_contract_doc_page_release_post_action_queue_consumption_denial_section_regression', 'syntax_report_contract_doc_page_release_post_action_queue_consumption_denial_section_regression_export'],
    ['syntax_report_contract_doc_page_release_post_action_queue_consumption_denial_section_regression_export', 'report_contract_doc_page_release_post_action_queue_consumption_denial_section_regression_export'],
    ['syntax_report_contract_doc_page_release_post_action_background_runner_denial_section_regression', 'syntax_report_contract_doc_page_release_post_action_background_runner_denial_section_regression_export'],
    ['syntax_report_contract_doc_page_release_post_action_background_runner_denial_section_regression_export', 'report_contract_doc_page_release_post_action_background_runner_denial_section_regression_export'],
    ['syntax_report_contract_doc_page_release_post_action_dispatch_completion_denial_section_regression', 'syntax_report_contract_doc_page_release_post_action_dispatch_completion_denial_section_regression_export'],
    ['syntax_report_contract_doc_page_release_post_action_dispatch_completion_denial_section_regression_export', 'report_contract_doc_page_release_post_action_dispatch_completion_denial_section_regression_export'],
    ['syntax_report_manifest_drift_regression', 'syntax_report_manifest_drift_regression_export'],
    ['syntax_report_manifest_drift_regression_export', 'report_manifest_drift_regression_export'],
    ['syntax_report_latest_recovery_regression', 'syntax_report_latest_recovery_regression_export'],
    ['syntax_report_latest_recovery_regression_export', 'report_latest_recovery_regression_export'],
    ['syntax_report_bootstrap_seed_regression', 'syntax_report_bootstrap_seed_regression_export'],
    ['syntax_report_bootstrap_seed_regression_export', 'report_bootstrap_seed_regression_export'],
    ['syntax_report_gate_clean_rerun_regression', 'syntax_report_gate_clean_rerun_regression_export'],
    ['syntax_report_gate_clean_rerun_regression_export', 'report_gate_clean_rerun_regression_export'],
    ['syntax_report_clean_gate_idempotence_regression', 'syntax_report_clean_gate_idempotence_regression_export'],
    ['syntax_report_clean_gate_idempotence_regression_export', 'report_clean_gate_idempotence_regression_export'],
    ['syntax_report_final_settlement_regression', 'syntax_report_final_settlement_regression_export'],
    ['syntax_report_final_settlement_regression_export', 'report_final_settlement_regression_export'],
    ['syntax_report_post_final_drift_regression', 'syntax_report_post_final_drift_regression_export'],
    ['syntax_report_post_final_drift_regression_export', 'report_post_final_drift_regression_export'],
    ['syntax_report_closeout_drift_classification_regression', 'syntax_report_closeout_drift_classification_regression_export'],
    ['syntax_report_closeout_drift_classification_regression_export', 'report_closeout_drift_classification_regression_export'],
    ['syntax_report_closeout_command_inventory_regression', 'syntax_report_closeout_command_inventory_regression_export'],
    ['syntax_report_closeout_command_inventory_regression_export', 'report_closeout_command_inventory_regression_export'],
    ['syntax_report_bootstrap_seeds_export', 'report_bootstrap_seed_export'],
    ['report_contract_manifest_export', 'report_contract_required_coverage_regression_export'],
    ['report_contract_required_coverage_regression_export', 'report_contract_doc_coverage_regression_export'],
    ['report_contract_doc_coverage_regression_export', 'report_contract_syntax_coverage_regression_export'],
    ['report_contract_syntax_coverage_regression_export', 'report_contract_source_derivation_regression_export'],
    ['report_contract_source_derivation_regression_export', 'report_contract_summary_key_regression_export'],
    ['report_contract_summary_key_regression_export', 'report_contract_audit_forwarding_regression_export'],
    ['report_contract_audit_forwarding_regression_export', 'report_contract_checkpoint_binding_shape_regression_export'],
    ['report_contract_checkpoint_binding_shape_regression_export', 'report_contract_gate_summary_shape_regression_export'],
    ['report_contract_gate_summary_shape_regression_export', 'report_contract_exporter_stdout_shape_regression_export'],
    ['report_contract_exporter_stdout_shape_regression_export', 'report_contract_safety_flag_regression_export'],
    ['report_contract_safety_flag_regression_export', 'report_contract_artifact_binding_regression_export'],
    ['report_contract_artifact_binding_regression_export', 'report_contract_doc_index_anchor_regression_export'],
    ['report_contract_doc_index_anchor_regression_export', 'report_contract_doc_page_latest_detail_regression_export'],
    ['report_contract_doc_page_latest_detail_regression_export', 'report_contract_doc_page_command_section_regression_export'],
    ['report_contract_doc_page_command_section_regression_export', 'report_contract_doc_page_safety_section_detail_regression_export'],
    ['report_contract_doc_page_safety_section_detail_regression_export', 'report_contract_doc_page_strict_gate_section_regression_export'],
    ['report_contract_doc_page_strict_gate_section_regression_export', 'report_contract_doc_page_output_section_regression_export'],
    ['report_contract_doc_page_output_section_regression_export', 'report_contract_doc_page_cross_report_section_regression_export'],
    ['report_contract_doc_page_cross_report_section_regression_export', 'report_contract_doc_page_closeout_section_regression_export'],
    ['report_contract_doc_page_closeout_section_regression_export', 'report_contract_doc_page_post_gate_writer_section_regression_export'],
    ['report_contract_doc_page_post_gate_writer_section_regression_export', 'report_contract_doc_page_retention_section_regression_export'],
    ['report_contract_doc_page_retention_section_regression_export', 'report_contract_doc_page_freshness_hash_section_regression_export'],
    ['report_contract_doc_page_freshness_hash_section_regression_export', 'report_contract_doc_page_checkpoint_hash_section_regression_export'],
    ['report_contract_doc_page_checkpoint_hash_section_regression_export', 'report_contract_doc_page_bootstrap_seed_section_regression_export'],
    ['report_contract_doc_page_bootstrap_seed_section_regression_export', 'report_contract_doc_page_clean_rerun_section_regression_export'],
    ['report_contract_doc_page_clean_rerun_section_regression_export', 'report_manifest_drift_regression_export'],
    ['report_contract_doc_page_closeout_ledger_section_regression_export', 'report_contract_doc_page_closeout_retention_proof_section_regression_export'],
    ['report_contract_doc_page_closeout_retention_proof_section_regression_export', 'report_contract_doc_page_closeout_probe_bundle_section_regression_export'],
    ['report_contract_doc_page_closeout_probe_bundle_section_regression_export', 'report_contract_doc_page_closeout_signoff_section_regression_export'],
    ['report_contract_doc_page_closeout_signoff_section_regression_export', 'report_contract_doc_page_closeout_release_manifest_section_regression_export'],
    ['report_contract_doc_page_closeout_release_manifest_section_regression_export', 'report_contract_doc_page_release_archive_index_section_regression_export'],
    ['report_contract_doc_page_release_archive_index_section_regression_export', 'report_manifest_drift_regression_export'],
    ['report_contract_doc_page_release_runner_dispatch_denial_section_regression_export', 'report_contract_doc_page_release_live_action_preflight_section_regression_export'],
    ['report_contract_doc_page_release_live_action_preflight_section_regression_export', 'report_contract_doc_page_release_execution_intent_capture_section_regression_export'],
    ['report_contract_doc_page_release_execution_intent_capture_section_regression_export', 'report_contract_doc_page_release_execution_approval_boundary_section_regression_export'],
    ['report_contract_doc_page_release_execution_approval_boundary_section_regression_export', 'report_manifest_drift_regression_export'],
    ['report_bootstrap_seed_regression_export', 'report_gate_clean_rerun_regression_export'],
    ['report_gate_clean_rerun_regression_export', 'report_clean_gate_idempotence_regression_export'],
    ['report_clean_gate_idempotence_regression_export', 'report_final_settlement_regression_export'],
    ['report_final_settlement_regression_export', 'report_post_final_drift_regression_export'],
    ['report_post_final_drift_regression_export', 'report_closeout_drift_classification_regression_export'],
    ['report_closeout_drift_classification_regression_export', 'report_closeout_command_inventory_regression_export'],
    ['report_closeout_command_inventory_regression_export', 'report_runner_contract_regression_export'],
    ['syntax_report_runner_contract_regression', 'syntax_report_runner_contract_regression_export'],
    ['syntax_report_runner_contract_regression_export', 'report_runner_contract_regression_export'],
    ['report_runner_contract_regression_export', 'runtime_dry_run_harness_export'],
    ['runtime_dry_run_harness_export', 'post_action_evidence_matrix_export'],
    ['post_action_evidence_matrix_export', 'post_action_audit_bundle_matrix_export'],
    ['post_action_audit_bundle_matrix_export', 'post_action_audit_archive_matrix_export'],
    ['post_action_audit_archive_matrix_export', 'post_action_replay_guard_matrix_export'],
    ['post_action_replay_guard_matrix_export', 'post_action_dispatch_envelope_matrix_export'],
    ['post_action_dispatch_envelope_matrix_export', 'post_action_dispatch_completion_matrix_export'],
    ['post_action_dispatch_completion_matrix_export', 'post_action_reconciliation_matrix_export'],
    ['post_action_reconciliation_matrix_export', 'report_freshness_export_pre_tooling'],
    ['syntax_runtime_dry_run_harness', 'syntax_runtime_dry_run_harness_export'],
    ['syntax_runtime_dry_run_harness_export', 'runtime_dry_run_harness_export'],
    ['syntax_post_action_evidence_matrix', 'syntax_post_action_evidence_matrix_export'],
    ['syntax_post_action_evidence_matrix_export', 'post_action_evidence_matrix_export'],
    ['syntax_post_action_audit_bundle_matrix', 'syntax_post_action_audit_bundle_matrix_export'],
    ['syntax_post_action_audit_bundle_matrix_export', 'post_action_audit_bundle_matrix_export'],
    ['syntax_post_action_audit_archive_matrix', 'syntax_post_action_audit_archive_matrix_export'],
    ['syntax_post_action_audit_archive_matrix_export', 'post_action_audit_archive_matrix_export'],
    ['syntax_post_action_replay_guard_matrix', 'syntax_post_action_replay_guard_matrix_export'],
    ['syntax_post_action_replay_guard_matrix_export', 'post_action_replay_guard_matrix_export'],
    ['syntax_post_action_dispatch_envelope_matrix', 'syntax_post_action_dispatch_envelope_matrix_export'],
    ['syntax_post_action_dispatch_envelope_matrix_export', 'post_action_dispatch_envelope_matrix_export'],
    ['syntax_post_action_dispatch_completion_matrix', 'syntax_post_action_dispatch_completion_matrix_export'],
    ['syntax_post_action_dispatch_completion_matrix_export', 'post_action_dispatch_completion_matrix_export'],
    ['syntax_post_action_reconciliation_matrix', 'syntax_post_action_reconciliation_matrix_export'],
    ['syntax_post_action_reconciliation_matrix_export', 'post_action_reconciliation_matrix_export'],
  ]) {
    if (indexById[previousStepId] == null || indexById[stepId] == null) continue;
    if (indexById[previousStepId] >= indexById[stepId]) {
      blockers.push({
        code: 'integration_gate_sequence_order_mismatch',
        stepId,
        previousStepId,
        notes: `${previousStepId} must run before ${stepId}.`,
      });
    }
  }

  for (const [stepId, requiredArgs] of Object.entries(REQUIRED_STEP_ARGS)) {
    const step = steps.find((item) => item.stepId === stepId);
    if (!step) continue;
    const missingArgs = requiredArgs.filter((arg) => !step.args.includes(arg));
    blockers.push(...missingArgs.map((arg) => ({
      code: 'integration_gate_sequence_required_step_arg_missing',
      stepId,
      arg,
      notes: `${stepId} must include ${arg}.`,
    })));
  }

  return {
    status: blockers.length ? 'blocked_integration_gate_sequence_analysis' : 'pass_integration_gate_sequence_analysis',
    ok: blockers.length === 0,
    stepCount: steps.length,
    requiredStepCount: requiredStepIds.length,
    expectedOrder: [...EXPECTED_ORDER],
    stepIds: steps.map((step) => step.stepId),
    blockers,
  };
}

function sourceIndex(sourceText, needle, fromIndex = 0) {
  return String(sourceText).indexOf(needle, fromIndex);
}

export function analyzeIntegrationGateLifecycle(sourceText = '') {
  const source = String(sourceText);
  const acquireIndex = sourceIndex(source, 'const lock = acquireIntegrationDependencyGateLock');
  const busyBranchIndex = sourceIndex(source, 'if (!lock.ok)');
  const busyReturnIndex = busyBranchIndex >= 0 ? sourceIndex(source, 'return;', busyBranchIndex) : -1;
  const gateBuildIndex = sourceIndex(source, 'const gate = buildIntegrationDependencyGate();');
  const reportWriteIndex = sourceIndex(source, 'const reportFiles = writeReports(gate);');
  const releaseIndex = sourceIndex(source, 'lockReleased = releaseIntegrationDependencyGateLock(lock);');
  const stdoutIndex = sourceIndex(source, 'process.stdout.write(`${JSON.stringify(summary');
  const finallyIndex = sourceIndex(source, 'finally {');
  const fallbackReleaseIndex = finallyIndex >= 0
    ? sourceIndex(source, 'if (!lockReleased) releaseIntegrationDependencyGateLock(lock);', finallyIndex)
    : -1;
  const busyBranchBody = busyBranchIndex >= 0 && busyReturnIndex >= 0
    ? source.slice(busyBranchIndex, busyReturnIndex)
    : '';

  const blockers = [
    ...(acquireIndex < 0 ? [{
      code: 'integration_gate_sequence_lock_acquire_missing',
      notes: 'integration-dependency-gate.mjs must acquire the local gate lock before building reports.',
    }] : []),
    ...(busyBranchIndex < 0 ? [{
      code: 'integration_gate_sequence_lock_busy_branch_missing',
      notes: 'integration-dependency-gate.mjs must fail fast when the local gate lock is busy.',
    }] : []),
    ...(busyBranchIndex >= 0 && busyReturnIndex < 0 ? [{
      code: 'integration_gate_sequence_lock_busy_return_missing',
      notes: 'integration-dependency-gate.mjs busy lock branch must return before report generation.',
    }] : []),
    ...(/writeReports\s*\(/.test(busyBranchBody) ? [{
      code: 'integration_gate_sequence_lock_busy_writes_report',
      notes: 'integration-dependency-gate.mjs busy lock branch must not write latest reports.',
    }] : []),
    ...(gateBuildIndex < 0 ? [{
      code: 'integration_gate_sequence_gate_build_missing',
      notes: 'integration-dependency-gate.mjs must build the integration dependency gate after acquiring the lock.',
    }] : []),
    ...(reportWriteIndex < 0 ? [{
      code: 'integration_gate_sequence_report_write_missing',
      notes: 'integration-dependency-gate.mjs must write latest reports before stdout summary.',
    }] : []),
    ...(!(reportWriteIndex >= 0 && releaseIndex > reportWriteIndex && stdoutIndex > releaseIndex) ? [{
      code: 'integration_gate_sequence_lock_release_before_stdout_missing',
      notes: 'integration-dependency-gate.mjs must release the local gate lock after writing reports and before printing stdout.',
    }] : []),
    ...(fallbackReleaseIndex < 0 ? [{
      code: 'integration_gate_sequence_lock_finally_release_fallback_missing',
      notes: 'integration-dependency-gate.mjs must retain a finally release fallback for exceptions before normal release.',
    }] : []),
  ];

  return {
    status: blockers.length ? 'blocked_integration_gate_lifecycle_analysis' : 'pass_integration_gate_lifecycle_analysis',
    ok: blockers.length === 0,
    acquireIndex,
    busyBranchIndex,
    busyReturnIndex,
    gateBuildIndex,
    reportWriteIndex,
    releaseIndex,
    stdoutIndex,
    finallyIndex,
    fallbackReleaseIndex,
    writesReportWhileBusy: /writeReports\s*\(/.test(busyBranchBody),
    releaseBeforeStdout: reportWriteIndex >= 0 && releaseIndex > reportWriteIndex && stdoutIndex > releaseIndex,
    finallyReleaseFallback: fallbackReleaseIndex >= 0,
    blockers,
  };
}

function compactAnalysis(analysis) {
  return {
    status: analysis.status,
    ok: analysis.ok === true,
    stepCount: analysis.stepCount,
    requiredStepCount: analysis.requiredStepCount,
    blockers: analysis.blockers.map((item) => ({
      code: item.code,
      stepId: item.stepId || null,
      previousStepId: item.previousStepId || null,
      arg: item.arg || null,
    })),
  };
}

function compactLifecycleAnalysis(analysis) {
  return {
    status: analysis.status,
    ok: analysis.ok === true,
    releaseBeforeStdout: analysis.releaseBeforeStdout === true,
    writesReportWhileBusy: analysis.writesReportWhileBusy === true,
    finallyReleaseFallback: analysis.finallyReleaseFallback === true,
    blockers: analysis.blockers.map((item) => ({
      code: item.code,
    })),
  };
}

function runScenario(scenario, baselineSteps) {
  const steps = scenario.mutate(baselineSteps.map((step) => ({ ...step, args: [...step.args] })));
  const analysis = analyzeIntegrationGateSequence(steps);
  const observedBlockerCodes = analysis.blockers.map((item) => item.code);
  const blockers = [
    ...(analysis.ok === true ? [{
      code: 'integration_gate_sequence_regression_scenario_unexpectedly_passed',
      notes: `${scenario.scenarioId} must make integration gate sequence analysis fail.`,
    }] : []),
    ...(!observedBlockerCodes.includes(scenario.expectedBlockerCode) ? [{
      code: 'integration_gate_sequence_regression_expected_blocker_missing',
      notes: `${scenario.scenarioId} expected ${scenario.expectedBlockerCode}, got ${observedBlockerCodes.join(', ') || 'none'}.`,
    }] : []),
  ];
  return {
    scenarioId: scenario.scenarioId,
    label: scenario.label,
    status: blockers.length ? 'blocked_integration_gate_sequence_regression_scenario' : 'pass_integration_gate_sequence_regression_scenario',
    ok: blockers.length === 0,
    expectedBlockerCode: scenario.expectedBlockerCode,
    observedBlockerCodes,
    analysis: compactAnalysis(analysis),
    blockers,
  };
}

function runSourceScenario(scenario, sourceText) {
  const analysis = analyzeIntegrationGateLifecycle(scenario.mutateSource(sourceText));
  const observedBlockerCodes = analysis.blockers.map((item) => item.code);
  const blockers = [
    ...(analysis.ok === true ? [{
      code: 'integration_gate_sequence_source_scenario_unexpectedly_passed',
      notes: `${scenario.scenarioId} must make integration gate lifecycle analysis fail.`,
    }] : []),
    ...(!observedBlockerCodes.includes(scenario.expectedBlockerCode) ? [{
      code: 'integration_gate_sequence_source_expected_blocker_missing',
      notes: `${scenario.scenarioId} expected ${scenario.expectedBlockerCode}, got ${observedBlockerCodes.join(', ') || 'none'}.`,
    }] : []),
  ];
  return {
    scenarioId: scenario.scenarioId,
    label: scenario.label,
    scenarioKind: 'source_lifecycle',
    status: blockers.length ? 'blocked_integration_gate_lifecycle_regression_scenario' : 'pass_integration_gate_lifecycle_regression_scenario',
    ok: blockers.length === 0,
    expectedBlockerCode: scenario.expectedBlockerCode,
    observedBlockerCodes,
    analysis: compactLifecycleAnalysis(analysis),
    blockers,
  };
}

export function buildIntegrationGateSequenceRegressionReport({
  sourceText = '',
  generatedAt = new Date().toISOString(),
} = {}) {
  const steps = extractIntegrationGateStepSpecs(sourceText);
  const actual = analyzeIntegrationGateSequence(steps);
  const lifecycle = analyzeIntegrationGateLifecycle(sourceText);
  const sequenceScenarios = NEGATIVE_SCENARIOS.map((scenario) => runScenario(scenario, steps));
  const sourceScenarios = SOURCE_NEGATIVE_SCENARIOS.map((scenario) => runSourceScenario(scenario, sourceText));
  const scenarios = [
    ...sequenceScenarios.map((scenario) => ({ ...scenario, scenarioKind: 'step_sequence' })),
    ...sourceScenarios,
  ];
  const blockers = [
    ...actual.blockers.map((item) => ({
      ...item,
      source: 'actual_sequence',
    })),
    ...lifecycle.blockers.map((item) => ({
      ...item,
      source: 'actual_lifecycle',
    })),
    ...scenarios.flatMap((scenario) => scenario.blockers.map((item) => ({
      ...item,
      source: 'negative_scenario',
      scenarioId: scenario.scenarioId,
    }))),
  ];
  const report = {
    version: INTEGRATION_GATE_SEQUENCE_REGRESSION_VERSION,
    kind: 'IntegrationGateSequenceRegression',
    status: blockers.length ? 'blocked_integration_gate_sequence_regression' : 'pass_integration_gate_sequence_regression',
    ok: blockers.length === 0,
    generatedAt,
    fixture: {
      expectedOrder: [...EXPECTED_ORDER],
      requiredStepArgs: Object.fromEntries(Object.entries(REQUIRED_STEP_ARGS).map(([stepId, args]) => [stepId, [...args]])),
      expectedScenarioCount: scenarios.length,
      sequenceScenarioCount: NEGATIVE_SCENARIOS.length,
      sourceScenarioCount: SOURCE_NEGATIVE_SCENARIOS.length,
      scenarioIds: scenarios.map((scenario) => scenario.scenarioId),
      expectedBlockerCodes: scenarios.map((scenario) => scenario.expectedBlockerCode),
    },
    actual: compactAnalysis(actual),
    lifecycle: compactLifecycleAnalysis(lifecycle),
    scenarios,
    summary: {
      actualOk: actual.ok === true,
      lifecycleOk: lifecycle.ok === true,
      lifecycleReleaseBeforeStdout: lifecycle.releaseBeforeStdout === true,
      lifecycleFinallyReleaseFallback: lifecycle.finallyReleaseFallback === true,
      lifecycleWritesReportWhileBusy: lifecycle.writesReportWhileBusy === true,
      actualStepCount: actual.stepCount,
      expectedScenarioCount: scenarios.length,
      scenarioCount: scenarios.length,
      passedScenarioCount: scenarios.filter((scenario) => scenario.ok).length,
      failedScenarioCount: scenarios.filter((scenario) => !scenario.ok).length,
      observedExpectedBlockerCount: scenarios.filter((scenario) => (
        scenario.observedBlockerCodes.includes(scenario.expectedBlockerCode)
      )).length,
      blockerCount: blockers.length,
    },
    blockers,
    safety: {
      localOnly: true,
      readOnly: true,
      syntheticFixtureOnly: true,
      sourceInspectionOnly: true,
      mutatesReportFiles: false,
      executesExternalAction: false,
      providerSpend: false,
      browserAutomation: false,
      upload: false,
      submit: false,
      messaging: false,
      payment: false,
      acceptance: false,
      deployment: false,
      fetchesChannelState: false,
      appliesLocalStateTransition: false,
      grantsExecutionPermission: false,
    },
  };
  const sequenceRegressionHash = digest({
    version: report.version,
    kind: report.kind,
    status: report.status,
    fixture: report.fixture,
    actual: report.actual,
    lifecycle: report.lifecycle,
    scenarios: report.scenarios.map((scenario) => ({
      scenarioId: scenario.scenarioId,
      scenarioKind: scenario.scenarioKind,
      status: scenario.status,
      ok: scenario.ok,
      expectedBlockerCode: scenario.expectedBlockerCode,
      observedBlockerCodes: scenario.observedBlockerCodes,
      analysis: scenario.analysis,
      blockers: scenario.blockers,
    })),
    summary: report.summary,
    blockers: report.blockers,
    safety: report.safety,
  });
  return {
    ...report,
    sequenceRegressionHash,
    hash: sequenceRegressionHash,
  };
}

export function summarizeIntegrationGateSequenceRegressionReport(report) {
  return {
    version: report?.version || null,
    status: report?.status || 'missing_integration_gate_sequence_regression',
    ok: report?.ok === true,
    sequenceRegressionHash: report?.sequenceRegressionHash || null,
    actualOk: report?.summary?.actualOk === true,
    lifecycleOk: report?.summary?.lifecycleOk === true,
    lifecycleReleaseBeforeStdout: report?.summary?.lifecycleReleaseBeforeStdout === true,
    lifecycleFinallyReleaseFallback: report?.summary?.lifecycleFinallyReleaseFallback === true,
    lifecycleWritesReportWhileBusy: report?.summary?.lifecycleWritesReportWhileBusy === true,
    actualStepCount: report?.summary?.actualStepCount || 0,
    scenarioCount: report?.summary?.scenarioCount || 0,
    passedScenarioCount: report?.summary?.passedScenarioCount || 0,
    failedScenarioCount: report?.summary?.failedScenarioCount || 0,
    observedExpectedBlockerCount: report?.summary?.observedExpectedBlockerCount || 0,
    blockerCount: report?.summary?.blockerCount || 0,
    safety: {
      localOnly: report?.safety?.localOnly === true,
      readOnly: report?.safety?.readOnly === true,
      syntheticFixtureOnly: report?.safety?.syntheticFixtureOnly === true,
      sourceInspectionOnly: report?.safety?.sourceInspectionOnly === true,
      mutatesReportFiles: report?.safety?.mutatesReportFiles === true,
      executesExternalAction: report?.safety?.executesExternalAction === true,
    },
  };
}
