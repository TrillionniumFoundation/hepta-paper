import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  assertCapabilityVerificationCodeProvenanceUnchanged,
  assertProductionCapabilityRefreshCodeProvenance,
  capabilityVerificationCodeProvenance,
  capabilityVerificationCodeProvenanceHash,
  createCapabilityReplayArtifactPublisher,
  executeCapabilityVerification,
  validateCapabilityOperationalEvidence,
} from '../../migration/capability-operational-evidence.mjs';
import { CAPABILITY_CATALOG } from '../../paper-domain/governance/capability-catalog.mjs';
import { currentCodeProvenance } from '../../paper-adapters/runtime/code-provenance.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const workspaceRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const SHA = (label) => `sha256:${crypto.createHash('sha256').update(label).digest('hex')}`;
const fileHash = (candidate) => `sha256:${crypto.createHash('sha256')
  .update(fs.readFileSync(candidate)).digest('hex')}`;

function executableOnPath(name) {
  for (const directory of String(process.env.PATH || '').split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.realpathSync(candidate);
    } catch {
      // Continue searching the configured executable path.
    }
  }
  throw new Error(`test_executable_not_found:${name}`);
}

const REAL_GIT = executableOnPath('git');

function fixtureGit(root, ...args) {
  const result = spawnSync(REAL_GIT, args, {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return String(result.stdout || '').trim();
}

function createProvenanceRepository(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'code-provenance-controlled-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'package.json'), '{"version":"1.2.3"}\n');
  fs.writeFileSync(path.join(root, 'source.mjs'), 'export const value = 1;\n');
  fixtureGit(root, 'init', '-q');
  fixtureGit(root, 'config', 'user.email', 'provenance@example.invalid');
  fixtureGit(root, 'config', 'user.name', 'Provenance Test');
  fixtureGit(root, 'add', '.');
  fixtureGit(root, 'commit', '-qm', 'fixture');
  return root;
}

function installGitWrapper(t, body) {
  const wrapperRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'code-provenance-git-'));
  const wrapperPath = path.join(wrapperRoot, 'git');
  const priorPath = process.env.PATH;
  const source = `#!${process.execPath}
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const realGit = ${JSON.stringify(REAL_GIT)};
const args = process.argv.slice(2);
function runReal(candidateArgs = args) {
  return spawnSync(realGit, candidateArgs, {
    cwd: process.cwd(),
    env: process.env,
    encoding: null,
  });
}
function emit(result) {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  process.exitCode = Number.isInteger(result.status) ? result.status : 70;
}
${body}
`;
  fs.writeFileSync(wrapperPath, source, { mode: 0o700 });
  process.env.PATH = `${wrapperRoot}${path.delimiter}${priorPath || ''}`;
  t.after(() => {
    if (priorPath === undefined) delete process.env.PATH;
    else process.env.PATH = priorPath;
    fs.rmSync(wrapperRoot, { recursive: true, force: true });
  });
}

function provenance(label = 'current', overrides = {}) {
  return capabilityVerificationCodeProvenance({
    version: 2,
    kind: 'CodeProvenance',
    packageVersion: '0.21.0',
    commit: crypto.createHash('sha1').update(`${label}:commit`).digest('hex'),
    commitTree: crypto.createHash('sha1').update(`${label}:tree`).digest('hex'),
    treeDirty: false,
    indexStateHash: SHA(`${label}:index`),
    repositoryEntryCount: 2_000,
    repositoryContentHash: SHA(`${label}:repository`),
    worktreeStateHash: SHA(`${label}:worktree`),
    ...overrides,
  });
}

function evidence(codeProvenance = provenance()) {
  const [capabilityId, catalog] = Object.entries(CAPABILITY_CATALOG)[0];
  const testPath = `migration/tests/capabilities/${capabilityId}.test.mjs`;
  const receiptPayload = {
    version: 2,
    kind: 'CapabilityVerificationReceipt',
    capabilityId,
    status: 'capability_implementation_verified',
    executedAt: '2026-08-01T00:00:00.000Z',
    test: {
      path: testPath,
      sha256: fileHash(path.join(workspaceRoot, testPath)),
      result: 'passed',
      exitCode: 0,
      stdoutHash: SHA('stdout'),
      stderrHash: SHA('stderr'),
    },
    targets: [{
      path: catalog.target,
      sha256: fileHash(path.join(workspaceRoot, catalog.target)),
    }],
    executionClass: 'release_capability_conformance',
    conformanceProof: false,
    conformanceReceiptHashes: [],
    conformanceIssuerAssurances: [],
    operationalProof: false,
    operationalReceiptHashes: [],
    externalActionPerformed: false,
    codeProvenance,
    codeProvenanceHash: capabilityVerificationCodeProvenanceHash(codeProvenance),
  };
  const receipt = {
    ...receiptPayload,
    capabilityVerificationReceiptHash: hashRecord(
      'CapabilityVerificationReceipt',
      receiptPayload,
    ),
    ledgerReceiptId: 'capability-verification:test',
  };
  const manifestPayload = {
    version: 2,
    kind: 'CapabilityVerificationManifest',
    status: 'capability_verification_complete',
    generatedAt: '2026-08-01T00:00:01.000Z',
    capabilityCount: 1,
    passedCount: 1,
    codeProvenance,
    codeProvenanceHash: capabilityVerificationCodeProvenanceHash(codeProvenance),
    receipts: [receipt],
  };
  return {
    ...manifestPayload,
    capabilityVerificationManifestHash: hashRecord(
      'CapabilityVerificationManifest',
      manifestPayload,
    ),
  };
}

function rehashManifest(manifest) {
  const { capabilityVerificationManifestHash: ignored, ...payload } = manifest;
  return {
    ...payload,
    capabilityVerificationManifestHash: hashRecord('CapabilityVerificationManifest', payload),
  };
}

test('implementation evidence binds the exact current code identity and manifest hash', () => {
  const codeProvenance = provenance();
  const manifest = evidence(codeProvenance);
  const accepted = validateCapabilityOperationalEvidence({
    evidence: manifest,
    codeProvenance,
  });
  assert.equal(accepted.size, 1);

  assert.equal(validateCapabilityOperationalEvidence({
    evidence: { ...manifest, capabilityVerificationManifestHash: SHA('tampered') },
    codeProvenance,
  }).size, 0);
  assert.equal(validateCapabilityOperationalEvidence({
    evidence: manifest,
    codeProvenance: provenance('other'),
  }).size, 0);
});

test('raw release-current capability evidence is never an audit-manifest fallback', (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'capability-evidence-selection-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const codeProvenance = provenance();
  const manifest = evidence(codeProvenance);
  const rawReleaseCurrent = path.join(
    runtimeRoot,
    'release-evidence',
    'current',
    'CAPABILITY_VERIFICATION_MANIFEST.json',
  );
  fs.mkdirSync(path.dirname(rawReleaseCurrent), { recursive: true });
  fs.writeFileSync(rawReleaseCurrent, `${JSON.stringify(manifest)}\n`);
  assert.equal(validateCapabilityOperationalEvidence({
    runtimeRoot,
    codeProvenance,
  }).size, 0);

  const auditManifest = path.join(
    runtimeRoot,
    'audits',
    'capability-verification',
    'CAPABILITY_VERIFICATION_MANIFEST.json',
  );
  fs.mkdirSync(path.dirname(auditManifest), { recursive: true });
  fs.writeFileSync(auditManifest, `${JSON.stringify(manifest)}\n`);
  assert.equal(validateCapabilityOperationalEvidence({
    runtimeRoot,
    codeProvenance,
  }).size, 1);

  const outside = path.join(os.tmpdir(), `capability-evidence-outside-${crypto.randomUUID()}.json`);
  fs.writeFileSync(outside, `${JSON.stringify(manifest)}\n`);
  t.after(() => fs.rmSync(outside, { force: true }));
  fs.unlinkSync(auditManifest);
  fs.symlinkSync(outside, auditManifest);
  assert.equal(validateCapabilityOperationalEvidence({
    runtimeRoot,
    codeProvenance,
  }).size, 0);
});

test('legacy or independently rebound receipt provenance fails closed', () => {
  const codeProvenance = provenance();
  const manifest = evidence(codeProvenance);
  const legacy = { ...manifest };
  delete legacy.codeProvenance;
  delete legacy.codeProvenanceHash;
  assert.equal(validateCapabilityOperationalEvidence({
    evidence: rehashManifest(legacy),
    codeProvenance,
  }).size, 0);
  assert.equal(validateCapabilityOperationalEvidence({
    evidence: rehashManifest({ ...manifest, version: 1 }),
    codeProvenance,
  }).size, 0);

  const changed = provenance('changed-receipt');
  const receipt = { ...manifest.receipts[0], codeProvenance: changed };
  receipt.codeProvenanceHash = capabilityVerificationCodeProvenanceHash(changed);
  const { capabilityVerificationReceiptHash: ignored, ledgerReceiptId, ...payload } = receipt;
  receipt.capabilityVerificationReceiptHash = hashRecord('CapabilityVerificationReceipt', payload);
  receipt.ledgerReceiptId = ledgerReceiptId;
  assert.equal(validateCapabilityOperationalEvidence({
    evidence: rehashManifest({ ...manifest, receipts: [receipt] }),
    codeProvenance,
  }).size, 0);
});

test('production refresh accepts only a clean real-HEAD identity', () => {
  const clean = provenance();
  assert.deepEqual(assertProductionCapabilityRefreshCodeProvenance({
    codeProvenance: clean,
    declaredReleaseCommit: clean.commit,
  }), clean);
  assert.throws(() => assertProductionCapabilityRefreshCodeProvenance({
    codeProvenance: provenance('dirty', { treeDirty: true }),
  }), /production_capability_refresh_clean_commit_required/);
  assert.throws(() => assertProductionCapabilityRefreshCodeProvenance({
    codeProvenance: clean,
    declaredReleaseCommit: 'f'.repeat(40),
  }), /production_capability_refresh_release_commit_mismatch/);

  const prior = process.env.HEPTA_RELEASE_COMMIT;
  try {
    process.env.HEPTA_RELEASE_COMMIT = 'f'.repeat(40);
    assert.equal(currentCodeProvenance().commit, 'f'.repeat(40));
    assert.notEqual(currentCodeProvenance({
      allowReleaseCommitEnvironment: false,
    }).commit, 'f'.repeat(40));
  } finally {
    if (prior === undefined) delete process.env.HEPTA_RELEASE_COMMIT;
    else process.env.HEPTA_RELEASE_COMMIT = prior;
  }
});

test('production refresh binds evidence classification before provenance and defers current publication', () => {
  const source = fs.readFileSync(
    path.join(workspaceRoot, 'migration', 'bin', 'refresh-production-capability-verification.mjs'),
    'utf8',
  );
  const environmentIndex = source.indexOf("process.env.HEPTA_EVIDENCE_ENVIRONMENT = 'production_source_bound'");
  const provenanceIndex = source.indexOf('const codeProvenance = assertProductionCapabilityRefreshCodeProvenance');
  assert.ok(environmentIndex >= 0 && provenanceIndex > environmentIndex);
  assert.doesNotMatch(source, /release_current_capability_verification_manifest/u);
  assert.match(source, /releaseCurrentPublication: 'deferred_to_signed_isolated_verification_pointer'/u);
});

test('code provenance binds a stable clean, dirty, staged, and untracked repository state', (t) => {
  const root = createProvenanceRepository(t);
  const clean = currentCodeProvenance({
    workspaceRoot: root,
    allowReleaseCommitEnvironment: false,
  });
  assert.equal(clean.commit, fixtureGit(root, 'rev-parse', 'HEAD'));
  assert.equal(clean.commitTree, fixtureGit(root, 'rev-parse', 'HEAD^{tree}'));
  assert.equal(clean.treeDirty, false);
  assert.equal(clean.repositoryEntryCount, 2);

  fs.writeFileSync(path.join(root, 'source.mjs'), 'export const value = 2;\n');
  fs.writeFileSync(path.join(root, 'untracked.txt'), 'untracked\n');
  const dirty = currentCodeProvenance({
    workspaceRoot: root,
    allowReleaseCommitEnvironment: false,
  });
  assert.equal(dirty.treeDirty, true);
  assert.equal(dirty.repositoryEntryCount, 3);
  assert.notEqual(dirty.repositoryContentHash, clean.repositoryContentHash);
  assert.notEqual(dirty.worktreeStateHash, clean.worktreeStateHash);

  fixtureGit(root, 'add', 'source.mjs');
  const staged = currentCodeProvenance({
    workspaceRoot: root,
    allowReleaseCommitEnvironment: false,
  });
  assert.equal(staged.treeDirty, true);
  assert.equal(staged.repositoryEntryCount, dirty.repositoryEntryCount);
  assert.notEqual(staged.indexStateHash, dirty.indexStateHash);
  assert.notEqual(staged.repositoryContentHash, dirty.repositoryContentHash);
});

test('code provenance exposes only a bounded error when a required Git command fails', (t) => {
  const root = createProvenanceRepository(t);
  const secret = 'private-git-stderr-material';
  installGitWrapper(t, `
if (args[0] === 'status') {
  process.stderr.write(${JSON.stringify(secret)});
  process.exitCode = 17;
} else {
  emit(runReal());
}
`);
  assert.throws(() => currentCodeProvenance({
    workspaceRoot: root,
    allowReleaseCommitEnvironment: false,
  }), (error) => {
    assert.match(
      error.message,
      /^code_provenance_git_command_failed:worktree_status:exit_17:stderr_[0-9a-f]{64}$/,
    );
    assert.equal(error.stderrHash, SHA(secret));
    assert.doesNotMatch(error.message, /private-git-stderr-material/);
    return true;
  });
});

test('code provenance rejects empty required Git identity output', (t) => {
  const root = createProvenanceRepository(t);
  installGitWrapper(t, `
if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
  process.exitCode = 0;
} else {
  emit(runReal());
}
`);
  assert.throws(() => currentCodeProvenance({
    workspaceRoot: root,
    allowReleaseCommitEnvironment: false,
  }), /code_provenance_git_output_required:head/);
});

test('a scan-time content mutation and restoration forces a complete snapshot retry', (t) => {
  const root = createProvenanceRepository(t);
  const sourcePath = path.join(root, 'source.mjs');
  const counterPath = path.join(root, '.git', 'provenance-test-counter');
  const expected = currentCodeProvenance({
    workspaceRoot: root,
    allowReleaseCommitEnvironment: false,
  });
  installGitWrapper(t, `
const counterPath = ${JSON.stringify(counterPath)};
const sourcePath = ${JSON.stringify(sourcePath)};
const count = Number(fs.existsSync(counterPath) ? fs.readFileSync(counterPath, 'utf8') : 0) + 1;
fs.writeFileSync(counterPath, String(count));
const result = runReal();
if (count === 6) fs.writeFileSync(sourcePath, 'export const value = 999;\\n');
if (count === 12) fs.writeFileSync(sourcePath, 'export const value = 1;\\n');
emit(result);
`);
  const actual = currentCodeProvenance({
    workspaceRoot: root,
    allowReleaseCommitEnvironment: false,
  });
  assert.equal(actual.treeDirty, false);
  assert.equal(actual.repositoryContentHash, expected.repositoryContentHash);
  assert.equal(actual.worktreeStateHash, expected.worktreeStateHash);
  assert.ok(Number(fs.readFileSync(counterPath, 'utf8')) >= 24);
});

test('a tag mutation between samples is retried and then bound into provenance', (t) => {
  const root = createProvenanceRepository(t);
  const counterPath = path.join(root, '.git', 'provenance-tag-counter');
  installGitWrapper(t, `
const counterPath = ${JSON.stringify(counterPath)};
const count = Number(fs.existsSync(counterPath) ? fs.readFileSync(counterPath, 'utf8') : 0) + 1;
fs.writeFileSync(counterPath, String(count));
const result = runReal();
if (count === 3) {
  const mutation = runReal(['tag', 'provenance-race-tag']);
  if (mutation.status !== 0) emit(mutation);
}
emit(result);
`);
  const actual = currentCodeProvenance({
    workspaceRoot: root,
    allowReleaseCommitEnvironment: false,
  });
  assert.deepEqual(actual.tags, ['provenance-race-tag']);
  assert.ok(Number(fs.readFileSync(counterPath, 'utf8')) >= 24);
});

test('continuously changing tag state exhausts the finite provenance retry budget', (t) => {
  const root = createProvenanceRepository(t);
  installGitWrapper(t, `
if (args[0] === 'tag' && args[1] === '--points-at') {
  const present = runReal(['show-ref', '--verify', '--quiet', 'refs/tags/provenance-flapping-tag']);
  const mutation = present.status === 0
    ? runReal(['tag', '-d', 'provenance-flapping-tag'])
    : runReal(['tag', 'provenance-flapping-tag']);
  if (mutation.status !== 0) {
    emit(mutation);
  } else {
    emit(runReal());
  }
} else {
  emit(runReal());
}
`);
  assert.throws(() => currentCodeProvenance({
    workspaceRoot: root,
    allowReleaseCommitEnvironment: false,
  }), /^Error: code_provenance_snapshot_unstable$/);
});

test('preflight and postflight require the complete exact clean provenance', () => {
  const selected = provenance();
  assert.deepEqual(assertCapabilityVerificationCodeProvenanceUnchanged({
    expected: selected,
    actual: selected,
    phase: 'postflight',
  }), selected);
  assert.throws(() => assertCapabilityVerificationCodeProvenanceUnchanged({
    expected: selected,
    actual: provenance('stale'),
    phase: 'postflight',
  }), /capability_verification_code_provenance_changed:postflight/);
  assert.throws(() => assertCapabilityVerificationCodeProvenanceUnchanged({
    expected: selected,
    actual: provenance('dirty-postflight', { treeDirty: true }),
    phase: 'postflight',
  }), /capability_verification_code_provenance_changed:postflight/);
});

test('verification performs exact provenance preflight before ledger or artifact writes', async () => {
  const selected = provenance();
  let ledgerWrites = 0;
  let artifactRepositories = 0;
  await assert.rejects(() => executeCapabilityVerification({
    runtimeRoot: '/not-used-after-preflight',
    receiptLedger: {
      record() {
        ledgerWrites += 1;
        return { receiptId: 'unexpected' };
      },
    },
    artifactRepositoryFactory() {
      artifactRepositories += 1;
      throw new Error('artifact repository must not be created');
    },
    clock: { nowIso: () => '2026-08-01T00:00:00.000Z' },
    capabilityCatalog: {},
    codeProvenance: selected,
    codeProvenanceProvider: () => provenance('stale-preflight'),
  }), /capability_verification_code_provenance_changed:preflight/);
  assert.equal(ledgerWrites, 0);
  assert.equal(artifactRepositories, 0);
});

test('staged capability artifacts publish atomically without clobbering', async (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'capability-replay-publish-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const publisher = createCapabilityReplayArtifactPublisher({
    runtimeRoot,
    publicationId: 'successful-publication',
  });
  const first = publisher.stageJson('replays/example/a.json', { value: 1 });
  const second = publisher.stageJson('CAPABILITY_CONFORMANCE_REPLAY_MANIFEST_aaaaaaaaaaaa.json', { value: 2 });
  const receipt = await publisher.publish({
    relativePaths: [first.relativePath, second.relativePath],
  });
  assert.equal(receipt.status, 'capability_replay_artifacts_published');
  assert.equal(receipt.atomicNoClobber, true);
  for (const candidate of receipt.publishedPaths) {
    assert.equal(fs.statSync(candidate).mode & 0o777, 0o400);
  }
  assert.equal(fs.existsSync(publisher.stagingRoot), false);
});

test('publisher rejects same-inode staged content drift', async (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'capability-replay-content-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const publisher = createCapabilityReplayArtifactPublisher({
    runtimeRoot,
    publicationId: 'content-drift-publication',
  });
  const staged = publisher.stageJson('capabilities/example/a.json', { value: 'intended' });
  const stagingPath = path.join(publisher.stagingRoot, ...staged.relativePath.split('/'));
  fs.chmodSync(stagingPath, 0o600);
  fs.writeFileSync(stagingPath, '{"value":"raced"}\n');
  fs.chmodSync(stagingPath, 0o400);
  await assert.rejects(() => publisher.publish({
    relativePaths: [staged.relativePath],
  }), /capability_replay_staging_artifact_content_changed/);
  assert.equal(
    fs.existsSync(path.join(publisher.proofRoot, ...staged.relativePath.split('/'))),
    false,
  );
  publisher.discard();
});

test('no-clobber race rolls back only artifacts linked by the publisher', async (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'capability-replay-race-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const publisher = createCapabilityReplayArtifactPublisher({
    runtimeRoot,
    publicationId: 'racing-publication',
  });
  const first = publisher.stageJson('capabilities/example/a.json', { value: 1 });
  const second = publisher.stageJson('capabilities/example/b.json', { value: 2 });
  const racedTarget = path.join(publisher.proofRoot, ...second.relativePath.split('/'));
  await assert.rejects(() => publisher.publish({
    relativePaths: [first.relativePath, second.relativePath],
    beforePublish() {
      fs.writeFileSync(racedTarget, 'racing-writer\n', { flag: 'wx', mode: 0o600 });
    },
  }), /capability_replay_no_clobber_conflict/);
  assert.equal(fs.existsSync(path.join(publisher.proofRoot, ...first.relativePath.split('/'))), false);
  assert.equal(fs.readFileSync(racedTarget, 'utf8'), 'racing-writer\n');
});

test('rollback preserves a writer that replaces a just-published artifact', async (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'capability-replay-rollback-race-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const publisher = createCapabilityReplayArtifactPublisher({
    runtimeRoot,
    publicationId: 'rollback-race-publication',
  });
  const first = publisher.stageJson('capabilities/example/a.json', { value: 1 });
  const second = publisher.stageJson('capabilities/example/b.json', { value: 2 });
  const firstTarget = path.join(publisher.proofRoot, ...first.relativePath.split('/'));
  const secondTarget = path.join(publisher.proofRoot, ...second.relativePath.split('/'));
  const escapedPublisherLink = `${firstTarget}.publisher-link`;
  const originalRenameSync = fs.renameSync;
  let replacementInjected = false;
  fs.renameSync = function renameWithRollbackRace(candidate, destination, ...args) {
    if (!replacementInjected
      && path.resolve(String(candidate)) === path.resolve(firstTarget)
      && path.resolve(String(destination)).startsWith(
        `${path.resolve(path.join(publisher.stagingRoot, '.rollback'))}${path.sep}`,
      )) {
      replacementInjected = true;
      originalRenameSync.call(fs, firstTarget, escapedPublisherLink);
      fs.writeFileSync(firstTarget, 'concurrent-writer\n', { flag: 'wx', mode: 0o600 });
    }
    return originalRenameSync.call(fs, candidate, destination, ...args);
  };
  try {
    await assert.rejects(() => publisher.publish({
      relativePaths: [first.relativePath, second.relativePath],
      beforePublish() {
        fs.writeFileSync(secondTarget, 'preexisting\n', { flag: 'wx', mode: 0o600 });
      },
    }), /capability_replay_no_clobber_conflict/);
  } finally {
    fs.renameSync = originalRenameSync;
  }
  assert.equal(replacementInjected, true);
  assert.equal(fs.readFileSync(firstTarget, 'utf8'), 'concurrent-writer\n');
  assert.equal(fs.readFileSync(secondTarget, 'utf8'), 'preexisting\n');
  assert.equal(fs.existsSync(escapedPublisherLink), true);
});

test('post-publication provenance drift removes the complete new publication', async (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'capability-replay-postflight-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const publisher = createCapabilityReplayArtifactPublisher({
    runtimeRoot,
    publicationId: 'postflight-publication',
  });
  const staged = publisher.stageJson('capabilities/example/a.json', { value: 1 });
  await assert.rejects(() => publisher.publish({
    relativePaths: [staged.relativePath],
    afterPublish() {
      throw new Error('simulated_provenance_drift');
    },
  }), /simulated_provenance_drift/);
  assert.equal(fs.existsSync(path.join(publisher.proofRoot, ...staged.relativePath.split('/'))), false);
});

test('publisher rejects symlink ancestors and never reuses another publication staging root', (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'capability-replay-symlink-'));
  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'capability-replay-outside-'));
  t.after(() => {
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
    fs.rmSync(outsideRoot, { recursive: true, force: true });
  });
  fs.symlinkSync(outsideRoot, path.join(runtimeRoot, 'conformance-proof'));
  assert.throws(() => createCapabilityReplayArtifactPublisher({
    runtimeRoot,
    publicationId: 'symlinked-publication',
  }), /capability_replay_directory_unsafe/);
  assert.deepEqual(fs.readdirSync(outsideRoot), []);

  fs.unlinkSync(path.join(runtimeRoot, 'conformance-proof'));
  const stagingRoot = path.join(
    runtimeRoot,
    'conformance-proof',
    '.publication-staging',
    'shared-publication',
  );
  fs.mkdirSync(stagingRoot, { recursive: true, mode: 0o700 });
  const marker = path.join(stagingRoot, 'other-run-marker');
  fs.writeFileSync(marker, 'owned by another run\n');
  assert.throws(() => createCapabilityReplayArtifactPublisher({
    runtimeRoot,
    publicationId: 'shared-publication',
  }), /capability_replay_publication_id_conflict/);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'owned by another run\n');
  assert.throws(() => createCapabilityReplayArtifactPublisher({
    runtimeRoot,
    publicationId: '..',
  }), /capability_replay_publication_configuration_invalid/);
});

test('publisher refuses identity-changed staging cleanup', (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'capability-replay-identity-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const publisher = createCapabilityReplayArtifactPublisher({
    runtimeRoot,
    publicationId: 'identity-publication',
  });
  publisher.stageJson('replays/example/a.json', { value: 1 });
  const displaced = `${publisher.stagingRoot}-displaced`;
  fs.renameSync(publisher.stagingRoot, displaced);
  fs.mkdirSync(publisher.stagingRoot, { mode: 0o700 });
  const marker = path.join(publisher.stagingRoot, 'replacement-marker');
  fs.writeFileSync(marker, 'replacement must survive\n');
  assert.throws(() => publisher.discard(), /capability_replay_staging_root_identity_changed/);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'replacement must survive\n');
  assert.equal(fs.existsSync(displaced), true);
});

test('publisher quarantines rather than deleting a staging-root replacement race', (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'capability-replay-discard-race-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const publisher = createCapabilityReplayArtifactPublisher({
    runtimeRoot,
    publicationId: 'discard-race-publication',
  });
  publisher.stageJson('replays/example/a.json', { value: 1 });
  const displaced = `${publisher.stagingRoot}-displaced`;
  const originalRenameSync = fs.renameSync;
  let replacementInjected = false;
  fs.renameSync = function renameWithDiscardRace(candidate, destination, ...args) {
    if (!replacementInjected
      && path.resolve(String(candidate)) === path.resolve(publisher.stagingRoot)
      && path.basename(String(destination)) === 'owned') {
      replacementInjected = true;
      originalRenameSync.call(fs, publisher.stagingRoot, displaced);
      fs.mkdirSync(publisher.stagingRoot, { mode: 0o700 });
      fs.writeFileSync(
        path.join(publisher.stagingRoot, 'new-owner-marker'),
        'replacement must survive\n',
      );
    }
    return originalRenameSync.call(fs, candidate, destination, ...args);
  };
  let quarantinedPath = null;
  try {
    assert.throws(() => publisher.discard(), (error) => {
      assert.match(error.message, /capability_replay_staging_root_identity_changed/);
      quarantinedPath = error.quarantinedPath;
      return true;
    });
  } finally {
    fs.renameSync = originalRenameSync;
  }
  assert.equal(replacementInjected, true);
  assert.equal(
    fs.readFileSync(path.join(quarantinedPath, 'new-owner-marker'), 'utf8'),
    'replacement must survive\n',
  );
  assert.equal(fs.existsSync(displaced), true);
});

test('production replay binds the canonical source before and around publication', () => {
  const runner = fs.readFileSync(
    path.join(workspaceRoot, 'migration', 'bin', 'run-production-capability-replays.mjs'),
    'utf8',
  );
  assert.match(runner, /const paperId = 'A_Theory_of__Expectations';/u);
  assert.match(runner, /production_capability_replay_canonical_paper_required/u);
  assert.match(runner, /resolveCurrentCapabilityProductionSubject\(\{ assetRoot, paperId \}\)/u);
  assert.doesNotMatch(runner, /sha256File\(mainTex\)/u);
  for (const phase of ['preflight', 'postflight', 'prepublication', 'postpublication']) {
    assert.match(runner, new RegExp(`assertProductionSubjectUnchanged\\('${phase}'\\)`));
  }
});
