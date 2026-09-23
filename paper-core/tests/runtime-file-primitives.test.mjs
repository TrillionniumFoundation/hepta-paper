import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { fsyncDirectorySync, writeDurableJsonSync } from '../../paper-adapters/runtime/durable-json-repository.mjs';
import { writeImmutableFileSync } from '../../paper-adapters/runtime/immutable-file-repository.mjs';
import { parseJsonOrThrow } from '../../workflow-kernel/runtime/data-utils.mjs';
import { readDescriptorFullySync, writeDescriptorFullySync } from '../../workflow-kernel/runtime/file-descriptor-utils.mjs';
import { sha256FileSync } from '../../workflow-kernel/runtime/file-utils.mjs';

test('shared synchronous file hash preserves prefixed and raw SHA-256 forms', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-file-primitives-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const candidate = path.join(root, 'payload.txt');
  fs.writeFileSync(candidate, 'abc');
  const digest = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
  assert.equal(sha256FileSync(candidate), `sha256:${digest}`);
  assert.equal(sha256FileSync(candidate, { prefix: false }), digest);
});

test('shared immutable writer is idempotent only for byte-identical content', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-immutable-file-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const candidate = path.join(root, 'nested', 'payload.txt');
  assert.equal(writeImmutableFileSync(candidate, Buffer.from('first')), candidate);
  assert.equal(writeImmutableFileSync(candidate, Buffer.from('first')), candidate);
  assert.equal(fs.statSync(candidate).mode & 0o777, 0o444);
  assert.throws(
    () => writeImmutableFileSync(candidate, Buffer.from('second'), { collisionError: 'fixture_immutable_collision' }),
    /fixture_immutable_collision/,
  );
});

test('shared durable JSON writer persists a private complete record and syncs its directory', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-durable-json-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const candidate = path.join(root, 'nested', 'record.json');
  writeDurableJsonSync(candidate, { version: 1, status: 'ready' });
  assert.deepEqual(JSON.parse(fs.readFileSync(candidate, 'utf8')), { version: 1, status: 'ready' });
  assert.equal(fs.statSync(candidate).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.dirname(candidate)), ['record.json']);
  assert.doesNotThrow(() => fsyncDirectorySync(path.dirname(candidate)));
});

test('shared descriptor primitives complete bounded writes and reads', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-descriptor-primitives-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const candidate = path.join(root, 'payload.bin');
  const output = fs.openSync(candidate, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
  try { assert.equal(writeDescriptorFullySync(output, Buffer.from('descriptor-payload')), 18); }
  finally { fs.closeSync(output); }
  const input = fs.openSync(candidate, fs.constants.O_RDONLY);
  try {
    const read = readDescriptorFullySync(input, 18);
    assert.equal(read.bytesRead, 18);
    assert.equal(read.buffer.toString('utf8'), 'descriptor-payload');
  } finally { fs.closeSync(input); }
});

test('shared fail-closed JSON decoder preserves caller-owned blocker codes', () => {
  assert.deepEqual(parseJsonOrThrow('{"ready":true}', 'fixture_json_invalid'), { ready: true });
  assert.throws(
    () => parseJsonOrThrow('{', 'fixture_json_invalid'),
    (error) => error.code === 'fixture_json_invalid' && error.message === 'fixture_json_invalid',
  );
});
