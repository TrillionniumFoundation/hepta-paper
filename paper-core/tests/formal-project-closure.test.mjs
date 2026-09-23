import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  DEFAULT_MAXIMUM_FORMAL_PROJECT_FILES,
  readFormalProjectClosure,
} from '../../paper-adapters/research-verify/formal-project-closure-reader.mjs';
import { createFormalProjectSnapshotRepository } from '../../paper-adapters/research-verify/formal-project-snapshot-repository.mjs';
import {
  inspectWorkspaceExecutionSnapshot,
  sourceTreeExcludedNames,
} from '../../paper-adapters/runtime/execution-snapshot.mjs';
import { createLakeFormalVerifier } from '../../paper-adapters/research-verify/lake-formal-verifier.mjs';
import {
  DEFAULT_LAKE_FORMAL_BUILD_TIMEOUT_MS,
  MAXIMUM_LAKE_FORMAL_BUILD_TIMEOUT_MS,
  resolveLakeFormalBuildTimeout,
} from '../../paper-adapters/research-verify/lake-formal-worker.mjs';
import { hashBytes } from '../../workflow-kernel/record-hash.mjs';

function writeFile(filePath, content, mode = 0o644) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  fs.chmodSync(filePath, mode);
}

function formalDependencyFixture(t) {
  const scopeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-formal-closure-'));
  t.after(() => fs.rmSync(scopeRoot, { recursive: true, force: true }));
  const projectRoot = path.join(scopeRoot, 'project');
  const mathlibRoot = path.join(projectRoot, '.lake', 'packages', 'mathlib');
  const localDependencyRoot = path.join(scopeRoot, 'local-dependency');
  fs.mkdirSync(projectRoot, { recursive: true });
  writeFile(path.join(projectRoot, 'lakefile.lean'), 'import Lake\nopen Lake DSL\npackage Fixture where\n');
  writeFile(path.join(projectRoot, 'lean-toolchain'), 'leanprover/lean4:v4.30.0\n');
  writeFile(path.join(projectRoot, 'lake-manifest.json'), `${JSON.stringify({
    version: '1.1.0',
    packagesDir: '.lake/packages',
    packages: [
      { name: 'mathlib', dir: '.lake/packages/mathlib' },
      { name: 'localDependency', dir: '../local-dependency' },
    ],
    name: 'Fixture',
    lakeDir: '.lake',
  }, null, 2)}\n`);
  writeFile(path.join(projectRoot, 'Main.lean'), 'import Mathlib\ntheorem fixture : 1 = 1 := by rfl\n');
  writeFile(path.join(mathlibRoot, 'Mathlib.lean'), 'theorem dependencyFixture : True := by trivial\n');
  writeFile(path.join(mathlibRoot, 'scripts', 'generate.sh'), '#!/bin/sh\nexit 0\n', 0o777);
  writeFile(path.join(mathlibRoot, '.lake', 'build', 'stale.olean'), 'stale build output\n');
  writeFile(path.join(mathlibRoot, '.lake', 'lakefile.olean'), 'nested lake metadata\n');
  writeFile(path.join(localDependencyRoot, 'Local.lean'), 'theorem localFixture : True := by trivial\n', 0o640);
  return { scopeRoot, projectRoot, executable: path.join(mathlibRoot, 'scripts', 'generate.sh') };
}

test('formal closure default file ceiling admits an official Mathlib-sized workspace while remaining bounded', () => {
  assert.equal(DEFAULT_MAXIMUM_FORMAL_PROJECT_FILES, 150000);
});

test('formal snapshot seal excludes root runtime state but binds nested runtime code', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-formal-runtime-boundary-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files = [
    ['runtime/mutable-state.json', '{"state":1}\n'],
    ['paper-adapters/runtime/adapter.mjs', 'export const adapter = true;\n'],
    ['workflow-kernel/runtime/kernel.mjs', 'export const kernel = true;\n'],
  ];
  for (const [relative, content] of files) writeFile(path.join(root, relative), content);
  const snapshot = createFormalProjectSnapshotRepository().materialize({
    projectRoot: root,
    dependencyScopeRoot: root,
    projectFiles: files.map(([relative, content]) => ({
      path: relative,
      sourcePath: relative,
      projectPath: relative,
      hash: hashBytes(content),
      bytes: Buffer.byteLength(content),
      posixMode: 0o644,
      role: 'lean_source',
    })),
  });
  try {
    const seal = snapshot.seal();
    const executionSnapshot = inspectWorkspaceExecutionSnapshot(snapshot.scopeRoot, {
      excludeNames: sourceTreeExcludedNames(snapshot.scopeRoot),
    });
    assert.deepEqual(executionSnapshot.blockers, []);
    assert.equal(executionSnapshot.fileRecords.some(
      (entry) => entry.path === 'runtime/mutable-state.json',
    ), false);
    assert.equal(executionSnapshot.fileRecords.some(
      (entry) => entry.path === 'paper-adapters/runtime/adapter.mjs',
    ), true);
    assert.equal(executionSnapshot.fileRecords.some(
      (entry) => entry.path === 'workflow-kernel/runtime/kernel.mjs',
    ), true);
    assert.equal(seal.workspaceExecutionMerkleHash, executionSnapshot.merkleHash);
    assert.equal(seal.workspaceExecutionManifestHash, executionSnapshot.manifestHash);
  } finally {
    snapshot.cleanup();
  }
});

test('formal closure binds .lake package and external dependency modes while snapshots preserve only safe authority', async (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX file modes are required');
    return;
  }
  const fixture = formalDependencyFixture(t);
  const closure = await readFormalProjectClosure({
    projectRoot: fixture.projectRoot,
    dependencyScopeRoot: fixture.scopeRoot,
  });
  assert.equal(closure.status, 'formal_project_closure_verified', JSON.stringify(closure.blockers));
  const packageScript = closure.files.find((file) => file.projectPath === '.lake/packages/mathlib/scripts/generate.sh');
  const externalDependency = closure.files.find((file) => file.sourcePath === 'local-dependency/Local.lean');
  assert.equal(packageScript?.role, 'lake_package_dependency');
  assert.equal(packageScript?.posixMode, 0o777);
  assert.equal(externalDependency?.role, 'external_lake_dependency');
  assert.equal(externalDependency?.posixMode, 0o640);
  const compiledDependency = closure.files.find((file) => (
    file.sourcePath.endsWith('/.lake/build/stale.olean')
  ));
  assert.equal(compiledDependency?.role, 'lake_build_artifact');
  assert.equal(closure.lakeBuildArtifactFileCount, 1);
  const nestedLakefile = closure.files.find((file) => (
    file.sourcePath.endsWith('/mathlib/.lake/lakefile.olean')
  ));
  assert.equal(nestedLakefile?.role, 'lake_runtime_metadata');

  const repository = createFormalProjectSnapshotRepository();
  const snapshot = repository.materialize({
    projectRoot: fixture.projectRoot,
    dependencyScopeRoot: fixture.scopeRoot,
    projectFiles: closure.files,
  });
  try {
    const snapshotExecutable = path.join(snapshot.root, '.lake', 'packages', 'mathlib', 'scripts', 'generate.sh');
    const snapshotExternal = path.join(snapshot.scopeRoot, 'local-dependency', 'Local.lean');
    assert.equal(fs.statSync(snapshotExecutable).mode & 0o777, 0o555,
      'all baseline write authority must be stripped');
    assert.equal(fs.statSync(snapshotExternal).mode & 0o777, 0o440,
      'external dependency snapshots must be read-only');
    assert.equal(fs.readFileSync(path.join(
      snapshot.root,
      '.lake/packages/mathlib/.lake/build/stale.olean',
    ), 'utf8'), 'stale build output\n');
    assert.ok(fs.statSync(path.join(
      snapshot.root,
      '.lake/packages/mathlib/.lake/lakefile.olean',
    )).mtimeMs > fs.statSync(path.join(
      snapshot.root,
      '.lake/packages/mathlib/Mathlib.lean',
    )).mtimeMs, 'compiled metadata must have a deterministic later mtime');
    const seal = snapshot.seal();
    assert.equal(seal.writableFileCount, 0);
    assert.equal(seal.writableDirectoryCount, 0);
    const executionSnapshot = inspectWorkspaceExecutionSnapshot(
      snapshot.scopeRoot,
      { excludeNames: sourceTreeExcludedNames(snapshot.scopeRoot) },
    );
    assert.deepEqual(executionSnapshot.blockers, []);
    assert.equal(
      seal.workspaceExecutionMerkleHash,
      executionSnapshot.merkleHash,
    );
    assert.equal(
      seal.workspaceExecutionManifestHash,
      executionSnapshot.manifestHash,
    );
  } finally {
    snapshot.cleanup();
  }

  fs.chmodSync(fixture.executable, 0o755);
  const changedModeClosure = await readFormalProjectClosure({
    projectRoot: fixture.projectRoot,
    dependencyScopeRoot: fixture.scopeRoot,
  });
  const changedPackageScript = changedModeClosure.files.find((file) => file.projectPath === '.lake/packages/mathlib/scripts/generate.sh');
  assert.equal(changedPackageScript.hash, packageScript.hash, 'content is intentionally unchanged');
  assert.equal(changedPackageScript.posixMode, 0o755);
  assert.notEqual(changedModeClosure.manifestHash, closure.manifestHash);
  assert.notEqual(changedModeClosure.formalProjectClosureHash, closure.formalProjectClosureHash);
  assert.throws(() => repository.materialize({
    projectRoot: fixture.projectRoot,
    dependencyScopeRoot: fixture.scopeRoot,
    projectFiles: closure.files,
  }), /formal_project_snapshot_mode_mismatch/);

  writeFile(path.join(
    fixture.projectRoot,
    '.lake/packages/mathlib/.lake/build/stale.olean',
  ), 'changed compiled dependency\n');
  const changedBuildClosure = await readFormalProjectClosure({
    projectRoot: fixture.projectRoot,
    dependencyScopeRoot: fixture.scopeRoot,
  });
  assert.notEqual(changedBuildClosure.manifestHash, changedModeClosure.manifestHash);
  assert.notEqual(changedBuildClosure.formalProjectClosureHash,
    changedModeClosure.formalProjectClosureHash);
});

test('Lake formal build timeout has a Mathlib-sized default, a hard ceiling, and fail-closed parsing', () => {
  assert.equal(DEFAULT_LAKE_FORMAL_BUILD_TIMEOUT_MS, 60 * 60 * 1000);
  assert.equal(MAXIMUM_LAKE_FORMAL_BUILD_TIMEOUT_MS, 2 * 60 * 60 * 1000);
  assert.deepEqual(resolveLakeFormalBuildTimeout({ configuredDefaultTimeoutMs: null }), {
    status: 'formal_build_timeout_verified',
    timeoutMs: DEFAULT_LAKE_FORMAL_BUILD_TIMEOUT_MS,
    maximumTimeoutMs: MAXIMUM_LAKE_FORMAL_BUILD_TIMEOUT_MS,
    blockers: [],
  });
  assert.equal(resolveLakeFormalBuildTimeout({
    configuredDefaultTimeoutMs: 45 * 60 * 1000,
  }).timeoutMs, 45 * 60 * 1000);
  assert.equal(resolveLakeFormalBuildTimeout({
    configuredDefaultTimeoutMs: 45 * 60 * 1000,
    requestedTimeoutMs: 30 * 60 * 1000,
  }).timeoutMs, 30 * 60 * 1000);
  assert.deepEqual(resolveLakeFormalBuildTimeout({ requestedTimeoutMs: 'not-a-number' }).blockers, [
    'formal_build_timeout_request_invalid',
  ]);
  assert.deepEqual(resolveLakeFormalBuildTimeout({
    configuredDefaultTimeoutMs: MAXIMUM_LAKE_FORMAL_BUILD_TIMEOUT_MS + 1,
  }).blockers, [
    'formal_build_timeout_configuration_exceeds_limit',
  ]);
  assert.deepEqual(resolveLakeFormalBuildTimeout({
    requestedTimeoutMs: MAXIMUM_LAKE_FORMAL_BUILD_TIMEOUT_MS + 1,
  }).blockers, [
    'formal_build_timeout_request_exceeds_limit',
  ]);
});

test('immutable Lake verification rejects an empty audit target set after sealing and before execution', async (t) => {
  const fixture = formalDependencyFixture(t);
  const toolchainIdentity = Object.freeze({
    status: 'lean_toolchain_identity_verified',
    toolchain: 'leanprover/lean4:v4.30.0',
    leanToolchainContentIdentityHash:
      'sha256:fixture-immutable-toolchain-content',
    blockers: Object.freeze([]),
  });
  let sealed = 0;
  let cleaned = 0;
  const verifier = createLakeFormalVerifier({
    projectRoot: fixture.projectRoot,
    dependencyScopeRoot: fixture.scopeRoot,
    requireImmutableExecutionClosure: true,
    toolchainIdentityProvider: Object.freeze({
      inspect: () => toolchainIdentity,
    }),
    projectSnapshotRepository: Object.freeze({
      materialize() {
        return Object.freeze({
          root: fixture.projectRoot,
          scopeRoot: fixture.scopeRoot,
          seal() {
            sealed += 1;
            return Object.freeze({
              writableFileCount: 0,
              writableDirectoryCount: 0,
              formalProjectSnapshotSealReceiptHash:
                'sha256:fixture-immutable-snapshot-seal',
            });
          },
          cleanup() { cleaned += 1; },
        });
      },
    }),
    commandRunnerFactory() {
      throw new Error('immutable_fixture_runner_must_not_be_created');
    },
  });
  const result = await verifier.verify({ claimBindings: [] });
  assert.equal(result.status, 'formal_certificate_blocked');
  assert.ok(result.blockers.includes(
    'formal_immutable_execution_audit_target_required',
  ));
  assert.equal(sealed, 1);
  assert.equal(cleaned, 1);

  const unsealedVerifier = createLakeFormalVerifier({
    projectRoot: fixture.projectRoot,
    dependencyScopeRoot: fixture.scopeRoot,
    requireImmutableExecutionClosure: true,
    toolchainIdentityProvider: Object.freeze({
      inspect: () => toolchainIdentity,
    }),
    projectSnapshotRepository: Object.freeze({
      materialize() {
        return Object.freeze({
          root: fixture.projectRoot,
          scopeRoot: fixture.scopeRoot,
          seal: () => Object.freeze({
            writableFileCount: 1,
            writableDirectoryCount: 0,
            formalProjectSnapshotSealReceiptHash:
              'sha256:fixture-writable-snapshot-seal',
          }),
          cleanup() {},
        });
      },
    }),
    commandRunnerFactory() {
      throw new Error('unsealed_fixture_runner_must_not_be_created');
    },
  });
  const unsealed = await unsealedVerifier.verify({ claimBindings: [] });
  assert.equal(unsealed.status, 'formal_certificate_blocked');
  assert.ok(unsealed.blockers.includes(
    'formal_immutable_execution_snapshot_not_sealed',
  ));
});

test('Lake replay rejects a mode-only change in a package dependency before re-execution', async (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX file modes are required');
    return;
  }
  const fixture = formalDependencyFixture(t);
  let executionCount = 0;
  const toolchainIdentity = Object.freeze({
    status: 'lean_toolchain_identity_verified',
    toolchain: 'leanprover/lean4:v4.30.0',
    leanToolchainContentIdentityHash: 'sha256:fixture-toolchain-content',
    blockers: [],
  });
  const verifier = createLakeFormalVerifier({
    projectRoot: fixture.projectRoot,
    dependencyScopeRoot: fixture.scopeRoot,
    toolchainIdentityProvider: Object.freeze({ inspect: () => toolchainIdentity }),
    commandRunnerFactory: () => Object.freeze({
      async run() {
        executionCount += 1;
        return {
          ok: true,
          receiptHash: 'sha256:fixture-formal-execution',
          runnerId: 'fixture-formal-runner',
          backend: 'fixture',
          runtimeIdentityType: 'fixture',
          runtimeIdentityHash: 'sha256:fixture-runtime',
          runtimeExecutableSnapshotHash: 'sha256:fixture-lake',
          runtimeExecutableInvocationPath: '/fixture/lake',
          containerImageDigest: null,
        };
      },
    }),
  });
  const certificate = await verifier.verify();
  assert.equal(certificate.status, 'formal_build_verified', JSON.stringify(certificate.blockers));
  assert.equal(executionCount, 1);
  fs.chmodSync(fixture.executable, 0o755);
  const replay = await verifier.replay({ certificateBundle: certificate });
  assert.equal(replay.status, 'formal_certificate_replay_blocked');
  assert.ok(replay.blockers.includes('formal_input_mode_mismatch:.lake/packages/mathlib/scripts/generate.sh'));
  assert.equal(executionCount, 1, 'mode drift must be rejected before invoking Lake again');
});
