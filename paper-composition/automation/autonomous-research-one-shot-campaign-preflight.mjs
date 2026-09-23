import fs from 'node:fs';
import path from 'node:path';

import {
  AUTONOMOUS_RESEARCH_ONE_SHOT_PROVIDER_CONFIGURATION_HASH,
  AUTONOMOUS_RESEARCH_ONE_SHOT_TARGET_CAMPAIGN_ID,
  AUTONOMOUS_RESEARCH_ONE_SHOT_TARGET_DATASET_MOUNTS_HASH,
  autonomousResearchOneShotCampaignCodeProvenanceHash,
  autonomousResearchOneShotCampaignSourceExecutionSnapshotHash,
  autonomousResearchOneShotProtectedCampaignFingerprintHash,
  verifyAutonomousResearchOneShotCodeProvenance,
  verifyAutonomousResearchOneShotProtectedCampaignDefinition,
  verifyAutonomousResearchOneShotSourceExecutionSnapshot,
} from '../../paper-domain/automation/autonomous-research-one-shot-campaign-attempt.mjs';
import {
  loadOperatorDatasetAuthorityTrustStoreSync,
  readOperatorDatasetHarness,
} from '../../paper-adapters/automation/operator-dataset-harness-reader.mjs';
import { currentCodeProvenance } from '../../paper-adapters/runtime/code-provenance.mjs';
import {
  inspectWorkspaceExecutionSnapshot,
  sourceTreeExcludedNames,
} from '../../paper-adapters/runtime/execution-snapshot.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  createReadOnlyPaperStore,
  createSqliteCampaignStore,
  heptaStorePath,
} from '../bootstrap/operator-persistence-composition.mjs';
import {
  resolveAutonomousResearchProviderConfiguration,
} from './autonomous-research-qualification-composition.mjs';
import {
  canonicalAutonomousResearchOneShotDatasetMounts,
} from './autonomous-research-one-shot-campaign-execution-fence.mjs';
import {
  createCampaignOneShotAttemptJournalRepository,
} from '../../paper-adapters/automation/campaign-one-shot-attempt-journal-repository.mjs';
import {
  fixedAutonomousResearchOneShotProviderEnvironment,
} from './autonomous-research-one-shot-provider-environment.mjs';
import {
  autonomousResearchOneShotCampaignPreflightBlocker,
} from './autonomous-research-one-shot-campaign-attempt-failure.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
export const AUTONOMOUS_RESEARCH_ONE_SHOT_PREFLIGHT_ACTIONS =
  Object.freeze(['plan', 'preflight']);
const PREFLIGHT_ACTIONS = new Set(AUTONOMOUS_RESEARCH_ONE_SHOT_PREFLIGHT_ACTIONS);

const READ_ONLY = fs.constants.O_RDONLY;
const DIRECTORY = fs.constants.O_DIRECTORY || 0;
const NO_FOLLOW = fs.constants.O_NOFOLLOW || 0;

function lstatIfPresent(candidate) {
  try { return fs.lstatSync(candidate, { bigint: true }); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function ensureNoSqliteSidecars(dbPath) {
  for (const suffix of ['-wal', '-shm', '-journal']) {
    if (lstatIfPresent(`${dbPath}${suffix}`) !== null) {
      throw new Error('autonomous_research_one_shot_native_store_sidecar_present');
    }
  }
}

function directoryIdentity(stat) {
  if (!stat?.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('autonomous_research_one_shot_native_store_runtime_root_unsafe');
  }
  return Object.freeze({
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    mode: stat.mode.toString(),
    uid: stat.uid.toString(),
    gid: stat.gid.toString(),
  });
}

function immutableSqliteIdentity(stat) {
  if (!stat?.isFile() || stat.isSymbolicLink() || Number(stat.nlink) !== 1) {
    throw new Error('autonomous_research_one_shot_native_store_path_unsafe');
  }
  return Object.freeze({
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    mode: stat.mode.toString(),
    nlink: stat.nlink.toString(),
    uid: stat.uid.toString(),
    gid: stat.gid.toString(),
    size: stat.size.toString(),
    mtimeNs: stat.mtimeNs.toString(),
    ctimeNs: stat.ctimeNs.toString(),
  });
}

function sameIdentity(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function descriptorAccessPath(descriptor, expectedIdentity, { directory = false } = {}) {
  for (const prefix of ['/proc/self/fd', '/dev/fd']) {
    const candidate = `${prefix}/${descriptor}`;
    let observedDescriptor = null;
    try {
      observedDescriptor = fs.openSync(candidate, READ_ONLY | (directory ? DIRECTORY : 0));
      const observed = directory
        ? directoryIdentity(fs.fstatSync(observedDescriptor, { bigint: true }))
        : immutableSqliteIdentity(fs.fstatSync(observedDescriptor, { bigint: true }));
      if (sameIdentity(observed, expectedIdentity)) return candidate;
    } catch { /* try the next descriptor filesystem */ }
    finally {
      if (observedDescriptor !== null) fs.closeSync(observedDescriptor);
    }
  }
  throw new Error('autonomous_research_one_shot_native_store_descriptor_unavailable');
}

export function defaultAutonomousResearchOneShotNativeStoreSnapshotGuard({
  root,
  runtimeRoot,
}) {
  const canonicalRuntimeRoot = path.resolve(runtimeRoot);
  const sourceDbPath = heptaStorePath(root, canonicalRuntimeRoot);
  let runtimeDescriptor = null;
  let databaseDescriptor = null;
  try {
    const runtimeStat = fs.lstatSync(canonicalRuntimeRoot, { bigint: true });
    const runtimeIdentity = directoryIdentity(runtimeStat);
    if (fs.realpathSync(canonicalRuntimeRoot) !== canonicalRuntimeRoot) {
      throw new Error('autonomous_research_one_shot_native_store_runtime_root_unsafe');
    }
    runtimeDescriptor = fs.openSync(
      canonicalRuntimeRoot,
      READ_ONLY | DIRECTORY | NO_FOLLOW,
    );
    if (!sameIdentity(
      directoryIdentity(fs.fstatSync(runtimeDescriptor, { bigint: true })),
      runtimeIdentity,
    )) {
      throw new Error('autonomous_research_one_shot_native_store_runtime_root_changed');
    }
    const pinnedRuntimeRoot = descriptorAccessPath(
      runtimeDescriptor,
      runtimeIdentity,
      { directory: true },
    );
    ensureNoSqliteSidecars(sourceDbPath);
    const sourceIdentity = immutableSqliteIdentity(
      fs.lstatSync(sourceDbPath, { bigint: true }),
    );
    databaseDescriptor = fs.openSync(
      path.join(pinnedRuntimeRoot, path.basename(sourceDbPath)),
      READ_ONLY | NO_FOLLOW,
    );
    const databaseIdentity = immutableSqliteIdentity(
      fs.fstatSync(databaseDescriptor, { bigint: true }),
    );
    if (!sameIdentity(sourceIdentity, databaseIdentity)) {
      throw new Error('autonomous_research_one_shot_native_store_changed');
    }
    const pinnedDbPath = descriptorAccessPath(databaseDescriptor, databaseIdentity);
    let closed = false;
    const verifyUnchanged = () => {
      if (closed) {
        throw new Error('autonomous_research_one_shot_native_store_guard_closed');
      }
      const observedRuntimeIdentity = directoryIdentity(
        fs.lstatSync(canonicalRuntimeRoot, { bigint: true }),
      );
      const observedDatabaseIdentity = immutableSqliteIdentity(
        fs.lstatSync(sourceDbPath, { bigint: true }),
      );
      if (fs.realpathSync(canonicalRuntimeRoot) !== canonicalRuntimeRoot
        || !sameIdentity(runtimeIdentity, observedRuntimeIdentity)
        || !sameIdentity(
          runtimeIdentity,
          directoryIdentity(fs.fstatSync(runtimeDescriptor, { bigint: true })),
        )
        || !sameIdentity(databaseIdentity, observedDatabaseIdentity)
        || !sameIdentity(
          databaseIdentity,
          immutableSqliteIdentity(fs.fstatSync(databaseDescriptor, { bigint: true })),
        )) {
        throw new Error('autonomous_research_one_shot_native_store_changed');
      }
      ensureNoSqliteSidecars(sourceDbPath);
    };
    verifyUnchanged();
    return Object.freeze({
      dbPath: pinnedDbPath,
      sourceDbPath,
      verifyUnchanged,
      close() {
        if (closed) return;
        closed = true;
        fs.closeSync(databaseDescriptor);
        fs.closeSync(runtimeDescriptor);
        databaseDescriptor = null;
        runtimeDescriptor = null;
      },
    });
  } catch (error) {
    if (databaseDescriptor !== null) fs.closeSync(databaseDescriptor);
    if (runtimeDescriptor !== null) fs.closeSync(runtimeDescriptor);
    throw error;
  }
}

export function defaultAutonomousResearchOneShotDatasetAuthorityInspector({
  datasetMounts,
  runtimeRoot,
  now,
}) {
  if (!Array.isArray(datasetMounts) || datasetMounts.length !== 1) return null;
  const authorityTrustStore = loadOperatorDatasetAuthorityTrustStoreSync({ runtimeRoot });
  return readOperatorDatasetHarness(datasetMounts[0], {
    authorityTrustStore,
    runtimeRoot,
    now,
  }).receipt;
}

function safeMessage(error) {
  try { return typeof error?.message === 'string' ? error.message : ''; }
  catch { return ''; }
}

export function autonomousResearchOneShotDatasetInspectionBlockerCode(error) {
  const message = safeMessage(error);
  if (/source/u.test(message)) {
    return 'autonomous_research_one_shot_dataset_source_unreadable';
  }
  if (/manifest/u.test(message)) {
    return 'autonomous_research_one_shot_dataset_manifest_invalid';
  }
  if (/envelope/u.test(message)) {
    return 'autonomous_research_one_shot_dataset_v4_envelope_invalid';
  }
  if (/(?:authority|signature|trust|time_window)/u.test(message)) {
    return 'autonomous_research_one_shot_dataset_trust_invalid';
  }
  return 'autonomous_research_one_shot_dataset_contract_invalid';
}

export function autonomousResearchOneShotDatasetReceiptBlockerCodes(
  receipt,
  datasetMounts,
) {
  const codes = new Set();
  if (!receipt || receipt.status !== 'operator_dataset_harness_authority_verified') {
    codes.add('autonomous_research_one_shot_dataset_contract_invalid');
  }
  if (receipt?.authority?.version !== 4
    || receipt?.authority?.kind !== 'LocalGoldenDatasetHarnessAuthority') {
    codes.add('autonomous_research_one_shot_dataset_v4_envelope_invalid');
  }
  if (receipt?.authorityVerification?.cryptographicSignaturesVerified !== true
    || receipt?.authorityVerification?.timeWindowValid !== true) {
    codes.add('autonomous_research_one_shot_dataset_trust_invalid');
  }
  if (receipt?.datasetManifestHash !== datasetMounts[0]?.manifestHash) {
    codes.add('autonomous_research_one_shot_dataset_manifest_invalid');
  }
  for (const blocker of Array.isArray(receipt?.blockers) ? receipt.blockers : []) {
    if (typeof blocker !== 'string') continue;
    if (/(?:source_unreadable|source_required|worker_exposure_manifest_unreadable)/u
      .test(blocker)) {
      codes.add('autonomous_research_one_shot_dataset_source_unreadable');
    } else if (/(?:manifest|split_manifest)/u.test(blocker)) {
      codes.add('autonomous_research_one_shot_dataset_manifest_invalid');
    } else if (/(?:envelope|analysis_protocol_required)/u.test(blocker)) {
      codes.add('autonomous_research_one_shot_dataset_v4_envelope_invalid');
    } else if (/(?:authority|signature|trust|time_window|runtime_scope)/u.test(blocker)) {
      codes.add('autonomous_research_one_shot_dataset_trust_invalid');
    } else {
      codes.add('autonomous_research_one_shot_dataset_contract_invalid');
    }
  }
  if (datasetMounts[0]?.readOnly !== true) {
    codes.add('autonomous_research_one_shot_dataset_contract_invalid');
  }
  return [...codes];
}

function typedBlockers(codes) {
  return Object.freeze([...new Set(codes)].sort().map(
    (code) => autonomousResearchOneShotCampaignPreflightBlocker(code),
  ));
}

function hasBlockerPrefix(blockers, prefix) {
  return blockers.some((blocker) => blocker.errorCode.startsWith(prefix));
}

function buildReport({
  action,
  blockerCodes,
  datasetMountsHash,
  datasetAuthorityReceiptHash,
  providerConfigurationHash,
  providerRuntimeBindingHash,
  protectedCampaignFingerprintHash,
  targetCampaignAbsent,
  targetJournalAttemptAbsent,
  codeProvenanceHash,
  sourceExecutionSnapshotHash,
  executionBindingHash,
  nativeStoreInspected,
  nativeStoreSnapshotUnchanged,
  journalReadOnlyInspected,
}) {
  const blockers = typedBlockers(blockerCodes);
  const payload = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchOneShotCampaignPreflightReport',
    status: blockers.length
      ? 'autonomous_research_one_shot_campaign_preflight_blocked'
      : 'autonomous_research_one_shot_campaign_preflight_passed',
    action,
    campaignId: AUTONOMOUS_RESEARCH_ONE_SHOT_TARGET_CAMPAIGN_ID,
    checks: Object.freeze({
      dataset: Object.freeze({
        status: hasBlockerPrefix(blockers, 'autonomous_research_one_shot_dataset_')
          ? 'blocked' : 'passed',
        datasetMountsHash,
        authorityReceiptHash: datasetAuthorityReceiptHash,
      }),
      provider: Object.freeze({
        status: hasBlockerPrefix(blockers, 'autonomous_research_one_shot_provider_')
          ? 'blocked' : 'passed',
        providerConfigurationHash,
        providerRuntimeBindingHash,
      }),
      reviewedTarget: Object.freeze({
        status: blockers.some((blocker) => blocker.failingStage === 'reviewed_target')
          ? 'blocked' : 'passed',
        protectedCampaignFingerprintHash,
        targetCampaignAbsent,
        targetJournalAttemptAbsent,
      }),
      reviewerIndependence: Object.freeze({
        status: 'not_proven',
        independentPrincipalVerified: false,
        independentServiceVerified: false,
        independentOrganizationVerified: false,
        independentCredentialRootVerified: false,
      }),
      source: Object.freeze({
        status: blockers.some((blocker) => blocker.failureClass === 'source_not_clean')
          ? 'blocked' : 'passed',
        codeProvenanceHash,
        sourceExecutionSnapshotHash,
      }),
      executionBinding: Object.freeze({
        status: executionBindingHash ? 'passed' : 'not_proven',
        executionBindingHash,
      }),
    }),
    blockers,
    readyForReservation: blockers.length === 0,
    executionAuthorized: false,
    campaignPreparationVerified: false,
    providerCanaryVerified: false,
    launchReadinessVerified: false,
    sideEffects: Object.freeze({
      reservationCreated: false,
      journalWriteRepositoryOpened: false,
      journalReadOnlyInspectionPerformed: journalReadOnlyInspected,
      nativeDatabaseWritePerformed: false,
      nativeStoreReadOnlyInspectionPerformed: nativeStoreInspected,
      nativeStoreImmutableSnapshotVerified: nativeStoreSnapshotUnchanged,
      nativeStoreFilesystemWritePerformed: false,
      providerInvocationPerformed: false,
      campaignLaunchPerformed: false,
      networkAccessPerformed: false,
    }),
  });
  return Object.freeze({
    ...payload,
    autonomousResearchOneShotCampaignPreflightHash: hashRecord(
      'AutonomousResearchOneShotCampaignPreflightReport', payload,
    ),
  });
}

export function inspectAutonomousResearchOneShotCampaignPreflight({
  action = 'plan',
  workspaceRoot,
  root,
  runtimeRoot,
  controlRoot,
  datasetMounts,
  environment = process.env,
  clock = { now: () => new Date() },
  codeProvenanceInspector = currentCodeProvenance,
  sourceSnapshotInspector = inspectWorkspaceExecutionSnapshot,
  providerConfigurationResolver = resolveAutonomousResearchProviderConfiguration,
  datasetAuthorityInspector =
    defaultAutonomousResearchOneShotDatasetAuthorityInspector,
  readOnlyStoreFactory = createReadOnlyPaperStore,
  campaignStoreFactory = createSqliteCampaignStore,
  nativeStoreSnapshotGuardFactory =
    defaultAutonomousResearchOneShotNativeStoreSnapshotGuard,
  journalRepositoryFactory = createCampaignOneShotAttemptJournalRepository,
  inspectProtectedCampaign,
} = {}) {
  if (!PREFLIGHT_ACTIONS.has(action) || !workspaceRoot || !root || !runtimeRoot
    || !controlRoot
    || !Array.isArray(datasetMounts) || typeof clock?.now !== 'function'
    || typeof datasetAuthorityInspector !== 'function'
    || typeof journalRepositoryFactory !== 'function'
    || typeof nativeStoreSnapshotGuardFactory !== 'function'
    || typeof inspectProtectedCampaign !== 'function') {
    throw new Error('autonomous_research_one_shot_campaign_preflight_invalid');
  }
  const blockerCodes = [];
  let boundDatasetMounts = null;
  let datasetMountsHash = null;
  let datasetAuthorityReceiptHash = null;
  let fixedEnvironment = null;
  let providerConfiguration = null;
  let providerConfigurationHash = null;
  let providerRuntimeBindingHash = null;
  let protectedCampaignDefinition = null;
  let protectedCampaignFingerprintHash = null;
  let targetCampaignAbsent = null;
  let targetJournalAttemptAbsent = null;
  let codeProvenance = null;
  let codeProvenanceHash = null;
  let sourceExecutionSnapshot = null;
  let sourceExecutionSnapshotHash = null;
  let executionBindingHash = null;
  let nativeStoreInspected = false;
  let nativeStoreSnapshotUnchanged = false;
  let journalReadOnlyInspected = false;

  try {
    boundDatasetMounts = canonicalAutonomousResearchOneShotDatasetMounts(datasetMounts);
    datasetMountsHash = hashRecord(
      'AutonomousResearchOneShotCampaignDatasetMounts', boundDatasetMounts,
    );
    if (datasetMountsHash !== AUTONOMOUS_RESEARCH_ONE_SHOT_TARGET_DATASET_MOUNTS_HASH) {
      blockerCodes.push('autonomous_research_one_shot_dataset_binding_mismatch');
    }
  } catch {
    blockerCodes.push('autonomous_research_one_shot_dataset_mounts_invalid');
  }
  if (boundDatasetMounts) {
    if (boundDatasetMounts.length !== 1) {
      blockerCodes.push('autonomous_research_one_shot_dataset_mounts_invalid');
    } else {
      try {
        const receipt = datasetAuthorityInspector({
          datasetMounts: boundDatasetMounts,
          runtimeRoot,
          now: clock.now(),
        });
        if (typeof receipt?.operatorDatasetHarnessAuthorityReceiptHash === 'string'
          && SHA256.test(receipt.operatorDatasetHarnessAuthorityReceiptHash)) {
          datasetAuthorityReceiptHash = receipt.operatorDatasetHarnessAuthorityReceiptHash;
        }
        blockerCodes.push(...autonomousResearchOneShotDatasetReceiptBlockerCodes(
          receipt,
          boundDatasetMounts,
        ));
      } catch (error) {
        blockerCodes.push(autonomousResearchOneShotDatasetInspectionBlockerCode(error));
      }
    }
  }

  try {
    fixedEnvironment = fixedAutonomousResearchOneShotProviderEnvironment({
      runtimeRoot, environment,
    });
    providerConfiguration = providerConfigurationResolver({
      environment: fixedEnvironment,
    });
    if (providerConfiguration?.autonomousResearchProviderConfigurationHash
      !== AUTONOMOUS_RESEARCH_ONE_SHOT_PROVIDER_CONFIGURATION_HASH) {
      blockerCodes.push(
        'autonomous_research_one_shot_provider_configuration_mismatch',
      );
    } else {
      providerConfigurationHash = AUTONOMOUS_RESEARCH_ONE_SHOT_PROVIDER_CONFIGURATION_HASH;
    }
  } catch {
    blockerCodes.push('autonomous_research_one_shot_provider_configuration_invalid');
  }
  if (providerConfigurationHash && fixedEnvironment) {
    blockerCodes.push('autonomous_research_one_shot_provider_runtime_not_proven');
  }
  blockerCodes.push('autonomous_research_one_shot_reviewer_independence_not_proven');

  let store = null;
  let nativeStoreSnapshotGuard = null;
  try {
    nativeStoreSnapshotGuard = nativeStoreSnapshotGuardFactory({ root, runtimeRoot });
    nativeStoreSnapshotGuard.verifyUnchanged();
    store = readOnlyStoreFactory({
      root,
      runtimeRoot,
      dbPath: nativeStoreSnapshotGuard.dbPath,
      immutable: true,
    });
    if (store?.readOnly !== true) {
      throw new Error('autonomous_research_one_shot_native_store_not_read_only');
    }
    nativeStoreInspected = true;
    const campaignStore = campaignStoreFactory({ store, clock });
    protectedCampaignDefinition = inspectProtectedCampaign({ store, campaignStore });
    const targetCampaign = campaignStore.getCampaign(
      AUTONOMOUS_RESEARCH_ONE_SHOT_TARGET_CAMPAIGN_ID,
    );
    targetCampaignAbsent = !targetCampaign;
    if (targetCampaign) {
      blockerCodes.push('autonomous_research_one_shot_target_campaign_already_exists');
    }
  } catch (error) {
    if (safeMessage(error)
      === 'autonomous_research_one_shot_protected_campaign_missing') {
      blockerCodes.push('autonomous_research_one_shot_protected_campaign_missing');
    } else {
      blockerCodes.push('autonomous_research_one_shot_native_store_not_ready');
    }
  } finally {
    try {
      store?.close();
    } catch {
      blockerCodes.push('autonomous_research_one_shot_native_store_not_ready');
    }
    try {
      nativeStoreSnapshotGuard?.verifyUnchanged();
      if (nativeStoreSnapshotGuard) nativeStoreSnapshotUnchanged = true;
    } catch {
      blockerCodes.push('autonomous_research_one_shot_native_store_not_ready');
    } finally {
      try { nativeStoreSnapshotGuard?.close?.(); }
      catch { blockerCodes.push('autonomous_research_one_shot_native_store_not_ready'); }
    }
  }
  if (protectedCampaignDefinition) {
    if (verifyAutonomousResearchOneShotProtectedCampaignDefinition(
      protectedCampaignDefinition,
    )) {
      protectedCampaignFingerprintHash =
        autonomousResearchOneShotProtectedCampaignFingerprintHash(
          protectedCampaignDefinition,
        );
    } else {
      blockerCodes.push(
        'autonomous_research_one_shot_protected_campaign_fingerprint_invalid',
      );
    }
  }

  try {
    const repository = journalRepositoryFactory({
      controlRoot,
      runtimeRoot,
      create: false,
      clock,
    });
    try {
      journalReadOnlyInspected = true;
      const existing = repository.inspectHistoricalAttempt({
        campaignId: AUTONOMOUS_RESEARCH_ONE_SHOT_TARGET_CAMPAIGN_ID,
      });
      targetJournalAttemptAbsent = existing === null;
      if (existing) {
        blockerCodes.push(
          'autonomous_research_one_shot_target_campaign_attempt_already_recorded',
        );
      }
    } finally {
      repository.close();
    }
  } catch {
    blockerCodes.push('autonomous_research_one_shot_attempt_journal_not_ready');
  }

  try {
    codeProvenance = codeProvenanceInspector({
      workspaceRoot,
      allowReleaseCommitEnvironment: false,
    });
    if (codeProvenance?.treeDirty !== false) {
      blockerCodes.push(
        'autonomous_research_one_shot_source_snapshot_blocked:dirty_git_worktree',
      );
    } else if (!verifyAutonomousResearchOneShotCodeProvenance(codeProvenance)) {
      blockerCodes.push('autonomous_research_one_shot_source_provenance_invalid');
    } else {
      codeProvenanceHash =
        autonomousResearchOneShotCampaignCodeProvenanceHash(codeProvenance);
      const snapshot = sourceSnapshotInspector(workspaceRoot, {
        excludeNames: sourceTreeExcludedNames(workspaceRoot),
      });
      if (snapshot?.blockers?.length) {
        blockerCodes.push('autonomous_research_one_shot_source_snapshot_invalid');
      } else {
        sourceExecutionSnapshot = Object.freeze({
          version: 1,
          merkleHash: snapshot?.merkleHash,
          manifestHash: snapshot?.manifestHash,
        });
        if (verifyAutonomousResearchOneShotSourceExecutionSnapshot(
          sourceExecutionSnapshot,
        )) {
          sourceExecutionSnapshotHash =
            autonomousResearchOneShotCampaignSourceExecutionSnapshotHash(
              sourceExecutionSnapshot,
            );
        } else {
          sourceExecutionSnapshot = null;
          blockerCodes.push('autonomous_research_one_shot_source_snapshot_invalid');
        }
      }
    }
  } catch {
    blockerCodes.push('autonomous_research_one_shot_source_provenance_invalid');
  }

  return buildReport({
    action,
    blockerCodes,
    datasetMountsHash,
    datasetAuthorityReceiptHash,
    providerConfigurationHash,
    providerRuntimeBindingHash,
    protectedCampaignFingerprintHash,
    targetCampaignAbsent,
    targetJournalAttemptAbsent,
    codeProvenanceHash,
    sourceExecutionSnapshotHash,
    executionBindingHash,
    nativeStoreInspected,
    nativeStoreSnapshotUnchanged,
    journalReadOnlyInspected,
  });
}
