import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const kitPath = path.join(
  root,
  'docs/provider-sandbox/provider-external-acceptance-kit.v1.json',
);
const vectorRunner = path.join(
  root,
  'docs/provider-sandbox/tools/run-provider-conformance-vectors.mjs',
);
const portableCompanion = path.join(root, 'provider-sandbox/provider-sandbox.mjs');
const strictSchema = path.join(root, 'docs/rust/tools/strict_json_schema.py');
const digest = `sha256:${'a'.repeat(64)}`;

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function temporaryDirectory(t, name) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function validate(schema, instance, expectedStatus = 0) {
  const result = spawnSync(
    'python3',
    [strictSchema, '--schema', schema, '--instance', instance],
    {
      cwd: root,
      encoding: 'utf8',
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
      env: {
        PATH: '/usr/bin:/bin',
        LANG: 'C.UTF-8',
        LC_ALL: 'C.UTF-8',
        PYTHONDONTWRITEBYTECODE: '1',
      },
    },
  );
  assert.equal(
    result.status,
    expectedStatus,
    `${result.stdout}\n${result.stderr}`,
  );
}

function candidateDocuments(directory) {
  const manifest = {
    schemaVersion: 1,
    kind: 'ProviderExternalCompanionSourceManifestV1',
    status: 'external_candidate_unaccepted',
    providerOwner: {
      ownerId: 'external-provider-owner',
      organization: 'external-provider-organization',
      acceptanceAuthorityId: 'external-provider-acceptance-authority',
      contact: 'provider-owner@example.invalid',
    },
    release: {
      releaseId: 'provider-companion-release-v1',
      version: 'v1.0.0',
      createdAt: '2026-09-07T00:00:00Z',
      artifactSha256: digest,
      signatureArtifactSha256: digest,
    },
    source: {
      repository: 'https://github.com/example/provider-companion',
      commit: 'a'.repeat(40),
      tree: 'b'.repeat(40),
      executablePath: portableCompanion,
      executableSha256: digest,
      dependencyLockSha256: digest,
      buildRecipeSha256: digest,
    },
    runtime: {
      nodeVersion: 'v22.23.1',
      protocolVersion: 1,
      requestSchemaSha256: digest,
      responseSchemaSha256: digest,
    },
    reproducibility: {
      sourceArchiveSha256: digest,
      cleanBuildRequired: true,
      networkDuringBuildAllowed: false,
      deterministicOutputRequired: true,
    },
    authority: {
      providerAuthorized: false,
      credentialCustodyEstablished: false,
      externalActionAuthorized: false,
      releaseAuthorized: false,
      submissionAuthorized: false,
      productionAuthorized: false,
      externalAuthorityClaimed: false,
    },
  };
  const profile = {
    schemaVersion: 1,
    kind: 'ProviderExternalTargetHostProfileV1',
    status: 'external_target_unaccepted',
    subject: {
      hostId: 'provider-target-host',
      hostnameSha256: digest,
      osRelease: 'linux-control',
      kernelRelease: 'kernel-control',
      architecture: 'x86_64',
    },
    process: {
      serviceManager: 'systemd',
      unitName: 'hepta-provider-sandbox.service',
      unitFileSha256: digest,
      uid: 1000,
      gid: 1000,
      noNewPrivileges: true,
      privateTmp: true,
      protectSystem: 'strict',
      protectHome: true,
      privateDevices: true,
      restrictSuidSgid: true,
      lockPersonality: true,
      memoryDenyWriteExecute: true,
    },
    filesystem: {
      runtimeRoot: path.join(directory, 'runtime'),
      sourceRoot: path.dirname(portableCompanion),
      ownerUid: 1000,
      ownerGid: 1000,
      runtimeMode: '0700',
      noSymlinkRuntimeRoot: true,
      singleLinkInputs: true,
      immutableSourceMount: true,
    },
    network: {
      defaultDeny: true,
      allowedDestinations: [],
      proxyEnvironmentAllowed: false,
      dnsPolicy: 'disabled',
      socketActivationAllowed: false,
    },
    resourceControl: {
      cgroupVersion: 2,
      cpuQuotaMicrosPerSecond: 100000,
      memoryMaxBytes: 268435456,
      pidsMax: 64,
      ioMaxEntries: 0,
      killMode: 'control-group',
    },
    audit: {
      logSink: 'append-only-provider-audit',
      receiptStore: 'append-only-provider-receipts',
      clockSource: 'authenticated-host-clock',
      retentionDays: 365,
      appendOnlyRequired: true,
    },
    authority: {
      hostQualified: false,
      providerAuthorized: false,
      externalActionAuthorized: false,
      productionAuthorized: false,
      externalAuthorityClaimed: false,
    },
  };
  const manifestPath = path.join(directory, 'manifest.json');
  const profilePath = path.join(directory, 'profile.json');
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  fs.writeFileSync(profilePath, `${JSON.stringify(profile)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  return { manifest, manifestPath, profile, profilePath };
}

test('external provider acceptance-kit index is closed and non-authorizing', () => {
  const kit = readJson(kitPath);
  assert.deepEqual(Object.keys(kit).sort(), [
    'acceptanceGuide',
    'authority',
    'conformanceVectorSchema',
    'conformanceVectors',
    'externalOperationalTest',
    'idempotencyReconciliationContract',
    'kind',
    'operationalRunner',
    'requestSchema',
    'responseSchema',
    'revocationRollbackChecklist',
    'schemaVersion',
    'sourceManifestSchema',
    'sourceManifestTemplate',
    'status',
    'targetHostProfileSchema',
    'targetHostProfileTemplate',
  ].sort());
  assert.equal(kit.kind, 'ProviderExternalAcceptanceKitV1');
  assert.equal(kit.status, 'source_contract_ready_external_evidence_required');
  assert.ok(Object.values(kit.authority).every((value) => value === false));
  for (const [key, relativePath] of Object.entries(kit)) {
    if (typeof relativePath !== 'string' || !relativePath.includes('/')) continue;
    assert.equal(fs.lstatSync(path.join(root, relativePath)).isFile(), true, key);
  }
});

test('source manifest and target-host profile schemas are closed', (t) => {
  const directory = temporaryDirectory(t, 'provider-acceptance-schema');
  const documents = candidateDocuments(directory);
  const kit = readJson(kitPath);
  validate(path.join(root, kit.sourceManifestSchema), documents.manifestPath);
  validate(path.join(root, kit.targetHostProfileSchema), documents.profilePath);

  const escalatedManifest = structuredClone(documents.manifest);
  escalatedManifest.authority.providerAuthorized = true;
  const escalatedManifestPath = path.join(directory, 'manifest-escalated.json');
  fs.writeFileSync(escalatedManifestPath, JSON.stringify(escalatedManifest));
  validate(path.join(root, kit.sourceManifestSchema), escalatedManifestPath, 1);

  const weakenedProfile = structuredClone(documents.profile);
  weakenedProfile.network.defaultDeny = false;
  const weakenedProfilePath = path.join(directory, 'profile-weakened.json');
  fs.writeFileSync(weakenedProfilePath, JSON.stringify(weakenedProfile));
  validate(path.join(root, kit.targetHostProfileSchema), weakenedProfilePath, 1);
});

test('checked-in templates cannot be mistaken for accepted evidence', () => {
  const kit = readJson(kitPath);
  for (const relativePath of [
    kit.sourceManifestTemplate,
    kit.targetHostProfileTemplate,
  ]) {
    const template = readJson(path.join(root, relativePath));
    assert.equal(template.status, 'template_unbound');
    assert.equal(template.templateOnly, true);
    assert.equal(template.externalAcceptanceEligible, false);
    assert.ok(template.requiredBindings.length >= 10);
    assert.ok(Object.values(template.authority).every((value) => value === false));
  }
});

test('credential-free vector schema and portable runner agree', (t) => {
  const kit = readJson(kitPath);
  const vectorsPath = path.join(root, kit.conformanceVectors);
  validate(path.join(root, kit.conformanceVectorSchema), vectorsPath);
  const directory = temporaryDirectory(t, 'provider-vector-runner');
  const runtime = path.join(directory, 'runtime');
  const evidence = path.join(directory, 'evidence', 'result.json');
  const result = spawnSync(process.execPath, [vectorRunner], {
    cwd: root,
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
    env: {
      PATH: '/usr/bin:/bin',
      HOME: directory,
      TMPDIR: directory,
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      PROVIDER_COMPANION: portableCompanion,
      PROVIDER_VECTORS: vectorsPath,
      PROVIDER_VECTOR_EVIDENCE: evidence,
      PROVIDER_VECTOR_RUNTIME: runtime,
    },
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const report = readJson(evidence);
  assert.equal(report.status, 'credential_free_conformance_complete_non_authorizing');
  assert.equal(report.positive.length, 2);
  assert.equal(report.negative.length, 5);
  assert.equal(report.credentialsObserved, false);
  assert.equal(report.externalActionPerformed, false);
  assert.equal(report.providerAuthorized, false);
  assert.equal(report.productionAuthorized, false);
  assert.equal(report.externalAuthorityClaimed, false);
});

test('external acceptance shell entrypoint is fail-closed and syntax-valid', () => {
  const kit = readJson(kitPath);
  const runner = path.join(root, kit.operationalRunner);
  const result = spawnSync('bash', ['-n', runner], {
    cwd: root,
    encoding: 'utf8',
    timeout: 15_000,
    env: { PATH: '/usr/bin:/bin' },
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const source = fs.readFileSync(runner, 'utf8');
  for (const required of [
    'PROVIDER_SOURCE_MANIFEST',
    'PROVIDER_TARGET_PROFILE',
    'provider_acceptance_companion_missing',
    'provider_acceptance_companion_digest_mismatch',
    'env -i',
    'provider-sandbox-external.operational.mjs',
    'externalAuthorityClaimed',
  ]) assert.ok(source.includes(required), required);
  assert.doesNotMatch(source, /\bskip\b|fixture fallback|catch-to-success/iu);
});

test('acceptance contracts retain idempotency, reconciliation and revocation obligations', () => {
  const kit = readJson(kitPath);
  const idempotency = fs.readFileSync(
    path.join(root, kit.idempotencyReconciliationContract),
    'utf8',
  );
  const rollback = fs.readFileSync(
    path.join(root, kit.revocationRollbackChecklist),
    'utf8',
  );
  for (const token of [
    'remote_outcome_ambiguous',
    'reconciled_absent',
    'persistent lease or fencing generation',
    'provider_idempotency_conflict',
    'Crash and restart recovery',
  ]) assert.ok(idempotency.includes(token), token);
  for (const token of [
    'advance the companion fencing generation',
    'remote_ambiguous_manual_reconciliation',
    'Credential compromise procedure',
    'immutable, previously accepted source manifest',
    'Re-enable conditions',
  ]) assert.ok(rollback.includes(token), token);
});
