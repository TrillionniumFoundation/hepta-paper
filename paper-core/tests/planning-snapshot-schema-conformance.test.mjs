import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  SNAPSHOT_BUILDER_INPUT_BOUNDARY,
  verifyPlanningStateSnapshotCurrentV1,
  moduleMetadata,
  requirement,
  request,
  component,
  build,
  currentContext,
} from './planning-snapshot-fixtures.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const schemas = Object.freeze({
  request: 'docs/modules/schemas/planning-state-snapshot-request-v1.schema.json',
  component: 'docs/modules/schemas/planning-snapshot-component-v1.schema.json',
  snapshot: 'docs/modules/schemas/planning-state-snapshot-v1.schema.json',
  receipt: 'docs/modules/schemas/planning-state-snapshot-currentness-receipt-v1.schema.json',
});

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function validateSchema(t, schema, value, expectedStatus = 0) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-schema-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const instance = path.join(directory, 'instance.json');
  fs.writeFileSync(instance, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  const result = spawnSync('python3', [
    'docs/rust/tools/strict_json_schema.py',
    '--schema', schemas[schema],
    '--instance', instance,
  ], { cwd: root, encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024 });
  assert.equal(result.status, expectedStatus,
    `${schema}: stdout=${result.stdout}\nstderr=${result.stderr}`);
}

function records() {
  const metadata = [moduleMetadata()];
  const snapshot = build({ moduleQualificationMetadata: metadata,
    request: request(metadata) });
  const receipt = verifyPlanningStateSnapshotCurrentV1({
    inputBoundary: SNAPSHOT_BUILDER_INPUT_BOUNDARY,
    snapshot,
    observedAt: '2026-09-06T00:20:00Z',
    currentContext: currentContext(snapshot),
  });
  return { request: snapshot.request, component: snapshot.components[0], snapshot, receipt };
}

test('every runtime-produced public snapshot record validates its closed wire schema', { concurrency: false }, (t) => {
  const values = records();
  for (const name of Object.keys(schemas)) validateSchema(t, name, values[name]);
});

test('schema-valid JSON round trips through runtime reconstruction with stable identities', { concurrency: false }, (t) => {
  const values = records();
  const wire = plain(values.snapshot);
  const rebuilt = build({
    request: wire.request,
    moduleQualificationMetadata: wire.moduleQualificationMetadata,
    components: wire.components,
    observedAt: wire.observedAt,
  });
  assert.equal(rebuilt.stateSnapshotHash, values.snapshot.stateSnapshotHash);
  assert.deepEqual(plain(rebuilt), wire);
  const receipt = verifyPlanningStateSnapshotCurrentV1({
    inputBoundary: SNAPSHOT_BUILDER_INPUT_BOUNDARY,
    snapshot: wire,
    observedAt: values.receipt.observedAt,
    currentContext: plain(currentContext(rebuilt)),
  });
  assert.deepEqual(plain(receipt), plain(values.receipt));
  validateSchema(t, 'snapshot', rebuilt);
  validateSchema(t, 'receipt', receipt);
});

test('request schema and runtime both reject closed-shape and scalar violations', { concurrency: false }, (t) => {
  const base = plain(records().request);
  for (const changed of [
    { ...base, unexpected: false },
    { ...base, kind: 'OtherRequest' },
    { ...base, consistencyEpoch: 0 },
    { ...base, requiredComponents: [] },
    { ...base, readTransactionHash: 'not-a-hash' },
  ]) {
    validateSchema(t, 'request', changed, 1);
    assert.throws(() => build({ request: changed }));
  }
});

test('component schema and runtime both reject identity, range and closed-shape violations', { concurrency: false }, (t) => {
  const values = records();
  const base = plain(values.component);
  const resource = plain(values.snapshot.components[1]);
  for (const changed of [
    { ...base, unexpected: false },
    { ...base, kind: 'OtherComponent' },
    { ...base, revision: -1 },
    { ...base, sourceGeneration: 0 },
    { ...base, componentHash: 'not-a-hash' },
  ]) {
    validateSchema(t, 'component', changed, 1);
    assert.throws(() => build({ components: [changed, resource] }));
  }
});

test('snapshot and receipt schemas close all authority and extension fields', { concurrency: false }, (t) => {
  const values = records();
  const authorityEscalation = plain(values.snapshot);
  authorityEscalation.authority.productionAuthorized = true;
  validateSchema(t, 'snapshot', authorityEscalation, 1);
  assert.throws(() => verifyPlanningStateSnapshotCurrentV1({
    inputBoundary: SNAPSHOT_BUILDER_INPUT_BOUNDARY,
    snapshot: authorityEscalation,
    observedAt: values.receipt.observedAt,
    currentContext: currentContext(values.snapshot),
  }));

  validateSchema(t, 'snapshot', { ...plain(values.snapshot), unexpected: false }, 1);
  validateSchema(t, 'snapshot', { ...plain(values.snapshot), componentCount: '2' }, 1);
  validateSchema(t, 'receipt', { ...plain(values.receipt), unexpected: false }, 1);
  const receiptEscalation = plain(values.receipt);
  receiptEscalation.authority.writerAuthorityGranted = true;
  validateSchema(t, 'receipt', receiptEscalation, 1);
});

test('wire schema acceptance never replaces runtime hash and semantic verification', { concurrency: false }, (t) => {
  const values = records();
  const forged = plain(values.component);
  forged.payload = { changed: true };
  // The wire schema intentionally validates shape, not the cryptographic relation.
  validateSchema(t, 'component', forged);
  assert.throws(() => build({ components: [forged, plain(values.snapshot.components[1])] }),
    { code: 'snapshot_component_hash_invalid' });
});

test('schema patterns and runtime both reject terminal control suffixes', { concurrency: false }, (t) => {
  const base = plain(records().request);
  const cases = Object.freeze([
    Object.freeze({
      name: 'identifier-lf',
      value: { ...base, snapshotRequestId: `${base.snapshotRequestId}\n` },
    }),
    Object.freeze({
      name: 'digest-lf',
      value: { ...base, readTransactionHash: `${base.readTransactionHash}\n` },
    }),
    Object.freeze({
      name: 'token-lf',
      value: { ...base, objectiveVersion: `${base.objectiveVersion}\n` },
    }),
    Object.freeze({
      name: 'module-id-lf',
      value: {
        ...base,
        requiredComponents: base.requiredComponents.map((entry, index) => (
          index === 0 ? { ...entry, sourceModuleId: `${entry.sourceModuleId}\n` } : entry
        )),
      },
    }),
    Object.freeze({
      name: 'capability-id-lf',
      value: {
        ...base,
        requiredComponents: base.requiredComponents.map((entry, index) => (
          index === 0
            ? { ...entry, requiredCapabilityId: `${entry.requiredCapabilityId}\n` }
            : entry
        )),
      },
    }),
    Object.freeze({
      name: 'remaining-terminal-controls',
      value: {
        ...base,
        snapshotRequestId: `${base.snapshotRequestId}\r`,
        readTransactionHash: `${base.readTransactionHash}\r\n`,
        objectiveVersion: `${base.objectiveVersion}\u2028`,
        requiredComponents: base.requiredComponents.map((entry, index) => (
          index === 0
            ? { ...entry, sourceModuleId: `${entry.sourceModuleId}\u2029` }
            : { ...entry, requiredCapabilityId: `${entry.requiredCapabilityId}\r` }
        )),
      },
    }),
  ]);

  for (const item of cases) {
    validateSchema(t, 'request', item.value, 1);
    assert.throws(
      () => build({ request: item.value }),
      { name: 'Error' },
      item.name,
    );
  }
});

test('schema pattern ceilings accept exact maxima and reject one-unit overruns', { concurrency: false }, (t) => {
  const identifier = 'i'.repeat(192);
  const componentKind = 'k'.repeat(192);
  const moduleId = `module.${'m'.repeat(96)}`;
  const moduleVersion = 'v'.repeat(128);
  const capabilityId = `CAP-${'C'.repeat(96)}`;
  const objectiveVersion = 'o'.repeat(128);
  const metadata = [moduleMetadata({
    moduleId,
    moduleVersion,
    capabilityIds: [capabilityId],
  })];
  const exactRequest = request(metadata, {
    snapshotRequestId: identifier,
    objectiveVersion,
    requiredComponents: [
      requirement(identifier, {
        componentKind,
        sourceModuleId: moduleId,
        sourceModuleVersion: moduleVersion,
        requiredCapabilityId: capabilityId,
      }),
      requirement('secondary', {
        sourceModuleId: moduleId,
        sourceModuleVersion: moduleVersion,
        requiredCapabilityId: capabilityId,
      }),
    ],
  });
  const exactComponents = [
    component(identifier, {
      componentKind,
      sourceModuleId: moduleId,
      sourceModuleVersion: moduleVersion,
      requiredCapabilityId: capabilityId,
      sourceQualificationMetadataHash: metadata[0].qualificationMetadataHash,
    }),
    component('secondary', {
      sourceModuleId: moduleId,
      sourceModuleVersion: moduleVersion,
      requiredCapabilityId: capabilityId,
      sourceQualificationMetadataHash: metadata[0].qualificationMetadataHash,
    }),
  ];
  const exactSnapshot = build({
    request: exactRequest,
    moduleQualificationMetadata: metadata,
    components: exactComponents,
  });
  validateSchema(t, 'request', exactRequest);
  assert.equal(exactSnapshot.request.snapshotRequestId, identifier);
  assert.equal(exactSnapshot.request.objectiveVersion, objectiveVersion);

  const base = plain(records().request);
  const invalid = Object.freeze([
    {
      ...base,
      snapshotRequestId: 'i'.repeat(193),
      objectiveVersion: 'o'.repeat(129),
      readTransactionHash: `sha256:${'a'.repeat(65)}`,
    },
    {
      ...base,
      requiredComponents: base.requiredComponents.map((entry, index) => (
        index === 0
          ? {
            ...entry,
            sourceModuleId: `module.${'m'.repeat(97)}`,
            sourceModuleVersion: 'v'.repeat(129),
            requiredCapabilityId: `CAP-${'C'.repeat(97)}`,
          }
          : entry
      )),
    },
  ]);
  for (const changed of invalid) {
    validateSchema(t, 'request', changed, 1);
    assert.throws(() => build({ request: changed }));
  }
});
