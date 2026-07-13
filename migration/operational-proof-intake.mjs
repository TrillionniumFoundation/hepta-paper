import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { verifyAuthoritySignatures } from '../paper-core/src/authority-signatures.mjs';
import { hashRecord } from '../workflow-kernel/record-hash.mjs';

const SHA256_RE = /^sha256:[a-f0-9]{64}$/;

function sha256File(file) {
  return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
}

function trustedKeysForVerification(trustStore, verification) {
  const verifiedKeyIds = new Set((verification?.verifiedSignatures || []).map((item) => item.keyId));
  return (trustStore?.keys || []).filter((key) => verifiedKeyIds.has(key.keyId));
}

function verifyCommonReceipt({ document, capabilityId, targetBindings, releaseCommit, blockers }) {
  if (document?.capabilityId !== capabilityId) blockers.push('receipt_capability_mismatch');
  if (!document?.productionSubject?.paperId && !document?.productionSubject?.subjectId) blockers.push('receipt_subject_missing');
  if (!Array.isArray(document?.inputHashes) || !document.inputHashes.length || document.inputHashes.some((value) => !SHA256_RE.test(value))) blockers.push('receipt_input_hashes_invalid');
  for (const key of ['executionReceiptHash', 'resultHash', 'replayReceiptHash']) {
    if (!SHA256_RE.test(document?.[key] || '')) blockers.push(`receipt_${key}_invalid`);
  }
  if (document?.replayMatched !== true) blockers.push('receipt_replay_not_matched');
  if (!releaseCommit || document?.releaseCommit !== releaseCommit) blockers.push('receipt_release_commit_mismatch');
  const expectedTargets = [...(targetBindings || [])].sort((a, b) => a.path.localeCompare(b.path));
  const actualTargets = [...(document?.targetHashes || [])].sort((a, b) => String(a.path).localeCompare(String(b.path)));
  if (JSON.stringify(actualTargets) !== JSON.stringify(expectedTargets)) blockers.push('receipt_target_hashes_mismatch');
}

export function capabilityTargetBindings(workspaceRoot, capabilityCatalog) {
  return Object.fromEntries(Object.entries(capabilityCatalog).map(([capabilityId, catalog]) => {
    const file = path.join(workspaceRoot, catalog.target);
    return [capabilityId, [{ path: catalog.target, sha256: fs.existsSync(file) ? sha256File(file) : null }]];
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
  if (document?.kind !== 'CapabilityOperationalReceipt' || document?.version !== 2) blockers.push('operational_receipt_contract_invalid');
  if (document?.status !== 'production_runtime_observation_verified') blockers.push('operational_receipt_status_invalid');
  if (document?.executionClass !== 'production_runtime_observation') blockers.push('operational_execution_class_invalid');
  if (document?.evidenceEnvironment !== 'production' || document?.evidenceClass !== 'operational') blockers.push('operational_receipt_not_production_bound');
  if (document?.productionEligible !== true) blockers.push('operational_receipt_not_production_eligible');
  verifyCommonReceipt({ document, capabilityId, targetBindings, releaseCommit, blockers });
  const verification = verifyAuthoritySignatures({
    document,
    trustStore,
    requiredRoles: ['capability_owner', 'operational_observer'],
    minSignatures: 2,
    requireDistinctSubjects: true,
  });
  if (!verification.cryptographicSignaturesVerified) blockers.push('operational_independent_signatures_invalid');
  const trustedKeys = trustedKeysForVerification(trustStore, verification);
  if (trustedKeys.length < 2 || trustedKeys.some((key) => key.assurance !== 'external_independent')) {
    blockers.push('operational_signer_assurance_not_external_independent');
  }
  const operationalReceiptHash = hashRecord('CapabilityOperationalReceipt', document);
  return Object.freeze({
    version: 2,
    kind: 'CapabilityOperationalReceiptVerification',
    status: blockers.length ? 'capability_operational_receipt_blocked' : 'capability_operational_receipt_verified',
    capabilityId,
    operationalReceiptHash,
    issuerAssurance: blockers.includes('operational_signer_assurance_not_external_independent') ? 'insufficient' : 'external_independent',
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
} = {}) {
  const blockers = [];
  if (document?.kind !== 'CapabilityConformanceReceipt' || document?.version !== 1) blockers.push('conformance_receipt_contract_invalid');
  if (document?.status !== 'production_source_bound_conformance_replay_verified') blockers.push('conformance_receipt_status_invalid');
  if (document?.executionClass !== 'production_source_bound_conformance') blockers.push('conformance_execution_class_invalid');
  if (document?.evidenceEnvironment !== 'production_source_bound' || document?.evidenceClass !== 'conformance') blockers.push('conformance_evidence_class_invalid');
  if (document?.productionEligible !== false) blockers.push('conformance_must_not_be_production_eligible');
  verifyCommonReceipt({ document, capabilityId, targetBindings, releaseCommit, blockers });
  const verification = verifyAuthoritySignatures({ document, trustStore, requiredRoles: ['capability_owner'], minSignatures: 1 });
  if (!verification.cryptographicSignaturesVerified) blockers.push('conformance_owner_signature_invalid');
  const trustedKeys = trustedKeysForVerification(trustStore, verification);
  const assurances = [...new Set(trustedKeys.map((key) => key.assurance || 'unspecified'))].sort();
  if (!trustedKeys.length || assurances.includes('unspecified')) blockers.push('conformance_signer_assurance_unspecified');
  const conformanceReceiptHash = hashRecord('CapabilityConformanceReceipt', document);
  return Object.freeze({
    version: 1,
    kind: 'CapabilityConformanceReceiptVerification',
    status: blockers.length ? 'capability_conformance_receipt_blocked' : 'capability_conformance_receipt_verified',
    capabilityId,
    conformanceReceiptHash,
    issuerAssurance: assurances.join('+') || 'unknown',
    blockers: [...new Set(blockers)],
    verifiedSubjectIds: verification.verifiedSubjectIds || [],
  });
}

function loadProofs({ runtimeRoot, workspaceRoot, capabilityCatalog, releaseCommit, directoryName, verify, verifiedStatus, hashField, listField }) {
  const verified = new Map();
  let trustStore = null;
  try { trustStore = JSON.parse(fs.readFileSync(path.join(runtimeRoot, 'owner-acceptance', 'OWNER_TRUST_STORE.json'), 'utf8')); } catch { return verified; }
  const bindings = capabilityTargetBindings(workspaceRoot, capabilityCatalog);
  const root = path.join(runtimeRoot, directoryName, 'capabilities');
  for (const capabilityId of Object.keys(capabilityCatalog).sort()) {
    const directory = path.join(root, capabilityId);
    let files = [];
    try { files = fs.readdirSync(directory).filter((name) => name.endsWith('.json')).sort(); } catch { continue; }
    const receipts = [];
    const assurances = new Set();
    for (const name of files) {
      try {
        const document = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
        const result = verify({ document, trustStore, capabilityId, targetBindings: bindings[capabilityId], releaseCommit });
        if (result.status === verifiedStatus) {
          receipts.push(result[hashField]);
          assurances.add(result.issuerAssurance);
        }
      } catch { /* malformed external intake stays unverified */ }
    }
    if (receipts.length) verified.set(capabilityId, Object.freeze({
      capabilityId,
      [listField]: [...new Set(receipts)].sort(),
      issuerAssurances: [...assurances].sort(),
    }));
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

export function loadCapabilityConformanceProofs(options = {}) {
  return loadProofs({
    ...options,
    directoryName: 'conformance-proof',
    verify: verifyCapabilityConformanceReceipt,
    verifiedStatus: 'capability_conformance_receipt_verified',
    hashField: 'conformanceReceiptHash',
    listField: 'conformanceReceiptHashes',
  });
}
