import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { currentCodeProvenance } from '../src/code-provenance.mjs';
import {
  bindIdentityBoundTemporaryDirectory,
  createNonReentrantCleanup,
  prepareImmutableReleaseWorkspace,
} from '../../paper-adapters/runtime/immutable-release-workspace-repository.mjs';
import { isolatedVerificationCodeProvenanceMatches } from '../src/isolated-verification-receipt-contract.mjs';
import {
  assertReleaseDependencyTreeContract,
  buildReleaseDependencyTreeContract,
} from '../../paper-adapters/runtime/release-dependency-tree.mjs';
import { assertWorkspaceReleaseReady } from '../src/release-state-repository.mjs';
import { sha256StableFileSyncNoFollow } from '../../workflow-kernel/runtime/file-utils.mjs';

function git(root, ...args) {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
  assert.equal(result.status, 0, result.stderr);
  return String(result.stdout || '').trim();
}

function verificationProvenance(root) {
  return {
    ...currentCodeProvenance({ workspaceRoot: root, allowReleaseCommitEnvironment: false }),
    evidenceEnvironment: 'verification',
    evidenceClass: 'technical_conformance',
  };
}

function removeWritable(root) {
  if (!fs.existsSync(root)) return;
  const visit = (candidate) => {
    const stat = fs.lstatSync(candidate);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      fs.chmodSync(candidate, stat.mode | 0o700);
      for (const entry of fs.readdirSync(candidate)) visit(path.join(candidate, entry));
    } else fs.chmodSync(candidate, stat.mode | 0o600);
  };
  visit(root);
  fs.rmSync(root, { recursive: true, force: true });
}

function createFixture(t, { escapingDependencySymlink = false } = {}) {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'immutable-release-fixture-'));
  const candidateRoot = path.join(fixtureRoot, 'candidate');
  const temporaryParent = path.join(fixtureRoot, 'temporary');
  fs.mkdirSync(path.join(candidateRoot, 'paper-core', 'docs'), { recursive: true });
  fs.mkdirSync(path.join(candidateRoot, 'paper-core', 'config'), { recursive: true });
  fs.mkdirSync(path.join(candidateRoot, 'src'), { recursive: true });
  fs.mkdirSync(path.join(candidateRoot, 'node_modules', 'fixture-package'), { recursive: true });
  fs.mkdirSync(temporaryParent);
  fs.writeFileSync(path.join(candidateRoot, '.gitignore'), '/node_modules/\n');
  fs.writeFileSync(path.join(candidateRoot, 'package.json'), `${JSON.stringify({
    name: 'hepta-paper-workspace',
    version: '0.21.0',
    engines: { node: '>=22.23.1 <23' },
    packageManager: 'npm@10.9.8',
  })}\n`);
  fs.writeFileSync(path.join(candidateRoot, 'package-lock.json'), `${JSON.stringify({
    name: 'hepta-paper-workspace',
    version: '0.21.0',
    packages: { '': { name: 'hepta-paper-workspace', version: '0.21.0' } },
  })}\n`);
  fs.writeFileSync(
    path.join(candidateRoot, 'paper-core', 'docs', 'CURRENT_STATUS.md'),
    'Release state: finalized v0.21.0 source.\n',
  );
  fs.writeFileSync(
    path.join(candidateRoot, 'RELEASE.md'),
    'Version 0.21.0 is finalized from this exact source commit.\n',
  );
  fs.writeFileSync(
    path.join(candidateRoot, 'CHANGELOG.md'),
    '## 0.21.0 (finalized source)\n',
  );
  fs.writeFileSync(path.join(candidateRoot, 'src', 'index.mjs'), 'export const ready = true;\n');
  fs.writeFileSync(
    path.join(candidateRoot, 'node_modules', 'fixture-package', 'index.mjs'),
    'export const dependency = true;\n',
  );
  if (escapingDependencySymlink) {
    fs.symlinkSync('/etc/passwd', path.join(candidateRoot, 'node_modules', 'escape'));
  } else {
    fs.mkdirSync(path.join(candidateRoot, 'node_modules', '.bin'));
    fs.symlinkSync(
      '../fixture-package/index.mjs',
      path.join(candidateRoot, 'node_modules', '.bin', 'fixture-package'),
    );
  }
  const dependencyContract = buildReleaseDependencyTreeContract({
    workspaceRoot: candidateRoot,
    generatedAt: '2030-01-01T00:00:00.000Z',
  });
  fs.writeFileSync(
    path.join(candidateRoot, 'paper-core', 'config', 'release-dependency-tree.v1.json'),
    `${JSON.stringify(dependencyContract, null, 2)}\n`,
  );
  git(candidateRoot, 'init', '-q');
  git(candidateRoot, 'config', 'user.email', 'immutable-release@example.invalid');
  git(candidateRoot, 'config', 'user.name', 'Immutable Release Test');
  git(candidateRoot, 'add', '.');
  git(candidateRoot, 'commit', '-qm', 'immutable release fixture');
  git(candidateRoot, 'tag', 'fixture-anchor');
  const expectedCodeProvenance = verificationProvenance(candidateRoot);
  const expectedReleaseStateSnapshot = assertWorkspaceReleaseReady({
    workspaceRoot: candidateRoot,
  });
  t.after(() => removeWritable(fixtureRoot));
  return {
    fixtureRoot,
    candidateRoot,
    candidateWorkspaceRoot: candidateRoot,
    temporaryParent,
    expectedCodeProvenance,
    expectedReleaseStateSnapshot,
    codeProvenanceMatches: isolatedVerificationCodeProvenanceMatches,
    inspectReleaseState({ workspaceRoot, expectedSnapshotHash }) {
      return assertWorkspaceReleaseReady({ workspaceRoot, expectedSnapshotHash });
    },
  };
}

function writablePaths(root) {
  const writable = [];
  const visit = (candidate) => {
    const stat = fs.lstatSync(candidate);
    if (stat.isSymbolicLink()) return;
    if ((stat.mode & 0o222) !== 0) writable.push(candidate);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(candidate)) visit(path.join(candidate, entry));
    }
  };
  visit(root);
  return writable;
}

test('release workspace is an exact detached no-hardlink clone with read-only dependencies', (t) => {
  const fixture = createFixture(t);
  const prepared = prepareImmutableReleaseWorkspace(fixture);
  assert.equal(prepared.status, 'immutable_release_workspace_ready');
  assert.notEqual(fs.realpathSync(prepared.workspaceRoot), fs.realpathSync(fixture.candidateRoot));
  assert.equal(git(prepared.workspaceRoot, 'rev-parse', '--verify', 'HEAD^{commit}'),
    fixture.expectedCodeProvenance.commit);
  assert.equal(git(prepared.workspaceRoot, 'status', '--porcelain=v1'), '');
  assert.equal(git(prepared.workspaceRoot, 'check-ignore', '--no-index', 'node_modules'),
    'node_modules');
  assert.equal(fs.lstatSync(path.join(prepared.workspaceRoot, 'node_modules')).isSymbolicLink(), true);
  assert.ok(fs.realpathSync(path.join(prepared.workspaceRoot, 'node_modules'))
    .startsWith(`${path.dirname(prepared.workspaceRoot)}${path.sep}dependencies${path.sep}`));
  assert.deepEqual(writablePaths(prepared.workspaceRoot), []);
  assert.deepEqual(writablePaths(prepared.nodeModulesTarget), []);
  assert.equal(
    fs.readFileSync(path.join(prepared.workspaceRoot, 'node_modules', 'fixture-package', 'index.mjs'), 'utf8'),
    'export const dependency = true;\n',
  );
  const sourceDependencyIdentity = fs.statSync(path.join(
    fixture.candidateRoot,
    'node_modules',
    'fixture-package',
    'index.mjs',
  ));
  const copiedDependencyIdentity = fs.statSync(path.join(
    prepared.workspaceRoot,
    'node_modules',
    'fixture-package',
    'index.mjs',
  ));
  assert.notDeepEqual(
    [sourceDependencyIdentity.dev, sourceDependencyIdentity.ino],
    [copiedDependencyIdentity.dev, copiedDependencyIdentity.ino],
  );
  const candidateSourceIdentity = fs.statSync(path.join(
    fixture.candidateRoot,
    'src',
    'index.mjs',
  ));
  const immutableSourceIdentity = fs.statSync(path.join(
    prepared.workspaceRoot,
    'src',
    'index.mjs',
  ));
  assert.notDeepEqual(
    [candidateSourceIdentity.dev, candidateSourceIdentity.ino],
    [immutableSourceIdentity.dev, immutableSourceIdentity.ino],
  );
  assert.equal(
    prepared.dependencyTreeInspection.contractHash,
    prepared.dependencyTreeCopyInspection.contractHash,
  );
  assert.equal(
    prepared.dependencyTreeInspection.contractHash,
    prepared.immutableDependencyTreeInspection.contractHash,
  );
  assert.throws(() => fs.writeFileSync(
    path.join(prepared.workspaceRoot, 'src', 'index.mjs'),
    'mutated\n',
  ), /EACCES|EPERM/u);
  assert.throws(() => fs.writeFileSync(
    path.join(prepared.workspaceRoot, 'node_modules', 'fixture-package', 'index.mjs'),
    'mutated\n',
  ), /EACCES|EPERM/u);
  fs.writeFileSync(
    path.join(fixture.candidateRoot, 'node_modules', 'fixture-package', 'index.mjs'),
    'source dependency changed\n',
  );
  assert.equal(
    fs.readFileSync(path.join(prepared.workspaceRoot, 'node_modules', 'fixture-package', 'index.mjs'), 'utf8'),
    'export const dependency = true;\n',
  );
  const tempRoot = path.dirname(prepared.workspaceRoot);
  prepared.cleanup();
  prepared.cleanup();
  assert.equal(fs.existsSync(tempRoot), false);
});

test('provenance ignores host write bits but still binds the executable bit', (t) => {
  const fixture = createFixture(t);
  const trackedFile = path.join(fixture.candidateRoot, 'src', 'index.mjs');
  fs.chmodSync(trackedFile, 0o444);
  const readOnly = verificationProvenance(fixture.candidateRoot);
  assert.equal(isolatedVerificationCodeProvenanceMatches(
    fixture.expectedCodeProvenance,
    readOnly,
  ), true);
  assert.equal(readOnly.treeDirty, false);
  fs.chmodSync(trackedFile, 0o555);
  const executable = verificationProvenance(fixture.candidateRoot);
  assert.equal(executable.treeDirty, true);
  assert.notEqual(
    executable.repositoryContentHash,
    fixture.expectedCodeProvenance.repositoryContentHash,
  );
});

test('dependency contract ignores write bits but rejects executable-bit escalation', (t) => {
  const fixture = createFixture(t);
  const dependency = path.join(
    fixture.candidateRoot,
    'node_modules',
    'fixture-package',
    'index.mjs',
  );
  fs.chmodSync(dependency, 0o444);
  assert.equal(assertReleaseDependencyTreeContract({
    workspaceRoot: fixture.candidateRoot,
  }).status, 'release_dependency_tree_verified');
  fs.chmodSync(dependency, 0o555);
  assert.throws(() => assertReleaseDependencyTreeContract({
    workspaceRoot: fixture.candidateRoot,
  }), /release_dependency_tree_mismatch/u);
});

test('dependency contract rejects byte and symlink-target tampering', (t) => {
  const byteFixture = createFixture(t);
  fs.writeFileSync(
    path.join(byteFixture.candidateRoot, 'node_modules', 'fixture-package', 'index.mjs'),
    'export const dependency = false;\n',
  );
  assert.throws(() => assertReleaseDependencyTreeContract({
    workspaceRoot: byteFixture.candidateRoot,
  }), /release_dependency_tree_mismatch/u);

  const linkFixture = createFixture(t);
  const link = path.join(linkFixture.candidateRoot, 'node_modules', '.bin', 'fixture-package');
  fs.unlinkSync(link);
  fs.symlinkSync('../fixture-package/missing.mjs', link);
  assert.throws(() => assertReleaseDependencyTreeContract({
    workspaceRoot: linkFixture.candidateRoot,
  }), /release_dependency_tree_mismatch/u);
});

test('dependency contract binds the exact lockfile bytes', (t) => {
  const fixture = createFixture(t);
  fs.appendFileSync(path.join(fixture.candidateRoot, 'package-lock.json'), ' ');
  assert.throws(() => assertReleaseDependencyTreeContract({
    workspaceRoot: fixture.candidateRoot,
  }), /release_dependency_tree_lockfile_hash_mismatch/u);
});

test('dependency contract rejects symlinked contract, lockfile, and parent paths', (t) => {
  for (const target of ['contract', 'lockfile', 'parent']) {
    const fixture = createFixture(t);
    if (target === 'contract') {
      const file = path.join(
        fixture.candidateRoot,
        'paper-core',
        'config',
        'release-dependency-tree.v1.json',
      );
      fs.renameSync(file, `${file}.real`);
      fs.symlinkSync('release-dependency-tree.v1.json.real', file);
    } else if (target === 'lockfile') {
      const file = path.join(fixture.candidateRoot, 'package-lock.json');
      fs.renameSync(file, `${file}.real`);
      fs.symlinkSync('package-lock.json.real', file);
    } else {
      const directory = path.join(fixture.candidateRoot, 'paper-core', 'config');
      fs.renameSync(directory, `${directory}.real`);
      fs.symlinkSync('config.real', directory);
    }
    assert.throws(() => assertReleaseDependencyTreeContract({
      workspaceRoot: fixture.candidateRoot,
    }), /release_dependency_contract_path_unsafe/u);
  }
});

test('a full 13-field provenance mismatch fails closed and removes the temporary clone', (t) => {
  const fixture = createFixture(t);
  const captureCodeProvenance = (root) => {
    const captured = verificationProvenance(root);
    return path.resolve(root) === path.resolve(fixture.candidateRoot)
      ? captured
      : { ...captured, tags: [...captured.tags, 'forged-tag'].sort() };
  };
  assert.throws(() => prepareImmutableReleaseWorkspace({
    ...fixture,
    captureCodeProvenance,
  }), /immutable_release_workspace_code_provenance_mismatch/u);
  assert.deepEqual(fs.readdirSync(fixture.temporaryParent), []);
});

test('unsafe dependency symlinks fail closed without retaining a partial checkout', (t) => {
  const fixture = createFixture(t, { escapingDependencySymlink: true });
  assert.throws(() => prepareImmutableReleaseWorkspace(fixture),
    /immutable_release_workspace_dependency_absolute_symlink_forbidden/u);
  assert.deepEqual(fs.readdirSync(fixture.temporaryParent), []);
});

test('dependency source identity remains bound across contract inspection and copy', (t) => {
  const fixture = createFixture(t);
  const displaced = `${path.join(fixture.candidateRoot, 'node_modules')}.displaced`;
  let inspected = false;
  assert.throws(() => prepareImmutableReleaseWorkspace({
    ...fixture,
    verifyDependencyTree(options) {
      const inspection = assertReleaseDependencyTreeContract(options);
      if (!inspected) {
        inspected = true;
        fs.renameSync(options.nodeModulesPath, displaced);
        fs.cpSync(displaced, options.nodeModulesPath, {
          recursive: true,
          dereference: false,
          verbatimSymlinks: true,
        });
      }
      return inspection;
    },
  }), /immutable_release_workspace_node_modules_identity_changed/u);
  assert.equal(inspected, true);
  assert.deepEqual(fs.readdirSync(fixture.temporaryParent), []);
});

test('read-only conversion never follows a file replaced by an escaping symlink', (t) => {
  const fixture = createFixture(t);
  const outside = path.join(fixture.fixtureRoot, 'outside-preserve.txt');
  fs.writeFileSync(outside, 'outside\n', { mode: 0o600 });
  let injected = false;
  assert.throws(() => prepareImmutableReleaseWorkspace({
    ...fixture,
    modeMutationFaultInjector({ stage, scope, relative, candidate }) {
      if (injected || stage !== 'after_entry_lstat'
        || scope !== 'source' || relative !== 'src/index.mjs') return;
      injected = true;
      fs.renameSync(candidate, `${candidate}.displaced`);
      fs.symlinkSync(outside, candidate);
    },
  }), /ELOOP|immutable_release_workspace_entry_identity_changed/u);
  assert.equal(injected, true);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'outside\n');
  assert.equal(fs.statSync(outside).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(fixture.temporaryParent), []);
});

test('cleanup refuses a substituted temporary root and preserves both identities', (t) => {
  const fixture = createFixture(t);
  const prepared = prepareImmutableReleaseWorkspace(fixture);
  const tempRoot = path.dirname(prepared.workspaceRoot);
  const displaced = `${tempRoot}.displaced`;
  fs.renameSync(tempRoot, displaced);
  fs.mkdirSync(tempRoot);
  fs.writeFileSync(path.join(tempRoot, 'replacement-marker'), 'preserve\n');
  assert.throws(() => prepared.cleanup(),
    /immutable_release_workspace_temp_root_identity_changed/u);
  assert.equal(fs.readFileSync(path.join(tempRoot, 'replacement-marker'), 'utf8'), 'preserve\n');
  assert.equal(fs.existsSync(path.join(displaced, 'source')), true);
  fs.rmSync(tempRoot, { recursive: true, force: true });
  fs.renameSync(displaced, tempRoot);
  prepared.cleanup();
  assert.equal(fs.existsSync(tempRoot), false);
});

test('cleanup never restores over a path that reappears after quarantine', (t) => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-cleanup-race-'));
  t.after(() => removeWritable(fixtureRoot));
  const ownedRoot = path.join(fixtureRoot, 'owned');
  fs.mkdirSync(ownedRoot);
  fs.writeFileSync(path.join(ownedRoot, 'owned-marker'), 'owned\n');
  const binding = bindIdentityBoundTemporaryDirectory(ownedRoot);
  assert.throws(() => binding.cleanup({
    faultInjector({ stage }) {
      if (stage !== 'after_temp_root_quarantined') return;
      fs.mkdirSync(ownedRoot);
      fs.writeFileSync(path.join(ownedRoot, 'replacement-marker'), 'replacement\n');
    },
  }), /immutable_release_workspace_source_reappeared_after_quarantine/u);
  assert.equal(
    fs.readFileSync(path.join(ownedRoot, 'replacement-marker'), 'utf8'),
    'replacement\n',
  );
  const reservations = fs.readdirSync(fixtureRoot)
    .filter((name) => name.startsWith('.hepta-release-cleanup-'));
  assert.equal(reservations.length, 1);
  assert.equal(fs.readFileSync(path.join(
    fixtureRoot,
    reservations[0],
    'quarantined-root',
    'owned-marker',
  ), 'utf8'), 'owned\n');
});

test('cleanup detects a dangling symlink that reappears after quarantine', (t) => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-cleanup-link-race-'));
  t.after(() => removeWritable(fixtureRoot));
  const ownedRoot = path.join(fixtureRoot, 'owned');
  fs.mkdirSync(ownedRoot);
  fs.writeFileSync(path.join(ownedRoot, 'owned-marker'), 'owned\n');
  const binding = bindIdentityBoundTemporaryDirectory(ownedRoot);
  assert.throws(() => binding.cleanup({
    faultInjector({ stage }) {
      if (stage === 'after_temp_root_quarantined') {
        fs.symlinkSync(path.join(fixtureRoot, 'missing-target'), ownedRoot);
      }
    },
  }), /immutable_release_workspace_source_reappeared_after_quarantine/u);
  assert.equal(fs.lstatSync(ownedRoot).isSymbolicLink(), true);
  assert.equal(fs.existsSync(ownedRoot), false);
  assert.equal(
    fs.readdirSync(fixtureRoot).filter((name) => name.startsWith('.hepta-release-cleanup-')).length,
    1,
  );
});

test('cleanup restore never follows a regular file replaced by an escaping symlink', (t) => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-cleanup-mode-race-'));
  t.after(() => removeWritable(fixtureRoot));
  const ownedRoot = path.join(fixtureRoot, 'owned');
  const nested = path.join(ownedRoot, 'nested');
  const ownedFile = path.join(nested, 'owned.txt');
  const outside = path.join(fixtureRoot, 'outside.txt');
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(ownedFile, 'owned\n', { mode: 0o400 });
  fs.writeFileSync(outside, 'outside\n', { mode: 0o600 });
  const binding = bindIdentityBoundTemporaryDirectory(ownedRoot);
  let injected = false;
  assert.throws(() => binding.cleanup({
    faultInjector({ stage, relative, candidate }) {
      if (injected || stage !== 'after_entry_lstat' || relative !== 'nested/owned.txt') return;
      injected = true;
      fs.renameSync(candidate, `${candidate}.displaced`);
      fs.symlinkSync(outside, candidate);
    },
  }), /ELOOP|immutable_release_workspace_entry_identity_changed/u);
  assert.equal(injected, true);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'outside\n');
  assert.equal(fs.statSync(outside).mode & 0o777, 0o600);
  assert.equal(
    fs.readdirSync(fixtureRoot).filter((name) => name.startsWith('.hepta-release-cleanup-')).length,
    1,
  );
});

test('cleanup listeners are single-shot and non-reentrant', () => {
  let calls = 0;
  let cleanup;
  cleanup = createNonReentrantCleanup(() => {
    calls += 1;
    cleanup();
  });
  cleanup();
  cleanup();
  assert.equal(calls, 1);
});

test('stable file hashing streams exact bytes and refuses a final symlink', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stable-no-follow-hash-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'database.sqlite');
  const link = path.join(root, 'database-link.sqlite');
  const bytes = Buffer.alloc((2 * 1024 * 1024) + 17, 0x5a);
  fs.writeFileSync(file, bytes);
  fs.symlinkSync(file, link);
  assert.equal(
    sha256StableFileSyncNoFollow(file),
    `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`,
  );
  assert.throws(() => sha256StableFileSyncNoFollow(link), /ELOOP/u);
});
