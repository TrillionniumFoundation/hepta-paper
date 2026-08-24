import fs from 'node:fs';
import path from 'node:path';

import { verifyFormalOperationalReceipt } from '../bin/dynamic-formal-kernel-operational.mjs';
import { currentCodeProvenance } from '../../paper-adapters/runtime/code-provenance.mjs';
import {
  inspectPersonalLocalDatabase,
} from '../../paper-adapters/persistence/personal-local-database-readiness.mjs';
import {
  inspectSourceSupplyChainSecurity,
} from './source-supply-chain-security.mjs';
import {
  evaluatePersonalSelfHostedProductionReadiness,
} from '../../paper-domain/operations/personal-self-hosted-production-profile-contract.mjs';
import {
  verifyPersonalGpuOperationalReceipt,
} from '../../paper-domain/research/personal-gpu-operational-gate-contract.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const EMPTY_INDEX_HASH = 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const MAX_RECEIPT_BYTES = 32 * 1024 * 1024;

function safeRegularFile(candidate, { maximumBytes = MAX_RECEIPT_BYTES } = {}) {
  if (!candidate) return { path: null, present: false, safe: false, value: null };
  const selected = path.resolve(String(candidate));
  try {
    const stat = fs.lstatSync(selected);
    const safe = stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1
      && stat.size > 0 && stat.size <= maximumBytes
      && fs.realpathSync(selected) === selected
      && (stat.mode & 0o022) === 0;
    return {
      path: selected,
      present: stat.isFile() && !stat.isSymbolicLink(),
      safe,
      value: safe ? fs.readFileSync(selected) : null,
      mode: stat.mode & 0o7777,
      uid: stat.uid,
    };
  } catch {
    return { path: selected, present: false, safe: false, value: null };
  }
}

function safeDirectory(candidate) {
  if (!candidate) return { path: null, present: false, safe: false, mode: null, uid: null };
  const selected = path.resolve(String(candidate));
  try {
    const stat = fs.lstatSync(selected);
    const safe = stat.isDirectory() && !stat.isSymbolicLink()
      && fs.realpathSync(selected) === selected && (stat.mode & 0o077) === 0
      && (typeof process.geteuid !== 'function' || stat.uid === process.geteuid());
    return {
      path: selected,
      present: stat.isDirectory() && !stat.isSymbolicLink(),
      safe,
      mode: stat.mode & 0o7777,
      uid: stat.uid,
    };
  } catch {
    return { path: selected, present: false, safe: false, mode: null, uid: null };
  }
}

function readJson(candidate, options = {}) {
  const file = safeRegularFile(candidate, options);
  if (!file.value) return { ...file, parsed: false, document: null };
  try {
    const document = JSON.parse(file.value.toString('utf8'));
    return { ...file, parsed: true, document };
  } catch {
    return { ...file, parsed: false, document: null };
  }
}

function hash(value, kind = 'PersonalSelfHostedLocalEvidence') {
  return hashRecord(kind, value);
}

function instant(value) {
  const milliseconds = Date.parse(String(value || ''));
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function evidence(status, details, observedAt, source = 'local-observation') {
  const payload = {
    status,
    source,
    observedAt,
    details,
  };
  return Object.freeze({
    ...payload,
    evidenceHash: hash(payload),
  });
}

function inspectProvenance({ workspaceRoot, codeProvenanceReader, observedAt = new Date().toISOString() }) {
  try {
    const provenance = codeProvenanceReader({
      workspaceRoot,
      allowReleaseCommitEnvironment: false,
    });
    const details = {
      clean: provenance.treeDirty === false
        && provenance.indexStateHash === EMPTY_INDEX_HASH,
      commit: provenance.commit,
      commitTree: provenance.commitTree,
      repositoryContentHash: provenance.repositoryContentHash,
      indexClean: provenance.indexStateHash === EMPTY_INDEX_HASH,
    };
    const ready = details.clean
      && /^[0-9a-f]{40,64}$/u.test(String(details.commit || ''))
      && /^[0-9a-f]{40,64}$/u.test(String(details.commitTree || ''))
      && SHA256.test(String(details.repositoryContentHash || ''));
    return {
      provenance,
      evidence: evidence(ready ? 'verified' : 'blocked', details, observedAt),
    };
  } catch (error) {
    return {
      provenance: null,
      evidence: evidence('blocked', {
        clean: false,
        commit: null,
        commitTree: null,
        repositoryContentHash: null,
        indexClean: false,
        error: String(error?.code || error?.message || 'provenance_invalid'),
      }, observedAt),
    };
  }
}

function inspectFormal({ runtimeRoot, environment, provenance, observedAt }) {
  const receiptPath = environment.HEPTA_FORMAL_OPERATIONAL_RECEIPT
    || path.join(runtimeRoot, 'formal-operational', 'formal-operational-receipt.json');
  const read = readJson(receiptPath);
  let verified = false;
  if (read.safe && read.parsed && provenance) {
    try {
      verified = verifyFormalOperationalReceipt(read.document, {
        expectedCodeProvenance: provenance,
      });
    } catch { verified = false; }
  }
  const value = read.document || {};
  const details = {
    zeroSkipped: verified && value.fail === 0 && value.skipped === 0 && value.todo === 0,
    pass: Number(value.pass || 0),
    fail: Number(value.fail || 0),
    skipped: Number(value.skipped || 0),
    todo: Number(value.todo || 0),
    commit: value.codeProvenance?.commit || null,
  };
  return evidence(details.zeroSkipped ? 'verified' : 'blocked', details, observedAt);
}

function inspectGpu({ runtimeRoot, environment, provenance, observedAt }) {
  const enabled = environment.HEPTA_PERSONAL_GPU_ENABLED === 'true';
  const receiptPath = environment.HEPTA_PERSONAL_GPU_RECEIPT
    || path.join(runtimeRoot, 'gpu-personal', 'personal-gpu-operational-receipt.json');
  if (!enabled) {
    return {
      enabled: false,
      status: 'not_enabled',
      deterministicReplay: false,
      sameDeviceReplay: false,
      errorBudgetVerified: false,
      modelDataCheckpointIrBound: false,
      evidenceHash: null,
      observedAt: observedAt,
      disabledReason: environment.HEPTA_PERSONAL_GPU_DISABLED_REASON
        || 'GPU capability is not enabled; run the personal GPU operational gate to collect CPU/GPU scientific evidence.',
      receiptPath,
    };
  }
  const read = readJson(receiptPath);
  const receipt = read.safe && read.parsed ? read.document : null;
  let receiptTime = null;
  try {
    receiptTime = receipt?.createdAtEpochMs
      ? new Date(receipt.createdAtEpochMs).toISOString() : null;
  } catch { receiptTime = null; }
  const valid = verifyPersonalGpuOperationalReceipt(receipt)
    && receipt.personalProductionReady === true
    && receipt.workspaceCommit === provenance?.commit
    && receipt.externalActionPerformed === false
    && receipt.networkActionPerformed === false
    && receipt.pde?.scientificChecksPassed === true
    && receipt.deepLearning?.deterministicReplay === true
    && receipt.deepLearning?.sameDeviceReplayHash
    && receipt.ir?.modelExecutableCodeEmbedded === false
    && receipt.ir?.checkpointExecutablePayloadAllowed === false
    && receipt.ir?.pickleAllowed === false
    && instant(receiptTime)
    && receiptTime <= observedAt
    && Date.parse(observedAt) - Date.parse(receiptTime) <= 24 * 60 * 60 * 1000;
  return {
    enabled: true,
    status: valid ? 'verified' : 'blocked',
    deterministicReplay: valid,
    sameDeviceReplay: valid,
    errorBudgetVerified: valid,
    modelDataCheckpointIrBound: valid,
    evidenceHash: valid ? receipt.personalGpuOperationalReceiptHash : null,
    observedAt: valid ? receiptTime : observedAt,
    receiptPath,
    workspaceCommit: receipt?.workspaceCommit || null,
    receiptKind: receipt?.kind || null,
    blockers: valid ? [] : ['personal_gpu_operational_receipt_missing_or_invalid'],
  };
}

export async function inspectPersonalSelfHostedLocalEvidence({
  workspaceRoot,
  runtimeRoot,
  environment = process.env,
  now = new Date(),
  codeProvenanceReader = currentCodeProvenance,
  personalDatabaseInspector = inspectPersonalLocalDatabase,
  sourceSecurityInspector = inspectSourceSupplyChainSecurity,
} = {}) {
  const observedAt = now instanceof Date ? now.toISOString() : String(now);
  if (!instant(observedAt)) throw new Error('personal_self_hosted_observation_time_invalid');
  const provenanceObservation = inspectProvenance({
    workspaceRoot,
    codeProvenanceReader,
    observedAt,
  });
  const provenance = provenanceObservation.provenance;
  const controls = {
    'exact-code-provenance': provenanceObservation.evidence,
    'formal-operational-zero-skipped': inspectFormal({
      runtimeRoot, environment, provenance, observedAt,
    }),
  };
  const sourceSecurity = (() => {
    try {
      return sourceSecurityInspector({ workspaceRoot, deploymentProfile: 'source-inspection' });
    } catch { return null; }
  })();
  const runtimeStat = safeDirectory(runtimeRoot);
  const sourceScanReady = sourceSecurity?.secrets?.status === 'tracked_secret_scan_ready';
  const credentialDetails = {
    privateKeyMaterialAbsent: sourceScanReady,
    secretLeakScanPassed: sourceScanReady,
    runtimeOwnerOnly: runtimeStat.safe,
    sourceScanStatus: sourceSecurity?.secrets?.status || 'unavailable',
    runtimeMode: runtimeStat.mode,
    runtimeUid: runtimeStat.uid,
  };
  controls['credential-and-runtime-boundary'] = evidence(
    sourceScanReady && runtimeStat.safe ? 'verified' : 'blocked',
    credentialDetails,
    observedAt,
  );
  let database = null;
  try {
    database = await personalDatabaseInspector({
      runtimeRoot,
      requireRestoreDrill: true,
    });
  } catch (error) {
    database = {
      ready: false,
      status: 'personal_local_database_blocked',
      blockers: [String(error?.code || error?.message || 'personal_database_inspection_failed')],
      schemaVersion: 0,
      minimumSchemaVersion: 25,
      antiRollback: null,
      restoreDrill: null,
    };
  }
  const databaseReady = database.ready === true;
  controls['database-inventory-and-schema'] = evidence(
    databaseReady ? 'verified' : 'blocked',
    {
      inventoryReady: databaseReady,
      databaseCount: 1,
      databaseReadyCount: databaseReady ? 1 : 0,
      schemaVersion: database.schemaVersion || 0,
      minimumSchemaVersion: database.minimumSchemaVersion || 25,
      quickCheck: database.quickCheck || null,
      foreignKeyViolationCount: database.foreignKeyViolationCount ?? null,
      blockers: database.blockers || [],
    },
    observedAt,
  );
  const restoreReady = database.restoreDrill?.receiptHash
    && database.restoreDrill.performedAt
    && database.ready === true;
  controls['database-restore-drill'] = evidence(
    restoreReady ? 'verified' : 'blocked',
    {
      restoreDrillReady: Boolean(restoreReady),
      restoreReceiptHash: database.restoreDrill?.receiptHash || null,
      performedAt: database.restoreDrill?.performedAt || null,
      blockers: database.blockers || [],
    },
    observedAt,
  );
  const antiRollbackReady = database.antiRollback?.ready === true
    && SHA256.test(String(database.antiRollback.ledgerHash || ''))
    && database.antiRollback.currentDatabaseSha256 === database.antiRollback.databaseSha256;
  controls['online-anti-rollback'] = evidence(
    antiRollbackReady ? 'verified' : 'blocked',
    {
      antiRollbackReady,
      integrityPinHash: database.antiRollback?.ledgerHash || null,
      sequence: database.antiRollback?.sequence || 0,
      databaseSha256: database.antiRollback?.databaseSha256 || null,
      currentDatabaseSha256: database.antiRollback?.currentDatabaseSha256 || null,
      blockers: database.blockers || [],
    },
    observedAt,
  );
  const gpu = inspectGpu({ runtimeRoot, environment, provenance, observedAt });
  const scientificDetails = {
    // The personal GPU gate is the actual producer for both the process-
    // isolated CPU oracle and the GPU/PDE/DL replay.  A disabled GPU must not
    // silently turn the CPU scientific claim green without an independent
    // local scientific receipt.
    enabledCapabilitiesReady: gpu.enabled && gpu.status === 'verified',
    enabledCapabilities: gpu.enabled ? ['cpu', 'gpu'] : ['cpu'],
    scientificReceiptPath: gpu.receiptPath,
    scientificReceiptHash: gpu.evidenceHash,
    scientificReceiptObservedAt: gpu.observedAt,
    secondHardwareStatus: 'not_applicable_for_personal_use',
  };
  controls['enabled-scientific-oracles'] = evidence(
    scientificDetails.enabledCapabilitiesReady ? 'verified' : 'blocked',
    scientificDetails,
    observedAt,
  );
  const scientific = {
    enabledCapabilities: gpu.enabled ? ['cpu', 'gpu'] : ['cpu'],
    cpu: {
      status: controls['enabled-scientific-oracles'].status === 'verified' ? 'verified' : 'blocked',
      deterministicReplay: controls['enabled-scientific-oracles'].status === 'verified',
      errorBudgetVerified: controls['enabled-scientific-oracles'].status === 'verified',
      modelDataCheckpointIrBound: controls['enabled-scientific-oracles'].status === 'verified',
      evidenceHash: controls['enabled-scientific-oracles'].evidenceHash,
      observedAt: gpu.enabled && gpu.observedAt ? gpu.observedAt : observedAt,
    },
    gpu,
  };
  const externalControls = Object.fromEntries([
    ['independent-external-authority-roles', 'no-external-authority-or-multi-operator-release-claim'],
    ['hardware-kms-hsm', 'no-distributed-release-signing-key-is-used'],
    ['local-author-review-session-separation', 'single-operator-no-review-workflow'],
    ['offhost-worm-custody', 'private-single-host-scope-with-local-backup-contract'],
    ['venue-portal-live-submission', 'no-external-submission-or-publishing-action'],
    ['oci-registry-attestation', 'no-oci-registry-distribution'],
    ['kubernetes-release-digest', 'no-kubernetes-deployment'],
  ].map(([controlId, reason]) => [controlId, { status: 'not_applicable', reason }]));
  const diagnostics = {
    'local-slo-alert-policy': {
      status: runtimeStat.safe && databaseReady ? 'locally_observed' : 'attention',
      blocking: false,
      automatic: true,
      runtimeOwnerOnly: runtimeStat.safe,
      databaseReady,
      missingDataAlertsExercised: false,
      note: 'Optional local health diagnostic; no hand-authored receipt is required.',
    },
  };
  return evaluatePersonalSelfHostedProductionReadiness({
    controls,
    scientific,
    diagnostics,
    externalControls,
    externalActionsPerformed: false,
    observedAt,
  });
}
