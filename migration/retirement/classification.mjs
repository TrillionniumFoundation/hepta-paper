// Historical paper_factory retirement classification. This module is not part of the live adapter surface.
import { normalizeText } from '../../workflow-kernel/runtime/text-utils.mjs';

const RETIREMENT_WAVES = [
  {
    id: 'wave_0_freeze_legacy_entrypoints',
    label: 'Wave 0: Freeze legacy entrypoints',
    goal: 'Stop using bin/paperctl and paper_production_core.py as primary workflow entrypoints.',
    statusWhenClear: 'legacy_entrypoint_freeze_ready',
    exitCriteria: [
      'paper-production-core batch-run covers inventory/build/package/research/referee/reviewed-submit paths',
      'legacy entrypoints are no longer needed for normal production runs',
    ],
  },
  {
    id: 'wave_1_promote_registry_schema_templates_docs',
    label: 'Wave 1: Promote registry/schema/templates/docs',
    goal: 'Keep registry/schema/templates/docs as data assets, not executable control plane.',
    statusWhenClear: 'data_asset_export_plan_ready',
    exitCriteria: [
      'SQLite/YAML registry remains readable by hepta inventory',
      'schemas/templates have owner docs or native paper adapter consumers',
    ],
  },
  {
    id: 'wave_2_migrate_research_source_package_semantics',
    label: 'Wave 2: Migrate research/source/package semantics',
    goal: 'Extract useful research-compute and package/source semantics into typed hepta receipts.',
    statusWhenClear: 'research_source_package_migration_backlog_ready',
    exitCriteria: [
      'research worker logic is represented as worker bridge receipts',
      'source/package/build rules are represented in build-package contracts',
    ],
  },
  {
    id: 'wave_3_migrate_referee_review_repair_semantics',
    label: 'Wave 3: Migrate referee review/repair semantics',
    goal: 'Replace old referee plugins and repair modules with agent review/revise adapters.',
    statusWhenClear: 'referee_review_repair_migration_backlog_ready',
    exitCriteria: [
      'referee-review can generate issue queues from source',
      'referee-revise can apply, recheck, resolve, and reenter reviewed-submit',
    ],
  },
  {
    id: 'wave_4_migrate_submission_venue_source_decision_semantics',
    label: 'Wave 4: Migrate submission/venue/source decision semantics',
    goal: 'Move venue/source decisions and submission lifecycle into hepta contracts.',
    statusWhenClear: 'submission_venue_source_decision_backlog_ready',
    exitCriteria: [
      'venue/source blockers have native hepta decision packets',
      'reviewed-submit uses agent approval and controlled executor receipts',
      'live external submission remains a separate audited executor',
    ],
  },
  {
    id: 'wave_5_quarantine_reports_matrices_capstones_llm_manual_chains',
    label: 'Wave 5: Quarantine reports/matrices/capstones/LLM/manual chains',
    goal: 'Keep stale report/matrix/capstone and old LLM/manual chains out of the new workflow.',
    statusWhenClear: 'quarantine_manifest_ready',
    exitCriteria: [
      'no hepta adapter imports report-only/capstone modules as control plane',
      'archive references remain available for audit only',
    ],
  },
  {
    id: 'wave_6_remove_old_control_plane',
    label: 'Wave 6: Remove old control plane',
    goal: 'Declare paper_factory executable control plane retired after data/export parity is closed.',
    statusWhenClear: 'old_control_plane_removal_ready',
    exitCriteria: [
      'all active papers are reachable through hepta inventory',
      'legacy control-plane entrypoints are unused',
      'remaining live external executor policy is explicit',
    ],
  },
];

function classifyLegacyFile(relative) {
  const text = normalizeText(relative).toLowerCase();
  if (/bin\/paperctl$/.test(text)) return 'blocked_primary_entrypoint';
  if (/paperctl_modules\/paper_production_core\.py$/.test(text)) return 'retire_legacy_production_core';
  if (/paperctl_modules\/external_submission_handoff_bundle/.test(text)) {
    return 'adapter_candidate_submission_lifecycle';
  }
  if (/paperctl_modules\/paper_production_reviewed_target_evidence_autofill/.test(text)) {
    return 'adapter_candidate_submission_lifecycle';
  }
  if (/paperctl_modules\/paper_production_theorem_proof_appendix_gate/.test(text)) {
    return 'adapter_candidate_research_compute';
  }
  if (/paperctl_modules\/paper_production_.*(release_lock|runtime_dry_run|strict_ordered_refresh|target_scope|stale_pass|post_action_runtime|remaining_input|terminal_chain)/.test(text)) {
    return 'adapter_candidate_submission_lifecycle';
  }
  if (/paperctl_modules\/paper_production_.*(audit|architecture|comparison|v2_|contract_frontier|gap_|gate_consumer|upstream_integrity)/.test(text)) {
    return 'quarantine_control_plane_report';
  }
  if (/paperctl_modules\/report_|paperctl_modules\/report(events|_events|_io|_schema|_ref_health)/.test(text)) {
    return 'quarantine_control_plane_report';
  }
  if (/paperctl_modules\/(capability|factory_command_state_ownership|paper_workflow|release_boundary|round_runner|scheduler_autopilot|task_graph|rust_promotion|__init__)\.py$/.test(text)) {
    return 'retire_legacy_orchestration_control_plane';
  }
  if (/paperctl_modules\/decision_points\.py$/.test(text)) {
    return 'adapter_candidate_venue_source_decision';
  }
  if (/paperctl_modules\/llm_|paperctl_modules\/agent_autonomy|paperctl_modules\/manual_boundary/.test(text)) {
    return 'retire_llm_or_manual_control_plane';
  }
  if (/paperctl_modules\/paper_production_.*(external|submission|portal|executor|lifecycle|handoff)/.test(text)) {
    return 'adapter_candidate_submission_lifecycle';
  }
  if (/paperctl_modules\/paper_production_.*(source|artifact|package|archive|mutation)/.test(text)) {
    return 'adapter_candidate_source_package';
  }
  if (/paperctl_modules\/paper_production_.*(venue|operator_drop|readiness|final_settlement)/.test(text)) {
    return 'adapter_candidate_venue_source_decision';
  }
  if (/paperctl_modules\/paper_production_.*(referee|repair)/.test(text)) {
    return 'adapter_candidate_referee_revision';
  }
  if (/paperctl_modules\/.*(capstone|matrix|roadmap|latest|report_only|report-|_report|doctor|hygiene|parity)/.test(text)) {
    return 'quarantine_control_plane_report';
  }
  if (/paperctl_modules\/research_compute_/.test(text)) return 'adapter_candidate_research_compute';
  if (/paperctl_modules\/.*referee|plugins\/core\/referee/.test(text)) return 'adapter_candidate_referee_revision';
  if (/plugins\/core\//.test(text)) return 'adapter_candidate_plugin_wrapper';
  if (/schema\/|registry\/|templates\/|docs\//.test(text)) return 'domain_asset_or_documentation';
  return 'review_manually';
}

function migrationTargetFor(relative, disposition) {
  const text = normalizeText(relative).toLowerCase();
  if (disposition === 'blocked_primary_entrypoint') return 'paper-core/bin/paper-production-core.mjs';
  if (disposition === 'retire_legacy_production_core') return 'paper-core/src/paper-batch-runner.mjs';
  if (disposition === 'adapter_candidate_research_compute') return 'paper-adapters/research-verify';
  if (disposition === 'adapter_candidate_referee_revision') {
    if (/plugins\/core\/(referee|substantive-referee)/.test(text)) return 'paper-adapters/referee-review';
    return 'paper-adapters/referee-revise';
  }
  if (disposition === 'adapter_candidate_submission_lifecycle') return 'paper-adapters/submission';
  if (disposition === 'adapter_candidate_source_package') return 'paper-adapters/build-package';
  if (disposition === 'adapter_candidate_venue_source_decision') {
    return /source/.test(text) ? 'paper-adapters/source-adapt' : 'paper-adapters/venue-resolve';
  }
  if (disposition === 'adapter_candidate_plugin_wrapper') {
    if (/compile/.test(text)) return 'paper-adapters/build-package';
    if (/evidence/.test(text)) return 'paper-adapters/research-verify';
    if (/packager/.test(text)) return 'paper-adapters/build-package';
    if (/referee/.test(text)) return 'paper-adapters/referee-review/referee-revise';
    if (/venue|external/.test(text)) return 'paper-adapters/submission/venue-resolve';
    return 'paper-adapters';
  }
  if (disposition === 'domain_asset_or_documentation') {
    if (/registry\//.test(text)) return 'paper-adapters/inventory';
    if (/schema\//.test(text)) return 'paper-core/docs/data-model';
    if (/templates\//.test(text)) return 'paper-adapters/proposal/source-adapt';
    return 'paper-core/docs';
  }
  if (disposition === 'retire_llm_or_manual_control_plane') return 'retired: old llm/manual control plane';
  if (disposition === 'retire_legacy_orchestration_control_plane') return 'retired: old orchestration control plane';
  if (disposition === 'quarantine_control_plane_report') return 'retired: report/capstone/matrix quarantine';
  return 'migration/retirement review queue';
}

function migrationActionFor(relative, disposition) {
  const text = normalizeText(relative).toLowerCase();
  if (disposition === 'blocked_primary_entrypoint') {
    return 'replace_entrypoint_with_paper_production_core';
  }
  if (disposition === 'retire_legacy_production_core') {
    return 'retire_after_batch_runner_and_adapters_cover_workflow';
  }
  if (disposition === 'retire_llm_or_manual_control_plane') {
    return 'retire_not_migrate';
  }
  if (disposition === 'retire_legacy_orchestration_control_plane') {
    return 'retire_not_migrate';
  }
  if (disposition === 'quarantine_control_plane_report') {
    return 'quarantine_not_migrate';
  }
  if (disposition === 'adapter_candidate_research_compute') {
    return 'extract_worker_semantics_into_research_verify_receipts';
  }
  if (disposition === 'adapter_candidate_referee_revision') {
    return /plugins\/core\/(referee|substantive-referee)/.test(text)
      ? 'extract_review_heuristics_into_referee_review'
      : 'extract_repair_semantics_into_referee_revise';
  }
  if (disposition === 'adapter_candidate_submission_lifecycle') {
    return 'extract_external_lifecycle_contracts_without_live_action';
  }
  if (disposition === 'adapter_candidate_source_package') {
    return 'extract_source_package_rules_into_build_package_adapter';
  }
  if (disposition === 'adapter_candidate_venue_source_decision') {
    return 'extract_decision_rules_into_venue_or_source_adapter';
  }
  if (disposition === 'adapter_candidate_plugin_wrapper') {
    return 'replace_plugin_wrapper_with_native_paper_adapter';
  }
  if (disposition === 'domain_asset_or_documentation') {
    return 'promote_domain_asset_or_archive_reference';
  }
  return 'triage_manually_then_assign_target_adapter';
}

function retirementWaveFor(disposition, action) {
  if (disposition === 'blocked_primary_entrypoint') return 'wave_0_freeze_legacy_entrypoints';
  if (disposition === 'retire_legacy_production_core') return 'wave_6_remove_old_control_plane';
  if (disposition === 'retire_llm_or_manual_control_plane') return 'wave_5_quarantine_llm_manual_control_plane';
  if (disposition === 'retire_legacy_orchestration_control_plane') return 'wave_5_quarantine_llm_manual_control_plane';
  if (disposition === 'quarantine_control_plane_report') return 'wave_5_quarantine_reports_matrices_capstones';
  if (action === 'promote_domain_asset_or_archive_reference') return 'wave_1_promote_data_assets';
  if (disposition === 'adapter_candidate_research_compute') return 'wave_2_research_compute_semantics';
  if (disposition === 'adapter_candidate_referee_revision') return 'wave_3_referee_review_and_repair_semantics';
  if (disposition === 'adapter_candidate_source_package') return 'wave_2_source_package_semantics';
  if (disposition === 'adapter_candidate_submission_lifecycle') return 'wave_4_submission_lifecycle_semantics';
  if (disposition === 'adapter_candidate_venue_source_decision') return 'wave_4_venue_source_decision_semantics';
  if (disposition === 'adapter_candidate_plugin_wrapper') return 'wave_3_plugin_wrapper_replacement';
  return 'wave_1_manual_triage';
}

function retirementWaveFamilyFor(retirementWave) {
  if (retirementWave === 'wave_0_freeze_legacy_entrypoints') return 'wave_0_freeze_legacy_entrypoints';
  if (retirementWave === 'wave_6_remove_old_control_plane') return 'wave_6_remove_old_control_plane';
  if (retirementWave.startsWith('wave_1_')) return 'wave_1_promote_registry_schema_templates_docs';
  if (retirementWave.startsWith('wave_2_')) return 'wave_2_migrate_research_source_package_semantics';
  if (retirementWave.startsWith('wave_3_')) return 'wave_3_migrate_referee_review_repair_semantics';
  if (retirementWave.startsWith('wave_4_')) return 'wave_4_migrate_submission_venue_source_decision_semantics';
  if (retirementWave.startsWith('wave_5_')) return 'wave_5_quarantine_reports_matrices_capstones_llm_manual_chains';
  return 'wave_1_promote_registry_schema_templates_docs';
}

function priorityFor(disposition, action) {
  if (disposition === 'blocked_primary_entrypoint') return 'P0';
  if (disposition === 'retire_legacy_production_core') return 'P0';
  if (/^extract_|replace_plugin_wrapper/.test(action)) return 'P1';
  if (/promote_domain_asset/.test(action)) return 'P2';
  if (/quarantine|retire_not_migrate/.test(action)) return 'P3';
  return 'P2';
}

function enrichLegacyEntry(entry) {
  const migrationAction = migrationActionFor(entry.path, entry.disposition);
  const targetAdapter = migrationTargetFor(entry.path, entry.disposition);
  const retirementWave = retirementWaveFor(entry.disposition, migrationAction);
  return {
    ...entry,
    targetAdapter,
    migrationAction,
    retirementWave,
    retirementWaveFamily: retirementWaveFamilyFor(retirementWave),
    priority: priorityFor(entry.disposition, migrationAction),
  };
}


export { RETIREMENT_WAVES, classifyLegacyFile, migrationTargetFor, migrationActionFor, retirementWaveFor, retirementWaveFamilyFor, priorityFor, enrichLegacyEntry };
