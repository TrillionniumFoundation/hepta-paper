import { deepFreezeJsonValue } from '../../workflow-kernel/deep-freeze-json-value.mjs';
import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  verifyAdvancedNumericalPluginDescriptor,
} from '../research/advanced-numerical-plugin-contract.mjs';
import { verifyAnalysisProtocol } from './analysis-protocol-contract.mjs';
import { verifyVersionedExperimentIr } from './versioned-experiment-ir.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,511}$/;

export const ADVANCED_NUMERICAL_CAMPAIGN_NODE_KIND = 'advanced-numerical-analysis';

const TYPED_INPUT_KEYS = Object.freeze([
  'advancedNumericalTypedInputHash', 'kind', 'schemaHash', 'schemaId',
  'value', 'version',
]);
const RUNTIME_IDENTITY_KEYS = Object.freeze([
  'advancedNumericalPluginRuntimeIdentityHash', 'configurationHash',
  'configurationVersion', 'dependencyFileHashes', 'kind', 'signedBundleHash',
  'version',
]);
const BUDGET_KEYS = Object.freeze([
  'cpuSeconds', 'maximumCapturedBytes', 'maximumOutputBytes',
  'maximumProcesses', 'memoryBytes', 'timeoutMs',
]);
const PLAN_KEYS = Object.freeze([
  'advancedNumericalCampaignExecutionPlanHash', 'analysisProtocol',
  'analysisProtocolHash', 'budget', 'campaignId', 'kind', 'nodeId',
  'nodeKind', 'paperId', 'pluginDescriptor', 'pluginDescriptorHash',
  'pluginRuntimeIdentity', 'pluginRuntimeIdentityHash', 'promotionPolicy',
  'seed', 'sourceMutationPolicy', 'status', 'typedInput', 'typedInputHash',
  'version', 'versionedExperimentIr', 'versionedExperimentIrHash',
]);

function sha(value) {
  return SHA256.test(String(value || '').toLowerCase());
}

function safeId(value) {
  const selected = String(value || '').trim();
  return SAFE_ID.test(selected) ? selected : null;
}

function canonicalHashMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('advanced_numerical_plugin_runtime_dependency_hashes_invalid');
  }
  const rows = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
  if (!rows.length || rows.some(([name, digest]) => (
    !/^[A-Za-z][A-Za-z0-9]{0,127}$/.test(name) || !sha(digest)
  ))) {
    throw new Error('advanced_numerical_plugin_runtime_dependency_hashes_invalid');
  }
  return Object.freeze(Object.fromEntries(rows.map(([name, digest]) => (
    [name, String(digest).toLowerCase()]
  ))));
}

function canonicalBudget(value, descriptor) {
  if (!hasExactObjectKeys(value, BUDGET_KEYS)) {
    throw new Error('advanced_numerical_campaign_budget_invalid');
  }
  const budget = Object.freeze(Object.fromEntries(BUDGET_KEYS.map((key) => (
    [key, Number(value[key])]
  ))));
  if (BUDGET_KEYS.some((key) => (
    !Number.isSafeInteger(budget[key])
      || budget[key] < 1
      || budget[key] !== Number(descriptor.limits[key])
  )) || budget.maximumCapturedBytes > budget.maximumOutputBytes) {
    throw new Error('advanced_numerical_campaign_budget_invalid');
  }
  return budget;
}

function canonicalPluginInput({
  versionedExperimentIr,
  analysisProtocol,
  typedInput,
  budget,
} = {}) {
  const input = Object.freeze({
    versionedExperimentIr,
    analysisProtocol,
    typedInput,
    budget,
  });
  if (Buffer.byteLength(JSON.stringify(input)) > 32 * 1024) {
    throw new Error('advanced_numerical_campaign_plugin_input_too_large');
  }
  return input;
}

export function advancedNumericalCampaignNodeId(campaignId) {
  const selected = safeId(campaignId);
  if (!selected) throw new Error('advanced_numerical_campaign_id_invalid');
  return `${selected}:0:${ADVANCED_NUMERICAL_CAMPAIGN_NODE_KIND}`;
}

export function buildAdvancedNumericalCampaignTypedInput({
  schemaId,
  schemaHash,
  value,
} = {}) {
  const selectedSchemaId = safeId(schemaId);
  if (!selectedSchemaId || !sha(schemaHash)) {
    throw new Error('advanced_numerical_typed_input_schema_invalid');
  }
  let frozenValue;
  try {
    frozenValue = deepFreezeJsonValue(structuredClone(value));
  } catch {
    throw new Error('advanced_numerical_typed_input_value_invalid');
  }
  if (Buffer.byteLength(JSON.stringify(frozenValue)) > 32 * 1024) {
    throw new Error('advanced_numerical_typed_input_value_too_large');
  }
  const payload = {
    version: 1,
    kind: 'AdvancedNumericalTypedInput',
    schemaId: selectedSchemaId,
    schemaHash: String(schemaHash).toLowerCase(),
    value: frozenValue,
  };
  return Object.freeze({
    ...payload,
    advancedNumericalTypedInputHash:
      hashRecord('AdvancedNumericalTypedInput', payload),
  });
}

export function verifyAdvancedNumericalCampaignTypedInput(value) {
  if (!hasExactObjectKeys(value, TYPED_INPUT_KEYS)) return false;
  try {
    const rebuilt = buildAdvancedNumericalCampaignTypedInput(value);
    return JSON.stringify(rebuilt) === JSON.stringify(value);
  } catch {
    return false;
  }
}

export function buildAdvancedNumericalPluginRuntimeIdentity({
  configurationVersion,
  configurationHash,
  signedBundleHash,
  dependencyFileHashes,
} = {}) {
  const selectedVersion = Number(configurationVersion);
  if (![1, 2].includes(selectedVersion) || !sha(configurationHash)
    || !sha(signedBundleHash)) {
    throw new Error('advanced_numerical_plugin_runtime_identity_invalid');
  }
  const payload = {
    version: 1,
    kind: 'AdvancedNumericalPluginRuntimeIdentity',
    configurationVersion: selectedVersion,
    configurationHash: String(configurationHash).toLowerCase(),
    signedBundleHash: String(signedBundleHash).toLowerCase(),
    dependencyFileHashes: canonicalHashMap(dependencyFileHashes),
  };
  return Object.freeze({
    ...payload,
    advancedNumericalPluginRuntimeIdentityHash:
      hashRecord('AdvancedNumericalPluginRuntimeIdentity', payload),
  });
}

export function verifyAdvancedNumericalPluginRuntimeIdentity(value) {
  if (!hasExactObjectKeys(value, RUNTIME_IDENTITY_KEYS)) return false;
  try {
    return JSON.stringify(buildAdvancedNumericalPluginRuntimeIdentity(value))
      === JSON.stringify(value);
  } catch {
    return false;
  }
}

function analysisProtocolValid(protocol, experimentIr) {
  return protocol?.benchmarkFamily === experimentIr?.benchmarkFamily
    && verifyAnalysisProtocol(protocol, {
      benchmarkId: protocol?.benchmarkId,
      benchmarkFamily: experimentIr?.benchmarkFamily,
      requiredMetrics: protocol?.requiredMetrics,
      metricSpecs: protocol?.metricSpecs,
    });
}

export function buildAdvancedNumericalCampaignExecutionPlan({
  campaignId,
  paperId,
  nodeId = null,
  versionedExperimentIr,
  analysisProtocol,
  pluginDescriptor,
  pluginRuntimeIdentity,
  typedInput,
  seed,
  budget = null,
} = {}) {
  const selectedCampaignId = safeId(campaignId);
  const selectedPaperId = safeId(paperId);
  const expectedNodeId = selectedCampaignId
    ? advancedNumericalCampaignNodeId(selectedCampaignId) : null;
  const selectedNodeId = safeId(nodeId || expectedNodeId);
  if (!selectedCampaignId || !selectedPaperId || selectedNodeId !== expectedNodeId
    || !verifyVersionedExperimentIr(versionedExperimentIr)
    || !analysisProtocolValid(analysisProtocol, versionedExperimentIr)
    || !verifyAdvancedNumericalPluginDescriptor(pluginDescriptor)
    || !verifyAdvancedNumericalPluginRuntimeIdentity(pluginRuntimeIdentity)
    || !verifyAdvancedNumericalCampaignTypedInput(typedInput)
    || !Number.isSafeInteger(seed)) {
    throw new Error('advanced_numerical_campaign_execution_plan_invalid');
  }
  const selectedBudget = canonicalBudget(budget || pluginDescriptor.limits, pluginDescriptor);
  canonicalPluginInput({
    versionedExperimentIr,
    analysisProtocol,
    typedInput,
    budget: selectedBudget,
  });
  const payload = {
    version: 1,
    kind: 'AdvancedNumericalCampaignExecutionPlan',
    status: 'advanced_numerical_campaign_execution_planned',
    campaignId: selectedCampaignId,
    paperId: selectedPaperId,
    nodeId: selectedNodeId,
    nodeKind: ADVANCED_NUMERICAL_CAMPAIGN_NODE_KIND,
    versionedExperimentIr,
    versionedExperimentIrHash: versionedExperimentIr.versionedExperimentIrHash,
    analysisProtocol,
    analysisProtocolHash: analysisProtocol.analysisProtocolHash,
    pluginDescriptor,
    pluginDescriptorHash: pluginDescriptor.advancedNumericalPluginDescriptorHash,
    pluginRuntimeIdentity,
    pluginRuntimeIdentityHash:
      pluginRuntimeIdentity.advancedNumericalPluginRuntimeIdentityHash,
    typedInput,
    typedInputHash: typedInput.advancedNumericalTypedInputHash,
    seed,
    budget: selectedBudget,
    sourceMutationPolicy: 'forbid',
    promotionPolicy: 'production-qualification-required',
  };
  return Object.freeze({
    ...payload,
    advancedNumericalCampaignExecutionPlanHash:
      hashRecord('AdvancedNumericalCampaignExecutionPlan', payload),
  });
}

export function advancedNumericalCampaignPluginInput(plan) {
  if (!verifyAdvancedNumericalCampaignExecutionPlan(plan)) {
    throw new Error('advanced_numerical_campaign_execution_plan_invalid');
  }
  return canonicalPluginInput(plan);
}

export function verifyAdvancedNumericalCampaignExecutionPlan(value, expected = {}) {
  if (!hasExactObjectKeys(value, PLAN_KEYS)) return false;
  try {
    const rebuilt = buildAdvancedNumericalCampaignExecutionPlan({
      ...value,
      nodeId: value.nodeId,
    });
    return JSON.stringify(rebuilt) === JSON.stringify(value)
      && (!expected.campaignId || value.campaignId === expected.campaignId)
      && (!expected.paperId || value.paperId === expected.paperId)
      && (!expected.nodeId || value.nodeId === expected.nodeId);
  } catch {
    return false;
  }
}

export function requireAdvancedNumericalCampaignExecutionPlan(value, {
  campaignId,
  paperId,
  mode,
} = {}) {
  if (value === null || value === undefined) return null;
  if (mode !== 'full-campaign'
    || !verifyAdvancedNumericalCampaignExecutionPlan(value, {
      campaignId,
      paperId,
      nodeId: advancedNumericalCampaignNodeId(campaignId),
    })) {
    throw new Error('campaign_advanced_numerical_execution_plan_invalid');
  }
  return value;
}

function pluginExecutionReceiptValid(value, plan) {
  if (!value || value.version !== 1
    || value.kind !== 'AdvancedNumericalPluginExecutionReceipt'
    || ![
      'advanced_numerical_plugin_execution_completed_qualified',
      'advanced_numerical_plugin_execution_completed_unqualified',
    ].includes(value.status)
    || value.pluginId !== plan.pluginDescriptor.pluginId
    || value.analysisFamily !== plan.pluginDescriptor.analysisFamily
    || value.pluginDescriptorHash !== plan.pluginDescriptorHash
    || !sha(value.requestHash) || !sha(value.resultHash)
    || !sha(value.workerReceiptHash)
    || !sha(value.advancedNumericalPluginExecutionReceiptHash)
    || value.productionQualified !== (value.status
      === 'advanced_numerical_plugin_execution_completed_qualified')) return false;
  const { advancedNumericalPluginExecutionReceiptHash: claimedHash, ...payload } = value;
  return hashRecord('AdvancedNumericalPluginExecutionReceipt', payload) === claimedHash;
}

export function buildAdvancedNumericalCampaignExecutionReceipt({
  campaign,
  node,
  plan,
  pluginExecutionReceipt,
} = {}) {
  if (!verifyAdvancedNumericalCampaignExecutionPlan(plan, {
    campaignId: campaign?.campaignId,
    paperId: campaign?.paperId,
    nodeId: node?.nodeId,
  }) || node?.kind !== ADVANCED_NUMERICAL_CAMPAIGN_NODE_KIND
    || !safeId(node?.attemptId) || !Number.isSafeInteger(node?.leaseGeneration)
    || node.leaseGeneration < 1 || !sha(campaign?.spec?.campaignPlanHash)
    || !pluginExecutionReceiptValid(pluginExecutionReceipt, plan)) {
    throw new Error('advanced_numerical_campaign_execution_receipt_invalid');
  }
  const productionQualified = pluginExecutionReceipt.productionQualified === true;
  const payload = {
    version: 1,
    kind: 'AdvancedNumericalCampaignExecutionReceipt',
    status: productionQualified
      ? 'advanced_numerical_campaign_execution_completed_qualified'
      : 'advanced_numerical_campaign_execution_completed_unqualified',
    campaignId: campaign.campaignId,
    paperId: campaign.paperId,
    campaignPlanHash: campaign.spec.campaignPlanHash,
    nodeId: node.nodeId,
    nodeKind: node.kind,
    attemptId: node.attemptId,
    leaseGeneration: node.leaseGeneration,
    executionPlanHash: plan.advancedNumericalCampaignExecutionPlanHash,
    versionedExperimentIrHash: plan.versionedExperimentIrHash,
    analysisProtocolHash: plan.analysisProtocolHash,
    pluginDescriptorHash: plan.pluginDescriptorHash,
    pluginRuntimeIdentityHash: plan.pluginRuntimeIdentityHash,
    typedInputHash: plan.typedInputHash,
    seed: plan.seed,
    budget: plan.budget,
    pluginExecutionReceiptHash:
      pluginExecutionReceipt.advancedNumericalPluginExecutionReceiptHash,
    pluginExecutionReceipt,
    productionQualified,
    promotionEligible: productionQualified,
    blockers: Object.freeze(productionQualified ? [] : [
      'advanced_numerical_plugin_production_qualification_required',
    ]),
    externalActionPerformed: false,
  };
  return Object.freeze({
    ...payload,
    advancedNumericalCampaignExecutionReceiptHash:
      hashRecord('AdvancedNumericalCampaignExecutionReceipt', payload),
  });
}

export function verifyAdvancedNumericalCampaignExecutionReceipt(value, {
  campaign,
  node,
  plan,
  requirePromotionEligible = false,
} = {}) {
  if (!value || !verifyAdvancedNumericalCampaignExecutionPlan(plan, {
    campaignId: campaign?.campaignId,
    paperId: campaign?.paperId,
    nodeId: node?.nodeId,
  })) return false;
  try {
    const rebuilt = buildAdvancedNumericalCampaignExecutionReceipt({
      campaign,
      node,
      plan,
      pluginExecutionReceipt: value.pluginExecutionReceipt,
    });
    return JSON.stringify(rebuilt) === JSON.stringify(value)
      && (!requirePromotionEligible || value.promotionEligible === true);
  } catch {
    return false;
  }
}

export function buildAdvancedNumericalCampaignEvidence(receipt) {
  if (!receipt || !sha(receipt.advancedNumericalCampaignExecutionReceiptHash)) {
    throw new Error('advanced_numerical_campaign_evidence_receipt_invalid');
  }
  const payload = {
    version: 1,
    kind: 'AdvancedNumericalCampaignEvidence',
    status: receipt.promotionEligible
      ? 'advanced_numerical_campaign_evidence_qualified'
      : 'advanced_numerical_campaign_evidence_unqualified',
    campaignId: receipt.campaignId,
    paperId: receipt.paperId,
    nodeId: receipt.nodeId,
    attemptId: receipt.attemptId,
    leaseGeneration: receipt.leaseGeneration,
    executionPlanHash: receipt.executionPlanHash,
    versionedExperimentIrHash: receipt.versionedExperimentIrHash,
    analysisProtocolHash: receipt.analysisProtocolHash,
    advancedNumericalCampaignExecutionReceiptHash:
      receipt.advancedNumericalCampaignExecutionReceiptHash,
    receipt,
    productionQualified: receipt.productionQualified,
    promotionEligible: receipt.promotionEligible,
    blockers: receipt.blockers,
    externalActionPerformed: false,
  };
  return Object.freeze({
    ...payload,
    advancedNumericalCampaignEvidenceHash:
      hashRecord('AdvancedNumericalCampaignEvidence', payload),
  });
}

export function advancedNumericalCampaignEvidenceBytes(evidence) {
  return Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
}

export function buildCampaignAdvancedNumericalExecutionResult({
  campaign,
  node,
  plan,
  pluginExecutionReceipt,
} = {}) {
  const receipt = buildAdvancedNumericalCampaignExecutionReceipt({
    campaign,
    node,
    plan,
    pluginExecutionReceipt,
  });
  const evidence = buildAdvancedNumericalCampaignEvidence(receipt);
  const evidenceDocumentHash = hashBytes(advancedNumericalCampaignEvidenceBytes(evidence));
  const payload = {
    version: 1,
    kind: 'CampaignAdvancedNumericalExecutionResult',
    status: receipt.productionQualified
      ? 'campaign_advanced_numerical_execution_completed_qualified'
      : 'campaign_advanced_numerical_execution_completed_unqualified',
    campaignId: receipt.campaignId,
    paperId: receipt.paperId,
    nodeId: receipt.nodeId,
    attemptId: receipt.attemptId,
    leaseGeneration: receipt.leaseGeneration,
    executionPlanHash: receipt.executionPlanHash,
    advancedNumericalCampaignExecutionReceiptHash:
      receipt.advancedNumericalCampaignExecutionReceiptHash,
    advancedNumericalCampaignExecutionReceipt: receipt,
    advancedNumericalCampaignEvidenceHash:
      evidence.advancedNumericalCampaignEvidenceHash,
    advancedNumericalCampaignEvidence: evidence,
    evidenceDocumentHash,
    materializedPaths: Object.freeze([]),
    productionQualified: receipt.productionQualified,
    promotionEligible: receipt.promotionEligible,
    blockers: receipt.blockers,
    externalActionPerformed: false,
  };
  return Object.freeze({
    ...payload,
    campaignAdvancedNumericalExecutionResultHash:
      hashRecord('CampaignAdvancedNumericalExecutionResult', payload),
  });
}

export function verifyCampaignAdvancedNumericalExecutionResult(value, {
  campaign,
  node,
  plan,
  requirePromotionEligible = false,
} = {}) {
  const {
    workspaceAttemptIntegration: _workspaceAttemptIntegration,
    ...semanticValue
  } = value || {};
  if (!value || !verifyAdvancedNumericalCampaignExecutionReceipt(
    semanticValue.advancedNumericalCampaignExecutionReceipt,
    { campaign, node, plan, requirePromotionEligible },
  )) return false;
  try {
    const rebuilt = buildCampaignAdvancedNumericalExecutionResult({
      campaign,
      node,
      plan,
      pluginExecutionReceipt:
        semanticValue.advancedNumericalCampaignExecutionReceipt.pluginExecutionReceipt,
    });
    return JSON.stringify(rebuilt) === JSON.stringify(semanticValue)
      && (!requirePromotionEligible || semanticValue.promotionEligible === true);
  } catch {
    return false;
  }
}
