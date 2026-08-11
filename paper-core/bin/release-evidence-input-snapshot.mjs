import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { currentCodeProvenance } from '../src/code-provenance.mjs';
import { defaultPaperAssetRoot } from '../src/workspace-layout.mjs';
import {
  coldVolumeCasStatus,
  verifyColdVolumeContract,
  verifyOffhostWormTarget,
} from '../../paper-composition/bootstrap/operator-release-composition.mjs';
import { verifyLegacyDifferentialReference } from '../../migration/legacy-reference-fixture.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  loadCapabilityConformanceProofs,
  loadCapabilityOperationalProofs,
} from '../../paper-composition/bootstrap/operator-governance-composition.mjs';
import {
  immutableLegacyMatrixReferenceStatus,
  resolveImmutableLegacyMatrixArchive,
} from '../../migration/legacy-matrix-reference.mjs';
import { validateCapabilityOperationalEvidence } from '../../migration/capability-operational-evidence.mjs';
import { CAPABILITY_CATALOG } from '../../paper-domain/governance/capability-catalog.mjs';
import { buildReleaseTrustLayerGate } from '../../paper-domain/governance/release-trust-layer-gate.mjs';
import { releaseIntegrityEvidence } from './release-integrity-evidence.mjs';
import { assertWorkspaceReleaseReady } from '../src/release-state-repository.mjs';
import { selectCurrentReleaseVerificationReceipt } from './release-verification-receipt-selection.mjs';
import { selectCurrentCapabilityVerificationManifest } from './release-capability-manifest-selection.mjs';
import { selectCurrentLegacyImmutableSnapshotReceipt } from './release-evidence-legacy-immutable-snapshot.mjs';
import { selectCurrentLegacyDeletionDrillReceipt } from './release-evidence-legacy-deletion-drill.mjs';
import {
  captureProductionStoreLogicalIntegrity,
  captureReleaseEvidenceRegularFile,
} from './release-evidence-input-file-capture.mjs';

const defaultWorkspaceRoot =
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RELEASE_EVIDENCE_INPUT_SNAPSHOT_KEYS = Object.freeze([
  'authorityTrustStore', 'capabilityCatalogHash', 'capabilityCount',
  'capabilityManifestEvidence', 'codeProvenance', 'coldVolumeCas', 'coldVolumeContract',
  'coldVolumeStatus', 'conformanceProofSet', 'deletionDrillEvidence',
  'implementationProofSet', 'immutableMatrixReference', 'immutableSnapshotEvidence',
  'inputs', 'kind', 'minimalDifferentialFixture', 'offhostWormContract',
  'offhostWormStatus', 'operationalProofSet', 'productionStoreLogicalIntegrity',
  'releaseEvidenceInputSnapshotHash', 'releaseStateSnapshot', 'runtimeHygieneExport',
  'trustLayerGate', 'verificationReceiptEvidence', 'version',
]);
const {
  SHA256_PATTERN,
  assertExactCleanCodeProvenance,
  exactKeys,
  isPlainObject,
} = releaseIntegrityEvidence;

export function releaseAttestationCodeProvenance(provenance) {
  const selected = provenance === undefined
    ? assertExactCleanCodeProvenance(currentCodeProvenance({ allowReleaseCommitEnvironment: false }))
    : provenance;
  return Object.freeze({
    ...selected,
    evidenceEnvironment: 'administrative',
    evidenceClass: 'release_attestation',
  });
}

function canonicalReleaseEvidenceInputValue(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('release_evidence_input_snapshot_number_invalid');
    return value;
  }
  if (typeof value === 'bigint') return String(value);
  if (Buffer.isBuffer(value)) {
    return Object.freeze({ encoding: 'base64', value: value.toString('base64') });
  }
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new Error('release_evidence_input_snapshot_date_invalid');
    return value.toISOString();
  }
  if (value instanceof Map) {
    const entries = [...value.entries()].map(([key, item]) => Object.freeze({
      key: String(key),
      value: canonicalReleaseEvidenceInputValue(item),
    }));
    entries.sort((left, right) => left.key.localeCompare(right.key));
    if (new Set(entries.map((entry) => entry.key)).size !== entries.length) {
      throw new Error('release_evidence_input_snapshot_map_key_collision');
    }
    return Object.freeze(entries);
  }
  if (value instanceof Set) {
    const values = [...value].map(canonicalReleaseEvidenceInputValue);
    values.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    return Object.freeze(values);
  }
  if (Array.isArray(value)) {
    return Object.freeze(value.map(canonicalReleaseEvidenceInputValue));
  }
  if (!isPlainObject(value)) throw new Error('release_evidence_input_snapshot_value_invalid');
  return Object.freeze(Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalReleaseEvidenceInputValue(item)]),
  ));
}

export function buildReleaseEvidenceProofSetSnapshot(kind, proofs) {
  if (typeof kind !== 'string' || !kind.trim() || !(proofs instanceof Map)) {
    throw new Error('release_evidence_proof_set_inputs_invalid');
  }
  const entries = canonicalReleaseEvidenceInputValue(proofs);
  const payload = Object.freeze({
    version: 1,
    kind: 'ReleaseEvidenceProofSetSnapshot',
    proofKind: kind,
    count: entries.length,
    entries,
  });
  return Object.freeze({
    ...payload,
    releaseEvidenceProofSetSnapshotHash: hashRecord('ReleaseEvidenceProofSetSnapshot', payload),
  });
}


function capturedJsonFile(file) {
  const capture = captureReleaseEvidenceRegularFile(
    file,
    { required: true, maximumBytes: 2 * 1024 * 1024 },
  );
  let document;
  try { document = JSON.parse(capture.bytes.toString('utf8')); } catch {
    throw new Error('release_evidence_input_json_invalid');
  }
  const { bytes, ...fileCapture } = capture;
  return Object.freeze({
    file: Object.freeze(fileCapture),
    document: canonicalReleaseEvidenceInputValue(document),
  });
}

function capturedDirectory(directory, { required = false } = {}) {
  const absolute = path.resolve(directory);
  let stat;
  try { stat = fs.lstatSync(absolute); } catch (error) {
    if (!required && error?.code === 'ENOENT') {
      return Object.freeze({ present: false, path: absolute });
    }
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('release_evidence_input_directory_unsafe');
  }
  return Object.freeze({
    present: true,
    path: absolute,
    device: String(stat.dev),
    inode: String(stat.ino),
    mode: stat.mode & 0o7777,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  });
}

function projectedContract(value, keys, label) {
  if (value === null) return null;
  if (!isPlainObject(value)) throw new Error(`release_evidence_${label}_invalid`);
  return canonicalReleaseEvidenceInputValue(Object.fromEntries(
    keys.filter((key) => Object.hasOwn(value, key)).map((key) => [key, value[key]]),
  ));
}

const SEMANTIC_CONTRACT_KEYS = Object.freeze({
  coldVolumeStatus: Object.freeze([
    'version', 'kind', 'status', 'contractId', 'contractHash', 'assetRoot', 'mountRoot',
    'mountAvailable', 'mountIdentity', 'mountObservationHash',
    'targetDirectoryIdentity', 'targetDeviceMajorMinor', 'targetMountId',
    'mountDeviceMatchesTarget', 'mountIdMatchesTarget', 'mountBindingStable',
    'expectedStorageIdentityHash', 'storageIdentityMatchesContract',
    'storageAccessPolicyHash', 'coldCasRoot', 'dispositionHash', 'releaseScopeHash',
    'releaseScopeRetired', 'releaseGateSatisfied', 'retiredEntryCount',
    'retiredLogicalPathCount',
    'rawDatasetRootCount', 'presentDispositionCount', 'rebuildableDispositionCount',
    'missingDispositionCount', 'rawDatasetRows',
    'sentinelPath', 'sentinelHash', 'entryCount', 'contractValid',
    'operationalReplayReady', 'blockers', 'rows',
  ]),
  minimalDifferentialFixture: Object.freeze([
    'version', 'kind', 'status', 'manifestPath', 'archivePath', 'archiveSha256',
    'fileCount', 'blockers',
  ]),
  immutableMatrixReference: Object.freeze([
    'version', 'kind', 'status', 'manifestPath', 'archivePath', 'archiveSha256',
    'matrixPath', 'matrixSha256', 'sourceFileCount', 'liveLegacyRootRequired',
  ]),
  productionStoreLogicalIntegrity: Object.freeze([
    'version', 'kind', 'status', 'dbPath', 'byteHashBefore', 'byteHashAfter',
    'readonlyCheckMutatedDatabase', 'logicalDatabaseHash', 'schemaHash', 'tableCount',
    'totalRowCount', 'tables', 'quickCheck', 'foreignKeyViolationCount',
    'receiptLedgerRowCount', 'invalidReceiptHashCount', 'invalidReceiptRows', 'blockers',
  ]),
  coldVolumeCas: Object.freeze([
    'version', 'kind', 'status', 'casRoot', 'manifestPath', 'manifestHash', 'contractId',
    'contractHash', 'releaseScopeHash', 'entryCount', 'objectCount', 'blockers',
  ]),
  offhostWormStatus: Object.freeze([
    'version', 'kind', 'status', 'contractId', 'targetMountRoot', 'mountAvailable',
    'mountIdentity', 'mountObservationHash', 'targetDirectoryIdentity',
    'targetDeviceMajorMinor', 'targetMountId', 'mountDeviceMatchesTarget',
    'mountIdMatchesTarget', 'expectedStorageIdentityHash',
    'storageIdentityMatchesContract', 'distinctDevice', 'storageIdentityHash', 'custodyRequired',
    'currentProtectionLevel',
    'custodyDeclaredQualified', 'offHostOrOffsiteCustodyQualified', 'custodyStatus',
    'custodyBlockers', 'custodyEvidenceStatus', 'custodyEvidenceBundleHash',
    'custodyTrustStoreHash', 'custodyEvidenceExpiresAt', 'blockers',
  ]),
  trustLayerGate: Object.freeze([
    'version', 'kind', 'status', 'releaseCommit', 'capabilityCount', 'implementation',
    'releaseBoundConformance', 'independentProductionOperational',
    'conformanceCannotQualifyAsOperationalProof',
    'operationalProofCannotSubstituteForReleaseBoundConformance',
    'releaseTrustLayerGateHash',
  ]),
});

export function projectReleaseEvidenceSemanticContract(contract, value) {
  const keys = SEMANTIC_CONTRACT_KEYS[contract];
  if (keys) return projectedContract(value, keys, `${contract}_contract`);
  if ([
    'releaseStateSnapshot',
    'codeProvenance',
    'verificationReceiptEvidence',
    'capabilityManifestEvidence',
    'deletionDrillEvidence',
    'immutableSnapshotEvidence',
    'implementationProofSet',
    'conformanceProofSet',
    'operationalProofSet',
  ].includes(contract)) {
    // These documents are self-hashed/signed or contain self-hashed/signed receipts. Their
    // createdAt/completedAt/executedAt/generatedAt values are freshness and identity inputs,
    // not observation timestamps, and therefore remain in the semantic snapshot.
    return canonicalReleaseEvidenceInputValue(value);
  }
  throw new Error('release_evidence_semantic_contract_unknown');
}

function inputSnapshotPayload(snapshot) {
  const payload = { ...snapshot };
  delete payload.releaseEvidenceInputSnapshotHash;
  return payload;
}

function validProofSetSnapshot(proofSet, expectedKind) {
  if (!exactKeys(proofSet, [
    'count', 'entries', 'kind', 'proofKind', 'releaseEvidenceProofSetSnapshotHash', 'version',
  ])
    || proofSet.version !== 1
    || proofSet.kind !== 'ReleaseEvidenceProofSetSnapshot'
    || proofSet.proofKind !== expectedKind
    || !Array.isArray(proofSet.entries)
    || proofSet.count !== proofSet.entries.length
    || !proofSet.entries.every((entry) => exactKeys(entry, ['key', 'value'])
      && typeof entry.key === 'string')
    || new Set(proofSet.entries.map((entry) => entry.key)).size !== proofSet.entries.length
    || proofSet.entries.some((entry, index) => index > 0
      && proofSet.entries[index - 1].key.localeCompare(entry.key) >= 0)) return false;
  const { releaseEvidenceProofSetSnapshotHash: _hash, ...payload } = proofSet;
  return hashRecord('ReleaseEvidenceProofSetSnapshot', payload)
    === proofSet.releaseEvidenceProofSetSnapshotHash;
}

export function assertValidReleaseEvidenceInputSnapshot(snapshot) {
  if (!exactKeys(snapshot, RELEASE_EVIDENCE_INPUT_SNAPSHOT_KEYS)
    || snapshot.version !== 1
    || snapshot.kind !== 'ReleaseEvidenceInputSnapshot'
    || !SHA256_PATTERN.test(String(snapshot.releaseEvidenceInputSnapshotHash || ''))
    || !validProofSetSnapshot(snapshot.implementationProofSet, 'implementation')
    || !validProofSetSnapshot(snapshot.conformanceProofSet, 'release_bound_conformance')
    || !validProofSetSnapshot(
      snapshot.operationalProofSet,
      'independent_production_operational',
    )
    || hashRecord('ReleaseEvidenceInputSnapshot', inputSnapshotPayload(snapshot))
      !== snapshot.releaseEvidenceInputSnapshotHash) {
    throw new Error('release_evidence_input_snapshot_invalid');
  }
  return snapshot;
}

export function captureReleaseEvidenceInputSnapshot({
  runtimeRoot,
  legacyRoot,
  workspaceRoot = defaultWorkspaceRoot,
  environment = process.env,
  expectedReleaseStateSnapshotHash = null,
  now = new Date(),
} = {}) {
  const releaseStateSnapshot = assertWorkspaceReleaseReady({
    workspaceRoot,
    expectedSnapshotHash: expectedReleaseStateSnapshotHash,
  });
  const codeProvenance = releaseAttestationCodeProvenance(assertExactCleanCodeProvenance(
    currentCodeProvenance({ workspaceRoot, allowReleaseCommitEnvironment: false }),
    { releaseCommitAssertion: environment.HEPTA_RELEASE_COMMIT },
  ));
  if (releaseStateSnapshot.headCommit !== codeProvenance.commit) {
    throw new Error('release_evidence_release_state_commit_mismatch');
  }

  const verificationReceiptEvidence = selectCurrentReleaseVerificationReceipt({
    verificationRoot: path.join(runtimeRoot, 'release-evidence', 'verification-receipts'),
    runtimeRoot,
    codeProvenance,
    expectedReleaseStateSnapshot: releaseStateSnapshot,
  });
  const capabilityManifestEvidence = selectCurrentCapabilityVerificationManifest({
    runtimeRoot,
    expectedReceipt: verificationReceiptEvidence.receipt,
    expectedReceiptRelativePath: verificationReceiptEvidence.candidateRelativePath,
    expectedReceiptFileHash: verificationReceiptEvidence.candidateFileHash,
  });
  const archivePath = resolveImmutableLegacyMatrixArchive();
  const immutableSnapshotEvidence = selectCurrentLegacyImmutableSnapshotReceipt({
    archivePath,
    runtimeRoot,
    expectedCodeProvenance: codeProvenance,
    expectedReleaseStateSnapshot: releaseStateSnapshot,
    now,
  });
  const deletionDrillEvidence = selectCurrentLegacyDeletionDrillReceipt({
    deletionDrillRoot: path.join(runtimeRoot, 'legacy-retirement', 'deletion-drills'),
    runtimeRoot,
    expectedCodeProvenance: codeProvenance,
    expectedReleaseStateSnapshot: releaseStateSnapshot,
    archivePath,
    now,
  });

  const capabilityCount = Object.keys(CAPABILITY_CATALOG).length;
  const implementationProofSet = buildReleaseEvidenceProofSetSnapshot(
    'implementation',
    validateCapabilityOperationalEvidence({
      runtimeRoot,
      evidence: capabilityManifestEvidence.manifest,
      codeProvenance: verificationReceiptEvidence.receipt?.codeProvenance,
    }),
  );
  const conformanceProofSet = buildReleaseEvidenceProofSetSnapshot(
    'release_bound_conformance',
    loadCapabilityConformanceProofs({
      runtimeRoot,
      workspaceRoot,
      capabilityCatalog: CAPABILITY_CATALOG,
      releaseCommit: codeProvenance.commit,
    }),
  );
  const operationalProofSet = buildReleaseEvidenceProofSetSnapshot(
    'independent_production_operational',
    loadCapabilityOperationalProofs({
      runtimeRoot,
      workspaceRoot,
      capabilityCatalog: CAPABILITY_CATALOG,
      releaseCommit: codeProvenance.commit,
    }),
  );
  const trustLayerGate = buildReleaseTrustLayerGate({
    releaseCommit: codeProvenance.commit,
    capabilityCount,
    implementationVerified: implementationProofSet.count,
    releaseBoundConformanceVerified: conformanceProofSet.count,
    independentProductionOperationalVerified: operationalProofSet.count,
  });

  const coldVolumeContractPath = path.join(
    workspaceRoot,
    'paper-core',
    'config',
    'cold-volume-contract.v1.json',
  );
  const coldVolumeContract = capturedJsonFile(coldVolumeContractPath);
  const coldVolumeInspection = verifyColdVolumeContract({
    assetRoot: defaultPaperAssetRoot(),
    contract: coldVolumeContract.document,
  });
  const coldVolumeStatus = Object.freeze({
    ...coldVolumeInspection,
    contractHash: coldVolumeContract.file.fileHash,
  });
  const contractedColdCasRoot = path.resolve(
    coldVolumeContract.document?.storageAccessPolicy?.coldCasRoot
      || '/data/home-data/hepta-paper-cold-object-store',
  );
  const selectedColdCasRoot = path.resolve(
    environment.HEPTA_COLD_OBJECT_STORE_ROOT || contractedColdCasRoot,
  );
  if (selectedColdCasRoot !== contractedColdCasRoot) {
    throw new Error('release_evidence_cold_cas_root_contract_mismatch');
  }
  const minimalDifferentialFixture = verifyLegacyDifferentialReference();
  const immutableMatrixReference = immutableLegacyMatrixReferenceStatus();

  const productionStoreCapture = captureProductionStoreLogicalIntegrity({ runtimeRoot });
  const productionDatabase = productionStoreCapture.database;
  const productionStoreLogicalIntegrity = productionStoreCapture.report;

  const coldVolumeCas = coldVolumeCasStatus({
    casRoot: selectedColdCasRoot,
    contract: coldVolumeContract.document,
    contractHash: coldVolumeContract.file.fileHash,
  });
  const offhostWormContractPath = path.join(
    workspaceRoot,
    'paper-core',
    'config',
    'offhost-worm-contract.v1.json',
  );
  const offhostWormContract = capturedJsonFile(offhostWormContractPath);
  const offhostWormStatus = verifyOffhostWormTarget({
    workspaceRoot,
    contract: offhostWormContract.document,
    requireCustody: true,
  });

  const archiveRoot = path.dirname(archivePath);
  const archiveReadOnlyReceipt = captureReleaseEvidenceRegularFile(
    path.join(archiveRoot, 'LEGACY_ARCHIVE_READ_ONLY_RECEIPT.json'),
  );
  const legacyDatabase = captureReleaseEvidenceRegularFile(
    path.join(legacyRoot, 'paper_factory.sqlite'),
  );
  const migrationMatrix = captureReleaseEvidenceRegularFile(
    path.join(workspaceRoot, 'migration', 'legacy-semantic-migration-matrix.json'),
    { required: true },
  );
  const runtimeHygieneExport = captureReleaseEvidenceRegularFile(path.join(
    runtimeRoot,
    'quarantine',
    'pre-v0.5-runtime-evidence',
    'CONTAMINATED_RECEIPTS.json',
  ));
  const authorityTrustStore = captureReleaseEvidenceRegularFile(
    path.join(runtimeRoot, 'trust', 'AUTHORITY_TRUST_STORE.json'),
  );
  const payload = canonicalReleaseEvidenceInputValue({
    version: 1,
    kind: 'ReleaseEvidenceInputSnapshot',
    releaseStateSnapshot: projectReleaseEvidenceSemanticContract(
      'releaseStateSnapshot',
      releaseStateSnapshot,
    ),
    codeProvenance: projectReleaseEvidenceSemanticContract('codeProvenance', codeProvenance),
    verificationReceiptEvidence: projectReleaseEvidenceSemanticContract(
      'verificationReceiptEvidence',
      verificationReceiptEvidence,
    ),
    capabilityManifestEvidence: projectReleaseEvidenceSemanticContract(
      'capabilityManifestEvidence',
      capabilityManifestEvidence,
    ),
    deletionDrillEvidence: projectReleaseEvidenceSemanticContract(
      'deletionDrillEvidence',
      deletionDrillEvidence,
    ),
    immutableSnapshotEvidence: projectReleaseEvidenceSemanticContract(
      'immutableSnapshotEvidence',
      immutableSnapshotEvidence,
    ),
    capabilityCount,
    capabilityCatalogHash: hashRecord(
      'ReleaseEvidenceCapabilityCatalog',
      canonicalReleaseEvidenceInputValue(CAPABILITY_CATALOG),
    ),
    implementationProofSet: projectReleaseEvidenceSemanticContract(
      'implementationProofSet',
      implementationProofSet,
    ),
    conformanceProofSet: projectReleaseEvidenceSemanticContract(
      'conformanceProofSet',
      conformanceProofSet,
    ),
    operationalProofSet: projectReleaseEvidenceSemanticContract(
      'operationalProofSet',
      operationalProofSet,
    ),
    trustLayerGate: projectReleaseEvidenceSemanticContract('trustLayerGate', trustLayerGate),
    coldVolumeContract: coldVolumeContract.file,
    coldVolumeStatus: projectReleaseEvidenceSemanticContract(
      'coldVolumeStatus',
      coldVolumeStatus,
    ),
    minimalDifferentialFixture: projectReleaseEvidenceSemanticContract(
      'minimalDifferentialFixture',
      minimalDifferentialFixture,
    ),
    immutableMatrixReference: projectReleaseEvidenceSemanticContract(
      'immutableMatrixReference',
      immutableMatrixReference,
    ),
    productionStoreLogicalIntegrity: projectReleaseEvidenceSemanticContract(
      'productionStoreLogicalIntegrity',
      productionStoreLogicalIntegrity,
    ),
    coldVolumeCas: projectReleaseEvidenceSemanticContract('coldVolumeCas', coldVolumeCas),
    offhostWormContract: offhostWormContract.file,
    offhostWormStatus: projectReleaseEvidenceSemanticContract(
      'offhostWormStatus',
      offhostWormStatus,
    ),
    runtimeHygieneExport,
    authorityTrustStore,
    inputs: {
      workspaceRoot: path.resolve(workspaceRoot),
      runtimeRoot: path.resolve(runtimeRoot),
      legacyRoot: capturedDirectory(legacyRoot),
      legacyDatabase,
      archivePath,
      archiveReadOnlyReceipt,
      migrationMatrix,
      productionDatabase,
    },
  });
  return Object.freeze({
    ...payload,
    releaseEvidenceInputSnapshotHash: hashRecord('ReleaseEvidenceInputSnapshot', payload),
  });
}

export function assertReleaseEvidenceInputSnapshotUnchanged({
  expectedSnapshotHash,
  capture = captureReleaseEvidenceInputSnapshot,
  captureOptions,
} = {}) {
  if (!SHA256_PATTERN.test(String(expectedSnapshotHash || ''))
    || typeof capture !== 'function') {
    throw new Error('release_evidence_input_snapshot_boundary_invalid');
  }
  let current;
  try { current = assertValidReleaseEvidenceInputSnapshot(capture(captureOptions)); } catch (error) {
    throw new Error('release_evidence_input_snapshot_changed', { cause: error });
  }
  if (current.releaseEvidenceInputSnapshotHash !== expectedSnapshotHash) {
    throw new Error('release_evidence_input_snapshot_changed');
  }
  return current;
}
