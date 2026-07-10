import { digest } from './hash-utils.mjs';
import {
  extractIntegrationGateStepSpecs,
} from './integration-gate-sequence-regression.mjs';
import {
  extractCheckpointReportBindings,
  extractGateSummaryHashKeys,
} from './report-inventory-consistency.mjs';

export const REPORT_LINEAGE_TOPOLOGY_VERSION = 1;

export const REPORT_LINEAGE_TOPOLOGY_REPORT_FILE_ID = 'report-lineage-topology-latest.json';

export const REPORT_LINEAGE_TOPOLOGY_SCRIPT_ID = 'reports:lineage-topology';

export const REPORT_LINEAGE_TOPOLOGY_NODES = Object.freeze([
  Object.freeze({
    nodeId: 'report_freshness_regression',
    fileId: 'report-freshness-regression-latest.json',
    scriptId: 'reports:freshness-regression',
    stepId: 'report_freshness_regression_export',
    hashKey: 'reportFreshnessRegressionHash',
    dependsOn: Object.freeze([]),
  }),
  Object.freeze({
    nodeId: 'report_retention_regression',
    fileId: 'report-retention-regression-latest.json',
    scriptId: 'reports:retention-regression',
    stepId: 'report_retention_regression_export',
    hashKey: 'reportRetentionRegressionHash',
    dependsOn: Object.freeze([]),
  }),
  Object.freeze({
    nodeId: 'integration_gate_sequence_regression',
    fileId: 'integration-gate-sequence-regression-latest.json',
    scriptId: 'reports:gate-sequence-regression',
    stepId: 'integration_gate_sequence_regression_export',
    hashKey: 'integrationGateSequenceRegressionHash',
    dependsOn: Object.freeze([
      'report_freshness_regression',
      'report_retention_regression',
    ]),
  }),
  Object.freeze({
    nodeId: 'report_inventory_consistency',
    fileId: 'report-inventory-consistency-latest.json',
    scriptId: 'reports:inventory-consistency',
    stepId: 'report_inventory_consistency_export',
    hashKey: 'reportInventoryConsistencyHash',
    dependsOn: Object.freeze(['integration_gate_sequence_regression']),
  }),
  Object.freeze({
    nodeId: 'report_schema_contract',
    fileId: 'report-schema-contract-latest.json',
    scriptId: 'reports:schema-contract',
    stepId: 'report_schema_contract_export',
    hashKey: 'reportSchemaContractHash',
    dependsOn: Object.freeze(['report_inventory_consistency']),
  }),
  Object.freeze({
    nodeId: 'report_lineage_topology',
    fileId: REPORT_LINEAGE_TOPOLOGY_REPORT_FILE_ID,
    scriptId: REPORT_LINEAGE_TOPOLOGY_SCRIPT_ID,
    stepId: 'report_lineage_topology_export',
    hashKey: 'reportLineageTopologyHash',
    selfReferenceMode: 'schema_contract_reads_previous_latest_then_lineage_refreshes',
    dependsOn: Object.freeze(['report_schema_contract']),
  }),
  Object.freeze({
    nodeId: 'report_hash_stability_regression',
    fileId: 'report-hash-stability-regression-latest.json',
    scriptId: 'reports:hash-stability-regression',
    stepId: 'report_hash_stability_regression_export',
    hashKey: 'reportHashStabilityRegressionHash',
    selfReferenceMode: 'schema_contract_reads_previous_latest_then_hash_stability_refreshes',
    dependsOn: Object.freeze(['report_lineage_topology']),
  }),
  Object.freeze({
    nodeId: 'report_output_pairing',
    fileId: 'report-output-pairing-latest.json',
    scriptId: 'reports:output-pairing',
    stepId: 'report_output_pairing_export',
    hashKey: 'reportOutputPairingHash',
    selfReferenceMode: 'schema_contract_reads_previous_latest_then_output_pairing_refreshes',
    dependsOn: Object.freeze(['report_hash_stability_regression']),
  }),
  Object.freeze({
    nodeId: 'report_artifact_reproducibility',
    fileId: 'report-artifact-reproducibility-latest.json',
    scriptId: 'reports:artifact-reproducibility',
    stepId: 'report_artifact_reproducibility_export',
    hashKey: 'reportArtifactReproducibilityHash',
    selfReferenceMode: 'schema_contract_reads_previous_latest_then_artifact_reproducibility_refreshes',
    dependsOn: Object.freeze(['report_output_pairing']),
  }),
  Object.freeze({
    nodeId: 'report_self_reference_boundary_regression',
    fileId: 'report-self-reference-boundary-regression-latest.json',
    scriptId: 'reports:self-reference-boundary-regression',
    stepId: 'report_self_reference_boundary_regression_export',
    hashKey: 'reportSelfReferenceBoundaryRegressionHash',
    selfReferenceMode: 'proves_mid_gate_observation_vs_final_freshness_blockers',
    dependsOn: Object.freeze(['report_artifact_reproducibility']),
  }),
  Object.freeze({
    nodeId: 'report_gate_clean_rerun_regression',
    fileId: 'report-gate-clean-rerun-regression-latest.json',
    scriptId: 'reports:gate-clean-rerun-regression',
    stepId: 'report_gate_clean_rerun_regression_export',
    hashKey: 'reportGateCleanRerunRegressionHash',
    selfReferenceMode: 'proves_clean_gate_rerun_skips_bootstrap_seeds_without_leaks',
    dependsOn: Object.freeze(['report_bootstrap_seed_regression']),
  }),
  Object.freeze({
    nodeId: 'report_clean_gate_idempotence_regression',
    fileId: 'report-clean-gate-idempotence-regression-latest.json',
    scriptId: 'reports:clean-gate-idempotence-regression',
    stepId: 'report_clean_gate_idempotence_regression_export',
    hashKey: 'reportCleanGateIdempotenceRegressionHash',
    selfReferenceMode: 'proves_two_clean_gate_reruns_keep_semantic_hashes_and_seed_skips_stable',
    dependsOn: Object.freeze(['report_gate_clean_rerun_regression']),
  }),
  Object.freeze({
    nodeId: 'report_runner_contract_regression',
    fileId: 'report-runner-contract-regression-latest.json',
    scriptId: 'reports:runner-contract-regression',
    stepId: 'report_runner_contract_regression_export',
    hashKey: 'reportRunnerContractRegressionHash',
    selfReferenceMode: 'proves_report_exporter_gate_runner_contracts_before_child_freshness',
    dependsOn: Object.freeze(['report_closeout_command_inventory_regression']),
  }),
  Object.freeze({
    nodeId: 'runtime_dry_run_harness',
    fileId: 'runtime-dry-run-harness-latest.json',
    scriptId: 'runtime:dry-run-harness',
    stepId: 'runtime_dry_run_harness_export',
    hashKey: 'runtimeDryRunHarnessHash',
    selfReferenceMode: 'proves_external_runner_handoff_reaches_sdk_boundary_without_core_execution',
    dependsOn: Object.freeze(['report_runner_contract_regression']),
  }),
  Object.freeze({
    nodeId: 'channel_runner_coverage_matrix',
    fileId: 'channel-runner-coverage-matrix-latest.json',
    scriptId: 'runtime:channel-runner-coverage-matrix',
    stepId: 'channel_runner_coverage_matrix_export',
    hashKey: 'channelRunnerCoverageMatrixHash',
    selfReferenceMode: 'classifies_runtime_ready_routes_against_local_live_runner_entrypoints',
    dependsOn: Object.freeze(['runtime_dry_run_harness']),
  }),
  Object.freeze({
    nodeId: 'post_action_evidence_matrix',
    fileId: 'post-action-evidence-matrix-latest.json',
    scriptId: 'runtime:post-action-evidence-matrix',
    stepId: 'post_action_evidence_matrix_export',
    hashKey: 'postActionEvidenceMatrixHash',
    selfReferenceMode: 'proves_action_specific_receipt_and_state_proof_fields_with_synthetic_post_action_evidence',
    dependsOn: Object.freeze(['channel_runner_coverage_matrix']),
  }),
  Object.freeze({
    nodeId: 'post_action_audit_bundle_matrix',
    fileId: 'post-action-audit-bundle-matrix-latest.json',
    scriptId: 'runtime:post-action-audit-bundle-matrix',
    stepId: 'post_action_audit_bundle_matrix_export',
    hashKey: 'postActionAuditBundleMatrixHash',
    selfReferenceMode: 'proves_post_action_inbox_ledger_and_audit_bundle_closure_with_synthetic_evidence',
    dependsOn: Object.freeze(['post_action_evidence_matrix']),
  }),
  Object.freeze({
    nodeId: 'post_action_audit_archive_matrix',
    fileId: 'post-action-audit-archive-matrix-latest.json',
    scriptId: 'runtime:post-action-audit-archive-matrix',
    stepId: 'post_action_audit_archive_matrix_export',
    hashKey: 'postActionAuditArchiveMatrixHash',
    selfReferenceMode: 'proves_post_action_audit_archive_index_closure_with_synthetic_evidence',
    dependsOn: Object.freeze(['post_action_audit_bundle_matrix']),
  }),
  Object.freeze({
    nodeId: 'post_action_replay_guard_matrix',
    fileId: 'post-action-replay-guard-matrix-latest.json',
    scriptId: 'runtime:post-action-replay-guard-matrix',
    stepId: 'post_action_replay_guard_matrix_export',
    hashKey: 'postActionReplayGuardMatrixHash',
    selfReferenceMode: 'proves_post_action_archive_backed_replay_guard_closure_with_synthetic_evidence',
    dependsOn: Object.freeze(['post_action_audit_archive_matrix']),
  }),
  Object.freeze({
    nodeId: 'post_action_dispatch_envelope_matrix',
    fileId: 'post-action-dispatch-envelope-matrix-latest.json',
    scriptId: 'runtime:post-action-dispatch-envelope-matrix',
    stepId: 'post_action_dispatch_envelope_matrix_export',
    hashKey: 'postActionDispatchEnvelopeMatrixHash',
    selfReferenceMode: 'proves_post_action_dispatch_envelope_handoff_closure_with_synthetic_evidence',
    dependsOn: Object.freeze(['post_action_replay_guard_matrix']),
  }),
  Object.freeze({
    nodeId: 'post_action_dispatch_completion_matrix',
    fileId: 'post-action-dispatch-completion-matrix-latest.json',
    scriptId: 'runtime:post-action-dispatch-completion-matrix',
    stepId: 'post_action_dispatch_completion_matrix_export',
    hashKey: 'postActionDispatchCompletionMatrixHash',
    selfReferenceMode: 'proves_post_action_dispatch_completion_evidence_closure_with_synthetic_evidence',
    dependsOn: Object.freeze(['post_action_dispatch_envelope_matrix']),
  }),
  Object.freeze({
    nodeId: 'post_action_reconciliation_matrix',
    fileId: 'post-action-reconciliation-matrix-latest.json',
    scriptId: 'runtime:post-action-reconciliation-matrix',
    stepId: 'post_action_reconciliation_matrix_export',
    hashKey: 'postActionReconciliationMatrixHash',
    selfReferenceMode: 'proves_post_action_dispatch_completion_archive_reconciliation_with_synthetic_evidence',
    dependsOn: Object.freeze(['post_action_dispatch_completion_matrix']),
  }),
  Object.freeze({
    nodeId: 'post_action_runtime_status',
    fileId: 'post-action-runtime-status-latest.json',
    scriptId: 'runtime:post-action-runtime-status',
    stepId: 'post_action_runtime_status_export',
    hashKey: 'postActionRuntimeStatusHash',
    selfReferenceMode: 'summarizes_full_post_action_runtime_proof_chain_without_execution_permission',
    dependsOn: Object.freeze(['post_action_reconciliation_matrix']),
  }),
  Object.freeze({
    nodeId: 'report_final_settlement_regression',
    fileId: 'report-final-settlement-regression-latest.json',
    scriptId: 'reports:final-settlement-regression',
    stepId: 'report_final_settlement_regression_export',
    hashKey: 'reportFinalSettlementRegressionHash',
    selfReferenceMode: 'proves_final_gate_freshness_checkpoint_and_clean_seed_closeout_order',
    dependsOn: Object.freeze(['report_clean_gate_idempotence_regression']),
  }),
  Object.freeze({
    nodeId: 'report_post_final_drift_regression',
    fileId: 'report-post-final-drift-regression-latest.json',
    scriptId: 'reports:post-final-drift-regression',
    stepId: 'report_post_final_drift_regression_export',
    hashKey: 'reportPostFinalDriftRegressionHash',
    selfReferenceMode: 'proves_post_final_latest_writes_are_blocked_until_clean_closeout_reruns',
    dependsOn: Object.freeze(['report_final_settlement_regression']),
  }),
  Object.freeze({
    nodeId: 'report_closeout_drift_classification_regression',
    fileId: 'report-closeout-drift-classification-regression-latest.json',
    scriptId: 'reports:closeout-drift-classification-regression',
    stepId: 'report_closeout_drift_classification_regression_export',
    hashKey: 'reportCloseoutDriftClassificationRegressionHash',
    selfReferenceMode: 'classifies_post_final_commands_by_closeout_drift_risk',
    dependsOn: Object.freeze(['report_post_final_drift_regression']),
  }),
  Object.freeze({
    nodeId: 'report_closeout_command_inventory_regression',
    fileId: 'report-closeout-command-inventory-regression-latest.json',
    scriptId: 'reports:closeout-command-inventory-regression',
    stepId: 'report_closeout_command_inventory_regression_export',
    hashKey: 'reportCloseoutCommandInventoryRegressionHash',
    selfReferenceMode: 'proves_package_docs_and_gate_closeout_commands_match_classification_inventory',
    dependsOn: Object.freeze(['report_closeout_drift_classification_regression']),
  }),
  Object.freeze({
    nodeId: 'report_contract_manifest',
    fileId: 'report-contract-manifest-latest.json',
    scriptId: 'reports:contract-manifest',
    stepId: 'report_contract_manifest_export',
    hashKey: 'reportContractManifestHash',
    selfReferenceMode: 'central_manifest_source_for_report_exporter_contracts',
    dependsOn: Object.freeze(['report_self_reference_boundary_regression']),
  }),
  Object.freeze({
    nodeId: 'report_contract_required_coverage_regression',
    fileId: 'report-contract-required-coverage-regression-latest.json',
    scriptId: 'reports:contract-required-coverage-regression',
    stepId: 'report_contract_required_coverage_regression_export',
    hashKey: 'reportContractRequiredCoverageRegressionHash',
    selfReferenceMode: 'proves_manifest_contracts_are_required_or_explicitly_optional',
    dependsOn: Object.freeze(['report_contract_manifest']),
  }),
  Object.freeze({
    nodeId: 'report_contract_doc_coverage_regression',
    fileId: 'report-contract-doc-coverage-regression-latest.json',
    scriptId: 'reports:contract-doc-coverage-regression',
    stepId: 'report_contract_doc_coverage_regression_export',
    hashKey: 'reportContractDocCoverageRegressionHash',
    selfReferenceMode: 'proves_manifest_contracts_have_docs_and_readme_coverage',
    dependsOn: Object.freeze(['report_contract_required_coverage_regression']),
  }),
  Object.freeze({
    nodeId: 'report_contract_syntax_coverage_regression',
    fileId: 'report-contract-syntax-coverage-regression-latest.json',
    scriptId: 'reports:contract-syntax-coverage-regression',
    stepId: 'report_contract_syntax_coverage_regression_export',
    hashKey: 'reportContractSyntaxCoverageRegressionHash',
    selfReferenceMode: 'proves_manifest_contracts_have_source_and_exporter_syntax_checks_before_export',
    dependsOn: Object.freeze(['report_contract_doc_coverage_regression']),
  }),
  Object.freeze({
    nodeId: 'report_contract_source_derivation_regression',
    fileId: 'report-contract-source-derivation-regression-latest.json',
    scriptId: 'reports:contract-source-derivation-regression',
    stepId: 'report_contract_source_derivation_regression_export',
    hashKey: 'reportContractSourceDerivationRegressionHash',
    selfReferenceMode: 'proves_manifest_contract_ids_derive_canonical_source_exporter_docs_report_and_hash_fields',
    dependsOn: Object.freeze(['report_contract_syntax_coverage_regression']),
  }),
  Object.freeze({
    nodeId: 'report_contract_summary_key_regression',
    fileId: 'report-contract-summary-key-regression-latest.json',
    scriptId: 'reports:contract-summary-key-regression',
    stepId: 'report_contract_summary_key_regression_export',
    hashKey: 'reportContractSummaryKeyRegressionHash',
    selfReferenceMode: 'proves_manifest_contracts_reach_gate_checkpoint_audit_and_selftest_observation_keys',
    dependsOn: Object.freeze(['report_contract_source_derivation_regression']),
  }),
  Object.freeze({
    nodeId: 'report_contract_audit_forwarding_regression',
    fileId: 'report-contract-audit-forwarding-regression-latest.json',
    scriptId: 'reports:contract-audit-forwarding-regression',
    stepId: 'report_contract_audit_forwarding_regression_export',
    hashKey: 'reportContractAuditForwardingRegressionHash',
    selfReferenceMode: 'proves_manifest_contract_blockers_are_forwarded_into_integration_audit',
    dependsOn: Object.freeze(['report_contract_summary_key_regression']),
  }),
  Object.freeze({
    nodeId: 'report_contract_checkpoint_binding_shape_regression',
    fileId: 'report-contract-checkpoint-binding-shape-regression-latest.json',
    scriptId: 'reports:contract-checkpoint-binding-shape-regression',
    stepId: 'report_contract_checkpoint_binding_shape_regression_export',
    hashKey: 'reportContractCheckpointBindingShapeRegressionHash',
    selfReferenceMode: 'proves_manifest_contract_checkpoint_bindings_have_canonical_shape',
    dependsOn: Object.freeze(['report_contract_audit_forwarding_regression']),
  }),
  Object.freeze({
    nodeId: 'report_contract_gate_summary_shape_regression',
    fileId: 'report-contract-gate-summary-shape-regression-latest.json',
    scriptId: 'reports:contract-gate-summary-shape-regression',
    stepId: 'report_contract_gate_summary_shape_regression_export',
    hashKey: 'reportContractGateSummaryShapeRegressionHash',
    selfReferenceMode: 'proves_manifest_contract_gate_summary_keys_have_canonical_shape',
    dependsOn: Object.freeze(['report_contract_checkpoint_binding_shape_regression']),
  }),
  Object.freeze({
    nodeId: 'report_contract_exporter_stdout_shape_regression',
    fileId: 'report-contract-exporter-stdout-shape-regression-latest.json',
    scriptId: 'reports:contract-exporter-stdout-shape-regression',
    stepId: 'report_contract_exporter_stdout_shape_regression_export',
    hashKey: 'reportContractExporterStdoutShapeRegressionHash',
    selfReferenceMode: 'proves_manifest_contract_exporter_stdout_has_canonical_shape',
    dependsOn: Object.freeze(['report_contract_gate_summary_shape_regression']),
  }),
  Object.freeze({
    nodeId: 'report_contract_safety_flag_regression',
    fileId: 'report-contract-safety-flag-regression-latest.json',
    scriptId: 'reports:contract-safety-flag-regression',
    stepId: 'report_contract_safety_flag_regression_export',
    hashKey: 'reportContractSafetyFlagRegressionHash',
    selfReferenceMode: 'proves_manifest_contract_latest_reports_have_canonical_safety_flags',
    dependsOn: Object.freeze(['report_contract_exporter_stdout_shape_regression']),
  }),
  Object.freeze({
    nodeId: 'report_contract_artifact_binding_regression',
    fileId: 'report-contract-artifact-binding-regression-latest.json',
    scriptId: 'reports:contract-artifact-binding-regression',
    stepId: 'report_contract_artifact_binding_regression_export',
    hashKey: 'reportContractArtifactBindingRegressionHash',
    selfReferenceMode: 'proves_manifest_contract_latest_artifacts_are_cross_report_bound',
    dependsOn: Object.freeze(['report_contract_safety_flag_regression']),
  }),
  Object.freeze({
    nodeId: 'report_contract_doc_index_anchor_regression',
    fileId: 'report-contract-doc-index-anchor-regression-latest.json',
    scriptId: 'reports:contract-doc-index-anchor-regression',
    stepId: 'report_contract_doc_index_anchor_regression_export',
    hashKey: 'reportContractDocIndexAnchorRegressionHash',
    selfReferenceMode: 'proves_manifest_contract_doc_indexes_have_canonical_anchors_and_commands',
    dependsOn: Object.freeze(['report_contract_artifact_binding_regression']),
  }),
  Object.freeze({
    nodeId: 'report_contract_doc_page_latest_detail_regression',
    fileId: 'report-contract-doc-page-latest-detail-regression-latest.json',
    scriptId: 'reports:contract-doc-page-latest-detail-regression',
    stepId: 'report_contract_doc_page_latest_detail_regression_export',
    hashKey: 'reportContractDocPageLatestDetailRegressionHash',
    selfReferenceMode: 'proves_manifest_contract_doc_pages_name_exact_latest_artifacts',
    dependsOn: Object.freeze(['report_contract_doc_index_anchor_regression']),
  }),
  Object.freeze({
    nodeId: 'report_contract_doc_page_command_section_regression',
    fileId: 'report-contract-doc-page-command-section-regression-latest.json',
    scriptId: 'reports:contract-doc-page-command-section-regression',
    stepId: 'report_contract_doc_page_command_section_regression_export',
    hashKey: 'reportContractDocPageCommandSectionRegressionHash',
    selfReferenceMode: 'proves_manifest_contract_doc_pages_keep_executable_command_sections',
    dependsOn: Object.freeze(['report_contract_doc_page_latest_detail_regression']),
  }),
  Object.freeze({
    nodeId: 'report_contract_doc_page_safety_section_detail_regression',
    fileId: 'report-contract-doc-page-safety-section-detail-regression-latest.json',
    scriptId: 'reports:contract-doc-page-safety-section-detail-regression',
    stepId: 'report_contract_doc_page_safety_section_detail_regression_export',
    hashKey: 'reportContractDocPageSafetySectionDetailRegressionHash',
    selfReferenceMode: 'proves_manifest_contract_doc_pages_keep_native_safety_section_details',
    dependsOn: Object.freeze(['report_contract_doc_page_command_section_regression']),
  }),
  Object.freeze({
    nodeId: 'report_contract_doc_page_strict_gate_section_regression',
    fileId: 'report-contract-doc-page-strict-gate-section-regression-latest.json',
    scriptId: 'reports:contract-doc-page-strict-gate-section-regression',
    stepId: 'report_contract_doc_page_strict_gate_section_regression_export',
    hashKey: 'reportContractDocPageStrictGateSectionRegressionHash',
    selfReferenceMode: 'proves_manifest_contract_doc_pages_keep_native_strict_gate_section_details',
    dependsOn: Object.freeze(['report_contract_doc_page_safety_section_detail_regression']),
  }),
  Object.freeze({
    nodeId: 'report_contract_doc_page_output_section_regression',
    fileId: 'report-contract-doc-page-output-section-regression-latest.json',
    scriptId: 'reports:contract-doc-page-output-section-regression',
    stepId: 'report_contract_doc_page_output_section_regression_export',
    hashKey: 'reportContractDocPageOutputSectionRegressionHash',
    selfReferenceMode: 'proves_manifest_contract_doc_pages_keep_native_output_artifact_binding_details',
    dependsOn: Object.freeze(['report_contract_doc_page_strict_gate_section_regression']),
  }),
  Object.freeze({
    nodeId: 'report_contract_doc_page_cross_report_section_regression',
    fileId: 'report-contract-doc-page-cross-report-section-regression-latest.json',
    scriptId: 'reports:contract-doc-page-cross-report-section-regression',
    stepId: 'report_contract_doc_page_cross_report_section_regression_export',
    hashKey: 'reportContractDocPageCrossReportSectionRegressionHash',
    selfReferenceMode: 'proves_manifest_contract_doc_pages_keep_native_cross_report_visibility_details',
    dependsOn: Object.freeze(['report_contract_doc_page_output_section_regression']),
  }),
  Object.freeze({
    nodeId: 'report_contract_doc_page_closeout_section_regression',
    fileId: 'report-contract-doc-page-closeout-section-regression-latest.json',
    scriptId: 'reports:contract-doc-page-closeout-section-regression',
    stepId: 'report_contract_doc_page_closeout_section_regression_export',
    hashKey: 'reportContractDocPageCloseoutSectionRegressionHash',
    selfReferenceMode: 'proves_manifest_contract_doc_pages_keep_native_closeout_probe_details',
    dependsOn: Object.freeze(['report_contract_doc_page_cross_report_section_regression']),
  }),
  Object.freeze({
    nodeId: 'report_contract_doc_page_post_gate_writer_section_regression',
    fileId: 'report-contract-doc-page-post-gate-writer-section-regression-latest.json',
    scriptId: 'reports:contract-doc-page-post-gate-writer-section-regression',
    stepId: 'report_contract_doc_page_post_gate_writer_section_regression_export',
    hashKey: 'reportContractDocPagePostGateWriterSectionRegressionHash',
    selfReferenceMode: 'proves_manifest_contract_doc_pages_keep_native_post_gate_writer_recovery_details',
    dependsOn: Object.freeze(['report_contract_doc_page_closeout_section_regression']),
  }),
  Object.freeze({
    nodeId: 'report_contract_doc_page_retention_section_regression',
    fileId: 'report-contract-doc-page-retention-section-regression-latest.json',
    scriptId: 'reports:contract-doc-page-retention-section-regression',
    stepId: 'report_contract_doc_page_retention_section_regression_export',
    hashKey: 'reportContractDocPageRetentionSectionRegressionHash',
    selfReferenceMode: 'proves_manifest_contract_doc_pages_keep_native_retention_prune_details',
    dependsOn: Object.freeze(['report_contract_doc_page_post_gate_writer_section_regression']),
  }),
  Object.freeze({
    nodeId: 'report_contract_doc_page_freshness_hash_section_regression',
    fileId: 'report-contract-doc-page-freshness-hash-section-regression-latest.json',
    scriptId: 'reports:contract-doc-page-freshness-hash-section-regression',
    stepId: 'report_contract_doc_page_freshness_hash_section_regression_export',
    hashKey: 'reportContractDocPageFreshnessHashSectionRegressionHash',
    selfReferenceMode: 'proves_manifest_contract_doc_pages_keep_native_freshness_hash_parity_details',
    dependsOn: Object.freeze(['report_contract_doc_page_retention_section_regression']),
  }),
  Object.freeze({
    nodeId: 'report_contract_doc_page_checkpoint_hash_section_regression',
    fileId: 'report-contract-doc-page-checkpoint-hash-section-regression-latest.json',
    scriptId: 'reports:contract-doc-page-checkpoint-hash-section-regression',
    stepId: 'report_contract_doc_page_checkpoint_hash_section_regression_export',
    hashKey: 'reportContractDocPageCheckpointHashSectionRegressionHash',
    selfReferenceMode: 'proves_manifest_contract_doc_pages_keep_native_checkpoint_hash_visibility_details',
    dependsOn: Object.freeze(['report_contract_doc_page_freshness_hash_section_regression']),
  }),
  Object.freeze({
    nodeId: 'report_contract_doc_page_bootstrap_seed_section_regression',
    fileId: 'report-contract-doc-page-bootstrap-seed-section-regression-latest.json',
    scriptId: 'reports:contract-doc-page-bootstrap-seed-section-regression',
    stepId: 'report_contract_doc_page_bootstrap_seed_section_regression_export',
    hashKey: 'reportContractDocPageBootstrapSeedSectionRegressionHash',
    selfReferenceMode: 'proves_manifest_contract_doc_pages_keep_native_bootstrap_seed_recovery_details',
    dependsOn: Object.freeze(['report_contract_doc_page_checkpoint_hash_section_regression']),
  }),
  Object.freeze({
    nodeId: 'report_contract_doc_page_clean_rerun_section_regression',
    fileId: 'report-contract-doc-page-clean-rerun-section-regression-latest.json',
    scriptId: 'reports:contract-doc-page-clean-rerun-section-regression',
    stepId: 'report_contract_doc_page_clean_rerun_section_regression_export',
    hashKey: 'reportContractDocPageCleanRerunSectionRegressionHash',
    selfReferenceMode: 'proves_manifest_contract_doc_pages_keep_native_clean_rerun_idempotence_details',
    dependsOn: Object.freeze(['report_contract_doc_page_bootstrap_seed_section_regression']),
  }),
  Object.freeze({
    nodeId: 'report_contract_doc_page_final_settlement_section_regression',
    fileId: 'report-contract-doc-page-final-settlement-section-regression-latest.json',
    scriptId: 'reports:contract-doc-page-final-settlement-section-regression',
    stepId: 'report_contract_doc_page_final_settlement_section_regression_export',
    hashKey: 'reportContractDocPageFinalSettlementSectionRegressionHash',
    selfReferenceMode: 'proves_manifest_contract_doc_pages_keep_native_final_settlement_closeout_order_details',
    dependsOn: Object.freeze(['report_contract_doc_page_clean_rerun_section_regression']),
  }),
  Object.freeze({
    nodeId: 'report_contract_doc_page_closeout_index_section_regression',
    fileId: 'report-contract-doc-page-closeout-index-section-regression-latest.json',
    scriptId: 'reports:contract-doc-page-closeout-index-section-regression',
    stepId: 'report_contract_doc_page_closeout_index_section_regression_export',
    hashKey: 'reportContractDocPageCloseoutIndexSectionRegressionHash',
    selfReferenceMode: 'proves_manifest_contract_doc_pages_keep_native_final_closeout_index_details',
    dependsOn: Object.freeze(['report_contract_doc_page_final_settlement_section_regression']),
  }),
  Object.freeze({
    nodeId: 'report_contract_doc_page_closeout_evidence_section_regression',
    fileId: 'report-contract-doc-page-closeout-evidence-section-regression-latest.json',
    scriptId: 'reports:contract-doc-page-closeout-evidence-section-regression',
    stepId: 'report_contract_doc_page_closeout_evidence_section_regression_export',
    hashKey: 'reportContractDocPageCloseoutEvidenceSectionRegressionHash',
    selfReferenceMode: 'proves_manifest_contract_doc_pages_keep_native_final_closeout_evidence_details',
    dependsOn: Object.freeze(['report_contract_doc_page_closeout_index_section_regression']),
  }),
  Object.freeze({
    nodeId: 'report_contract_doc_page_closeout_ledger_section_regression',
    fileId: 'report-contract-doc-page-closeout-ledger-section-regression-latest.json',
    scriptId: 'reports:contract-doc-page-closeout-ledger-section-regression',
    stepId: 'report_contract_doc_page_closeout_ledger_section_regression_export',
    hashKey: 'reportContractDocPageCloseoutLedgerSectionRegressionHash',
    selfReferenceMode: 'proves_manifest_contract_doc_pages_keep_native_final_closeout_ledger_details',
    dependsOn: Object.freeze(['report_contract_doc_page_closeout_evidence_section_regression']),
  }),
  Object.freeze({
    nodeId: 'report_contract_doc_page_closeout_retention_proof_section_regression',
    fileId: 'report-contract-doc-page-closeout-retention-proof-section-regression-latest.json',
    scriptId: 'reports:contract-doc-page-closeout-retention-proof-section-regression',
    stepId: 'report_contract_doc_page_closeout_retention_proof_section_regression_export',
    hashKey: 'reportContractDocPageCloseoutRetentionProofSectionRegressionHash',
    selfReferenceMode: 'proves_manifest_contract_doc_pages_keep_native_final_retention_proof_details',
    dependsOn: Object.freeze(['report_contract_doc_page_closeout_ledger_section_regression']),
  }),
  Object.freeze({
    nodeId: 'report_contract_doc_page_closeout_probe_bundle_section_regression',
    fileId: 'report-contract-doc-page-closeout-probe-bundle-section-regression-latest.json',
    scriptId: 'reports:contract-doc-page-closeout-probe-bundle-section-regression',
    stepId: 'report_contract_doc_page_closeout_probe_bundle_section_regression_export',
    hashKey: 'reportContractDocPageCloseoutProbeBundleSectionRegressionHash',
    selfReferenceMode: 'proves_manifest_contract_doc_pages_keep_native_final_closeout_probe_bundle_details',
    dependsOn: Object.freeze(['report_contract_doc_page_closeout_retention_proof_section_regression']),
  }),
  Object.freeze({
    nodeId: 'report_contract_doc_page_closeout_signoff_section_regression',
    fileId: 'report-contract-doc-page-closeout-signoff-section-regression-latest.json',
    scriptId: 'reports:contract-doc-page-closeout-signoff-section-regression',
    stepId: 'report_contract_doc_page_closeout_signoff_section_regression_export',
    hashKey: 'reportContractDocPageCloseoutSignoffSectionRegressionHash',
    selfReferenceMode: 'proves_manifest_contract_doc_pages_keep_native_final_closeout_signoff_details',
    dependsOn: Object.freeze(['report_contract_doc_page_closeout_probe_bundle_section_regression']),
  }),
  Object.freeze({
    nodeId: 'report_contract_doc_page_closeout_release_manifest_section_regression',
    fileId: 'report-contract-doc-page-closeout-release-manifest-section-regression-latest.json',
    scriptId: 'reports:contract-doc-page-closeout-release-manifest-section-regression',
    stepId: 'report_contract_doc_page_closeout_release_manifest_section_regression_export',
    hashKey: 'reportContractDocPageCloseoutReleaseManifestSectionRegressionHash',
    selfReferenceMode: 'proves_manifest_contract_doc_pages_keep_native_final_release_manifest_readiness',
    dependsOn: Object.freeze(['report_contract_doc_page_closeout_signoff_section_regression']),
  }),
  Object.freeze({
    nodeId: 'report_contract_doc_page_release_archive_index_section_regression',
    fileId: 'report-contract-doc-page-release-archive-index-section-regression-latest.json',
    scriptId: 'reports:contract-doc-page-release-archive-index-section-regression',
    stepId: 'report_contract_doc_page_release_archive_index_section_regression_export',
    hashKey: 'reportContractDocPageReleaseArchiveIndexSectionRegressionHash',
    selfReferenceMode: 'proves_manifest_contract_doc_pages_keep_native_release_archive_index_readiness',
    dependsOn: Object.freeze(['report_contract_doc_page_closeout_release_manifest_section_regression']),
  }),
  Object.freeze({
    nodeId: 'report_contract_doc_page_release_handoff_ledger_section_regression',
    fileId: 'report-contract-doc-page-release-handoff-ledger-section-regression-latest.json',
    scriptId: 'reports:contract-doc-page-release-handoff-ledger-section-regression',
    stepId: 'report_contract_doc_page_release_handoff_ledger_section_regression_export',
    hashKey: 'reportContractDocPageReleaseHandoffLedgerSectionRegressionHash',
    selfReferenceMode: 'proves_manifest_contract_doc_pages_keep_native_release_handoff_ledger_readiness',
    dependsOn: Object.freeze(['report_contract_doc_page_release_archive_index_section_regression']),
  }),
  Object.freeze({
    nodeId: 'report_contract_doc_page_release_delivery_readiness_section_regression',
    fileId: 'report-contract-doc-page-release-delivery-readiness-section-regression-latest.json',
    scriptId: 'reports:contract-doc-page-release-delivery-readiness-section-regression',
    stepId: 'report_contract_doc_page_release_delivery_readiness_section_regression_export',
    hashKey: 'reportContractDocPageReleaseDeliveryReadinessSectionRegressionHash',
    selfReferenceMode: 'proves_manifest_contract_doc_pages_keep_native_release_delivery_readiness',
    dependsOn: Object.freeze(['report_contract_doc_page_release_handoff_ledger_section_regression']),
  }),
  Object.freeze({
    nodeId: 'report_contract_doc_page_release_execution_denial_section_regression',
    fileId: 'report-contract-doc-page-release-execution-denial-section-regression-latest.json',
    scriptId: 'reports:contract-doc-page-release-execution-denial-section-regression',
    stepId: 'report_contract_doc_page_release_execution_denial_section_regression_export',
    hashKey: 'reportContractDocPageReleaseExecutionDenialSectionRegressionHash',
    selfReferenceMode: 'proves_manifest_contract_doc_pages_keep_native_release_execution_denial',
    dependsOn: Object.freeze(['report_contract_doc_page_release_delivery_readiness_section_regression']),
  }),
  Object.freeze({
    nodeId: 'report_contract_doc_page_release_operator_approval_section_regression',
    fileId: 'report-contract-doc-page-release-operator-approval-section-regression-latest.json',
    scriptId: 'reports:contract-doc-page-release-operator-approval-section-regression',
    stepId: 'report_contract_doc_page_release_operator_approval_section_regression_export',
    hashKey: 'reportContractDocPageReleaseOperatorApprovalSectionRegressionHash',
    selfReferenceMode: 'proves_manifest_contract_doc_pages_keep_native_release_operator_approval',
    dependsOn: Object.freeze(['report_contract_doc_page_release_execution_denial_section_regression']),
  }),
  Object.freeze({
    nodeId: 'report_contract_doc_page_release_approval_ledger_section_regression',
    fileId: 'report-contract-doc-page-release-approval-ledger-section-regression-latest.json',
    scriptId: 'reports:contract-doc-page-release-approval-ledger-section-regression',
    stepId: 'report_contract_doc_page_release_approval_ledger_section_regression_export',
    hashKey: 'reportContractDocPageReleaseApprovalLedgerSectionRegressionHash',
    selfReferenceMode: 'proves_manifest_contract_doc_pages_keep_native_release_approval_ledger',
    dependsOn: Object.freeze(['report_contract_doc_page_release_operator_approval_section_regression']),
  }),
  Object.freeze({
    nodeId: 'report_contract_doc_page_release_action_queue_section_regression',
    fileId: 'report-contract-doc-page-release-action-queue-section-regression-latest.json',
    scriptId: 'reports:contract-doc-page-release-action-queue-section-regression',
    stepId: 'report_contract_doc_page_release_action_queue_section_regression_export',
    hashKey: 'reportContractDocPageReleaseActionQueueSectionRegressionHash',
    selfReferenceMode: 'proves_manifest_contract_doc_pages_keep_native_release_action_queue',
    dependsOn: Object.freeze(['report_contract_doc_page_release_approval_ledger_section_regression']),
  }),
  Object.freeze({
    nodeId: 'report_contract_doc_page_release_runner_dispatch_denial_section_regression',
    fileId: 'report-contract-doc-page-release-runner-dispatch-denial-section-regression-latest.json',
    scriptId: 'reports:contract-doc-page-release-runner-dispatch-denial-section-regression',
    stepId: 'report_contract_doc_page_release_runner_dispatch_denial_section_regression_export',
    hashKey: 'reportContractDocPageReleaseRunnerDispatchDenialSectionRegressionHash',
    selfReferenceMode: 'proves_manifest_contract_doc_pages_keep_native_release_runner_dispatch_denial',
    dependsOn: Object.freeze(['report_contract_doc_page_release_action_queue_section_regression']),
  }),
  Object.freeze({
    nodeId: 'report_contract_doc_page_release_live_action_preflight_section_regression',
    fileId: 'report-contract-doc-page-release-live-action-preflight-section-regression-latest.json',
    scriptId: 'reports:contract-doc-page-release-live-action-preflight-section-regression',
    stepId: 'report_contract_doc_page_release_live_action_preflight_section_regression_export',
    hashKey: 'reportContractDocPageReleaseLiveActionPreflightSectionRegressionHash',
    selfReferenceMode: 'proves_manifest_contract_doc_pages_keep_native_release_live_action_preflight',
    dependsOn: Object.freeze(['report_contract_doc_page_release_runner_dispatch_denial_section_regression']),
  }),
  Object.freeze({
    nodeId: 'report_contract_doc_page_release_execution_intent_capture_section_regression',
    fileId: 'report-contract-doc-page-release-execution-intent-capture-section-regression-latest.json',
    scriptId: 'reports:contract-doc-page-release-execution-intent-capture-section-regression',
    stepId: 'report_contract_doc_page_release_execution_intent_capture_section_regression_export',
    hashKey: 'reportContractDocPageReleaseExecutionIntentCaptureSectionRegressionHash',
    selfReferenceMode: 'proves_manifest_contract_doc_pages_keep_native_release_execution_intent_capture',
    dependsOn: Object.freeze(['report_contract_doc_page_release_live_action_preflight_section_regression']),
  }),
  Object.freeze({
    nodeId: 'report_contract_doc_page_release_execution_approval_boundary_section_regression',
    fileId: 'report-contract-doc-page-release-execution-approval-boundary-section-regression-latest.json',
    scriptId: 'reports:contract-doc-page-release-execution-approval-boundary-section-regression',
    stepId: 'report_contract_doc_page_release_execution_approval_boundary_section_regression_export',
    hashKey: 'reportContractDocPageReleaseExecutionApprovalBoundarySectionRegressionHash',
    selfReferenceMode: 'proves_manifest_contract_doc_pages_keep_native_release_execution_approval_boundary',
    dependsOn: Object.freeze(['report_contract_doc_page_release_execution_intent_capture_section_regression']),
  }),
  Object.freeze({
    nodeId: 'report_contract_doc_page_release_runner_execution_gate_section_regression',
    fileId: 'report-contract-doc-page-release-runner-execution-gate-section-regression-latest.json',
    scriptId: 'reports:contract-doc-page-release-runner-execution-gate-section-regression',
    stepId: 'report_contract_doc_page_release_runner_execution_gate_section_regression_export',
    hashKey: 'reportContractDocPageReleaseRunnerExecutionGateSectionRegressionHash',
    selfReferenceMode: 'proves_manifest_contract_doc_pages_keep_native_release_runner_execution_gate',
    dependsOn: Object.freeze(['report_contract_doc_page_release_execution_approval_boundary_section_regression']),
  }),
  Object.freeze({
    nodeId: 'report_contract_doc_page_release_dispatch_implementation_denial_section_regression',
    fileId: 'report-contract-doc-page-release-dispatch-implementation-denial-section-regression-latest.json',
    scriptId: 'reports:contract-doc-page-release-dispatch-implementation-denial-section-regression',
    stepId: 'report_contract_doc_page_release_dispatch_implementation_denial_section_regression_export',
    hashKey: 'reportContractDocPageReleaseDispatchImplementationDenialSectionRegressionHash',
    selfReferenceMode: 'proves_manifest_contract_doc_pages_keep_native_release_dispatch_implementation_denial',
    dependsOn: Object.freeze(['report_contract_doc_page_release_runner_execution_gate_section_regression']),
  }),
  Object.freeze({
    nodeId: 'report_contract_doc_page_release_platform_state_snapshot_denial_section_regression',
    fileId: 'report-contract-doc-page-release-platform-state-snapshot-denial-section-regression-latest.json',
    scriptId: 'reports:contract-doc-page-release-platform-state-snapshot-denial-section-regression',
    stepId: 'report_contract_doc_page_release_platform_state_snapshot_denial_section_regression_export',
    hashKey: 'reportContractDocPageReleasePlatformStateSnapshotDenialSectionRegressionHash',
    selfReferenceMode: 'proves_manifest_contract_doc_pages_keep_native_release_platform_state_snapshot_denial',
    dependsOn: Object.freeze(['report_contract_doc_page_release_dispatch_implementation_denial_section_regression']),
  }),
  Object.freeze({
    nodeId: 'report_contract_doc_page_release_dry_run_replay_denial_section_regression',
    fileId: 'report-contract-doc-page-release-dry-run-replay-denial-section-regression-latest.json',
    scriptId: 'reports:contract-doc-page-release-dry-run-replay-denial-section-regression',
    stepId: 'report_contract_doc_page_release_dry_run_replay_denial_section_regression_export',
    hashKey: 'reportContractDocPageReleaseDryRunReplayDenialSectionRegressionHash',
    selfReferenceMode: 'proves_manifest_contract_doc_pages_keep_native_release_dry_run_replay_denial',
    dependsOn: Object.freeze(['report_contract_doc_page_release_platform_state_snapshot_denial_section_regression']),
  }),
  Object.freeze({
    nodeId: 'report_contract_doc_page_release_proof_bundle_denial_section_regression',
    fileId: 'report-contract-doc-page-release-proof-bundle-denial-section-regression-latest.json',
    scriptId: 'reports:contract-doc-page-release-proof-bundle-denial-section-regression',
    stepId: 'report_contract_doc_page_release_proof_bundle_denial_section_regression_export',
    hashKey: 'reportContractDocPageReleaseProofBundleDenialSectionRegressionHash',
    selfReferenceMode: 'proves_manifest_contract_doc_pages_keep_native_release_proof_bundle_denial',
    dependsOn: Object.freeze(['report_contract_doc_page_release_dry_run_replay_denial_section_regression']),
  }),
  Object.freeze({
    nodeId: 'report_contract_doc_page_release_ledger_denial_section_regression',
    fileId: 'report-contract-doc-page-release-ledger-denial-section-regression-latest.json',
    scriptId: 'reports:contract-doc-page-release-ledger-denial-section-regression',
    stepId: 'report_contract_doc_page_release_ledger_denial_section_regression_export',
    hashKey: 'reportContractDocPageReleaseLedgerDenialSectionRegressionHash',
    selfReferenceMode: 'proves_manifest_contract_doc_pages_keep_native_release_ledger_denial',
    dependsOn: Object.freeze(['report_contract_doc_page_release_proof_bundle_denial_section_regression']),
  }),
  Object.freeze({
    nodeId: 'report_contract_doc_page_release_audit_evidence_denial_section_regression',
    fileId: 'report-contract-doc-page-release-audit-evidence-denial-section-regression-latest.json',
    scriptId: 'reports:contract-doc-page-release-audit-evidence-denial-section-regression',
    stepId: 'report_contract_doc_page_release_audit_evidence_denial_section_regression_export',
    hashKey: 'reportContractDocPageReleaseAuditEvidenceDenialSectionRegressionHash',
    selfReferenceMode: 'proves_manifest_contract_doc_pages_keep_native_release_audit_evidence_denial',
    dependsOn: Object.freeze(['report_contract_doc_page_release_ledger_denial_section_regression']),
  }),
  Object.freeze({
    nodeId: 'report_contract_doc_page_release_receipt_evidence_denial_section_regression',
    fileId: 'report-contract-doc-page-release-receipt-evidence-denial-section-regression-latest.json',
    scriptId: 'reports:contract-doc-page-release-receipt-evidence-denial-section-regression',
    stepId: 'report_contract_doc_page_release_receipt_evidence_denial_section_regression_export',
    hashKey: 'reportContractDocPageReleaseReceiptEvidenceDenialSectionRegressionHash',
    selfReferenceMode: 'proves_manifest_contract_doc_pages_keep_native_release_receipt_evidence_denial',
    dependsOn: Object.freeze(['report_contract_doc_page_release_audit_evidence_denial_section_regression']),
  }),
  Object.freeze({
    nodeId: 'report_contract_doc_page_release_post_action_receipt_denial_section_regression',
    fileId: 'report-contract-doc-page-release-post-action-receipt-denial-section-regression-latest.json',
    scriptId: 'reports:contract-doc-page-release-post-action-receipt-denial-section-regression',
    stepId: 'report_contract_doc_page_release_post_action_receipt_denial_section_regression_export',
    hashKey: 'reportContractDocPageReleasePostActionReceiptDenialSectionRegressionHash',
    selfReferenceMode: 'proves_manifest_contract_doc_pages_keep_native_release_post_action_receipt_denial',
    dependsOn: Object.freeze(['report_contract_doc_page_release_receipt_evidence_denial_section_regression']),
  }),
  Object.freeze({
    nodeId: 'report_contract_doc_page_release_post_action_audit_denial_section_regression',
    fileId: 'report-contract-doc-page-release-post-action-audit-denial-section-regression-latest.json',
    scriptId: 'reports:contract-doc-page-release-post-action-audit-denial-section-regression',
    stepId: 'report_contract_doc_page_release_post_action_audit_denial_section_regression_export',
    hashKey: 'reportContractDocPageReleasePostActionAuditDenialSectionRegressionHash',
    selfReferenceMode: 'proves_manifest_contract_doc_pages_keep_native_release_post_action_audit_denial',
    dependsOn: Object.freeze(['report_contract_doc_page_release_post_action_receipt_denial_section_regression']),
  }),
  Object.freeze({
    nodeId: 'report_contract_doc_page_release_post_action_reconciliation_denial_section_regression',
    fileId: 'report-contract-doc-page-release-post-action-reconciliation-denial-section-regression-latest.json',
    scriptId: 'reports:contract-doc-page-release-post-action-reconciliation-denial-section-regression',
    stepId: 'report_contract_doc_page_release_post_action_reconciliation_denial_section_regression_export',
    hashKey: 'reportContractDocPageReleasePostActionReconciliationDenialSectionRegressionHash',
    selfReferenceMode: 'proves_manifest_contract_doc_pages_keep_native_release_post_action_reconciliation_denial',
    dependsOn: Object.freeze(['report_contract_doc_page_release_post_action_audit_denial_section_regression']),
  }),
  Object.freeze({
    nodeId: 'report_contract_doc_page_release_post_action_settlement_denial_section_regression',
    fileId: 'report-contract-doc-page-release-post-action-settlement-denial-section-regression-latest.json',
    scriptId: 'reports:contract-doc-page-release-post-action-settlement-denial-section-regression',
    stepId: 'report_contract_doc_page_release_post_action_settlement_denial_section_regression_export',
    hashKey: 'reportContractDocPageReleasePostActionSettlementDenialSectionRegressionHash',
    selfReferenceMode: 'proves_manifest_contract_doc_pages_keep_native_release_post_action_settlement_denial',
    dependsOn: Object.freeze(['report_contract_doc_page_release_post_action_reconciliation_denial_section_regression']),
  }),
  Object.freeze({
    nodeId: 'report_contract_doc_page_release_post_action_acceptance_denial_section_regression',
    fileId: 'report-contract-doc-page-release-post-action-acceptance-denial-section-regression-latest.json',
    scriptId: 'reports:contract-doc-page-release-post-action-acceptance-denial-section-regression',
    stepId: 'report_contract_doc_page_release_post_action_acceptance_denial_section_regression_export',
    hashKey: 'reportContractDocPageReleasePostActionAcceptanceDenialSectionRegressionHash',
    selfReferenceMode: 'proves_manifest_contract_doc_pages_keep_native_release_post_action_acceptance_denial',
    dependsOn: Object.freeze(['report_contract_doc_page_release_post_action_settlement_denial_section_regression']),
  }),
  Object.freeze({
    nodeId: 'report_contract_doc_page_release_post_action_payment_denial_section_regression',
    fileId: 'report-contract-doc-page-release-post-action-payment-denial-section-regression-latest.json',
    scriptId: 'reports:contract-doc-page-release-post-action-payment-denial-section-regression',
    stepId: 'report_contract_doc_page_release_post_action_payment_denial_section_regression_export',
    hashKey: 'reportContractDocPageReleasePostActionPaymentDenialSectionRegressionHash',
    selfReferenceMode: 'proves_manifest_contract_doc_pages_keep_native_release_post_action_payment_denial',
    dependsOn: Object.freeze(['report_contract_doc_page_release_post_action_acceptance_denial_section_regression']),
  }),
  Object.freeze({
    nodeId: 'report_contract_doc_page_release_post_action_deployment_denial_section_regression',
    fileId: 'report-contract-doc-page-release-post-action-deployment-denial-section-regression-latest.json',
    scriptId: 'reports:contract-doc-page-release-post-action-deployment-denial-section-regression',
    stepId: 'report_contract_doc_page_release_post_action_deployment_denial_section_regression_export',
    hashKey: 'reportContractDocPageReleasePostActionDeploymentDenialSectionRegressionHash',
    selfReferenceMode: 'proves_manifest_contract_doc_pages_keep_native_release_post_action_deployment_denial',
    dependsOn: Object.freeze(['report_contract_doc_page_release_post_action_payment_denial_section_regression']),
  }),
  Object.freeze({
    nodeId: 'report_contract_doc_page_release_post_action_provider_spend_denial_section_regression',
    fileId: 'report-contract-doc-page-release-post-action-provider-spend-denial-section-regression-latest.json',
    scriptId: 'reports:contract-doc-page-release-post-action-provider-spend-denial-section-regression',
    stepId: 'report_contract_doc_page_release_post_action_provider_spend_denial_section_regression_export',
    hashKey: 'reportContractDocPageReleasePostActionProviderSpendDenialSectionRegressionHash',
    selfReferenceMode: 'proves_manifest_contract_doc_pages_keep_native_release_post_action_provider_spend_denial',
    dependsOn: Object.freeze(['report_contract_doc_page_release_post_action_deployment_denial_section_regression']),
  }),
  Object.freeze({
    nodeId: 'report_contract_doc_page_release_post_action_state_transition_denial_section_regression',
    fileId: 'report-contract-doc-page-release-post-action-state-transition-denial-section-regression-latest.json',
    scriptId: 'reports:contract-doc-page-release-post-action-state-transition-denial-section-regression',
    stepId: 'report_contract_doc_page_release_post_action_state_transition_denial_section_regression_export',
    hashKey: 'reportContractDocPageReleasePostActionStateTransitionDenialSectionRegressionHash',
    selfReferenceMode: 'proves_manifest_contract_doc_pages_keep_native_release_post_action_state_transition_denial',
    dependsOn: Object.freeze(['report_contract_doc_page_release_post_action_provider_spend_denial_section_regression']),
  }),
  Object.freeze({
    nodeId: 'report_contract_doc_page_release_post_action_queue_consumption_denial_section_regression',
    fileId: 'report-contract-doc-page-release-post-action-queue-consumption-denial-section-regression-latest.json',
    scriptId: 'reports:contract-doc-page-release-post-action-queue-consumption-denial-section-regression',
    stepId: 'report_contract_doc_page_release_post_action_queue_consumption_denial_section_regression_export',
    hashKey: 'reportContractDocPageReleasePostActionQueueConsumptionDenialSectionRegressionHash',
    selfReferenceMode: 'proves_manifest_contract_doc_pages_keep_native_release_post_action_queue_consumption_denial',
    dependsOn: Object.freeze(['report_contract_doc_page_release_post_action_state_transition_denial_section_regression']),
  }),
  Object.freeze({
    nodeId: 'report_contract_doc_page_release_post_action_background_runner_denial_section_regression',
    fileId: 'report-contract-doc-page-release-post-action-background-runner-denial-section-regression-latest.json',
    scriptId: 'reports:contract-doc-page-release-post-action-background-runner-denial-section-regression',
    stepId: 'report_contract_doc_page_release_post_action_background_runner_denial_section_regression_export',
    hashKey: 'reportContractDocPageReleasePostActionBackgroundRunnerDenialSectionRegressionHash',
    selfReferenceMode: 'proves_manifest_contract_doc_pages_keep_native_release_post_action_background_runner_denial',
    dependsOn: Object.freeze(['report_contract_doc_page_release_post_action_queue_consumption_denial_section_regression']),
  }),
  Object.freeze({
    nodeId: 'report_contract_doc_page_release_post_action_dispatch_completion_denial_section_regression',
    fileId: 'report-contract-doc-page-release-post-action-dispatch-completion-denial-section-regression-latest.json',
    scriptId: 'reports:contract-doc-page-release-post-action-dispatch-completion-denial-section-regression',
    stepId: 'report_contract_doc_page_release_post_action_dispatch_completion_denial_section_regression_export',
    hashKey: 'reportContractDocPageReleasePostActionDispatchCompletionDenialSectionRegressionHash',
    selfReferenceMode: 'proves_manifest_contract_doc_pages_keep_native_release_post_action_dispatch_completion_denial',
    dependsOn: Object.freeze(['report_contract_doc_page_release_post_action_background_runner_denial_section_regression']),
  }),
  Object.freeze({
    nodeId: 'report_manifest_drift_regression',
    fileId: 'report-manifest-drift-regression-latest.json',
    scriptId: 'reports:manifest-drift-regression',
    stepId: 'report_manifest_drift_regression_export',
    hashKey: 'reportManifestDriftRegressionHash',
    selfReferenceMode: 'proves_manifest_changes_are_reflected_in_downstream_report_indexes',
    dependsOn: Object.freeze(['report_contract_doc_page_release_post_action_dispatch_completion_denial_section_regression']),
  }),
  Object.freeze({
    nodeId: 'report_latest_recovery_regression',
    fileId: 'report-latest-recovery-regression-latest.json',
    scriptId: 'reports:latest-recovery-regression',
    stepId: 'report_latest_recovery_regression_export',
    hashKey: 'reportLatestRecoveryRegressionHash',
    selfReferenceMode: 'proves_contaminated_latest_reports_can_be_bootstrap_recovered_before_child_freshness',
    dependsOn: Object.freeze(['report_manifest_drift_regression']),
  }),
  Object.freeze({
    nodeId: 'report_bootstrap_seed_regression',
    fileId: 'report-bootstrap-seed-regression-latest.json',
    scriptId: 'reports:bootstrap-seed-regression',
    stepId: 'report_bootstrap_seed_regression_export',
    hashKey: 'reportBootstrapSeedRegressionHash',
    selfReferenceMode: 'proves_temporary_bootstrap_seed_reports_are_allowlisted_and_replaced',
    dependsOn: Object.freeze(['report_latest_recovery_regression']),
  }),
  Object.freeze({
    nodeId: 'report_freshness',
    fileId: 'report-freshness-latest.json',
    scriptId: 'reports:freshness',
    stepId: 'report_freshness_export_pre_tooling',
    hashKey: 'reportFreshnessHash',
    selfReferenceMode: 'gate_runs_skip_gate_child_then_final_child_refreshes',
    dependsOn: Object.freeze(['post_action_reconciliation_matrix']),
  }),
  Object.freeze({
    nodeId: 'integration_gate_tooling',
    fileId: 'integration-gate-tooling-latest.json',
    scriptId: 'integration:tooling',
    stepId: 'integration_gate_tooling_export',
    hashKey: 'integrationGateToolingHash',
    dependsOn: Object.freeze(['report_freshness']),
  }),
  Object.freeze({
    nodeId: 'selftest_lanes',
    fileId: 'selftest-lanes-latest.json',
    scriptId: 'selftest:lanes',
    stepId: 'selftest_lanes',
    hashKey: 'selftestLanesHash',
    dependsOn: Object.freeze(['integration_gate_tooling']),
  }),
  Object.freeze({
    nodeId: 'integration_audit',
    fileId: 'integration-dependency-audit-latest.json',
    scriptId: 'audit:integration:strict',
    stepId: 'integration_dependency_audit_strict',
    hashKey: 'integrationAuditHash',
    dependsOn: Object.freeze(['selftest_lanes']),
  }),
  Object.freeze({
    nodeId: 'integration_gate',
    fileId: 'integration-dependency-gate-latest.json',
    scriptId: 'gate:integration:strict',
    hashKey: 'gateHash',
    requiresCheckpointBinding: true,
    requiresGateSummaryHashKey: false,
    dependsOn: Object.freeze([
      'integration_audit',
      'report_freshness',
    ]),
  }),
  Object.freeze({
    nodeId: 'architecture_checkpoint',
    fileId: 'architecture-checkpoint-latest.json',
    scriptId: 'checkpoint:architecture',
    hashKey: 'checkpointHash',
    requiresCheckpointBinding: false,
    requiresGateSummaryHashKey: false,
    dependsOn: Object.freeze([
      'integration_gate',
      'report_freshness',
    ]),
  }),
  Object.freeze({
    nodeId: 'release_final_settlement',
    fileId: 'release-final-settlement-latest.json',
    scriptId: 'release:final-settlement',
    hashKey: 'finalSettlementHash',
    selfReferenceMode: 'terminal_report_written_after_final_freshness_checkpoint_writeback_and_dirty_scan',
    requiresCheckpointBinding: false,
    requiresGateSummaryHashKey: false,
    dependsOn: Object.freeze(['architecture_checkpoint']),
  }),
]);

export const REPORT_LINEAGE_TOPOLOGY_REQUIRED_NODE_IDS = Object.freeze(
  REPORT_LINEAGE_TOPOLOGY_NODES.map((node) => node.nodeId),
);

const NEGATIVE_SCENARIOS = Object.freeze([
  Object.freeze({
    scenarioId: 'missing_terminal_final_settlement_node',
    label: 'The terminal final settlement report node is removed',
    expectedBlockerCode: 'report_lineage_required_node_missing',
    mutate(input) {
      input.nodes = input.nodes.filter((node) => node.nodeId !== 'release_final_settlement');
    },
  }),
  Object.freeze({
    scenarioId: 'missing_dependency_node',
    label: 'A lineage dependency node is removed',
    expectedBlockerCode: 'report_lineage_dependency_node_missing',
    mutate(input) {
      input.nodes = input.nodes.filter((node) => node.nodeId !== 'report_schema_contract');
    },
  }),
  Object.freeze({
    scenarioId: 'dependency_after_consumer',
    label: 'A dependency is moved after its consumer in the gate sequence',
    expectedBlockerCode: 'report_lineage_order_mismatch',
    mutate(input) {
      input.gateSteps = moveStepAfter(
        input.gateSteps,
        'report_schema_contract_export',
        'report_lineage_topology_export',
      );
    },
  }),
  Object.freeze({
    scenarioId: 'cycle_detected',
    label: 'A cycle is introduced into report lineage',
    expectedBlockerCode: 'report_lineage_cycle_detected',
    mutate(input) {
      input.nodes = input.nodes.map((node) => (node.nodeId === 'report_freshness_regression'
        ? { ...node, dependsOn: ['report_freshness'] }
        : node));
    },
  }),
  Object.freeze({
    scenarioId: 'missing_gate_step',
    label: 'The lineage topology export step is removed from the gate',
    expectedBlockerCode: 'report_lineage_gate_step_missing',
    mutate(input) {
      input.gateSteps = input.gateSteps.filter((step) => step.stepId !== 'report_lineage_topology_export');
    },
  }),
  Object.freeze({
    scenarioId: 'missing_package_script',
    label: 'The lineage topology npm script is removed',
    expectedBlockerCode: 'report_lineage_script_missing',
    mutate(input) {
      input.packageScriptIds = input.packageScriptIds.filter((scriptId) => scriptId !== REPORT_LINEAGE_TOPOLOGY_SCRIPT_ID);
    },
  }),
  Object.freeze({
    scenarioId: 'missing_checkpoint_binding',
    label: 'Architecture checkpoint omits the lineage topology latest report',
    expectedBlockerCode: 'report_lineage_checkpoint_binding_missing',
    mutate(input) {
      input.checkpointBindings = input.checkpointBindings
        .filter((binding) => binding.filename !== REPORT_LINEAGE_TOPOLOGY_REPORT_FILE_ID);
    },
  }),
  Object.freeze({
    scenarioId: 'missing_gate_summary_hash_key',
    label: 'Integration gate summary omits the lineage topology hash key',
    expectedBlockerCode: 'report_lineage_gate_summary_hash_key_missing',
    mutate(input) {
      input.gateSummaryHashKeys = input.gateSummaryHashKeys
        .filter((key) => key !== 'reportLineageTopologyHash');
    },
  }),
]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function duplicateValues(values = []) {
  return values
    .filter((value, index, all) => all.indexOf(value) !== index)
    .filter((value, index, all) => all.indexOf(value) === index)
    .sort((left, right) => left.localeCompare(right));
}

function uniqueSorted(values = []) {
  return [...new Set(values.filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function moveStepAfter(steps, movingStepId, anchorStepId) {
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

function nodeById(nodes = []) {
  return Object.fromEntries(nodes.map((node) => [node.nodeId, node]));
}

function nodeStepIndex(node, stepIndexById) {
  if (!node?.stepId) return null;
  return stepIndexById[node.stepId] == null ? null : stepIndexById[node.stepId];
}

function cycleNodeIds(nodes = []) {
  const byId = nodeById(nodes);
  const visiting = new Set();
  const visited = new Set();
  const cycles = new Set();

  function visit(nodeId, stack = []) {
    if (visiting.has(nodeId)) {
      const cycleStart = stack.indexOf(nodeId);
      for (const cycleNodeId of stack.slice(cycleStart < 0 ? 0 : cycleStart)) cycles.add(cycleNodeId);
      cycles.add(nodeId);
      return;
    }
    if (visited.has(nodeId) || !byId[nodeId]) return;
    visiting.add(nodeId);
    for (const dependencyId of byId[nodeId].dependsOn || []) visit(dependencyId, [...stack, nodeId]);
    visiting.delete(nodeId);
    visited.add(nodeId);
  }

  for (const node of nodes) visit(node.nodeId);
  return uniqueSorted([...cycles]);
}

function compactAnalysis(analysis) {
  return {
    status: analysis.status,
    ok: analysis.ok === true,
    nodeCount: analysis.nodeCount,
    edgeCount: analysis.edgeCount,
    requiredNodeCount: analysis.requiredNodeCount,
    missingRequiredNodeCount: analysis.missingRequiredNodeCount,
    gateStepCount: analysis.gateStepCount,
    checkpointBindingCount: analysis.checkpointBindingCount,
    gateSummaryHashKeyCount: analysis.gateSummaryHashKeyCount,
    packageScriptCount: analysis.packageScriptCount,
    blockers: analysis.blockers.map((item) => ({
      code: item.code,
      nodeId: item.nodeId || null,
      dependencyId: item.dependencyId || null,
      fileId: item.fileId || null,
      scriptId: item.scriptId || null,
      stepId: item.stepId || null,
      hashKey: item.hashKey || null,
    })),
  };
}

export function buildReportLineageTopologyInput({
  gateSourceText = '',
  checkpointSourceText = '',
  packageScriptIds = [],
  nodes = REPORT_LINEAGE_TOPOLOGY_NODES,
  requiredNodeIds = REPORT_LINEAGE_TOPOLOGY_REQUIRED_NODE_IDS,
} = {}) {
  return {
    requiredNodeIds: [...requiredNodeIds],
    nodes: nodes.map((node) => ({
      nodeId: node.nodeId,
      fileId: node.fileId,
      scriptId: node.scriptId,
      stepId: node.stepId || null,
      hashKey: node.hashKey || null,
      selfReferenceMode: node.selfReferenceMode || null,
      requiresCheckpointBinding: node.requiresCheckpointBinding !== false,
      requiresGateSummaryHashKey: node.requiresGateSummaryHashKey !== false,
      dependsOn: [...(node.dependsOn || [])],
    })),
    gateSteps: extractIntegrationGateStepSpecs(gateSourceText),
    checkpointBindings: extractCheckpointReportBindings(checkpointSourceText),
    gateSummaryHashKeys: extractGateSummaryHashKeys(gateSourceText),
    packageScriptIds: [...packageScriptIds],
  };
}

export function analyzeReportLineageTopology(input = {}) {
  const nodes = input.nodes || [];
  const byId = nodeById(nodes);
  const requiredNodeIds = input.requiredNodeIds || [];
  const stepIndexById = Object.fromEntries((input.gateSteps || []).map((step, index) => [step.stepId, index]));
  const checkpointFileIds = (input.checkpointBindings || []).map((binding) => binding.filename);
  const gateSummaryHashKeys = input.gateSummaryHashKeys || [];
  const packageScriptIds = input.packageScriptIds || [];
  const missingRequiredNodeIds = requiredNodeIds.filter((nodeId) => !byId[nodeId]);
  const missingDependencies = nodes.flatMap((node) => (node.dependsOn || [])
    .filter((dependencyId) => !byId[dependencyId])
    .map((dependencyId) => ({ node, dependencyId })));
  const cycleIds = cycleNodeIds(nodes);
  const orderMismatches = nodes.flatMap((node) => (node.dependsOn || []).flatMap((dependencyId) => {
    const dependency = byId[dependencyId];
    const dependencyIndex = nodeStepIndex(dependency, stepIndexById);
    const nodeIndex = nodeStepIndex(node, stepIndexById);
    if (dependencyIndex == null || nodeIndex == null || dependencyIndex < nodeIndex) return [];
    return [{ node, dependency, dependencyIndex, nodeIndex }];
  }));
  const blockers = [
    ...missingRequiredNodeIds.map((nodeId) => ({
      code: 'report_lineage_required_node_missing',
      nodeId,
      notes: `${nodeId} is a required report lineage topology node.`,
    })),
    ...duplicateValues(nodes.map((node) => node.nodeId)).map((nodeId) => ({
      code: 'report_lineage_duplicate_node_id',
      nodeId,
      notes: `${nodeId} appears more than once in the report lineage topology.`,
    })),
    ...duplicateValues(nodes.map((node) => node.fileId)).map((fileId) => ({
      code: 'report_lineage_duplicate_file_id',
      fileId,
      notes: `${fileId} appears more than once in the report lineage topology.`,
    })),
    ...duplicateValues(nodes.map((node) => node.hashKey).filter(Boolean)).map((hashKey) => ({
      code: 'report_lineage_duplicate_hash_key',
      hashKey,
      notes: `${hashKey} appears more than once in the report lineage topology.`,
    })),
    ...missingDependencies.map(({ node, dependencyId }) => ({
      code: 'report_lineage_dependency_node_missing',
      nodeId: node.nodeId,
      dependencyId,
      notes: `${node.nodeId} depends on missing lineage node ${dependencyId}.`,
    })),
    ...cycleIds.map((nodeId) => ({
      code: 'report_lineage_cycle_detected',
      nodeId,
      notes: `${nodeId} participates in a report lineage cycle.`,
    })),
    ...nodes
      .filter((node) => node.stepId && stepIndexById[node.stepId] == null)
      .map((node) => ({
        code: 'report_lineage_gate_step_missing',
        nodeId: node.nodeId,
        stepId: node.stepId,
        notes: `${node.nodeId} requires integration gate step ${node.stepId}.`,
      })),
    ...orderMismatches.map(({ node, dependency }) => ({
      code: 'report_lineage_order_mismatch',
      nodeId: node.nodeId,
      dependencyId: dependency.nodeId,
      stepId: node.stepId,
      dependencyStepId: dependency.stepId,
      notes: `${dependency.stepId} must run before ${node.stepId}.`,
    })),
    ...nodes
      .filter((node) => node.scriptId && !packageScriptIds.includes(node.scriptId))
      .map((node) => ({
        code: 'report_lineage_script_missing',
        nodeId: node.nodeId,
        scriptId: node.scriptId,
        notes: `${node.nodeId} requires package script ${node.scriptId}.`,
      })),
    ...nodes
      .filter((node) => node.requiresCheckpointBinding !== false && !checkpointFileIds.includes(node.fileId))
      .map((node) => ({
        code: 'report_lineage_checkpoint_binding_missing',
        nodeId: node.nodeId,
        fileId: node.fileId,
        notes: `${node.fileId} must be bound by architecture checkpoint reports.`,
      })),
    ...nodes
      .filter((node) => (
        node.hashKey
          && node.requiresGateSummaryHashKey !== false
          && !gateSummaryHashKeys.includes(node.hashKey)
      ))
      .map((node) => ({
        code: 'report_lineage_gate_summary_hash_key_missing',
        nodeId: node.nodeId,
        hashKey: node.hashKey,
        notes: `${node.hashKey} must be present in integration dependency gate summary.`,
      })),
  ];
  return {
    status: blockers.length ? 'blocked_report_lineage_topology_analysis' : 'pass_report_lineage_topology_analysis',
    ok: blockers.length === 0,
    nodeCount: nodes.length,
    edgeCount: nodes.reduce((sum, node) => sum + (node.dependsOn || []).length, 0),
    requiredNodeCount: requiredNodeIds.length,
    missingRequiredNodeCount: missingRequiredNodeIds.length,
    gateStepCount: input.gateSteps?.length || 0,
    checkpointBindingCount: checkpointFileIds.length,
    gateSummaryHashKeyCount: gateSummaryHashKeys.length,
    packageScriptCount: packageScriptIds.length,
    nodes: nodes.map((node) => ({
      nodeId: node.nodeId,
      fileId: node.fileId,
      scriptId: node.scriptId,
      stepId: node.stepId || null,
      hashKey: node.hashKey || null,
      selfReferenceMode: node.selfReferenceMode || null,
      dependsOn: [...(node.dependsOn || [])],
    })),
    edges: nodes.flatMap((node) => (node.dependsOn || []).map((dependencyId) => ({
      from: dependencyId,
      to: node.nodeId,
    }))),
    blockers,
  };
}

function runScenario(scenario, baselineInput) {
  const input = clone(baselineInput);
  scenario.mutate(input);
  const analysis = analyzeReportLineageTopology(input);
  const observedBlockerCodes = analysis.blockers.map((item) => item.code);
  const blockers = [
    ...(analysis.ok === true ? [{
      code: 'report_lineage_topology_scenario_unexpectedly_passed',
      notes: `${scenario.scenarioId} must make report lineage topology fail.`,
    }] : []),
    ...(!observedBlockerCodes.includes(scenario.expectedBlockerCode) ? [{
      code: 'report_lineage_topology_expected_blocker_missing',
      notes: `${scenario.scenarioId} expected ${scenario.expectedBlockerCode}, got ${observedBlockerCodes.join(', ') || 'none'}.`,
    }] : []),
  ];
  return {
    scenarioId: scenario.scenarioId,
    label: scenario.label,
    status: blockers.length ? 'blocked_report_lineage_topology_scenario' : 'pass_report_lineage_topology_scenario',
    ok: blockers.length === 0,
    expectedBlockerCode: scenario.expectedBlockerCode,
    observedBlockerCodes,
    analysis: compactAnalysis(analysis),
    blockers,
  };
}

export function buildReportLineageTopologyReport({
  gateSourceText = '',
  checkpointSourceText = '',
  packageScriptIds = [],
  generatedAt = new Date().toISOString(),
} = {}) {
  const input = buildReportLineageTopologyInput({
    gateSourceText,
    checkpointSourceText,
    packageScriptIds,
  });
  const actual = analyzeReportLineageTopology(input);
  const scenarios = NEGATIVE_SCENARIOS.map((scenario) => runScenario(scenario, input));
  const blockers = [
    ...actual.blockers.map((item) => ({
      ...item,
      source: 'actual_topology',
    })),
    ...scenarios.flatMap((scenario) => scenario.blockers.map((item) => ({
      ...item,
      source: 'negative_scenario',
      scenarioId: scenario.scenarioId,
    }))),
  ];
  const report = {
    version: REPORT_LINEAGE_TOPOLOGY_VERSION,
    kind: 'ReportLineageTopology',
    status: blockers.length ? 'blocked_report_lineage_topology' : 'pass_report_lineage_topology',
    ok: blockers.length === 0,
    generatedAt,
    reportFileId: REPORT_LINEAGE_TOPOLOGY_REPORT_FILE_ID,
    scriptId: REPORT_LINEAGE_TOPOLOGY_SCRIPT_ID,
    actual: compactAnalysis(actual),
    topology: {
      nodes: actual.nodes,
      edges: actual.edges,
    },
    scenarios,
    summary: {
      actualOk: actual.ok === true,
      nodeCount: actual.nodeCount,
      edgeCount: actual.edgeCount,
      requiredNodeCount: actual.requiredNodeCount,
      missingRequiredNodeCount: actual.missingRequiredNodeCount,
      gateStepCount: actual.gateStepCount,
      checkpointBindingCount: actual.checkpointBindingCount,
      gateSummaryHashKeyCount: actual.gateSummaryHashKeyCount,
      packageScriptCount: actual.packageScriptCount,
      expectedScenarioCount: NEGATIVE_SCENARIOS.length,
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
      sourceInspectionOnly: true,
      syntheticFixtureOnly: true,
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
  const lineageTopologyHash = digest({
    version: report.version,
    kind: report.kind,
    status: report.status,
    reportFileId: report.reportFileId,
    scriptId: report.scriptId,
    actual: report.actual,
    topology: report.topology,
    scenarios: report.scenarios.map((scenario) => ({
      scenarioId: scenario.scenarioId,
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
    lineageTopologyHash,
    hash: lineageTopologyHash,
  };
}

export function summarizeReportLineageTopologyReport(report) {
  return {
    version: report?.version || null,
    status: report?.status || 'missing_report_lineage_topology',
    ok: report?.ok === true,
    lineageTopologyHash: report?.lineageTopologyHash || null,
    actualOk: report?.summary?.actualOk === true,
    nodeCount: report?.summary?.nodeCount || 0,
    edgeCount: report?.summary?.edgeCount || 0,
    requiredNodeCount: report?.summary?.requiredNodeCount || 0,
    missingRequiredNodeCount: report?.summary?.missingRequiredNodeCount || 0,
    passedScenarioCount: report?.summary?.passedScenarioCount || 0,
    scenarioCount: report?.summary?.scenarioCount || 0,
    blockerCount: report?.summary?.blockerCount || 0,
    safety: {
      localOnly: true,
      readOnly: true,
      sourceInspectionOnly: true,
      syntheticFixtureOnly: true,
      executesExternalAction: false,
    },
  };
}
