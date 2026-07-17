// Historical retirement planning retained for immutable-reference verification only.
import path from 'node:path';
import {
  walkFiles,
} from '../../workflow-kernel/runtime/file-utils.mjs';
import { uniqueStrings } from '../../workflow-kernel/runtime/text-utils.mjs';
import { hashPaperRecord } from '../../paper-domain/contracts/primitives.mjs';
import { resolveWorkspaceLayout } from '../../paper-adapters/runtime/workspace-layout.mjs';

import { RETIREMENT_WAVES } from './classification.mjs';

async function detectHeptaCapabilities(_legacyRoot) {
  const adaptersRoot = path.join(resolveWorkspaceLayout().workspaceRoot, 'paper-adapters');
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
      retirementAudit: true,
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

function verifiedDispositionForEntry(entry, matrixRow) {
  const verificationClass = matrixRow.verificationClass;
  const behavioralReplacement = verificationClass === 'behavioral_replacement';
  const record = {
    kind: 'PaperFactoryVerifiedDisposition',
    status: behavioralReplacement
      ? 'behavioral_replacement_verified'
      : 'explicit_retirement_verified',
    verificationClass,
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
    acceptanceCriteria: behavioralReplacement
      ? [
        'do not import old paper_factory control-plane modules',
        'represent reusable semantics as hepta adapter contracts, receipts, or deterministic local logic',
        'preserve source legacy file hash as audit evidence',
        'keep external actions behind controlled executor receipts',
      ]
      : [
        'preserve source legacy file hash and public-symbol inventory as retirement evidence',
        'prove the legacy surface is outside the hepta production import/execution boundary',
        'do not inherit legacy mutation, subprocess, model, academic-evidence, or external-action authority',
        'explicit retirement is not behavioral migration or functional parity',
      ],
  };
  return hashBound('PaperFactoryVerifiedDisposition', record, 'verifiedDispositionHash');
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
  const verifiedDispositions = migrationMatrixAudit.rows
    .filter((row) => row.verified && entryByPath.has(row.sourcePath))
    .map((row) => verifiedDispositionForEntry(entryByPath.get(row.sourcePath), row));
  const behavioralReplacements = verifiedDispositions.filter((row) => (
    row.verificationClass === 'behavioral_replacement'
  ));
  const explicitRetirements = verifiedDispositions.filter((row) => (
    row.verificationClass === 'explicit_retirement'
  ));
  const blockers = migrationMatrixAudit.ok ? [] : migrationMatrixAudit.blockers;
  const missingP0 = migrationMatrixAudit.missingByPriority.P0;
  const missingP1 = migrationMatrixAudit.missingByPriority.P1;
  const record = {
    kind: 'PaperFactoryP0P1BacklogDrainReceipt',
    status: blockers.length
      ? 'p0_p1_disposition_matrix_blocked'
      : execute
        ? 'p0_p1_dispositions_verified_and_recorded'
        : 'p0_p1_dispositions_verified_by_matrix',
    consumedBacklogPacketHash: migrationBacklogPacket.migrationBacklogPacketHash,
    rawBacklogCount: migrationEntries.length,
    p0RawCount: migrationEntries.filter((entry) => entry.priority === 'P0').length,
    p1RawCount: migrationEntries.filter((entry) => entry.priority === 'P1').length,
    verifiedDispositionCount: verifiedDispositions.length,
    verifiedBehavioralReplacementCount: behavioralReplacements.length,
    verifiedExplicitRetirementCount: explicitRetirements.length,
    semanticMigrationClaimCount: behavioralReplacements.length,
    verifiedMigrationCount: behavioralReplacements.length,
    functionalParityClaimAllowed: explicitRetirements.length === 0,
    explicitRetirementIsNotBehavioralMigration: true,
    missingMigrationMatrixEntryCount: migrationMatrixAudit.missingEntryCount,
    invalidMigrationMatrixEntryCount: migrationMatrixAudit.invalidEntryCount,
    activeP0BlockerCount: missingP0,
    activeP1BlockerCount: missingP1,
    byContractFamily: countBy(behavioralReplacements, 'contractFamily'),
    byVerificationClass: countBy(verifiedDispositions, 'verificationClass'),
    byTargetAdapter: countBy(migrationEntries, 'targetAdapter'),
    byMigrationAction: countBy(migrationEntries, 'migrationAction'),
    claims: behavioralReplacements,
    verifiedDispositions,
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
    'p0_p1_dispositions_verified_by_matrix',
    'p0_p1_dispositions_verified_and_recorded',
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
  const verifiedBehavioralReplacementCount = Number(
    p0P1BacklogDrainReceipt?.verifiedBehavioralReplacementCount || 0,
  );
  const verifiedExplicitRetirementCount = Number(
    p0P1BacklogDrainReceipt?.verifiedExplicitRetirementCount || 0,
  );
  const record = {
    kind: 'PaperFactoryRetirementReadinessGate',
    status: uniqueBlockers.length
      ? 'paper_factory_retirement_blocked'
      : 'paper_factory_control_plane_archive_ready',
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
    verifiedBehavioralReplacementCount,
    verifiedExplicitRetirementCount,
    functionalParityClaimAllowed: verifiedExplicitRetirementCount === 0,
    retirementReadinessDoesNotMeanFunctionalParity: true,
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


export { detectHeptaCapabilities, countBy, sampleEntries, hashBound, entriesForWaveFamily, buildLegacyEntrypointDeprecationPacket, buildDataAssetExportPlan, buildMigrationBacklogPacket, migrationContractFamilyFor, verifiedDispositionForEntry, buildP0P1BacklogDrainReceipt, buildQuarantineManifest, liveExternalExecutorPolicyFinalized, dataAssetExportRecorded, p0P1BacklogDrained, waveBlockersFor, buildRetirementWavePackets, buildRetirementReadinessGate, buildRetirementPlan };
