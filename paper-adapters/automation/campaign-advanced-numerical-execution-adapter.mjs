import {
  advancedNumericalCampaignPluginInput,
  buildAdvancedNumericalPluginRuntimeIdentity,
  buildCampaignAdvancedNumericalExecutionResult,
  verifyAdvancedNumericalCampaignExecutionPlan,
  verifyCampaignAdvancedNumericalExecutionResult,
} from '../../paper-domain/automation/advanced-numerical-campaign-execution-contract.mjs';
import {
  assertCampaignAdvancedNumericalExecutionPort,
} from '../../paper-ports/campaign-advanced-numerical-execution-port.mjs';
import {
  assertAdvancedNumericalPluginRunnerPort,
} from '../../paper-ports/advanced-numerical-plugin-runner-port.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  createCampaignAdvancedNumericalEvidenceRepository,
} from './campaign-advanced-numerical-evidence-repository.mjs';

function runtimeIdentityFromComposition(runtime) {
  return buildAdvancedNumericalPluginRuntimeIdentity({
    configurationVersion: runtime?.runtimeConfiguration?.configuration?.version,
    configurationHash: runtime?.runtimeConfiguration?.configurationHash,
    signedBundleHash: runtime?.verifiedBundle?.signedBundleHash,
    dependencyFileHashes:
      runtime?.runtimeConfiguration?.dependencyFileHashes,
  });
}

export function createCampaignAdvancedNumericalExecutionAdapter({
  runtime,
} = {}) {
  const runner = assertAdvancedNumericalPluginRunnerPort(runtime?.runner);
  const runtimeIdentity = runtimeIdentityFromComposition(runtime);
  const evidenceRepository = createCampaignAdvancedNumericalEvidenceRepository({
    outputRoot: runtime?.runtimeConfiguration?.outputRoot,
  });
  const capabilities = Object.freeze({
    version: 1,
    kind: 'CampaignAdvancedNumericalExecutionCapabilities',
    optionalCampaignNode: true,
    hashBoundPlan: true,
    attemptLeaseBound: true,
    idempotentNoClobber: true,
    osSandboxDelegated: true,
    productionQualificationRequiredForPromotion: true,
    productionQualified: runner.capabilities().productionQualified === true,
    pluginRuntimeIdentityHash:
      runtimeIdentity.advancedNumericalPluginRuntimeIdentityHash,
  });
  return assertCampaignAdvancedNumericalExecutionPort(Object.freeze({
    version: 1,
    kind: 'CampaignAdvancedNumericalExecutionPort',
    capabilities: () => capabilities,
    async execute({ campaign, node, plan } = {}) {
      if (!verifyAdvancedNumericalCampaignExecutionPlan(plan, {
        campaignId: campaign?.campaignId,
        paperId: campaign?.paperId,
        nodeId: node?.nodeId,
      }) || plan.pluginRuntimeIdentityHash
        !== runtimeIdentity.advancedNumericalPluginRuntimeIdentityHash
        || node?.advancedNumericalExecutionPlanHash
          !== plan.advancedNumericalCampaignExecutionPlanHash
        || !node?.attemptId || !Number.isSafeInteger(node?.leaseGeneration)
        || node.leaseGeneration < 1) {
        const error = new Error('advanced_numerical_campaign_execution_binding_invalid');
        error.retryable = false;
        throw error;
      }
      const { outputDirectory, cachedPath } = evidenceRepository.prepareAttempt({
        campaign, node, plan,
      });
      const cached = evidenceRepository.readCached({ cachedPath });
      if (cached) {
        if (!verifyCampaignAdvancedNumericalExecutionResult(cached, {
          campaign, node, plan,
        })) {
          const error = new Error('advanced_numerical_campaign_cached_receipt_invalid');
          error.retryable = false;
          throw error;
        }
        return cached;
      }
      const pluginExecutionReceipt = await runner.run({
        runId: `advanced-numerical:${hashRecord('AdvancedNumericalCampaignPluginRun', {
          campaignId: campaign.campaignId,
          nodeId: node.nodeId,
          attemptId: node.attemptId,
          leaseGeneration: node.leaseGeneration,
        }).slice('sha256:'.length)}`,
        input: advancedNumericalCampaignPluginInput(plan),
        seed: plan.seed,
        outputDirectory,
      });
      if (![
        'advanced_numerical_plugin_execution_completed_qualified',
        'advanced_numerical_plugin_execution_completed_unqualified',
      ].includes(pluginExecutionReceipt?.status)) {
        const error = new Error(
          `advanced_numerical_campaign_plugin_execution_blocked:${
            (pluginExecutionReceipt?.blockers || []).join(',') || pluginExecutionReceipt?.status || 'unknown'
          }`,
        );
        error.retryable = false;
        error.receipt = pluginExecutionReceipt || null;
        throw error;
      }
      const result = buildCampaignAdvancedNumericalExecutionResult({
        campaign,
        node,
        plan,
        pluginExecutionReceipt,
      });
      evidenceRepository.persistCached({ cachedPath, result });
      return result;
    },
  }));
}
