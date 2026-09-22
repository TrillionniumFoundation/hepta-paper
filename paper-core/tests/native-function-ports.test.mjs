import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { validateNativeFunctionPorts } from '../../docs/tools/validate-native-function-ports.mjs';

const base = () => JSON.parse(fs.readFileSync(
  new URL('../../docs/migration/native-function-ports.v1.json', import.meta.url),
));

test('all current native function groups bind code oracle tests and examples', () => {
  const report = validateNativeFunctionPorts();
  assert.equal(report.sourceGroups, 4);
  assert.equal(report.incumbentFunctions, 23);
  assert.equal(report.incumbentConstants, 3);
  assert.equal(report.incumbentExports, 26);
  assert.equal(report.testsExecutedByThisValidator, false);
  assert.equal(report.fullCommandParityAccepted, false);
});

test('a source digest-shaped claim is not enough', () => {
  const index = base();
  index.groups[0].nodeSourceSha256 = `sha256:${'0'.repeat(64)}`;
  assert.throws(() => validateNativeFunctionPorts({ index }), /source changed/);
});

test('missing Node exports cannot silently shrink the denominator', () => {
  const index = base();
  index.groups[0].nodeFunctions.pop();
  assert.throws(() => validateNativeFunctionPorts({ index }), /denominator/);
});

test('a nonexistent Rust function cannot be counted', () => {
  const index = base();
  index.groups[0].rustSymbols = ['fully_replaced_node'];
  assert.throws(() => validateNativeFunctionPorts({ index }), /symbol absent/);
});

test('duplicate groups are rejected', () => {
  const index = base();
  index.groups.push(index.groups[0]);
  assert.throws(() => validateNativeFunctionPorts({ index }), /identity/);
});

test('unknown fields cannot smuggle authority', () => {
  const index = base();
  index.approved = true;
  assert.throws(() => validateNativeFunctionPorts({ index }), /shape/);
});

test('production and retirement remain separate', () => {
  for (const key of ['productionActivation', 'nodeRetirement']) {
    const index = base();
    index[key] = true;
    assert.throws(() => validateNativeFunctionPorts({ index }), /scope/);
  }
});

test('unrelated examples cannot replace executable examples', () => {
  const index = base();
  index.groups[0].examplePath = index.groups[2].examplePath;
  assert.throws(() => validateNativeFunctionPorts({ index }), /documentation example/);
});

test('path traversal rejected', () => {
  const index = base();
  index.groups[0].nodePath = '../outside';
  assert.throws(() => validateNativeFunctionPorts({ index }), /noncanonical/);
});

test('empty inventory cannot pass', () => {
  const index = base();
  index.groups = [];
  assert.throws(() => validateNativeFunctionPorts({ index }), /scope/);
});

// Updating a source digest must not make an added non-function export disappear
// from the denominator. Use private fixture files, never mutate repository source.
test('a newly added constant cannot silently escape the export inventory', () => {
  const index = base();
  index.groups = [index.groups[0]];
  const row = index.groups[0];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-native-bindings-'));
  try {
    for (const key of ['nodePath', 'rustPath', 'testPath', 'oraclePath', 'examplePath']) {
      const destination = path.join(root, row[key]);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(new URL(`../../${row[key]}`, import.meta.url), destination);
    }
    const incumbent = path.join(root, row.nodePath);
    fs.appendFileSync(incumbent, '\nexport const additionalPublicSurface = 1;\n');
    row.nodeSourceSha256 = `sha256:${createHash('sha256').update(fs.readFileSync(incumbent)).digest('hex')}`;
    assert.throws(() => validateNativeFunctionPorts({ index, root }), /denominator/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
