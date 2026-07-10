import assert from 'node:assert/strict';
import test from 'node:test';
import { buildClaimRegistry, transitionClaim } from '../../../paper-domain/research/claim-registry.mjs';

test('research.claim-registry validates graph structure and transitions', () => {
  const valid = buildClaimRegistry({ paperTask: { paperId: 'p' }, claims: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B', dependencyIds: ['a'] }] });
  assert.equal(valid.status, 'claim_graph_valid');
  assert.equal(transitionClaim(valid, { claimId: 'a', toStatus: 'supported', expectedVersion: 1 }).claims[0].status, 'supported');
  assert.equal(buildClaimRegistry({ claims: [{ id: 'a', dependencyIds: ['b'] }, { id: 'b', dependencyIds: ['a'] }] }).status, 'claim_graph_blocked');
});
