import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { signAuthorityDocument } from '../../paper-adapters/authority/authority-signatures.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  capabilityConformanceReceiptHash,
  capabilityConformanceReplayEvidenceHash,
  capabilityConformanceReplayManifestHash,
  capabilityProductionSubject,
  capabilityVerificationCodeProvenance,
  capabilityVerificationCodeProvenanceHash,
  loadCapabilityConformanceProofs,
  resolveCurrentCapabilityProductionSubject,
  verifyCapabilityConformanceReceipt,
  verifyCapabilityConformanceReplayEvidence,
  verifyCapabilityOperationalReceipt,
} from '../operational-proof-intake.mjs';

function signer(keyId, subjectId, role, assurance = 'external_independent') {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  return {
    keyId,
    subjectId,
    role,
    assurance,
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    trustKey: {
      keyId,
      subjectId,
      assurance,
      roles: [role],
      publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
      status: 'active',
      algorithm: 'ed25519',
    },
  };
}

const targetBindings = [{ path: 'paper-domain/research/claim-registry.mjs', sha256: `sha256:${'1'.repeat(64)}` }];
const releaseCommit = 'a'.repeat(40);
const productionSourceHash = `sha256:${'2'.repeat(64)}`;
const productionSubject = {
  paperId: 'real-paper',
  sourceHash: productionSourceHash,
  sourcePath: 'submission/AoM/real-paper/main.tex',
};
const codeProvenance = capabilityVerificationCodeProvenance({
  version: 2,
  kind: 'CodeProvenance',
  packageVersion: '0.21.0',
  commit: releaseCommit,
  commitTree: 'b'.repeat(40),
  treeDirty: false,
  indexStateHash: `sha256:${'6'.repeat(64)}`,
  repositoryEntryCount: 2_000,
  repositoryContentHash: `sha256:${'7'.repeat(64)}`,
  worktreeStateHash: `sha256:${'8'.repeat(64)}`,
});
const common = {
  capabilityId: 'research.claim-registry',
  productionSubject,
  inputHashes: [productionSourceHash],
  executionReceiptHash: `sha256:${'3'.repeat(64)}`,
  resultHash: `sha256:${'4'.repeat(64)}`,
  replayReceiptHash: `sha256:${'5'.repeat(64)}`,
  replayMatched: true,
  releaseCommit,
  targetHashes: targetBindings,
};

function signedConformanceReceipt(owner, overrides = {}) {
  const unsigned = {
    version: 2,
    kind: 'CapabilityConformanceReceipt',
    ...common,
    status: 'production_source_bound_conformance_replay_verified',
    executionClass: 'production_source_bound_conformance',
    evidenceEnvironment: 'production_source_bound',
    evidenceClass: 'conformance',
    productionEligible: false,
    codeProvenance,
    codeProvenanceHash: capabilityVerificationCodeProvenanceHash(codeProvenance),
    externalActionPerformed: false,
    signatures: [],
    ...overrides,
  };
  const document = {
    ...unsigned,
    capabilityConformanceReceiptHash: capabilityConformanceReceiptHash(unsigned),
  };
  return signAuthorityDocument(document, {
    keyId: owner.keyId,
    role: owner.role,
    privateKeyPem: owner.privateKeyPem,
  });
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

test('production subject binds the current regular source file and rejects aliases', (t) => {
  const assetRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'capability-subject-'));
  t.after(() => fs.rmSync(assetRoot, { recursive: true, force: true }));
  const paperId = 'real-paper';
  const sourceFile = path.join(assetRoot, 'submission', 'AoM', paperId, 'main.tex');
  fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
  fs.writeFileSync(sourceFile, 'production source\n');
  const binding = resolveCurrentCapabilityProductionSubject({ assetRoot, paperId });
  assert.deepEqual(binding, {
    paperId,
    sourceHash: `sha256:${crypto.createHash('sha256').update('production source\n').digest('hex')}`,
    sourcePath: 'submission/AoM/real-paper/main.tex',
  });
  assert.throws(() => capabilityProductionSubject({
    ...binding,
    unboundAlias: true,
  }), /capability_production_subject_invalid/);

  const canonicalPaperId = 'A_Theory_of__Expectations';
  const canonicalSource = path.join(
    assetRoot,
    'submission',
    'AoM',
    canonicalPaperId,
    'main.tex',
  );
  fs.mkdirSync(path.dirname(canonicalSource), { recursive: true });
  fs.writeFileSync(canonicalSource, 'canonical production source\n');
  const priorPaperId = process.env.HEPTA_OPERATIONAL_REPLAY_PAPER_ID;
  process.env.HEPTA_OPERATIONAL_REPLAY_PAPER_ID = paperId;
  t.after(() => {
    if (priorPaperId === undefined) delete process.env.HEPTA_OPERATIONAL_REPLAY_PAPER_ID;
    else process.env.HEPTA_OPERATIONAL_REPLAY_PAPER_ID = priorPaperId;
  });
  assert.equal(resolveCurrentCapabilityProductionSubject({ assetRoot }).paperId, canonicalPaperId);

  fs.renameSync(sourceFile, `${sourceFile}.real`);
  fs.symlinkSync(`${sourceFile}.real`, sourceFile);
  assert.throws(() => resolveCurrentCapabilityProductionSubject({ assetRoot, paperId }),
    /capability_production_source_symlink_forbidden/);
});

test('production subject rejects a parent path swap between resolution and fd open', (t) => {
  const assetRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'capability-subject-race-'));
  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'capability-subject-outside-'));
  const paperId = 'real-paper';
  const paperDirectory = path.join(assetRoot, 'submission', 'AoM', paperId);
  const displacedDirectory = `${paperDirectory}-displaced`;
  const sourceFile = path.join(paperDirectory, 'main.tex');
  const outsideSource = path.join(outsideRoot, 'main.tex');
  fs.mkdirSync(paperDirectory, { recursive: true });
  fs.writeFileSync(sourceFile, 'expected production source\n');
  fs.writeFileSync(outsideSource, 'unexpected outside source\n');
  const originalOpenSync = fs.openSync;
  let swapped = false;
  fs.openSync = function openWithParentSwap(candidate, ...args) {
    if (!swapped && path.resolve(String(candidate)) === path.resolve(sourceFile)) {
      fs.renameSync(paperDirectory, displacedDirectory);
      fs.symlinkSync(outsideRoot, paperDirectory);
      swapped = true;
    }
    return originalOpenSync.call(fs, candidate, ...args);
  };
  t.after(() => {
    fs.openSync = originalOpenSync;
    try {
      if (fs.lstatSync(paperDirectory).isSymbolicLink()) fs.unlinkSync(paperDirectory);
    } catch {
      // Test cleanup is best-effort after the required assertion.
    }
    if (fs.existsSync(displacedDirectory) && !fs.existsSync(paperDirectory)) {
      fs.renameSync(displacedDirectory, paperDirectory);
    }
    fs.rmSync(assetRoot, { recursive: true, force: true });
    fs.rmSync(outsideRoot, { recursive: true, force: true });
  });
  assert.throws(() => resolveCurrentCapabilityProductionSubject({ assetRoot, paperId }),
    /capability_production_source_(?:not_regular|path_changed)/);
  assert.equal(swapped, true);
});

test('operational proof requires distinct externally independent owner and observer signatures', () => {
  const owner = signer('owner-key', 'external-owner', 'capability_owner');
  const observer = signer('observer-key', 'external-observer', 'operational_observer');
  let document = {
    version: 2,
    kind: 'CapabilityOperationalReceipt',
    ...common,
    status: 'production_runtime_observation_verified',
    executionClass: 'production_runtime_observation',
    evidenceEnvironment: 'production',
    evidenceClass: 'operational',
    productionEligible: true,
    signatures: [],
  };
  for (const authority of [owner, observer]) {
    document = signAuthorityDocument(document, {
      keyId: authority.keyId,
      role: authority.role,
      privateKeyPem: authority.privateKeyPem,
    });
  }
  const trustStore = { version: 1, kind: 'AuthorityTrustStore', keys: [owner.trustKey, observer.trustKey] };
  const verified = verifyCapabilityOperationalReceipt({ document, trustStore, capabilityId: common.capabilityId, targetBindings, releaseCommit });
  assert.equal(verified.status, 'capability_operational_receipt_verified');

  const localTrustStore = structuredClone(trustStore);
  localTrustStore.keys[0].assurance = 'local_admin_delegated';
  const blocked = verifyCapabilityOperationalReceipt({ document, trustStore: localTrustStore, capabilityId: common.capabilityId, targetBindings, releaseCommit });
  assert.equal(blocked.status, 'capability_operational_receipt_blocked');
  assert.ok(blocked.blockers.includes('operational_signer_assurance_not_external_independent'));
});

test('local-admin signed production-source replay is conformance, never operational', () => {
  const owner = signer('local-owner-key', 'local-owner', 'capability_owner', 'local_admin_delegated');
  const document = signedConformanceReceipt(owner);
  const trustStore = { version: 1, kind: 'AuthorityTrustStore', keys: [owner.trustKey] };
  const verified = verifyCapabilityConformanceReceipt({ document, trustStore, capabilityId: common.capabilityId, targetBindings, releaseCommit, codeProvenance, expectedProductionSubject: productionSubject });
  assert.equal(verified.status, 'capability_conformance_receipt_verified');
  assert.equal(verified.issuerAssurance, 'local_admin_delegated');
  const operational = verifyCapabilityOperationalReceipt({ document, trustStore, capabilityId: common.capabilityId, targetBindings, releaseCommit });
  assert.equal(operational.status, 'capability_operational_receipt_blocked');
});

test('rehashing and resigning cannot turn conformance into external-action evidence', () => {
  const owner = signer('local-owner-key', 'local-owner', 'capability_owner', 'local_admin_delegated');
  const trustStore = { version: 1, kind: 'AuthorityTrustStore', keys: [owner.trustKey] };
  const receipt = signedConformanceReceipt(owner, { externalActionPerformed: true });
  const receiptVerification = verifyCapabilityConformanceReceipt({
    document: receipt,
    trustStore,
    capabilityId: common.capabilityId,
    targetBindings,
    releaseCommit,
    codeProvenance,
    expectedProductionSubject: productionSubject,
  });
  assert.equal(receiptVerification.status, 'capability_conformance_receipt_blocked');
  assert.ok(receiptVerification.blockers.includes('conformance_receipt_external_action_invalid'));

  const result = { status: 'malicious_replay', externalActionPerformed: true };
  const resultHash = hashRecord('CapabilityOperationalResult', {
    capabilityId: common.capabilityId,
    result,
  });
  const replayReceiptHash = hashRecord('CapabilityOperationalReplayComparison', {
    version: 1,
    kind: 'CapabilityOperationalReplayComparison',
    capabilityId: common.capabilityId,
    firstResultHash: resultHash,
    secondResultHash: resultHash,
    replayMatched: true,
  });
  const evidencePayload = {
    version: 2,
    kind: 'CapabilityConformanceReplayEvidence',
    ...common,
    resultHash,
    replayReceiptHash,
    firstResult: result,
    secondResult: result,
    status: 'production_source_bound_conformance_replay_verified',
    executionClass: 'production_source_bound_conformance',
    evidenceEnvironment: 'production_source_bound',
    evidenceClass: 'conformance',
    productionEligible: true,
    codeProvenance,
    codeProvenanceHash: capabilityVerificationCodeProvenanceHash(codeProvenance),
    externalActionPerformed: false,
  };
  delete evidencePayload.executionReceiptHash;
  const evidence = {
    ...evidencePayload,
    executionReceiptHash: capabilityConformanceReplayEvidenceHash(evidencePayload),
  };
  const evidenceVerification = verifyCapabilityConformanceReplayEvidence({
    document: evidence,
    capabilityId: common.capabilityId,
    targetBindings,
    releaseCommit,
    codeProvenance,
    expectedProductionSubject: productionSubject,
  });
  assert.equal(evidenceVerification.status, 'capability_conformance_replay_evidence_blocked');
  assert.ok(evidenceVerification.blockers.includes('conformance_replay_must_not_be_production_eligible'));
  assert.ok(evidenceVerification.blockers.includes('conformance_replay_result_external_action_invalid'));
});

test('a valid owner signature cannot override stale provenance or a stale receipt self-hash', () => {
  const owner = signer('local-owner-key', 'local-owner', 'capability_owner', 'local_admin_delegated');
  const trustStore = { version: 1, kind: 'AuthorityTrustStore', keys: [owner.trustKey] };
  const staleProvenance = capabilityVerificationCodeProvenance({
    ...codeProvenance,
    repositoryContentHash: `sha256:${'9'.repeat(64)}`,
  });
  const stale = signedConformanceReceipt(owner, {
    codeProvenance: staleProvenance,
    codeProvenanceHash: capabilityVerificationCodeProvenanceHash(staleProvenance),
  });
  const staleVerification = verifyCapabilityConformanceReceipt({
    document: stale,
    trustStore,
    capabilityId: common.capabilityId,
    targetBindings,
    releaseCommit,
    codeProvenance,
    expectedProductionSubject: productionSubject,
  });
  assert.equal(staleVerification.status, 'capability_conformance_receipt_blocked');
  assert.ok(staleVerification.blockers.includes('conformance_code_provenance_not_current'));

  const valid = signedConformanceReceipt(owner);
  const { signatures: _signatures, ...validPayload } = valid;
  const rebound = signAuthorityDocument({
    ...validPayload,
    resultHash: `sha256:${'f'.repeat(64)}`,
    signatures: [],
  }, {
    keyId: owner.keyId,
    role: owner.role,
    privateKeyPem: owner.privateKeyPem,
  });
  const reboundVerification = verifyCapabilityConformanceReceipt({
    document: rebound,
    trustStore,
    capabilityId: common.capabilityId,
    targetBindings,
    releaseCommit,
    codeProvenance,
    expectedProductionSubject: productionSubject,
  });
  assert.equal(reboundVerification.status, 'capability_conformance_receipt_blocked');
  assert.ok(reboundVerification.blockers.includes('conformance_receipt_self_hash_mismatch'));
  assert.ok(!reboundVerification.blockers.includes('conformance_owner_signature_invalid'));
});

test('historic v1 conformance receipts remain auditable but never release-bound', () => {
  const owner = signer('historic-owner-key', 'historic-owner', 'capability_owner', 'local_admin_delegated');
  let document = {
    version: 1,
    kind: 'CapabilityConformanceReceipt',
    ...common,
    status: 'production_source_bound_conformance_replay_verified',
    executionClass: 'production_source_bound_conformance',
    evidenceEnvironment: 'production_source_bound',
    evidenceClass: 'conformance',
    productionEligible: false,
    signatures: [],
  };
  document = signAuthorityDocument(document, {
    keyId: owner.keyId,
    role: owner.role,
    privateKeyPem: owner.privateKeyPem,
  });
  const trustStore = { version: 1, kind: 'AuthorityTrustStore', keys: [owner.trustKey] };
  const verification = verifyCapabilityConformanceReceipt({
    document,
    trustStore,
    capabilityId: common.capabilityId,
    targetBindings,
    releaseCommit,
    codeProvenance,
    expectedProductionSubject: productionSubject,
  });
  assert.equal(verification.status, 'capability_conformance_receipt_audit_only');
  assert.equal(verification.releaseBound, false);
  assert.deepEqual(verification.blockers, ['conformance_receipt_historic_v1_audit_only']);
});

test('release-bound loader requires one current v2 manifest binding every receipt and evidence file', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capability-proof-loader-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtimeRoot = path.join(root, 'runtime');
  const workspaceRoot = path.join(root, 'workspace');
  const assetRoot = path.join(root, 'assets');
  const paperId = 'real-paper';
  const productionSourceFile = path.join(
    assetRoot,
    'submission',
    'AoM',
    paperId,
    'main.tex',
  );
  const productionSourceBytes = 'loader production source\n';
  fs.mkdirSync(path.dirname(productionSourceFile), { recursive: true });
  fs.writeFileSync(productionSourceFile, productionSourceBytes);
  const loaderProductionSubject = resolveCurrentCapabilityProductionSubject({
    assetRoot,
    paperId,
  });
  const loaderProductionSourceHash = loaderProductionSubject.sourceHash;
  const targetPath = 'target.mjs';
  const targetFile = path.join(workspaceRoot, targetPath);
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.writeFileSync(targetFile, 'export const capability = true;\n');
  const boundTargets = [{
    path: targetPath,
    sha256: `sha256:${crypto.createHash('sha256').update(fs.readFileSync(targetFile)).digest('hex')}`,
  }];
  const capabilityId = common.capabilityId;
  const owner = signer('manifest-owner-key', 'manifest-owner', 'capability_owner', 'local_admin_delegated');
  const trustStore = { version: 1, kind: 'AuthorityTrustStore', keys: [owner.trustKey] };
  const replayResult = { status: 'deterministic_result' };
  const resultHash = hashRecord('CapabilityOperationalResult', {
    capabilityId,
    result: replayResult,
  });
  const replayReceiptHash = hashRecord('CapabilityOperationalReplayComparison', {
    version: 1,
    kind: 'CapabilityOperationalReplayComparison',
    capabilityId,
    firstResultHash: resultHash,
    secondResultHash: resultHash,
    replayMatched: true,
  });
  const evidencePayload = {
    version: 2,
    kind: 'CapabilityConformanceReplayEvidence',
    ...common,
    productionSubject: loaderProductionSubject,
    inputHashes: [loaderProductionSourceHash],
    targetHashes: boundTargets,
    firstResult: replayResult,
    secondResult: replayResult,
    resultHash,
    replayReceiptHash,
    status: 'production_source_bound_conformance_replay_verified',
    executionClass: 'production_source_bound_conformance',
    evidenceEnvironment: 'production_source_bound',
    evidenceClass: 'conformance',
    productionEligible: false,
    codeProvenance,
    codeProvenanceHash: capabilityVerificationCodeProvenanceHash(codeProvenance),
    externalActionPerformed: false,
  };
  delete evidencePayload.executionReceiptHash;
  const evidence = {
    ...evidencePayload,
    executionReceiptHash: capabilityConformanceReplayEvidenceHash(evidencePayload),
  };
  const evidencePath = `conformance-proof/replays/${capabilityId}/${releaseCommit.slice(0, 12)}.json`;
  const unsignedReceipt = {
    version: 2,
    kind: 'CapabilityConformanceReceipt',
    ...common,
    productionSubject: loaderProductionSubject,
    inputHashes: [loaderProductionSourceHash],
    targetHashes: boundTargets,
    executionReceiptHash: evidence.executionReceiptHash,
    resultHash,
    replayReceiptHash,
    status: 'production_source_bound_conformance_replay_verified',
    executionClass: 'production_source_bound_conformance',
    evidenceEnvironment: 'production_source_bound',
    evidenceClass: 'conformance',
    productionEligible: false,
    codeProvenance,
    codeProvenanceHash: capabilityVerificationCodeProvenanceHash(codeProvenance),
    executionEvidencePath: evidencePath,
    externalActionPerformed: false,
    signatures: [],
  };
  let receipt = {
    ...unsignedReceipt,
    capabilityConformanceReceiptHash: capabilityConformanceReceiptHash(unsignedReceipt),
  };
  receipt = signAuthorityDocument(receipt, {
    keyId: owner.keyId,
    role: owner.role,
    privateKeyPem: owner.privateKeyPem,
  });
  const receiptPath = `conformance-proof/capabilities/${capabilityId}/${releaseCommit.slice(0, 12)}.json`;
  const verified = [{
    capabilityId,
    resultHash: receipt.resultHash,
    executionReceiptHash: receipt.executionReceiptHash,
    replayReceiptHash: receipt.replayReceiptHash,
    conformanceReceiptHash: receipt.capabilityConformanceReceiptHash,
    receiptPath,
    evidencePath,
  }];
  const manifestPayload = {
    version: 2,
    kind: 'CapabilityConformanceReplayManifest',
    status: 'all_capabilities_conformance_replayed',
    releaseCommit,
    codeProvenance,
    codeProvenanceHash: capabilityVerificationCodeProvenanceHash(codeProvenance),
    paperId,
    productionSourceHash: loaderProductionSourceHash,
    productionSubject: loaderProductionSubject,
    inputHashes: [loaderProductionSourceHash],
    capabilityCount: 1,
    issuerAssurance: 'local_admin_delegated',
    productionEligible: false,
    verified,
    externalActionPerformed: false,
  };
  const manifest = {
    ...manifestPayload,
    capabilityConformanceReplayManifestHash:
      capabilityConformanceReplayManifestHash(manifestPayload),
  };
  writeJson(path.join(runtimeRoot, 'owner-acceptance', 'OWNER_TRUST_STORE.json'), trustStore);
  writeJson(path.join(runtimeRoot, ...evidencePath.split('/')), evidence);
  writeJson(path.join(runtimeRoot, ...receiptPath.split('/')), receipt);
  const manifestFile = path.join(
    runtimeRoot,
    'conformance-proof',
    `CAPABILITY_CONFORMANCE_REPLAY_MANIFEST_${releaseCommit.slice(0, 12)}.json`,
  );
  writeJson(manifestFile, manifest);
  const options = {
    runtimeRoot,
    workspaceRoot,
    capabilityCatalog: { [capabilityId]: { target: targetPath } },
    releaseCommit,
    codeProvenance,
    assetRoot,
    paperId,
  };
  assert.equal(loadCapabilityConformanceProofs(options).size, 1);

  const originalOpenForSourceRace = fs.openSync;
  let sourceChangedDuringLoad = false;
  fs.openSync = function openWithSourceMutation(candidate, ...args) {
    if (!sourceChangedDuringLoad
      && path.resolve(String(candidate)) === path.resolve(manifestFile)) {
      fs.writeFileSync(productionSourceFile, 'changed during proof load\n');
      sourceChangedDuringLoad = true;
    }
    return originalOpenForSourceRace.call(fs, candidate, ...args);
  };
  try {
    assert.equal(loadCapabilityConformanceProofs(options).size, 0);
    assert.equal(sourceChangedDuringLoad, true);
  } finally {
    fs.openSync = originalOpenForSourceRace;
    fs.writeFileSync(productionSourceFile, productionSourceBytes);
  }

  const proofRoot = path.join(runtimeRoot, 'conformance-proof');
  const displacedProofRoot = path.join(runtimeRoot, 'conformance-proof-displaced');
  const outsideProofRoot = path.join(root, 'conformance-proof-outside-runtime');
  fs.cpSync(proofRoot, outsideProofRoot, { recursive: true });
  const originalOpenSync = fs.openSync;
  let proofRootSwapped = false;
  fs.openSync = function openWithProofParentSwap(candidate, ...args) {
    if (!proofRootSwapped && path.resolve(String(candidate)) === path.resolve(manifestFile)) {
      fs.renameSync(proofRoot, displacedProofRoot);
      fs.symlinkSync(outsideProofRoot, proofRoot);
      proofRootSwapped = true;
    }
    return originalOpenSync.call(fs, candidate, ...args);
  };
  try {
    assert.equal(loadCapabilityConformanceProofs(options).size, 0);
    assert.equal(proofRootSwapped, true);
  } finally {
    fs.openSync = originalOpenSync;
    if (fs.lstatSync(proofRoot).isSymbolicLink()) fs.unlinkSync(proofRoot);
    fs.renameSync(displacedProofRoot, proofRoot);
  }

  fs.renameSync(proofRoot, displacedProofRoot);
  fs.symlinkSync(displacedProofRoot, proofRoot);
  assert.equal(loadCapabilityConformanceProofs(options).size, 0);
  fs.unlinkSync(proofRoot);
  fs.renameSync(displacedProofRoot, proofRoot);

  const reboundManifestPayload = {
    ...manifest,
    productionSourceHash: `sha256:${'0'.repeat(64)}`,
  };
  delete reboundManifestPayload.capabilityConformanceReplayManifestHash;
  writeJson(manifestFile, {
    ...reboundManifestPayload,
    capabilityConformanceReplayManifestHash:
      capabilityConformanceReplayManifestHash(reboundManifestPayload),
  });
  assert.equal(loadCapabilityConformanceProofs(options).size, 0);

  const alternateSourceHash = `sha256:${'0'.repeat(64)}`;
  const alternateSubject = { ...loaderProductionSubject, sourceHash: alternateSourceHash };
  const fullyReboundEvidencePayload = {
    ...evidence,
    productionSubject: alternateSubject,
    inputHashes: [alternateSourceHash],
  };
  delete fullyReboundEvidencePayload.executionReceiptHash;
  const fullyReboundEvidence = {
    ...fullyReboundEvidencePayload,
    executionReceiptHash: capabilityConformanceReplayEvidenceHash(fullyReboundEvidencePayload),
  };
  const fullyReboundUnsignedReceipt = {
    ...receipt,
    productionSubject: alternateSubject,
    inputHashes: [alternateSourceHash],
    executionReceiptHash: fullyReboundEvidence.executionReceiptHash,
    signatures: [],
  };
  delete fullyReboundUnsignedReceipt.capabilityConformanceReceiptHash;
  let fullyReboundReceipt = {
    ...fullyReboundUnsignedReceipt,
    capabilityConformanceReceiptHash:
      capabilityConformanceReceiptHash(fullyReboundUnsignedReceipt),
  };
  fullyReboundReceipt = signAuthorityDocument(fullyReboundReceipt, {
    keyId: owner.keyId,
    role: owner.role,
    privateKeyPem: owner.privateKeyPem,
  });
  const fullyReboundManifestPayload = {
    ...manifest,
    paperId: alternateSubject.paperId,
    productionSourceHash: alternateSourceHash,
    productionSubject: alternateSubject,
    inputHashes: [alternateSourceHash],
    verified: [{
      ...verified[0],
      executionReceiptHash: fullyReboundEvidence.executionReceiptHash,
      conformanceReceiptHash: fullyReboundReceipt.capabilityConformanceReceiptHash,
    }],
  };
  delete fullyReboundManifestPayload.capabilityConformanceReplayManifestHash;
  const fullyReboundManifest = {
    ...fullyReboundManifestPayload,
    capabilityConformanceReplayManifestHash:
      capabilityConformanceReplayManifestHash(fullyReboundManifestPayload),
  };
  writeJson(path.join(runtimeRoot, ...evidencePath.split('/')), fullyReboundEvidence);
  writeJson(path.join(runtimeRoot, ...receiptPath.split('/')), fullyReboundReceipt);
  writeJson(manifestFile, fullyReboundManifest);
  assert.equal(loadCapabilityConformanceProofs(options).size, 0);
});
