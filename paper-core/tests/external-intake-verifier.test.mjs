import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { capabilityTargetBindings } from '../../paper-adapters/governance/capability-proof-verifier.mjs';
import { LEGACY_OWNER_ACCEPTANCE_FAMILY_MANIFEST } from '../../paper-adapters/governance/legacy-owner-acceptance-contract.mjs';
import { signAuthorityDocument } from '../src/authority-signatures.mjs';
import { validatePublicTrustStore, verifyExternalIntake } from '../../paper-adapters/governance/external-intake-verifier.mjs';
import { CAPABILITY_CATALOG } from '../../paper-domain/governance/capability-catalog.mjs';
import { currentCodeProvenance } from '../src/code-provenance.mjs';

const workspaceRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');

function fixtureAuthority(keyId, subjectId, roles) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  return {
    keyId,
    subjectId,
    roles,
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicRecord: {
      keyId,
      subjectId,
      roles,
      publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
      status: 'active',
      algorithm: 'ed25519',
    },
  };
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

test('external intake verifier is read-only and fails closed for an empty staging area', (t) => {
  const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-external-intake-'));
  t.after(() => fs.rmSync(stagingRoot, { recursive: true, force: true }));
  const before = fs.readdirSync(stagingRoot);
  const result = verifyExternalIntake({
    stagingRoot,
    workspaceRoot,
    runtimeRoot: path.join(stagingRoot, 'runtime'),
    releaseCommit: 'test-release',
  });
  assert.equal(result.status, 'external_evidence_intake_blocked');
  assert.equal(result.ownerAccepted, 0);
  assert.equal(result.externallyOwnerAccepted, 0);
  assert.equal(result.operationallyProven, 0);
  assert.equal(result.installAuthorized, false);
  assert.deepEqual(fs.readdirSync(stagingRoot), before);
});

test('public trust validation rejects private material and missing role separation', () => {
  const result = validatePublicTrustStore({
    trustStore: {
      version: 1,
      kind: 'AuthorityTrustStore',
      keys: [{ keyId: 'bad', subjectId: 'same', algorithm: 'ed25519', publicKeyPem: 'PRIVATE KEY', privateKeyPem: 'forbidden', roles: ['academic_evidence_authority'], status: 'active' }],
    },
    requiredRoles: ['academic_evidence_authority', 'independent_referee'],
    requireDistinctSubjects: true,
  });
  assert.equal(result.status, 'public_trust_store_blocked');
  assert.ok(result.blockers.some((item) => item.startsWith('private_key_material_forbidden')));
  assert.ok(result.blockers.includes('trust_store_role_missing:independent_referee'));
});

test('external intake preflight requires external owner assurance and never authorizes installation', (t) => {
  const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-external-intake-complete-'));
  const runtimeRoot = path.join(stagingRoot, 'runtime');
  t.after(() => fs.rmSync(stagingRoot, { recursive: true, force: true }));
  const paperId = 'A_Theory_of__Expectations';
  const releaseCommit = currentCodeProvenance().commit;
  const authorities = [
    fixtureAuthority('academic-key', 'academic-subject', ['academic_evidence_authority']),
    fixtureAuthority('referee-key', 'referee-subject', ['independent_referee']),
    fixtureAuthority('operator-key', 'operator-subject', ['submission_operator']),
    fixtureAuthority('executor-key', 'executor-subject', ['live_executor_authorizer']),
  ];
  const owner = fixtureAuthority('owner-key', 'owner-subject', ['capability_owner']);
  const observer = fixtureAuthority('observer-key', 'observer-subject', ['operational_observer']);
  owner.publicRecord.assurance = 'external_independent';
  observer.publicRecord.assurance = 'external_independent';
  writeJson(path.join(stagingRoot, 'AUTHORITY_TRUST_STORE.json'), {
    version: 1,
    kind: 'AuthorityTrustStore',
    keys: authorities.map((item) => item.publicRecord),
  });
  const ownerTrustStore = { version: 1, kind: 'AuthorityTrustStore', keys: [owner.publicRecord, observer.publicRecord] };
  writeJson(path.join(stagingRoot, 'OWNER_TRUST_STORE.json'), ownerTrustStore);

  let ownerAcceptance = {
    version: 2,
    kind: 'CapabilityOwnerAcceptance',
    familyManifestHash: LEGACY_OWNER_ACCEPTANCE_FAMILY_MANIFEST.familyManifestHash,
    acceptedAt: '2026-07-11T00:00:00.000Z',
    acceptedFamilies: LEGACY_OWNER_ACCEPTANCE_FAMILY_MANIFEST.families.map((family) => ({
      familyId: family.familyId,
      familyHash: family.familyHash,
      businessDecision: family.businessDecision,
    })),
    signatures: [],
  };
  ownerAcceptance = signAuthorityDocument(ownerAcceptance, {
    privateKeyPem: owner.privateKeyPem,
    keyId: owner.keyId,
    role: 'capability_owner',
  });
  writeJson(path.join(stagingRoot, 'CAPABILITY_OWNER_ACCEPTANCE.json'), ownerAcceptance);

  const bindings = capabilityTargetBindings(workspaceRoot, CAPABILITY_CATALOG);
  for (const capabilityId of Object.keys(CAPABILITY_CATALOG)) {
    let receipt = {
      version: 2,
      kind: 'CapabilityOperationalReceipt',
      capabilityId,
      status: 'production_runtime_observation_verified',
      executionClass: 'production_runtime_observation',
      evidenceEnvironment: 'production',
      evidenceClass: 'operational',
      productionEligible: true,
      productionSubject: { paperId },
      inputHashes: [`sha256:${'1'.repeat(64)}`],
      executionReceiptHash: `sha256:${'2'.repeat(64)}`,
      resultHash: `sha256:${'3'.repeat(64)}`,
      replayReceiptHash: `sha256:${'4'.repeat(64)}`,
      replayMatched: true,
      releaseCommit,
      targetHashes: bindings[capabilityId],
      signatures: [],
    };
    receipt = signAuthorityDocument(receipt, {
      privateKeyPem: owner.privateKeyPem,
      keyId: owner.keyId,
      role: 'capability_owner',
    });
    receipt = signAuthorityDocument(receipt, {
      privateKeyPem: observer.privateKeyPem,
      keyId: observer.keyId,
      role: 'operational_observer',
    });
    writeJson(path.join(stagingRoot, 'operational-proof', 'capabilities', capabilityId, 'fixture.json'), receipt);
  }

  const authorityDocuments = [
    ['ACADEMIC_EVIDENCE_ATTESTATION.json', { version: 2, kind: 'AcademicEvidenceAttestation', paperId }, authorities[0]],
    ['INDEPENDENT_REFEREE_VERDICT.json', { version: 1, kind: 'IndependentRefereeVerdict', paperId }, authorities[1]],
  ];
  for (const [name, envelope, authority] of authorityDocuments) {
    const document = signAuthorityDocument({ ...envelope, signatures: [] }, {
      privateKeyPem: authority.privateKeyPem,
      keyId: authority.keyId,
      role: authority.roles[0],
    });
    writeJson(path.join(stagingRoot, 'authority-inbox', paperId, name), document);
  }
  let authorization = { version: 1, kind: 'LiveSubmissionAuthorization', paperId, signatures: [] };
  for (const authority of authorities.slice(2)) {
    authorization = signAuthorityDocument(authorization, {
      privateKeyPem: authority.privateKeyPem,
      keyId: authority.keyId,
      role: authority.roles[0],
    });
  }
  writeJson(path.join(stagingRoot, 'authority-inbox', paperId, 'LIVE_SUBMISSION_AUTHORIZATION.json'), authorization);

  const result = verifyExternalIntake({ stagingRoot, workspaceRoot, runtimeRoot, releaseCommit, paperId });
  assert.equal(result.status, 'external_evidence_intake_preflight_verified');
  assert.equal(result.ownerAccepted, 249);
  assert.equal(result.externallyOwnerAccepted, 249);
  assert.equal(result.ownerAcceptanceFamilyManifestBound, true);
  assert.equal(result.operationallyProven, 14);
  assert.equal(result.authorityDocuments.every((item) => item.envelopeVerified), true);
  assert.equal(result.installAuthorized, false);
  assert.equal(result.semanticValidationDeferredToProductionPipeline, true);

  const cli = spawnSync(process.execPath, [
    'paper-core/bin/verify-external-intake.mjs',
    '--staging', stagingRoot,
  ], {
    cwd: workspaceRoot,
    encoding: 'utf8',
    env: { ...process.env, HEPTA_PAPER_RUNTIME_ROOT: runtimeRoot },
  });
  assert.equal(cli.status, 0, cli.stderr);
  const cliResult = JSON.parse(cli.stdout);
  assert.equal(cliResult.status, 'external_evidence_intake_preflight_verified');
  assert.equal(cliResult.installAuthorized, false);
  assert.equal(fs.existsSync(runtimeRoot), false);

  const delegatedOwner = fixtureAuthority(
    'delegated-owner-key',
    'delegated-owner-subject',
    ['capability_owner'],
  );
  delegatedOwner.publicRecord.assurance = 'local_admin_delegated';
  writeJson(path.join(stagingRoot, 'OWNER_TRUST_STORE.json'), {
    version: 1,
    kind: 'AuthorityTrustStore',
    keys: [owner.publicRecord, observer.publicRecord, delegatedOwner.publicRecord],
  });
  const delegatedAcceptance = signAuthorityDocument({
    ...ownerAcceptance,
    signatures: [],
  }, {
    privateKeyPem: delegatedOwner.privateKeyPem,
    keyId: delegatedOwner.keyId,
    role: 'capability_owner',
  });
  writeJson(
    path.join(stagingRoot, 'CAPABILITY_OWNER_ACCEPTANCE.json'),
    delegatedAcceptance,
  );

  const delegated = verifyExternalIntake({
    stagingRoot,
    workspaceRoot,
    runtimeRoot,
    releaseCommit,
    paperId,
  });
  assert.equal(delegated.status, 'external_evidence_intake_blocked');
  assert.equal(delegated.ownerAccepted, 249);
  assert.equal(delegated.externallyOwnerAccepted, 0);
  assert.equal(delegated.operationallyProven, 14);
  assert.ok(delegated.blockers.includes('external_owner_acceptance_incomplete:0/249'));
  assert.equal(delegated.installAuthorized, false);

  const delegatedCli = spawnSync(process.execPath, [
    'paper-core/bin/verify-external-intake.mjs',
    '--staging', stagingRoot,
  ], {
    cwd: workspaceRoot,
    encoding: 'utf8',
    env: { ...process.env, HEPTA_PAPER_RUNTIME_ROOT: runtimeRoot },
  });
  assert.equal(delegatedCli.status, 1, delegatedCli.stderr);
  assert.equal(JSON.parse(delegatedCli.stdout).status, 'external_evidence_intake_blocked');
  assert.equal(fs.existsSync(runtimeRoot), false);

  let bogusLegacyAcceptance = {
    version: 1,
    kind: 'CapabilityOwnerAcceptance',
    acceptedEntries: Array.from({ length: 249 }, (_, index) => ({
      legacyMatrixEntryId: `bogus-${index}`,
    })),
    signatures: [],
  };
  bogusLegacyAcceptance = signAuthorityDocument(bogusLegacyAcceptance, {
    privateKeyPem: owner.privateKeyPem,
    keyId: owner.keyId,
    role: 'capability_owner',
  });
  writeJson(
    path.join(stagingRoot, 'CAPABILITY_OWNER_ACCEPTANCE.json'),
    bogusLegacyAcceptance,
  );
  const bogusLegacy = verifyExternalIntake({
    stagingRoot,
    workspaceRoot,
    runtimeRoot,
    releaseCommit,
    paperId,
  });
  assert.equal(bogusLegacy.status, 'external_evidence_intake_blocked');
  assert.equal(bogusLegacy.ownerAccepted, 249);
  assert.equal(bogusLegacy.externallyOwnerAccepted, 0);
  assert.equal(bogusLegacy.ownerAcceptanceFamilyManifestBound, false);
  assert.ok(bogusLegacy.blockers.includes('owner_acceptance_v2_family_manifest_required'));
  assert.equal(bogusLegacy.installAuthorized, false);
  assert.equal(fs.existsSync(runtimeRoot), false);
});
