import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateDependencyFreshness } from '../../paper-domain/evidence/dependency-freshness-policy.mjs';

test('dependency freshness is DAG and hash bound rather than wall-clock ordered', () => {
  const fresh = evaluateDependencyFreshness({ nodes: [
    { id: 'source', outputHash: 'sha256:s', dependsOn: [] },
    { id: 'proof', outputHash: 'sha256:p', dependsOn: ['source'], dependencyOutputHashes: { source: 'sha256:s' } },
    { id: 'package', outputHash: 'sha256:k', dependsOn: ['proof'], dependencyOutputHashes: { proof: 'sha256:p' } },
  ] });
  assert.equal(fresh.status, 'evidence_dependency_chain_fresh');
  const stale = evaluateDependencyFreshness({ nodes: [
    { id: 'source', outputHash: 'sha256:new', dependsOn: [] },
    { id: 'proof', outputHash: 'sha256:p', dependsOn: ['source'], dependencyOutputHashes: { source: 'sha256:old' } },
  ] });
  assert.ok(stale.blockers.includes('evidence_dependency_hash_stale:proof:source'));
});
