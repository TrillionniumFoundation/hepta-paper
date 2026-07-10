import assert from 'node:assert/strict';
import test from 'node:test';
import { buildExperimentRegistry } from '../../../paper-domain/research/experiment-registry.mjs';

test('research.experiment-registry requires dataset metric seed code and result bindings', () => {
  const ready = buildExperimentRegistry({ artifacts: [{ kind: 'experiment', experimentId: 'x', datasetHash: 'd', metric: 'accuracy', seed: 7, codeHash: 'c', resultHash: 'r', resultPath: 'r.json' }] });
  assert.equal(ready.status, 'experiment_registry_ready');
  assert.equal(buildExperimentRegistry({ artifacts: [{ kind: 'experiment', hash: 'r' }] }).status, 'experiment_registry_blocked');
});
