import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { verifyAuthoritySignatures } from '../paper-core/src/authority-signatures.mjs';
import { hashRecord } from '../workflow-kernel/record-hash.mjs';

const SHA256_RE = /^sha256:[a-f0-9]{64}$/;

function sha256File(file) {
  return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
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
  if (document?.kind !== 'CapabilityOperationalReceipt' || document?.version !== 1) blockers.push('operational_receipt_contract_invalid');
  if (document?.capabilityId !== capabilityId) blockers.push('operational_receipt_capability_mismatch');
  if (document?.status !== 'production_capability_replay_verified') blockers.push('operational_receipt_status_invalid');
  if (document?.evidenceEnvironment !== 'production' || document?.evidenceClass !== 'operational') blockers.push('operational_receipt_not_production_bound');
  if (document?.productionEligible !== true) blockers.push('operational_receipt_not_production_eligible');
  if (!document?.productionSubject?.paperId && !document?.productionSubject?.subjectId) blockers.push('operational_receipt_subject_missing');
  if (!Array.isArray(document?.inputHashes) || !document.inputHashes.length || document.inputHashes.some((value) => !SHA256_RE.test(value))) blockers.push('operational_input_hashes_invalid');
  for (const key of ['executionReceiptHash', 'resultHash', 'replayReceiptHash']) {
    if (!SHA256_RE.test(document?.[key] || '')) blockers.push(`operational_${key}_invalid`);
  }
  if (document?.replayMatched !== true) blockers.push('operational_replay_not_matched');
  if (!releaseCommit || document?.releaseCommit !== releaseCommit) blockers.push('operational_release_commit_mismatch');
  const expectedTargets = [...(targetBindings || [])].sort((a, b) => a.path.localeCompare(b.path));
  const actualTargets = [...(document?.targetHashes || [])].sort((a, b) => String(a.path).localeCompare(String(b.path)));
  if (JSON.stringify(actualTargets) !== JSON.stringify(expectedTargets)) blockers.push('operational_target_hashes_mismatch');
  const verification = verifyAuthoritySignatures({
    document,
    trustStore,
    requiredRoles: ['capability_owner'],
    minSignatures: 1,
  });
  if (!verification.cryptographicSignaturesVerified) blockers.push('operational_owner_signature_invalid');
  const operationalReceiptHash = hashRecord('CapabilityOperationalReceipt', document);
  return Object.freeze({
    version: 1,
    kind: 'CapabilityOperationalReceiptVerification',
    status: blockers.length ? 'capability_operational_receipt_blocked' : 'capability_operational_receipt_verified',
    capabilityId,
    operationalReceiptHash,
    blockers,
    verifiedSubjectIds: verification.verifiedSubjectIds || [],
  });
}

export function loadCapabilityOperationalProofs({ runtimeRoot, workspaceRoot, capabilityCatalog, releaseCommit } = {}) {
  const verified = new Map();
  let trustStore = null;
  try { trustStore = JSON.parse(fs.readFileSync(path.join(runtimeRoot, 'owner-acceptance', 'OWNER_TRUST_STORE.json'), 'utf8')); } catch { return verified; }
  const bindings = capabilityTargetBindings(workspaceRoot, capabilityCatalog);
  const root = path.join(runtimeRoot, 'operational-proof', 'capabilities');
  for (const capabilityId of Object.keys(capabilityCatalog).sort()) {
    const directory = path.join(root, capabilityId);
    let files = [];
    try { files = fs.readdirSync(directory).filter((name) => name.endsWith('.json')).sort(); } catch { continue; }
    const receipts = [];
    for (const name of files) {
      try {
        const document = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
        const result = verifyCapabilityOperationalReceipt({
          document,
          trustStore,
          capabilityId,
          targetBindings: bindings[capabilityId],
          releaseCommit,
        });
        if (result.status === 'capability_operational_receipt_verified') receipts.push(result.operationalReceiptHash);
      } catch { /* malformed external intake stays unverified */ }
    }
    if (receipts.length) verified.set(capabilityId, Object.freeze({ capabilityId, operationalReceiptHashes: [...new Set(receipts)].sort() }));
  }
  return verified;
}
