import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { before, test } from 'node:test';
import { observeRouteAcceptanceV1, consumeRouteAcceptanceRecordV1,
  routeAcceptanceRequirementsV1, DEFAULT_ROUTE_ACCEPTANCE_IDS_V1 } from '../../docs/tools/node-rust-route-acceptance.mjs';

let observed;
before(async () => {
  observed = await observeRouteAcceptanceV1({ routeIds: ['retirement/reference'],
    onCase: value => console.log('reference-case '+JSON.stringify({caseId:value.caseId,passed:value.passed,inputSha256:value.inputSha256})) });
  console.log('reference-candidate-observation '+JSON.stringify(observed));
});
test('reference_candidate_executes_ordinary_none_grammar_and_preserves_actual_input_boundary_gaps', () => {
  assert.deepEqual(DEFAULT_ROUTE_ACCEPTANCE_IDS_V1, ['operator/store', 'operator/workspace', 'verify/repository-assets']);
  assert.equal(observed.rows.length, 1); const row = observed.rows[0]; assert.equal(row.routeId, 'retirement/reference');
  const requirement = routeAcceptanceRequirementsV1().find(value => value.routeId === row.routeId);
  assert.equal(requirement.argumentContract.forwardingPolicy, 'none'); assert.equal(requirement.argumentContract.forwardedArgumentSchema, null);
  assert.ok(row.cases.length > 60); assert.ok(row.cases.every(value => value.effectsUnchanged && value.effectsSatisfied));
  const boundaries = ['snapshot-without-archives', 'immutable-without-files', 'duplicate-json-key',
    'duplicate-archive-name', 'parent-archive-name', 'archive-symlink', 'receipt-symlink',
    'invalid-hash', 'archive-count-limit', 'receipt-byte-limit'];
  assert.deepEqual(row.cases.filter(value => !value.passed).map(value => value.caseId), boundaries.map(value => `${value}/mode-0`));
  assert.ok(row.cases.filter(value => value.caseId.startsWith('refuse/')).every(value => value.passed));
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    const value = row.cases.find(value => value.caseId === `unknown-result/${signal}/fresh-retry`);
    assert.ok(value.passed); assert.equal(value.node.signal, signal); assert.equal(value.native.signal, signal);
    assert.ok(value.retry.effectsUnchanged); assert.deepEqual(value.retry.node, value.retry.native);
  }
  assert.ok(Object.values(observed.authority).every(value => value === false));
});
test('reference_actual_boundary_failures_cannot_be_consumed_as_complete_route_acceptance', async () => {
  // A dirty observation is already ineligible. Also test a forged clean
  // presentation of those actual cases: failures must reject before any
  // schema, current-commit or replay claim could establish acceptance.
  const forged = structuredClone(observed); forged.kind = 'NodeRustRouteAcceptanceRecordV1'; forged.subject.committedClean = true;
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  const { recordSha256, ...payload } = forged;
  forged.recordSha256 = 'sha256:'+createHash('sha256').update(JSON.stringify(canonical(payload))).digest('hex');
  await assert.rejects(consumeRouteAcceptanceRecordV1(forged), /route_acceptance_complete_contract_missing:retirement\/reference/u);
});
