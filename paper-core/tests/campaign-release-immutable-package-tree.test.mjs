import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  assertImmutableCampaignPackageFilesSync,
  campaignReleasePackageRootFor,
  campaignReleaseRebuildRootFor,
  campaignReleaseRootFor,
  commitPreparedCampaignReleaseMaterializationSync,
  prepareCampaignReleaseMaterializationSync,
  prepareCampaignReleasePackageDirectorySync,
  readCampaignReleaseMaterializationSync,
  sealImmutableCampaignPackageDirectoriesSync,
} from '../../paper-adapters/automation/campaign-release-materialization.mjs';
import {
  acquireCampaignReleasePackageGenerationLockHandleSync,
  openPinnedScopedDirectory,
  pathEntryExistsNoFollow,
  publishCampaignReleasePreparedPackageSync,
  readCampaignReleasePackagePreparedTransactionSync,
} from '../../paper-adapters/automation/campaign-release-package-transaction-repository.mjs';
import {
  assertCampaignReleasePackageBuildTransactionCurrentSync,
  beginCampaignReleasePackageBuildTransactionSync,
  readCampaignReleasePackageBuildingTransactionSync,
} from '../../paper-adapters/automation/campaign-release-package-build-transaction-repository.mjs';
import {
  inspectFencedCampaignReleasePackageTransactionsSync,
} from '../../paper-adapters/automation/campaign-release-package-fenced-transaction-inventory.mjs';
import {
  fsyncCampaignReleaseFileSync,
} from '../../paper-adapters/automation/campaign-release-packaging-helpers.mjs';
import { persistCampaignReleaseBundleSync } from '../../paper-adapters/automation/campaign-release-repository.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';

function restoreOwnerWriteSync(root) {
  if (!fs.existsSync(root)) return;
  const visit = (directory) => {
    fs.chmodSync(directory, 0o700);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) visit(path.join(directory, entry.name));
    }
  };
  visit(root);
}

function fixture(t) {
  const runtimeRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hepta-release-exact-tree-'),
  );
  t.after(() => {
    restoreOwnerWriteSync(runtimeRoot);
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  });
  const packageDir = path.join(runtimeRoot, 'packages', 'attempt');
  const evidenceDir = path.join(packageDir, 'evidence', 'gpu-scientific');
  fs.mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
  const candidate = path.join(evidenceDir, 'model-spec.json');
  const content = Buffer.from('{"version":1}\n', 'utf8');
  fs.writeFileSync(candidate, content, { mode: 0o400 });
  const packageOutput = {
    releaseRoot: path.join(runtimeRoot, 'campaign-releases', 'attempt'),
    packageDir,
    files: [{
      role: 'research_evidence_capsule_file',
      path: candidate,
      hash: hashBytes(content),
      bytes: content.length,
    }],
  };
  fs.mkdirSync(packageOutput.releaseRoot, { recursive: true, mode: 0o700 });
  return { runtimeRoot, packageDir, evidenceDir, candidate, packageOutput };
}

test('release path and generation-lock boundaries reject incomplete or escaping scopes', (t) => {
  const { runtimeRoot, packageOutput } = fixture(t);

  assert.throws(
    () => campaignReleaseRootFor(runtimeRoot, {}, {}),
    /campaign_release_package_attempt_id_required/,
  );
  assert.throws(
    () => campaignReleasePackageRootFor(runtimeRoot, {}, {}),
    /campaign_release_package_attempt_id_required/,
  );

  const anonymousNode = { attemptId: 'attempt-without-node-id' };
  const releaseRoot = campaignReleaseRootFor(runtimeRoot, {}, anonymousNode);
  const rebuildRoot = campaignReleaseRebuildRootFor(runtimeRoot, {}, anonymousNode);
  const packageRoot = campaignReleasePackageRootFor(runtimeRoot, {}, anonymousNode);
  assert.equal(releaseRoot.startsWith(path.join(runtimeRoot, 'campaign-releases')), true);
  assert.equal(rebuildRoot.startsWith(path.join(runtimeRoot, 'campaign-release-rebuilds')), true);
  assert.equal(path.dirname(packageRoot), path.join(runtimeRoot, 'packages'));

  assert.throws(
    () => assertImmutableCampaignPackageFilesSync({
      ...packageOutput,
      releaseRoot: path.join(path.dirname(runtimeRoot), 'escaped-release'),
    }, runtimeRoot),
    /campaign_release_package_output_runtime_escape/,
  );
  assert.throws(
    () => assertImmutableCampaignPackageFilesSync({
      ...packageOutput,
      packageDir: path.join(path.dirname(runtimeRoot), 'escaped-package'),
    }, runtimeRoot),
    /campaign_release_package_output_runtime_escape/,
  );

  assert.throws(
    () => pathEntryExistsNoFollow('/dev/null/not-a-directory'),
    (error) => error?.code === 'ENOTDIR',
  );
  assert.throws(
    () => openPinnedScopedDirectory(
      runtimeRoot,
      path.dirname(runtimeRoot),
      'campaign_release_test_scope_invalid',
    ),
    /campaign_release_test_scope_invalid/,
  );
  assert.throws(
    () => acquireCampaignReleasePackageGenerationLockHandleSync({
      runtimeRoot,
      releaseRoot: path.join(path.dirname(runtimeRoot), 'escaped-release'),
    }),
    /campaign_release_package_generation_lock_invalid/,
  );
  assert.throws(
    () => acquireCampaignReleasePackageGenerationLockHandleSync({
      runtimeRoot,
      releaseRoot: packageOutput.releaseRoot,
      lockProbeTimeoutMs: 0,
    }),
    /campaign_release_package_generation_lock_probe_timeout_invalid/,
  );
});

function transactionFixture(t) {
  const runtimeRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hepta-release-transaction-'),
  );
  t.after(() => {
    restoreOwnerWriteSync(runtimeRoot);
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  });
  const releaseRoot = path.join(runtimeRoot, 'campaign-releases', 'attempt');
  const packageDir = path.join(runtimeRoot, 'packages', 'attempt');
  fs.mkdirSync(releaseRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.dirname(packageDir), { recursive: true, mode: 0o700 });
  const preparation = prepareCampaignReleasePackageDirectorySync({
    runtimeRoot,
    releaseRoot,
    packageDir,
  });
  assert.equal(
    path.dirname(preparation.preparedParent),
    path.dirname(packageDir),
  );
  assert.equal(
    fs.lstatSync(preparation.preparedParent).dev,
    fs.lstatSync(path.dirname(packageDir)).dev,
  );
  const evidenceDir = path.join(
    preparation.preparedPackageDir,
    'evidence',
    'gpu-scientific',
  );
  fs.mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
  const preparedFile = path.join(evidenceDir, 'model-spec.json');
  const publishedFile = path.join(
    packageDir,
    'evidence',
    'gpu-scientific',
    'model-spec.json',
  );
  const content = Buffer.from('{"version":1}\n', 'utf8');
  fs.writeFileSync(preparedFile, content, { mode: 0o444 });
  const packageOutputPayload = {
    version: 1,
    kind: 'ImmutableCampaignPackageOutput',
    immutable: true,
    releaseRoot,
    packageDir,
    artifactBaseRoot: path.dirname(packageDir),
    files: [{
      role: 'research_evidence_capsule_file',
      path: publishedFile,
      hash: hashBytes(content),
      bytes: content.length,
    }],
    fileCount: 1,
    externalActionPerformed: false,
  };
  const packageOutput = {
    ...packageOutputPayload,
    immutableCampaignPackageOutputHash: hashRecord(
      'ImmutableCampaignPackageOutput',
      packageOutputPayload,
    ),
  };
  const bundle = {
    campaignReleaseBundleHash: hashBytes(Buffer.from('release-bundle', 'utf8')),
    packageOutput,
  };
  return {
    runtimeRoot,
    releaseRoot,
    packageDir,
    preparation,
    preparedFile,
    publishedFile,
    bundle,
  };
}

function buildingMarkerCrashFixture(t, label) {
  const runtimeRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), `hepta-release-building-marker-${label}-`),
  );
  t.after(() => {
    restoreOwnerWriteSync(runtimeRoot);
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  });
  const nodeRoot = path.join(
    runtimeRoot,
    'campaign-releases',
    `campaign-${label}`,
    'package-node',
  );
  const releaseRoot = path.join(nodeRoot, 'attempt-old');
  const successorReleaseRoot = path.join(nodeRoot, 'attempt-successor');
  const packagesRoot = path.join(runtimeRoot, 'packages');
  fs.mkdirSync(releaseRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(successorReleaseRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(packagesRoot, { recursive: true, mode: 0o700 });
  const commonBinding = {
    campaignId: `campaign-building-marker-${label}`,
    campaignPlanHash: hashBytes(Buffer.from(`marker-plan-${label}`)),
    packageNodeId: `campaign-building-marker-${label}:package`,
    sourceSnapshotHash: hashBytes(Buffer.from(`marker-source-${label}`)),
    sourceWorkspaceManifestHash:
      hashBytes(Buffer.from(`marker-workspace-${label}`)),
  };
  const binding = {
    ...commonBinding,
    packageAttemptId: 'attempt-old',
    leaseGeneration: 4,
    createdAt: '2026-08-18T00:00:00.000Z',
  };
  return Object.freeze({
    runtimeRoot,
    releaseRoot,
    packageDir: path.join(packagesRoot, 'attempt-old'),
    binding: Object.freeze(binding),
    successorReleaseRoot,
    successorPackageDir: path.join(packagesRoot, 'attempt-successor'),
    successorBinding: Object.freeze({
      ...commonBinding,
      packageAttemptId: 'attempt-successor',
      leaseGeneration: 5,
      createdAt: '2026-08-18T00:01:00.000Z',
    }),
  });
}

async function crashDuringBuildingMarkerTemporaryWrite(value) {
  const moduleUrl = new URL(
    '../../paper-adapters/automation/campaign-release-package-build-transaction-repository.mjs',
    import.meta.url,
  ).href;
  const childSource = `
    import fs from 'node:fs';
    import { beginCampaignReleasePackageBuildTransactionSync } from ${JSON.stringify(moduleUrl)};
    const writeFileSync = fs.writeFileSync;
    fs.writeFileSync = (...args) => {
      const result = writeFileSync(...args);
      const bytes = Buffer.isBuffer(args[1])
        ? args[1]
        : Buffer.from(String(args[1]));
      if (bytes.includes(Buffer.from('CampaignReleasePackageBuildingMarker'))) {
        process.kill(process.pid, 'SIGKILL');
      }
      return result;
    };
    beginCampaignReleasePackageBuildTransactionSync(${JSON.stringify({
    runtimeRoot: value.runtimeRoot,
    releaseRoot: value.releaseRoot,
    packageDir: value.packageDir,
    binding: value.binding,
  })});
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', childSource], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const [code, signal] = await once(child, 'exit');
  assert.equal(code, null, stderr);
  assert.equal(signal, 'SIGKILL', stderr);
  const transaction = readCampaignReleasePackageBuildingTransactionSync({
    runtimeRoot: value.runtimeRoot,
    releaseRoot: value.releaseRoot,
  });
  assert.ok(transaction);
  const names = fs.readdirSync(transaction.preparedParent);
  assert.equal(names.length, 1);
  assert.match(
    names[0],
    /^\.\.CAMPAIGN_RELEASE_PACKAGE_BUILDING\.json\.tmp-[1-9][0-9]*-[0-9a-f]{24}$/,
  );
  return Object.freeze({ transaction, temporaryName: names[0] });
}

function assertRepeatedMaterializationCollision(value) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    assert.throws(() => readCampaignReleaseMaterializationSync({
      runtimeRoot: value.runtimeRoot,
      releaseRoot: value.releaseRoot,
    }), (error) => {
      assert.equal(
        error.code,
        'campaign_release_materialization_immutable_collision',
      );
      return true;
    });
  }
}

test('immutable campaign package requires an exact physical tree', (t) => {
  const value = fixture(t);
  assert.doesNotThrow(() => assertImmutableCampaignPackageFilesSync(
    value.packageOutput,
    value.runtimeRoot,
  ));
  fs.writeFileSync(path.join(value.evidenceDir, 'UNBOUND.bin'), 'unbound');
  assert.throws(() => assertImmutableCampaignPackageFilesSync(
    value.packageOutput,
    value.runtimeRoot,
  ), /campaign_release_package_output_exact_tree_invalid/);
});

test('immutable campaign package rejects symlink, hardlink, and directory substitutions', (t) => {
  const symlink = fixture(t);
  fs.unlinkSync(symlink.candidate);
  fs.symlinkSync('/dev/null', symlink.candidate);
  assert.throws(() => assertImmutableCampaignPackageFilesSync(
    symlink.packageOutput,
    symlink.runtimeRoot,
  ), /campaign_release_package_output_(?:file_invalid|entry_unsafe)/);

  const hardlink = fixture(t);
  fs.linkSync(hardlink.candidate, path.join(hardlink.evidenceDir, 'alias.json'));
  assert.throws(() => assertImmutableCampaignPackageFilesSync(
    hardlink.packageOutput,
    hardlink.runtimeRoot,
  ), /campaign_release_package_output_(?:file_invalid|entry_unsafe)/);

  const directory = fixture(t);
  fs.unlinkSync(directory.candidate);
  fs.mkdirSync(directory.candidate);
  assert.throws(() => assertImmutableCampaignPackageFilesSync(
    directory.packageOutput,
    directory.runtimeRoot,
  ), /campaign_release_package_output_(?:file_invalid|exact_tree_invalid)/);
});

test('immutable campaign package sealing removes directory write permissions', (t) => {
  const value = fixture(t);
  assert.doesNotThrow(() => sealImmutableCampaignPackageDirectoriesSync(
    value.packageOutput,
    value.runtimeRoot,
  ));
  for (const directory of [
    value.packageDir,
    path.join(value.packageDir, 'evidence'),
    value.evidenceDir,
  ]) {
    assert.equal(fs.lstatSync(directory).mode & 0o222, 0);
  }
  assert.doesNotThrow(() => assertImmutableCampaignPackageFilesSync(
    value.packageOutput,
    value.runtimeRoot,
  ));
});

test('campaign package file sealing durably orders descriptor chmod before fsync', (t) => {
  const value = fixture(t);
  fs.chmodSync(value.candidate, 0o600);
  const originalFchmodSync = fs.fchmodSync;
  const originalFsyncSync = fs.fsyncSync;
  const operations = [];
  fs.fchmodSync = (descriptor, mode) => {
    operations.push(`fchmod:${mode.toString(8)}`);
    return originalFchmodSync(descriptor, mode);
  };
  fs.fsyncSync = (descriptor) => {
    operations.push('fsync');
    return originalFsyncSync(descriptor);
  };
  try {
    fsyncCampaignReleaseFileSync(value.candidate);
  } finally {
    fs.fchmodSync = originalFchmodSync;
    fs.fsyncSync = originalFsyncSync;
  }
  assert.deepEqual(operations, ['fchmod:444', 'fsync']);
  assert.equal(fs.lstatSync(value.candidate).mode & 0o777, 0o444);
});

test('campaign package file sealing rejects a path swap after descriptor chmod', (t) => {
  const value = fixture(t);
  fs.chmodSync(value.candidate, 0o600);
  const displaced = `${value.candidate}.displaced`;
  const originalFchmodSync = fs.fchmodSync;
  let attacked = false;
  fs.fchmodSync = (descriptor, mode) => {
    const result = originalFchmodSync(descriptor, mode);
    if (!attacked) {
      attacked = true;
      fs.renameSync(value.candidate, displaced);
      fs.writeFileSync(value.candidate, '{"replacement":true}\n', { mode: 0o600 });
    }
    return result;
  };
  try {
    assert.throws(
      () => fsyncCampaignReleaseFileSync(value.candidate),
      /campaign_release_package_file_identity_changed/,
    );
  } finally {
    fs.fchmodSync = originalFchmodSync;
  }
  assert.equal(attacked, true);
  assert.equal(fs.lstatSync(displaced).mode & 0o777, 0o444);
  assert.equal(fs.lstatSync(value.candidate).mode & 0o777, 0o600);
});

test('building transaction recovers a real SIGKILL partial package without an orphan',
  async (t) => {
    const runtimeRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hepta-release-building-sigkill-'),
    );
    t.after(() => {
      restoreOwnerWriteSync(runtimeRoot);
      fs.rmSync(runtimeRoot, { recursive: true, force: true });
    });
    const releaseRoot = path.join(runtimeRoot, 'campaign-releases', 'attempt');
    const packageDir = path.join(runtimeRoot, 'packages', 'attempt');
    fs.mkdirSync(releaseRoot, { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.dirname(packageDir), { recursive: true, mode: 0o700 });
    const binding = {
      campaignId: 'campaign-building-sigkill',
      campaignPlanHash: hashBytes(Buffer.from('campaign-plan')),
      packageNodeId: 'campaign-building-sigkill:package',
      packageAttemptId: 'attempt-building-sigkill',
      leaseGeneration: 7,
      sourceSnapshotHash: hashBytes(Buffer.from('source-snapshot')),
      sourceWorkspaceManifestHash: hashBytes(Buffer.from('workspace-manifest')),
      createdAt: '2026-08-18T00:00:00.000Z',
    };
    const moduleUrl = new URL(
      '../../paper-adapters/automation/campaign-release-package-build-transaction-repository.mjs',
      import.meta.url,
    ).href;
    const childSource = `
      import fs from 'node:fs';
      import { beginCampaignReleasePackageBuildTransactionSync } from ${JSON.stringify(moduleUrl)};
      const transaction = beginCampaignReleasePackageBuildTransactionSync(${JSON.stringify({
    runtimeRoot,
    releaseRoot,
    packageDir,
    binding,
  })});
      fs.mkdirSync(transaction.preparedPackageDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(
        new URL('partial-output.bin', 'file://' + transaction.preparedPackageDir + '/'),
        Buffer.alloc(4096, 0x5a),
      );
      process.stdout.write(JSON.stringify({
        transactionHash: transaction.record.campaignReleasePackageBuildingTransactionHash,
        preparedPackageDir: transaction.preparedPackageDir,
      }) + '\\n');
      setInterval(() => {}, 1000);
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', childSource], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    t.after(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    });
    let stdout = '';
    const ready = new Promise((resolve, reject) => {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
        if (stdout.includes('\n')) resolve();
      });
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        if (!stdout.includes('\n')) reject(new Error(`child_exited:${code}:${signal}`));
      });
    });
    await ready;
    const first = JSON.parse(stdout.trim().split('\n')[0]);
    assert.equal(fs.existsSync(path.join(
      releaseRoot,
      'CAMPAIGN_RELEASE_PACKAGE_BUILDING.json',
    )), true);
    assert.equal(fs.existsSync(path.join(
      first.preparedPackageDir,
      'partial-output.bin',
    )), true);
    child.kill('SIGKILL');
    const [, signal] = await once(child, 'exit');
    assert.equal(signal, 'SIGKILL');

    const recovered = beginCampaignReleasePackageBuildTransactionSync({
      runtimeRoot,
      releaseRoot,
      packageDir,
      binding,
    });
    assert.equal(
      recovered.record.campaignReleasePackageBuildingTransactionHash,
      first.transactionHash,
    );
    assert.equal(recovered.preparedPackageDir, first.preparedPackageDir);
    assert.equal(fs.existsSync(recovered.preparedPackageDir), false);
    assert.equal(fs.readdirSync(recovered.preparedParent).length, 1);
    assert.equal(
      fs.readdirSync(path.dirname(packageDir))
        .some((name) => name.startsWith('.package-aborted-')),
      false,
    );
  });

test('building transaction recovers a real SIGKILL after aborted promotion before erase',
  async (t) => {
    const value = buildingMarkerCrashFixture(t, 'aborted-cleanup-sigkill');
    const transaction = beginCampaignReleasePackageBuildTransactionSync({
      runtimeRoot: value.runtimeRoot,
      releaseRoot: value.releaseRoot,
      packageDir: value.packageDir,
      binding: value.binding,
    });
    fs.mkdirSync(transaction.preparedPackageDir, { recursive: true });
    fs.writeFileSync(
      path.join(transaction.preparedPackageDir, 'partial-output.bin'),
      Buffer.alloc(4096, 0x6b),
    );
    const moduleUrl = new URL(
      '../../paper-adapters/automation/campaign-release-package-build-transaction-repository.mjs',
      import.meta.url,
    ).href;
    const childSource = `
      import fs from 'node:fs';
      import { beginCampaignReleasePackageBuildTransactionSync } from ${JSON.stringify(moduleUrl)};
      fs.rmSync = () => process.kill(process.pid, 'SIGKILL');
      beginCampaignReleasePackageBuildTransactionSync(${JSON.stringify({
    runtimeRoot: value.runtimeRoot,
    releaseRoot: value.releaseRoot,
    packageDir: value.packageDir,
    binding: value.binding,
  })});
    `;
    const child = spawn(
      process.execPath,
      ['--input-type=module', '-e', childSource],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const [code, signal] = await once(child, 'exit');
    assert.equal(code, null, stderr);
    assert.equal(signal, 'SIGKILL', stderr);
    assert.equal(fs.existsSync(transaction.preparedParent), false);
    assert.equal(fs.existsSync(transaction.abortedParent), true);

    const recovered = beginCampaignReleasePackageBuildTransactionSync({
      runtimeRoot: value.runtimeRoot,
      releaseRoot: value.releaseRoot,
      packageDir: value.packageDir,
      binding: value.binding,
    });
    assert.equal(fs.existsSync(transaction.abortedParent), false);
    assert.deepEqual(
      fs.readdirSync(recovered.preparedParent),
      ['.CAMPAIGN_RELEASE_PACKAGE_BUILDING.json'],
    );
  });

test('aborted staging recovery rejects missing and hardlink-replaced markers', (t) => {
  for (const attack of ['missing', 'hardlink']) {
    const value = buildingMarkerCrashFixture(t, `aborted-${attack}`);
    const transaction = beginCampaignReleasePackageBuildTransactionSync({
      runtimeRoot: value.runtimeRoot,
      releaseRoot: value.releaseRoot,
      packageDir: value.packageDir,
      binding: value.binding,
    });
    fs.writeFileSync(path.join(transaction.preparedParent, 'partial.bin'), 'partial');
    fs.renameSync(transaction.preparedParent, transaction.abortedParent);
    const marker = path.join(
      transaction.abortedParent,
      '.CAMPAIGN_RELEASE_PACKAGE_BUILDING.json',
    );
    if (attack === 'missing') {
      fs.unlinkSync(marker);
    } else {
      const bytes = fs.readFileSync(marker);
      const replacement = path.join(value.runtimeRoot, 'replacement-marker.json');
      fs.writeFileSync(replacement, bytes, { mode: 0o444 });
      fs.unlinkSync(marker);
      fs.linkSync(replacement, marker);
    }
    assert.throws(() => beginCampaignReleasePackageBuildTransactionSync({
      runtimeRoot: value.runtimeRoot,
      releaseRoot: value.releaseRoot,
      packageDir: value.packageDir,
      binding: value.binding,
    }), /campaign_release_package_building_staging_invalid/);
    assert.equal(
      fs.readFileSync(path.join(transaction.abortedParent, 'partial.bin'), 'utf8'),
      'partial',
    );
  }
});

test('same lease generation recovers a real SIGKILL building marker temporary',
  async (t) => {
    const value = buildingMarkerCrashFixture(t, 'same-generation');
    const crashed = await crashDuringBuildingMarkerTemporaryWrite(value);

    const recovered = beginCampaignReleasePackageBuildTransactionSync({
      runtimeRoot: value.runtimeRoot,
      releaseRoot: value.releaseRoot,
      packageDir: value.packageDir,
      binding: value.binding,
    });
    assert.equal(
      recovered.record.campaignReleasePackageBuildingTransactionHash,
      crashed.transaction.record
        .campaignReleasePackageBuildingTransactionHash,
    );
    assert.deepEqual(
      fs.readdirSync(recovered.preparedParent),
      ['.CAMPAIGN_RELEASE_PACKAGE_BUILDING.json'],
    );
    assert.equal(
      fs.existsSync(path.join(recovered.preparedParent, crashed.temporaryName)),
      false,
    );
  });

test('higher lease generation fences and recovers a real SIGKILL building marker temporary',
  async (t) => {
    const value = buildingMarkerCrashFixture(t, 'higher-generation');
    const crashed = await crashDuringBuildingMarkerTemporaryWrite(value);

    const successor = beginCampaignReleasePackageBuildTransactionSync({
      runtimeRoot: value.runtimeRoot,
      releaseRoot: value.successorReleaseRoot,
      packageDir: value.successorPackageDir,
      binding: value.successorBinding,
    });
    assert.equal(fs.existsSync(crashed.transaction.preparedParent), false);
    assert.equal(fs.existsSync(path.join(
      value.releaseRoot,
      'CAMPAIGN_RELEASE_PACKAGE_BUILDING_FENCED.json',
    )), true);
    assert.deepEqual(
      fs.readdirSync(successor.preparedParent),
      ['.CAMPAIGN_RELEASE_PACKAGE_BUILDING.json'],
    );
    assert.throws(() => assertCampaignReleasePackageBuildTransactionCurrentSync({
      runtimeRoot: value.runtimeRoot,
      releaseRoot: value.releaseRoot,
      expectedTransactionHash: crashed.transaction.record
        .campaignReleasePackageBuildingTransactionHash,
    }), /campaign_release_package_building_transaction_fenced/);
  });

test('building marker temporary recovery rejects unknown and replacement entries',
  async (t) => {
    const unknown = buildingMarkerCrashFixture(t, 'unknown-entry');
    const unknownCrash = await crashDuringBuildingMarkerTemporaryWrite(unknown);
    const unknownPath = path.join(
      unknownCrash.transaction.preparedParent,
      'UNKNOWN.bin',
    );
    fs.writeFileSync(unknownPath, 'unknown\n', { mode: 0o444 });
    assert.throws(() => beginCampaignReleasePackageBuildTransactionSync({
      runtimeRoot: unknown.runtimeRoot,
      releaseRoot: unknown.successorReleaseRoot,
      packageDir: unknown.successorPackageDir,
      binding: unknown.successorBinding,
    }), /campaign_release_package_building_staging_invalid/);
    assert.equal(fs.readFileSync(unknownPath, 'utf8'), 'unknown\n');
    assert.equal(fs.existsSync(path.join(
      unknownCrash.transaction.preparedParent,
      unknownCrash.temporaryName,
    )), true);

    const replacement = buildingMarkerCrashFixture(t, 'replacement-entry');
    const replacementCrash = await crashDuringBuildingMarkerTemporaryWrite(
      replacement,
    );
    const replacementPath = path.join(
      replacementCrash.transaction.preparedParent,
      replacementCrash.temporaryName,
    );
    const replacementBytes = fs.readFileSync(replacementPath);
    const replacementSource = path.join(
      replacement.runtimeRoot,
      'replacement-building-marker.tmp',
    );
    fs.writeFileSync(replacementSource, replacementBytes, { mode: 0o444 });
    fs.unlinkSync(replacementPath);
    fs.linkSync(replacementSource, replacementPath);
    assert.throws(() => beginCampaignReleasePackageBuildTransactionSync({
      runtimeRoot: replacement.runtimeRoot,
      releaseRoot: replacement.releaseRoot,
      packageDir: replacement.packageDir,
      binding: replacement.binding,
    }), /campaign_release_package_building_staging_invalid/);
    assert.deepEqual(fs.readFileSync(replacementPath), replacementBytes);
    assert.equal(fs.lstatSync(replacementPath).nlink, 2);
  });

test('durable package commit survives duplicate begin and remains readable after successor fence',
  (t) => {
    const value = transactionFixture(t);
    fs.rmSync(value.preparation.preparedParent, { recursive: true });
    const binding = {
      campaignId: 'campaign-building-complete',
      campaignPlanHash: hashBytes(Buffer.from('complete-plan')),
      packageNodeId: 'campaign-building-complete:package',
      packageAttemptId: 'attempt-building-complete',
      leaseGeneration: 3,
      sourceSnapshotHash: hashBytes(Buffer.from('complete-snapshot')),
      sourceWorkspaceManifestHash:
        hashBytes(Buffer.from('complete-workspace-manifest')),
      createdAt: '2026-08-18T00:00:00.000Z',
    };
    const building = beginCampaignReleasePackageBuildTransactionSync({
      runtimeRoot: value.runtimeRoot,
      releaseRoot: value.releaseRoot,
      packageDir: value.packageDir,
      binding,
    });
    const preparedFile = path.join(
      building.preparedPackageDir,
      'evidence',
      'gpu-scientific',
      'model-spec.json',
    );
    fs.mkdirSync(path.dirname(preparedFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(preparedFile, '{"version":1}\n', { mode: 0o444 });
    prepareCampaignReleaseMaterializationSync({
      runtimeRoot: value.runtimeRoot,
      releaseRoot: value.releaseRoot,
      bundle: value.bundle,
      preparedPackageDir: building.preparedPackageDir,
    });
    const preparedBeforeDuplicate =
      readCampaignReleasePackagePreparedTransactionSync({
        runtimeRoot: value.runtimeRoot,
        releaseRoot: value.releaseRoot,
      });
    assert.throws(() => beginCampaignReleasePackageBuildTransactionSync({
      runtimeRoot: value.runtimeRoot,
      releaseRoot: value.releaseRoot,
      packageDir: value.packageDir,
      binding,
    }), /campaign_release_package_prepared_transaction_exists/);
    const preparedAfterDuplicate =
      readCampaignReleasePackagePreparedTransactionSync({
        runtimeRoot: value.runtimeRoot,
        releaseRoot: value.releaseRoot,
      });
    assert.equal(
      preparedAfterDuplicate.record
        .campaignReleasePackagePreparedTransactionHash,
      preparedBeforeDuplicate.record
        .campaignReleasePackagePreparedTransactionHash,
    );
    assert.equal(fs.existsSync(building.preparedPackageDir), true);
    assert.equal(fs.existsSync(building.abortedParent), false);
    commitPreparedCampaignReleaseMaterializationSync({
      runtimeRoot: value.runtimeRoot,
      releaseRoot: value.releaseRoot,
    });
    assert.equal(fs.existsSync(building.preparedParent), false);
    assert.equal(fs.existsSync(value.packageDir), true);
    assert.equal(fs.existsSync(path.join(
      value.releaseRoot,
      'CAMPAIGN_RELEASE_PACKAGE_BUILDING.json',
    )), true);
    assert.equal(fs.readdirSync(path.dirname(value.packageDir))
      .some((name) => name.startsWith('.package-prepared-')), false);

    const successorReleaseRoot = path.join(
      path.dirname(value.releaseRoot),
      'attempt-building-successor',
    );
    fs.mkdirSync(successorReleaseRoot, { mode: 0o700 });
    beginCampaignReleasePackageBuildTransactionSync({
      runtimeRoot: value.runtimeRoot,
      releaseRoot: successorReleaseRoot,
      packageDir: path.join(
        path.dirname(value.packageDir),
        'attempt-building-successor',
      ),
      binding: {
        ...binding,
        packageAttemptId: 'attempt-building-successor',
        leaseGeneration: binding.leaseGeneration + 1,
        createdAt: '2026-08-18T00:01:00.000Z',
      },
    });
    assert.equal(fs.existsSync(path.join(
      value.releaseRoot,
      'CAMPAIGN_RELEASE_PACKAGE_BUILDING_FENCED.json',
    )), true);
    const historical = readCampaignReleaseMaterializationSync({
      runtimeRoot: value.runtimeRoot,
      releaseRoot: value.releaseRoot,
    });
    assert.equal(
      historical.bundle.campaignReleaseBundleHash,
      value.bundle.campaignReleaseBundleHash,
    );
    assert.equal(fs.readFileSync(value.publishedFile, 'utf8'), '{"version":1}\n');
  });

test('higher lease generation durably fences and reclaims a stale building transaction',
  (t) => {
    const runtimeRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hepta-release-building-fence-'),
    );
    t.after(() => {
      restoreOwnerWriteSync(runtimeRoot);
      fs.rmSync(runtimeRoot, { recursive: true, force: true });
    });
    const nodeRoot = path.join(
      runtimeRoot,
      'campaign-releases',
      'campaign',
      'package-node',
    );
    const oldReleaseRoot = path.join(nodeRoot, 'attempt-old');
    const newReleaseRoot = path.join(nodeRoot, 'attempt-new');
    const packagesRoot = path.join(runtimeRoot, 'packages');
    fs.mkdirSync(oldReleaseRoot, { recursive: true, mode: 0o700 });
    fs.mkdirSync(newReleaseRoot, { recursive: true, mode: 0o700 });
    fs.mkdirSync(packagesRoot, { recursive: true, mode: 0o700 });
    const common = {
      campaignId: 'campaign-building-fence',
      campaignPlanHash: hashBytes(Buffer.from('fence-plan')),
      packageNodeId: 'campaign-building-fence:package',
      sourceSnapshotHash: hashBytes(Buffer.from('fence-snapshot')),
      sourceWorkspaceManifestHash:
        hashBytes(Buffer.from('fence-workspace-manifest')),
      createdAt: '2026-08-18T00:00:00.000Z',
    };
    const old = beginCampaignReleasePackageBuildTransactionSync({
      runtimeRoot,
      releaseRoot: oldReleaseRoot,
      packageDir: path.join(packagesRoot, 'attempt-old'),
      binding: {
        ...common,
        packageAttemptId: 'attempt-old',
        leaseGeneration: 4,
      },
    });
    fs.mkdirSync(old.preparedPackageDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(old.preparedPackageDir, 'partial.bin'), 'partial');

    const current = beginCampaignReleasePackageBuildTransactionSync({
      runtimeRoot,
      releaseRoot: newReleaseRoot,
      packageDir: path.join(packagesRoot, 'attempt-new'),
      binding: {
        ...common,
        packageAttemptId: 'attempt-new',
        leaseGeneration: 5,
        createdAt: '2026-08-18T00:01:00.000Z',
      },
    });
    assert.equal(fs.existsSync(old.preparedParent), false);
    assert.equal(fs.existsSync(path.join(
      oldReleaseRoot,
      'CAMPAIGN_RELEASE_PACKAGE_BUILDING_FENCED.json',
    )), true);
    assert.throws(() => assertCampaignReleasePackageBuildTransactionCurrentSync({
      runtimeRoot,
      releaseRoot: oldReleaseRoot,
      expectedTransactionHash: old.record
        .campaignReleasePackageBuildingTransactionHash,
    }), /campaign_release_package_building_transaction_fenced/);
    assert.doesNotThrow(() => (
      assertCampaignReleasePackageBuildTransactionCurrentSync({
        runtimeRoot,
        releaseRoot: newReleaseRoot,
        expectedTransactionHash: current.record
          .campaignReleasePackageBuildingTransactionHash,
      })
    ));
    const inventory = inspectFencedCampaignReleasePackageTransactionsSync({
      runtimeRoot,
    });
    assert.equal(inventory.rows.length, 1);
    assert.equal(inventory.rows[0].packageAttemptId, 'attempt-old');
    assert.equal(inventory.rows[0].supersedingPackageAttemptId, 'attempt-new');
    assert.equal(
      inventory.rows[0].campaignReleasePackageBuildingTransactionHash,
      old.record.campaignReleasePackageBuildingTransactionHash,
    );
    assert.equal(fs.readdirSync(packagesRoot)
      .some((name) => name.startsWith('.package-aborted-')), false);
  });

test('a prepared stale generation cannot publish after a newer generation fences it',
  (t) => {
    const value = transactionFixture(t);
    fs.rmSync(value.preparation.preparedParent, { recursive: true });
    const common = {
      campaignId: 'campaign-prepared-fence',
      campaignPlanHash: hashBytes(Buffer.from('prepared-fence-plan')),
      packageNodeId: 'campaign-prepared-fence:package',
      sourceSnapshotHash: hashBytes(Buffer.from('prepared-fence-snapshot')),
      sourceWorkspaceManifestHash:
        hashBytes(Buffer.from('prepared-fence-workspace-manifest')),
    };
    const stale = beginCampaignReleasePackageBuildTransactionSync({
      runtimeRoot: value.runtimeRoot,
      releaseRoot: value.releaseRoot,
      packageDir: value.packageDir,
      binding: {
        ...common,
        packageAttemptId: 'attempt-stale',
        leaseGeneration: 4,
        createdAt: '2026-08-18T00:00:00.000Z',
      },
    });
    const staleFile = path.join(
      stale.preparedPackageDir,
      'evidence',
      'gpu-scientific',
      'model-spec.json',
    );
    fs.mkdirSync(path.dirname(staleFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(staleFile, '{"version":1}\n', { mode: 0o444 });
    prepareCampaignReleaseMaterializationSync({
      runtimeRoot: value.runtimeRoot,
      releaseRoot: value.releaseRoot,
      bundle: value.bundle,
      preparedPackageDir: stale.preparedPackageDir,
    });

    const successorReleaseRoot = path.join(
      path.dirname(value.releaseRoot),
      'attempt-successor',
    );
    fs.mkdirSync(successorReleaseRoot, { recursive: true, mode: 0o700 });
    beginCampaignReleasePackageBuildTransactionSync({
      runtimeRoot: value.runtimeRoot,
      releaseRoot: successorReleaseRoot,
      packageDir: path.join(path.dirname(value.packageDir), 'attempt-successor'),
      binding: {
        ...common,
        packageAttemptId: 'attempt-successor',
        leaseGeneration: 5,
        createdAt: '2026-08-18T00:01:00.000Z',
      },
    });

    assert.throws(() => commitPreparedCampaignReleaseMaterializationSync({
      runtimeRoot: value.runtimeRoot,
      releaseRoot: value.releaseRoot,
    }), /campaign_release_package_building_transaction_fenced/);
    assert.equal(fs.existsSync(value.packageDir), false);
    assert.equal(fs.existsSync(path.join(
      value.releaseRoot,
      'CAMPAIGN_RELEASE_BUNDLE.json',
    )), false);
  });

test('prepared campaign package publication recovers after a crash before commit', (t) => {
  const value = transactionFixture(t);
  const prepared = prepareCampaignReleaseMaterializationSync({
    runtimeRoot: value.runtimeRoot,
    releaseRoot: value.releaseRoot,
    bundle: value.bundle,
    preparedPackageDir: value.preparation.preparedPackageDir,
  });
  assert.equal(prepared.record.status, 'campaign_release_package_prepared');
  assert.equal(fs.existsSync(value.packageDir), false);
  assert.equal(
    fs.lstatSync(value.preparation.preparedPackageDir).mode & 0o222,
    0,
  );
  fs.chmodSync(value.preparation.preparedPackageDir, 0o700);

  const recovered = readCampaignReleaseMaterializationSync({
    runtimeRoot: value.runtimeRoot,
    releaseRoot: value.releaseRoot,
  });
  assert.equal(
    recovered.bundle.campaignReleaseBundleHash,
    value.bundle.campaignReleaseBundleHash,
  );
  assert.equal(fs.existsSync(value.preparation.preparedPackageDir), false);
  assert.equal(fs.readFileSync(value.publishedFile, 'utf8'), '{"version":1}\n');
  assert.equal(fs.lstatSync(value.packageDir).mode & 0o222, 0);
  assert.equal(fs.lstatSync(value.publishedFile).mode & 0o222, 0);
  assert.equal(fs.existsSync(path.join(
    value.releaseRoot,
    'CAMPAIGN_RELEASE_PACKAGE_PREPARED.json',
  )), true);
  assert.equal(
    readCampaignReleaseMaterializationSync({
      runtimeRoot: value.runtimeRoot,
      releaseRoot: value.releaseRoot,
    }).hash,
    recovered.hash,
  );
});

test('published package without a bundle is recovered from its durable transaction', (t) => {
  const value = transactionFixture(t);
  prepareCampaignReleaseMaterializationSync({
    runtimeRoot: value.runtimeRoot,
    releaseRoot: value.releaseRoot,
    bundle: value.bundle,
    preparedPackageDir: value.preparation.preparedPackageDir,
  });
  const prepared = readCampaignReleasePackagePreparedTransactionSync({
    runtimeRoot: value.runtimeRoot,
    releaseRoot: value.releaseRoot,
  });
  fs.chmodSync(value.preparation.preparedPackageDir, 0o700);
  publishCampaignReleasePreparedPackageSync({
    runtimeRoot: value.runtimeRoot,
    prepared,
  });
  assert.equal(fs.existsSync(value.preparation.preparedPackageDir), false);
  assert.equal(fs.existsSync(value.packageDir), true);
  assert.notEqual(fs.lstatSync(value.packageDir).mode & 0o200, 0);
  assert.equal(
    fs.existsSync(path.join(value.releaseRoot, 'CAMPAIGN_RELEASE_BUNDLE.json')),
    false,
  );

  const recovered = readCampaignReleaseMaterializationSync({
    runtimeRoot: value.runtimeRoot,
    releaseRoot: value.releaseRoot,
  });
  assert.equal(
    recovered.bundle.campaignReleaseBundleHash,
    value.bundle.campaignReleaseBundleHash,
  );
  assert.equal(fs.lstatSync(value.packageDir).mode & 0o222, 0);
  assert.equal(fs.existsSync(path.join(
    value.releaseRoot,
    'CAMPAIGN_RELEASE_PACKAGE_PREPARED.json',
  )), true);
});

test('matching final bundle and package reconcile with their prepared transaction', (t) => {
  const value = transactionFixture(t);
  prepareCampaignReleaseMaterializationSync({
    runtimeRoot: value.runtimeRoot,
    releaseRoot: value.releaseRoot,
    bundle: value.bundle,
    preparedPackageDir: value.preparation.preparedPackageDir,
  });
  const materialized = commitPreparedCampaignReleaseMaterializationSync({
    runtimeRoot: value.runtimeRoot,
    releaseRoot: value.releaseRoot,
  });
  const reconciled = readCampaignReleaseMaterializationSync({
    runtimeRoot: value.runtimeRoot,
    releaseRoot: value.releaseRoot,
  });
  const recommitted = commitPreparedCampaignReleaseMaterializationSync({
    runtimeRoot: value.runtimeRoot,
    releaseRoot: value.releaseRoot,
  });
  assert.equal(reconciled.hash, materialized.contentHash);
  assert.equal(recommitted.contentHash, materialized.contentHash);
  assert.deepEqual(reconciled.bundle, value.bundle);
  assert.equal(fs.lstatSync(value.packageDir).mode & 0o222, 0);
});

test('raced final bundle cannot override a different prepared transaction', (t) => {
  const value = transactionFixture(t);
  prepareCampaignReleaseMaterializationSync({
    runtimeRoot: value.runtimeRoot,
    releaseRoot: value.releaseRoot,
    bundle: value.bundle,
    preparedPackageDir: value.preparation.preparedPackageDir,
  });
  const prepared = readCampaignReleasePackagePreparedTransactionSync({
    runtimeRoot: value.runtimeRoot,
    releaseRoot: value.releaseRoot,
  });
  fs.chmodSync(value.preparation.preparedPackageDir, 0o700);
  publishCampaignReleasePreparedPackageSync({
    runtimeRoot: value.runtimeRoot,
    prepared,
  });
  sealImmutableCampaignPackageDirectoriesSync(
    value.bundle.packageOutput,
    value.runtimeRoot,
  );
  const racedBundle = {
    ...value.bundle,
    campaignReleaseBundleHash: hashBytes(Buffer.from('raced-release-bundle')),
  };
  persistCampaignReleaseBundleSync({
    runtimeRoot: value.runtimeRoot,
    releaseRoot: value.releaseRoot,
    bundle: racedBundle,
  });

  assert.throws(() => commitPreparedCampaignReleaseMaterializationSync({
    runtimeRoot: value.runtimeRoot,
    releaseRoot: value.releaseRoot,
  }), /campaign_release_materialization_immutable_collision/);
  assertRepeatedMaterializationCollision(value);
  assert.equal(fs.existsSync(value.packageDir), true);
  assert.equal(fs.existsSync(value.preparation.preparedPackageDir), false);
});

test('semantically matching but noncanonical final bundle bytes cannot reconcile', (t) => {
  const value = transactionFixture(t);
  prepareCampaignReleaseMaterializationSync({
    runtimeRoot: value.runtimeRoot,
    releaseRoot: value.releaseRoot,
    bundle: value.bundle,
    preparedPackageDir: value.preparation.preparedPackageDir,
  });
  const prepared = readCampaignReleasePackagePreparedTransactionSync({
    runtimeRoot: value.runtimeRoot,
    releaseRoot: value.releaseRoot,
  });
  fs.chmodSync(value.preparation.preparedPackageDir, 0o700);
  publishCampaignReleasePreparedPackageSync({
    runtimeRoot: value.runtimeRoot,
    prepared,
  });
  sealImmutableCampaignPackageDirectoriesSync(
    value.bundle.packageOutput,
    value.runtimeRoot,
  );
  fs.writeFileSync(
    path.join(value.releaseRoot, 'CAMPAIGN_RELEASE_BUNDLE.json'),
    JSON.stringify(value.bundle),
    { mode: 0o444 },
  );

  assert.throws(() => commitPreparedCampaignReleaseMaterializationSync({
    runtimeRoot: value.runtimeRoot,
    releaseRoot: value.releaseRoot,
  }), /campaign_release_materialization_immutable_collision/);
  assertRepeatedMaterializationCollision(value);
});

test('matching final bundle rejects a replacement package with the same exact tree', (t) => {
  const value = transactionFixture(t);
  prepareCampaignReleaseMaterializationSync({
    runtimeRoot: value.runtimeRoot,
    releaseRoot: value.releaseRoot,
    bundle: value.bundle,
    preparedPackageDir: value.preparation.preparedPackageDir,
  });
  fs.mkdirSync(path.dirname(value.publishedFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    value.publishedFile,
    fs.readFileSync(value.preparedFile),
    { mode: 0o444 },
  );
  sealImmutableCampaignPackageDirectoriesSync(
    value.bundle.packageOutput,
    value.runtimeRoot,
  );
  persistCampaignReleaseBundleSync({
    runtimeRoot: value.runtimeRoot,
    releaseRoot: value.releaseRoot,
    bundle: value.bundle,
  });

  assert.throws(() => commitPreparedCampaignReleaseMaterializationSync({
    runtimeRoot: value.runtimeRoot,
    releaseRoot: value.releaseRoot,
  }), /campaign_release_materialization_immutable_collision/);
  assertRepeatedMaterializationCollision(value);
  assert.equal(fs.existsSync(value.preparation.preparedPackageDir), true);
});

test('matching final bundle rejects post-publication package tree pollution', (t) => {
  const value = transactionFixture(t);
  prepareCampaignReleaseMaterializationSync({
    runtimeRoot: value.runtimeRoot,
    releaseRoot: value.releaseRoot,
    bundle: value.bundle,
    preparedPackageDir: value.preparation.preparedPackageDir,
  });
  commitPreparedCampaignReleaseMaterializationSync({
    runtimeRoot: value.runtimeRoot,
    releaseRoot: value.releaseRoot,
  });
  const evidenceDir = path.dirname(value.publishedFile);
  fs.chmodSync(evidenceDir, 0o700);
  fs.writeFileSync(path.join(evidenceDir, 'UNDECLARED.txt'), 'pollution\n', {
    mode: 0o444,
  });
  fs.chmodSync(evidenceDir, 0o500);

  assert.throws(() => commitPreparedCampaignReleaseMaterializationSync({
    runtimeRoot: value.runtimeRoot,
    releaseRoot: value.releaseRoot,
  }), /campaign_release_materialization_immutable_collision/);
  assertRepeatedMaterializationCollision(value);
});

test('prepared campaign package publication never clobbers a raced target', (t) => {
  const value = transactionFixture(t);
  prepareCampaignReleaseMaterializationSync({
    runtimeRoot: value.runtimeRoot,
    releaseRoot: value.releaseRoot,
    bundle: value.bundle,
    preparedPackageDir: value.preparation.preparedPackageDir,
  });
  fs.mkdirSync(value.packageDir, { mode: 0o700 });
  const sentinel = path.join(value.packageDir, 'DO_NOT_REPLACE.txt');
  fs.writeFileSync(sentinel, 'pre-existing\n', { mode: 0o600 });

  assert.throws(() => commitPreparedCampaignReleaseMaterializationSync({
    runtimeRoot: value.runtimeRoot,
    releaseRoot: value.releaseRoot,
  }), /campaign_release_package_publication_collision/);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'pre-existing\n');
  assert.equal(fs.existsSync(value.preparation.preparedPackageDir), true);
  assert.equal(
    fs.existsSync(path.join(value.releaseRoot, 'CAMPAIGN_RELEASE_BUNDLE.json')),
    false,
  );
});

test('cross-process prepared publication race commits one exact package without clobber',
  async (t) => {
    const value = transactionFixture(t);
    prepareCampaignReleaseMaterializationSync({
      runtimeRoot: value.runtimeRoot,
      releaseRoot: value.releaseRoot,
      bundle: value.bundle,
      preparedPackageDir: value.preparation.preparedPackageDir,
    });
    const trigger = path.join(value.runtimeRoot, 'publish.trigger');
    const moduleUrl = new URL(
      '../../paper-adapters/automation/campaign-release-materialization.mjs',
      import.meta.url,
    ).href;
    const childSource = `
      import fs from 'node:fs';
      import { setTimeout as wait } from 'node:timers/promises';
      import { commitPreparedCampaignReleaseMaterializationSync } from ${JSON.stringify(moduleUrl)};
      process.stdout.write('READY\\n');
      while (!fs.existsSync(${JSON.stringify(trigger)})) await wait(2);
      try {
        const receipt = commitPreparedCampaignReleaseMaterializationSync(${JSON.stringify({
    runtimeRoot: value.runtimeRoot,
    releaseRoot: value.releaseRoot,
  })});
        process.stdout.write(JSON.stringify({ ok: true, hash: receipt.contentHash }) + '\\n');
      } catch (error) {
        process.stdout.write(JSON.stringify({ ok: false, code: error?.code || null, message: error?.message }) + '\\n');
      }
    `;
    const children = [0, 1].map(() => spawn(
      process.execPath,
      ['--input-type=module', '-e', childSource],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    ));
    t.after(() => {
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }
    });
    const outputs = ['', ''];
    await Promise.all(children.map((child, index) => new Promise((resolve, reject) => {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        outputs[index] += chunk;
        if (outputs[index].includes('READY\n')) resolve();
      });
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        if (!outputs[index].includes('READY\n')) {
          reject(new Error(`publication_child_exited:${code}:${signal}`));
        }
      });
    })));
    fs.writeFileSync(trigger, 'publish\n', { flag: 'wx' });
    await Promise.all(children.map((child) => once(child, 'exit')));
    const results = outputs.map((output) => JSON.parse(
      output.trim().split('\n').at(-1),
    ));
    assert.equal(results.filter((result) => result.ok).length >= 1, true);
    for (const result of results.filter((candidate) => !candidate.ok)) {
      assert.match(
        `${result.code || ''}:${result.message || ''}`,
        /campaign_release_(?:bundle|package|materialization)_/,
      );
    }
    const committed = readCampaignReleaseMaterializationSync({
      runtimeRoot: value.runtimeRoot,
      releaseRoot: value.releaseRoot,
    });
    assert.equal(
      committed.bundle.campaignReleaseBundleHash,
      value.bundle.campaignReleaseBundleHash,
    );
    assert.equal(fs.readFileSync(value.publishedFile, 'utf8'), '{"version":1}\n');
    assert.deepEqual(fs.readdirSync(value.packageDir), ['evidence']);
  });

test('prepared package rename readiness chmod stays descriptor-bound across a path swap', (t) => {
  const value = transactionFixture(t);
  prepareCampaignReleaseMaterializationSync({
    runtimeRoot: value.runtimeRoot,
    releaseRoot: value.releaseRoot,
    bundle: value.bundle,
    preparedPackageDir: value.preparation.preparedPackageDir,
  });
  const outside = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hepta-release-chmod-outside-'),
  );
  fs.chmodSync(outside, 0o750);
  t.after(() => {
    fs.chmodSync(outside, 0o700);
    fs.rmSync(outside, { recursive: true, force: true });
  });
  const displaced = `${value.preparation.preparedPackageDir}.displaced`;
  const originalFchmodSync = fs.fchmodSync;
  let attacked = false;
  fs.fchmodSync = (descriptor, mode) => {
    if (!attacked) {
      attacked = true;
      fs.renameSync(value.preparation.preparedPackageDir, displaced);
      fs.symlinkSync(outside, value.preparation.preparedPackageDir);
    }
    return originalFchmodSync(descriptor, mode);
  };
  try {
    assert.throws(() => commitPreparedCampaignReleaseMaterializationSync({
      runtimeRoot: value.runtimeRoot,
      releaseRoot: value.releaseRoot,
    }), /campaign_release_package_prepared_transaction_invalid/);
  } finally {
    fs.fchmodSync = originalFchmodSync;
  }
  assert.equal(attacked, true);
  assert.equal(fs.lstatSync(value.preparation.preparedPackageDir).isSymbolicLink(), true);
  assert.equal(fs.lstatSync(outside).mode & 0o777, 0o750);
  assert.equal(fs.lstatSync(displaced).mode & 0o777, 0o700);
  assert.equal(fs.existsSync(value.packageDir), false);
  assert.equal(fs.existsSync(path.join(
    value.releaseRoot,
    'CAMPAIGN_RELEASE_BUNDLE.json',
  )), false);
});

test('an unprepared partial staging directory does not reserve publication', (t) => {
  const value = transactionFixture(t);
  fs.writeFileSync(
    path.join(value.preparation.preparedParent, 'partial-output'),
    'partial\n',
  );
  const replacement = prepareCampaignReleasePackageDirectorySync({
    runtimeRoot: value.runtimeRoot,
    releaseRoot: value.releaseRoot,
    packageDir: value.packageDir,
  });
  assert.notEqual(replacement.preparedParent, value.preparation.preparedParent);
  assert.equal(fs.existsSync(replacement.preparedPackageDir), false);
});
