import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  inspectConfiguredDynamicFormalProjectClosure,
} from '../../paper-adapters/research-verify/dynamic-formal-project-closure-readiness.mjs';
import {
  readFormalProjectClosureSync,
} from '../../paper-adapters/research-verify/formal-project-closure-reader.mjs';
import {
  PRODUCTION_LEAN_TOOLCHAIN,
  PRODUCTION_LEAN_TOOLCHAIN_ROOT_MERKLE_HASHES,
  PRODUCTION_MATHLIB_RELEASES,
} from '../../paper-domain/research/formal-verifier-policy.mjs';
import {
  buildBubblewrapWorkerCommand,
  buildDockerWorkerCommand,
} from '../../paper-adapters/runtime/docker-worker-command.mjs';
import { createOsSandboxedWorkerRunner } from '../../paper-adapters/runtime/os-sandboxed-worker-runner.mjs';
import {
  SYSTEM_PINNED_FORMAL_SANDBOX_RUNTIME_CONFIGURATION,
} from '../../paper-adapters/research-verify/pinned-formal-sandbox-runtime-configuration.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  autonomousConfigurationAuthoritySigningPayload,
} from '../../paper-domain/automation/autonomous-configuration-authority-contract.mjs';
import {
  buildProductionMathlibBuildAuthorization,
  buildSignedProductionMathlibBuildAuthorityConfiguration,
  productionMathlibBuildAuthorizationHash,
  PRODUCTION_MATHLIB_BUILD_AUTHORITY_ROLE,
} from '../../paper-adapters/research-verify/production-mathlib-build-authority.mjs';
import {
  PRODUCTION_MATHLIB_BUILD_AUTHORITY_CONFIG_ENV,
  PRODUCTION_MATHLIB_BUILD_AUTHORITY_CONFIGURATION_HASH_ENV,
} from '../../paper-adapters/research-verify/production-mathlib-build-authority-configuration.mjs';

function write(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  fs.chmodSync(filePath, 0o600);
}

function fixture(t) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-dynamic-formal-'));
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  write(path.join(projectRoot, 'lean-toolchain'), `${PRODUCTION_LEAN_TOOLCHAIN}\n`);
  write(path.join(projectRoot, 'lakefile.lean'), [
    'import Lake',
    'open Lake DSL',
    'package HeptaDynamicFormal where',
    '',
  ].join('\n'));
  write(path.join(projectRoot, 'lake-manifest.json'), `${JSON.stringify({
    version: '1.2.0',
    packagesDir: '.lake/packages',
    packages: [PRODUCTION_MATHLIB_RELEASES[
      PRODUCTION_LEAN_TOOLCHAIN
    ].packageEntry],
    name: 'HeptaDynamicFormal',
    lakeDir: '.lake',
    fixedToolchain: false,
  })}\n`);
  write(path.join(projectRoot, '.lake/packages/mathlib/Mathlib.lean'),
    'theorem mathlibFixture : 1 = 1 := by rfl\n');
  write(path.join(projectRoot, '.lake/packages/mathlib/.lake/build/lib/lean/Mathlib.olean'),
    'compiled-mathlib-fixture\n');
  write(path.join(projectRoot, '.lake/lakefile.olean'), 'compiled-lakefile-fixture\n');
  write(path.join(projectRoot, 'HeptaMathlibReadiness.lean'),
    'import Mathlib\nexample (x : Real) : x * 1 = x := by ring\n');
  const closure = readFormalProjectClosureSync({ projectRoot });
  assert.equal(closure.status, 'formal_project_closure_verified');
  return { projectRoot, closure };
}

function fixtureMathlibReleaseIdentity({ projectRoot, projectScopeRoot }) {
  const policy = PRODUCTION_MATHLIB_RELEASES[PRODUCTION_LEAN_TOOLCHAIN];
  const criticalSourceFiles = Object.freeze([
    'Mathlib.lean', 'lakefile.lean', 'lake-manifest.json', 'lean-toolchain',
  ].map((sourcePath, index) => Object.freeze({
    path: sourcePath,
    hash: `sha256:${String(index + 5).repeat(64)}`,
    bytes: index + 1,
    posixMode: 0o600,
  })));
  const mathlibManifestHash = criticalSourceFiles.find((file) => (
    file.path === 'lake-manifest.json'
  )).hash;
  const sourceEvidence = {
    gitHeadRevision: policy.revision,
    gitHeadTreeHash: policy.sourceTreeHash,
    gitRemoteUrl: policy.repositoryUrl,
    criticalSourceFiles,
    mathlibManifestHash,
  };
  const gitExecutableRealPath = fs.realpathSync.native('/usr/bin/git');
  const payload = {
    version: 1,
    kind: 'ProductionMathlibReleaseIdentity',
    status: 'production_mathlib_release_verified',
    toolchain: PRODUCTION_LEAN_TOOLCHAIN,
    manifestVersion: policy.manifestVersion,
    packagesDir: policy.packagesDir,
    packageEntry: policy.packageEntry,
    packageSourcePath: path.relative(
      fs.realpathSync.native(projectScopeRoot),
      fs.realpathSync.native(path.join(projectRoot, '.lake/packages/mathlib')),
    ).replaceAll('\\', '/'),
    releaseTag: policy.releaseTag,
    repositoryUrl: policy.repositoryUrl,
    revision: policy.revision,
    sourceTreeHash: policy.sourceTreeHash,
    gitHeadRevision: policy.revision,
    gitHeadTreeHash: policy.sourceTreeHash,
    gitRemoteUrl: policy.repositoryUrl,
    gitExecutableRealPath,
    gitExecutableHash: hashBytes(fs.readFileSync(gitExecutableRealPath)),
    criticalSourceFiles,
    mathlibManifestHash,
    sourceEvidenceHash: hashRecord('ProductionMathlibSourceEvidence', sourceEvidence),
    blockers: Object.freeze([]),
  };
  return Object.freeze({
    ...payload,
    productionMathlibReleaseIdentityHash: hashRecord(
      'ProductionMathlibReleaseIdentity', payload,
    ),
  });
}

function readyOptions(closure, {
  sandboxCalls = null,
  sandboxReceiptOverrides = null,
  verifySandboxProbeReceipt = () => true,
} = {}) {
  return {
    resolvePinnedRuntime: () => ({
      status: 'formal_pinned_lake_resolved',
      lakeExecutable: '/pinned/lake',
      leanExecutable: '/pinned/lean',
      toolchainRoot: '/pinned',
      blockers: [],
    }),
    inspectToolchain: () => ({
      status: 'lean_toolchain_identity_verified',
      toolchainRootMerkleHash:
        PRODUCTION_LEAN_TOOLCHAIN_ROOT_MERKLE_HASHES[PRODUCTION_LEAN_TOOLCHAIN],
      leanToolchainContentIdentityHash: `sha256:${'1'.repeat(64)}`,
      blockers: [],
    }),
    sandboxProbeRunnerFactory: (options) => ({
      run: (spec) => {
        sandboxCalls?.push({ options, spec });
        const sourceMerkleHash = spec.expectedSourceMerkleHash;
        const sourceWorkspaceManifestHash =
          spec.expectedSourceWorkspaceManifestHash;
        const receipt = {
          ok: true,
          backend: 'docker',
          status: 'os_sandbox_worker_passed',
          runtimeIdentityType: 'container',
          containerImageDigest:
            'sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc',
          runtimeIdentityHash: `sha256:${'2'.repeat(64)}`,
          executionProcessIdentityHash: `sha256:${'3'.repeat(64)}`,
          receiptHash: `sha256:${'4'.repeat(64)}`,
          sourceMerkleHashBefore: sourceMerkleHash,
          sourceMerkleHashAfter: sourceMerkleHash,
          workSourceMerkleHash: sourceMerkleHash,
          sourceWorkspaceManifestHashBefore: sourceWorkspaceManifestHash,
          sourceWorkspaceManifestHashAfter: sourceWorkspaceManifestHash,
          workWorkspaceManifestHash: sourceWorkspaceManifestHash,
          sourceMutationDetected: false,
          isolation: {
            immutableWorkRootVerified: true,
            workspaceExecutionSnapshotVerified: true,
          },
          blockers: [],
        };
        return {
          ...receipt,
          ...(sandboxReceiptOverrides || {}),
          isolation: {
            ...receipt.isolation,
            ...(sandboxReceiptOverrides?.isolation || {}),
          },
        };
      },
    }),
    verifySandboxProbeReceipt,
    inspectMathlibRelease: fixtureMathlibReleaseIdentity,
    trustedMathlibBuildClosureHashes: Object.freeze([
      closure.formalProjectClosureHash,
    ]),
  };
}

function signedBuildAuthorityConfiguration({
  projectRoot,
  closure,
  keyId = 'independent-mathlib-build-authority',
  pair = crypto.generateKeyPairSync('ed25519'),
  signedAt,
  expiresAt,
  observedAt,
} = {}) {
  const releaseIdentity = fixtureMathlibReleaseIdentity({
    projectRoot,
    projectScopeRoot: projectRoot,
  });
  const authorization = buildProductionMathlibBuildAuthorization({
    formalProjectClosureHash: closure.formalProjectClosureHash,
    productionMathlibReleaseIdentityHash:
      releaseIdentity.productionMathlibReleaseIdentityHash,
  });
  const trustStore = {
    version: 1,
    kind: 'AuthorityTrustStore',
    keys: [{
      keyId,
      algorithm: 'ed25519',
      status: 'active',
      roles: [PRODUCTION_MATHLIB_BUILD_AUTHORITY_ROLE],
      subjectId: keyId,
      publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }),
    }],
  };
  const unsigned = {
    version: 1,
    kind: 'ProductionMathlibBuildAuthorizationEnvelope',
    subjectKind: 'ProductionMathlibBuildAuthorization',
    subjectHash: productionMathlibBuildAuthorizationHash(authorization),
    signedAt,
    expiresAt,
  };
  const authorityEnvelope = {
    ...unsigned,
    signatures: [{
      keyId,
      algorithm: 'ed25519',
      role: PRODUCTION_MATHLIB_BUILD_AUTHORITY_ROLE,
      value: crypto.sign(
        null,
        autonomousConfigurationAuthoritySigningPayload(unsigned),
        pair.privateKey,
      ).toString('base64'),
    }],
  };
  return buildSignedProductionMathlibBuildAuthorityConfiguration({
    authorization,
    trustStore,
    authorityEnvelope,
    expectedKeyIds: [keyId],
    maximumLifetimeMs: 24 * 60 * 60 * 1_000,
    observedAt,
  });
}

test('dynamic Real readiness requires an explicitly hash-bound executable Mathlib closure', (t) => {
  const { projectRoot, closure } = fixture(t);
  const calls = [];
  const sandboxCalls = [];
  const inspection = inspectConfiguredDynamicFormalProjectClosure({
    environment: {
      HEPTA_DYNAMIC_FORMAL_PROJECT_ROOT: projectRoot,
      HEPTA_DYNAMIC_FORMAL_PROJECT_CLOSURE_HASH: closure.formalProjectClosureHash,
      HEPTA_DYNAMIC_FORMAL_PROJECT_PROBE: 'HeptaMathlibReadiness.lean',
    },
    spawnSyncImpl(executable, args, options) {
      calls.push({ executable, args, options });
      return { status: 0, stdout: '', stderr: '' };
    },
    ...readyOptions(closure, { sandboxCalls }),
  });
  assert.equal(inspection.status, 'dynamic_formal_project_closure_ready');
  assert.equal(inspection.ready, true);
  assert.equal(inspection.formalProjectClosureHash, closure.formalProjectClosureHash);
  assert.equal(inspection.formalProjectManifestHash, closure.manifestHash);
  assert.equal(inspection.executableProbeVerified, true);
  assert.equal(inspection.postProbeReinspectionVerified, true);
  assert.match(inspection.formalSandboxProbeReceiptHash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(inspection.formalSandboxRuntimeImageDigest,
    'sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc');
  assert.match(inspection.toolchainRootMerkleHash, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(calls.map(({ executable, args }) => ({ executable, args })), [{
    executable: '/pinned/lake',
    args: ['env', 'lean', 'HeptaMathlibReadiness.lean'],
  }]);
  assert.equal(calls[0].options.cwd, projectRoot);
  assert.equal(sandboxCalls.length, 1);
  assert.deepEqual(sandboxCalls[0].options.allowedExecutables, ['/pinned/lean']);
  assert.equal(sandboxCalls[0].spec.executable, '/pinned/lean');
  assert.deepEqual(sandboxCalls[0].spec.args, ['HeptaMathlibReadiness.lean']);
  assert.equal(sandboxCalls[0].spec.env.LEAN_PATH,
    '/work/.lake/packages/mathlib/.lake/build/lib/lean:'
      + '/work/.lake/build/lib/lean:/pinned/lib/lean');
  assert.ok(closure.lakeBuildArtifactFileCount >= 1);
});

test('sandbox snapshot receipt must bind equal source, work, and post-execution identities', (t) => {
  const { projectRoot, closure } = fixture(t);
  const environment = {
    HEPTA_DYNAMIC_FORMAL_PROJECT_ROOT: projectRoot,
    HEPTA_DYNAMIC_FORMAL_PROJECT_CLOSURE_HASH:
      closure.formalProjectClosureHash,
    HEPTA_DYNAMIC_FORMAL_PROJECT_PROBE: 'HeptaMathlibReadiness.lean',
  };
  const tamperedReceipts = [
    { sourceMerkleHashAfter: `sha256:${'7'.repeat(64)}` },
    { workSourceMerkleHash: `sha256:${'7'.repeat(64)}` },
    { sourceWorkspaceManifestHashAfter: `sha256:${'8'.repeat(64)}` },
    { workWorkspaceManifestHash: `sha256:${'8'.repeat(64)}` },
    { sourceMerkleHashBefore: 'not-a-hash' },
    { isolation: { workspaceExecutionSnapshotVerified: false } },
    {
      sourceMerkleHashBefore: `sha256:${'9'.repeat(64)}`,
      sourceMerkleHashAfter: `sha256:${'9'.repeat(64)}`,
      workSourceMerkleHash: `sha256:${'9'.repeat(64)}`,
      sourceWorkspaceManifestHashBefore: `sha256:${'a'.repeat(64)}`,
      sourceWorkspaceManifestHashAfter: `sha256:${'a'.repeat(64)}`,
      workWorkspaceManifestHash: `sha256:${'a'.repeat(64)}`,
    },
  ];
  for (const sandboxReceiptOverrides of tamperedReceipts) {
    const inspection = inspectConfiguredDynamicFormalProjectClosure({
      environment,
      spawnSyncImpl: () => ({ status: 0, stdout: '', stderr: '' }),
      ...readyOptions(closure, { sandboxReceiptOverrides }),
    });
    assert.equal(inspection.ready, false, JSON.stringify(sandboxReceiptOverrides));
    assert.ok(inspection.blockers.includes(
      'dynamic_formal_sandbox_probe_snapshot_changed',
    ), JSON.stringify(inspection, null, 2));
  }
});

test('sandbox snapshot receipt must pass the complete worker receipt verifier', (t) => {
  const { projectRoot, closure } = fixture(t);
  const inspection = inspectConfiguredDynamicFormalProjectClosure({
    environment: {
      HEPTA_DYNAMIC_FORMAL_PROJECT_ROOT: projectRoot,
      HEPTA_DYNAMIC_FORMAL_PROJECT_CLOSURE_HASH:
        closure.formalProjectClosureHash,
      HEPTA_DYNAMIC_FORMAL_PROJECT_PROBE: 'HeptaMathlibReadiness.lean',
    },
    spawnSyncImpl: () => ({ status: 0, stdout: '', stderr: '' }),
    ...readyOptions(closure, {
      verifySandboxProbeReceipt: () => false,
    }),
  });
  assert.equal(inspection.ready, false);
  assert.ok(inspection.blockers.includes(
    'dynamic_formal_sandbox_mathlib_probe_failed',
  ), JSON.stringify(inspection, null, 2));
});

test('independently signed and environment-pinned Mathlib build authority unlocks only its exact closure', (t) => {
  const { projectRoot, closure } = fixture(t);
  const authorityRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-mathlib-authority-'));
  t.after(() => fs.rmSync(authorityRoot, { recursive: true, force: true }));
  const observedAt = '2026-07-22T08:00:00.000Z';
  const configuration = signedBuildAuthorityConfiguration({
    projectRoot,
    closure,
    signedAt: '2026-07-22T07:55:00.000Z',
    expiresAt: '2026-07-22T09:00:00.000Z',
    observedAt,
  });
  const configurationPath = path.join(authorityRoot, 'mathlib-build-authority.json');
  write(configurationPath, `${JSON.stringify(configuration)}\n`);
  const environment = {
    HEPTA_DYNAMIC_FORMAL_PROJECT_ROOT: projectRoot,
    HEPTA_DYNAMIC_FORMAL_PROJECT_CLOSURE_HASH: closure.formalProjectClosureHash,
    HEPTA_DYNAMIC_FORMAL_PROJECT_PROBE: 'HeptaMathlibReadiness.lean',
    [PRODUCTION_MATHLIB_BUILD_AUTHORITY_CONFIG_ENV]: configurationPath,
    [PRODUCTION_MATHLIB_BUILD_AUTHORITY_CONFIGURATION_HASH_ENV]:
      configuration.configurationHash,
  };
  const options = readyOptions(closure);
  delete options.trustedMathlibBuildClosureHashes;
  const inspection = inspectConfiguredDynamicFormalProjectClosure({
    environment,
    spawnSyncImpl: () => ({ status: 0, stdout: '', stderr: '' }),
    mathlibBuildAuthorityClock: () => observedAt,
    ...options,
  });
  assert.equal(inspection.ready, true, JSON.stringify(inspection, null, 2));
  assert.equal(
    inspection.productionMathlibBuildAuthority.authorizationType,
    'independent_ed25519_signed_configuration',
  );
  assert.equal(
    inspection.productionMathlibBuildAuthority.configurationHash,
    configuration.configurationHash,
  );
  assert.equal(
    inspection.productionMathlibBuildAuthority.formalProjectClosureHash,
    closure.formalProjectClosureHash,
  );

  delete environment[PRODUCTION_MATHLIB_BUILD_AUTHORITY_CONFIGURATION_HASH_ENV];
  const unpinned = inspectConfiguredDynamicFormalProjectClosure({
    environment,
    spawnSyncImpl: () => ({ status: 0, stdout: '', stderr: '' }),
    mathlibBuildAuthorityClock: () => observedAt,
    ...options,
  });
  assert.equal(unpinned.ready, false);
  assert.ok(unpinned.blockers.some((blocker) => blocker.includes(
    'production_mathlib_build_authority_configuration_pin_required',
  )));
});

test('expired, tampered, or rotated signed Mathlib authority fails closed across the probe', (t) => {
  const { projectRoot, closure } = fixture(t);
  const authorityRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-mathlib-authority-'));
  t.after(() => fs.rmSync(authorityRoot, { recursive: true, force: true }));
  const configurationPath = path.join(authorityRoot, 'mathlib-build-authority.json');
  const valid = signedBuildAuthorityConfiguration({
    projectRoot,
    closure,
    signedAt: '2026-07-22T07:55:00.000Z',
    expiresAt: '2026-07-22T09:00:00.000Z',
    observedAt: '2026-07-22T08:00:00.000Z',
  });
  write(configurationPath, `${JSON.stringify(valid)}\n`);
  const baseEnvironment = {
    HEPTA_DYNAMIC_FORMAL_PROJECT_ROOT: projectRoot,
    HEPTA_DYNAMIC_FORMAL_PROJECT_CLOSURE_HASH: closure.formalProjectClosureHash,
    HEPTA_DYNAMIC_FORMAL_PROJECT_PROBE: 'HeptaMathlibReadiness.lean',
    [PRODUCTION_MATHLIB_BUILD_AUTHORITY_CONFIG_ENV]: configurationPath,
    [PRODUCTION_MATHLIB_BUILD_AUTHORITY_CONFIGURATION_HASH_ENV]:
      valid.configurationHash,
  };
  const options = readyOptions(closure);
  delete options.trustedMathlibBuildClosureHashes;
  const expired = inspectConfiguredDynamicFormalProjectClosure({
    environment: { ...baseEnvironment },
    spawnSyncImpl: () => ({ status: 0, stdout: '', stderr: '' }),
    mathlibBuildAuthorityClock: () => '2026-07-22T09:00:00.000Z',
    ...options,
  });
  assert.equal(expired.ready, false);
  assert.ok(expired.blockers.some((blocker) => blocker.includes(
    'production_mathlib_build_authority_configuration_invalid',
  )));

  const tampered = JSON.parse(JSON.stringify(valid));
  tampered.authorization.formalProjectClosureHash = `sha256:${'f'.repeat(64)}`;
  write(configurationPath, `${JSON.stringify(tampered)}\n`);
  const tamperResult = inspectConfiguredDynamicFormalProjectClosure({
    environment: { ...baseEnvironment },
    spawnSyncImpl: () => ({ status: 0, stdout: '', stderr: '' }),
    mathlibBuildAuthorityClock: () => '2026-07-22T08:00:00.000Z',
    ...options,
  });
  assert.equal(tamperResult.ready, false);

  write(configurationPath, `${JSON.stringify(valid)}\n`);
  const rotated = signedBuildAuthorityConfiguration({
    projectRoot,
    closure,
    keyId: 'rotated-independent-mathlib-build-authority',
    signedAt: '2026-07-22T07:56:00.000Z',
    expiresAt: '2026-07-22T09:00:00.000Z',
    observedAt: '2026-07-22T08:00:00.000Z',
  });
  const rotationEnvironment = { ...baseEnvironment };
  const rotation = inspectConfiguredDynamicFormalProjectClosure({
    environment: rotationEnvironment,
    spawnSyncImpl: () => {
      write(configurationPath, `${JSON.stringify(rotated)}\n`);
      rotationEnvironment[
        PRODUCTION_MATHLIB_BUILD_AUTHORITY_CONFIGURATION_HASH_ENV
      ] = rotated.configurationHash;
      return { status: 0, stdout: '', stderr: '' };
    },
    mathlibBuildAuthorityClock: () => '2026-07-22T08:00:00.000Z',
    ...options,
  });
  assert.equal(rotation.ready, false);
  assert.ok(rotation.blockers.includes(
    'dynamic_formal_mathlib_build_authority_changed_during_probe',
  ));
});

test('successful probe exit cannot hide project mutation or mutate-and-restore TOCTOU', (t) => {
  const restoredFixture = fixture(t);
  const restoredProbe = path.join(
    restoredFixture.projectRoot,
    'HeptaMathlibReadiness.lean',
  );
  const originalProbe = fs.readFileSync(restoredProbe);
  const restored = inspectConfiguredDynamicFormalProjectClosure({
    environment: {
      HEPTA_DYNAMIC_FORMAL_PROJECT_ROOT: restoredFixture.projectRoot,
      HEPTA_DYNAMIC_FORMAL_PROJECT_CLOSURE_HASH:
        restoredFixture.closure.formalProjectClosureHash,
      HEPTA_DYNAMIC_FORMAL_PROJECT_PROBE: 'HeptaMathlibReadiness.lean',
    },
    spawnSyncImpl() {
      write(restoredProbe, 'import Mathlib\nexample : False := by sorry\n');
      write(restoredProbe, originalProbe);
      return { status: 0, stdout: '', stderr: '' };
    },
    ...readyOptions(restoredFixture.closure),
  });
  assert.equal(restored.ready, false);
  assert.ok(restored.blockers.includes(
    'dynamic_formal_project_closure_changed_during_probe',
  ));

  const changedFixture = fixture(t);
  const mathlibSource = path.join(
    changedFixture.projectRoot,
    '.lake/packages/mathlib/Mathlib.lean',
  );
  const changed = inspectConfiguredDynamicFormalProjectClosure({
    environment: {
      HEPTA_DYNAMIC_FORMAL_PROJECT_ROOT: changedFixture.projectRoot,
      HEPTA_DYNAMIC_FORMAL_PROJECT_CLOSURE_HASH:
        changedFixture.closure.formalProjectClosureHash,
      HEPTA_DYNAMIC_FORMAL_PROJECT_PROBE: 'HeptaMathlibReadiness.lean',
    },
    spawnSyncImpl() {
      write(mathlibSource, 'theorem substitutedDependency : False := by sorry\n');
      return { status: 0, stdout: '', stderr: '' };
    },
    ...readyOptions(changedFixture.closure),
  });
  assert.equal(changed.ready, false);
  assert.ok(changed.blockers.includes(
    'dynamic_formal_project_closure_changed_during_probe',
  ));

  const buildFixture = fixture(t);
  const compiledMathlib = path.join(
    buildFixture.projectRoot,
    '.lake/packages/mathlib/.lake/build/lib/lean/Mathlib.olean',
  );
  const buildChanged = inspectConfiguredDynamicFormalProjectClosure({
    environment: {
      HEPTA_DYNAMIC_FORMAL_PROJECT_ROOT: buildFixture.projectRoot,
      HEPTA_DYNAMIC_FORMAL_PROJECT_CLOSURE_HASH:
        buildFixture.closure.formalProjectClosureHash,
      HEPTA_DYNAMIC_FORMAL_PROJECT_PROBE: 'HeptaMathlibReadiness.lean',
    },
    spawnSyncImpl() {
      write(compiledMathlib, 'substituted-compiled-mathlib\n');
      return { status: 0, stdout: '', stderr: '' };
    },
    ...readyOptions(buildFixture.closure),
  });
  assert.equal(buildChanged.ready, false);
  assert.ok(buildChanged.blockers.includes(
    'dynamic_formal_project_closure_changed_during_probe',
  ));

  const lakeMetadataFixture = fixture(t);
  const compiledLakefile = path.join(
    lakeMetadataFixture.projectRoot,
    '.lake/lakefile.olean',
  );
  const lakeMetadataChanged = inspectConfiguredDynamicFormalProjectClosure({
    environment: {
      HEPTA_DYNAMIC_FORMAL_PROJECT_ROOT: lakeMetadataFixture.projectRoot,
      HEPTA_DYNAMIC_FORMAL_PROJECT_CLOSURE_HASH:
        lakeMetadataFixture.closure.formalProjectClosureHash,
      HEPTA_DYNAMIC_FORMAL_PROJECT_PROBE: 'HeptaMathlibReadiness.lean',
    },
    spawnSyncImpl() {
      write(compiledLakefile, 'substituted-compiled-lakefile\n');
      return { status: 0, stdout: '', stderr: '' };
    },
    ...readyOptions(lakeMetadataFixture.closure),
  });
  assert.equal(lakeMetadataChanged.ready, false);
  assert.ok(lakeMetadataChanged.blockers.includes(
    'dynamic_formal_project_closure_changed_during_probe',
  ));
});

test('post-probe toolchain identity must match the pre-probe identity', (t) => {
  const { projectRoot, closure } = fixture(t);
  let inspections = 0;
  const result = inspectConfiguredDynamicFormalProjectClosure({
    environment: {
      HEPTA_DYNAMIC_FORMAL_PROJECT_ROOT: projectRoot,
      HEPTA_DYNAMIC_FORMAL_PROJECT_CLOSURE_HASH: closure.formalProjectClosureHash,
      HEPTA_DYNAMIC_FORMAL_PROJECT_PROBE: 'HeptaMathlibReadiness.lean',
    },
    spawnSyncImpl: () => ({ status: 0, stdout: '', stderr: '' }),
    ...readyOptions(closure),
    inspectToolchain: () => {
      inspections += 1;
      return {
        status: 'lean_toolchain_identity_verified',
        toolchainRootMerkleHash:
          PRODUCTION_LEAN_TOOLCHAIN_ROOT_MERKLE_HASHES[PRODUCTION_LEAN_TOOLCHAIN],
        leanToolchainContentIdentityHash: `sha256:${String(inspections).repeat(64)}`,
        blockers: [],
      };
    },
  });
  assert.equal(inspections, 2, JSON.stringify(result, null, 2));
  assert.equal(result.ready, false);
  assert.ok(result.blockers.includes(
    'dynamic_formal_toolchain_identity_changed_during_probe',
  ));
});

test('Init-only/default, hash drift, missing Mathlib and failed execution remain blocked', (t) => {
  assert.equal(inspectConfiguredDynamicFormalProjectClosure({ environment: {} }).ready, false);
  const { projectRoot, closure } = fixture(t);
  const environment = {
    HEPTA_DYNAMIC_FORMAL_PROJECT_ROOT: projectRoot,
    HEPTA_DYNAMIC_FORMAL_PROJECT_CLOSURE_HASH: closure.formalProjectClosureHash,
    HEPTA_DYNAMIC_FORMAL_PROJECT_PROBE: 'HeptaMathlibReadiness.lean',
  };
  const drift = inspectConfiguredDynamicFormalProjectClosure({
    environment: {
      ...environment,
      HEPTA_DYNAMIC_FORMAL_PROJECT_CLOSURE_HASH: `sha256:${'0'.repeat(64)}`,
    },
    spawnSyncImpl: () => ({ status: 0 }),
    ...readyOptions(closure),
  });
  assert.ok(drift.blockers.includes('dynamic_formal_project_closure_hash_mismatch'));

  const failedProbe = inspectConfiguredDynamicFormalProjectClosure({
    environment,
    spawnSyncImpl: () => ({ status: 1, stderr: 'unknown module Mathlib' }),
    ...readyOptions(closure),
  });
  assert.ok(failedProbe.blockers.includes('dynamic_formal_mathlib_executable_probe_failed'));

  const manifestPath = path.join(projectRoot, 'lake-manifest.json');
  write(manifestPath, `${JSON.stringify({ version: '1.1.0', packages: [] })}\n`);
  const missing = inspectConfiguredDynamicFormalProjectClosure({
    environment,
    spawnSyncImpl: () => ({ status: 0 }),
    ...readyOptions(closure),
  });
  assert.ok(missing.blockers.some((blocker) => (
    blocker.includes('production_mathlib_manifest_entry_required')
  )));
});

test('self-chosen build hashes and source packages impersonating Mathlib remain blocked', (t) => {
  const { projectRoot, closure } = fixture(t);
  const environment = {
    HEPTA_DYNAMIC_FORMAL_PROJECT_ROOT: projectRoot,
    HEPTA_DYNAMIC_FORMAL_PROJECT_CLOSURE_HASH: closure.formalProjectClosureHash,
    HEPTA_DYNAMIC_FORMAL_PROJECT_PROBE: 'HeptaMathlibReadiness.lean',
  };
  const selfChosen = inspectConfiguredDynamicFormalProjectClosure({
    environment,
    spawnSyncImpl: () => ({ status: 0, stdout: '', stderr: '' }),
    ...readyOptions(closure),
    trustedMathlibBuildClosureHashes: Object.freeze([]),
  });
  assert.equal(selfChosen.ready, false);
  assert.ok(selfChosen.blockers.includes(
    'dynamic_formal_mathlib_build_authority_required',
  ));

  const fakeSource = inspectConfiguredDynamicFormalProjectClosure({
    environment,
    spawnSyncImpl: () => ({ status: 0, stdout: '', stderr: '' }),
    resolvePinnedRuntime: readyOptions(closure).resolvePinnedRuntime,
    inspectToolchain: readyOptions(closure).inspectToolchain,
    sandboxProbeRunnerFactory:
      readyOptions(closure).sandboxProbeRunnerFactory,
    trustedMathlibBuildClosureHashes: Object.freeze([
      closure.formalProjectClosureHash,
    ]),
  });
  assert.equal(fakeSource.ready, false);
  assert.ok(fakeSource.blockers.some((blocker) => (
    blocker.startsWith('production_mathlib_release_inspection_failed:')
  )));

  const provenanceDrift = Object.freeze({
    type: 'path',
    url: 'https://example.invalid/fake-mathlib',
    rev: '0'.repeat(40),
    inputRev: 'attacker-selected',
    configFile: 'lakefile.toml',
    manifestFile: 'attacker-manifest.json',
    subDir: 'attacker-subdirectory',
    scope: 'attacker-scope',
    inherited: true,
  });
  for (const [field, value] of Object.entries(provenanceDrift)) {
    const driftFixture = fixture(t);
    const manifestPath = path.join(driftFixture.projectRoot, 'lake-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.packages[0] = { ...manifest.packages[0], [field]: value };
    write(manifestPath, `${JSON.stringify(manifest)}\n`);
    const fakeClosure = readFormalProjectClosureSync({
      projectRoot: driftFixture.projectRoot,
    });
    const fakeManifest = inspectConfiguredDynamicFormalProjectClosure({
      environment: {
        HEPTA_DYNAMIC_FORMAL_PROJECT_ROOT: driftFixture.projectRoot,
        HEPTA_DYNAMIC_FORMAL_PROJECT_CLOSURE_HASH:
          fakeClosure.formalProjectClosureHash,
        HEPTA_DYNAMIC_FORMAL_PROJECT_PROBE: 'HeptaMathlibReadiness.lean',
      },
      spawnSyncImpl: () => ({ status: 0, stdout: '', stderr: '' }),
      ...readyOptions(fakeClosure),
    });
    assert.equal(fakeManifest.ready, false, field);
    assert.ok(fakeManifest.blockers.includes(
      `production_mathlib_manifest_entry_field_mismatch:${field}`,
    ), field);
  }
});

test('immutable formal work roots are kernel-mounted read-only and reject writes', {
  timeout: 120_000,
}, (t) => {
  const dockerCommand = buildDockerWorkerCommand({
    limits: { memory: 1024, cpu: 1, pids: 8 },
    uid: 1000,
    gid: 1000,
    environment: [],
    requiresGpu: false,
    systemMounts: [],
    workRoot: '/fixture/work',
    outputRoot: '/fixture/output',
    supervisorRoot: '/fixture/supervisor',
    runtimeExecutableSnapshot: null,
    mountedDatasets: [],
    relativeCwd: '',
    containerImageDigest:
      SYSTEM_PINNED_FORMAL_SANDBOX_RUNTIME_CONFIGURATION.imageDigest,
    executable: '/bin/sh',
    arguments: ['-c', 'true'],
    immutableWorkRoot: true,
  });
  assert.ok(dockerCommand.includes('/fixture/work:/work:ro'));
  const bubblewrapCommand = buildBubblewrapWorkerCommand({
    limits: { memory: 1024, cpu: 1, pids: 8 },
    bubblewrap: 'bwrap',
    texMounts: [],
    runtimeMounts: [],
    workRoot: '/fixture/work',
    outputRoot: '/fixture/output',
    runtimeExecutableSnapshot: null,
    mountedDatasets: [],
    relativeCwd: '',
    requiresGpu: false,
    gpuDevices: [],
    environment: [],
    executable: '/bin/sh',
    arguments: ['-c', 'true'],
    immutableWorkRoot: true,
  });
  const binding = bubblewrapCommand.findIndex((entry, index) => (
    entry === '--ro-bind' && bubblewrapCommand[index + 1] === '/fixture/work'
      && bubblewrapCommand[index + 2] === '/work'
  ));
  assert.ok(binding >= 0);

  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-formal-ro-work-'));
  const sealedDependencyRoot = path.join(sourceRoot, 'sealed-dependency');
  t.after(() => {
    try { fs.chmodSync(sealedDependencyRoot, 0o700); } catch { /* already removed */ }
    fs.rmSync(sourceRoot, { recursive: true, force: true });
  });
  write(path.join(sourceRoot, 'input.txt'), 'immutable\n');
  write(path.join(sealedDependencyRoot, 'dependency.txt'), 'sealed\n');
  fs.chmodSync(sealedDependencyRoot, 0o500);
  const runtime = SYSTEM_PINNED_FORMAL_SANDBOX_RUNTIME_CONFIGURATION;
  const runner = createOsSandboxedWorkerRunner({
    allowedExecutables: ['/bin/sh'],
    allowedRoots: [sourceRoot],
    dockerImage: runtime.image,
    allowedContainerImages: [runtime.image],
    maximumTimeoutMs: 30_000,
  });
  if (runner.availability?.backend !== 'docker' || runner.availability?.available !== true) {
    t.skip('Docker sandbox unavailable');
    return;
  }
  const read = runner.run({
    executable: '/bin/sh',
    args: ['-c', 'test -r input.txt'],
    cwd: sourceRoot,
    sourceRoot,
    timeoutMs: 30_000,
    outputPaths: [],
    requireImmutableWorkRoot: true,
    language: 'shell',
    determinismPolicy: 'formal-readonly-work-root-test-v1',
  });
  assert.equal(read.ok, true, JSON.stringify(read.blockers));
  assert.equal(read.isolation.immutableWorkRootVerified, true);
  const writeAttempt = runner.run({
    executable: '/bin/sh',
    args: ['-c', 'printf forbidden > mutation.txt'],
    cwd: sourceRoot,
    sourceRoot,
    timeoutMs: 30_000,
    outputPaths: [],
    requireImmutableWorkRoot: true,
    language: 'shell',
    determinismPolicy: 'formal-readonly-work-root-test-v1',
  });
  assert.equal(writeAttempt.ok, false);
  assert.equal(writeAttempt.isolation.immutableWorkRootVerified, true);
  assert.equal(fs.existsSync(path.join(sourceRoot, 'mutation.txt')), false);
});
