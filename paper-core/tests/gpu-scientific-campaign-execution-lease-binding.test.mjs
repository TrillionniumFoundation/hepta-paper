import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildGpuScientificCampaignAttemptAuthority,
  buildGpuScientificCampaignExecutionResult,
  verifyGpuScientificCampaignExecutionResult,
} from '../../paper-domain/automation/gpu-scientific-campaign-execution-contract.mjs';
import {
  verifyGpuScientificDeepLearningTaskReceipt,
  verifyGpuScientificPdeTaskReceipt,
} from '../../paper-domain/automation/gpu-scientific-campaign-evidence-verifier.mjs';
import {
  gpuScientificReleaseEvidenceValid,
} from '../../paper-domain/automation/campaign-release-contract-helpers.mjs';
import {
  buildGpuScientificCampaignPromotionEvidence,
} from '../../paper-domain/automation/gpu-scientific-campaign-promotion-contract.mjs';
import {
  buildPdePoisson2dGpuArtifactManifest,
} from '../../paper-domain/research/pde-poisson-2d-gpu-capability-contract.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  createGpuScientificCampaignReleaseFixture,
} from './support/gpu-scientific-campaign-release-fixture.mjs';
import {
  createPdePoisson2dCpuOracleFixtureRunner,
} from './support/pde-poisson-2d-cpu-oracle-fixture-runner.mjs';
import {
  importProcessIsolatedPdePoisson2dIndependentCpuOracleForTest,
  withPdePoisson2dCpuOracleSandboxRunnerForTest,
} from './support/process-isolated-pde-poisson-2d-independent-cpu-oracle-test-seam.mjs';

const processIsolatedPdeCpuOracleModule =
  await importProcessIsolatedPdePoisson2dIndependentCpuOracleForTest();

const H = (label) => hashRecord(
  'GpuScientificCampaignExecutionLeaseBindingTest',
  { label },
);

function workerReceiptWithBinding(workerReceipt, binding) {
  const rebuilt = structuredClone(workerReceipt);
  rebuilt.gpuSelectorExecutionLeaseBinding = binding;
  rebuilt.gpuSelectorExecutionLeaseBindingHash =
    binding.gpuSelectorExecutionLeaseBindingHash;
  const payload = { ...rebuilt };
  delete payload.ok;
  delete payload.receiptHash;
  delete payload.blockers;
  rebuilt.receiptHash = hashRecord('OsSandboxWorkerReceipt', payload);
  return rebuilt;
}

function workerReceiptWithAcquisition(originalWorkerReceipt, overrides) {
  const originalBinding =
    originalWorkerReceipt.gpuSelectorExecutionLeaseBinding;
  const originalAcquisition =
    originalBinding.gpuSelectorExecutionLeaseReceipt;
  const acquisitionPayload = {
    ...structuredClone(originalAcquisition),
    ...overrides,
  };
  delete acquisitionPayload.gpuSelectorExecutionLeaseReceiptHash;
  const acquisitionReceipt = {
    ...acquisitionPayload,
    gpuSelectorExecutionLeaseReceiptHash: hashRecord(
      'GpuSelectorExecutionLeaseReceipt',
      acquisitionPayload,
    ),
  };
  const bindingPayload = {
    ...structuredClone(originalBinding),
    gpuSelectorExecutionLeaseReceipt: acquisitionReceipt,
    gpuSelectorExecutionLeaseReceiptHash:
      acquisitionReceipt.gpuSelectorExecutionLeaseReceiptHash,
  };
  delete bindingPayload.gpuSelectorExecutionLeaseBindingHash;
  const binding = {
    ...bindingPayload,
    gpuSelectorExecutionLeaseBindingHash: hashRecord(
      'GpuSelectorExecutionLeaseWorkerBinding',
      bindingPayload,
    ),
  };
  return workerReceiptWithBinding(
    originalWorkerReceipt,
    binding,
  );
}

function deepLearningReceiptWithAcquisition(receipt, overrides) {
  const workerReceipt = workerReceiptWithAcquisition(
    receipt.workerReceipt,
    overrides,
  );
  const rebuilt = structuredClone(receipt);
  rebuilt.workerReceipt = workerReceipt;
  rebuilt.workerReceiptHash = workerReceipt.receiptHash;
  rebuilt.environmentBomHash = workerReceipt.environmentBomHash;
  delete rebuilt.canonicalCupyDeepLearningTrainingReceiptHash;
  rebuilt.canonicalCupyDeepLearningTrainingReceiptHash = hashRecord(
    'CanonicalCupyDeepLearningTrainingReceipt',
    rebuilt,
  );
  return rebuilt;
}

function pdeScientificReceiptWithAcquisition(receipt, overrides, runtimeRoot) {
  const originalGpuReceipt = receipt.gpuReceipt;
  const originalManifest = originalGpuReceipt.artifactManifest;
  const workerReceipt = workerReceiptWithAcquisition(
    originalManifest.osSandboxWorkerReceipt,
    overrides,
  );
  const artifactManifest = buildPdePoisson2dGpuArtifactManifest({
    ...originalManifest,
    producerSpecification: originalGpuReceipt.producerSpecification,
    workerReceiptHash: workerReceipt.receiptHash,
    osSandboxWorkerReceipt: workerReceipt,
  });
  const gpuReceipt = structuredClone(originalGpuReceipt);
  gpuReceipt.artifactManifest = artifactManifest;
  gpuReceipt.artifactManifestHash =
    artifactManifest.pdePoisson2dGpuArtifactManifestHash;
  gpuReceipt.workerReceiptHash = workerReceipt.receiptHash;
  delete gpuReceipt.canonicalCupyPdePoisson2dExecutionReceiptHash;
  gpuReceipt.canonicalCupyPdePoisson2dExecutionReceiptHash = hashRecord(
    'CanonicalCupyPdePoisson2dExecutionReceipt',
    gpuReceipt,
  );
  const cpuOracleAssurance =
    withPdePoisson2dCpuOracleSandboxRunnerForTest(
      createPdePoisson2dCpuOracleFixtureRunner({ runtimeRoot }),
      () => processIsolatedPdeCpuOracleModule
        .runProcessIsolatedPdePoisson2dIndependentCpuOracle({
          artifactRoot: gpuReceipt.outputDirectory,
          artifactManifest,
          producerSpecification: gpuReceipt.producerSpecification,
          absoluteDeadlineEpochMs: gpuReceipt.absoluteDeadlineEpochMs,
        }),
    );
  const rebuilt = structuredClone(receipt);
  rebuilt.gpuReceipt = gpuReceipt;
  rebuilt.cpuOracleAssurance = cpuOracleAssurance;
  delete rebuilt.canonicalPdePoisson2dGpuScientificReceiptHash;
  rebuilt.canonicalPdePoisson2dGpuScientificReceiptHash = hashRecord(
    'CanonicalPdePoisson2dGpuScientificReceipt',
    rebuilt,
  );
  return rebuilt;
}

function executionResultWithTaskReceipts(result, receipts) {
  const rebuilt = structuredClone(result);
  receipts.forEach((receipt, index) => {
    if (!receipt) return;
    const taskResult = rebuilt.taskResults[index];
    taskResult.receipt = receipt;
    taskResult.receiptHash = index === 0
      ? receipt.canonicalPdePoisson2dGpuScientificReceiptHash
      : receipt.canonicalCupyDeepLearningTrainingReceiptHash;
    delete taskResult.gpuScientificCampaignTaskResultHash;
    taskResult.gpuScientificCampaignTaskResultHash = hashRecord(
      'GpuScientificCampaignTaskResult',
      taskResult,
    );
    rebuilt.taskResultHashes[index] =
      taskResult.gpuScientificCampaignTaskResultHash;
  });
  delete rebuilt.gpuScientificCampaignExecutionResultHash;
  rebuilt.gpuScientificCampaignExecutionResultHash = hashRecord(
    'GpuScientificCampaignExecutionResult',
    rebuilt,
  );
  return rebuilt;
}

function executionResultWithDeepLearningReceipt(result, receipt) {
  return executionResultWithTaskReceipts(result, [null, receipt]);
}

test('GPU campaign result rejects individually valid task receipts outside one attempt-owned outer lease', async (t) => {
  const fixture = await createGpuScientificCampaignReleaseFixture(t, {
    campaignId: 'gpu-campaign-lease-binding-negative',
  });
  const { campaign, gpu } = fixture;
  const { executionPlan: plan, node, executionResult: result } = gpu;
  const pdeReceipt = result.taskResults[0].receipt;
  const deepLearningReceipt = result.taskResults[1].receipt;
  assert.equal(
    pdeReceipt.cpuOracleAssurance.runtimeAttestation.executableTarget,
    '/usr/bin/node',
  );
  const pdeAcquisition = pdeReceipt.gpuReceipt.artifactManifest
    .osSandboxWorkerReceipt.gpuSelectorExecutionLeaseBinding
    .gpuSelectorExecutionLeaseReceipt;
  const deepLearningAcquisition = deepLearningReceipt.workerReceipt
    .gpuSelectorExecutionLeaseBinding.gpuSelectorExecutionLeaseReceipt;
  const attemptAuthority = buildGpuScientificCampaignAttemptAuthority({
    campaign,
    node,
    plan,
  });
  const releaseCapsuleManifestHash = H('release-capsule-manifest');
  const releaseCapsuleManifestFileHash = H('release-capsule-manifest-file');
  const releaseAttestationHash = H('release-attestation');
  const qualificationEvidence = fixture.qualification.evidence;
  const promotionEvidence = buildGpuScientificCampaignPromotionEvidence({
    qualificationEvidence,
    researchEvidenceCapsuleManifestHash: releaseCapsuleManifestHash,
    researchEvidenceCapsuleManifestFileHash: releaseCapsuleManifestFileHash,
    researchExecutionReleaseAttestationHash: releaseAttestationHash,
  });

  assert.deepEqual(pdeAcquisition, deepLearningAcquisition);
  assert.equal(
    pdeAcquisition.ownerAuthorityHash,
    attemptAuthority.gpuScientificCampaignAttemptAuthorityHash,
  );

  const invalidAcquisitions = [
    ['different lease id', { leaseId: H('different-lease') }],
    ['non-attempt owner', { ownerAuthorityHash: H('different-owner') }],
    ['different fencing token', { fencingToken: H('different-fencing') }],
    ['different scope', { scope: 'different-coordination-scope-v1' }],
    ['different lock scope identity', {
      lockScopeIdentityHash: H('different-lock-scope'),
    }],
    ['different lock identity', {
      lockIdentityHash: H('different-lock-identity'),
    }],
  ];

  for (const [label, overrides] of invalidAcquisitions) {
    await t.test(label, () => {
      const alteredDeepLearningReceipt =
        deepLearningReceiptWithAcquisition(deepLearningReceipt, overrides);
      assert.equal(verifyGpuScientificDeepLearningTaskReceipt(
        alteredDeepLearningReceipt,
        {
          task: plan.tasks[1],
          gpuDeviceSelector: plan.gpuDeviceSelector,
          deadline: result.effectiveExecutionDeadlineEpochMs,
          executionAuthorityHash:
            attemptAuthority.gpuScientificCampaignAttemptAuthorityHash,
        },
      ), label !== 'different scope');
      assert.throws(() => buildGpuScientificCampaignExecutionResult({
        campaign,
        node,
        plan,
        pdeScientificReceipt: pdeReceipt,
        deepLearningTrainingReceipt: alteredDeepLearningReceipt,
        effectiveExecutionDeadlineEpochMs:
          result.effectiveExecutionDeadlineEpochMs,
        executionStartedAtEpochMs: result.executionStartedAtEpochMs,
        executionCompletedAtEpochMs: result.executionCompletedAtEpochMs,
      }), /gpu_scientific_campaign_execution_lease_binding_invalid/);
      const forgedResult = executionResultWithDeepLearningReceipt(
        result,
        alteredDeepLearningReceipt,
      );
      assert.equal(verifyGpuScientificCampaignExecutionResult(forgedResult, {
        campaign,
        node,
        plan,
      }), false);
      assert.equal(gpuScientificReleaseEvidenceValid({
        campaignPlanHash: campaign.spec.campaignPlanHash,
        campaignId: campaign.campaignId,
        paperId: campaign.paperId,
        plan,
        evidence: forgedResult,
        qualificationEvidence,
        promotionEvidence,
        researchEvidenceCapsuleManifestHash: releaseCapsuleManifestHash,
        researchEvidenceCapsuleManifestFileHash:
          releaseCapsuleManifestFileHash,
        researchExecutionReleaseAttestationHash: releaseAttestationHash,
      }), false);
    });
  }

  await t.test('same non-attempt owner on both task receipts', () => {
    const ownerAuthorityHash = H('shared-non-attempt-owner');
    const alteredPdeReceipt = pdeScientificReceiptWithAcquisition(
      pdeReceipt,
      { ownerAuthorityHash },
      fixture.runtimeRoot,
    );
    const alteredDeepLearningReceipt = deepLearningReceiptWithAcquisition(
      deepLearningReceipt,
      { ownerAuthorityHash },
    );
    const alteredPdeAcquisition = alteredPdeReceipt.gpuReceipt.artifactManifest
      .osSandboxWorkerReceipt.gpuSelectorExecutionLeaseBinding
      .gpuSelectorExecutionLeaseReceipt;
    const alteredDeepLearningAcquisition = alteredDeepLearningReceipt
      .workerReceipt.gpuSelectorExecutionLeaseBinding
      .gpuSelectorExecutionLeaseReceipt;
    assert.deepEqual(alteredPdeAcquisition, alteredDeepLearningAcquisition);
    assert.equal(alteredPdeAcquisition.ownerAuthorityHash, ownerAuthorityHash);
    assert.notEqual(
      ownerAuthorityHash,
      attemptAuthority.gpuScientificCampaignAttemptAuthorityHash,
    );
    assert.equal(verifyGpuScientificPdeTaskReceipt(alteredPdeReceipt, {
      task: plan.tasks[0],
      gpuDeviceSelector: plan.gpuDeviceSelector,
      deadline: result.effectiveExecutionDeadlineEpochMs,
      executionAuthorityHash:
        attemptAuthority.gpuScientificCampaignAttemptAuthorityHash,
    }), true);
    assert.equal(verifyGpuScientificDeepLearningTaskReceipt(
      alteredDeepLearningReceipt,
      {
        task: plan.tasks[1],
        gpuDeviceSelector: plan.gpuDeviceSelector,
        deadline: result.effectiveExecutionDeadlineEpochMs,
        executionAuthorityHash:
          attemptAuthority.gpuScientificCampaignAttemptAuthorityHash,
      },
    ), true);
    assert.throws(() => buildGpuScientificCampaignExecutionResult({
      campaign,
      node,
      plan,
      pdeScientificReceipt: alteredPdeReceipt,
      deepLearningTrainingReceipt: alteredDeepLearningReceipt,
      effectiveExecutionDeadlineEpochMs:
        result.effectiveExecutionDeadlineEpochMs,
      executionStartedAtEpochMs: result.executionStartedAtEpochMs,
      executionCompletedAtEpochMs: result.executionCompletedAtEpochMs,
    }), /gpu_scientific_campaign_execution_lease_binding_invalid/);
    const forgedResult = executionResultWithTaskReceipts(result, [
      alteredPdeReceipt,
      alteredDeepLearningReceipt,
    ]);
    assert.equal(verifyGpuScientificCampaignExecutionResult(forgedResult, {
      campaign,
      node,
      plan,
    }), false);
    assert.equal(gpuScientificReleaseEvidenceValid({
      campaignPlanHash: campaign.spec.campaignPlanHash,
      campaignId: campaign.campaignId,
      paperId: campaign.paperId,
      plan,
      evidence: forgedResult,
      qualificationEvidence,
      promotionEvidence,
      researchEvidenceCapsuleManifestHash: releaseCapsuleManifestHash,
      researchEvidenceCapsuleManifestFileHash:
        releaseCapsuleManifestFileHash,
      researchExecutionReleaseAttestationHash: releaseAttestationHash,
    }), false);
  });

  const missingBindingReceipt = structuredClone(deepLearningReceipt);
  delete missingBindingReceipt.workerReceipt
    .gpuSelectorExecutionLeaseBinding;
  delete missingBindingReceipt.workerReceipt
    .gpuSelectorExecutionLeaseBindingHash;
  const workerPayload = {
    ...missingBindingReceipt.workerReceipt,
  };
  delete workerPayload.ok;
  delete workerPayload.receiptHash;
  delete workerPayload.blockers;
  missingBindingReceipt.workerReceipt.receiptHash = hashRecord(
    'OsSandboxWorkerReceipt',
    workerPayload,
  );
  missingBindingReceipt.workerReceiptHash =
    missingBindingReceipt.workerReceipt.receiptHash;
  delete missingBindingReceipt.canonicalCupyDeepLearningTrainingReceiptHash;
  missingBindingReceipt.canonicalCupyDeepLearningTrainingReceiptHash =
    hashRecord('CanonicalCupyDeepLearningTrainingReceipt', missingBindingReceipt);
  assert.throws(() => buildGpuScientificCampaignExecutionResult({
    campaign,
    node,
    plan,
    pdeScientificReceipt: pdeReceipt,
    deepLearningTrainingReceipt: missingBindingReceipt,
    effectiveExecutionDeadlineEpochMs:
      result.effectiveExecutionDeadlineEpochMs,
    executionStartedAtEpochMs: result.executionStartedAtEpochMs,
    executionCompletedAtEpochMs: result.executionCompletedAtEpochMs,
  }), /gpu_scientific_campaign_execution_lease_binding_invalid/);
});
