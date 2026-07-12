import path from 'node:path';
import fsp from 'node:fs/promises';
import {
  fileRecord,
  relativePath,
  walkFiles,
} from '../../paper-core/src/runtime/file-utils.mjs';
import { normalizeText, uniqueStrings } from '../../paper-core/src/runtime/text-utils.mjs';
import { writeJsonFile } from '../artifacts/write-artifact.mjs';
import { hashPaperRecord } from '../../paper-core/src/paper-contract-primitives.mjs';
import { buildMigrationMatrixAudit } from './migration-matrix.mjs';
import { heptaStorePath } from '../../paper-core/src/hepta-store.mjs';
import { resolveWorkspaceLayout } from '../../paper-core/src/workspace-layout.mjs';

import { RETIREMENT_WAVES, classifyLegacyFile, migrationTargetFor, migrationActionFor, retirementWaveFor, retirementWaveFamilyFor, priorityFor, enrichLegacyEntry } from './classification.mjs';
import { detectHeptaCapabilities, countBy, sampleEntries, hashBound, entriesForWaveFamily, buildLegacyEntrypointDeprecationPacket, buildDataAssetExportPlan, buildMigrationBacklogPacket, migrationContractFamilyFor, verifiedDispositionForEntry, buildP0P1BacklogDrainReceipt, buildQuarantineManifest, liveExternalExecutorPolicyFinalized, dataAssetExportRecorded, p0P1BacklogDrained, waveBlockersFor, buildRetirementWavePackets, buildRetirementReadinessGate, buildRetirementPlan } from './retirement-planning.mjs';

async function buildLegacyEntrypointFreezeReceipt({ root, legacyEntrypointDeprecationPacket, execute }) {
  const blocked = legacyEntrypointDeprecationPacket.status !== 'legacy_entrypoint_deprecation_ready';
  const frozenEntrypoints = [];
  if (execute && !blocked) {
    for (const entry of legacyEntrypointDeprecationPacket.targetEntrypoints || []) {
      const absolutePath = path.resolve(root, entry.path);
      let executableBitsRemoved = false;
      try {
        const stat = await fsp.stat(absolutePath);
        if ((stat.mode & 0o111) !== 0) await fsp.chmod(absolutePath, stat.mode & ~0o111);
        const after = await fsp.stat(absolutePath);
        executableBitsRemoved = (after.mode & 0o111) === 0;
      } catch {
        executableBitsRemoved = false;
      }
      frozenEntrypoints.push({ ...entry, executableBitsRemoved });
    }
  }
  const freezeBlockers = execute && !blocked
    ? frozenEntrypoints.filter((entry) => !entry.executableBitsRemoved).map((entry) => `legacy_entrypoint_not_frozen:${entry.path}`)
    : [];
  const record = {
    kind: 'LegacyEntrypointFreezeReceipt',
    status: blocked || freezeBlockers.length
      ? 'legacy_entrypoint_freeze_blocked'
      : execute
        ? 'legacy_entrypoint_freeze_recorded'
        : 'legacy_entrypoint_freeze_planned',
    consumedPacketHash: legacyEntrypointDeprecationPacket.legacyEntrypointDeprecationPacketHash,
    replacementCommand: legacyEntrypointDeprecationPacket.replacementCommand,
    frozenLegacyEntrypoints: execute ? frozenEntrypoints : legacyEntrypointDeprecationPacket.targetEntrypoints,
    blockers: uniqueStrings([
      ...(blocked ? legacyEntrypointDeprecationPacket.blockers : []),
      ...freezeBlockers,
    ], 16),
    policy: {
      normalProductionEntrypoint: 'paper-production-core batch-run',
      oldEntrypointsAllowedOnlyForArchiveInspection: true,
      oldEntrypointsMayOwnProductionWorkflow: false,
    },
    safety: {
      writesRuntime: Boolean(execute && !blocked),
      writesLegacyEntrypoints: Boolean(execute && !blocked),
      contentMutation: false,
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

function nativeStoreMigrationStatus(root, injectedStore = null) {
  const dbPath = heptaStorePath(root);
  if (!injectedStore) return { ready: false, path: dbPath, blocker: 'native_store_not_injected' };
  const store = injectedStore;
  const role = store.query("select value from store_metadata where key='store_role' and value='hepta-paper-native';");
  const quickCheck = store.query('pragma quick_check;');
  return {
    ready: role.ok && role.rows.some((row) => row.value === 'hepta-paper-native')
      && quickCheck.ok && quickCheck.rows?.[0]?.quick_check === 'ok',
    path: dbPath,
  };
}

async function buildHeptaDataAssetExportReceipt({
  root,
  entries,
  dataAssetExportPlan,
  execute,
  store = null,
}) {
  const dataStoreRecords = await collectDataStoreRecords(root);
  const nativeStore = nativeStoreMigrationStatus(root, store);
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
  const layout = resolveWorkspaceLayout();
  const record = {
    kind: 'PaperFactoryQuarantineIsolationReceipt',
    waveId: 'wave_5_quarantine_reports_matrices_capstones_llm_manual_chains',
    status: execute ? 'quarantine_isolation_receipt_recorded' : 'quarantine_isolation_receipt_planned',
    consumedManifestHash: quarantineManifest.quarantineManifestHash,
    quarantineCount: quarantineManifest.quarantineCount,
    workspacePhysicallyDecoupled: layout.physicallyDecoupled,
    legacyCatalogRuntimeScanAllowed: layout.legacyCatalogRuntimeScanAllowed,
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
  legacyEntrypointFreezeReceipt = null,
  execute,
}) {
  const layout = resolveWorkspaceLayout();
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
    ...(legacyEntrypointFreezeReceipt?.status === 'legacy_entrypoint_freeze_recorded'
      ? []
      : ['legacy_entrypoint_freeze_not_recorded']),
    ...(layout.physicallyDecoupled ? [] : ['hepta_workspace_not_physically_decoupled']),
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
    legacyEntrypointFreezeStatus: legacyEntrypointFreezeReceipt?.status || 'missing',
    workspacePhysicallyDecoupled: layout.physicallyDecoupled,
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
        writesLegacyControlPlane: Boolean(consumedReceipt?.safety?.writesLegacyEntrypoints),
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


export { buildLegacyEntrypointFreezeReceipt, collectDataStoreRecords, nativeStoreMigrationStatus, buildHeptaDataAssetExportReceipt, buildMigrationCoverageReceipt, buildQuarantineIsolationReceipt, buildLiveExternalExecutorPolicyReceipt, buildOldControlPlaneRemovalReceipt, buildRetirementWaveExecutionReceipts, writeRetirementRuntimeReceipts };
