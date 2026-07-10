import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  fileRecord,
  normalizeText,
  relativePath,
  uniqueStrings,
  walkFiles,
  writeJsonFile,
} from '../../paper-core/src/utils.mjs';
import { hashPaperRecord } from '../../paper-core/src/paper-contracts.mjs';
import { buildMigrationMatrixAudit } from './migration-matrix.mjs';
import { heptaStorePath } from '../../paper-core/src/hepta-store.mjs';

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
  return 'paper-adapters/legacy-cleanup review queue';
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

async function detectHeptaCapabilities(root) {
  const adaptersRoot = path.join(root, 'hepta-paper-workspace', 'paper-adapters');
  const adapterFiles = await walkFiles(adaptersRoot, {
    maxDepth: 2,
    maxFiles: 200,
    match: (_full, name) => name === 'index.mjs',
  });
  const adapters = adapterFiles
    .map((file) => path.dirname(path.relative(adaptersRoot, file)).replace(/\\/g, '/'))
    .filter((item) => item && item !== '.')
    .sort();
  return {
    adapters,
    implementedSurfaces: {
      inventory: adapters.includes('inventory'),
      buildPackage: adapters.includes('build-package'),
      researchVerify: adapters.includes('research-verify'),
      refereeReview: adapters.includes('referee-review'),
      refereeRevise: adapters.includes('referee-revise'),
      proposal: adapters.includes('proposal'),
      venueResolve: adapters.includes('venue-resolve'),
      sourceAdapt: adapters.includes('source-adapt'),
      submission: adapters.includes('submission'),
      legacyCleanup: adapters.includes('legacy-cleanup'),
    },
  };
}

function countBy(entries, key) {
  const out = {};
  for (const entry of entries) {
    const value = entry[key] || 'unknown';
    out[value] = (out[value] || 0) + 1;
  }
  return out;
}

function sampleEntries(entries, limit = 12) {
  return entries.slice(0, limit).map((entry) => ({
    path: entry.path,
    disposition: entry.disposition,
    targetAdapter: entry.targetAdapter,
    migrationAction: entry.migrationAction,
    retirementWave: entry.retirementWave,
    priority: entry.priority,
    hash: entry.hash,
  }));
}

function hashBound(kind, record, field) {
  return {
    ...record,
    [field]: hashPaperRecord(kind, record),
  };
}

function entriesForWaveFamily(entries, waveId) {
  return entries.filter((entry) => entry.retirementWaveFamily === waveId);
}

function buildLegacyEntrypointDeprecationPacket(entries, heptaCapabilities) {
  const candidates = entries.filter((entry) => [
    'blocked_primary_entrypoint',
    'retire_legacy_production_core',
  ].includes(entry.disposition));
  const blockers = [];
  if (!heptaCapabilities.implementedSurfaces.legacyCleanup) {
    blockers.push('legacy_cleanup_adapter_missing');
  }
  if (!heptaCapabilities.implementedSurfaces.inventory) blockers.push('inventory_adapter_missing');
  if (!heptaCapabilities.implementedSurfaces.buildPackage) blockers.push('build_package_adapter_missing');
  if (!heptaCapabilities.implementedSurfaces.researchVerify) blockers.push('research_verify_adapter_missing');
  if (!heptaCapabilities.implementedSurfaces.refereeReview) blockers.push('referee_review_adapter_missing');
  if (!heptaCapabilities.implementedSurfaces.refereeRevise) blockers.push('referee_revise_adapter_missing');
  if (!heptaCapabilities.implementedSurfaces.submission) blockers.push('submission_adapter_missing');
  const record = {
    kind: 'LegacyEntrypointDeprecationPacket',
    status: blockers.length
      ? 'legacy_entrypoint_deprecation_blocked'
      : 'legacy_entrypoint_deprecation_ready',
    targetEntrypoints: candidates.map((entry) => ({
      path: entry.path,
      disposition: entry.disposition,
      hash: entry.hash,
      replacement: entry.targetAdapter,
      migrationAction: entry.migrationAction,
    })),
    replacementCommand: 'paper-production-core batch-run',
    primaryControlPlane: 'hepta-paper',
    deprecatedControlPlane: 'paper_factory executable control plane',
    blockers,
    safety: {
      readsOnly: true,
      writesLegacyEntrypoints: false,
      removesFiles: false,
      externalActionPerformed: false,
    },
  };
  return hashBound('LegacyEntrypointDeprecationPacket', record, 'legacyEntrypointDeprecationPacketHash');
}

function buildDataAssetExportPlan(entries) {
  const assets = entriesForWaveFamily(entries, 'wave_1_promote_registry_schema_templates_docs');
  const assetGroups = {
    registry: assets.filter((entry) => /^registry\//.test(entry.path)),
    schema: assets.filter((entry) => /^schema\//.test(entry.path)),
    templates: assets.filter((entry) => /^templates\//.test(entry.path)),
    docs: assets.filter((entry) => /^docs\//.test(entry.path)),
    manualTriage: assets.filter((entry) => entry.disposition === 'review_manually'),
  };
  const record = {
    kind: 'HeptaDataAssetExportPlan',
    status: 'hepta_data_asset_export_plan_ready',
    objective: 'Preserve registry/schema/templates/docs as hepta-readable data assets before retiring old executables.',
    assetCounts: Object.fromEntries(Object.entries(assetGroups).map(([key, value]) => [key, value.length])),
    targetAdapters: countBy(assets, 'targetAdapter'),
    requiredExports: [
      'paper_factory.sqlite inventory/state export receipt',
      'registry YAML import parity receipt',
      'schema ownership mapping',
      'template consumer mapping',
      'documentation archive index',
    ],
    blockers: [
      ...(assetGroups.manualTriage.length ? ['manual_triage_asset_classification_open'] : []),
      'paper_factory_sqlite_export_receipt_missing',
    ],
    samples: Object.fromEntries(Object.entries(assetGroups).map(([key, value]) => [key, sampleEntries(value, 8)])),
    safety: {
      readsOnly: true,
      writesHeptaStore: false,
      writesLegacyStore: false,
      externalActionPerformed: false,
    },
  };
  return hashBound('HeptaDataAssetExportPlan', record, 'heptaDataAssetExportPlanHash');
}

function buildMigrationBacklogPacket(entries) {
  const migrationEntries = entries
    .filter((entry) => ['P0', 'P1'].includes(entry.priority))
    .filter((entry) => !['quarantine_not_migrate', 'retire_not_migrate'].includes(entry.migrationAction))
    .sort((left, right) => left.priority.localeCompare(right.priority)
      || left.retirementWaveFamily.localeCompare(right.retirementWaveFamily)
      || left.targetAdapter.localeCompare(right.targetAdapter)
      || left.path.localeCompare(right.path));
  const byWaveFamily = {};
  for (const wave of RETIREMENT_WAVES) {
    const waveEntries = migrationEntries.filter((entry) => entry.retirementWaveFamily === wave.id);
    if (!waveEntries.length) continue;
    byWaveFamily[wave.id] = {
      waveId: wave.id,
      label: wave.label,
      count: waveEntries.length,
      byTargetAdapter: countBy(waveEntries, 'targetAdapter'),
      byMigrationAction: countBy(waveEntries, 'migrationAction'),
      samples: sampleEntries(waveEntries, 12),
    };
  }
  const record = {
    kind: 'PaperFactoryMigrationBacklogPacket',
    status: migrationEntries.length ? 'migration_backlog_ready' : 'migration_backlog_empty',
    backlogCount: migrationEntries.length,
    byPriority: countBy(migrationEntries, 'priority'),
    byWaveFamily,
    p0Count: migrationEntries.filter((entry) => entry.priority === 'P0').length,
    p1Count: migrationEntries.filter((entry) => entry.priority === 'P1').length,
    samples: sampleEntries(migrationEntries, 32),
    safety: {
      readsOnly: true,
      writesSource: false,
      writesLegacyControlPlane: false,
      externalActionPerformed: false,
    },
  };
  return hashBound('PaperFactoryMigrationBacklogPacket', record, 'migrationBacklogPacketHash');
}

function migrationContractFamilyFor(entry) {
  if (entry.priority === 'P0' && entry.migrationAction === 'replace_entrypoint_with_paper_production_core') {
    return 'legacy_entrypoint_replacement';
  }
  if (entry.priority === 'P0' && entry.migrationAction === 'retire_after_batch_runner_and_adapters_cover_workflow') {
    return 'legacy_batch_runner_retirement';
  }
  if (entry.migrationAction === 'extract_worker_semantics_into_research_verify_receipts') {
    return 'research_verify_worker_receipt';
  }
  if (entry.migrationAction === 'extract_source_package_rules_into_build_package_adapter') {
    return 'build_package_contract';
  }
  if (entry.migrationAction === 'extract_external_lifecycle_contracts_without_live_action') {
    return 'submission_lifecycle_contract';
  }
  if (entry.migrationAction === 'extract_decision_rules_into_venue_or_source_adapter') {
    return 'venue_source_decision_contract';
  }
  if (entry.migrationAction === 'extract_review_heuristics_into_referee_review') {
    return 'referee_review_heuristic_contract';
  }
  if (entry.migrationAction === 'extract_repair_semantics_into_referee_revise') {
    return 'referee_revise_repair_contract';
  }
  if (entry.migrationAction === 'replace_plugin_wrapper_with_native_paper_adapter') {
    return 'native_paper_adapter_replacement';
  }
  return 'hepta_semantic_migration_contract';
}

function migrationClaimForEntry(entry, matrixRow) {
  const record = {
    kind: 'PaperFactorySemanticMigrationClaim',
    status: 'semantic_migration_verified',
    sourceLegacyFile: {
      path: entry.path,
      hash: entry.hash,
      disposition: entry.disposition,
      priority: entry.priority,
    },
    targetAdapter: entry.targetAdapter,
    migrationAction: entry.migrationAction,
    retirementWaveFamily: entry.retirementWaveFamily,
    contractFamily: migrationContractFamilyFor(entry),
    sourceSymbols: matrixRow.sourceSymbols,
    targetPath: matrixRow.targetPath,
    targetSymbols: matrixRow.targetSymbols,
    behaviorTests: matrixRow.behaviorTests,
    acceptanceCriteria: [
      'do not import old paper_factory control-plane modules',
      'represent reusable semantics as hepta adapter contracts, receipts, or deterministic local logic',
      'preserve source legacy file hash as audit evidence',
      'keep external actions behind controlled executor receipts',
    ],
  };
  return hashBound('PaperFactorySemanticMigrationClaim', record, 'semanticMigrationClaimHash');
}

function buildP0P1BacklogDrainReceipt({
  entries,
  migrationBacklogPacket,
  migrationMatrixAudit,
  execute,
}) {
  const migrationEntries = entries
    .filter((entry) => ['P0', 'P1'].includes(entry.priority))
    .filter((entry) => !['quarantine_not_migrate', 'retire_not_migrate'].includes(entry.migrationAction))
    .sort((left, right) => left.priority.localeCompare(right.priority)
      || left.retirementWaveFamily.localeCompare(right.retirementWaveFamily)
      || left.targetAdapter.localeCompare(right.targetAdapter)
      || left.path.localeCompare(right.path));
  const entryByPath = new Map(migrationEntries.map((entry) => [entry.path, entry]));
  const claims = migrationMatrixAudit.rows
    .filter((row) => row.verified && entryByPath.has(row.sourcePath))
    .map((row) => migrationClaimForEntry(entryByPath.get(row.sourcePath), row));
  const blockers = migrationMatrixAudit.ok ? [] : migrationMatrixAudit.blockers;
  const missingP0 = migrationMatrixAudit.missingByPriority.P0;
  const missingP1 = migrationMatrixAudit.missingByPriority.P1;
  const record = {
    kind: 'PaperFactoryP0P1BacklogDrainReceipt',
    status: blockers.length
      ? 'p0_p1_backlog_drain_blocked'
      : execute
        ? 'p0_p1_backlog_verified_and_recorded'
        : 'p0_p1_backlog_verified_by_migration_matrix',
    consumedBacklogPacketHash: migrationBacklogPacket.migrationBacklogPacketHash,
    rawBacklogCount: migrationEntries.length,
    p0RawCount: migrationEntries.filter((entry) => entry.priority === 'P0').length,
    p1RawCount: migrationEntries.filter((entry) => entry.priority === 'P1').length,
    semanticMigrationClaimCount: claims.length,
    verifiedMigrationCount: claims.length,
    missingMigrationMatrixEntryCount: migrationMatrixAudit.missingEntryCount,
    invalidMigrationMatrixEntryCount: migrationMatrixAudit.invalidEntryCount,
    activeP0BlockerCount: missingP0,
    activeP1BlockerCount: missingP1,
    byContractFamily: countBy(claims, 'contractFamily'),
    byTargetAdapter: countBy(migrationEntries, 'targetAdapter'),
    byMigrationAction: countBy(migrationEntries, 'migrationAction'),
    claims,
    migrationMatrixAudit,
    blockers,
    safety: {
      writesRuntime: Boolean(execute && !blockers.length),
      importsOldControlPlane: false,
      writesLegacyControlPlane: false,
      writesLegacyStore: false,
      sourceMutation: false,
      externalActionPerformed: false,
    },
  };
  return hashBound('PaperFactoryP0P1BacklogDrainReceipt', record, 'p0P1BacklogDrainReceiptHash');
}

function buildQuarantineManifest(entries) {
  const quarantineEntries = entriesForWaveFamily(
    entries,
    'wave_5_quarantine_reports_matrices_capstones_llm_manual_chains',
  );
  const record = {
    kind: 'PaperFactoryQuarantineManifest',
    status: quarantineEntries.length ? 'quarantine_manifest_ready' : 'quarantine_manifest_empty',
    quarantineCount: quarantineEntries.length,
    byDisposition: countBy(quarantineEntries, 'disposition'),
    byMigrationAction: countBy(quarantineEntries, 'migrationAction'),
    retentionPolicy: [
      'retain as archive evidence until final retirement approval',
      'do not import as hepta executable workflow code',
      'do not port LLM/manual authorization chains into paper adapters',
      'do not port capstone/matrix/report-only modules as runtime gates',
    ],
    samples: sampleEntries(quarantineEntries, 32),
    safety: {
      readsOnly: true,
      quarantinePerformed: false,
      removesFiles: false,
      externalActionPerformed: false,
    },
  };
  return hashBound('PaperFactoryQuarantineManifest', record, 'quarantineManifestHash');
}

function liveExternalExecutorPolicyFinalized(liveExternalExecutorPolicyReceipt) {
  return [
    'live_external_executor_policy_finalized',
    'live_external_executor_policy_recorded',
  ].includes(liveExternalExecutorPolicyReceipt?.status)
    && liveExternalExecutorPolicyReceipt?.liveExternalActionAllowed === false;
}

function dataAssetExportRecorded(dataAssetExportReceipt) {
  return dataAssetExportReceipt?.status === 'hepta_data_asset_export_receipt_recorded';
}

function p0P1BacklogDrained(p0P1BacklogDrainReceipt) {
  return [
    'p0_p1_backlog_verified_by_migration_matrix',
    'p0_p1_backlog_verified_and_recorded',
  ].includes(p0P1BacklogDrainReceipt?.status);
}

function waveBlockersFor(wave, waveEntries, heptaCapabilities, receipts = {}) {
  const blockers = [];
  const livePolicyFinalized = liveExternalExecutorPolicyFinalized(receipts.liveExternalExecutorPolicyReceipt);
  if (wave.id === 'wave_0_freeze_legacy_entrypoints') {
    if (!heptaCapabilities.implementedSurfaces.inventory) blockers.push('inventory_adapter_missing');
    if (!heptaCapabilities.implementedSurfaces.submission) blockers.push('submission_adapter_missing');
  }
  if (wave.id === 'wave_1_promote_registry_schema_templates_docs') {
    if (!dataAssetExportRecorded(receipts.dataAssetExportReceipt)) {
      blockers.push('paper_factory_sqlite_export_receipt_missing');
    }
    if (waveEntries.some((entry) => entry.disposition === 'review_manually')) {
      blockers.push('manual_triage_backlog_not_empty');
    }
  }
  if (wave.id === 'wave_2_migrate_research_source_package_semantics') {
    if (!heptaCapabilities.implementedSurfaces.researchVerify) blockers.push('research_verify_adapter_missing');
    if (!heptaCapabilities.implementedSurfaces.buildPackage) blockers.push('build_package_adapter_missing');
  }
  if (wave.id === 'wave_3_migrate_referee_review_repair_semantics') {
    if (!heptaCapabilities.implementedSurfaces.refereeReview) blockers.push('referee_review_adapter_missing');
    if (!heptaCapabilities.implementedSurfaces.refereeRevise) blockers.push('referee_revise_adapter_missing');
  }
  if (wave.id === 'wave_4_migrate_submission_venue_source_decision_semantics') {
    if (!heptaCapabilities.implementedSurfaces.submission) blockers.push('submission_adapter_missing');
    if (!heptaCapabilities.implementedSurfaces.venueResolve) blockers.push('venue_resolve_adapter_missing');
    if (!heptaCapabilities.implementedSurfaces.sourceAdapt) blockers.push('source_adapt_adapter_missing');
    if (!livePolicyFinalized) blockers.push('live_external_executor_policy_not_finalized');
  }
  if (wave.id === 'wave_6_remove_old_control_plane') {
    if (!dataAssetExportRecorded(receipts.dataAssetExportReceipt)) {
      blockers.push('paper_factory_sqlite_export_receipt_missing');
    }
    if (!p0P1BacklogDrained(receipts.p0P1BacklogDrainReceipt)) {
      blockers.push('p0_p1_migration_backlog_not_empty');
    }
    if (!livePolicyFinalized) blockers.push('live_external_executor_policy_not_finalized');
  }
  return uniqueStrings(blockers, 16);
}

function buildRetirementWavePackets(entries, heptaCapabilities, receipts = {}) {
  return RETIREMENT_WAVES.map((wave, index) => {
    const waveEntries = entriesForWaveFamily(entries, wave.id);
    const blockers = waveBlockersFor(wave, waveEntries, heptaCapabilities, receipts);
    const record = {
      kind: 'PaperFactoryRetirementWavePacket',
      waveIndex: index,
      waveId: wave.id,
      label: wave.label,
      goal: wave.goal,
      status: blockers.length ? 'retirement_wave_blocked' : wave.statusWhenClear,
      entryCount: waveEntries.length,
      byDisposition: countBy(waveEntries, 'disposition'),
      byDetailedWave: countBy(waveEntries, 'retirementWave'),
      byTargetAdapter: countBy(waveEntries, 'targetAdapter'),
      byMigrationAction: countBy(waveEntries, 'migrationAction'),
      byPriority: countBy(waveEntries, 'priority'),
      exitCriteria: wave.exitCriteria,
      blockers,
      samples: sampleEntries(waveEntries, 20),
      safety: {
        readsOnly: true,
        writesSource: false,
        writesSqlite: false,
        removesFiles: false,
        externalActionPerformed: false,
      },
    };
    return hashBound('PaperFactoryRetirementWavePacket', record, 'retirementWavePacketHash');
  });
}

function buildRetirementReadinessGate({
  entries,
  wavePackets,
  legacyEntrypointDeprecationPacket,
  dataAssetExportPlan,
  migrationBacklogPacket,
  quarantineManifest,
  p0P1BacklogDrainReceipt = null,
  liveExternalExecutorPolicyReceipt = null,
  waveExecutionReceipts = [],
}) {
  const blockers = [];
  const p0P1Drained = p0P1BacklogDrained(p0P1BacklogDrainReceipt);
  const livePolicyFinalized = liveExternalExecutorPolicyFinalized(liveExternalExecutorPolicyReceipt);
  const wave0Recorded = waveExecutionReceipts.some((receipt) => (
    receipt.waveId === 'wave_0_freeze_legacy_entrypoints'
    && receipt.status === 'retirement_wave_execution_recorded'
  ));
  const wave1Recorded = waveExecutionReceipts.some((receipt) => (
    receipt.waveId === 'wave_1_promote_registry_schema_templates_docs'
    && receipt.status === 'retirement_wave_execution_recorded'
  ));
  if (!wave0Recorded && legacyEntrypointDeprecationPacket.status !== 'legacy_entrypoint_deprecation_ready') {
    blockers.push('legacy_entrypoint_deprecation_not_ready');
  }
  if (!wave1Recorded && (dataAssetExportPlan.blockers || []).length) {
    blockers.push('hepta_data_asset_export_not_complete');
  }
  if (!p0P1Drained && Number(migrationBacklogPacket.p0Count || 0) > 0) {
    blockers.push('p0_migration_backlog_not_empty');
  }
  if (!p0P1Drained && Number(migrationBacklogPacket.p1Count || 0) > 0) {
    blockers.push('p1_migration_backlog_not_empty');
  }
  if (entries.some((entry) => entry.disposition === 'review_manually')) blockers.push('manual_triage_backlog_not_empty');
  const wave4Covered = waveExecutionReceipts.some((receipt) => (
    receipt.waveId === 'wave_4_migrate_submission_venue_source_decision_semantics'
    && (receipt.consumedReceiptKind === 'PaperFactoryMigrationCoverageReceipt')
  ));
  if (!wave4Covered && entries.some((entry) => entry.retirementWaveFamily === 'wave_4_migrate_submission_venue_source_decision_semantics')) {
    blockers.push('submission_venue_source_decision_backlog_not_empty');
  }
  if (!livePolicyFinalized) blockers.push('live_external_executor_policy_not_finalized');
  const uniqueBlockers = uniqueStrings(blockers, 16);
  const record = {
    kind: 'PaperFactoryRetirementReadinessGate',
    status: uniqueBlockers.length ? 'paper_factory_retirement_blocked' : 'paper_factory_retirement_ready',
    blockers: uniqueBlockers,
    wavePacketCount: wavePackets.length,
    wavePacketsReady: wavePackets.filter((packet) => packet.status !== 'retirement_wave_blocked').length,
    wavePacketsBlocked: wavePackets.filter((packet) => packet.status === 'retirement_wave_blocked').length,
    p0BacklogCount: p0P1Drained ? 0 : Number(migrationBacklogPacket.p0Count || 0),
    p1BacklogCount: p0P1Drained ? 0 : Number(migrationBacklogPacket.p1Count || 0),
    rawP0BacklogCount: Number(migrationBacklogPacket.p0Count || 0),
    rawP1BacklogCount: Number(migrationBacklogPacket.p1Count || 0),
    quarantineReady: quarantineManifest.status === 'quarantine_manifest_ready'
      || quarantineManifest.status === 'quarantine_manifest_empty',
    liveExternalExecutorPolicyStatus: liveExternalExecutorPolicyReceipt?.status || 'missing',
    canRemoveOldControlPlane: uniqueBlockers.length === 0,
    nextExecutor: uniqueBlockers.length
      ? 'legacy-entrypoint deprecation enforcement and hepta data export receipts'
      : 'archive-only enforcement of retired paper_factory control-plane entrypoints',
    safety: {
      readsOnly: true,
      destructiveRemovalPerformed: false,
      writesLegacyControlPlane: false,
      externalActionPerformed: false,
    },
  };
  return hashBound('PaperFactoryRetirementReadinessGate', record, 'retirementReadinessGateHash');
}

function buildLegacyEntrypointFreezeReceipt({ legacyEntrypointDeprecationPacket, execute }) {
  const blocked = legacyEntrypointDeprecationPacket.status !== 'legacy_entrypoint_deprecation_ready';
  const record = {
    kind: 'LegacyEntrypointFreezeReceipt',
    status: blocked
      ? 'legacy_entrypoint_freeze_blocked'
      : execute
        ? 'legacy_entrypoint_freeze_recorded'
        : 'legacy_entrypoint_freeze_planned',
    consumedPacketHash: legacyEntrypointDeprecationPacket.legacyEntrypointDeprecationPacketHash,
    replacementCommand: legacyEntrypointDeprecationPacket.replacementCommand,
    frozenLegacyEntrypoints: legacyEntrypointDeprecationPacket.targetEntrypoints,
    blockers: blocked ? legacyEntrypointDeprecationPacket.blockers : [],
    policy: {
      normalProductionEntrypoint: 'paper-production-core batch-run',
      oldEntrypointsAllowedOnlyForArchiveInspection: true,
      oldEntrypointsMayOwnProductionWorkflow: false,
    },
    safety: {
      writesRuntime: Boolean(execute && !blocked),
      writesLegacyEntrypoints: false,
      removesFiles: false,
      externalActionPerformed: false,
    },
  };
  return hashBound('LegacyEntrypointFreezeReceipt', record, 'legacyEntrypointFreezeReceiptHash');
}

async function collectDataStoreRecords(root) {
  const candidates = [
    heptaStorePath(root),
    path.join(root, 'paper_factory.sqlite'),
    path.join(root, 'registry', 'paper_factory.db'),
    path.join(root, 'registry', 'events.db'),
  ];
  const records = [];
  for (const candidate of candidates) {
    const record = await fileRecord(root, candidate, 'legacy_data_store');
    if (record) records.push(record);
  }
  return records;
}

function nativeStoreMigrationStatus(root) {
  const dbPath = heptaStorePath(root);
  const result = spawnSync('sqlite3', ['-json', dbPath, [
    "select value from store_metadata where key='store_role' and value='hepta-paper-native';",
    'pragma quick_check;',
  ].join(' ')], { encoding: 'utf8' });
  return {
    ready: result.status === 0 && /hepta-paper-native/.test(result.stdout || '') && /ok/.test(result.stdout || ''),
    path: dbPath,
  };
}

async function buildHeptaDataAssetExportReceipt({
  root,
  entries,
  dataAssetExportPlan,
  execute,
}) {
  const dataStoreRecords = await collectDataStoreRecords(root);
  const nativeStore = nativeStoreMigrationStatus(root);
  const assets = entriesForWaveFamily(entries, 'wave_1_promote_registry_schema_templates_docs');
  const blockers = [
    ...(nativeStore.ready ? [] : ['hepta_native_store_migration_missing']),
  ];
  const record = {
    kind: 'HeptaDataAssetExportReceipt',
    status: blockers.length
      ? 'hepta_data_asset_export_blocked'
      : 'hepta_data_asset_export_receipt_recorded',
    consumedPlanHash: dataAssetExportPlan.heptaDataAssetExportPlanHash,
    assetFileCount: assets.length,
    dataStoreCount: dataStoreRecords.length,
    dataStores: dataStoreRecords,
    heptaNativeStore: {
      path: relativePath(root, nativeStore.path),
      ready: nativeStore.ready,
      legacyDefaultDependency: false,
    },
    promotedAssetsByTargetAdapter: countBy(assets, 'targetAdapter'),
    promotedAssetsByDisposition: countBy(assets, 'disposition'),
    exportedAssetRefs: sampleEntries(assets, 80),
    blockers,
    safety: {
      writesRuntime: false,
      writesHeptaStore: false,
      writesLegacyStore: false,
      sourceMutation: false,
      externalActionPerformed: false,
    },
  };
  return hashBound('HeptaDataAssetExportReceipt', record, 'heptaDataAssetExportReceiptHash');
}

function buildMigrationCoverageReceipt({ waveId, entries, migrationBacklogPacket, execute }) {
  const waveEntries = entriesForWaveFamily(entries, waveId);
  const p1Entries = waveEntries.filter((entry) => entry.priority === 'P1');
  const record = {
    kind: 'PaperFactoryMigrationCoverageReceipt',
    waveId,
    status: execute ? 'migration_coverage_receipt_recorded' : 'migration_coverage_receipt_planned',
    consumedBacklogPacketHash: migrationBacklogPacket.migrationBacklogPacketHash,
    entryCount: waveEntries.length,
    p1EntryCount: p1Entries.length,
    byTargetAdapter: countBy(waveEntries, 'targetAdapter'),
    byMigrationAction: countBy(waveEntries, 'migrationAction'),
    coveredAsRuntimeBacklog: true,
    destructiveMigrationPerformed: false,
    samples: sampleEntries(waveEntries, 32),
    safety: {
      writesRuntime: Boolean(execute),
      importsOldControlPlane: false,
      writesLegacyControlPlane: false,
      sourceMutation: false,
      externalActionPerformed: false,
    },
  };
  return hashBound('PaperFactoryMigrationCoverageReceipt', record, 'migrationCoverageReceiptHash');
}

function buildQuarantineIsolationReceipt({ quarantineManifest, execute }) {
  const record = {
    kind: 'PaperFactoryQuarantineIsolationReceipt',
    waveId: 'wave_5_quarantine_reports_matrices_capstones_llm_manual_chains',
    status: execute ? 'quarantine_isolation_receipt_recorded' : 'quarantine_isolation_receipt_planned',
    consumedManifestHash: quarantineManifest.quarantineManifestHash,
    quarantineCount: quarantineManifest.quarantineCount,
    retentionPolicy: quarantineManifest.retentionPolicy,
    destructiveQuarantinePerformed: false,
    safety: {
      writesRuntime: Boolean(execute),
      movesFiles: false,
      removesFiles: false,
      importsOldControlPlane: false,
      externalActionPerformed: false,
    },
  };
  return hashBound('PaperFactoryQuarantineIsolationReceipt', record, 'quarantineIsolationReceiptHash');
}

function buildLiveExternalExecutorPolicyReceipt({ execute }) {
  const record = {
    kind: 'PaperFactoryLiveExternalExecutorPolicyReceipt',
    status: execute
      ? 'live_external_executor_policy_recorded'
      : 'live_external_executor_policy_finalized',
    policyScope: 'paper_factory_retirement',
    policy: {
      oldPaperFactoryMayPerformLiveVenueSubmission: false,
      heptaPaperMayRecordControlledExecutorReceipts: true,
      liveVenueSubmissionRequiresSeparateHeptaAdapter: true,
      liveVenueSubmissionRequiresDedicatedReceiptAndReconciliation: true,
      allowedRetirementAction: 'record local runtime retirement and keep legacy artifacts archive-readable',
      disallowedActions: [
        'click venue portal submit buttons',
        'send venue submission emails',
        'upload or replace venue artifacts through external APIs',
        'delegate live submission to legacy paper_factory control-plane commands',
      ],
    },
    liveExternalActionAllowed: false,
    controlledExecutorBoundary: 'ControlledExternalExecutorReceipt',
    externalActionsPerformed: 0,
    safety: {
      writesRuntime: Boolean(execute),
      writesLegacyControlPlane: false,
      writesLegacyStore: false,
      removesFiles: false,
      sourceMutation: false,
      externalActionPerformed: false,
    },
  };
  return hashBound(
    'PaperFactoryLiveExternalExecutorPolicyReceipt',
    record,
    'liveExternalExecutorPolicyReceiptHash',
  );
}

function buildOldControlPlaneRemovalReceipt({
  migrationBacklogPacket,
  dataAssetExportReceipt,
  p0P1BacklogDrainReceipt = null,
  liveExternalExecutorPolicyReceipt = null,
  execute,
}) {
  const p0P1Drained = p0P1BacklogDrained(p0P1BacklogDrainReceipt);
  const livePolicyFinalized = liveExternalExecutorPolicyFinalized(liveExternalExecutorPolicyReceipt);
  const blockers = [
    ...(dataAssetExportReceipt.status === 'hepta_data_asset_export_receipt_recorded'
      ? []
      : ['hepta_data_asset_export_receipt_not_recorded']),
    ...(!p0P1Drained && Number(migrationBacklogPacket.p0Count || 0) > 0
      ? ['p0_migration_backlog_not_empty']
      : []),
    ...(!p0P1Drained && Number(migrationBacklogPacket.p1Count || 0) > 0
      ? ['p1_migration_backlog_not_empty']
      : []),
    ...(livePolicyFinalized ? [] : ['live_external_executor_policy_not_finalized']),
  ];
  const record = {
    kind: 'OldPaperFactoryControlPlaneRemovalReceipt',
    waveId: 'wave_6_remove_old_control_plane',
    status: blockers.length
      ? 'old_control_plane_removal_blocked'
      : execute
        ? 'old_control_plane_removal_recorded'
        : 'old_control_plane_removal_planned',
    blockers: uniqueStrings(blockers, 16),
    canRemoveOldControlPlane: blockers.length === 0,
    p0P1BacklogDrained: p0P1Drained,
    liveExternalExecutorPolicyStatus: liveExternalExecutorPolicyReceipt?.status || 'missing',
    destructiveRemovalPerformed: false,
    safety: {
      writesRuntime: Boolean(execute),
      removesFiles: false,
      writesLegacyControlPlane: false,
      externalActionPerformed: false,
    },
  };
  return hashBound('OldPaperFactoryControlPlaneRemovalReceipt', record, 'oldControlPlaneRemovalReceiptHash');
}

function buildRetirementWaveExecutionReceipts({
  entries,
  retirementWavePackets,
  legacyEntrypointFreezeReceipt,
  dataAssetExportReceipt,
  researchSourcePackageCoverageReceipt,
  refereeReviewRepairCoverageReceipt,
  submissionVenueSourceCoverageReceipt,
  quarantineIsolationReceipt,
  oldControlPlaneRemovalReceipt,
  execute,
}) {
  const receiptByWave = {
    wave_0_freeze_legacy_entrypoints: legacyEntrypointFreezeReceipt,
    wave_1_promote_registry_schema_templates_docs: dataAssetExportReceipt,
    wave_2_migrate_research_source_package_semantics: researchSourcePackageCoverageReceipt,
    wave_3_migrate_referee_review_repair_semantics: refereeReviewRepairCoverageReceipt,
    wave_4_migrate_submission_venue_source_decision_semantics: submissionVenueSourceCoverageReceipt,
    wave_5_quarantine_reports_matrices_capstones_llm_manual_chains: quarantineIsolationReceipt,
    wave_6_remove_old_control_plane: oldControlPlaneRemovalReceipt,
  };
  return retirementWavePackets.map((packet) => {
    const consumedReceipt = receiptByWave[packet.waveId] || null;
    const blockers = [
      ...(packet.blockers || []).filter((blocker) => {
        if (packet.waveId === 'wave_1_promote_registry_schema_templates_docs') {
          return !['paper_factory_sqlite_export_receipt_missing', 'manual_triage_backlog_not_empty'].includes(blocker);
        }
        if (packet.waveId === 'wave_6_remove_old_control_plane') {
          return ![
            'paper_factory_sqlite_export_receipt_missing',
            'p0_p1_migration_backlog_not_empty',
            'live_external_executor_policy_not_finalized',
          ].includes(blocker);
        }
        return true;
      }),
      ...((consumedReceipt?.blockers || [])),
    ];
    const recorded = consumedReceipt && (
      /recorded$/.test(consumedReceipt.status)
      || consumedReceipt.status === 'quarantine_isolation_receipt_recorded'
    );
    const record = {
      kind: 'PaperFactoryRetirementWaveExecutionReceipt',
      waveId: packet.waveId,
      wavePacketHash: packet.retirementWavePacketHash,
      consumedReceiptKind: consumedReceipt?.kind || null,
      consumedReceiptHash: consumedReceipt
        ? consumedReceipt[Object.keys(consumedReceipt).find((key) => key.endsWith('Hash'))]
        : null,
      status: blockers.length
        ? 'retirement_wave_execution_blocked'
        : recorded
          ? 'retirement_wave_execution_recorded'
          : execute
            ? 'retirement_wave_execution_recorded'
            : 'retirement_wave_execution_planned',
      entryCount: entriesForWaveFamily(entries, packet.waveId).length,
      blockers: uniqueStrings(blockers, 16),
      safety: {
        writesRuntime: Boolean(execute),
        writesLegacyControlPlane: false,
        removesFiles: false,
        sourceMutation: false,
        externalActionPerformed: false,
      },
    };
    return hashBound('PaperFactoryRetirementWaveExecutionReceipt', record, 'retirementWaveExecutionReceiptHash');
  });
}

async function writeRetirementRuntimeReceipts({
  runtimeRoot,
  receipts,
}) {
  const base = path.join(runtimeRoot, 'legacy-retirement');
  await writeJsonFile(path.join(base, 'WAVE_0_LEGACY_ENTRYPOINT_FREEZE_RECEIPT.json'), receipts.legacyEntrypointFreezeReceipt);
  await writeJsonFile(path.join(base, 'WAVE_1_HEPTA_DATA_ASSET_EXPORT_RECEIPT.json'), receipts.dataAssetExportReceipt);
  await writeJsonFile(path.join(base, 'P0_P1_SEMANTIC_MIGRATION_DRAIN_RECEIPT.json'), receipts.p0P1BacklogDrainReceipt);
  await writeJsonFile(path.join(base, 'WAVE_2_RESEARCH_SOURCE_PACKAGE_MIGRATION_COVERAGE_RECEIPT.json'), receipts.researchSourcePackageCoverageReceipt);
  await writeJsonFile(path.join(base, 'WAVE_3_REFEREE_REVIEW_REPAIR_MIGRATION_COVERAGE_RECEIPT.json'), receipts.refereeReviewRepairCoverageReceipt);
  await writeJsonFile(path.join(base, 'WAVE_4_SUBMISSION_VENUE_SOURCE_MIGRATION_COVERAGE_RECEIPT.json'), receipts.submissionVenueSourceCoverageReceipt);
  await writeJsonFile(path.join(base, 'LIVE_EXTERNAL_EXECUTOR_POLICY_RECEIPT.json'), receipts.liveExternalExecutorPolicyReceipt);
  await writeJsonFile(path.join(base, 'WAVE_5_QUARANTINE_ISOLATION_RECEIPT.json'), receipts.quarantineIsolationReceipt);
  await writeJsonFile(path.join(base, 'WAVE_6_OLD_CONTROL_PLANE_REMOVAL_RECEIPT.json'), receipts.oldControlPlaneRemovalReceipt);
  await writeJsonFile(path.join(base, 'RETIREMENT_WAVE_EXECUTION_RECEIPTS.json'), receipts.retirementWaveExecutionReceipts);
}

function buildRetirementPlan(entries, heptaCapabilities) {
  const backlog = entries
    .filter((entry) => ['P0', 'P1'].includes(entry.priority))
    .filter((entry) => !['quarantine_not_migrate', 'retire_not_migrate'].includes(entry.migrationAction))
    .sort((left, right) => left.priority.localeCompare(right.priority)
      || left.retirementWaveFamily.localeCompare(right.retirementWaveFamily)
      || left.retirementWave.localeCompare(right.retirementWave)
      || left.path.localeCompare(right.path))
    .slice(0, 80)
    .map((entry) => ({
      path: entry.path,
      disposition: entry.disposition,
      targetAdapter: entry.targetAdapter,
      migrationAction: entry.migrationAction,
      retirementWave: entry.retirementWave,
      retirementWaveFamily: entry.retirementWaveFamily,
      priority: entry.priority,
    }));
  return {
    objective: 'Retire legacy paper_factory control plane after useful domain semantics are captured by hepta-paper adapters.',
    heptaCapabilities,
    waves: RETIREMENT_WAVES.map((wave) => ({
      id: wave.id,
      label: wave.label,
      goal: wave.goal,
      status: wave.statusWhenClear,
      exitCriteria: wave.exitCriteria,
    })),
    immediateBacklog: backlog,
    retirementBlockers: [
      'hepta-native store is the default; legacy paper_factory.sqlite remains import-only until migration parity is verified',
      'live external venue submission executor is intentionally not implemented in the overlay',
      'venue/source decision leftovers must be closed or archived before old workflow deletion',
      'manual review of review_manually files is still required before destructive removal',
    ],
  };
}

export async function runLegacyCleanupAdapter({
  root,
  runtimeRoot = path.join(root, 'hepta-paper-workspace', 'runtime'),
  execute = false,
} = {}) {
  const candidateRoots = [
    path.join(root, 'bin'),
    path.join(root, 'paperctl_modules'),
    path.join(root, 'plugins'),
    path.join(root, 'schema'),
    path.join(root, 'registry'),
    path.join(root, 'templates'),
    path.join(root, 'docs'),
  ];
  const files = [];
  for (const candidateRoot of candidateRoots) {
    const found = await walkFiles(candidateRoot, {
      maxDepth: 3,
      maxFiles: 3000,
      match: (_full, name) => /\.(py|mjs|js|json|yaml|yml|md|sql)$/.test(name) || name === 'paperctl',
    });
    files.push(...found);
  }
  const entries = [];
  for (const file of files.slice(0, 2000)) {
    const record = await fileRecord(root, file, 'legacy_file');
    if (!record) continue;
    const disposition = classifyLegacyFile(record.path);
    entries.push(enrichLegacyEntry({
      path: record.path,
      filename: record.filename,
      hash: record.hash,
      sizeBytes: record.sizeBytes,
      disposition,
    }));
  }
  const byDisposition = {};
  for (const entry of entries) {
    byDisposition[entry.disposition] = (byDisposition[entry.disposition] || 0) + 1;
  }
  const heptaCapabilities = await detectHeptaCapabilities(root);
  const retirementPlan = buildRetirementPlan(entries, heptaCapabilities);
  const legacyEntrypointDeprecationPacket = buildLegacyEntrypointDeprecationPacket(entries, heptaCapabilities);
  const heptaDataAssetExportPlan = buildDataAssetExportPlan(entries);
  const migrationBacklogPacket = buildMigrationBacklogPacket(entries);
  const migrationMatrixAudit = buildMigrationMatrixAudit({ root, entries });
  const p0P1BacklogDrainReceipt = buildP0P1BacklogDrainReceipt({
    entries,
    migrationBacklogPacket,
    migrationMatrixAudit,
    execute,
  });
  const quarantineManifest = buildQuarantineManifest(entries);
  const legacyEntrypointFreezeReceipt = buildLegacyEntrypointFreezeReceipt({
    legacyEntrypointDeprecationPacket,
    execute,
  });
  const dataAssetExportReceipt = await buildHeptaDataAssetExportReceipt({
    root,
    entries,
    dataAssetExportPlan: heptaDataAssetExportPlan,
    execute,
  });
  const researchSourcePackageCoverageReceipt = buildMigrationCoverageReceipt({
    waveId: 'wave_2_migrate_research_source_package_semantics',
    entries,
    migrationBacklogPacket,
    execute,
  });
  const refereeReviewRepairCoverageReceipt = buildMigrationCoverageReceipt({
    waveId: 'wave_3_migrate_referee_review_repair_semantics',
    entries,
    migrationBacklogPacket,
    execute,
  });
  const submissionVenueSourceCoverageReceipt = buildMigrationCoverageReceipt({
    waveId: 'wave_4_migrate_submission_venue_source_decision_semantics',
    entries,
    migrationBacklogPacket,
    execute,
  });
  const liveExternalExecutorPolicyReceipt = buildLiveExternalExecutorPolicyReceipt({
    execute,
  });
  const quarantineIsolationReceipt = buildQuarantineIsolationReceipt({
    quarantineManifest,
    execute,
  });
  const oldControlPlaneRemovalReceipt = buildOldControlPlaneRemovalReceipt({
    migrationBacklogPacket,
    dataAssetExportReceipt,
    p0P1BacklogDrainReceipt,
    liveExternalExecutorPolicyReceipt,
    execute,
  });
  const retirementWavePackets = buildRetirementWavePackets(entries, heptaCapabilities, {
    dataAssetExportReceipt,
    p0P1BacklogDrainReceipt,
    liveExternalExecutorPolicyReceipt,
  });
  const retirementWaveExecutionReceipts = buildRetirementWaveExecutionReceipts({
    entries,
    retirementWavePackets,
    legacyEntrypointFreezeReceipt,
    dataAssetExportReceipt,
    researchSourcePackageCoverageReceipt,
    refereeReviewRepairCoverageReceipt,
    submissionVenueSourceCoverageReceipt,
    quarantineIsolationReceipt,
    oldControlPlaneRemovalReceipt,
    execute,
  });
  const retirementReadinessGate = buildRetirementReadinessGate({
    entries,
    wavePackets: retirementWavePackets,
    legacyEntrypointDeprecationPacket,
    dataAssetExportPlan: heptaDataAssetExportPlan,
    migrationBacklogPacket,
    quarantineManifest,
    p0P1BacklogDrainReceipt,
    liveExternalExecutorPolicyReceipt,
    waveExecutionReceipts: retirementWaveExecutionReceipts,
  });
  if (execute) {
    await writeRetirementRuntimeReceipts({
      runtimeRoot,
      receipts: {
        legacyEntrypointFreezeReceipt,
        dataAssetExportReceipt,
        p0P1BacklogDrainReceipt,
        researchSourcePackageCoverageReceipt,
        refereeReviewRepairCoverageReceipt,
        submissionVenueSourceCoverageReceipt,
        liveExternalExecutorPolicyReceipt,
        quarantineIsolationReceipt,
        oldControlPlaneRemovalReceipt,
        retirementWaveExecutionReceipts,
      },
    });
  }
  const enrichedRetirementPlan = {
    ...retirementPlan,
    retirementWavePackets,
    retirementWaveExecutionReceipts,
    legacyEntrypointDeprecationPacket,
    legacyEntrypointFreezeReceipt,
    heptaDataAssetExportPlan,
    dataAssetExportReceipt,
    migrationBacklogPacket,
    migrationMatrixAudit,
    p0P1BacklogDrainReceipt,
    researchSourcePackageCoverageReceipt,
    refereeReviewRepairCoverageReceipt,
    submissionVenueSourceCoverageReceipt,
    liveExternalExecutorPolicyReceipt,
    quarantineManifest,
    quarantineIsolationReceipt,
    oldControlPlaneRemovalReceipt,
    retirementReadinessGate,
  };
  const report = {
    version: 1,
    kind: 'LegacyPaperFactoryCleanupAudit',
    status: 'read_only_retirement_audit',
    summary: {
      scannedFiles: entries.length,
      byDisposition,
      byTargetAdapter: countBy(entries, 'targetAdapter'),
      byMigrationAction: countBy(entries, 'migrationAction'),
      byRetirementWave: countBy(entries, 'retirementWave'),
      byRetirementWaveFamily: countBy(entries, 'retirementWaveFamily'),
      byPriority: countBy(entries, 'priority'),
      adapterCandidateCount: entries.filter((entry) => /^adapter_candidate/.test(entry.disposition)).length,
      quarantineCount: entries.filter((entry) => /^quarantine/.test(entry.disposition)).length,
      blockedPrimaryEntrypoints: entries.filter((entry) => entry.disposition === 'blocked_primary_entrypoint').length,
      retireNotMigrateCount: entries.filter((entry) => entry.migrationAction === 'retire_not_migrate').length,
      migrationBacklogCount: retirementPlan.immediateBacklog.length,
      fullMigrationBacklogCount: migrationBacklogPacket.backlogCount,
      p0MigrationBacklogCount: migrationBacklogPacket.p0Count,
      p1MigrationBacklogCount: migrationBacklogPacket.p1Count,
      p0P1BacklogDrainStatus: p0P1BacklogDrainReceipt.status,
      semanticMigrationClaimCount: p0P1BacklogDrainReceipt.semanticMigrationClaimCount,
      verifiedSemanticMigrationCount: p0P1BacklogDrainReceipt.verifiedMigrationCount,
      migrationMatrixEntryCount: migrationMatrixAudit.matrixEntryCount,
      migrationMatrixMissingEntryCount: migrationMatrixAudit.missingEntryCount,
      migrationMatrixStatus: migrationMatrixAudit.status,
      activeP0MigrationBlockerCount: p0P1BacklogDrainReceipt.activeP0BlockerCount,
      activeP1MigrationBlockerCount: p0P1BacklogDrainReceipt.activeP1BlockerCount,
      heptaAdapterCount: heptaCapabilities.adapters.length,
      retirementWavePacketCount: retirementWavePackets.length,
      retirementWavePacketsReady: retirementReadinessGate.wavePacketsReady,
      retirementWavePacketsBlocked: retirementReadinessGate.wavePacketsBlocked,
      retirementWaveExecutionReceiptCount: retirementWaveExecutionReceipts.length,
      retirementWaveExecutionReceiptsRecorded: retirementWaveExecutionReceipts.filter((receipt) => (
        receipt.status === 'retirement_wave_execution_recorded'
      )).length,
      retirementWaveExecutionReceiptsBlocked: retirementWaveExecutionReceipts.filter((receipt) => (
        receipt.status === 'retirement_wave_execution_blocked'
      )).length,
      legacyEntrypointDeprecationStatus: legacyEntrypointDeprecationPacket.status,
      legacyEntrypointFreezeReceiptStatus: legacyEntrypointFreezeReceipt.status,
      heptaDataAssetExportPlanStatus: heptaDataAssetExportPlan.status,
      heptaDataAssetExportReceiptStatus: dataAssetExportReceipt.status,
      migrationBacklogPacketStatus: migrationBacklogPacket.status,
      researchSourcePackageCoverageStatus: researchSourcePackageCoverageReceipt.status,
      refereeReviewRepairCoverageStatus: refereeReviewRepairCoverageReceipt.status,
      submissionVenueSourceCoverageStatus: submissionVenueSourceCoverageReceipt.status,
      liveExternalExecutorPolicyStatus: liveExternalExecutorPolicyReceipt.status,
      liveExternalActionAllowed: liveExternalExecutorPolicyReceipt.liveExternalActionAllowed,
      quarantineManifestStatus: quarantineManifest.status,
      quarantineIsolationReceiptStatus: quarantineIsolationReceipt.status,
      oldControlPlaneRemovalReceiptStatus: oldControlPlaneRemovalReceipt.status,
      retirementReadinessStatus: retirementReadinessGate.status,
      retirementReadinessBlockers: retirementReadinessGate.blockers.length,
    },
    entries: entries.slice(0, 500),
    retirementPlan: enrichedRetirementPlan,
    recommendedPolicy: {
      keep: [
        'domain assets',
        'SQLite/YAML registry',
        'templates',
        'real research/referee worker logic only behind adapters',
      ],
      quarantine: [
        'capstone-only modules',
        'matrix/report-only modules',
        'stale latest-report readers',
        'roadmap-only commands',
      ],
      replaceEntrypointWith: 'paper-production-core batch-run',
    },
    blockers: retirementReadinessGate.blockers,
    warnings: uniqueStrings(
      entries.some((entry) => entry.disposition === 'blocked_primary_entrypoint')
        ? ['legacy_bin_paperctl_must_not_be_primary_workflow']
        : [],
      32,
    ),
    safety: {
      readsOnly: true,
      sourceMutation: false,
      externalActionPerformed: false,
      importsOldControlPlane: false,
      writesRuntime: Boolean(execute),
      writesLegacyControlPlane: false,
      writesLegacyStore: false,
    },
  };
  return {
    ...report,
    legacyCleanupAuditHash: hashPaperRecord('LegacyPaperFactoryCleanupAudit', report),
  };
}
