import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  signAuthorityDocument,
  verifyAuthoritySignatures,
} from '../../paper-adapters/authority/authority-signatures.mjs';
import {
  executePortalTargetQualificationRegistryImport,
  inspectPortalTargetQualificationRegistry,
  planPortalTargetQualificationRegistryImport,
  preflightPortalTargetQualificationRegistry,
} from '../../paper-adapters/submission/portal-target-qualification-registry-repository.mjs';
import {
  applyInspectedPortalTargetQualifications,
} from '../../paper-composition/submission/portal-target-qualification-composition.mjs';
import {
  PORTAL_TARGET_QUALIFICATION_AUTHORITY_ROLES,
  PORTAL_TARGET_QUALIFICATION_EVIDENCE_POLICIES,
  buildPortalTargetQualification,
  buildPortalTargetQualificationEvidenceAttestation,
  buildPortalTargetQualificationRegistry,
  buildPortalTargetQualificationSubjectHash,
  verifyPortalTargetQualificationRegistryStructure,
} from '../../paper-domain/submission/portal-target-qualification-contract.mjs';
import {
  JOURNAL_SUBMISSION_CONNECTOR_COVERAGE,
} from '../../paper-domain/submission/journal-connector-coverage.mjs';
import {
  runPortalTargetQualificationCli,
} from '../bin/portal-target-qualification.mjs';
import {
  inspectPortalTargetQualificationPreflightContinuity,
} from '../../paper-domain/submission/portal-target-qualification-preflight-continuity.mjs';
import {
  getJournalSubmissionTargetProfile,
} from '../../paper-domain/submission/journal-submission-target-registry.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';

const NOW = new Date('2026-08-08T01:15:00.000Z');
const ISSUED_AT = '2026-08-08T01:00:00.000Z';
const REGISTRY_EXPIRES_AT = '2026-08-08T01:30:00.000Z';
const EVIDENCE_OBSERVED_AT = '2026-08-08T00:45:00.000Z';
const EVIDENCE_EXPIRES_AT = '2026-08-08T01:45:00.000Z';

function authority(role, suffix, keyPair = crypto.generateKeyPairSync('ed25519')) {
  const { privateKey, publicKey } = keyPair;
  return Object.freeze({
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    trustKey: Object.freeze({
      keyId: `portal-${suffix}`,
      subjectId: `principal:${suffix}`,
      organization: `organization:${suffix}`,
      algorithm: 'ed25519',
      status: 'active',
      roles: Object.freeze([role]),
      publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
    }),
  });
}

function sha(label) {
  return hashRecord('PortalTargetQualificationTestValue', { label });
}

function qualificationFixture({
  sharedKeyPair = null,
  signEvidence = true,
  issuerOverrides = {},
} = {}) {
  const owner = authority(
    PORTAL_TARGET_QUALIFICATION_AUTHORITY_ROLES.owner,
    'owner',
    sharedKeyPair || undefined,
  );
  const observer = authority(
    PORTAL_TARGET_QUALIFICATION_AUTHORITY_ROLES.observer,
    'observer',
    sharedKeyPair || undefined,
  );
  const authorizer = authority(
    PORTAL_TARGET_QUALIFICATION_AUTHORITY_ROLES.productionAuthorizer,
    'authorizer',
    sharedKeyPair || undefined,
  );
  const issuers = {
    discovery: owner.trustKey.subjectId,
    sandboxCanary: observer.trustKey.subjectId,
    portalIdentity: observer.trustKey.subjectId,
    dispatcherChallenge: observer.trustKey.subjectId,
    cycleRecovery: observer.trustKey.subjectId,
    productionAuthorization: authorizer.trustKey.subjectId,
    ...issuerOverrides,
  };
  const target = getJournalSubmissionTargetProfile('tmlr');
  const targetBinding = {
    venueId: target.venueId,
    venueKind: target.venueKind,
    baseTargetProfileHash: target.journalSubmissionTargetProfileHash,
    targetInstanceId: 'TMLR',
    edition: null,
    track: null,
    connectorFamily: 'openreview-api-v2',
    portalOriginHash: sha('origin'),
    submissionRouteHash: sha('route'),
    schemaFingerprintHash: sha('schema'),
    authenticationProfileHash: sha('authentication'),
    automationPolicyEvidenceHash: sha('automation-policy'),
    statusMappingHash: sha('status-mapping'),
    portalConfigurationHash: sha('portal-configuration'),
    portalDescriptorHash: sha('portal-descriptor'),
  };
  const subjectHash = buildPortalTargetQualificationSubjectHash(targetBinding);
  const signers = { owner, observer, authorizer };
  const evidence = Object.fromEntries(
    Object.keys(issuers).map((evidenceType) => {
      const policy = PORTAL_TARGET_QUALIFICATION_EVIDENCE_POLICIES[evidenceType];
      const signer = evidenceType === 'discovery'
        ? signers.owner
        : evidenceType === 'productionAuthorization'
          ? signers.authorizer
          : signers.observer;
      let attestation = buildPortalTargetQualificationEvidenceAttestation({
        evidenceType,
        issuerPrincipalId: issuers[evidenceType],
        subjectHash,
        artifactKind: policy.artifactKind,
        artifactHash: sha(`artifact:${evidenceType}`),
        verificationReceiptKind: policy.verificationReceiptKind,
        verificationReceiptHash: sha(`verification-receipt:${evidenceType}`),
        verificationPolicyHash: sha(`verification-policy:${evidenceType}`),
        verifierRole: policy.authorityRole,
        evidenceEnvironment: policy.evidenceEnvironment,
        observedAt: EVIDENCE_OBSERVED_AT,
        expiresAt: EVIDENCE_EXPIRES_AT,
        authorizationScope: policy.authorizationScope,
      });
      if (signEvidence) {
        attestation = signAuthorityDocument(attestation, {
          privateKeyPem: signer.privateKeyPem,
          keyId: signer.trustKey.keyId,
          role: signer.trustKey.roles[0],
        });
      }
      return [evidenceType, attestation];
    }),
  );
  const entry = buildPortalTargetQualification({
    ...targetBinding,
    qualificationLevel: 'production',
    qualifiedAt: '2026-08-08T00:50:00.000Z',
    expiresAt: EVIDENCE_EXPIRES_AT,
    evidence,
  });
  let registry = buildPortalTargetQualificationRegistry({
    generation: 1,
    issuedAt: ISSUED_AT,
    expiresAt: REGISTRY_EXPIRES_AT,
    entries: [entry],
    signatures: [],
  });
  for (const signer of [owner, observer, authorizer]) {
    registry = signAuthorityDocument(registry, {
      privateKeyPem: signer.privateKeyPem,
      keyId: signer.trustKey.keyId,
      role: signer.trustKey.roles[0],
    });
  }
  return Object.freeze({
    entry,
    authorities: Object.freeze({ owner, observer, authorizer }),
    registry,
    subjectHash,
    targetBinding,
    trustStore: Object.freeze({
      version: 1,
      kind: 'AuthorityTrustStore',
      keys: Object.freeze([
        owner.trustKey,
        observer.trustKey,
        authorizer.trustKey,
      ]),
    }),
  });
}

function writeSecureJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
  return hashBytes(fs.readFileSync(filePath));
}

function inspectFixture(t, fixture, { pinRegistry = true } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-portal-inspection-'));
  t.after(() => fs.rmSync(directory, { force: true, recursive: true }));
  const registryPath = path.join(directory, 'active.json');
  const trustStorePath = path.join(directory, 'trust-store.json');
  writeSecureJson(registryPath, fixture.registry);
  const expectedTrustStoreHash = writeSecureJson(trustStorePath, fixture.trustStore);
  return inspectPortalTargetQualificationRegistry({
    registryPath,
    trustStorePath,
    expectedTrustStoreHash,
    expectedRegistryHash: pinRegistry
      ? fixture.registry.portalTargetQualificationRegistryHash : null,
    now: NOW,
  });
}

test('portal qualification CLI stays read-only and fails closed across every action', () => {
  const help = runPortalTargetQualificationCli({ argv: ['--help'], environment: {} });
  assert.equal(help.kind, 'PortalTargetQualificationUsage');

  const status = runPortalTargetQualificationCli({
    argv: ['--action', 'status', '--require-ready'],
    environment: {},
    now: NOW,
  });
  assert.equal(status.exitCode, 2);
  assert.equal(status.report.ready, false);

  const expectedSubjectHash = `sha256:${'a'.repeat(64)}`;
  const preflight = runPortalTargetQualificationCli({
    argv: [
      '--action', 'preflight',
      '--target', 'openreview',
      '--expected-subject-hash', `openreview=${expectedSubjectHash}`,
      '--require-ready',
    ],
    environment: {},
    now: NOW,
  });
  assert.equal(preflight.exitCode, 2);
  assert.equal(preflight.report.ready, false);

  assert.throws(
    () => runPortalTargetQualificationCli({
      argv: ['--action', 'import-plan'],
      environment: {},
      now: NOW,
    }),
    /portal_target_qualification_candidate_pin_required/,
  );
  assert.throws(
    () => runPortalTargetQualificationCli({
      argv: [
        '--action', 'import-execute', '--execute',
        '--plan-hash', expectedSubjectHash,
      ],
      environment: {},
      now: NOW,
    }),
    /portal_target_qualification_candidate_pin_required/,
  );
  assert.throws(
    () => runPortalTargetQualificationCli({
      argv: ['--action', 'unknown'],
      environment: {},
      now: NOW,
    }),
    /portal_target_qualification_action_invalid/,
  );
  assert.throws(
    () => runPortalTargetQualificationCli({
      argv: [
        '--action', 'preflight', '--target', 'openreview',
        '--expected-route-hash', `tmlr=${expectedSubjectHash}`,
      ],
      environment: {},
      now: NOW,
    }),
    /portal_target_qualification_preflight_binding_argument_invalid/,
  );
});

test('signed production qualification remains unable to authorize live commit', () => {
  const { registry } = qualificationFixture();
  assert.equal(verifyPortalTargetQualificationRegistryStructure(registry), true);
  assert.equal(registry.entries.length, 1);
  assert.equal(registry.entries[0].productionQualified, true);
  assert.equal(registry.entries[0].liveCommitAuthorized, false);
  assert.equal(registry.entries[0].liveCommitPermitHash, null);
  assert.equal(registry.liveCommitAuthorizationIncluded, false);
  assert.equal(registry.humanSingleUseAuthorizationRequired, true);
});

test('redacted preflight reports a missing external registry without producing evidence', () => {
  const report = preflightPortalTargetQualificationRegistry({
    targetVenueIds: ['tmlr'],
    now: NOW,
  });
  assert.equal(report.ready, false);
  assert.equal(report.targets.length, 1);
  assert.equal(report.targets[0].liveCommitAuthorized, false);
  assert.equal(report.targets[0].evidence.filter((item) => item.required).length, 6);
  assert.ok(report.blockers.some(({ errorCode }) => (
    errorCode === 'portal_target_qualification_preflight_registry_missing'
  )));
  assert.deepEqual(
    report.blockers.filter(({ errorCode }) => (
      errorCode === 'portal_target_qualification_preflight_evidence_missing'
    )).map(({ evidenceType }) => evidenceType).sort(),
    Object.keys(PORTAL_TARGET_QUALIFICATION_EVIDENCE_POLICIES).sort(),
  );
  assert.deepEqual(report.safety, {
    readOnly: true,
    mutationPerformed: false,
    registryProduced: false,
    evidenceProduced: false,
    networkActionPerformed: false,
    credentialUsed: false,
    portalLoginPerformed: false,
    uploadPerformed: false,
    signatureProduced: false,
    authorizationProduced: false,
    liveCommitAuthorized: false,
    liveCommitPermitProduced: false,
    liveCommitPermitConsumed: false,
  });
  assert.equal(JSON.stringify(report).includes(process.cwd()), false);

  const unbounded = preflightPortalTargetQualificationRegistry({
    targetVenueIds: ['tmlr', 'iclr', 'jmlr'],
    now: NOW,
  });
  assert.equal(unbounded.targets.length, 0);
  assert.ok(unbounded.blockers.some(({ errorCode }) => (
    errorCode === 'portal_target_qualification_preflight_target_count_invalid'
  )));
});

test('pinned preflight recognizes a valid target but redacts authority material', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-portal-preflight-'));
  t.after(() => fs.rmSync(directory, { force: true, recursive: true }));
  const fixture = qualificationFixture();
  const registryPath = path.join(directory, 'registry.json');
  const trustStorePath = path.join(directory, 'trust.json');
  writeSecureJson(registryPath, fixture.registry);
  const trustStoreHash = writeSecureJson(trustStorePath, fixture.trustStore);
  const options = {
    targetVenueIds: ['tmlr'],
    registryPath,
    expectedRegistryHash: fixture.registry.portalTargetQualificationRegistryHash,
    trustStorePath,
    expectedTrustStoreHash: trustStoreHash,
    now: NOW,
  };
  const report = preflightPortalTargetQualificationRegistry(options);
  assert.equal(report.ready, true, JSON.stringify(report.blockers));
  assert.equal(report.targets[0].productionQualified, true);
  assert.equal(report.targets[0].liveCommitAuthorized, false);
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes(directory), false);
  assert.equal(serialized.includes('principal:'), false);
  assert.equal(serialized.includes('BEGIN PUBLIC KEY'), false);
  assert.equal(serialized.includes('"signatures"'), false);

  const mismatched = preflightPortalTargetQualificationRegistry({
    ...options,
    expectedTargetBindings: {
      tmlr: {
        portalTargetSubjectHash: sha('wrong-subject'),
        submissionRouteHash: sha('wrong-route'),
        schemaFingerprintHash: sha('wrong-schema'),
      },
    },
  });
  assert.deepEqual(
    [...new Set(mismatched.blockers.map(({ errorCode }) => errorCode))]
      .filter((code) => /_(subject|route|schema)_mismatch$/u.test(code)).sort(),
    [
      'portal_target_qualification_preflight_route_mismatch',
      'portal_target_qualification_preflight_schema_mismatch',
      'portal_target_qualification_preflight_subject_mismatch',
    ],
  );
  const pinDrift = preflightPortalTargetQualificationRegistry({
    ...options,
    expectedRegistryHash: sha('wrong-registry'),
  });
  assert.ok(pinDrift.blockers.some(({ errorCode }) => (
    errorCode === 'portal_target_qualification_preflight_registry_pin_drift'
  )));
});

test('successor preflight preserves subject, route, and schema across a revoked replacement', () => {
  const priorQualificationHash = sha('prior-qualification');
  const priorRegistryHash = sha('prior-registry');
  const findings = inspectPortalTargetQualificationPreflightContinuity({
    currentRegistry: {
      generation: 1,
      issuedAt: '2026-08-08T01:00:00.000Z',
      portalTargetQualificationRegistryHash: priorRegistryHash,
      entries: [{
        venueId: 'tmlr',
        portalTargetQualificationHash: priorQualificationHash,
        portalTargetSubjectHash: sha('prior-subject'),
        submissionRouteHash: sha('prior-route'),
        schemaFingerprintHash: sha('prior-schema'),
      }],
    },
    candidateRegistry: {
      generation: 2,
      issuedAt: '2026-08-08T01:20:00.000Z',
      predecessorRegistryHash: priorRegistryHash,
      revokedQualificationHashes: [priorQualificationHash],
      entries: [{
        venueId: 'tmlr',
        portalTargetQualificationHash: sha('replacement-qualification'),
        portalTargetSubjectHash: sha('replacement-subject'),
        submissionRouteHash: sha('replacement-route'),
        schemaFingerprintHash: sha('replacement-schema'),
      }],
    },
  });
  assert.deepEqual(findings.map(({ errorCode }) => errorCode).sort(), [
    'portal_target_qualification_preflight_route_mismatch',
    'portal_target_qualification_preflight_schema_mismatch',
    'portal_target_qualification_preflight_subject_mismatch',
  ]);
});

test('candidate preflight verifies active authority and never reports candidate as active qualification', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-portal-candidate-preflight-'));
  t.after(() => fs.rmSync(directory, { force: true, recursive: true }));
  const fixture = qualificationFixture();
  let candidate = buildPortalTargetQualificationRegistry({
    generation: 2,
    issuedAt: '2026-08-08T01:10:00.000Z',
    expiresAt: '2026-08-08T01:25:00.000Z',
    entries: [fixture.entry],
    predecessorRegistryHash: fixture.registry.portalTargetQualificationRegistryHash,
    revokedQualificationHashes: [],
    signatures: [],
  });
  for (const signer of Object.values(fixture.authorities)) {
    candidate = signAuthorityDocument(candidate, {
      privateKeyPem: signer.privateKeyPem,
      keyId: signer.trustKey.keyId,
      role: signer.trustKey.roles[0],
    });
  }
  const registryPath = path.join(directory, 'active.json');
  const candidatePath = path.join(directory, 'candidate.json');
  const trustStorePath = path.join(directory, 'trust.json');
  writeSecureJson(registryPath, fixture.registry);
  const expectedCandidateFileHash = writeSecureJson(candidatePath, candidate);
  const expectedTrustStoreHash = writeSecureJson(trustStorePath, fixture.trustStore);
  const options = {
    targetVenueIds: ['tmlr'],
    registryPath,
    expectedRegistryHash: fixture.registry.portalTargetQualificationRegistryHash,
    candidatePath,
    expectedCandidateFileHash,
    trustStorePath,
    expectedTrustStoreHash,
    now: new Date('2026-08-08T01:12:00.000Z'),
  };
  const valid = preflightPortalTargetQualificationRegistry(options);
  assert.equal(valid.ready, true, JSON.stringify(valid.blockers));
  assert.equal(valid.targets[0].sandboxQualified, false);
  assert.equal(valid.targets[0].productionQualified, false);
  assert.equal(valid.targets[0].candidateSandboxQualificationVerified, true);
  assert.equal(valid.targets[0].candidateProductionQualificationVerified, true);

  fs.unlinkSync(registryPath);
  const missingCurrent = preflightPortalTargetQualificationRegistry(options);
  assert.equal(missingCurrent.ready, false);
  assert.ok(missingCurrent.blockers.some(({ errorCode }) => (
    errorCode === 'portal_target_qualification_preflight_current_registry_invalid'
  )));
  assert.ok(missingCurrent.blockers.some(({ errorCode }) => (
    errorCode === 'portal_target_qualification_preflight_registry_pin_drift'
  )));
  fs.symlinkSync('missing-active-registry.json', registryPath);
  const danglingCurrent = preflightPortalTargetQualificationRegistry(options);
  assert.equal(danglingCurrent.ready, false);
  assert.ok(danglingCurrent.blockers.some(({ errorCode }) => (
    errorCode === 'portal_target_qualification_preflight_current_registry_invalid'
  )));
  fs.unlinkSync(registryPath);
  writeSecureJson(registryPath, fixture.registry);

  const mismatchedSelection = preflightPortalTargetQualificationRegistry({
    ...options,
    targetVenueIds: ['iclr'],
  });
  assert.equal(mismatchedSelection.ready, false);
  assert.ok(mismatchedSelection.blockers.some(({ errorCode, targetVenueId }) => (
    errorCode === 'portal_target_qualification_preflight_candidate_target_set_mismatch'
      && targetVenueId === null
  )));

  const invalidCurrent = {
    ...fixture.registry,
    signatures: fixture.registry.signatures.map((signature, index) => (
      index === 0 ? { ...signature, value: 'invalid-signature' } : signature
    )),
  };
  assert.equal(verifyPortalTargetQualificationRegistryStructure(invalidCurrent), true);
  writeSecureJson(registryPath, invalidCurrent);
  const blocked = preflightPortalTargetQualificationRegistry(options);
  assert.equal(blocked.ready, false);
  assert.ok(blocked.blockers.some(({ errorCode }) => (
    errorCode === 'portal_target_qualification_preflight_signature_verification_failed'
  )));
});

test('SPKI alias defense preserves the historical verified-signature wire shape', () => {
  const { registry, trustStore } = qualificationFixture();
  const verification = verifyAuthoritySignatures({
    document: registry,
    trustStore,
    requiredRoles: Object.values(PORTAL_TARGET_QUALIFICATION_AUTHORITY_ROLES),
    minSignatures: 3,
    requireDistinctSubjects: true,
  });
  assert.equal(verification.status, 'authority_signatures_verified');
  for (const signature of verification.verifiedSignatures) {
    assert.deepEqual(Object.keys(signature).sort(), [
      'cryptographicallyVerified',
      'keyId',
      'organization',
      'role',
      'subjectId',
    ]);
    assert.match(signature.publicKeySpkiSha256, /^sha256:[0-9a-f]{64}$/u);
    assert.equal(Object.getOwnPropertyDescriptor(
      signature,
      'publicKeySpkiSha256',
    ).enumerable, false);
  }
  const serialized = JSON.parse(JSON.stringify(verification));
  assert.equal(serialized.verifiedSignatures.some(
    (signature) => Object.hasOwn(signature, 'publicKeySpkiSha256'),
  ), false);
});

test('pinned signed registry import is planned, atomically written, and reverified', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-portal-qualification-'));
  try {
    const { registry, trustStore } = qualificationFixture();
    const candidatePath = path.join(directory, 'candidate.json');
    const trustStorePath = path.join(directory, 'trust-store.json');
    const registryPath = path.join(directory, 'active.json');
    const expectedCandidateFileHash = writeSecureJson(candidatePath, registry);
    const expectedTrustStoreHash = writeSecureJson(trustStorePath, trustStore);
    const options = {
      registryPath,
      candidatePath,
      expectedCandidateFileHash,
      trustStorePath,
      expectedTrustStoreHash,
      now: NOW,
    };
    const plan = planPortalTargetQualificationRegistryImport(options);
    assert.equal(plan.safety.mutationPerformed, false);
    assert.equal(fs.existsSync(registryPath), false);
    assert.throws(
      () => executePortalTargetQualificationRegistryImport({
        ...options,
        expectedPlanHash: sha('wrong-plan'),
      }),
      /portal_target_qualification_plan_hash_mismatch/,
    );
    const receipt = executePortalTargetQualificationRegistryImport({
      ...options,
      expectedPlanHash: plan.planHash,
    });
    assert.equal(receipt.status, 'portal_target_qualification_registry_imported');
    assert.equal(receipt.liveCommitPermitProduced, false);
    assert.equal(receipt.liveCommitPermitConsumed, false);
    assert.equal(fs.statSync(registryPath).mode & 0o777, 0o600);
    const inspection = inspectPortalTargetQualificationRegistry({
      registryPath,
      trustStorePath,
      expectedTrustStoreHash,
      expectedRegistryHash: registry.portalTargetQualificationRegistryHash,
      now: NOW,
    });
    assert.equal(inspection.ready, true, inspection.blockers.join(','));
    assert.equal(inspection.productionQualifiedTargetCount, 1);
    assert.equal(inspection.liveCommitAuthorizedTargetCount, 0);
  } finally {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

test('only an opaque pinned verified inspection may promote coverage', (t) => {
  const fixture = qualificationFixture();
  assert.throws(() => applyInspectedPortalTargetQualifications(
    JOURNAL_SUBMISSION_CONNECTOR_COVERAGE,
    fixture.registry,
    { now: NOW },
  ), /portal_target_qualification_verified_inspection_required/);
  const unpinned = inspectFixture(t, fixture, { pinRegistry: false });
  assert.equal(unpinned.ready, false);
  assert.equal(unpinned.semanticPinVerified, false);
  assert.ok(unpinned.blockers.includes(
    'portal_target_qualification_registry_semantic_pin_required',
  ));
  assert.throws(() => applyInspectedPortalTargetQualifications(
    JOURNAL_SUBMISSION_CONNECTOR_COVERAGE,
    unpinned,
    { now: NOW },
  ), /portal_target_qualification_verified_inspection_required/);
  const inspection = inspectFixture(t, fixture);
  const coverage = applyInspectedPortalTargetQualifications(
    JOURNAL_SUBMISSION_CONNECTOR_COVERAGE,
    inspection,
    { now: NOW },
  );
  const tmlr = coverage.entries.find((entry) => entry.venueId === 'tmlr');
  assert.equal(tmlr.targetProfileResolved, true);
  assert.equal(tmlr.sandboxQualified, true);
  assert.equal(tmlr.productionQualified, true);
  assert.equal(tmlr.liveCommitAuthorized, false);
  assert.equal(tmlr.liveSubmissionReady, false);
  assert.deepEqual(tmlr.blockers, [
    'final_commit_human_review_and_single_use_permit_required',
  ]);
});

test('registry freshness and non-fixture evidence fail closed', () => {
  const { registry, trustStore } = qualificationFixture();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-portal-expiry-'));
  try {
    const registryPath = path.join(directory, 'active.json');
    const trustStorePath = path.join(directory, 'trust-store.json');
    writeSecureJson(registryPath, registry);
    const expectedTrustStoreHash = writeSecureJson(trustStorePath, trustStore);
    const expired = inspectPortalTargetQualificationRegistry({
      registryPath,
      trustStorePath,
      expectedTrustStoreHash,
      now: new Date(REGISTRY_EXPIRES_AT),
    });
    assert.equal(expired.ready, false);
    assert.ok(expired.blockers.includes('portal_target_qualification_registry_expired'));
    const preflight = preflightPortalTargetQualificationRegistry({
      targetVenueIds: ['tmlr'],
      registryPath,
      expectedRegistryHash: registry.portalTargetQualificationRegistryHash,
      trustStorePath,
      expectedTrustStoreHash,
      now: new Date(REGISTRY_EXPIRES_AT),
    });
    assert.ok(preflight.blockers.some(({ errorCode }) => (
      errorCode === 'portal_target_qualification_preflight_registry_expired'
    )));
  } finally {
    fs.rmSync(directory, { force: true, recursive: true });
  }
  const policy = PORTAL_TARGET_QUALIFICATION_EVIDENCE_POLICIES.sandboxCanary;
  assert.throws(() => buildPortalTargetQualificationEvidenceAttestation({
    evidenceType: 'sandboxCanary',
    issuerPrincipalId: 'principal:observer',
    subjectHash: sha('subject'),
    artifactKind: policy.artifactKind,
    artifactHash: sha('evidence'),
    verificationReceiptKind: policy.verificationReceiptKind,
    verificationReceiptHash: sha('receipt'),
    verificationPolicyHash: sha('policy'),
    verifierRole: policy.authorityRole,
    evidenceEnvironment: 'sandbox',
    observedAt: ISSUED_AT,
    expiresAt: EVIDENCE_EXPIRES_AT,
    fixtureEvidence: true,
  }), /portal_target_qualification_evidence_policy_invalid/);
});

test('every evidence attestation is bound to the exact canonical target subject', () => {
  const { entry, targetBinding } = qualificationFixture();
  const mismatchedEvidence = {
    ...entry.evidence,
    sandboxCanary: {
      ...entry.evidence.sandboxCanary,
      subjectHash: sha('different-target'),
    },
  };
  assert.throws(() => buildPortalTargetQualification({
    ...targetBinding,
    qualificationLevel: 'production',
    qualifiedAt: entry.qualifiedAt,
    expiresAt: entry.expiresAt,
    evidence: mismatchedEvidence,
  }), /portal_target_qualification_evidence_subject_mismatch:sandboxCanary/);
});

test('registry and every typed evidence attestation require cryptographic authority', (t) => {
  const valid = qualificationFixture();
  const unsignedRegistry = buildPortalTargetQualificationRegistry({
    ...valid.registry,
    signatures: [],
  });
  const registryInspection = inspectFixture(t, {
    ...valid,
    registry: unsignedRegistry,
  });
  assert.equal(registryInspection.ready, false);
  assert.ok(registryInspection.blockers.some((blocker) => (
    blocker.includes('authority_signatures_missing')
  )));

  const unsignedEvidence = qualificationFixture({ signEvidence: false });
  const evidenceInspection = inspectFixture(t, unsignedEvidence);
  assert.equal(evidenceInspection.ready, false);
  assert.ok(evidenceInspection.blockers.some((blocker) => (
    blocker.includes('portal_target_evidence_signature_set_not_minimal')
  )));
});

test('authority aliases sharing one Ed25519 SPKI cannot satisfy independence', (t) => {
  const sharedKeyPair = crypto.generateKeyPairSync('ed25519');
  const fixture = qualificationFixture({ sharedKeyPair });
  const inspection = inspectFixture(t, fixture);
  assert.equal(inspection.ready, false);
  assert.ok(inspection.blockers.includes(
    'portal_target_qualification_authority_spki_not_independent',
  ));

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-portal-spki-lint-'));
  t.after(() => fs.rmSync(directory, { force: true, recursive: true }));
  const registryPath = path.join(directory, 'registry.json');
  const trustStorePath = path.join(directory, 'trust.json');
  writeSecureJson(registryPath, fixture.registry);
  const trustStoreHash = writeSecureJson(trustStorePath, fixture.trustStore);
  const preflight = preflightPortalTargetQualificationRegistry({
    targetVenueIds: ['tmlr'],
    registryPath,
    expectedRegistryHash: fixture.registry.portalTargetQualificationRegistryHash,
    trustStorePath,
    expectedTrustStoreHash: trustStoreHash,
    now: NOW,
  });
  assert.ok(preflight.blockers.some(({ errorCode }) => (
    errorCode === 'portal_target_qualification_preflight_issuer_spki_not_independent'
  )));
});

test('redacted preflight types issuer-role mismatch without exposing principals', (t) => {
  const valid = qualificationFixture();
  const fixture = qualificationFixture({
    issuerOverrides: {
      sandboxCanary: valid.authorities.owner.trustKey.subjectId,
    },
  });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-portal-role-lint-'));
  t.after(() => fs.rmSync(directory, { force: true, recursive: true }));
  const registryPath = path.join(directory, 'registry.json');
  const trustStorePath = path.join(directory, 'trust.json');
  writeSecureJson(registryPath, fixture.registry);
  const trustStoreHash = writeSecureJson(trustStorePath, fixture.trustStore);
  const report = preflightPortalTargetQualificationRegistry({
    targetVenueIds: ['tmlr'],
    registryPath,
    expectedRegistryHash: fixture.registry.portalTargetQualificationRegistryHash,
    trustStorePath,
    expectedTrustStoreHash: trustStoreHash,
    now: NOW,
  });
  assert.ok(report.blockers.some(({ errorCode, evidenceType }) => (
    errorCode === 'portal_target_qualification_preflight_issuer_role_mismatch'
      && evidenceType === 'sandboxCanary'
  )));
  assert.equal(JSON.stringify(report).includes('principal:'), false);
});

test('duplicate trust key identifiers cannot split verification from SPKI identity', (t) => {
  const fixture = qualificationFixture();
  const keys = fixture.trustStore.keys.flatMap((trustedKey) => {
    const dummy = authority(trustedKey.roles[0], `dummy-${trustedKey.keyId}`).trustKey;
    return [{
      ...dummy,
      keyId: trustedKey.keyId,
      subjectId: trustedKey.subjectId,
      organization: trustedKey.organization,
    }, trustedKey];
  });
  const inspection = inspectFixture(t, {
    ...fixture,
    trustStore: {
      ...fixture.trustStore,
      keys,
    },
  });
  assert.equal(inspection.ready, false);
  for (const trustedKey of fixture.trustStore.keys) {
    assert.ok(inspection.blockers.includes(
      `${trustedKey.keyId}:duplicate_trust_key_id`,
    ));
  }
});

test('mislabeled non-Ed25519 public keys cannot satisfy authority policy', (t) => {
  const keyPairs = [
    crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }),
    crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }),
    crypto.generateKeyPairSync('ed448'),
  ];
  for (const keyPair of keyPairs) {
    const inspection = inspectFixture(t, qualificationFixture({
      sharedKeyPair: keyPair,
    }));
    assert.equal(inspection.ready, false);
    assert.ok(inspection.blockers.some((blocker) => (
      blocker.includes('trusted_key_type_not_ed25519')
    )));
  }
});

test('typed evidence policies reject wrong kinds and overlong per-type lifetimes', () => {
  const policy = PORTAL_TARGET_QUALIFICATION_EVIDENCE_POLICIES.productionAuthorization;
  const base = {
    evidenceType: 'productionAuthorization',
    issuerPrincipalId: 'principal:authorizer',
    subjectHash: sha('subject'),
    artifactKind: policy.artifactKind,
    artifactHash: sha('artifact'),
    verificationReceiptKind: policy.verificationReceiptKind,
    verificationReceiptHash: sha('receipt'),
    verificationPolicyHash: sha('policy'),
    verifierRole: policy.authorityRole,
    evidenceEnvironment: policy.evidenceEnvironment,
    observedAt: '2026-08-08T00:00:00.000Z',
    expiresAt: '2026-08-08T00:30:00.000Z',
    authorizationScope: policy.authorizationScope,
  };
  assert.throws(() => buildPortalTargetQualificationEvidenceAttestation({
    ...base,
    artifactKind: 'ArbitraryHashReference',
  }), /portal_target_qualification_evidence_policy_invalid/);
  assert.throws(() => buildPortalTargetQualificationEvidenceAttestation({
    ...base,
    expiresAt: '2026-08-08T01:00:00.001Z',
  }), /portal_target_qualification_evidence_policy_invalid/);
  const sandboxPolicy = PORTAL_TARGET_QUALIFICATION_EVIDENCE_POLICIES.sandboxCanary;
  assert.throws(() => buildPortalTargetQualificationEvidenceAttestation({
    ...base,
    evidenceType: 'sandboxCanary',
    artifactKind: sandboxPolicy.artifactKind,
    verificationReceiptKind: sandboxPolicy.verificationReceiptKind,
    verifierRole: sandboxPolicy.authorityRole,
    evidenceEnvironment: sandboxPolicy.evidenceEnvironment,
    authorizationScope: sandboxPolicy.authorizationScope,
    externalActionPerformed: true,
  }), /portal_target_qualification_evidence_policy_invalid/);
});

test('OpenReview target identity is compatible with invitation routing', () => {
  const { targetBinding } = qualificationFixture();
  assert.equal(targetBinding.targetInstanceId, 'TMLR');
  assert.equal('TMLR/-/Submission'.startsWith(
    `${targetBinding.targetInstanceId}/-/`,
  ), true);
  assert.throws(() => buildPortalTargetQualificationSubjectHash({
    ...targetBinding,
    targetInstanceId: 'tmlr:openreview:current',
  }), /portal_target_qualification_target_binding_invalid/);
});

test('a signed successor can revoke a qualification but cannot silently remove it', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-portal-revoke-'));
  t.after(() => fs.rmSync(directory, { force: true, recursive: true }));
  const fixture = qualificationFixture();
  const { owner, observer } = fixture.authorities;
  function successor(revokedQualificationHashes, generation = 2) {
    let registry = buildPortalTargetQualificationRegistry({
      generation,
      issuedAt: '2026-08-08T01:20:00.000Z',
      expiresAt: '2026-08-08T01:35:00.000Z',
      entries: [],
      predecessorRegistryHash:
        fixture.registry.portalTargetQualificationRegistryHash,
      revokedQualificationHashes,
      signatures: [],
    });
    for (const signer of [owner, observer]) {
      registry = signAuthorityDocument(registry, {
        privateKeyPem: signer.privateKeyPem,
        keyId: signer.trustKey.keyId,
        role: signer.trustKey.roles[0],
      });
    }
    return registry;
  }
  const registryPath = path.join(directory, 'active.json');
  const candidatePath = path.join(directory, 'candidate.json');
  const trustStorePath = path.join(directory, 'trust-store.json');
  writeSecureJson(registryPath, fixture.registry);
  const expectedTrustStoreHash = writeSecureJson(trustStorePath, fixture.trustStore);
  const silentlyRemoved = successor([]);
  let expectedCandidateFileHash = writeSecureJson(candidatePath, silentlyRemoved);
  const revocationLint = preflightPortalTargetQualificationRegistry({
    targetVenueIds: ['tmlr'],
    registryPath,
    candidatePath,
    expectedCandidateFileHash,
    trustStorePath,
    expectedTrustStoreHash,
    now: new Date('2026-08-08T01:25:00.000Z'),
  });
  assert.ok(revocationLint.blockers.some(({ errorCode }) => (
    errorCode === 'portal_target_qualification_preflight_revocation_drift'
  )));
  assert.throws(() => planPortalTargetQualificationRegistryImport({
    registryPath,
    candidatePath,
    expectedCandidateFileHash,
    trustStorePath,
    expectedTrustStoreHash,
    now: new Date('2026-08-08T01:25:00.000Z'),
  }), /portal_target_qualification_revocation_required:tmlr/);

  const skippedGeneration = successor([
    fixture.entry.portalTargetQualificationHash,
  ], 3);
  expectedCandidateFileHash = writeSecureJson(candidatePath, skippedGeneration);
  const generationLint = preflightPortalTargetQualificationRegistry({
    targetVenueIds: ['tmlr'],
    registryPath,
    candidatePath,
    expectedCandidateFileHash,
    trustStorePath,
    expectedTrustStoreHash,
    now: new Date('2026-08-08T01:25:00.000Z'),
  });
  assert.ok(generationLint.blockers.some(({ errorCode }) => (
    errorCode === 'portal_target_qualification_preflight_generation_drift'
  )));

  const revoked = successor([fixture.entry.portalTargetQualificationHash]);
  expectedCandidateFileHash = writeSecureJson(candidatePath, revoked);
  const options = {
    registryPath,
    candidatePath,
    expectedCandidateFileHash,
    trustStorePath,
    expectedTrustStoreHash,
    now: new Date('2026-08-08T01:25:00.000Z'),
  };
  const plan = planPortalTargetQualificationRegistryImport(options);
  const receipt = executePortalTargetQualificationRegistryImport({
    ...options,
    expectedPlanHash: plan.planHash,
  });
  assert.equal(receipt.inspection.ready, true);
  assert.equal(receipt.inspection.productionQualifiedTargetCount, 0);
  assert.deepEqual(
    receipt.inspection.registry.revokedQualificationHashes,
    [fixture.entry.portalTargetQualificationHash],
  );
});
