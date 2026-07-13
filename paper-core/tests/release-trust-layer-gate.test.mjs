import assert from 'node:assert/strict';
import test from 'node:test';
import { buildReleaseTrustLayerGate } from '../../paper-domain/governance/release-trust-layer-gate.mjs';

test('code release requires implementation and release-bound conformance as separate layers', () => {
  const blocked = buildReleaseTrustLayerGate({ releaseCommit: 'commit-a', capabilityCount: 14, implementationVerified: 14, releaseBoundConformanceVerified: 0, independentProductionOperationalVerified: 14 });
  assert.equal(blocked.status, 'code_release_trust_layers_blocked');
  assert.equal(blocked.operationalProofCannotSubstituteForReleaseBoundConformance, true);
  const ready = buildReleaseTrustLayerGate({ releaseCommit: 'commit-a', capabilityCount: 14, implementationVerified: 14, releaseBoundConformanceVerified: 14, independentProductionOperationalVerified: 0 });
  assert.equal(ready.status, 'code_release_trust_layers_ready');
  assert.equal(ready.releaseBoundConformance.productionEligible, false);
  assert.equal(ready.independentProductionOperational.releaseBlocking, false);
  assert.match(ready.releaseTrustLayerGateHash, /^sha256:/);
});

test('release trust counts fail closed outside the capability catalog bounds', () => {
  assert.throws(() => buildReleaseTrustLayerGate({ releaseCommit: 'commit-a', capabilityCount: 14, implementationVerified: 15, releaseBoundConformanceVerified: 14, independentProductionOperationalVerified: 0 }), /implementation_count_invalid/);
  assert.throws(() => buildReleaseTrustLayerGate({ releaseCommit: '', capabilityCount: 14, implementationVerified: 14, releaseBoundConformanceVerified: 14, independentProductionOperationalVerified: 0 }), /release_commit_required/);
});
