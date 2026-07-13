import path from 'node:path';
import fsp from 'node:fs/promises';
import {
  fileRecord,
  relativePath,
  walkFiles,
} from '../../workflow-kernel/runtime/file-utils.mjs';
import { normalizeText, uniqueStrings } from '../../workflow-kernel/runtime/text-utils.mjs';
import { writeJsonFile } from '../../paper-adapters/artifacts/write-artifact.mjs';
import { hashPaperRecord } from '../../paper-domain/contracts/primitives.mjs';
import { buildMigrationMatrixAudit } from './migration-matrix.mjs';
import { heptaStorePath } from '../../paper-adapters/persistence/store-paths.mjs';
import { resolveWorkspaceLayout } from '../../paper-adapters/runtime/workspace-layout.mjs';

import { RETIREMENT_WAVES, classifyLegacyFile, migrationTargetFor, migrationActionFor, retirementWaveFor, retirementWaveFamilyFor, priorityFor, enrichLegacyEntry } from './classification.mjs';
import { detectHeptaCapabilities, countBy, sampleEntries, hashBound, entriesForWaveFamily, buildLegacyEntrypointDeprecationPacket, buildDataAssetExportPlan, buildMigrationBacklogPacket, migrationContractFamilyFor, verifiedDispositionForEntry, buildP0P1BacklogDrainReceipt, buildQuarantineManifest, liveExternalExecutorPolicyFinalized, dataAssetExportRecorded, p0P1BacklogDrained, waveBlockersFor, buildRetirementWavePackets, buildRetirementReadinessGate, buildRetirementPlan } from './retirement-planning.mjs';
import { buildLegacyEntrypointFreezeReceipt, collectDataStoreRecords, nativeStoreMigrationStatus, buildHeptaDataAssetExportReceipt, buildMigrationCoverageReceipt, buildQuarantineIsolationReceipt, buildLiveExternalExecutorPolicyReceipt, buildOldControlPlaneRemovalReceipt, buildRetirementWaveExecutionReceipts, writeRetirementRuntimeReceipts } from './retirement-execution.mjs';

export async function runRetirementAudit({
  root,
  runtimeRoot = path.join(root, 'hepta-paper-workspace', 'runtime'),
  execute = false,
  store = null,
} = {}) {
  if (execute) throw new Error('historical_retirement_audit_is_read_only');
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
    store,
  });
  const quarantineManifest = buildQuarantineManifest(entries);
  const legacyEntrypointFreezeReceipt = await buildLegacyEntrypointFreezeReceipt({
    root,
    legacyEntrypointDeprecationPacket,
    execute,
  });
  const dataAssetExportReceipt = await buildHeptaDataAssetExportReceipt({
    root,
    entries,
    dataAssetExportPlan: heptaDataAssetExportPlan,
    execute,
    store,
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
    legacyEntrypointFreezeReceipt,
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
      verifiedDispositionCount: p0P1BacklogDrainReceipt.verifiedDispositionCount,
      verifiedBehavioralReplacementCount: p0P1BacklogDrainReceipt.verifiedBehavioralReplacementCount,
      verifiedExplicitRetirementCount: p0P1BacklogDrainReceipt.verifiedExplicitRetirementCount,
      semanticMigrationClaimCount: p0P1BacklogDrainReceipt.semanticMigrationClaimCount,
      verifiedSemanticMigrationCount: p0P1BacklogDrainReceipt.verifiedMigrationCount,
      functionalParityClaimAllowed: p0P1BacklogDrainReceipt.functionalParityClaimAllowed,
      explicitRetirementIsNotBehavioralMigration: true,
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
