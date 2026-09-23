import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildAutonomousResearchGpuScientificExecutionPlan,
} from '../../paper-composition/automation/autonomous-research-gpu-scientific-plan.mjs';
import {
  gpuScientificCampaignNodeId,
  verifyGpuScientificCampaignExecutionPlan,
} from '../../paper-domain/automation/gpu-scientific-campaign-execution-contract.mjs';

const GPU_UUID = 'GPU-a33875b7-7eb7-679e-df08-19227d3decee';

function preparation(launchMode = 'production-run') {
  return Object.freeze({
    launchMode,
    createdAt: '2026-08-14T00:00:00.000Z',
    proposal: Object.freeze({ paperId: 'autonomous-gpu-paper' }),
  });
}

function readiness(overrides = {}) {
  return Object.freeze({
    gpuScientificRuntimeReady: true,
    runtimes: Object.freeze({
      gpuContainer: Object.freeze({
        usable: true,
        deviceSelector: GPU_UUID,
        ...(overrides.gpuContainer || {}),
      }),
    }),
    ...overrides,
  });
}

test('production autonomous research derives a campaign-bound GPU scientific plan from observed UUID authority', () => {
  const value = buildAutonomousResearchGpuScientificExecutionPlan({
    campaignId: 'autonomous-research:autonomous-gpu-paper',
    loopPreparation: preparation(),
    budgets: { maxWallTimeMs: 6 * 60 * 60 * 1_000 },
    productionReadiness: readiness(),
  });
  assert.equal(verifyGpuScientificCampaignExecutionPlan(value, {
    campaignId: 'autonomous-research:autonomous-gpu-paper',
    paperId: 'autonomous-gpu-paper',
    nodeId: gpuScientificCampaignNodeId(
      'autonomous-research:autonomous-gpu-paper',
    ),
  }), true);
  assert.equal(value.gpuDeviceSelector, GPU_UUID);
  assert.equal(value.absoluteExecutionDeadlineEpochMs,
    Date.parse('2026-08-14T00:00:00.000Z') + 6 * 60 * 60 * 1_000);
});

test('bounded bootstrap remains explicit while production missing UUID/deadline authority fails closed', () => {
  assert.equal(buildAutonomousResearchGpuScientificExecutionPlan({
    campaignId: 'autonomous-research:autonomous-gpu-paper',
    loopPreparation: preparation('golden-bootstrap'),
  }), null);
  assert.throws(() => buildAutonomousResearchGpuScientificExecutionPlan({
    campaignId: 'autonomous-research:autonomous-gpu-paper',
    loopPreparation: preparation(),
    budgets: { maxWallTimeMs: 1_000 },
    productionReadiness: readiness({
      gpuContainer: { deviceSelector: 'all' },
    }),
  }), /gpu_scientific_device_authority_required/);
  assert.throws(() => buildAutonomousResearchGpuScientificExecutionPlan({
    campaignId: 'autonomous-research:autonomous-gpu-paper',
    loopPreparation: preparation(),
    budgets: { maxWallTimeMs: 0 },
    productionReadiness: readiness(),
  }), /gpu_scientific_deadline_authority_required/);
});
