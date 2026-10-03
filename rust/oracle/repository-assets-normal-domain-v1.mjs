// Actual copied ordinary frontends. The outer existing bounded process owner
// owns this process and all inherited-group children; this is no authority proof.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
assert.equal(process.version, 'v22.23.1');
const raw = fs.readFileSync(0);
assert.ok(raw.length <= 65536);
const { source, native } = JSON.parse(raw);
const { hashRecord } = await import(pathToFileURL(path.join(source, 'workflow-kernel/record-hash.mjs')));
const { ASSET_DOMAIN_PROFILES_V1: inputs, assetHandoffDiagnosticV1 } = await import(pathToFileURL(path.join(source,
  'docs/tools/node-rust-asset-route-acceptance.mjs')));
const snapshot = metadata => [metadata.dev, metadata.ino, metadata.mode, metadata.uid, metadata.gid,
  metadata.nlink, metadata.size, metadata.mtimeNs, metadata.ctimeNs].map(String);
function pin(file, maximum = 256 * 1024 * 1024, buildInput = false) {
  const named = fs.lstatSync(file, { bigint: true });
  assert.ok(named.isFile() && (buildInput ? named.nlink > 0n : named.nlink === 1n) && named.size <= BigInt(maximum));
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    assert.deepEqual(snapshot(fs.fstatSync(fd, { bigint: true })), snapshot(named));
    const hash = createHash('sha256'), buffer = Buffer.alloc(65536); let total = 0;
    for (let count; (count = fs.readSync(fd, buffer)) !== 0;) {
      total += count; assert.ok(total <= maximum && BigInt(total) <= named.size);
      hash.update(buffer.subarray(0, count));
    }
    assert.equal(BigInt(total), named.size);
    assert.deepEqual(snapshot(fs.fstatSync(fd, { bigint: true })), snapshot(named));
    assert.deepEqual(snapshot(fs.lstatSync(file, { bigint: true })), snapshot(named));
    return { identity: snapshot(named), sha256: hash.digest('hex') };
  } finally { fs.closeSync(fd); }
}
const completeMessage = 'repository_asset_externalization_handoff_blocked:[object Object]:first,fixture:second';
assert.equal(assetHandoffDiagnosticV1(`Error: ${completeMessage}\n    at fixture (actual.js:1:1)\n`), completeMessage);
assert.equal(assetHandoffDiagnosticV1(`hepta-paper-rust: ${completeMessage}\n`), completeMessage);
assert.notEqual(assetHandoffDiagnosticV1(`hepta-paper-rust: ${completeMessage}:forged\n`), completeMessage);
assert.throws(() => assetHandoffDiagnosticV1(`Error: ${completeMessage}\nError: ${completeMessage}\n    at fixture (actual.js:1:1)\n`), /asset_handoff_diagnostic_ambiguous/u);
let actualHandoffRefusals = 0;
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'asset-normal-domain-'));
const deployment = path.join(fixture, 'deployment'), caller = path.join(fixture, 'caller');
const graph = new Map(); let copiedBytes = 0;
function copy(from, to, mode, maximum, buildInput = false) {
  const before = pin(from, maximum, buildInput);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL); fs.chmodSync(to, mode);
  const copied = pin(to, maximum); assert.equal(copied.sha256, before.sha256);
  assert.deepEqual(pin(from, maximum, buildInput), before); return { from, to, before, copied, buildInput };
}
function observe(program, args) {
  const output = spawnSync(program, args, { cwd: caller,
    env: { PATH: process.env.PATH, NODE_V8_COVERAGE: '' }, shell: false,
    timeout: 30000, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
  assert.equal(output.error, undefined, output.error?.message);
  assert.equal(output.signal, null, output.stderr);
  if (output.stdout.trim()) return { exit: output.status, report: JSON.parse(output.stdout), error: null };
  const error = assetHandoffDiagnosticV1(output.stderr);
  assert.equal(typeof error, 'string', output.stderr); actualHandoffRefusals += 1; return { exit: output.status, report: null, error };
}
try {
  fs.mkdirSync(caller); fs.mkdirSync(path.join(deployment, 'paper-core/config'), { recursive: true });
  const pending = ['paper-core/bin/hepta-paper.mjs', 'paper-core/bin/repository-asset-status.mjs'];
  while (pending.length) {
    const relative = pending.pop(); if (graph.has(relative)) continue;
    assert.ok(graph.size < 512);
    const from = path.join(source, relative), metadata = fs.lstatSync(from, { bigint: true });
    assert.ok(metadata.isFile() && metadata.size <= 16n * 1024n * 1024n);
    copiedBytes += Number(metadata.size); assert.ok(copiedBytes <= 16 * 1024 * 1024);
    graph.set(relative, copy(from, path.join(deployment, relative), 0o440, 16 * 1024 * 1024));
    const text = fs.readFileSync(from, 'utf8');
    for (const match of text.matchAll(/(?:from\s+|import\s+|import\s*\()\s*['"]([^'"]+)['"]/gu)) {
      const name = match[1]; if (name.startsWith('node:')) continue;
      assert.ok(name.startsWith('.'), `unbound source import: ${name}`);
      const selected = path.relative(source, path.resolve(path.dirname(from), name));
      assert.ok(selected && !selected.startsWith(`..${path.sep}`) && !path.isAbsolute(selected)); pending.push(selected);
    }
  }
  const elf = copy(native, path.join(deployment, 'bin/hepta-paper-rust'), 0o550, 256 * 1024 * 1024, true);
  fs.writeFileSync(path.join(deployment, 'package.json'), JSON.stringify({ name: 'hepta-paper-workspace' }), { flag: 'wx', mode: 0o440 });
  fs.mkdirSync(path.join(deployment, 'asset'));
  const identity = path.join(deployment, 'asset/identity.txt'), bytes = Buffer.from('actual ordinary asset domain\n');
  fs.writeFileSync(identity, bytes); const identityPin = pin(identity);
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const receipt = { version: 1, kind: 'RepositoryAssetExternalRestoreDrillReceipt', status: 'repository_asset_external_restore_verified',
    assetId: 'fixture', externalReferenceDigest: digest, restoredIdentitySha256: digest, verifiedAt: '2026-01-01T00:00:00.000Z' };
  const base = { version: 1, kind: 'RepositoryAssetExternalizationManifest', assets: [{ assetId: 'fixture', sourcePath: 'asset',
    identityFile: 'asset/identity.txt', expectedIdentitySha256: digest, currentStorage: 'repository', targetStorage: 'immutable-registry',
    requiredExternalReferenceKind: 'content-addressed-artifact', retentionPolicy: 'retain', migrationStatus: 'externalized',
    externalReference: { kind: 'content-addressed-artifact', location: 'https://example.invalid/artifact', digest, restoreDrillReceipt: receipt } }] };
  const modes = [[], ['--handoff'], ['--require-externalized'], ['--handoff', '--require-externalized'], ['--require-externalized', '--handoff']];
  let comparisons = 0;
  for (const input of inputs) {
    const manifest = structuredClone(base), asset = manifest.assets[0];
    if (input.kind === 'date') asset.externalReference.restoreDrillReceipt.verifiedAt = structuredClone(input.value);
    else asset[input.field] = input.usesIdentityHash ? [asset.expectedIdentitySha256] : structuredClone(input.value);
    const drill = asset.externalReference.restoreDrillReceipt; delete drill.repositoryAssetExternalRestoreDrillReceiptHash;
    drill.repositoryAssetExternalRestoreDrillReceiptHash = hashRecord('RepositoryAssetExternalRestoreDrillReceipt', drill);
    const file = path.join(deployment, 'paper-core/config/repository-asset-externalization.v1.json');
    let encoded = JSON.stringify(manifest);
    if (input.rawJsonValue) encoded = encoded.replace(JSON.stringify(input.value), input.rawJsonValue);
    fs.writeFileSync(file, encoded);
    const before = pin(file);
    for (const flags of modes) {
      const args = ['verify', 'repository-assets', ...(flags.length ? ['--', ...flags] : [])];
      const incumbent = observe(process.execPath, [path.join(deployment, 'paper-core/bin/hepta-paper.mjs'), ...args]);
      const actual = observe(elf.to, args); assert.deepEqual(actual, incumbent, JSON.stringify({ input, flags }));
      assert.deepEqual(pin(file), before); assert.deepEqual(pin(identity), identityPin); comparisons += 1;
    }
  }
  for (const row of graph.values()) { assert.deepEqual(pin(row.from), row.before); assert.deepEqual(pin(row.to), row.copied); }
  assert.deepEqual(pin(elf.from, 256 * 1024 * 1024, true), elf.before); assert.deepEqual(pin(elf.to), elf.copied);
  process.stdout.write(JSON.stringify({ comparisons, inputs: inputs.length, modes: modes.length, copiedDefaultRoot: true,
    sourceAndFixtureInputsUnchanged: true, completeHandoffDiagnostics: actualHandoffRefusals > 0, actualHandoffRefusals, authority: false }));
} finally { fs.rmSync(fixture, { recursive: true, force: true }); }
