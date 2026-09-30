import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { auditCurrentCoverage } from '../../docs/tools/audit-node-rust-coverage.mjs';
import { renderNodeRustGapReport } from '../../docs/tools/generate-node-rust-gap-report.mjs';
import { assertVerifiedRouteAcceptanceV1, consumeRouteAcceptanceRecordV1, observeRouteAcceptanceV1,
  readRouteAcceptanceRecord, routeAcceptanceRequirementsV1 } from '../../docs/tools/node-rust-route-acceptance.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const schema = fs.readFileSync(path.join(root, 'docs/migration/node-rust-route-acceptance.v1.schema.json'), 'utf8');
function validate(value) {
  const result = spawnSync('python3', ['docs/rust/tools/strict_json_schema.py', '--batch-stdin'], {
    cwd: root, input: JSON.stringify([{ name: 'route-acceptance', schema, instance: JSON.stringify(value) }]),
    encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024,
  });
  assert.ok([0, 1].includes(result.status), result.stderr || result.error?.message);
  validate.errors = result.stdout || result.stderr;
  return result.status === 0;
}
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort()
    .map(key => [key, canonical(value[key])])) : value;
function rehash(record) {
  const { recordSha256: _oldHash, ...payload } = record;
  record.recordSha256 = `sha256:${createHash('sha256').update(JSON.stringify(canonical(payload))).digest('hex')}`;
  return record;
}
let observed;
before(async () => { observed = await observeRouteAcceptanceV1(); });

test('every canonical route retains its complete argument/effect contract and executable acceptance gap', () => {
  const requirements = routeAcceptanceRequirementsV1();
  assert.equal(requirements.length, 57);
  assert.equal(new Set(requirements.map(row => row.routeId)).size, 57);
  for (const row of requirements) {
    assert.match(row.argumentContractSha256, /^sha256:[0-9a-f]{64}$/u);
    assert.ok(row.argumentContract.nodeArgv.length > 0);
    assert.ok(row.remaining.includes('independent-current-subject-replay'));
  }
});

test('ordinary Node and Rust canonical routes execute the complete readonly refusal and process recovery matrix', () => {
  assert.equal(observed.rows.length, 2);
  assert.deepEqual(observed.rows.map(row => row.routeId), ['operator/workspace', 'verify/repository-assets']);
  for (const row of observed.rows) {
    assert.ok(row.cases.length > 40);
    assert.deepEqual(row.cases.filter(testCase => !testCase.passed), [], row.routeId);
    assert.ok(row.cases.every(testCase => testCase.effectsUnchanged));
    for (const signal of ['SIGTERM', 'SIGKILL']) {
      const recovery = row.cases.find(testCase => testCase.caseId === `unknown-result/${signal}/fresh-retry`);
      assert.equal(recovery.node.signal, signal);
      assert.equal(recovery.native.signal, signal);
      assert.equal(recovery.retry.node.outcome, 'report');
      assert.deepEqual(recovery.retry.node, recovery.retry.native);
      assert.equal(recovery.retry.effectsUnchanged, true);
    }
  }
});

test('schema-valid JSON status claims never become verified acceptance without current-subject CLI replay', async () => {
  const fake = structuredClone(observed);
  fake.kind = 'NodeRustRouteAcceptanceRecordV1';
  fake.subject.committedClean = true;
  fake.subject.commit = '0'.repeat(40);
  rehash(fake);
  assert.equal(validate(fake), true, JSON.stringify(validate.errors));
  assert.throws(() => assertVerifiedRouteAcceptanceV1(fake), /not_independently_replayed/u);
  await assert.rejects(() => consumeRouteAcceptanceRecordV1(fake), /subject_not_current_clean_commit/u);
  const report = auditCurrentCoverage();
  report.acceptedParityRows = 2;
  assert.throws(() => renderNodeRustGapReport(report), /cannot establish independent acceptance/u);
});

test('current commit complete matrix consumer closes exactly two local behavior gaps and retains all routes', async () => {
  if (!observed.subject.committedClean) {
    assert.equal(observed.kind, 'NodeRustRouteBehaviorObservationV1');
    await assert.rejects(() => consumeRouteAcceptanceRecordV1(observed), /record_scope_invalid/u);
    assert.equal(auditCurrentCoverage().acceptedParityRows, 0);
    return;
  }
  assert.equal(validate(observed), true, JSON.stringify(validate.errors));
  const acceptance = await consumeRouteAcceptanceRecordV1(observed);
  const report = auditCurrentCoverage({ routeAcceptance: acceptance });
  assert.equal(report.acceptedParityRows, 2);
  assert.equal(report.openCommandBehaviorGaps, 55);
  assert.equal(report.commandMappings.commands.length, 57);
  assert.equal(report.commandMappings.acceptedParity, false);
  assert.equal(report.fullReplacementEstablished, false);
  assert.equal(report.productionActivationVerified, false);
  assert.equal(report.nodeRetirementVerified, false);
  assert.ok(Object.values(acceptance.authority).every(value => value === false));
  assert.equal(acceptance.rows.filter(row => row.accepted).length, 2);
  assert.equal(acceptance.rows.filter(row => !row.accepted && row.remaining.length > 0).length, 55);
  const rendered = renderNodeRustGapReport(report);
  assert.match(rendered, /Independently accepted parity rows: \*\*2\*\*/u);
  assert.match(rendered, /Open command gaps: \*\*55\*\*/u);
  assert.equal(rendered.split('\n').filter(line => line.startsWith('| `')).length, 57);
  assert.equal(rendered.split('\n').filter(line => line.includes('| `accepted_local_behavior` |')).length, 2);
  assert.throws(() => renderNodeRustGapReport(structuredClone(report)), /not_independently_replayed/u);
});

test('removed parameter refusal or recovery case and authority expansion fail before any replay', async () => {
  const missing = rehash(structuredClone(observed));
  missing.kind = 'NodeRustRouteAcceptanceRecordV1'; missing.subject.committedClean = true;
  missing.rows[0].cases.pop(); rehash(missing);
  await assert.rejects(() => consumeRouteAcceptanceRecordV1(missing),
    /complete_contract_missing|subject_not_current_clean_commit/u);
  const expanded = structuredClone(observed);
  expanded.kind = 'NodeRustRouteAcceptanceRecordV1'; expanded.subject.committedClean = true;
  expanded.authority.submissionAuthority = true; rehash(expanded);
  assert.equal(validate(expanded), false);
  await assert.rejects(() => consumeRouteAcceptanceRecordV1(expanded), /record_scope_invalid/u);
});

test('forged success outputs with valid shape and self hash are rejected by actual CLI replay', async () => {
  const forged = structuredClone(observed);
  forged.kind = 'NodeRustRouteAcceptanceRecordV1'; forged.subject.committedClean = true;
  const first = forged.rows[0].cases[0];
  first.node.stdout.status = 'invented_success'; first.native.stdout.status = 'invented_success';
  rehash(forged);
  assert.equal(validate(forged), true, JSON.stringify(validate.errors));
  await assert.rejects(() => consumeRouteAcceptanceRecordV1(forged),
    /actual_replay_differs|subject_not_current_clean_commit/u);
});

test('bounded record reader rejects alias and mutation-prone inputs instead of executing them', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-route-record-reader-'));
  try {
    const file = path.join(directory, 'record.json'); fs.writeFileSync(file, JSON.stringify(observed));
    assert.deepEqual(readRouteAcceptanceRecord(file), observed);
    const alias = path.join(directory, 'alias.json'); fs.symlinkSync('record.json', alias);
    assert.throws(() => readRouteAcceptanceRecord(alias), /symlink_refused/u);
    const hardlink = path.join(directory, 'hardlink.json'); fs.linkSync(file, hardlink);
    assert.throws(() => readRouteAcceptanceRecord(file), /file_invalid/u);
    const invalidUtf8 = path.join(directory, 'invalid-utf8.json');
    fs.writeFileSync(invalidUtf8, Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]));
    assert.throws(() => readRouteAcceptanceRecord(invalidUtf8), /encoded data was not valid/u);
    assert.throws(() => readRouteAcceptanceRecord('relative.json'), /path_must_be_absolute/u);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
