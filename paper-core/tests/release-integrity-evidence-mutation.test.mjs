import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { releaseIntegrityEvidence } from '../bin/release-integrity-evidence.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-release-integrity-mutation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('identity-bound file rollback removes only the exact failed publication', (t) => {
  const root = fixture(t);
  const unsafeParent = path.join(root, 'not-a-directory');
  fs.writeFileSync(unsafeParent, 'preserve');
  assert.throws(
    () => releaseIntegrityEvidence.writeNoClobberJsonFile(
      path.join(unsafeParent, 'artifact.json'),
      { version: 1 },
    ),
    /release_evidence_output_directory_unsafe/,
  );

  const changed = path.join(root, 'changed.json');
  assert.throws(
    () => releaseIntegrityEvidence.writeNoClobberJsonFile(changed, { version: 1 }, {
      beforePostimageInspection() {
        fs.chmodSync(changed, 0o600);
        fs.truncateSync(changed, 0);
      },
    }),
    /release_evidence_output_postimage_mismatch/,
  );
  assert.equal(fs.existsSync(changed), false);

  assert.equal(releaseIntegrityEvidence.removeExactPublishedFile({
    path: path.join(root, 'absent.json'),
    identity: { dev: 1, ino: 1 },
    preexisting: false,
  }), false);

  const preserved = path.join(root, 'preserved.json');
  fs.writeFileSync(preserved, 'preserve');
  const preservedStat = fs.lstatSync(preserved);
  assert.equal(releaseIntegrityEvidence.removeExactPublishedFile({
    path: preserved,
    identity: { dev: preservedStat.dev, ino: preservedStat.ino + 1 },
    preexisting: false,
  }), false);
  assert.equal(fs.readFileSync(preserved, 'utf8'), 'preserve');

  const raced = path.join(root, 'raced.json');
  const held = path.join(root, 'raced-held.json');
  assert.throws(
    () => releaseIntegrityEvidence.writeNoClobberJsonFile(raced, { version: 1 }, {
      beforePostimageInspection() {
        fs.renameSync(raced, held);
        fs.writeFileSync(raced, 'concurrent');
        throw new Error('injected_postimage_race');
      },
    }),
    /release_evidence_output_rollback_incomplete:injected_postimage_race/,
  );
  assert.equal(fs.readFileSync(raced, 'utf8'), 'concurrent');
  assert.equal(fs.existsSync(held), true);

  const injectedPath = path.join(root, 'injected.json');
  fs.writeFileSync(injectedPath, 'preserve');
  const injectedStat = fs.lstatSync(injectedPath);
  const renameFailure = new Proxy(fs, {
    get(target, property) {
      if (property === 'renameSync') return () => { throw new Error('injected_rename'); };
      return target[property];
    },
  });
  assert.equal(releaseIntegrityEvidence.removeExactPublishedFile({
    path: injectedPath,
    identity: { dev: injectedStat.dev, ino: injectedStat.ino },
    preexisting: false,
  }, { fileSystem: renameFailure }), false);
});

test('injected descriptor and quarantine failures remain identity-bound', async (t) => {
  const root = fixture(t);
  await t.test('unsafe opened file identity is closed and removed', () => {
    const candidate = path.join(root, 'unsafe-opened.json');
    const unsafeFstat = new Proxy(fs, {
      get(target, property) {
        if (property === 'fstatSync') {
          return (descriptor) => {
            const stat = target.fstatSync(descriptor);
            return new Proxy(stat, {
              get(selected, key) {
                if (key === 'isFile') return () => false;
                return Reflect.get(selected, key, selected);
              },
            });
          };
        }
        return target[property];
      },
    });
    assert.throws(
      () => releaseIntegrityEvidence.writeNoClobberJsonFile(
        candidate,
        { version: 1 },
        { fileSystem: unsafeFstat },
      ),
      /release_evidence_output_file_unsafe/,
    );
    assert.equal(fs.existsSync(candidate), false);
  });

  await t.test('descriptor write failure closes and removes the exact file', () => {
    const candidate = path.join(root, 'write-failure.json');
    const writeFailure = new Proxy(fs, {
      get(target, property) {
        if (property === 'writeSync') return () => { throw new Error('injected_write_failure'); };
        return target[property];
      },
    });
    assert.throws(
      () => releaseIntegrityEvidence.writeNoClobberJsonFile(
        candidate,
        { version: 1 },
        { fileSystem: writeFailure },
      ),
      /injected_write_failure/,
    );
    assert.equal(fs.existsSync(candidate), false);
  });

  await t.test('failed concurrent-path restoration never overwrites', () => {
    const candidate = path.join(root, 'restore-link-failure.json');
    fs.writeFileSync(candidate, 'preserve');
    const stat = fs.lstatSync(candidate);
    const linkFailure = new Proxy(fs, {
      get(target, property) {
        if (property === 'linkSync') return () => { throw new Error('injected_link_failure'); };
        return target[property];
      },
    });
    assert.equal(releaseIntegrityEvidence.removeExactPublishedFile({
      path: candidate,
      identity: { dev: stat.dev, ino: stat.ino + 1 },
      preexisting: false,
    }, { fileSystem: linkFailure }), false);
    assert.equal(fs.existsSync(candidate), false);
  });

  await t.test('restored identity mismatch remains quarantined', () => {
    const candidate = path.join(root, 'restore-identity-failure.json');
    fs.writeFileSync(candidate, 'preserve');
    const stat = fs.lstatSync(candidate);
    let linked = false;
    const identityFailure = new Proxy(fs, {
      get(target, property) {
        if (property === 'linkSync') {
          return (...args) => {
            target.linkSync(...args);
            linked = true;
          };
        }
        if (property === 'lstatSync') {
          return (selected) => {
            const current = target.lstatSync(selected);
            if (!linked || selected !== candidate) return current;
            return new Proxy(current, {
              get(value, key) {
                if (key === 'dev') return value.dev + 1;
                return Reflect.get(value, key, value);
              },
            });
          };
        }
        return target[property];
      },
    });
    assert.equal(releaseIntegrityEvidence.removeExactPublishedFile({
      path: candidate,
      identity: { dev: stat.dev, ino: stat.ino + 1 },
      preexisting: false,
    }, { fileSystem: identityFailure }), false);
  });

  await t.test('quarantine cleanup failure preserves both recovery links', () => {
    const candidate = path.join(root, 'restore-cleanup-failure.json');
    fs.writeFileSync(candidate, 'preserve');
    const stat = fs.lstatSync(candidate);
    let renames = 0;
    const cleanupFailure = new Proxy(fs, {
      get(target, property) {
        if (property === 'renameSync') {
          return (...args) => {
            renames += 1;
            if (renames === 2) throw new Error('injected_quarantine_cleanup_failure');
            return target.renameSync(...args);
          };
        }
        return target[property];
      },
    });
    assert.equal(releaseIntegrityEvidence.removeExactPublishedFile({
      path: candidate,
      identity: { dev: stat.dev, ino: stat.ino + 1 },
      preexisting: false,
    }, { fileSystem: cleanupFailure }), false);
    assert.equal(fs.existsSync(candidate), true);
  });
});

test('artifact-set preflight rejects shape, collision, and mutable exact replay', (t) => {
  const root = fixture(t);
  const artifactPath = path.join(root, 'artifact.json');
  const value = { version: 1, kind: 'IntegrityMutationFixture' };
  releaseIntegrityEvidence.writeNoClobberJsonFile(artifactPath, value);
  assert.throws(
    () => releaseIntegrityEvidence.writeNoClobberJsonFiles([
      { path: artifactPath, value },
    ]),
    /release_evidence_artifact_collision/,
  );
  fs.chmodSync(artifactPath, 0o600);
  assert.throws(
    () => releaseIntegrityEvidence.writeNoClobberJsonFiles([
      { path: artifactPath, value, allowExistingExact: true },
    ]),
    /release_evidence_existing_artifact_conflict/,
  );
  fs.chmodSync(artifactPath, 0o444);
  const exact = releaseIntegrityEvidence.writeNoClobberJsonFiles([
    { path: artifactPath, value, allowExistingExact: true },
  ]);
  assert.equal(exact[0].preexisting, true);

  let serializations = 0;
  const lateFailure = {
    toJSON() {
      serializations += 1;
      if (serializations === 2) throw new Error('injected_late_serialization_failure');
      return { version: 1 };
    },
  };
  const firstPath = path.join(root, 'first.json');
  assert.throws(
    () => releaseIntegrityEvidence.writeNoClobberJsonFiles([
      { path: firstPath, value: { version: 1 } },
      { path: path.join(root, 'second.json'), value: lateFailure },
    ]),
    /injected_late_serialization_failure/,
  );
  assert.equal(fs.existsSync(firstPath), false);

  let racingSerializations = 0;
  const racingFirstPath = path.join(root, 'racing-first.json');
  const racingHeldPath = path.join(root, 'racing-first-held.json');
  const racingFailure = {
    toJSON() {
      racingSerializations += 1;
      if (racingSerializations === 2) {
        fs.renameSync(racingFirstPath, racingHeldPath);
        fs.writeFileSync(racingFirstPath, 'concurrent');
        throw new Error('injected_racing_serialization_failure');
      }
      return { version: 1 };
    },
  };
  assert.throws(
    () => releaseIntegrityEvidence.writeNoClobberJsonFiles([
      { path: racingFirstPath, value: { version: 1 } },
      { path: path.join(root, 'racing-second.json'), value: racingFailure },
    ]),
    /release_evidence_artifact_set_rollback_incomplete/,
  );
  assert.equal(fs.readFileSync(racingFirstPath, 'utf8'), 'concurrent');
});

test('artifact and pointer postimage mutations roll back the whole publication', async (t) => {
  const root = fixture(t);
  for (const boundary of ['beforePointer', 'afterPointer']) {
    await t.test(boundary, () => {
      const directory = path.join(root, boundary);
      fs.mkdirSync(directory);
      const artifactPath = path.join(directory, 'artifact.json');
      const pointerPath = path.join(directory, 'CURRENT.json');
      const mutateArtifact = () => fs.chmodSync(artifactPath, 0o600);
      assert.throws(
        () => releaseIntegrityEvidence.publishJsonArtifactSet({
          entries: [{ path: artifactPath, value: { version: 1 } }],
          pointerPath,
          pointerValue: { version: 1, artifact: 'artifact.json' },
          beforePointer: boundary === 'beforePointer' ? mutateArtifact : () => {},
          afterPointer: boundary === 'afterPointer' ? mutateArtifact : () => {},
        }),
        boundary === 'beforePointer'
          ? /release_evidence_artifact_changed_before_pointer/
          : /release_evidence_publication_postimage_changed/,
      );
      assert.equal(fs.existsSync(artifactPath), false);
      assert.equal(fs.existsSync(pointerPath), false);
      assert.equal(
        fs.existsSync(path.join(directory, '.release-integrity-publication.lock')),
        false,
      );
    });
  }

  assert.equal(
    releaseIntegrityEvidence.existingDirectoryWithinRuntime(root, root),
    null,
  );
  assert.equal(
    releaseIntegrityEvidence.existingDirectoryWithinRuntime(root, path.dirname(root)),
    null,
  );
});

test('pointer races preserve the concurrent path and reject incomplete rollback', async (t) => {
  const root = fixture(t);
  await t.test('existing pointer changes before commit', () => {
    const directory = path.join(root, 'existing');
    fs.mkdirSync(directory);
    const pointerPath = path.join(directory, 'CURRENT.json');
    const previousPath = path.join(directory, 'CURRENT.previous.json');
    fs.writeFileSync(pointerPath, '{"version":0}\n', { mode: 0o444 });
    let serialized = false;
    const pointerValue = {
      toJSON() {
        if (!serialized) {
          serialized = true;
          fs.renameSync(pointerPath, previousPath);
          fs.writeFileSync(pointerPath, '{"version":"concurrent"}\n', { mode: 0o444 });
        }
        return { version: 1 };
      },
    };
    assert.throws(
      () => releaseIntegrityEvidence.publishJsonArtifactSet({
        entries: [],
        pointerPath,
        pointerValue,
      }),
      /release_evidence_pointer_changed_before_commit/,
    );
    assert.equal(JSON.parse(fs.readFileSync(pointerPath, 'utf8')).version, 'concurrent');
  });

  await t.test('new pointer identity changes before postimage inspection', () => {
    const directory = path.join(root, 'new');
    fs.mkdirSync(directory);
    const pointerPath = path.join(directory, 'CURRENT.json');
    const heldPath = path.join(directory, 'CURRENT.held.json');
    assert.throws(
      () => releaseIntegrityEvidence.publishJsonArtifactSet({
        entries: [],
        pointerPath,
        pointerValue: { version: 1 },
        pointerHooks: {
          beforeStagingCleanup() {
            fs.renameSync(pointerPath, heldPath);
            fs.writeFileSync(pointerPath, '{"version":"concurrent"}\n', { mode: 0o444 });
          },
        },
      }),
      /release_evidence_pointer_rollback_incomplete/,
    );
    assert.equal(JSON.parse(fs.readFileSync(pointerPath, 'utf8')).version, 'concurrent');
    assert.equal(fs.existsSync(heldPath), true);
  });
});

test('pointer preimage mutations cover hard-link and in-place races', async (t) => {
  const root = fixture(t);
  await t.test('hard-linked pointer is unsafe', () => {
    const directory = path.join(root, 'hard-link');
    fs.mkdirSync(directory);
    const pointerPath = path.join(directory, 'CURRENT.json');
    fs.writeFileSync(pointerPath, '{"version":0}\n', { mode: 0o444 });
    fs.linkSync(pointerPath, path.join(directory, 'CURRENT.alias.json'));
    assert.throws(
      () => releaseIntegrityEvidence.publishJsonArtifactSet({
        entries: [],
        pointerPath,
        pointerValue: { version: 1 },
      }),
      /release_evidence_pointer_unsafe/,
    );
  });

  await t.test('same pointer inode changes size before commit', () => {
    const directory = path.join(root, 'in-place');
    fs.mkdirSync(directory);
    const pointerPath = path.join(directory, 'CURRENT.json');
    fs.writeFileSync(pointerPath, '{"version":0}\n', { mode: 0o444 });
    let serialized = false;
    const pointerValue = {
      toJSON() {
        if (!serialized) {
          serialized = true;
          fs.chmodSync(pointerPath, 0o600);
          fs.appendFileSync(pointerPath, ' ');
          fs.chmodSync(pointerPath, 0o444);
        }
        return { version: 1 };
      },
    };
    assert.throws(
      () => releaseIntegrityEvidence.publishJsonArtifactSet({
        entries: [],
        pointerPath,
        pointerValue,
      }),
      /release_evidence_pointer_changed_before_commit/,
    );
  });
});

test('concurrent postimages and lock replacement are never overwritten', async (t) => {
  const root = fixture(t);
  await t.test('artifact and pointer replacement make rollback visibly incomplete', () => {
    const directory = path.join(root, 'publication-race');
    fs.mkdirSync(directory);
    const artifactPath = path.join(directory, 'artifact.json');
    const pointerPath = path.join(directory, 'CURRENT.json');
    const heldArtifactPath = path.join(directory, 'artifact.held.json');
    const heldPointerPath = path.join(directory, 'CURRENT.held.json');
    assert.throws(
      () => releaseIntegrityEvidence.publishJsonArtifactSet({
        entries: [{ path: artifactPath, value: { version: 1 } }],
        pointerPath,
        pointerValue: { version: 1 },
        afterPointer() {
          fs.renameSync(artifactPath, heldArtifactPath);
          fs.writeFileSync(artifactPath, '{"concurrent":true}\n', { mode: 0o444 });
          fs.renameSync(pointerPath, heldPointerPath);
          fs.writeFileSync(pointerPath, '{"concurrent":true}\n', { mode: 0o444 });
        },
      }),
      /release_evidence_publication_rollback_incomplete/,
    );
    assert.equal(JSON.parse(fs.readFileSync(artifactPath, 'utf8')).concurrent, true);
    assert.equal(JSON.parse(fs.readFileSync(pointerPath, 'utf8')).concurrent, true);
  });

  await t.test('publication lock replacement blocks authority release', () => {
    const directory = path.join(root, 'lock-race');
    fs.mkdirSync(directory);
    const lockPath = path.join(directory, '.release-integrity-publication.lock');
    const heldLockPath = path.join(directory, '.release-integrity-publication.held');
    assert.throws(
      () => releaseIntegrityEvidence.publishJsonArtifactSet({
        entries: [],
        pointerPath: path.join(directory, 'CURRENT.json'),
        pointerValue: { version: 1 },
        afterPointer() {
          fs.renameSync(lockPath, heldLockPath);
          fs.writeFileSync(lockPath, 'concurrent', { mode: 0o600 });
        },
      }),
      /release_evidence_publication_lock_release_failed/,
    );
    assert.equal(fs.readFileSync(lockPath, 'utf8'), 'concurrent');
  });

  const unsafeParent = path.join(root, 'publication-parent-file');
  fs.writeFileSync(unsafeParent, 'unsafe');
  assert.throws(
    () => releaseIntegrityEvidence.publishJsonArtifactSet({
      entries: [],
      pointerPath: path.join(unsafeParent, 'CURRENT.json'),
      pointerValue: { version: 1 },
    }),
    /release_integrity_directory_chain_unsafe/,
  );
});
