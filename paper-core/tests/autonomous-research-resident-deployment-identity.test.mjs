import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildAutonomousResearchPublicDeploymentComponentInspection,
  inspectExternalResearchQualificationPublicDeploymentIdentity,
  inspectResearchExecutionReleaseAttestorPublicDeploymentIdentity,
  inspectRuntimeImageReproducibilityPublicDeploymentIdentity,
} from '../../paper-adapters/automation/autonomous-research-public-deployment-identity-readers.mjs';
import {
  inspectAutonomousResearchResidentDeploymentIdentity,
} from '../../paper-composition/automation/autonomous-research-resident-deployment-identity.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const H = (label) => hashRecord('ResidentPublicDeploymentIdentityTestHash', { label });

function write(candidate, contents, mode = 0o600) {
  fs.writeFileSync(candidate, contents, { mode });
  fs.chmodSync(candidate, mode);
}

function executable(root, name, marker) {
  const candidate = path.join(root, name);
  write(candidate, `#!/usr/bin/env node\n// ${marker}\n`, 0o755);
  return candidate;
}

function signer(root, label, role, overrides = {}) {
  const pair = crypto.generateKeyPairSync('ed25519');
  const publicKeyPath = path.join(root, `${label}.public.pem`);
  write(publicKeyPath, pair.publicKey.export({ type: 'spki', format: 'pem' }), 0o644);
  return Object.freeze({
    keyId: `${label}-key`,
    keyVersion: 'v1',
    subjectId: `${label}-subject`,
    organization: `${label} organization`,
    role,
    algorithm: 'ed25519',
    status: 'active',
    effectiveFrom: '2026-07-01T00:00:00.000Z',
    expiresAt: '2027-07-01T00:00:00.000Z',
    revokedAt: null,
    publicKeyPath,
    ...overrides,
  });
}

function fixtureRoot(t, label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function externalQualificationFixture(t) {
  const root = fixtureRoot(t, 'hepta-public-external-qualification');
  const qualifierExecutable = executable(root, 'qualifier.mjs', 'qualifier');
  const verifierExecutable = executable(root, 'verifier.mjs', 'verifier');
  const qualifierCredentialRoot = path.join(root, 'qualifier-credentials-not-readable');
  const verifierCredentialRoot = path.join(root, 'verifier-credentials-not-readable');
  const privateArgumentPath = path.join(root, 'verifier-private-key-not-readable.pem');
  const trustedSigner = signer(
    root,
    'qualification-attestor',
    'research_execution_release_attestor',
  );
  const verifierAttestor = signer(
    root,
    'independent-verifier',
    'external_qualification_independent_verifier',
  );
  const configuration = {
    version: 3,
    kind: 'ExternalResearchQualificationProcessConfiguration',
    status: 'active',
    maximumQualificationCostUsd: 2,
    qualificationCostAuthority: 'operator_declared_worst_case_usd',
    qualifier: {
      serviceId: 'qualification-service',
      principalId: 'qualification-principal',
      protocol: 'external-qualification-json-stdio-v1',
      executable: qualifierExecutable,
      credentialRoot: qualifierCredentialRoot,
      args: [],
      environmentAllowlist: ['QUALIFICATION_SERVICE_TOKEN'],
      timeoutMs: 10_000,
    },
    verifier: {
      serviceId: 'verification-service',
      principalId: 'verification-principal',
      protocol: 'external-qualification-json-stdio-v1',
      executable: verifierExecutable,
      credentialRoot: verifierCredentialRoot,
      args: [],
      environmentAllowlist: ['VERIFICATION_SERVICE_TOKEN'],
      timeoutMs: 10_000,
    },
    trustedSignerTrustSet: {
      version: 1,
      kind: 'ResearchExecutionReleaseAttestorTrustSet',
      keys: [trustedSigner],
    },
    verifierAttestor,
  };
  const configPath = path.join(root, 'external-qualification.json');
  write(configPath, `${JSON.stringify(configuration, null, 2)}\n`);
  return {
    root,
    configPath,
    configuration,
    qualifierExecutable,
    qualifierCredentialRoot,
    verifierCredentialRoot,
    privateArgumentPath,
  };
}

function runtimeReproducibilityFixture(t) {
  const root = fixtureRoot(t, 'hepta-public-runtime-reproducibility');
  const verifiers = [1, 2].map((ordinal) => ({
    command: {
      serviceId: `runtime-service-${ordinal}`,
      principalId: `runtime-principal-${ordinal}`,
      protocol: 'runtime-image-reproducibility-json-stdio-v1',
      executable: executable(root, `runtime-${ordinal}.mjs`, `runtime-${ordinal}`),
      args: [],
      credentialRoot: path.join(root, `runtime-credential-${ordinal}-not-readable`),
      environmentAllowlist: [`RUNTIME_SERVICE_${ordinal}_TOKEN`],
      timeoutMs: 60_000,
      backend: {
        backendId: `buildkit-backend-${ordinal}`,
        workerId: `buildkit-worker-${ordinal}`,
        buildkitVersion: `v0.1${ordinal}.0`,
        platform: 'linux/amd64',
        endpointTlsSpkiHash: H(`endpoint:${ordinal}`),
        stateRootIdentityHash: H(`state-root:${ordinal}`),
      },
    },
    attestor: signer(
      root,
      `runtime-attestor-${ordinal}`,
      'runtime_image_reproducibility_external_verifier',
    ),
  }));
  const configuration = {
    version: 1,
    kind: 'RuntimeImageReproducibilityProcessConfiguration',
    status: 'active',
    platform: 'linux/amd64',
    sourceDateEpoch: 1733097600,
    buildArgs: {},
    maximumReceiptAgeMs: 24 * 60 * 60 * 1000,
    maximumVerificationCostUsd: 5,
    verificationCostAuthority: 'operator_declared_worst_case_usd',
    verifiers,
  };
  const configPath = path.join(root, 'runtime-reproducibility.json');
  write(configPath, `${JSON.stringify(configuration, null, 2)}\n`);
  return { root, configPath, configuration };
}

function releaseAttestorFixture(t) {
  const root = fixtureRoot(t, 'hepta-public-release-attestor');
  const active = signer(
    root,
    'release-active',
    'research_execution_release_attestor',
  );
  const probe = signer(
    root,
    'release-probe',
    'research_execution_release_signer_backend_probe_attestor',
  );
  const configuration = {
    version: 2,
    kind: 'ResearchExecutionReleaseAttestorConfiguration',
    status: 'active',
    attestationLifetimeSeconds: 24 * 60 * 60,
    trustSet: {
      version: 1,
      kind: 'ResearchExecutionReleaseAttestorTrustSet',
      keys: [active],
    },
    backend: {
      kind: 'external-kms-command',
      backendId: 'release-kms-production',
      backendVersion: 'hsm-v7',
      algorithm: 'ed25519',
      hardwareProtected: true,
      privateKeyExportable: false,
      externalSignerProcess: true,
      activeKeyId: active.keyId,
      activeKeyVersion: active.keyVersion,
      signerCommand: {
        serviceId: 'release-kms-signer',
        principalId: 'release-kms-principal',
        protocol: 'hepta-release-signer-json-stdio-v1',
        executable: executable(root, 'release-signer.mjs', 'release-signer'),
        credentialRoot: path.join(root, 'release-credentials-not-readable'),
        args: [],
        environmentAllowlist: ['RELEASE_SIGNER_TOKEN'],
        timeoutMs: 5000,
      },
      probeCommand: {
        serviceId: 'release-kms-probe',
        principalId: 'release-kms-probe-principal',
        protocol: 'hepta-release-signer-probe-json-stdio-v1',
        executable: executable(root, 'release-probe.mjs', 'release-probe'),
        credentialRoot: path.join(root, 'release-probe-credentials-not-readable'),
        args: [],
        environmentAllowlist: ['RELEASE_PROBE_TOKEN'],
        timeoutMs: 5000,
      },
      probeAttestor: probe,
    },
  };
  const configPath = path.join(root, 'release-attestor.json');
  write(configPath, `${JSON.stringify(configuration, null, 2)}\n`);
  return { root, configPath, configuration };
}

test('external qualification public identity never reads credential roots, private args, or environment values', (t) => {
  const fixture = externalQualificationFixture(t);
  const input = { configPath: fixture.configPath };
  Object.defineProperty(input, 'environment', {
    get() { throw new Error('environment_values_must_not_be_read'); },
  });
  const before = inspectExternalResearchQualificationPublicDeploymentIdentity(input);
  assert.equal(before.ready, false);
  assert.match(before.publicIdentityHash, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(before.blockers, [
    'external_qualification_public_credential_generation_or_fingerprint_required',
  ]);
  assert.equal(before.secretMaterialRead, false);
  assert.equal(before.environmentValuesRead, false);
  assert.equal(before.externalActionPerformed, false);

  fs.mkdirSync(fixture.qualifierCredentialRoot, { mode: 0o700 });
  fs.mkdirSync(fixture.verifierCredentialRoot, { mode: 0o700 });
  write(path.join(fixture.qualifierCredentialRoot, 'token'), 'secret-one\n');
  write(path.join(fixture.verifierCredentialRoot, 'token'), 'secret-two\n');
  write(fixture.privateArgumentPath, '-----BEGIN PRIVATE KEY-----\nnever-read\n');
  const afterSecretsAppear =
    inspectExternalResearchQualificationPublicDeploymentIdentity(input);
  assert.equal(afterSecretsAppear.publicIdentityHash, before.publicIdentityHash);

  write(path.join(fixture.qualifierCredentialRoot, 'token'), 'rotated-secret\n');
  write(fixture.privateArgumentPath, '-----BEGIN PRIVATE KEY-----\nrotated-never-read\n');
  const afterSecretRotation =
    inspectExternalResearchQualificationPublicDeploymentIdentity(input);
  assert.equal(afterSecretRotation.publicIdentityHash, before.publicIdentityHash);

  write(fixture.qualifierExecutable, '#!/usr/bin/env node\n// rotated executable\n', 0o755);
  const afterPublicExecutableRotation =
    inspectExternalResearchQualificationPublicDeploymentIdentity(input);
  assert.notEqual(afterPublicExecutableRotation.publicIdentityHash, before.publicIdentityHash);
});

test('public command identity rejects unclassified inline token and private-key argv without hashing them', (t) => {
  for (const [label, unclassifiedArgument] of [
    ['inline-token', '--token=do-not-hash-this-token'],
    ['inline-private-key', '-----BEGIN PRIVATE KEY-----\ndo-not-hash-this-key\n'],
  ]) {
    const fixture = externalQualificationFixture(t);
    fixture.configuration.qualifier.args = [unclassifiedArgument];
    write(fixture.configPath, `${JSON.stringify(fixture.configuration, null, 2)}\n`);
    const first = inspectExternalResearchQualificationPublicDeploymentIdentity({
      configPath: fixture.configPath,
    });
    assert.equal(first.ready, false, label);
    assert.equal(first.publicIdentityHash, null, label);
    assert.deepEqual(first.blockers, [
      'autonomous_research_public_deployment_command_arguments_public_classification_required',
    ], label);

    fixture.configuration.qualifier.args = [`${unclassifiedArgument}:rotated`];
    write(fixture.configPath, `${JSON.stringify(fixture.configuration, null, 2)}\n`);
    const rotated = inspectExternalResearchQualificationPublicDeploymentIdentity({
      configPath: fixture.configPath,
    });
    assert.equal(rotated.publicIdentityHash, null, label);
    assert.equal(rotated.inspectionHash, first.inspectionHash, label);
  }
});

test('runtime reproducibility public identity excludes unavailable credential material', (t) => {
  const fixture = runtimeReproducibilityFixture(t);
  const inspection = inspectRuntimeImageReproducibilityPublicDeploymentIdentity({
    configPath: fixture.configPath,
  });
  assert.equal(inspection.ready, false);
  assert.match(inspection.publicIdentityHash, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(inspection.blockers, [
    'runtime_reproducibility_public_credential_generation_or_fingerprint_required',
  ]);
  assert.equal(inspection.secretMaterialRead, false);
  assert.equal(inspection.environmentValuesRead, false);
});

test('release attestor public identity rejects local private-key mode without opening its private key', (t) => {
  const root = fixtureRoot(t, 'hepta-public-release-local-key');
  const configPath = path.join(root, 'release-local.json');
  write(configPath, `${JSON.stringify({
    version: 1,
    kind: 'ResearchExecutionReleaseAttestorConfiguration',
    status: 'active',
    privateKeyPath: path.join(root, 'private-key-that-does-not-exist.pem'),
  })}\n`);
  const inspection = inspectResearchExecutionReleaseAttestorPublicDeploymentIdentity({
    configPath,
  });
  assert.equal(inspection.ready, false);
  assert.equal(inspection.publicIdentityHash, null);
  assert.deepEqual(inspection.blockers, ['release_attestor_public_configuration_v2_required']);
});

test('release attestor public identity binds public signer and executable but not credential contents', (t) => {
  const fixture = releaseAttestorFixture(t);
  const before = inspectResearchExecutionReleaseAttestorPublicDeploymentIdentity({
    configPath: fixture.configPath,
  });
  assert.equal(before.ready, false);
  assert.match(before.publicIdentityHash, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(before.blockers, [
    'release_attestor_public_transport_credential_generation_or_fingerprint_required',
  ]);
  for (const command of [
    fixture.configuration.backend.signerCommand,
    fixture.configuration.backend.probeCommand,
  ]) {
    fs.mkdirSync(command.credentialRoot, { mode: 0o700 });
    write(path.join(command.credentialRoot, 'token'), crypto.randomBytes(32));
  }
  const after = inspectResearchExecutionReleaseAttestorPublicDeploymentIdentity({
    configPath: fixture.configPath,
  });
  assert.equal(after.publicIdentityHash, before.publicIdentityHash);
});

test('resident public deployment identity is order independent and changes only for ready public rotation', () => {
  const ids = ['provider', 'online-mutation-authority', 'state-backup-authority'];
  const components = ids.map((componentId) => (
    buildAutonomousResearchPublicDeploymentComponentInspection({
      componentId,
      publicIdentityHash: H(`identity:${componentId}:v1`),
    })
  ));
  const first = inspectAutonomousResearchResidentDeploymentIdentity({
    components,
    requiredComponentIds: ids,
  });
  const reordered = inspectAutonomousResearchResidentDeploymentIdentity({
    components: [...components].reverse(),
    requiredComponentIds: [...ids].reverse(),
  });
  assert.equal(first.ready, true);
  assert.equal(first.residentDeploymentIdentityHash,
    reordered.residentDeploymentIdentityHash);
  assert.equal(first.secretMaterialRead, false);
  assert.equal(first.environmentValuesRead, false);
  assert.equal(first.externalActionPerformed, false);

  const rotated = inspectAutonomousResearchResidentDeploymentIdentity({
    components: components.map((component) => (
      component.componentId === 'provider'
        ? buildAutonomousResearchPublicDeploymentComponentInspection({
          componentId: component.componentId,
          publicIdentityHash: H('identity:provider:v2'),
        }) : component
    )),
    requiredComponentIds: ids,
  });
  assert.equal(rotated.ready, true);
  assert.notEqual(rotated.residentDeploymentIdentityHash,
    first.residentDeploymentIdentityHash);
});

test('blocked or missing component never yields an adoptable deployment identity', () => {
  const provider = buildAutonomousResearchPublicDeploymentComponentInspection({
    componentId: 'provider',
    publicIdentityHash: H('provider'),
  });
  const blocked = buildAutonomousResearchPublicDeploymentComponentInspection({
    componentId: 'external-qualification-process',
    publicIdentityHash: H('external-qualification-public'),
    blockers: ['external_qualification_public_credential_generation_or_fingerprint_required'],
  });
  const inspection = inspectAutonomousResearchResidentDeploymentIdentity({
    components: [provider, blocked],
    requiredComponentIds: [
      'provider', 'external-qualification-process', 'state-backup-authority',
    ],
  });
  assert.equal(inspection.ready, false);
  assert.equal(inspection.residentDeploymentIdentityHash, null);
  assert.match(inspection.observedPublicDeploymentIdentityHash, /^sha256:[0-9a-f]{64}$/);
  assert.ok(inspection.blockers.some((blocker) => (
    blocker.includes('component_blocked:external-qualification-process')
  )));
  assert.ok(inspection.blockers.some((blocker) => (
    blocker === 'autonomous_research_resident_deployment_component_missing:state-backup-authority'
  )));
});
