import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createLeanToolchainIdentityProvider } from '../../paper-adapters/research-verify/lean-toolchain-identity.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-lean-toolchain-identity-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(root, 'lib', 'lean'), { recursive: true });
  fs.copyFileSync('/bin/true', path.join(root, 'bin', 'lean'));
  fs.copyFileSync('/bin/true', path.join(root, 'bin', 'lake'));
  fs.writeFileSync(path.join(root, 'lib', 'lean', 'Init.olean'), 'stdlib-fixture\n');
  fs.writeFileSync(path.join(root, 'lib', 'liblean-runtime.so'), 'runtime-fixture\n');
  return root;
}

function provider(root, expectedToolchainRootMerkleHash = null) {
  return createLeanToolchainIdentityProvider({
    toolchain: 'leanprover/lean4:v-fixture',
    toolchainRoot: root,
    leanExecutable: path.join(root, 'bin', 'lean'),
    lakeExecutable: path.join(root, 'bin', 'lake'),
    expectedToolchainRootMerkleHash,
  });
}

test('Lean toolchain certificates require an independent root anchor and bind host dynamic libraries', (t) => {
  const root = fixture(t);
  const untrusted = provider(root).inspect({ forceContentRehash: true });
  assert.equal(untrusted.status, 'lean_toolchain_identity_blocked');
  assert.deepEqual(untrusted.blockers, ['formal_toolchain_trust_anchor_required']);
  assert.match(untrusted.measuredToolchainRootMerkleHash, /^sha256:[0-9a-f]{64}$/);

  const trusted = provider(root, untrusted.measuredToolchainRootMerkleHash).inspect({ forceContentRehash: true });
  assert.equal(trusted.status, 'lean_toolchain_identity_verified');
  assert.equal(trusted.toolchainTrustAnchorStatus, 'pinned_toolchain_root_allowlist_verified');
  assert.equal(trusted.trustedToolchainRootMerkleHash, trusted.toolchainRootMerkleHash);
  assert.ok(trusted.externalDynamicRuntimeFileCount >= 3);
  assert.match(trusted.externalDynamicRuntimeManifestHash, /^sha256:[0-9a-f]{64}$/);
});

test('Lean toolchain cache cannot hide same-size content replacement with restored mtime', (t) => {
  const root = fixture(t);
  const untrusted = provider(root).inspect({ forceContentRehash: true });
  const trustedProvider = provider(root, untrusted.measuredToolchainRootMerkleHash);
  assert.equal(trustedProvider.inspect().status, 'lean_toolchain_identity_verified');

  const target = path.join(root, 'lib', 'liblean-runtime.so');
  const before = fs.statSync(target);
  const original = fs.readFileSync(target);
  const replacement = Buffer.from(original.map((byte) => byte ^ 1));
  fs.writeFileSync(target, replacement);
  fs.utimesSync(target, before.atime, before.mtime);

  const changed = trustedProvider.inspect();
  assert.equal(changed.status, 'lean_toolchain_identity_blocked');
  assert.ok(changed.blockers.includes('formal_toolchain_trust_anchor_mismatch'));
});

test('Lean toolchain identity changes when the resolved host runtime closure drifts', (t) => {
  const root = fixture(t);
  const measured = provider(root).inspect({ forceContentRehash: true });
  let generation = 0;
  const trustedProvider = createLeanToolchainIdentityProvider({
    toolchain: 'leanprover/lean4:v-fixture-host-drift',
    toolchainRoot: root,
    leanExecutable: path.join(root, 'bin', 'lean'),
    lakeExecutable: path.join(root, 'bin', 'lake'),
    expectedToolchainRootMerkleHash: measured.measuredToolchainRootMerkleHash,
    inspectExternalRuntime() {
      generation += 1;
      const records = Object.freeze([Object.freeze({
        path: '/lib/libfixture.so',
        mode: 0o555,
        bytes: 1,
        hash: `sha256:${generation === 1 ? '1'.repeat(64) : '2'.repeat(64)}`,
        stat: Object.freeze({ generation: generation === 1 ? 1 : 2 }),
      })]);
      return Object.freeze({
        records,
        blockers: Object.freeze([]),
        metadataManifestHash: hashRecord(
          'LeanExternalDynamicRuntimeMetadataManifest',
          records.map(({ hash: _hash, ...record }) => record),
        ),
      });
    },
  });
  const before = trustedProvider.inspect({ forceContentRehash: true });
  const after = trustedProvider.inspect();
  assert.equal(before.status, 'lean_toolchain_identity_verified');
  assert.equal(after.status, 'lean_toolchain_identity_verified');
  assert.notEqual(after.externalDynamicRuntimeManifestHash,
    before.externalDynamicRuntimeManifestHash);
  assert.notEqual(after.leanToolchainContentIdentityHash,
    before.leanToolchainContentIdentityHash);
});
