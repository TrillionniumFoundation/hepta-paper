import fs from 'node:fs';
import path from 'node:path';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { sha256FileSync } from '../../workflow-kernel/runtime/file-utils.mjs';
import { verifyAuthoritySignatures } from '../authority/authority-signatures.mjs';
import { currentCodeProvenance } from '../runtime/code-provenance.mjs';
import {
  capabilityProductionSubject,
  readBoundRegularJson,
  resolveConformanceArtifact,
  resolveCurrentCapabilityProductionSubject,
} from './capability-proof-verifier-support.mjs';

export {
  capabilityProductionSubject,
  readBoundRegularJson,
  resolveCurrentCapabilityProductionSubject,
} from './capability-proof-verifier-support.mjs';

const SHA256_RE = /^sha256:[a-f0-9]{64}$/;
const GIT_OBJECT_ID_RE = /^[a-f0-9]{40,64}$/;
const CODE_PROVENANCE_KEYS = Object.freeze([
  'version',
  'kind',
  'packageVersion',
  'commit',
  'commitTree',
  'tags',
  'treeDirty',
  'indexStateHash',
  'repositoryEntryCount',
  'repositoryContentHash',
  'worktreeStateHash',
  'evidenceEnvironment',
  'evidenceClass',
]);

function hasExactKeys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === [...expected].sort().join('\0');
}

function verifyProductionSubjectBinding({ document, expectedProductionSubject, blockers, prefix }) {
  let actual;
  let expected;
  try {
    actual = capabilityProductionSubject(document?.productionSubject);
    expected = capabilityProductionSubject(expectedProductionSubject);
  } catch {
    blockers.push(`${prefix}_production_subject_invalid`);
    return;
  }
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    blockers.push(`${prefix}_production_subject_mismatch`);
  }
  if (!Array.isArray(document?.inputHashes)
    || !document.inputHashes.includes(actual.sourceHash)) {
    blockers.push(`${prefix}_production_source_hash_not_in_inputs`);
  }
}

function replayResultClaimsExternalAction(...results) {
  const pending = [...results];
  const seen = new WeakSet();
  let inspected = 0;
  while (pending.length > 0) {
    const value = pending.pop();
    if (!value || typeof value !== 'object') continue;
    if (seen.has(value)) continue;
    seen.add(value);
    inspected += 1;
    if (inspected > 10_000) return true;
    if (value.externalActionPerformed === true || value.providerCallPerformed === true) {
      return true;
    }
    pending.push(...(Array.isArray(value) ? value : Object.values(value)));
  }
  return false;
}

export function capabilityVerificationCodeProvenance(value, { exact = false } = {}) {
  const normalized = {
    ...value,
    tags: value?.tags ?? [],
    evidenceEnvironment: value?.evidenceEnvironment ?? 'production',
    evidenceClass: value?.evidenceClass ?? 'runtime_unclassified',
  };
  if ((exact && !hasExactKeys(value, CODE_PROVENANCE_KEYS))
    || normalized.version !== 2
    || normalized.kind !== 'CodeProvenance'
    || typeof normalized.packageVersion !== 'string'
    || !normalized.packageVersion
    || !GIT_OBJECT_ID_RE.test(String(normalized.commit || ''))
    || !GIT_OBJECT_ID_RE.test(String(normalized.commitTree || ''))
    || !Array.isArray(normalized.tags)
    || normalized.tags.some((tag) => typeof tag !== 'string')
    || new Set(normalized.tags).size !== normalized.tags.length
    || typeof normalized.treeDirty !== 'boolean'
    || !SHA256_RE.test(String(normalized.indexStateHash || ''))
    || !Number.isSafeInteger(normalized.repositoryEntryCount)
    || normalized.repositoryEntryCount < 1
    || !SHA256_RE.test(String(normalized.repositoryContentHash || ''))
    || !SHA256_RE.test(String(normalized.worktreeStateHash || ''))
    || typeof normalized.evidenceEnvironment !== 'string'
    || !normalized.evidenceEnvironment
    || typeof normalized.evidenceClass !== 'string'
    || !normalized.evidenceClass) {
    throw new Error('capability_verification_code_provenance_invalid');
  }
  return Object.freeze({
    ...Object.fromEntries(CODE_PROVENANCE_KEYS.map((key) => [key, normalized[key]])),
    tags: Object.freeze([...normalized.tags]),
  });
}

export function capabilityVerificationCodeProvenanceHash(value) {
  return hashRecord(
    'CapabilityVerificationCodeProvenance',
    capabilityVerificationCodeProvenance(value),
  );
}

export function capabilityVerificationCodeProvenanceMatches(left, right) {
  try {
    return capabilityVerificationCodeProvenanceHash(left)
      === capabilityVerificationCodeProvenanceHash(right);
  } catch {
    return false;
  }
}

function verifyExactCodeProvenance({ document, codeProvenance, releaseCommit, blockers }) {
  let bound;
  let current;
  try {
    bound = capabilityVerificationCodeProvenance(document?.codeProvenance, { exact: true });
    current = capabilityVerificationCodeProvenance(codeProvenance);
  } catch {
    blockers.push('conformance_code_provenance_invalid');
    return;
  }
  if (bound.treeDirty || current.treeDirty) blockers.push('conformance_clean_head_required');
  if (bound.commit !== releaseCommit || current.commit !== releaseCommit) {
    blockers.push('conformance_code_provenance_commit_mismatch');
  }
  if (document?.codeProvenanceHash !== capabilityVerificationCodeProvenanceHash(bound)) {
    blockers.push('conformance_code_provenance_hash_mismatch');
  }
  if (!capabilityVerificationCodeProvenanceMatches(bound, current)) {
    blockers.push('conformance_code_provenance_not_current');
  }
}

export function capabilityConformanceReceiptHash(document = {}) {
  const {
    capabilityConformanceReceiptHash: _claimedHash,
    signatures: _signatures,
    ...payload
  } = document;
  return hashRecord('CapabilityConformanceReceipt', { ...payload, signatures: [] });
}

export function capabilityConformanceReplayEvidenceHash(document = {}) {
  const { executionReceiptHash: _claimedHash, ...payload } = document;
  return hashRecord('CapabilityConformanceReplayEvidence', payload);
}

export function capabilityConformanceReplayManifestHash(document = {}) {
  const { capabilityConformanceReplayManifestHash: _claimedHash, ...payload } = document;
  return hashRecord('CapabilityConformanceReplayManifest', payload);
}

function trustedKeysForVerification(trustStore, verification) {
  const verifiedKeyIds = new Set((verification?.verifiedSignatures || []).map((item) => item.keyId));
  return (trustStore?.keys || []).filter((key) => verifiedKeyIds.has(key.keyId));
}

function verifyCommonReceipt({ document, capabilityId, targetBindings, releaseCommit, blockers }) {
  if (document?.capabilityId !== capabilityId) blockers.push('receipt_capability_mismatch');
  if (!document?.productionSubject?.paperId && !document?.productionSubject?.subjectId) {
    blockers.push('receipt_subject_missing');
  }
  if (!Array.isArray(document?.inputHashes)
    || !document.inputHashes.length
    || document.inputHashes.some((value) => !SHA256_RE.test(value))) {
    blockers.push('receipt_input_hashes_invalid');
  }
  for (const key of ['executionReceiptHash', 'resultHash', 'replayReceiptHash']) {
    if (!SHA256_RE.test(document?.[key] || '')) blockers.push(`receipt_${key}_invalid`);
  }
  if (document?.replayMatched !== true) blockers.push('receipt_replay_not_matched');
  if (!releaseCommit || document?.releaseCommit !== releaseCommit) {
    blockers.push('receipt_release_commit_mismatch');
  }
  const expectedTargets = [...(targetBindings || [])].sort((left, right) => left.path.localeCompare(right.path));
  const actualTargets = [...(document?.targetHashes || [])]
    .sort((left, right) => String(left.path).localeCompare(String(right.path)));
  if (JSON.stringify(actualTargets) !== JSON.stringify(expectedTargets)) {
    blockers.push('receipt_target_hashes_mismatch');
  }
}

export function capabilityTargetBindings(workspaceRoot, capabilityCatalog) {
  return Object.fromEntries(Object.entries(capabilityCatalog).map(([capabilityId, catalog]) => {
    const file = path.join(workspaceRoot, catalog.target);
    return [capabilityId, [{
      path: catalog.target,
      sha256: fs.existsSync(file) ? sha256FileSync(file) : null,
    }]];
  }));
}

export function verifyCapabilityOperationalReceipt({
  document,
  trustStore,
  capabilityId,
  targetBindings,
  releaseCommit,
} = {}) {
  const blockers = [];
  if (document?.kind !== 'CapabilityOperationalReceipt' || document?.version !== 2) {
    blockers.push('operational_receipt_contract_invalid');
  }
  if (document?.status !== 'production_runtime_observation_verified') {
    blockers.push('operational_receipt_status_invalid');
  }
  if (document?.executionClass !== 'production_runtime_observation') {
    blockers.push('operational_execution_class_invalid');
  }
  if (document?.evidenceEnvironment !== 'production' || document?.evidenceClass !== 'operational') {
    blockers.push('operational_receipt_not_production_bound');
  }
  if (document?.productionEligible !== true) blockers.push('operational_receipt_not_production_eligible');
  verifyCommonReceipt({ document, capabilityId, targetBindings, releaseCommit, blockers });
  const verification = verifyAuthoritySignatures({
    document,
    trustStore,
    requiredRoles: ['capability_owner', 'operational_observer'],
    minSignatures: 2,
    requireDistinctSubjects: true,
  });
  if (!verification.cryptographicSignaturesVerified) {
    blockers.push('operational_independent_signatures_invalid');
  }
  const trustedKeys = trustedKeysForVerification(trustStore, verification);
  if (trustedKeys.length < 2
    || trustedKeys.some((key) => key.assurance !== 'external_independent')) {
    blockers.push('operational_signer_assurance_not_external_independent');
  }
  const operationalReceiptHash = hashRecord('CapabilityOperationalReceipt', document);
  return Object.freeze({
    version: 2,
    kind: 'CapabilityOperationalReceiptVerification',
    status: blockers.length
      ? 'capability_operational_receipt_blocked'
      : 'capability_operational_receipt_verified',
    capabilityId,
    operationalReceiptHash,
    issuerAssurance: blockers.includes('operational_signer_assurance_not_external_independent')
      ? 'insufficient'
      : 'external_independent',
    blockers: [...new Set(blockers)],
    verifiedSubjectIds: verification.verifiedSubjectIds || [],
  });
}

export function verifyCapabilityConformanceReceipt({
  document,
  trustStore,
  capabilityId,
  targetBindings,
  releaseCommit,
  expectedProductionSubject,
  codeProvenance = currentCodeProvenance({ allowReleaseCommitEnvironment: false }),
} = {}) {
  const blockers = [];
  const historicV1 = document?.kind === 'CapabilityConformanceReceipt' && document?.version === 1;
  const currentV2 = document?.kind === 'CapabilityConformanceReceipt' && document?.version === 2;
  if (!historicV1 && !currentV2) {
    blockers.push('conformance_receipt_contract_invalid');
  }
  if (document?.status !== 'production_source_bound_conformance_replay_verified') {
    blockers.push('conformance_receipt_status_invalid');
  }
  if (document?.executionClass !== 'production_source_bound_conformance') {
    blockers.push('conformance_execution_class_invalid');
  }
  if (document?.evidenceEnvironment !== 'production_source_bound'
    || document?.evidenceClass !== 'conformance') {
    blockers.push('conformance_evidence_class_invalid');
  }
  if (document?.productionEligible !== false) blockers.push('conformance_must_not_be_production_eligible');
  verifyCommonReceipt({ document, capabilityId, targetBindings, releaseCommit, blockers });
  if (currentV2) {
    if (document?.externalActionPerformed !== false) {
      blockers.push('conformance_receipt_external_action_invalid');
    }
    verifyProductionSubjectBinding({
      document,
      expectedProductionSubject,
      blockers,
      prefix: 'conformance_receipt',
    });
    verifyExactCodeProvenance({ document, codeProvenance, releaseCommit, blockers });
    if (document?.capabilityConformanceReceiptHash
      !== capabilityConformanceReceiptHash(document)) {
      blockers.push('conformance_receipt_self_hash_mismatch');
    }
  }
  const verification = verifyAuthoritySignatures({
    document,
    trustStore,
    requiredRoles: ['capability_owner'],
    minSignatures: 1,
  });
  if (!verification.cryptographicSignaturesVerified) blockers.push('conformance_owner_signature_invalid');
  const trustedKeys = trustedKeysForVerification(trustStore, verification);
  const assurances = [...new Set(trustedKeys.map((key) => key.assurance || 'unspecified'))].sort();
  if (!trustedKeys.length || assurances.includes('unspecified')) {
    blockers.push('conformance_signer_assurance_unspecified');
  }
  const conformanceReceiptHash = currentV2
    ? document?.capabilityConformanceReceiptHash || capabilityConformanceReceiptHash(document)
    : hashRecord('CapabilityConformanceReceipt', document);
  const auditOnly = historicV1 && blockers.length === 0;
  return Object.freeze({
    version: 2,
    kind: 'CapabilityConformanceReceiptVerification',
    status: auditOnly
      ? 'capability_conformance_receipt_audit_only'
      : blockers.length
        ? 'capability_conformance_receipt_blocked'
        : 'capability_conformance_receipt_verified',
    capabilityId,
    conformanceReceiptHash,
    issuerAssurance: assurances.join('+') || 'unknown',
    releaseBound: currentV2 && blockers.length === 0,
    auditOnly,
    blockers: auditOnly
      ? ['conformance_receipt_historic_v1_audit_only']
      : [...new Set(blockers)],
    verifiedSubjectIds: verification.verifiedSubjectIds || [],
  });
}

export function verifyCapabilityConformanceReplayEvidence({
  document,
  capabilityId,
  targetBindings,
  releaseCommit,
  expectedProductionSubject,
  codeProvenance = currentCodeProvenance({ allowReleaseCommitEnvironment: false }),
} = {}) {
  const blockers = [];
  if (document?.kind !== 'CapabilityConformanceReplayEvidence' || document?.version !== 2) {
    blockers.push('conformance_replay_evidence_contract_invalid');
  }
  if (document?.status !== 'production_source_bound_conformance_replay_verified') {
    blockers.push('conformance_replay_evidence_status_invalid');
  }
  if (document?.executionClass !== 'production_source_bound_conformance'
    || document?.evidenceEnvironment !== 'production_source_bound'
    || document?.evidenceClass !== 'conformance') {
    blockers.push('conformance_replay_evidence_class_invalid');
  }
  if (document?.externalActionPerformed !== false) {
    blockers.push('conformance_replay_external_action_invalid');
  }
  if (document?.productionEligible !== false) {
    blockers.push('conformance_replay_must_not_be_production_eligible');
  }
  if (replayResultClaimsExternalAction(document?.firstResult, document?.secondResult)) {
    blockers.push('conformance_replay_result_external_action_invalid');
  }
  verifyCommonReceipt({ document, capabilityId, targetBindings, releaseCommit, blockers });
  verifyProductionSubjectBinding({
    document,
    expectedProductionSubject,
    blockers,
    prefix: 'conformance_replay_evidence',
  });
  verifyExactCodeProvenance({ document, codeProvenance, releaseCommit, blockers });
  const firstResultHash = hashRecord('CapabilityOperationalResult', {
    capabilityId,
    result: document?.firstResult,
  });
  const secondResultHash = hashRecord('CapabilityOperationalResult', {
    capabilityId,
    result: document?.secondResult,
  });
  const comparison = {
    version: 1,
    kind: 'CapabilityOperationalReplayComparison',
    capabilityId,
    firstResultHash,
    secondResultHash,
    replayMatched: firstResultHash === secondResultHash,
  };
  if (document?.resultHash !== firstResultHash
    || document?.replayMatched !== comparison.replayMatched
    || comparison.replayMatched !== true
    || document?.replayReceiptHash
      !== hashRecord('CapabilityOperationalReplayComparison', comparison)) {
    blockers.push('conformance_replay_result_binding_invalid');
  }
  if (document?.executionReceiptHash !== capabilityConformanceReplayEvidenceHash(document)) {
    blockers.push('conformance_replay_evidence_self_hash_mismatch');
  }
  return Object.freeze({
    version: 2,
    kind: 'CapabilityConformanceReplayEvidenceVerification',
    status: blockers.length
      ? 'capability_conformance_replay_evidence_blocked'
      : 'capability_conformance_replay_evidence_verified',
    capabilityId,
    executionReceiptHash: document?.executionReceiptHash || null,
    blockers: [...new Set(blockers)],
  });
}

export function verifyCapabilityConformanceReplayManifest({
  document,
  capabilityIds,
  releaseCommit,
  expectedProductionSubject,
  codeProvenance = currentCodeProvenance({ allowReleaseCommitEnvironment: false }),
} = {}) {
  const blockers = [];
  const expectedCapabilityIds = [...new Set(capabilityIds || [])].sort();
  const entries = Array.isArray(document?.verified) ? document.verified : [];
  const actualCapabilityIds = entries.map((item) => String(item?.capabilityId || '')).sort();
  if (document?.kind !== 'CapabilityConformanceReplayManifest' || document?.version !== 2) {
    blockers.push('conformance_replay_manifest_contract_invalid');
  }
  if (document?.status !== 'all_capabilities_conformance_replayed') {
    blockers.push('conformance_replay_manifest_status_invalid');
  }
  if (document?.productionEligible !== false || document?.externalActionPerformed !== false) {
    blockers.push('conformance_replay_manifest_policy_invalid');
  }
  if (document?.releaseCommit !== releaseCommit) {
    blockers.push('conformance_replay_manifest_release_commit_mismatch');
  }
  verifyProductionSubjectBinding({
    document,
    expectedProductionSubject,
    blockers,
    prefix: 'conformance_replay_manifest',
  });
  if (document?.paperId !== document?.productionSubject?.paperId
    || document?.productionSourceHash !== document?.productionSubject?.sourceHash) {
    blockers.push('conformance_replay_manifest_subject_alias_mismatch');
  }
  if (document?.capabilityCount !== expectedCapabilityIds.length
    || entries.length !== expectedCapabilityIds.length
    || JSON.stringify(actualCapabilityIds) !== JSON.stringify(expectedCapabilityIds)) {
    blockers.push('conformance_replay_manifest_capabilities_mismatch');
  }
  verifyExactCodeProvenance({ document, codeProvenance, releaseCommit, blockers });
  if (document?.capabilityConformanceReplayManifestHash
    !== capabilityConformanceReplayManifestHash(document)) {
    blockers.push('conformance_replay_manifest_self_hash_mismatch');
  }
  return Object.freeze({
    version: 2,
    kind: 'CapabilityConformanceReplayManifestVerification',
    status: blockers.length
      ? 'capability_conformance_replay_manifest_blocked'
      : 'capability_conformance_replay_manifest_verified',
    blockers: [...new Set(blockers)],
  });
}

function loadProofs({
  runtimeRoot,
  workspaceRoot,
  capabilityCatalog,
  releaseCommit,
  directoryName,
  verify,
  verifiedStatus,
  hashField,
  listField,
}) {
  const verified = new Map();
  let trustStore = null;
  try {
    trustStore = JSON.parse(fs.readFileSync(
      path.join(runtimeRoot, 'owner-acceptance', 'OWNER_TRUST_STORE.json'),
      'utf8',
    ));
  } catch {
    return verified;
  }
  const bindings = capabilityTargetBindings(workspaceRoot, capabilityCatalog);
  const root = path.join(runtimeRoot, directoryName, 'capabilities');
  for (const capabilityId of Object.keys(capabilityCatalog).sort()) {
    const directory = path.join(root, capabilityId);
    let files = [];
    try {
      files = fs.readdirSync(directory).filter((name) => name.endsWith('.json')).sort();
    } catch {
      continue;
    }
    const receipts = [];
    const assurances = new Set();
    for (const name of files) {
      try {
        const document = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
        const result = verify({
          document,
          trustStore,
          capabilityId,
          targetBindings: bindings[capabilityId],
          releaseCommit,
        });
        if (result.status === verifiedStatus) {
          receipts.push(result[hashField]);
          assurances.add(result.issuerAssurance);
        }
      } catch {
        // Malformed external intake stays unverified.
      }
    }
    if (receipts.length) {
      verified.set(capabilityId, Object.freeze({
        capabilityId,
        [listField]: [...new Set(receipts)].sort(),
        issuerAssurances: [...assurances].sort(),
      }));
    }
  }
  return verified;
}

export function loadCapabilityOperationalProofs(options = {}) {
  return loadProofs({
    ...options,
    directoryName: 'operational-proof',
    verify: verifyCapabilityOperationalReceipt,
    verifiedStatus: 'capability_operational_receipt_verified',
    hashField: 'operationalReceiptHash',
    listField: 'operationalReceiptHashes',
  });
}

function conformanceEntryMatches({ entry, receipt, evidence, verification }) {
  return entry?.resultHash === receipt.resultHash
    && entry.resultHash === evidence.resultHash
    && entry.executionReceiptHash === receipt.executionReceiptHash
    && entry.executionReceiptHash === evidence.executionReceiptHash
    && entry.replayReceiptHash === receipt.replayReceiptHash
    && entry.replayReceiptHash === evidence.replayReceiptHash
    && entry.conformanceReceiptHash === verification.conformanceReceiptHash
    && receipt.executionEvidencePath === entry.evidencePath
    && JSON.stringify(receipt.productionSubject) === JSON.stringify(evidence.productionSubject)
    && JSON.stringify(receipt.inputHashes) === JSON.stringify(evidence.inputHashes)
    && JSON.stringify(receipt.targetHashes) === JSON.stringify(evidence.targetHashes);
}

export function loadCapabilityConformanceProofs(options = {}) {
  const {
    runtimeRoot,
    workspaceRoot,
    capabilityCatalog,
    releaseCommit,
    codeProvenance = currentCodeProvenance({
      workspaceRoot,
      allowReleaseCommitEnvironment: false,
    }),
  } = options;
  const empty = new Map();
  let selectedProvenance;
  let expectedProductionSubject;
  try {
    selectedProvenance = capabilityVerificationCodeProvenance(codeProvenance);
    expectedProductionSubject = capabilityProductionSubject(
      resolveCurrentCapabilityProductionSubject(options),
    );
  } catch {
    return empty;
  }
  if (selectedProvenance.treeDirty || selectedProvenance.commit !== releaseCommit) return empty;
  let trustStore;
  let manifest;
  try {
    trustStore = readBoundRegularJson(
      runtimeRoot,
      path.join(runtimeRoot, 'owner-acceptance', 'OWNER_TRUST_STORE.json'),
    );
    manifest = readBoundRegularJson(
      runtimeRoot,
      path.join(
        runtimeRoot,
        'conformance-proof',
        `CAPABILITY_CONFORMANCE_REPLAY_MANIFEST_${releaseCommit.slice(0, 12)}.json`,
      ),
    );
  } catch {
    return empty;
  }
  const capabilityIds = Object.keys(capabilityCatalog || {}).sort();
  const manifestVerification = verifyCapabilityConformanceReplayManifest({
    document: manifest,
    capabilityIds,
    releaseCommit,
    codeProvenance: selectedProvenance,
    expectedProductionSubject,
  });
  if (manifestVerification.status !== 'capability_conformance_replay_manifest_verified') {
    return empty;
  }
  const verified = new Map();
  try {
    for (const entry of manifest.verified) {
      const capabilityId = String(entry.capabilityId || '');
      if (!capabilityCatalog[capabilityId] || verified.has(capabilityId)) {
        throw new Error('conformance_manifest_capability_duplicate_or_unknown');
      }
      const receipt = readBoundRegularJson(
        runtimeRoot,
        resolveConformanceArtifact(runtimeRoot, entry.receiptPath),
      );
      const evidence = readBoundRegularJson(
        runtimeRoot,
        resolveConformanceArtifact(runtimeRoot, entry.evidencePath),
      );
      const targetBindings = capabilityTargetBindings(workspaceRoot, {
        [capabilityId]: capabilityCatalog[capabilityId],
      })[capabilityId];
      const evidenceVerification = verifyCapabilityConformanceReplayEvidence({
        document: evidence,
        capabilityId,
        targetBindings,
        releaseCommit,
        codeProvenance: selectedProvenance,
        expectedProductionSubject,
      });
      const receiptVerification = verifyCapabilityConformanceReceipt({
        document: receipt,
        trustStore,
        capabilityId,
        targetBindings,
        releaseCommit,
        codeProvenance: selectedProvenance,
        expectedProductionSubject,
      });
      if (evidenceVerification.status !== 'capability_conformance_replay_evidence_verified'
        || receiptVerification.status !== 'capability_conformance_receipt_verified'
        || !conformanceEntryMatches({
          entry,
          receipt,
          evidence,
          verification: receiptVerification,
        })) {
        throw new Error('conformance_manifest_entry_invalid');
      }
      verified.set(capabilityId, Object.freeze({
        capabilityId,
        conformanceReceiptHashes: [receiptVerification.conformanceReceiptHash],
        issuerAssurances: [receiptVerification.issuerAssurance],
      }));
    }
  } catch {
    return empty;
  }
  if (verified.size !== capabilityIds.length) return empty;
  try {
    const postflightProductionSubject = capabilityProductionSubject(
      resolveCurrentCapabilityProductionSubject(options),
    );
    if (JSON.stringify(postflightProductionSubject)
      !== JSON.stringify(expectedProductionSubject)) return empty;
  } catch {
    return empty;
  }
  return verified;
}
