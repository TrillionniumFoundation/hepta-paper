import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createLeanToolchainIdentityProvider } from '../../paper-adapters/research-verify/lean-toolchain-identity.mjs';

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
