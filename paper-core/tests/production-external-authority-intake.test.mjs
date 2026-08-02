import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  buildAutonomousResearchAuthorIdentityConfiguration,
} from '../../paper-adapters/automation/autonomous-research-author-identity-configuration.mjs';
import {
  inspectResearchExecutionReleaseAttestorConfiguration,
} from '../../paper-adapters/build-package/research-execution-release-attestor.mjs';
import {
  buildPinnedExternalEvidenceEnvelope,
  pinnedExternalEvidenceSigningPayload,
} from '../../paper-adapters/authority/pinned-external-evidence-verifier.mjs';
import {
  buildExternalPrincipalIdentityAttestationSubject,
} from '../../paper-domain/evidence/external-principal-identity-attestation-contract.mjs';
import {
  composeProductionExternalAuthorityIntake,
} from '../../paper-composition/automation/production-external-authority-intake-composition.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const NOW = new Date('2026-07-29T04:00:00.000Z');
const AUTHOR_ROLE = 'external_principal_identity_attestor';
const H = (label) => hashRecord('ProductionExternalAuthorityIntakeTest', { label });

function writeFile(candidate, value, mode = 0o600) {
  fs.writeFileSync(candidate, value, { mode });
  fs.chmodSync(candidate, mode);
}

function authorConfiguration(root, {
  subjectAttestedAt = '2026-07-29T03:58:00.000Z',
  subjectExpiresAt = '2026-07-29T04:08:00.000Z',
  envelopeSignedAt = '2026-07-29T03:59:00.000Z',
  envelopeExpiresAt = '2026-07-29T04:05:00.000Z',
} = {}) {
  const pair = crypto.generateKeyPairSync('ed25519');
  const subject = buildExternalPrincipalIdentityAttestationSubject({
    serviceId: 'external-author-platform',
    principalId: 'external-author-principal',
    provider: 'openai',
    providerAccountIdentityHash: H('author-provider-account'),
    credentialRootIdentityHash: H('author-credential-root'),
    hostIdentityHash: H('author-host'),
    processIdentityHash: H('author-process'),
    trustDomainIdentityHash: H('author-trust-domain'),
    signerPublicKeySpkiHash: H('author-platform-signer'),
    challengeHash: H('author-challenge'),
    assuranceProfile: 'pinned-provider-account-and-platform-attestation-v1',
    attestedAt: subjectAttestedAt,
    expiresAt: subjectExpiresAt,
  });
  const unsigned = buildPinnedExternalEvidenceEnvelope({
    subjectKind: subject.kind,
    subjectHash: subject.externalPrincipalIdentityAttestationSubjectHash,
    signedAt: envelopeSignedAt,
    expiresAt: envelopeExpiresAt,
    signatures: [{
      keyId: 'external-author-authority-key',
      role: AUTHOR_ROLE,
      algorithm: 'ed25519',
      value: 'placeholder',
    }],
  });
  const signature = crypto.sign(
    null,
    pinnedExternalEvidenceSigningPayload(unsigned),
    pair.privateKey,
  ).toString('base64');
  const configuration = buildAutonomousResearchAuthorIdentityConfiguration({
    version: 2,
    subject,
    authorityEnvelope: buildPinnedExternalEvidenceEnvelope({
      ...unsigned,
      signatures: [{
        keyId: 'external-author-authority-key',
        role: AUTHOR_ROLE,
        algorithm: 'ed25519',
        value: signature,
      }],
    }),
    trustStore: {
      version: 1,
      kind: 'AuthorityTrustStore',
      keys: [{
        keyId: 'external-author-authority-key',
        subjectId: 'external-author-authority',
        organization: 'Independent Author Identity Authority',
        algorithm: 'ed25519',
        publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }),
        roles: [AUTHOR_ROLE],
        status: 'active',
        effectiveFrom: '2026-07-29T00:00:00.000Z',
        expiresAt: '2026-07-30T00:00:00.000Z',
        revokedAt: null,
      }],
    },
    signerKeyIds: ['external-author-authority-key'],
    maximumLifetimeMs: 10 * 60 * 1000,
  });
  const configPath = path.join(root, 'author.json');
  writeFile(configPath, `${JSON.stringify(configuration)}\n`);
  return { configPath, configuration };
}

function localReleaseConfiguration(root) {
  const pair = crypto.generateKeyPairSync('ed25519');
  const privateKeyPath = path.join(root, 'local-release-private.pem');
  const configPath = path.join(root, 'local-release.json');
  writeFile(
    privateKeyPath,
    pair.privateKey.export({ type: 'pkcs8', format: 'pem' }),
  );
  writeFile(configPath, `${JSON.stringify({
    version: 1,
    kind: 'ResearchExecutionReleaseAttestorConfiguration',
    keyId: 'local-release-key',
    keyVersion: 'local-v1',
    subjectId: 'local-release-attestor',
    organization: 'Local Release Office',
    algorithm: 'ed25519',
    role: 'research_execution_release_attestor',
    status: 'active',
    revoked: false,
    effectiveFrom: '2026-07-29T00:00:00.000Z',
    expiresAt: '2026-07-30T00:00:00.000Z',
    attestationLifetimeSeconds: 3600,
    privateKeyPath,
  })}\n`);
  return { configPath, privateKeyPath };
}

test('external authority intake validates real author evidence without invoking a signer', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-authority-intake-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const author = authorConfiguration(root);
  const release = localReleaseConfiguration(root);
  fs.rmSync(release.privateKeyPath);
  const guardedRelease = inspectResearchExecutionReleaseAttestorConfiguration({
    configPath: release.configPath,
    requiredConfigurationVersion: 3,
    requiredBackendKind: 'external-kms-command',
    activeVerification: false,
    now: NOW,
  });
  assert.deepEqual(guardedRelease.blockers, [
    'research_execution_release_attestor_external_kms_v3_configuration_required',
  ]);
  const candidate = composeProductionExternalAuthorityIntake({
    authorConfigPath: author.configPath,
    releaseAttestorConfigPath: release.configPath,
    environment: {},
    now: NOW,
  });
  assert.equal(candidate.author.cryptographicAuthorityReady, true);
  assert.equal(candidate.author.configurationPinned, false);
  assert.equal(
    candidate.author.observedConfigurationHash,
    author.configuration.configurationHash,
  );
  const inspection = composeProductionExternalAuthorityIntake({
    authorConfigPath: author.configPath,
    authorExpectedConfigurationHash: author.configuration.configurationHash,
    releaseAttestorConfigPath: release.configPath,
    environment: {},
    now: NOW,
  });
  assert.equal(inspection.author.readyForRuntimeBinding, true);
  assert.equal(inspection.releaseAttestor.configured, true);
  assert.equal(inspection.releaseAttestor.configurationPinned, false);
  assert.equal(inspection.releaseAttestor.backendKind, 'local-file');
  assert.equal(inspection.releaseAttestor.readyForLiveVerification, false);
  assert.ok(inspection.releaseAttestor.blockers.includes(
    'research_execution_release_attestor_external_kms_v3_configuration_required',
  ));
  assert.equal(inspection.readyForLiveVerification, false);
  assert.equal(inspection.fullProductionReady, false);
  assert.equal(inspection.externalActionPerformed, false);
  assert.equal(inspection.serviceStateChanged, false);
  assert.equal(JSON.stringify(inspection).includes('PRIVATE KEY'), false);
  assert.equal(JSON.stringify(inspection).includes(release.privateKeyPath), false);
});

test('external authority intake rejects an expired author subject even when its envelope is fresh', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-authority-subject-time-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const author = authorConfiguration(root, {
    subjectAttestedAt: '2026-07-29T03:40:00.000Z',
    subjectExpiresAt: '2026-07-29T03:50:00.000Z',
    envelopeSignedAt: '2026-07-29T03:59:00.000Z',
    envelopeExpiresAt: '2026-07-29T04:05:00.000Z',
  });
  const inspection = composeProductionExternalAuthorityIntake({
    authorConfigPath: author.configPath,
    authorExpectedConfigurationHash: author.configuration.configurationHash,
    releaseAttestorConfigPath: null,
    environment: {},
    now: NOW,
  });
  assert.equal(inspection.author.cryptographicAuthorityReady, true);
  assert.equal(inspection.author.readyForRuntimeBinding, false);
  assert.ok(inspection.author.blockers.includes(
    'autonomous_research_author_identity_subject_not_current',
  ));
  assert.equal(inspection.readyForLiveVerification, false);
  assert.equal(inspection.externalActionPerformed, false);
  assert.equal(inspection.serviceStateChanged, false);
});

test('external authority intake reports observed hashes while failing closed on bad pins', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-authority-pin-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const author = authorConfiguration(root);
  const inspection = composeProductionExternalAuthorityIntake({
    authorConfigPath: author.configPath,
    authorExpectedConfigurationHash: H('wrong-author-pin'),
    releaseAttestorConfigPath: null,
    environment: {},
    now: NOW,
  });
  assert.equal(inspection.author.configurationPinned, false);
  assert.equal(
    inspection.author.observedConfigurationHash,
    author.configuration.configurationHash,
  );
  assert.ok(inspection.author.blockers.includes(
    'autonomous_research_author_identity_configuration_pin_mismatch',
  ));
  assert.equal(inspection.ready, false);
  assert.equal(inspection.externalActionPerformed, false);
});

test('canonical authority intake command is read-only and uses exit 2 for missing inputs', () => {
  const environment = { ...process.env };
  for (const key of [
    'HEPTA_RESEARCH_AUTHOR_IDENTITY_CONFIG',
    'HEPTA_RESEARCH_AUTHOR_IDENTITY_CONFIG_HASH',
    'HEPTA_RESEARCH_EXECUTION_RELEASE_ATTESTOR_CONFIG',
    'HEPTA_RESEARCH_EXECUTION_RELEASE_ATTESTOR_CONFIG_HASH',
  ]) delete environment[key];
  const result = spawnSync(process.execPath, [
    'paper-core/bin/hepta-paper.mjs',
    'operator',
    'external-authority-intake',
    '--',
    '--require-ready',
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    env: environment,
  });
  assert.equal(result.status, 2, result.stderr);
  const inspection = JSON.parse(result.stdout);
  assert.equal(inspection.status, 'production_external_authority_inputs_required');
  assert.equal(inspection.externalActionPerformed, false);
  assert.equal(inspection.serviceStateChanged, false);
  assert.deepEqual(inspection.blockers, [
    'autonomous_research_author_identity_configuration_path_missing',
    'research_execution_release_attestor_config_path_missing',
  ]);
});
