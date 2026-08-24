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
  verifyPersonalSelfHostedGpuScientificReceiptBundle,
} from '../../paper-domain/operations/personal-self-hosted-scientific-receipt-contract.mjs';
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
      && fs.realpathSync(selected) === selected && (stat.mode & 0o022) === 0;
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

function genericReceipt(value, {
  kind,
  requiredDetails = [],
  observedAt,
} = {}) {
  const details = value?.details;
  const valid = value?.version === 1
    && value?.kind === kind
    && value?.status === 'verified'
    && value?.externalActionPerformed === false
    && instant(value?.observedAt)
    && (!observedAt || value.observedAt <= observedAt)
    && details && typeof details === 'object' && !Array.isArray(details)
    && requiredDetails.every((key) => details[key] === true)
    && SHA256.test(String(value?.receiptHash || ''));
  if (!valid) return null;
  const { receiptHash, ...payload } = value;
  return receiptHash === hashRecord(kind, payload) ? value : null;
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
    || path.join(runtimeRoot, 'personal-self-hosted', 'gpu-scientific-receipt.json');
  if (!enabled) {
    return {
      enabled: false,
      disabledReason: environment.HEPTA_PERSONAL_GPU_DISABLED_REASON
        || 'GPU capability is intentionally disabled for this local profile.',
    };
  }
  const read = readJson(receiptPath);
  const receipt = read.safe && read.parsed ? read.document : null;
  const valid = verifyPersonalSelfHostedGpuScientificReceiptBundle(receipt)
    && receipt.releaseCommit === provenance?.commit
    && Date.parse(receipt.observedAt) <= Date.parse(observedAt);
  return {
    enabled: true,
    status: valid ? 'verified' : 'blocked',
    deterministicReplay: valid,
    sameDeviceReplay: valid,
    errorBudgetVerified: valid,
    modelDataCheckpointIrBound: valid,
    evidenceHash: valid ? receipt.personalSelfHostedGpuScientificReceiptBundleHash : null,
    observedAt: valid ? receipt.observedAt : observedAt,
    receiptPath,
  };
}

function inspectReceiptControl({ path: receiptPath, kind, requiredDetails, observedAt }) {
  const read = readJson(receiptPath);
  const receipt = genericReceipt(read.document, { kind, requiredDetails, observedAt });
  return receipt ? receipt.details : null;
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
  const sessionDetails = inspectReceiptControl({
    path: environment.HEPTA_PERSONAL_AUTHOR_REVIEW_RECEIPT
      || path.join(runtimeRoot, 'personal-self-hosted', 'author-review-session-receipt.json'),
    kind: 'PersonalSelfHostedAuthorReviewSessionReceipt',
    requiredDetails: ['freshSessionSeparationVerified'],
    observedAt,
  });
  controls['local-author-review-session-separation'] = evidence(
    sessionDetails ? 'verified' : 'blocked',
    sessionDetails || {
      freshSessionSeparationVerified: false,
      authorSessionHash: null,
      reviewerSessionHash: null,
    }, observedAt,
  );
  const sourceSecurity = (() => {
    try {
      return sourceSecurityInspector({ workspaceRoot, deploymentProfile: 'source-inspection' });
    } catch { return null; }
  })();
  const runtimeStat = safeDirectory(runtimeRoot);
  const credentialDetails = inspectReceiptControl({
    path: environment.HEPTA_PERSONAL_CREDENTIAL_BOUNDARY_RECEIPT
      || path.join(runtimeRoot, 'personal-self-hosted', 'credential-runtime-boundary-receipt.json'),
    kind: 'PersonalSelfHostedCredentialRuntimeBoundaryReceipt',
    requiredDetails: ['privateKeyMaterialAbsent', 'secretLeakScanPassed', 'runtimeOwnerOnly'],
    observedAt,
  });
  controls['credential-and-runtime-boundary'] = evidence(
    credentialDetails && sourceSecurity?.secrets?.status === 'tracked_secret_scan_ready'
      && runtimeStat.safe ? 'verified' : 'blocked',
    credentialDetails || {
      privateKeyMaterialAbsent: false,
      secretLeakScanPassed: sourceSecurity?.secrets?.status === 'tracked_secret_scan_ready',
      runtimeOwnerOnly: runtimeStat.safe,
    }, observedAt,
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
    enabledCapabilitiesReady: gpu.enabled ? gpu.status === 'verified' : true,
    enabledCapabilities: gpu.enabled ? ['cpu', 'gpu'] : ['cpu'],
  };
  controls['enabled-scientific-oracles'] = evidence(
    scientificDetails.enabledCapabilitiesReady ? 'verified' : 'blocked',
    scientificDetails,
    observedAt,
  );
  const sloDetails = inspectReceiptControl({
    path: environment.HEPTA_PERSONAL_SLO_RECEIPT
      || path.join(runtimeRoot, 'personal-self-hosted', 'slo-alert-receipt.json'),
    kind: 'PersonalSelfHostedSloAlertReceipt',
    requiredDetails: ['alertPolicyConfigured', 'missingDataAlertsExercised'],
    observedAt,
  });
  controls['local-slo-alert-policy'] = evidence(
    sloDetails ? 'verified' : 'blocked',
    sloDetails || { alertPolicyConfigured: false, missingDataAlertsExercised: false },
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
      observedAt,
    },
    gpu,
  };
  const externalControls = Object.fromEntries([
    ['independent-external-authority-roles', 'no-external-authority-or-multi-operator-release-claim'],
    ['hardware-kms-hsm', 'no-distributed-release-signing-key-is-used'],
    ['offhost-worm-custody', 'private-single-host-scope-with-local-backup-contract'],
    ['venue-portal-live-submission', 'no-external-submission-or-publishing-action'],
    ['oci-registry-attestation', 'no-oci-registry-distribution'],
    ['kubernetes-release-digest', 'no-kubernetes-deployment'],
  ].map(([controlId, reason]) => [controlId, { status: 'not_applicable', reason }]));
  return evaluatePersonalSelfHostedProductionReadiness({
    controls,
    scientific,
    externalControls,
    externalActionsPerformed: false,
    observedAt,
  });
}
