import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createPlanningSnapshotComponent }
  from '../../paper-application/orchestration/snapshot-builder.mjs';
import { collectPlanningStateSnapshot }
  from '../../paper-application/orchestration/planning-snapshot-session.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const H = (character) => `sha256:${character.repeat(64)}`;
const nowEpochMs = Date.parse('2026-09-06T00:00:00Z');
const request = {
  schemaVersion: 1,
  kind: 'PlanningStateSnapshotRequestV1',
  snapshotRequestId: 'session-schema-snapshot',
  readTransactionHash: H('a'),
  consistencyEpoch: 1,
  deadline: '2026-09-07T00:00:00Z',
  requiredComponents: [{
    componentId: 'campaign',
    componentKind: 'campaign-state',
    minimumRevision: 1,
    maximumAgeMs: 3600000,
    maximumPayloadBytes: 65536,
  }],
};
const binding = {
  moduleId: 'module.readonly-control',
  moduleVersion: '1.0.0',
  projectionKinds: ['campaign-state'],
  qualificationSubjectHash: H('b'),
  validUntil: '2026-09-08T00:00:00Z',
};
let capturedResponse;
const collected = await collectPlanningStateSnapshot({
  request,
  moduleBindings: [binding],
  port: {
    kind: 'PlanningSnapshotReadPortV1',
    open(input) {
      return {
        kind: 'PlanningSnapshotReadSessionV1',
        readTransactionHash: input.snapshotRequest.readTransactionHash,
        consistencyEpoch: input.snapshotRequest.consistencyEpoch,
        readComponent(readInput) {
          capturedResponse = {
            schemaVersion: 1,
            kind: 'PlanningSnapshotComponentResponseV1',
            status: 'complete',
            component: createPlanningSnapshotComponent({
              schemaVersion: 1,
              kind: 'PlanningSnapshotComponentV1',
              componentId: readInput.requirement.componentId,
              componentKind: readInput.requirement.componentKind,
              sourceModuleId: readInput.moduleBinding.moduleId,
              sourceModuleVersion: readInput.moduleBinding.moduleVersion,
              sourceQualificationHash: readInput.moduleBinding.qualificationSubjectHash,
              readTransactionHash: readInput.snapshotRequest.readTransactionHash,
              consistencyEpoch: readInput.snapshotRequest.consistencyEpoch,
              revision: 1,
              generation: 1,
              capturedAt: '2026-09-05T23:59:00Z',
              expiresAt: '2026-09-07T00:00:00Z',
              payload: { revision: 1 },
            }),
            authority: {
              productionAuthorized: false,
              writerAuthorityGranted: false,
              providerAuthorized: false,
              externalAuthorityClaimed: false,
            },
          };
          return capturedResponse;
        },
        close() {},
      };
    },
  },
  nowEpochMs,
});

function validate(schema, value) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-session-schema-'));
  try {
    const instance = path.join(directory, 'instance.json');
    fs.writeFileSync(instance, `${JSON.stringify(value, null, 2)}\n`);
    return spawnSync('python3', [
      'docs/rust/tools/strict_json_schema.py',
      '--schema', schema,
      '--instance', instance,
    ], {
      cwd: root,
      encoding: 'utf8',
      timeout: 20000,
      maxBuffer: 1024 * 1024,
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('actual component response and closed collection receipt validate', () => {
  for (const [schema, value] of [
    ['docs/modules/schemas/planning-snapshot-component-response-v1.schema.json', capturedResponse],
    ['docs/modules/schemas/collected-planning-state-snapshot-v1.schema.json', collected],
  ]) {
    const checked = validate(schema, value);
    assert.equal(checked.status, 0, `${schema}\n${checked.stdout}\n${checked.stderr}`);
  }
});

test('response schema rejects partial status, unknown fields and authority escalation', () => {
  for (const invalid of [
    { ...capturedResponse, status: 'partial' },
    { ...capturedResponse, authority: { ...capturedResponse.authority, writerAuthorityGranted: true } },
    { ...capturedResponse, credential: 'forbidden' },
    { ...capturedResponse, component: { ...capturedResponse.component, unknown: false } },
  ]) {
    const checked = validate('docs/modules/schemas/planning-snapshot-component-response-v1.schema.json', invalid);
    assert.notEqual(checked.status, 0, `${checked.stdout}\n${checked.stderr}`);
  }
});

test('collection schema rejects close, count, hash-shape and authority violations', () => {
  for (const invalid of [
    { ...collected, sessionClosed: false },
    { ...collected, componentCount: 0 },
    { ...collected, componentPayloadHashes: [] },
    { ...collected, stateSnapshotHash: 'not-a-hash' },
    { ...collected, authority: { ...collected.authority, productionAuthorized: true } },
    { ...collected, credential: 'forbidden' },
  ]) {
    const checked = validate('docs/modules/schemas/collected-planning-state-snapshot-v1.schema.json', invalid);
    assert.notEqual(checked.status, 0, `${checked.stdout}\n${checked.stderr}`);
  }
});
