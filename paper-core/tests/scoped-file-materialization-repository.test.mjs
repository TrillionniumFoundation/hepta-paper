import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  abortStagedScopedFileSync,
  cleanupStagedScopedFileSync,
  commitStagedScopedFileSync,
  inspectScopedRegularFileSync,
  inspectScopedRegularFileWithRecoverySync,
  recoverScopedMaterializationIntentsSync,
  removeScopedRegularFileSync,
  stageScopedRegularFileCopySync,
} from '../../paper-adapters/runtime/scoped-file-materialization-repository.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-scoped-materialization-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, 'source');
  const destinationRoot = path.join(root, 'destination');
  fs.mkdirSync(sourceRoot);
  fs.mkdirSync(path.join(destinationRoot, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, 'payload.txt'), 'payload\n');
  return { root, sourceRoot, destinationRoot };
}

function hiddenMaterializationEntries(directory) {
  return fs.readdirSync(directory).filter((name) => name.startsWith('.') && name.includes('hepta'));
}

function recoveryEntries(root) {
  const directory = path.join(root, '.hepta-materialization-recovery');
  return fs.existsSync(directory) ? fs.readdirSync(directory) : [];
}

function assertDurableCompletionTombstones(root, minimum = 1) {
  const entries = recoveryEntries(root);
  const tombstones = entries.filter((name) => name.startsWith('.operation-') && name.endsWith('.completed.json'));
  assert.ok(tombstones.length >= minimum, `expected at least ${minimum} durable completion tombstones`);
  assert.equal(entries.every((name) => (
    (name.startsWith('.operation-') && name.endsWith('.completed.json'))
    || (name.startsWith('.definition-') && name.endsWith('.json'))
  )), true);
}

function descriptorsWithin(root) {
  if (!fs.existsSync('/proc/self/fd')) return [];
  return fs.readdirSync('/proc/self/fd').flatMap((name) => {
    try {
      const target = fs.realpathSync.native(`/proc/self/fd/${name}`);
      return target === root || target.startsWith(`${root}${path.sep}`) ? [{ descriptor: Number(name), target }] : [];
    } catch {
      return [];
    }
  });
}

test('descriptor-relative commit and remove preserve the expected regular-file CAS', (t) => {
  const { sourceRoot, destinationRoot } = fixture(t);
  const staged = stageScopedRegularFileCopySync({
    sourceRoot,
    destinationRoot,
    relative: 'payload.txt',
    destinationRelative: 'nested/payload.txt',
    stageId: 'descriptor-cas',
  });
  const persisted = commitStagedScopedFileSync(staged, { destinationRoot, expectedHash: null });
  assert.equal(persisted.hash, staged.hash);
  assert.equal(fs.readFileSync(path.join(destinationRoot, 'nested', 'payload.txt'), 'utf8'), 'payload\n');

  const removed = removeScopedRegularFileSync({
    scopeRoot: destinationRoot,
    relative: 'nested/payload.txt',
    expectedHash: staged.hash,
  });
  assert.equal(removed.removedHash, staged.hash);
  assert.equal(fs.existsSync(path.join(destinationRoot, 'nested', 'payload.txt')), false);
  assertDurableCompletionTombstones(destinationRoot, 2);
});

test('commit rejects a substituted destination parent inode and removes its staged file', (t) => {
  const { destinationRoot, sourceRoot } = fixture(t);
  const staged = stageScopedRegularFileCopySync({
    sourceRoot,
    destinationRoot,
    relative: 'payload.txt',
    destinationRelative: 'nested/payload.txt',
    stageId: 'parent-fence',
  });
  const moved = path.join(destinationRoot, 'moved-parent');
  fs.renameSync(path.join(destinationRoot, 'nested'), moved);
  fs.mkdirSync(path.join(destinationRoot, 'nested'));

  assert.throws(
    () => commitStagedScopedFileSync(staged, { destinationRoot, expectedHash: null }),
    /scoped_materialization_destination_parent_changed/,
  );
  assert.equal(fs.existsSync(path.join(destinationRoot, 'nested', 'payload.txt')), false);
  assert.equal(fs.existsSync(path.join(moved, staged.temporaryName)), false);
});

test('existing-file CAS commits with the public result shape and abort remains idempotent', (t) => {
  const { sourceRoot, destinationRoot } = fixture(t);
  const parent = path.join(destinationRoot, 'nested');
  const target = path.join(parent, 'payload.txt');
  fs.writeFileSync(target, 'old\n');
  const current = inspectScopedRegularFileSync({
    scopeRoot: destinationRoot,
    relative: 'nested/payload.txt',
  });
  const staged = stageScopedRegularFileCopySync({
    sourceRoot,
    destinationRoot,
    relative: 'payload.txt',
    destinationRelative: 'nested/payload.txt',
    stageId: 'existing-cas',
  });

  const persisted = commitStagedScopedFileSync(staged, {
    destinationRoot,
    expectedHash: current.hash,
  });

  assert.deepEqual(Object.keys(persisted).sort(), ['bytes', 'exists', 'hash', 'identityHash', 'relative']);
  assert.equal(persisted.exists, true);
  assert.equal(persisted.relative, 'nested/payload.txt');
  assert.equal(persisted.hash, staged.hash);
  assert.equal(persisted.bytes, staged.bytes);
  assert.equal(fs.readFileSync(target, 'utf8'), 'payload\n');
  assert.deepEqual(hiddenMaterializationEntries(parent), []);
  assertDurableCompletionTombstones(destinationRoot);
  assert.doesNotThrow(() => abortStagedScopedFileSync(staged));
  assert.doesNotThrow(() => abortStagedScopedFileSync(staged));
  assert.deepEqual(descriptorsWithin(destinationRoot), []);
});

test('operationId has one immutable cross-path semantic definition and exact DONE replay', (t) => {
  const { root, sourceRoot, destinationRoot } = fixture(t);
  const operationId = 'global-operation-definition';
  const relative = 'nested/payload.txt';
  const first = stageScopedRegularFileCopySync({
    sourceRoot,
    destinationRoot,
    relative: 'payload.txt',
    destinationRelative: relative,
    stageId: operationId,
    expectedHash: null,
  });
  const completed = commitStagedScopedFileSync(first, { destinationRoot, expectedHash: null });

  const replay = stageScopedRegularFileCopySync({
    sourceRoot,
    destinationRoot,
    relative: 'payload.txt',
    destinationRelative: relative,
    stageId: operationId,
    expectedHash: null,
  });
  assert.deepEqual(
    commitStagedScopedFileSync(replay, { destinationRoot, expectedHash: null }),
    completed,
  );

  const alternateSource = path.join(root, 'alternate-source');
  fs.mkdirSync(alternateSource);
  fs.writeFileSync(path.join(alternateSource, 'payload.txt'), 'different postimage\n');
  assert.throws(
    () => stageScopedRegularFileCopySync({
      sourceRoot: alternateSource,
      destinationRoot,
      relative: 'payload.txt',
      destinationRelative: relative,
      stageId: operationId,
      expectedHash: null,
    }),
    /scoped_materialization_operation_definition_conflict/,
  );
  assert.throws(
    () => stageScopedRegularFileCopySync({
      sourceRoot,
      destinationRoot,
      relative: 'payload.txt',
      destinationRelative: 'nested/other.txt',
      stageId: operationId,
      expectedHash: null,
    }),
    /scoped_materialization_operation_definition_conflict/,
  );
  assert.throws(
    () => removeScopedRegularFileSync({
      scopeRoot: destinationRoot,
      relative,
      expectedHash: completed.hash,
      operationId,
    }),
    /scoped_materialization_operation_definition_conflict/,
  );
  assert.equal(fs.readFileSync(path.join(destinationRoot, relative), 'utf8'), 'payload\n');
  assert.equal(recoveryEntries(destinationRoot).filter((name) => name.startsWith('.definition-')).length, 1);
  assert.deepEqual(hiddenMaterializationEntries(path.join(destinationRoot, 'nested')), []);
});

test('failed CAS retains its immutable operation definition without consuming it', (t) => {
  const { sourceRoot, destinationRoot } = fixture(t);
  const relative = 'nested/payload.txt';
  const target = path.join(destinationRoot, relative);
  fs.writeFileSync(target, 'old\n');
  const current = inspectScopedRegularFileSync({ scopeRoot: destinationRoot, relative });
  const operationId = 'definition-survives-rollback';
  const staged = stageScopedRegularFileCopySync({
    sourceRoot,
    destinationRoot,
    relative: 'payload.txt',
    destinationRelative: relative,
    stageId: operationId,
    expectedHash: current.hash,
  });
  assert.throws(
    () => commitStagedScopedFileSync(staged, {
      destinationRoot,
      expectedHash: `sha256:${'0'.repeat(64)}`,
    }),
    /scoped_materialization_operation_definition_conflict/,
  );
  assert.equal(fs.readFileSync(target, 'utf8'), 'old\n');
  assert.throws(
    () => stageScopedRegularFileCopySync({
      sourceRoot,
      destinationRoot,
      relative: 'payload.txt',
      destinationRelative: 'nested/other.txt',
      stageId: operationId,
      expectedHash: null,
    }),
    /scoped_materialization_operation_definition_conflict/,
  );
  assert.equal(recoveryEntries(destinationRoot).filter((name) => name.startsWith('.definition-')).length, 1);
});

test('temp collisions survive and a per-target lock fences concurrent stages', (t) => {
  const { sourceRoot, destinationRoot } = fixture(t);
  const parent = path.join(destinationRoot, 'nested');
  const collisionToken = crypto.createHash('sha256').update('collision').digest('hex');
  const collisionName = `.payload.txt.hepta-${collisionToken}.tmp`;
  const collision = path.join(parent, collisionName);
  fs.writeFileSync(collision, 'owned-by-another-stage\n');

  assert.throws(
    () => stageScopedRegularFileCopySync({
      sourceRoot,
      destinationRoot,
      relative: 'payload.txt',
      destinationRelative: 'nested/payload.txt',
      stageId: 'collision',
    }),
    (error) => error?.code === 'EEXIST',
  );
  assert.equal(fs.readFileSync(collision, 'utf8'), 'owned-by-another-stage\n');
  assert.deepEqual(hiddenMaterializationEntries(parent), [collisionName]);
  fs.unlinkSync(collision);

  const first = stageScopedRegularFileCopySync({
    sourceRoot,
    destinationRoot,
    relative: 'payload.txt',
    destinationRelative: 'nested/payload.txt',
    stageId: 'first-stage',
  });
  assert.ok(descriptorsWithin(destinationRoot).length >= (fs.existsSync('/proc/self/fd') ? 1 : 0));
  if (fs.existsSync('/proc/self/fd')) {
    assert.equal(fs.existsSync(`/proc/self/fd/${first.openedParent.descriptor}`), true);
    assert.equal(fs.existsSync(`/proc/self/fd/${first.targetLock.descriptor}`), true);
  }
  assert.throws(
    () => stageScopedRegularFileCopySync({
      sourceRoot,
      destinationRoot,
      relative: 'payload.txt',
      destinationRelative: 'nested/payload.txt',
      stageId: 'second-stage',
    }),
    (error) => error?.code === 'scoped_materialization_destination_locked',
  );
  assert.throws(
    () => cleanupStagedScopedFileSync({
      destinationRoot,
      relative: 'nested/payload.txt',
      stageId: 'unrelated-cleaner',
    }),
    (error) => error?.code === 'scoped_materialization_destination_locked',
  );

  assert.equal(fs.existsSync(first.temporary), true);
  assert.equal(fs.existsSync(path.join(parent, first.targetLock.name)), true);
  assert.doesNotThrow(() => abortStagedScopedFileSync(first));
  assert.doesNotThrow(() => abortStagedScopedFileSync(first));
  assert.deepEqual(hiddenMaterializationEntries(parent), []);
  assert.deepEqual(descriptorsWithin(destinationRoot), []);
});

test('descriptor-relative fallback fails closed when fd namespace semantics cannot be proved', (t) => {
  const { sourceRoot, destinationRoot } = fixture(t);
  const decoy = path.join(destinationRoot, 'nested');
  const originalOpenSync = fs.openSync;
  fs.openSync = (candidate, ...args) => {
    const value = String(candidate);
    if (value.startsWith('/proc/self/fd/')) {
      const error = new Error('simulated missing procfs');
      error.code = 'ENOENT';
      throw error;
    }
    if (value.startsWith('/dev/fd/')) {
      return originalOpenSync(
        decoy,
        fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0),
      );
    }
    return originalOpenSync(candidate, ...args);
  };
  try {
    assert.throws(
      () => stageScopedRegularFileCopySync({
        sourceRoot,
        destinationRoot,
        relative: 'payload.txt',
        destinationRelative: 'nested/payload.txt',
        stageId: 'unproved-dev-fd',
        expectedHash: null,
      }),
      /scoped_materialization_descriptor_relative_io_unsupported|scoped_materialization_source_open_failed/,
    );
  } finally {
    fs.openSync = originalOpenSync;
  }
  assert.equal(fs.existsSync(path.join(destinationRoot, 'nested', 'payload.txt')), false);
  assert.deepEqual(hiddenMaterializationEntries(path.join(destinationRoot, 'nested')), []);
});

test('a same-process orphan left by a failed lock COW is reclaimed on the next stage', (t) => {
  const { sourceRoot, destinationRoot } = fixture(t);
  const parent = path.join(destinationRoot, 'nested');
  const originalRenameSync = fs.renameSync;
  let injected = false;
  fs.renameSync = (from, to) => {
    const result = originalRenameSync(from, to);
    if (!injected && String(from).includes('.hepta-lock-publish-') && String(to).endsWith('.lock')) {
      injected = true;
      throw new Error('injected_after_lock_cow_publish');
    }
    return result;
  };
  try {
    assert.throws(
      () => stageScopedRegularFileCopySync({
        sourceRoot,
        destinationRoot,
        relative: 'payload.txt',
        destinationRelative: 'nested/payload.txt',
        stageId: 'same-process-orphan',
        expectedHash: null,
      }),
      /injected_after_lock_cow_publish/,
    );
  } finally {
    fs.renameSync = originalRenameSync;
  }
  assert.equal(injected, true);
  const retry = stageScopedRegularFileCopySync({
    sourceRoot,
    destinationRoot,
    relative: 'payload.txt',
    destinationRelative: 'nested/payload.txt',
    stageId: 'same-process-orphan',
    expectedHash: null,
  });
  abortStagedScopedFileSync(retry);
  assert.deepEqual(hiddenMaterializationEntries(parent), []);
});

test('a dead Linux lock owner is reclaimed with its unknown random-stage temp', (t) => {
  const { sourceRoot, destinationRoot } = fixture(t);
  const parent = path.join(destinationRoot, 'nested');
  const repositoryUrl = new URL('../../paper-adapters/runtime/scoped-file-materialization-repository.mjs', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', `
    import { stageScopedRegularFileCopySync } from ${JSON.stringify(repositoryUrl)};
    stageScopedRegularFileCopySync({
      sourceRoot: ${JSON.stringify(sourceRoot)},
      destinationRoot: ${JSON.stringify(destinationRoot)},
      relative: 'payload.txt',
      destinationRelative: 'nested/payload.txt',
    });
  `], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(hiddenMaterializationEntries(parent).some((name) => name.endsWith('.lock')), true);
  assert.equal(hiddenMaterializationEntries(parent).some((name) => name.endsWith('.tmp')), true);

  assert.equal(cleanupStagedScopedFileSync({
    destinationRoot,
    relative: 'nested/payload.txt',
  }), true);
  assert.deepEqual(hiddenMaterializationEntries(parent), []);
  assert.deepEqual(descriptorsWithin(destinationRoot), []);
});

test('SIGKILL across temp inode binding and lock COW milestones is recoverable', async (t) => {
  if (!fs.existsSync('/proc/self/fd')) return t.skip('descriptor-relative crash recovery requires Linux procfs');
  const repositoryUrl = new URL('../../paper-adapters/runtime/scoped-file-materialization-repository.mjs', import.meta.url).href;
  const scenarios = [
    {
      name: 'after durable inode-owner record before lock publish',
      hook: `
        let tempCreated = false;
        let inodeOwnerCreated = false;
        const originalOpenSync = fs.openSync;
        fs.openSync = (...args) => {
          const descriptor = originalOpenSync(...args);
          const candidate = String(args[0]);
          if (candidate.endsWith('.tmp')) tempCreated = true;
          if (tempCreated && candidate.includes('.hepta-lock-owner-')) inodeOwnerCreated = true;
          return descriptor;
        };
        const originalFsyncSync = fs.fsyncSync;
        fs.fsyncSync = (descriptor) => {
          const result = originalFsyncSync(descriptor);
          let target = '';
          try { target = fs.realpathSync.native('/proc/self/fd/' + descriptor); } catch {}
          if (inodeOwnerCreated && target === ${JSON.stringify('PARENT_PLACEHOLDER')}) process.kill(process.pid, 'SIGKILL');
          return result;
        };
      `,
    },
    {
      name: 'after temp bytes change under the persisted inode owner',
      hook: `
        const originalWriteSync = fs.writeSync;
        fs.writeSync = (...args) => {
          const result = originalWriteSync(...args);
          let target = '';
          try { target = fs.realpathSync.native('/proc/self/fd/' + args[0]); } catch {}
          if (target.endsWith('.tmp')) process.kill(process.pid, 'SIGKILL');
          return result;
        };
      `,
    },
    {
      name: 'after temp fsync before final metadata COW',
      hook: `
        const originalFsyncSync = fs.fsyncSync;
        fs.fsyncSync = (descriptor) => {
          const result = originalFsyncSync(descriptor);
          let target = '';
          try { target = fs.realpathSync.native('/proc/self/fd/' + descriptor); } catch {}
          if (target.endsWith('.tmp')) process.kill(process.pid, 'SIGKILL');
          return result;
        };
      `,
    },
    {
      name: 'after canonical lock COW rename before its directory fsync',
      hook: `
        const originalRenameSync = fs.renameSync;
        fs.renameSync = (from, to) => {
          const result = originalRenameSync(from, to);
          if (String(from).includes('.hepta-lock-publish-') && String(to).endsWith('.lock')) {
            process.kill(process.pid, 'SIGKILL');
          }
          return result;
        };
      `,
    },
  ];
  for (const [index, scenario] of scenarios.entries()) {
    await t.test(scenario.name, () => {
      const { sourceRoot, destinationRoot } = fixture(t);
      const parent = path.join(destinationRoot, 'nested');
      const hook = scenario.hook.replace(JSON.stringify('PARENT_PLACEHOLDER'), JSON.stringify(parent));
      const child = spawnSync(process.execPath, ['--input-type=module', '--eval', `
        import fs from 'node:fs';
        ${hook}
        const { stageScopedRegularFileCopySync } = await import(${JSON.stringify(repositoryUrl)});
        stageScopedRegularFileCopySync({
          sourceRoot: ${JSON.stringify(sourceRoot)},
          destinationRoot: ${JSON.stringify(destinationRoot)},
          relative: 'payload.txt',
          destinationRelative: 'nested/payload.txt',
          stageId: 'temp-crash-${index}',
          expectedHash: null,
        });
      `], { encoding: 'utf8' });
      assert.equal(child.signal, 'SIGKILL', child.stderr);
      assert.equal(cleanupStagedScopedFileSync({
        destinationRoot,
        relative: 'nested/payload.txt',
      }), true);
      assert.deepEqual(hiddenMaterializationEntries(parent), []);
      assert.equal(fs.existsSync(path.join(parent, 'payload.txt')), false);
    });
  }
});

test('SIGKILL after lease, backup, PREPARED, and DONE directory fsync is replayable', async (t) => {
  if (!fs.existsSync('/proc/self/fd')) return t.skip('descriptor-relative crash recovery requires Linux procfs');
  const repositoryUrl = new URL('../../paper-adapters/runtime/scoped-file-materialization-repository.mjs', import.meta.url).href;
  const milestones = [
    ['lease', `(entries) => entries.some((name) => name.startsWith('.lease-')) && !entries.some((name) => name.startsWith('.definition-'))`],
    ['backup', `(entries) => entries.some((name) => name.endsWith('.preimage')) && !entries.some((name) => name.endsWith('.prepared.json'))`],
    ['prepared', `(entries) => entries.some((name) => name.endsWith('.prepared.json')) && !entries.some((name) => name.endsWith('.completed.json'))`],
    ['done', `(entries) => entries.some((name) => name.endsWith('.completed.json'))`],
  ];
  for (const [index, [milestone, predicate]] of milestones.entries()) {
    await t.test(`${milestone} directory fsync`, () => {
      const { sourceRoot, destinationRoot } = fixture(t);
      const relative = 'nested/payload.txt';
      const target = path.join(destinationRoot, relative);
      fs.writeFileSync(target, 'old\n');
      const current = inspectScopedRegularFileSync({ scopeRoot: destinationRoot, relative });
      const operationId = `directory-fsync-${milestone}-${index}`;
      const child = spawnSync(process.execPath, ['--input-type=module', '--eval', `
        import fs from 'node:fs';
        const predicate = ${predicate};
        const originalFsyncSync = fs.fsyncSync;
        let injected = false;
        fs.fsyncSync = (descriptor) => {
          const result = originalFsyncSync(descriptor);
          let directory = '';
          try { directory = fs.realpathSync.native('/proc/self/fd/' + descriptor); } catch {}
          if (!injected && directory.endsWith('.hepta-materialization-recovery')) {
            const entries = fs.readdirSync(directory);
            if (predicate(entries)) {
              injected = true;
              process.kill(process.pid, 'SIGKILL');
            }
          }
          return result;
        };
        const { stageScopedRegularFileCopySync, commitStagedScopedFileSync } = await import(${JSON.stringify(repositoryUrl)});
        const staged = stageScopedRegularFileCopySync({
          sourceRoot: ${JSON.stringify(sourceRoot)},
          destinationRoot: ${JSON.stringify(destinationRoot)},
          relative: 'payload.txt',
          destinationRelative: ${JSON.stringify(relative)},
          stageId: ${JSON.stringify(operationId)},
          expectedHash: ${JSON.stringify(current.hash)},
        });
        commitStagedScopedFileSync(staged, {
          destinationRoot: ${JSON.stringify(destinationRoot)},
          expectedHash: ${JSON.stringify(current.hash)},
        });
      `], { encoding: 'utf8' });
      assert.equal(child.signal, 'SIGKILL', child.stderr);

      const retry = stageScopedRegularFileCopySync({
        sourceRoot,
        destinationRoot,
        relative: 'payload.txt',
        destinationRelative: relative,
        stageId: operationId,
        expectedHash: current.hash,
      });
      const completed = commitStagedScopedFileSync(retry, {
        destinationRoot,
        expectedHash: current.hash,
      });
      assert.equal(completed.hash, retry.hash);
      assert.equal(fs.readFileSync(target, 'utf8'), 'payload\n');
      assert.equal(recoveryEntries(destinationRoot).some((name) => name.endsWith('.prepared.json')), false);
      assert.deepEqual(hiddenMaterializationEntries(path.dirname(target)), []);
    });
  }
});

test('same-token legacy spellings cannot race one vault entry across different paths', async (t) => {
  const { destinationRoot } = fixture(t);
  const repositoryUrl = new URL('../../paper-adapters/runtime/scoped-file-materialization-repository.mjs', import.meta.url).href;
  const operations = [
    { relative: 'nested/first/payload.txt', operationId: 'same/token' },
    { relative: 'nested/second/payload.txt', operationId: 'same_token' },
  ];
  for (const operation of operations) {
    const target = path.join(destinationRoot, operation.relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'old\n');
    operation.expectedHash = inspectScopedRegularFileSync({
      scopeRoot: destinationRoot,
      relative: operation.relative,
    }).hash;
  }
  const outcomes = await Promise.all(operations.map((operation) => new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', `
      const { removeScopedRegularFileSync } = await import(${JSON.stringify(repositoryUrl)});
      removeScopedRegularFileSync({
        scopeRoot: ${JSON.stringify(destinationRoot)},
        relative: ${JSON.stringify(operation.relative)},
        expectedHash: ${JSON.stringify(operation.expectedHash)},
        operationId: ${JSON.stringify(operation.operationId)},
      });
    `], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status, signal) => resolve({ status, signal, stderr }));
  })));
  for (const outcome of outcomes) {
    assert.deepEqual({ status: outcome.status, signal: outcome.signal }, { status: 0, signal: null }, outcome.stderr);
  }
  for (const operation of operations) {
    assert.equal(fs.existsSync(path.join(destinationRoot, operation.relative)), false);
    assert.deepEqual(hiddenMaterializationEntries(path.dirname(path.join(destinationRoot, operation.relative))), []);
  }
  assert.equal(recoveryEntries(destinationRoot).filter((name) => name.startsWith('.definition-')).length, 2);
  assert.equal(recoveryEntries(destinationRoot).filter((name) => name.endsWith('.completed.json')).length, 2);
  assert.equal(recoveryEntries(destinationRoot).some((name) => name.endsWith('.removed')), false);
});

test('commit rejects an in-flight preimage mutation without overwriting it and cleans stage resources', (t) => {
  const { sourceRoot, destinationRoot } = fixture(t);
  const parent = path.join(destinationRoot, 'nested');
  const target = path.join(parent, 'payload.txt');
  fs.writeFileSync(target, 'old\n');
  const current = inspectScopedRegularFileSync({ scopeRoot: destinationRoot, relative: 'nested/payload.txt' });
  const staged = stageScopedRegularFileCopySync({
    sourceRoot,
    destinationRoot,
    relative: 'payload.txt',
    destinationRelative: 'nested/payload.txt',
    stageId: 'commit-race',
  });
  const parentDescriptor = staged.openedParent.descriptor;
  const lockDescriptor = staged.targetLock.descriptor;
  const originalRenameSync = fs.renameSync;
  let injected = false;
  fs.renameSync = (from, to) => {
    if (!injected && path.basename(String(from)) === 'payload.txt' && String(to).endsWith('.preimage')) {
      injected = true;
      fs.writeFileSync(from, 'concurrent\n');
    }
    return originalRenameSync(from, to);
  };
  try {
    assert.throws(
      () => commitStagedScopedFileSync(staged, { destinationRoot, expectedHash: current.hash }),
      /scoped_materialization_preimage_conflict/,
    );
  } finally {
    fs.renameSync = originalRenameSync;
  }

  assert.equal(injected, true);
  assert.equal(fs.readFileSync(target, 'utf8'), 'concurrent\n');
  assert.equal(staged.parentDescriptorClosed, true);
  assert.equal(staged.targetLock.closed, true);
  assert.deepEqual(hiddenMaterializationEntries(parent), []);
  if (fs.existsSync('/proc/self/fd')) {
    assert.equal(fs.existsSync(`/proc/self/fd/${parentDescriptor}`), false);
    assert.equal(fs.existsSync(`/proc/self/fd/${lockDescriptor}`), false);
  }
  assert.deepEqual(descriptorsWithin(destinationRoot), []);
  assert.doesNotThrow(() => abortStagedScopedFileSync(staged));
  assert.doesNotThrow(() => abortStagedScopedFileSync(staged));
});

test('an absent-file CAS rejects concurrent creation without target loss', (t) => {
  const { sourceRoot, destinationRoot } = fixture(t);
  const parent = path.join(destinationRoot, 'nested');
  const target = path.join(parent, 'payload.txt');
  const staged = stageScopedRegularFileCopySync({
    sourceRoot,
    destinationRoot,
    relative: 'payload.txt',
    destinationRelative: 'nested/payload.txt',
    stageId: 'absent-race',
  });
  fs.writeFileSync(target, 'concurrent\n');

  assert.throws(
    () => commitStagedScopedFileSync(staged, { destinationRoot, expectedHash: null }),
    /scoped_materialization_preimage_conflict/,
  );
  assert.equal(fs.readFileSync(target, 'utf8'), 'concurrent\n');
  assert.deepEqual(hiddenMaterializationEntries(parent), []);
  assert.deepEqual(descriptorsWithin(destinationRoot), []);
  assert.doesNotThrow(() => abortStagedScopedFileSync(staged));
});

test('remove quarantines by inode and rejects an in-flight target mutation without deleting it', (t) => {
  const { destinationRoot } = fixture(t);
  const parent = path.join(destinationRoot, 'nested');
  const target = path.join(parent, 'payload.txt');
  fs.writeFileSync(target, 'old\n');
  const current = inspectScopedRegularFileSync({ scopeRoot: destinationRoot, relative: 'nested/payload.txt' });
  const originalRenameSync = fs.renameSync;
  let injected = false;
  fs.renameSync = (from, to) => {
    if (!injected && path.basename(String(from)) === 'payload.txt' && String(to).endsWith('.removed')) {
      injected = true;
      fs.writeFileSync(from, 'concurrent\n');
    }
    return originalRenameSync(from, to);
  };
  try {
    assert.throws(
      () => removeScopedRegularFileSync({
        scopeRoot: destinationRoot,
        relative: 'nested/payload.txt',
        expectedHash: current.hash,
      }),
      /scoped_materialization_preimage_conflict/,
    );
  } finally {
    fs.renameSync = originalRenameSync;
  }

  assert.equal(injected, true);
  assert.equal(fs.readFileSync(target, 'utf8'), 'concurrent\n');
  assert.deepEqual(hiddenMaterializationEntries(parent), []);
  assert.deepEqual(descriptorsWithin(destinationRoot), []);
});

test('commit rolls back descriptor-relative installation when its parent is relocated mid-action', (t) => {
  const { sourceRoot, destinationRoot } = fixture(t);
  const parent = path.join(destinationRoot, 'nested');
  const moved = path.join(destinationRoot, 'moved-during-commit');
  const staged = stageScopedRegularFileCopySync({
    sourceRoot,
    destinationRoot,
    relative: 'payload.txt',
    destinationRelative: 'nested/payload.txt',
    stageId: 'commit-parent-race',
  });
  const originalLinkSync = fs.linkSync;
  let injected = false;
  fs.linkSync = (from, to) => {
    if (!injected && path.basename(String(to)) === 'payload.txt') {
      injected = true;
      fs.renameSync(parent, moved);
      fs.mkdirSync(parent);
    }
    return originalLinkSync(from, to);
  };
  try {
    assert.throws(
      () => commitStagedScopedFileSync(staged, { destinationRoot, expectedHash: null }),
      /scoped_materialization_destination_parent_changed/,
    );
  } finally {
    fs.linkSync = originalLinkSync;
  }

  assert.equal(injected, true);
  assert.equal(fs.existsSync(path.join(parent, 'payload.txt')), false);
  assert.equal(fs.existsSync(path.join(moved, 'payload.txt')), false);
  assert.deepEqual(hiddenMaterializationEntries(parent), []);
  assert.deepEqual(hiddenMaterializationEntries(moved), []);
  assert.deepEqual(descriptorsWithin(destinationRoot), []);
  assert.doesNotThrow(() => abortStagedScopedFileSync(staged));
});

test('remove restores its quarantined target when its parent is relocated mid-action', (t) => {
  const { destinationRoot } = fixture(t);
  const parent = path.join(destinationRoot, 'nested');
  const moved = path.join(destinationRoot, 'moved-during-remove');
  const target = path.join(parent, 'payload.txt');
  fs.writeFileSync(target, 'old\n');
  const current = inspectScopedRegularFileSync({ scopeRoot: destinationRoot, relative: 'nested/payload.txt' });
  const originalRenameSync = fs.renameSync;
  let injected = false;
  fs.renameSync = (from, to) => {
    if (!injected && path.basename(String(from)) === 'payload.txt' && String(to).endsWith('.removed')) {
      injected = true;
      originalRenameSync(parent, moved);
      fs.mkdirSync(parent);
    }
    return originalRenameSync(from, to);
  };
  try {
    assert.throws(
      () => removeScopedRegularFileSync({
        scopeRoot: destinationRoot,
        relative: 'nested/payload.txt',
        expectedHash: current.hash,
      }),
      /scoped_materialization_destination_parent_changed/,
    );
  } finally {
    fs.renameSync = originalRenameSync;
  }

  assert.equal(injected, true);
  assert.equal(fs.existsSync(path.join(parent, 'payload.txt')), false);
  assert.equal(fs.readFileSync(path.join(moved, 'payload.txt'), 'utf8'), 'old\n');
  assert.deepEqual(hiddenMaterializationEntries(parent), []);
  assert.deepEqual(hiddenMaterializationEntries(moved), []);
  assert.deepEqual(descriptorsWithin(destinationRoot), []);
});

test('commit keeps its durable postimage when relocation races post-completion cleanup', (t) => {
  const { sourceRoot, destinationRoot } = fixture(t);
  const parent = path.join(destinationRoot, 'nested');
  const moved = path.join(destinationRoot, 'moved-during-preimage-delete');
  const target = path.join(parent, 'payload.txt');
  fs.writeFileSync(target, 'old\n');
  const current = inspectScopedRegularFileSync({ scopeRoot: destinationRoot, relative: 'nested/payload.txt' });
  const staged = stageScopedRegularFileCopySync({
    sourceRoot,
    destinationRoot,
    relative: 'payload.txt',
    destinationRelative: 'nested/payload.txt',
    stageId: 'commit-final-delete-race',
  });
  const originalUnlinkSync = fs.unlinkSync;
  let injected = false;
  fs.unlinkSync = (candidate) => {
    if (!injected && path.basename(String(candidate)).endsWith('.preimage')) {
      injected = true;
      fs.renameSync(parent, moved);
      fs.mkdirSync(parent);
    }
    return originalUnlinkSync(candidate);
  };
  try {
    assert.throws(
      () => commitStagedScopedFileSync(staged, { destinationRoot, expectedHash: current.hash }),
      /scoped_materialization_destination_parent_changed/,
    );
  } finally {
    fs.unlinkSync = originalUnlinkSync;
  }

  assert.equal(injected, true);
  assert.equal(fs.existsSync(path.join(parent, 'payload.txt')), false);
  assert.equal(fs.readFileSync(path.join(moved, 'payload.txt'), 'utf8'), 'payload\n');
  assert.deepEqual(hiddenMaterializationEntries(parent), []);
  assert.deepEqual(hiddenMaterializationEntries(moved), []);
  assertDurableCompletionTombstones(destinationRoot);
  assert.deepEqual(descriptorsWithin(destinationRoot), []);
  assert.doesNotThrow(() => abortStagedScopedFileSync(staged));
});

test('remove keeps its durable tombstone when relocation races post-completion cleanup', (t) => {
  const { destinationRoot } = fixture(t);
  const parent = path.join(destinationRoot, 'nested');
  const moved = path.join(destinationRoot, 'moved-during-quarantine-delete');
  const target = path.join(parent, 'payload.txt');
  fs.writeFileSync(target, 'old\n');
  const current = inspectScopedRegularFileSync({ scopeRoot: destinationRoot, relative: 'nested/payload.txt' });
  const originalUnlinkSync = fs.unlinkSync;
  let injected = false;
  fs.unlinkSync = (candidate) => {
    if (!injected && path.basename(String(candidate)).endsWith('.removed')) {
      injected = true;
      fs.renameSync(parent, moved);
      fs.mkdirSync(parent);
    }
    return originalUnlinkSync(candidate);
  };
  try {
    assert.throws(
      () => removeScopedRegularFileSync({
        scopeRoot: destinationRoot,
        relative: 'nested/payload.txt',
        expectedHash: current.hash,
      }),
      /scoped_materialization_destination_parent_changed/,
    );
  } finally {
    fs.unlinkSync = originalUnlinkSync;
  }

  assert.equal(injected, true);
  assert.equal(fs.existsSync(path.join(parent, 'payload.txt')), false);
  assert.equal(fs.existsSync(path.join(moved, 'payload.txt')), false);
  assert.deepEqual(hiddenMaterializationEntries(parent), []);
  assert.deepEqual(hiddenMaterializationEntries(moved), []);
  assertDurableCompletionTombstones(destinationRoot);
  assert.deepEqual(descriptorsWithin(destinationRoot), []);
});

test('SIGKILL after durable preimage move is recovered before a replacement retry', (t) => {
  if (!fs.existsSync('/proc/self/fd')) return t.skip('descriptor-relative crash recovery requires Linux procfs');
  const { sourceRoot, destinationRoot } = fixture(t);
  const relative = 'nested/payload.txt';
  const target = path.join(destinationRoot, relative);
  fs.writeFileSync(target, 'old\n');
  const current = inspectScopedRegularFileSync({ scopeRoot: destinationRoot, relative });
  const repositoryUrl = new URL('../../paper-adapters/runtime/scoped-file-materialization-repository.mjs', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', `
    import fs from 'node:fs';
    const originalLinkSync = fs.linkSync;
    fs.linkSync = (from, to) => {
      if (path.basename(String(to)) === 'payload.txt' && path.basename(String(from)).endsWith('.tmp')) {
        process.kill(process.pid, 'SIGKILL');
      }
      return originalLinkSync(from, to);
    };
    import path from 'node:path';
    const { stageScopedRegularFileCopySync, commitStagedScopedFileSync } = await import(${JSON.stringify(repositoryUrl)});
    const staged = stageScopedRegularFileCopySync({
      sourceRoot: ${JSON.stringify(sourceRoot)},
      destinationRoot: ${JSON.stringify(destinationRoot)},
      relative: 'payload.txt',
      destinationRelative: ${JSON.stringify(relative)},
      stageId: 'sigkill-replace',
    });
    commitStagedScopedFileSync(staged, { destinationRoot: ${JSON.stringify(destinationRoot)}, expectedHash: ${JSON.stringify(current.hash)} });
  `], { encoding: 'utf8' });
  assert.equal(child.signal, 'SIGKILL', child.stderr);
  assert.equal(fs.existsSync(target), false);
  assert.equal(recoveryEntries(destinationRoot).some((name) => name.endsWith('.prepared.json')), true);
  assert.equal(recoveryEntries(destinationRoot).some((name) => name.endsWith('.preimage')), true);

  assert.equal(inspectScopedRegularFileWithRecoverySync({
    scopeRoot: destinationRoot,
    relative,
  }).hash, current.hash);
  assert.equal(fs.readFileSync(target, 'utf8'), 'old\n');

  const retry = stageScopedRegularFileCopySync({
    sourceRoot,
    destinationRoot,
    relative: 'payload.txt',
    destinationRelative: relative,
    stageId: 'sigkill-replace-retry',
  });
  assert.equal(fs.readFileSync(target, 'utf8'), 'old\n');
  assert.equal(recoveryEntries(destinationRoot).some((name) => name.endsWith('.prepared.json')), false);
  commitStagedScopedFileSync(retry, { destinationRoot, expectedHash: current.hash });
  assert.equal(fs.readFileSync(target, 'utf8'), 'payload\n');
  assertDurableCompletionTombstones(destinationRoot);
  assert.deepEqual(hiddenMaterializationEntries(path.dirname(target)), []);
});

test('remove recovers a completed replacement without mistaking it for a completed remove', (t) => {
  if (!fs.existsSync('/proc/self/fd')) return t.skip('descriptor-relative crash recovery requires Linux procfs');
  const { sourceRoot, destinationRoot } = fixture(t);
  const relative = 'nested/payload.txt';
  const target = path.join(destinationRoot, relative);
  fs.writeFileSync(target, 'old\n');
  const current = inspectScopedRegularFileSync({ scopeRoot: destinationRoot, relative });
  const repositoryUrl = new URL('../../paper-adapters/runtime/scoped-file-materialization-repository.mjs', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', `
    import fs from 'node:fs';
    import path from 'node:path';
    const originalLinkSync = fs.linkSync;
    fs.linkSync = (from, to) => {
      const result = originalLinkSync(from, to);
      if (String(to).endsWith('.completed.json')) {
        process.kill(process.pid, 'SIGKILL');
      }
      return result;
    };
    const { stageScopedRegularFileCopySync, commitStagedScopedFileSync } = await import(${JSON.stringify(repositoryUrl)});
    const staged = stageScopedRegularFileCopySync({ sourceRoot: ${JSON.stringify(sourceRoot)}, destinationRoot: ${JSON.stringify(destinationRoot)}, relative: 'payload.txt', destinationRelative: ${JSON.stringify(relative)}, stageId: 'sigkill-linked' });
    commitStagedScopedFileSync(staged, { destinationRoot: ${JSON.stringify(destinationRoot)}, expectedHash: ${JSON.stringify(current.hash)} });
  `], { encoding: 'utf8' });
  assert.equal(child.signal, 'SIGKILL', child.stderr);
  assert.equal(fs.existsSync(target), true);
  const replacement = inspectScopedRegularFileSync({ scopeRoot: sourceRoot, relative: 'payload.txt' });
  assert.equal(replacement.hash === current.hash, false);
  const removed = removeScopedRegularFileSync({
    scopeRoot: destinationRoot,
    relative,
    expectedHash: replacement.hash,
    operationId: 'remove-after-completed-replace',
  });
  assert.equal(removed.removedHash, replacement.hash);
  assert.equal(fs.existsSync(target), false);
  assert.deepEqual(hiddenMaterializationEntries(path.dirname(target)), []);
  assertDurableCompletionTombstones(destinationRoot, 2);
});

test('SIGKILL after remove quarantine is rolled back and a remove retry completes cleanly', (t) => {
  if (!fs.existsSync('/proc/self/fd')) return t.skip('descriptor-relative crash recovery requires Linux procfs');
  const { destinationRoot } = fixture(t);
  const relative = 'nested/payload.txt';
  const target = path.join(destinationRoot, relative);
  fs.writeFileSync(target, 'old\n');
  const current = inspectScopedRegularFileSync({ scopeRoot: destinationRoot, relative });
  const repositoryUrl = new URL('../../paper-adapters/runtime/scoped-file-materialization-repository.mjs', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', `
    import fs from 'node:fs';
    const originalRenameSync = fs.renameSync;
    let removedMoves = 0;
    fs.renameSync = (from, to) => {
      const result = originalRenameSync(from, to);
      if (String(to).endsWith('.removed') && ++removedMoves === 1) process.kill(process.pid, 'SIGKILL');
      return result;
    };
    const { removeScopedRegularFileSync } = await import(${JSON.stringify(repositoryUrl)});
    removeScopedRegularFileSync({
      scopeRoot: ${JSON.stringify(destinationRoot)},
      relative: ${JSON.stringify(relative)},
      expectedHash: ${JSON.stringify(current.hash)},
      operationId: 'sigkill-remove',
    });
  `], { encoding: 'utf8' });
  assert.equal(child.signal, 'SIGKILL', child.stderr);
  assert.equal(fs.existsSync(target), false);
  assert.equal(recoveryEntries(destinationRoot).some((name) => name.endsWith('.removed')), true);

  removeScopedRegularFileSync({
    scopeRoot: destinationRoot,
    relative,
    expectedHash: current.hash,
    operationId: 'sigkill-remove-retry',
  });
  assert.equal(fs.existsSync(target), false);
  assertDurableCompletionTombstones(destinationRoot);
});

test('recovery recognizes a durably completed remove instead of resurrecting its preimage', (t) => {
  if (!fs.existsSync('/proc/self/fd')) return t.skip('descriptor-relative crash recovery requires Linux procfs');
  const { destinationRoot } = fixture(t);
  const relative = 'nested/payload.txt';
  const target = path.join(destinationRoot, relative);
  fs.writeFileSync(target, 'old\n');
  const current = inspectScopedRegularFileSync({ scopeRoot: destinationRoot, relative });
  const repositoryUrl = new URL('../../paper-adapters/runtime/scoped-file-materialization-repository.mjs', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', `
    import fs from 'node:fs';
    const originalLinkSync = fs.linkSync;
    fs.linkSync = (from, to) => {
      const result = originalLinkSync(from, to);
      if (String(to).endsWith('.completed.json')) process.kill(process.pid, 'SIGKILL');
      return result;
    };
    const { removeScopedRegularFileSync } = await import(${JSON.stringify(repositoryUrl)});
    removeScopedRegularFileSync({
      scopeRoot: ${JSON.stringify(destinationRoot)},
      relative: ${JSON.stringify(relative)},
      expectedHash: ${JSON.stringify(current.hash)},
      operationId: 'sigkill-remove-finalized',
    });
  `], { encoding: 'utf8' });
  assert.equal(child.signal, 'SIGKILL', child.stderr);
  assert.equal(fs.existsSync(target), false);
  assert.equal(recoveryEntries(destinationRoot).some((name) => name.endsWith('.removed')), true);
  assert.equal(recoveryEntries(destinationRoot).some((name) => name.endsWith('.completed.json')), true);
  assert.deepEqual(removeScopedRegularFileSync({
    scopeRoot: destinationRoot,
    relative,
    expectedHash: current.hash,
    operationId: 'sigkill-remove-finalized',
  }), { relative, removedHash: current.hash });
  assert.equal(fs.existsSync(target), false);
  assertDurableCompletionTombstones(destinationRoot);
});

test('a completed remove does not satisfy a retry with the wrong expected hash', (t) => {
  if (!fs.existsSync('/proc/self/fd')) return t.skip('descriptor-relative crash recovery requires Linux procfs');
  const { destinationRoot } = fixture(t);
  const relative = 'nested/payload.txt';
  const target = path.join(destinationRoot, relative);
  fs.writeFileSync(target, 'old\n');
  const current = inspectScopedRegularFileSync({ scopeRoot: destinationRoot, relative });
  const repositoryUrl = new URL('../../paper-adapters/runtime/scoped-file-materialization-repository.mjs', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', `
    import fs from 'node:fs';
    const originalLinkSync = fs.linkSync;
    fs.linkSync = (from, to) => {
      const result = originalLinkSync(from, to);
      if (String(to).endsWith('.completed.json')) process.kill(process.pid, 'SIGKILL');
      return result;
    };
    const { removeScopedRegularFileSync } = await import(${JSON.stringify(repositoryUrl)});
    removeScopedRegularFileSync({
      scopeRoot: ${JSON.stringify(destinationRoot)},
      relative: ${JSON.stringify(relative)},
      expectedHash: ${JSON.stringify(current.hash)},
      operationId: 'sigkill-remove-wrong-hash',
    });
  `], { encoding: 'utf8' });
  assert.equal(child.signal, 'SIGKILL', child.stderr);
  assert.equal(fs.existsSync(target), false);

  assert.throws(
    () => removeScopedRegularFileSync({
      scopeRoot: destinationRoot,
      relative,
      expectedHash: `sha256:${'0'.repeat(64)}`,
      operationId: 'sigkill-remove-wrong-hash',
    }),
    /scoped_materialization_operation_definition_conflict|scoped_materialization_preimage_conflict/,
  );
  assert.equal(fs.existsSync(target), false);
  assert.equal(recoveryEntries(destinationRoot).some((name) => name.endsWith('.completed.json')), true);
});

test('recovery refuses a relocated symlink parent without touching the outside target', (t) => {
  if (!fs.existsSync('/proc/self/fd')) return t.skip('descriptor-relative crash recovery requires Linux procfs');
  const { root, sourceRoot, destinationRoot } = fixture(t);
  const relative = 'nested/payload.txt';
  const parent = path.join(destinationRoot, 'nested');
  const target = path.join(parent, 'payload.txt');
  fs.writeFileSync(target, 'old\n');
  const current = inspectScopedRegularFileSync({ scopeRoot: destinationRoot, relative });
  const repositoryUrl = new URL('../../paper-adapters/runtime/scoped-file-materialization-repository.mjs', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', `
    import fs from 'node:fs';
    import path from 'node:path';
    const originalLinkSync = fs.linkSync;
    fs.linkSync = (from, to) => {
      if (path.basename(String(to)) === 'payload.txt' && path.basename(String(from)).endsWith('.tmp')) {
        process.kill(process.pid, 'SIGKILL');
      }
      return originalLinkSync(from, to);
    };
    const { stageScopedRegularFileCopySync, commitStagedScopedFileSync } = await import(${JSON.stringify(repositoryUrl)});
    const staged = stageScopedRegularFileCopySync({ sourceRoot: ${JSON.stringify(sourceRoot)}, destinationRoot: ${JSON.stringify(destinationRoot)}, relative: 'payload.txt', destinationRelative: ${JSON.stringify(relative)}, stageId: 'sigkill-relocate' });
    commitStagedScopedFileSync(staged, { destinationRoot: ${JSON.stringify(destinationRoot)}, expectedHash: ${JSON.stringify(current.hash)} });
  `], { encoding: 'utf8' });
  assert.equal(child.signal, 'SIGKILL', child.stderr);
  const moved = path.join(destinationRoot, 'relocated-parent');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'payload.txt'), 'outside\n');
  fs.renameSync(parent, moved);
  fs.symlinkSync(outside, parent, 'dir');
  assert.throws(
    () => recoverScopedMaterializationIntentsSync({ scopeRoot: destinationRoot }),
    /scoped_materialization_destination_parent_unsafe|scoped_materialization_recovery_parent_changed/,
  );
  assert.equal(fs.readFileSync(path.join(outside, 'payload.txt'), 'utf8'), 'outside\n');
  assert.equal(recoveryEntries(destinationRoot).some((name) => name.endsWith('.preimage')), true);
  fs.unlinkSync(parent);
  fs.renameSync(moved, parent);
  assert.deepEqual(recoverScopedMaterializationIntentsSync({ scopeRoot: destinationRoot }), [
    {
      status: 'rolled_back',
      operation: 'replace',
      operationId: 'sigkill-relocate',
      relative,
      preimageHash: current.hash,
      postimageHash: 'sha256:d4e4877bac978b7952f0d544fc52ebff5411d351d129f1f056fa43f11da9af2b',
    },
  ]);
  assert.equal(fs.readFileSync(target, 'utf8'), 'old\n');
  assert.equal(recoveryEntries(destinationRoot).some((name) => name.endsWith('.prepared.json')), false);
  assert.equal(recoveryEntries(destinationRoot).some((name) => name.endsWith('.preimage')), false);
  assert.equal(recoveryEntries(destinationRoot).some((name) => name.startsWith('.definition-')), true);
});
