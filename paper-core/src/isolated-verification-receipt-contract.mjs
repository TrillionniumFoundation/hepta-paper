import crypto from 'node:crypto';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const GIT_OBJECT_ID = /^[0-9a-f]{40,64}$/;
const MODES = Object.freeze(['test', 'ci', 'release']);
const CODE_PROVENANCE_KEYS = Object.freeze([
  'commit', 'commitTree', 'evidenceClass', 'evidenceEnvironment', 'indexStateHash', 'kind',
  'packageVersion', 'repositoryContentHash', 'repositoryEntryCount', 'tags', 'treeDirty',
  'version', 'worktreeStateHash',
]);
const RECEIPT_KEYS = Object.freeze([
  'blockers', 'codeProvenance', 'completedAt', 'completedCodeProvenance',
  'completedReleaseStateSnapshot', 'evidenceClass', 'evidenceEnvironment', 'exitCode',
  'isolatedStoreHash', 'isolatedVerificationReceiptHash', 'kind', 'mode',
  'productionGraphTracking', 'productionLogicalHashAfter', 'productionLogicalHashBefore',
  'productionLogicalIntegrityBlockersAfter', 'productionLogicalIntegrityBlockersBefore',
  'productionLogicalIntegrityStatusAfter', 'productionLogicalIntegrityStatusBefore',
  'productionLogicalStoreMutated', 'productionStoreHashAfter', 'productionStoreHashBefore',
  'productionStoreMutated', 'releaseStateSnapshot', 'sourceMutatedDuringVerification',
  'startedAt', 'status', 'version',
]);
const RELEASE_STATE_SNAPSHOT_KEYS = Object.freeze([
  'allTags', 'documentHashes', 'headCommit', 'headTags', 'kind', 'releaseState', 'status',
  'version', 'workspaceReleaseStateSnapshotHash',
]);
const RELEASE_STATE_KEYS = Object.freeze([
  'contractVersion', 'documentationProfile', 'errors', 'kind', 'ok', 'state', 'version',
]);
const RELEASE_DOCUMENTS = Object.freeze({
  packageJson: 'package.json',
  packageLock: 'package-lock.json',
  currentStatus: 'paper-core/docs/CURRENT_STATUS.md',
  releaseDocument: 'RELEASE.md',
  changelog: 'CHANGELOG.md',
});
const GRAPH_KEYS = Object.freeze([
  'allProductionModulesTracked', 'blockers', 'edgeCount', 'indexBoundModuleCount', 'kind',
  'moduleCount', 'productionGraphManifestHash', 'status', 'trackedModuleCount', 'version',
]);

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype
      || Object.getPrototypeOf(value) === null);
}

function exactKeys(value, expected) {
  return plainObject(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function unique(values) {
  return [...new Set(values)];
}

function stringList(value) {
  return Array.isArray(value)
    && value.every((item) => typeof item === 'string')
    && new Set(value).size === value.length;
}

function sortedStringList(value) {
  return stringList(value)
    && JSON.stringify(value) === JSON.stringify([...value].sort((left, right) => left.localeCompare(right)));
}

function strictIso(value) {
  const timestamp = Date.parse(String(value || ''));
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
    ? timestamp
    : null;
}

function sha256Json(value) {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

export function isolatedVerificationCodeProvenance(value, { requireClean = false } = {}) {
  if (!exactKeys(value, CODE_PROVENANCE_KEYS)
    || value.version !== 2
    || value.kind !== 'CodeProvenance'
    || typeof value.packageVersion !== 'string'
    || !value.packageVersion
    || !GIT_OBJECT_ID.test(String(value.commit || ''))
    || !GIT_OBJECT_ID.test(String(value.commitTree || ''))
    || typeof value.treeDirty !== 'boolean'
    || (requireClean && value.treeDirty)
    || !SHA256.test(String(value.indexStateHash || ''))
    || !Number.isSafeInteger(value.repositoryEntryCount)
    || value.repositoryEntryCount < 1
    || !SHA256.test(String(value.repositoryContentHash || ''))
    || !SHA256.test(String(value.worktreeStateHash || ''))
    || !stringList(value.tags)
    || typeof value.evidenceEnvironment !== 'string'
    || !value.evidenceEnvironment
    || typeof value.evidenceClass !== 'string'
    || !value.evidenceClass) {
    throw new Error('isolated_verification_code_provenance_invalid');
  }
  return Object.freeze({ ...value, tags: Object.freeze([...value.tags]) });
}

export function isolatedVerificationCodeProvenanceMatches(left, right) {
  try {
    return hashRecord(
      'IsolatedVerificationExactCodeProvenance',
      isolatedVerificationCodeProvenance(left),
    ) === hashRecord(
      'IsolatedVerificationExactCodeProvenance',
      isolatedVerificationCodeProvenance(right),
    );
  } catch {
    return false;
  }
}

export function isolatedVerificationReleaseStateSnapshotBlockers(snapshot, prefix, {
  expectedCommit = null,
  expectedPackageVersion = null,
} = {}) {
  const blockers = [];
  if (!exactKeys(snapshot, RELEASE_STATE_SNAPSHOT_KEYS)
    || snapshot.version !== 2
    || snapshot.kind !== 'WorkspaceReleaseStateSnapshot') {
    return [`${prefix}_shape_invalid`];
  }
  const {
    workspaceReleaseStateSnapshotHash: claimedHash,
    ...payload
  } = snapshot;
  if (!SHA256.test(String(claimedHash || '')) || claimedHash !== sha256Json(payload)) {
    blockers.push(`${prefix}_self_hash_mismatch`);
  }
  if (snapshot.status !== 'workspace_release_state_release_ready'
    || !GIT_OBJECT_ID.test(String(snapshot.headCommit || ''))
    || !sortedStringList(snapshot.headTags)
    || !sortedStringList(snapshot.allTags)) blockers.push(`${prefix}_status_invalid`);
  if ((expectedCommit !== null && snapshot.headCommit !== expectedCommit)
    || !snapshot.headTags.every((tag) => snapshot.allTags.includes(tag))) {
    blockers.push(`${prefix}_identity_invalid`);
  }
  if (!exactKeys(snapshot.releaseState, RELEASE_STATE_KEYS)
    || snapshot.releaseState.kind !== 'ReleaseStateConsistency'
    || snapshot.releaseState.contractVersion !== 2
    || snapshot.releaseState.ok !== true
    || snapshot.releaseState.state !== 'release_ready'
    || snapshot.releaseState.documentationProfile !== 'finalized'
    || typeof snapshot.releaseState.version !== 'string'
    || !snapshot.releaseState.version
    || (expectedPackageVersion !== null
      && snapshot.releaseState.version !== expectedPackageVersion)
    || snapshot.headTags.includes(`v${snapshot.releaseState.version}`)
    || snapshot.allTags.includes(`v${snapshot.releaseState.version}`)
    || !Array.isArray(snapshot.releaseState.errors)
    || snapshot.releaseState.errors.length !== 0) blockers.push(`${prefix}_contract_invalid`);
  if (!exactKeys(snapshot.documentHashes, Object.keys(RELEASE_DOCUMENTS))) {
    blockers.push(`${prefix}_documents_invalid`);
  } else {
    for (const [name, expectedPath] of Object.entries(RELEASE_DOCUMENTS)) {
      const document = snapshot.documentHashes[name];
      if (!exactKeys(document, ['path', 'sha256'])
        || document.path !== expectedPath
        || !SHA256.test(String(document.sha256 || ''))) {
        blockers.push(`${prefix}_documents_invalid`);
        break;
      }
    }
  }
  return unique(blockers);
}

function productionGraphBlockers(graph) {
  if (!exactKeys(graph, GRAPH_KEYS)
    || graph.version !== 1
    || graph.kind !== 'TrackedProductionGraphReport') {
    return ['isolated_verification_production_graph_shape_invalid'];
  }
  const countsValid = Number.isSafeInteger(graph.moduleCount) && graph.moduleCount > 0
    && Number.isSafeInteger(graph.edgeCount) && graph.edgeCount >= 0
    && Number.isSafeInteger(graph.trackedModuleCount)
    && Number.isSafeInteger(graph.indexBoundModuleCount)
    && graph.trackedModuleCount === graph.moduleCount
    && graph.indexBoundModuleCount === graph.moduleCount;
  return graph.status === 'tracked_production_graph_ready'
    && graph.allProductionModulesTracked === true
    && Array.isArray(graph.blockers)
    && graph.blockers.length === 0
    && SHA256.test(String(graph.productionGraphManifestHash || ''))
    && countsValid
    ? []
    : ['isolated_verification_production_graph_not_ready'];
}

function normalizeBlockerList(value, field, blockers) {
  if (!stringList(value)) {
    blockers.push(`${field}_invalid`);
    return Object.freeze([]);
  }
  return Object.freeze([...value]);
}

export function buildIsolatedVerificationReceipt({
  mode,
  codeProvenance,
  completedCodeProvenance,
  releaseStateSnapshot = null,
  completedReleaseStateSnapshot = null,
  productionGraphTracking = null,
  startedAt,
  completedAt,
  exitCode,
  isolatedStoreHash,
  productionStoreHashBefore = null,
  productionStoreHashAfter = null,
  productionLogicalHashBefore = null,
  productionLogicalHashAfter = null,
  productionLogicalIntegrityStatusBefore = null,
  productionLogicalIntegrityStatusAfter = null,
  productionLogicalIntegrityBlockersBefore = [],
  productionLogicalIntegrityBlockersAfter = [],
  blockers: declaredBlockers = [],
} = {}) {
  const blockers = [];
  const selectedDeclaredBlockers = normalizeBlockerList(
    declaredBlockers,
    'isolated_verification_declared_blockers',
    blockers,
  );
  blockers.push(...selectedDeclaredBlockers);
  if (!MODES.includes(mode)) blockers.push('isolated_verification_mode_invalid');
  const selectedBefore = isolatedVerificationCodeProvenance(codeProvenance);
  const selectedAfter = isolatedVerificationCodeProvenance(completedCodeProvenance);
  const sourceMutatedDuringVerification = !isolatedVerificationCodeProvenanceMatches(
    selectedBefore,
    selectedAfter,
  );
  if (sourceMutatedDuringVerification) blockers.push('isolated_verification_source_mutated');
  if (selectedBefore.evidenceEnvironment !== 'verification'
    || selectedAfter.evidenceEnvironment !== 'verification'
    || selectedBefore.evidenceClass !== 'technical_conformance'
    || selectedAfter.evidenceClass !== 'technical_conformance') {
    blockers.push('isolated_verification_code_provenance_classification_invalid');
  }
  if (mode === 'release' && (selectedBefore.treeDirty || selectedAfter.treeDirty)) {
    blockers.push('isolated_verification_release_clean_provenance_required');
  }
  const startedAtMs = strictIso(startedAt);
  const completedAtMs = strictIso(completedAt);
  if (startedAtMs === null || completedAtMs === null || completedAtMs < startedAtMs) {
    blockers.push('isolated_verification_time_invalid');
  }
  if (exitCode !== 0) blockers.push('isolated_verification_process_failed');
  if (!SHA256.test(String(isolatedStoreHash || ''))) {
    blockers.push('isolated_verification_isolated_store_hash_invalid');
  }
  const byteEvidenceRequired = mode === 'release'
    || productionStoreHashBefore !== null
    || productionStoreHashAfter !== null;
  const productionStoreMutated = productionStoreHashBefore !== productionStoreHashAfter;
  if (byteEvidenceRequired && (!SHA256.test(String(productionStoreHashBefore || ''))
    || !SHA256.test(String(productionStoreHashAfter || ''))
    || productionStoreMutated)) blockers.push('isolated_verification_production_store_changed_or_missing');
  const beforeLogicalBlockers = normalizeBlockerList(
    productionLogicalIntegrityBlockersBefore,
    'isolated_verification_production_logical_blockers_before',
    blockers,
  );
  const afterLogicalBlockers = normalizeBlockerList(
    productionLogicalIntegrityBlockersAfter,
    'isolated_verification_production_logical_blockers_after',
    blockers,
  );
  const logicalEvidenceRequired = mode === 'release'
    || productionLogicalHashBefore !== null
    || productionLogicalHashAfter !== null
    || productionLogicalIntegrityStatusBefore !== null
    || productionLogicalIntegrityStatusAfter !== null;
  const productionLogicalStoreMutated = productionLogicalHashBefore
    !== productionLogicalHashAfter;
  if (logicalEvidenceRequired && (!SHA256.test(String(productionLogicalHashBefore || ''))
    || !SHA256.test(String(productionLogicalHashAfter || ''))
    || productionLogicalStoreMutated
    || productionLogicalIntegrityStatusBefore !== 'sqlite_logical_integrity_verified'
    || productionLogicalIntegrityStatusAfter !== 'sqlite_logical_integrity_verified'
    || beforeLogicalBlockers.length
    || afterLogicalBlockers.length)) {
    blockers.push('isolated_verification_production_logical_integrity_invalid');
  }
  if (mode === 'release') {
    blockers.push(...isolatedVerificationReleaseStateSnapshotBlockers(
      releaseStateSnapshot,
      'isolated_verification_release_state_before',
      {
        expectedCommit: selectedBefore.commit,
        expectedPackageVersion: selectedBefore.packageVersion,
      },
    ));
    blockers.push(...isolatedVerificationReleaseStateSnapshotBlockers(
      completedReleaseStateSnapshot,
      'isolated_verification_release_state_after',
      {
        expectedCommit: selectedAfter.commit,
        expectedPackageVersion: selectedAfter.packageVersion,
      },
    ));
    if (releaseStateSnapshot?.workspaceReleaseStateSnapshotHash
        !== completedReleaseStateSnapshot?.workspaceReleaseStateSnapshotHash
      || releaseStateSnapshot?.headCommit !== selectedBefore.commit
      || completedReleaseStateSnapshot?.headCommit !== selectedAfter.commit) {
      blockers.push('isolated_verification_release_state_changed');
    }
    blockers.push(...productionGraphBlockers(productionGraphTracking));
  } else {
    if (releaseStateSnapshot !== null || completedReleaseStateSnapshot !== null) {
      blockers.push('isolated_verification_nonrelease_state_snapshot_forbidden');
    }
    if (productionGraphTracking !== null) {
      blockers.push('isolated_verification_nonrelease_production_graph_forbidden');
    }
  }
  const payload = {
    version: 2,
    kind: 'IsolatedVerificationReceipt',
    status: blockers.length
      ? 'isolated_verification_blocked'
      : 'isolated_verification_passed',
    mode,
    codeProvenance: selectedBefore,
    completedCodeProvenance: selectedAfter,
    sourceMutatedDuringVerification,
    releaseStateSnapshot,
    completedReleaseStateSnapshot,
    productionGraphTracking,
    startedAt,
    completedAt,
    exitCode: Number.isSafeInteger(exitCode) ? exitCode : null,
    isolatedStoreHash,
    productionStoreHashBefore,
    productionStoreHashAfter,
    productionStoreMutated,
    productionLogicalHashBefore,
    productionLogicalHashAfter,
    productionLogicalStoreMutated,
    productionLogicalIntegrityStatusBefore,
    productionLogicalIntegrityStatusAfter,
    productionLogicalIntegrityBlockersBefore: beforeLogicalBlockers,
    productionLogicalIntegrityBlockersAfter: afterLogicalBlockers,
    evidenceEnvironment: 'verification',
    evidenceClass: 'technical_conformance',
    blockers: Object.freeze(unique(blockers)),
  };
  return Object.freeze({
    ...payload,
    isolatedVerificationReceiptHash: hashRecord('IsolatedVerificationReceipt', payload),
  });
}

export function verifyIsolatedVerificationReceipt({
  receipt,
  expectedMode = null,
  expectedCodeProvenance = null,
} = {}) {
  const blockers = [];
  if (!exactKeys(receipt, RECEIPT_KEYS)
    || receipt?.version !== 2
    || receipt?.kind !== 'IsolatedVerificationReceipt') {
    return Object.freeze({
      status: 'isolated_verification_receipt_invalid',
      blockers: Object.freeze(['isolated_verification_receipt_shape_invalid']),
      receipt: null,
    });
  }
  let rebuilt;
  try {
    rebuilt = buildIsolatedVerificationReceipt(receipt);
  } catch {
    blockers.push('isolated_verification_receipt_fields_invalid');
  }
  if (rebuilt && hashRecord('IsolatedVerificationReceiptExactShape', rebuilt)
    !== hashRecord('IsolatedVerificationReceiptExactShape', receipt)) {
    blockers.push('isolated_verification_receipt_status_inconsistent');
  }
  const { isolatedVerificationReceiptHash: claimedHash, ...payload } = receipt;
  if (!SHA256.test(String(claimedHash || ''))
    || claimedHash !== hashRecord('IsolatedVerificationReceipt', payload)) {
    blockers.push('isolated_verification_receipt_self_hash_mismatch');
  }
  if (expectedMode !== null && receipt.mode !== expectedMode) {
    blockers.push('isolated_verification_receipt_mode_mismatch');
  }
  if (expectedCodeProvenance !== null
    && !isolatedVerificationCodeProvenanceMatches(
      receipt.codeProvenance,
      expectedCodeProvenance,
    )) blockers.push('isolated_verification_receipt_code_provenance_mismatch');
  return Object.freeze({
    status: blockers.length
      ? 'isolated_verification_receipt_invalid'
      : 'isolated_verification_receipt_verified',
    blockers: Object.freeze(unique(blockers)),
    receipt: blockers.length ? null : receipt,
  });
}

export const ISOLATED_VERIFICATION_RECEIPT_KEYS = RECEIPT_KEYS;
