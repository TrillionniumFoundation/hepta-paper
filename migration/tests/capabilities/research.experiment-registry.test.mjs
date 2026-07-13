import assert from 'node:assert/strict';
import test from 'node:test';
import { buildExperimentRegistry } from '../../../paper-domain/research/experiment-registry.mjs';
import { trustedExperimentFixture } from '../../../paper-core/tests/trusted-evidence-test-support.mjs';

test('research.experiment-registry requires dataset metric seed code and result bindings', () => {
  const trusted = trustedExperimentFixture({ experimentId: 'x' });
  const ready = buildExperimentRegistry({ artifacts: [trusted.artifact], receiptLedger: trusted.ledger, artifactVerifier: trusted.artifactVerifier });
  assert.equal(ready.status, 'experiment_registry_ready');
  assert.equal(buildExperimentRegistry({ artifacts: [{ kind: 'experiment', hash: 'r' }] }).status, 'experiment_registry_blocked');
});
