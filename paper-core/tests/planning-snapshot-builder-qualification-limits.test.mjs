import assert from 'node:assert/strict';
import test from 'node:test';
import {
  hash,
  moduleMetadata,
  requirement,
  request,
  component,
  build,
  resealComponent,
} from './planning-snapshot-fixtures.mjs';

test('module qualification metadata is exact current and fully consumed', () => {
  const expired = [moduleMetadata({ qualificationExpiresAt: '2026-09-06T00:09:59Z' })];
  assert.throws(() => build({ moduleQualificationMetadata: expired,
    request: request(expired) }), { code: 'snapshot_module_qualification_not_current' });
  const extra = [moduleMetadata(), moduleMetadata({ moduleId: 'module.policy-engine' })];
  assert.throws(() => build({ moduleQualificationMetadata: extra,
    request: request(extra) }), { code: 'snapshot_unused_module_metadata' });
  assert.throws(() => build({ request: { ...request([moduleMetadata()]),
    moduleQualificationMetadataSetHash: hash('0') } }),
  { code: 'snapshot_module_metadata_set_mismatch' });
});

test('component hash and qualification metadata hash cannot be forged', () => {
  const base = component('campaign');
  assert.throws(() => build({ components: [{ ...base, payload: { forged: true } }, component('resources')] }),
    { code: 'snapshot_component_hash_invalid' });
  const changed = resealComponent(base, { sourceQualificationMetadataHash: hash('0') });
  assert.throws(() => build({ components: [changed, component('resources')] }),
    { code: 'snapshot_component_module_metadata_mismatch' });
});

test('payload and total byte ceilings are enforced separately', () => {
  const metadata = [moduleMetadata()];
  const payloadLimited = request(metadata, { requiredComponents: [
    requirement('campaign', { maximumPayloadBytes: 4 }), requirement('resources'),
  ] });
  assert.throws(() => build({ moduleQualificationMetadata: metadata,
    request: payloadLimited }), { code: 'snapshot_component_byte_limit' });
  const totalLimited = request(metadata, { maximumComponentBytes: 4096,
    maximumTotalComponentBytes: 4096, requiredComponents: [
      requirement('campaign', { maximumPayloadBytes: 2048 }),
      requirement('resources', { maximumPayloadBytes: 2048 }),
    ] });
  const large = { data: 'x'.repeat(1500) };
  assert.throws(() => build({ moduleQualificationMetadata: metadata,
    request: totalLimited, components: [component('campaign', { payload: large }),
      component('resources', { payload: large })] }),
  { code: 'snapshot_total_byte_limit' });
});

test('one aggregate payload node budget covers the complete snapshot transaction', () => {
  const large = () => ({ a: Array.from({ length: 12000 }, () => 0),
    b: Array.from({ length: 12000 }, () => 0),
    c: Array.from({ length: 12000 }, () => 0) });
  const first = component('campaign', { payload: large() });
  const second = component('resources', { payload: large() });
  const metadata = [moduleMetadata()];
  const wideRequest = request(metadata, {
    maximumComponentBytes: 2 * 1024 * 1024,
    maximumTotalComponentBytes: 4 * 1024 * 1024,
    requiredComponents: [
      requirement('campaign', { maximumPayloadBytes: 2 * 1024 * 1024 }),
      requirement('resources', { maximumPayloadBytes: 2 * 1024 * 1024 }),
    ],
  });
  assert.throws(() => build({ moduleQualificationMetadata: metadata,
    request: wideRequest, components: [first, second] }),
  { code: 'snapshot_value_structure_limit' });
});
