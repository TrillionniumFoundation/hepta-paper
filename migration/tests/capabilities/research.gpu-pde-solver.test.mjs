import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
  composeCanonicalPdePoisson2dGpuSolver,
} from '../../../paper-composition/automation/pde-poisson-2d-gpu-composition.mjs';
import {
  buildPdePoisson2dGpuProducerSpecification,
  verifyPdePoisson2dGpuProducerSpecification,
} from '../../../paper-domain/research/pde-poisson-2d-gpu-capability-contract.mjs';
import { temporaryDirectory } from './test-support.mjs';

test('research.gpu-pde-solver composes the canonical GPU producer without self-authorizing scientific promotion', async (t) => {
  const root = await temporaryDirectory(t, 'hepta-capability-gpu-pde-');
  assert.throws(
    () => composeCanonicalPdePoisson2dGpuSolver(),
    /pde_poisson_2d_gpu_composition_output_root_absolute_required/,
  );

  const composition = composeCanonicalPdePoisson2dGpuSolver({
    outputRoot: path.join(root, 'pde-output'),
  });
  assert.equal(composition.kind, 'CanonicalPdePoisson2dGpuComposition');
  const capabilities = composition.gpuExecutor.capabilities();
  assert.equal(capabilities.runtimeProfile, 'pythonGpu');
  assert.equal(capabilities.singleGpuUuidRequired, true);
  assert.equal(capabilities.independentCpuOracleRequired, true);
  assert.equal(capabilities.selfAuthorizesScientificPromotion, false);

  const specification = buildPdePoisson2dGpuProducerSpecification();
  assert.equal(verifyPdePoisson2dGpuProducerSpecification(specification), true);
  assert.equal(specification.runtime.cpuFallback, 'forbidden');

  const blocked = await composition.executeAndVerify({});
  assert.equal(blocked.status,
    'canonical_pde_poisson_2d_gpu_scientific_execution_blocked');
  assert.equal(blocked.productionPromotionEligible, false);
});
