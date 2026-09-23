import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  createLeanToolchainIdentityProvider,
  inspectLeanToolchainRootContent,
} from '../../paper-adapters/research-verify/lean-toolchain-identity.mjs';
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

test('Lean root content can be anchor-verified without dynamic executable inspection', (t) => {
  const root = fixture(t);
  const options = {
    toolchain: 'leanprover/lean4:v-fixture',
    toolchainRoot: root,
    leanExecutable: path.join(root, 'bin', 'lean'),
    lakeExecutable: path.join(root, 'bin', 'lake'),
    forceContentRehash: true,
  };
  const measured = inspectLeanToolchainRootContent(options);
  assert.equal(measured.status, 'lean_toolchain_root_content_blocked');
  const verified = inspectLeanToolchainRootContent({
    ...options,
    expectedToolchainRootMerkleHash: measured.measuredToolchainRootMerkleHash,
  });
  assert.equal(verified.status, 'lean_toolchain_root_content_verified');
  assert.equal(
    verified.toolchainRootMerkleHash,
    measured.measuredToolchainRootMerkleHash,
  );
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

test('Lean toolchain cache cannot cross a stricter ownership policy', (t) => {
  const root = fixture(t);
  const measured = provider(root).inspect({ forceContentRehash: true });
  assert.equal(
    provider(root, measured.measuredToolchainRootMerkleHash).inspect().status,
    'lean_toolchain_identity_verified',
  );
  const rootOwned = createLeanToolchainIdentityProvider({
    toolchain: 'leanprover/lean4:v-fixture',
    toolchainRoot: root,
    leanExecutable: path.join(root, 'bin', 'lean'),
    lakeExecutable: path.join(root, 'bin', 'lake'),
    expectedToolchainRootMerkleHash: measured.measuredToolchainRootMerkleHash,
    requiredOwnerUid: 0,
    requiredOwnerGid: 0,
    forbidGroupOrOtherWrite: true,
  }).inspect();
  assert.equal(rootOwned.status, 'lean_toolchain_identity_blocked');
  assert.ok(rootOwned.blockers.includes('formal_toolchain_root_owner_uid_mismatch'));
});

test('Lean toolchain cache binds the selected Lean and Lake relative paths', (t) => {
  const root = fixture(t);
  const secondLean = path.join(root, 'bin', 'second-lean');
  fs.copyFileSync('/bin/true', secondLean);
  const measured = provider(root).inspect({ forceContentRehash: true });
  const common = {
    toolchain: 'leanprover/lean4:v-fixture',
    toolchainRoot: root,
    lakeExecutable: path.join(root, 'bin', 'lake'),
    expectedToolchainRootMerkleHash: measured.measuredToolchainRootMerkleHash,
  };
  const first = createLeanToolchainIdentityProvider({
    ...common,
    leanExecutable: path.join(root, 'bin', 'lean'),
  }).inspect({ forceContentRehash: true });
  const second = createLeanToolchainIdentityProvider({
    ...common,
    leanExecutable: secondLean,
  }).inspect();
  assert.equal(first.status, 'lean_toolchain_identity_verified');
  assert.equal(second.status, 'lean_toolchain_identity_verified');
  assert.equal(first.leanExecutablePath, 'bin/lean');
  assert.equal(second.leanExecutablePath, 'bin/second-lean');
  assert.notEqual(
    first.leanToolchainContentIdentityHash,
    second.leanToolchainContentIdentityHash,
  );
});

test('sealed Lean toolchain policy rejects special mode bits outside the Merkle mode mask', (t) => {
  const root = fixture(t);
  const lean = path.join(root, 'bin', 'lean');
  fs.chmodSync(lean, 0o4755);
  const measured = provider(root).inspect({ forceContentRehash: true });
  const sealed = createLeanToolchainIdentityProvider({
    toolchain: 'leanprover/lean4:v-fixture',
    toolchainRoot: root,
    leanExecutable: lean,
    lakeExecutable: path.join(root, 'bin', 'lake'),
    expectedToolchainRootMerkleHash: measured.measuredToolchainRootMerkleHash,
    forbidGroupOrOtherWrite: true,
  }).inspect({ forceContentRehash: true });
  assert.equal(sealed.status, 'lean_toolchain_identity_blocked');
  assert.ok(sealed.blockers.includes(
    'formal_toolchain_entry_special_mode_bits_forbidden:bin/lean',
  ));
});

test('sealed Lean toolchain policy rejects ACL and capability-bearing extended attributes', (t) => {
  const root = fixture(t);
  const lean = path.join(root, 'bin', 'lean');
  for (const directory of [
    path.join(root, 'bin'),
    path.join(root, 'lib'),
    path.join(root, 'lib', 'lean'),
  ]) fs.chmodSync(directory, 0o755);
  for (const file of [
    path.join(root, 'lib', 'lean', 'Init.olean'),
    path.join(root, 'lib', 'liblean-runtime.so'),
  ]) fs.chmodSync(file, 0o644);
  fs.chmodSync(lean, 0o755);
  fs.chmodSync(path.join(root, 'bin', 'lake'), 0o755);
  const applied = spawnSync('/usr/bin/python3', [
    '-I', '-c',
    'import os,sys; os.setxattr(sys.argv[1], b"user.hepta_fixture", b"blocked")',
    lean,
  ], { encoding: 'utf8' });
  if (applied.status !== 0) {
    t.skip(`extended attributes unavailable: ${applied.stderr || applied.error}`);
    return;
  }
  const measured = provider(root).inspect({ forceContentRehash: true });
  const sealed = createLeanToolchainIdentityProvider({
    toolchain: 'leanprover/lean4:v-fixture',
    toolchainRoot: root,
    leanExecutable: lean,
    lakeExecutable: path.join(root, 'bin', 'lake'),
    expectedToolchainRootMerkleHash: measured.measuredToolchainRootMerkleHash,
    forbidGroupOrOtherWrite: true,
  }).inspect({ forceContentRehash: true });
  assert.equal(sealed.status, 'lean_toolchain_identity_blocked');
  assert.ok(sealed.blockers.includes(
    'formal_toolchain_extended_attributes_forbidden',
  ));
});
