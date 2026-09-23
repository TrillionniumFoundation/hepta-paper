import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  verifyMachineProposedScientificClaimSet,
} from './autonomous-research-proposal-contract.mjs';
import {
  validateOperatorDatasetAuthorityDocument,
} from './operator-dataset-harness-contract.mjs';
import {
  verifyResearchAgendaClaimBindingReceipt,
} from './research-agenda-claim-binding-contract.mjs';
import { verifyResearchAgendaIr } from './research-agenda-ir.mjs';
import {
  SYSTEM_BENCHMARK_CPU_BUDGET_SEMANTICS,
} from './system-benchmark-resource-budget-contract.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const BINDING_KEYS = Object.freeze([
  'dataRequirements', 'dataRequirementsHash', 'datasetCompatibility',
  'datasetResearchCompatibilityHash', 'empiricalClaimKey', 'empiricalClaimRecord',
  'empiricalClaimRecordHash', 'estimandHash', 'executionBudget',
  'executionBudgetHash', 'experimentResearchBindingHash', 'falsifiers',
  'falsifiersHash', 'kind', 'paperId', 'productionGenericEligible', 'proposal',
  'proposalHash', 'protocolFamily', 'researchAgendaClaimBindingReceipt',
  'researchAgendaClaimBindingReceiptHash', 'researchAgendaIr',
  'researchAgendaIrHash', 'resourceFeasibility', 'resourceFeasibilityHash',
  'status', 'version',
]);
const DATASET_COMPATIBILITY_KEYS = Object.freeze([
  'authorizedVariables', 'comparator', 'compatible', 'datasetConstraints', 'datasetManifestHash',
  'datasetName', 'datasetPopulation', 'datasetResearchSemanticsHash',
  'datasetSplitIdentityHash', 'datasetSplitManifestHash', 'eligibleSplits',
  'estimand', 'intervention', 'kind', 'operatorDatasetAuthority',
  'operatorDatasetAuthorityDocumentHash', 'population', 'requiredVariables',
  'schemaCompatibilityMode', 'selectorHash', 'status', 'version',
]);
const EXECUTION_BUDGET_KEYS = Object.freeze([
  'aggregateCpuSeconds', 'cpuBudgetSemantics', 'cpuCount', 'executionEnvironment', 'maximumWallTimeMs',
  'memoryBytes',
]);

function sha(value) {
  return SHA256.test(String(value || ''));
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function empiricalClaimFromProposal(proposal, key) {
  const matches = (proposal?.claims || []).filter((claim) => (
    claim?.verificationMode === 'empirical_protocol' && claim?.claimKey === key
  ));
  return matches.length === 1 ? matches[0] : null;
}

function researchSemanticsHash(semantics) {
  return hashRecord('OperatorDatasetResearchSemantics', semantics);
}

function canonicalDatasetCompatibility({
  researchAgendaIr,
  selector,
  datasetAuthorizationSet,
} = {}) {
  if (selector?.selectorType !== 'authorized_dataset_mount'
    || !sha(selector?.campaignBenchmarkSelectorHash)
    || !sha(selector?.experimentDesign?.datasetSplitIdentityHash)
    || !Array.isArray(datasetAuthorizationSet?.datasets)) {
    throw new Error('experiment_research_dataset_authority_required');
  }
  const dataset = datasetAuthorizationSet.datasets.filter((candidate) => (
    candidate?.name === selector.datasetMountName
  ));
  if (dataset.length !== 1) {
    throw new Error('experiment_research_dataset_authorization_ambiguous');
  }
  const selected = dataset[0];
  let authority = null;
  try {
    authority = validateOperatorDatasetAuthorityDocument(
      selected.operatorDatasetAuthority,
      { datasetName: selected.name, datasetManifestHash: selected.manifestHash },
    );
  } catch {
    throw new Error('experiment_research_dataset_semantic_authority_invalid');
  }
  if (authority.authority.version !== 3
    || !authority.authority.researchSemantics
    || authority.operatorDatasetAuthorityDocumentHash
      !== selected.operatorDatasetAuthorityDocumentHash
    || selected.operatorAuthorizationHash !== selected.operatorDatasetAuthorityDocumentHash
    || authority.authority.datasetSplitManifestHash !== selected.splitManifestHash
    || authority.authority.datasetSplitManifestHash !== selector.datasetSplitManifestHash
    || selector.experimentDesign.datasetSplitIdentityHash !== selector.datasetSplitManifestHash
    || authority.authority.benchmarkFamily !== researchAgendaIr.protocolFamily
    || authority.authority.benchmarkFamily !== selector.experimentDesign.benchmarkFamily) {
    throw new Error('experiment_research_dataset_semantic_authority_mismatch');
  }
  const semantics = authority.authority.researchSemantics;
  const semanticsHash = researchSemanticsHash(semantics);
  if (selected.operatorDatasetResearchSemanticsHash
      && selected.operatorDatasetResearchSemanticsHash !== semanticsHash) {
    throw new Error('experiment_research_dataset_semantic_hash_mismatch');
  }
  const requirements = researchAgendaIr.dataRequirements;
  if (requirements.population !== semantics.population) {
    throw new Error('experiment_research_dataset_population_mismatch');
  }
  if (requirements.intervention !== semantics.intervention
    || requirements.comparator !== semantics.comparator) {
    throw new Error('experiment_research_dataset_treatment_contract_mismatch');
  }
  if (!semantics.estimands.includes(requirements.estimand)) {
    throw new Error('experiment_research_dataset_estimand_mismatch');
  }
  const variables = new Set(semantics.variables);
  if (requirements.requiredVariables.some((variable) => !variables.has(variable))) {
    throw new Error('experiment_research_dataset_required_variable_missing');
  }
  const constraints = new Set(semantics.datasetConstraints);
  if (requirements.datasetConstraints.some((constraint) => !constraints.has(constraint))) {
    throw new Error('experiment_research_dataset_constraint_mismatch');
  }
  const payload = {
    version: 1,
    kind: 'ExperimentDatasetResearchCompatibility',
    status: 'experiment_dataset_research_compatibility_verified',
    datasetName: selected.name,
    datasetManifestHash: selected.manifestHash,
    datasetSplitManifestHash: selected.splitManifestHash,
    datasetSplitIdentityHash: selector.experimentDesign.datasetSplitIdentityHash,
    selectorHash: selector.campaignBenchmarkSelectorHash,
    operatorDatasetAuthorityDocumentHash:
      authority.operatorDatasetAuthorityDocumentHash,
    operatorDatasetAuthority: authority.authority,
    datasetResearchSemanticsHash: semanticsHash,
    population: requirements.population,
    datasetPopulation: semantics.population,
    intervention: requirements.intervention,
    comparator: requirements.comparator,
    estimand: requirements.estimand,
    requiredVariables: Object.freeze([...requirements.requiredVariables]),
    authorizedVariables: semantics.variables,
    datasetConstraints: Object.freeze([...requirements.datasetConstraints]),
    eligibleSplits: semantics.eligibleSplits,
    schemaCompatibilityMode: 'required-variable-subset-of-operator-signed-schema-v1',
    compatible: true,
  };
  return Object.freeze({
    ...payload,
    datasetResearchCompatibilityHash: hashRecord(
      'ExperimentDatasetResearchCompatibility', payload,
    ),
  });
}

function executionEnvironmentCompatible(requested, actual, language) {
  if (requested === actual) return true;
  if (actual !== 'signed-docker-runtime-v1') return false;
  return (language === 'python' && requested === 'signed-python-runtime-v1')
    || (language === 'r' && requested === 'signed-r-runtime-v1');
}

function canonicalExecutionBudget({
  researchAgendaIr,
  maximumWallTimeMs,
  memoryBytes,
  cpuCount,
  aggregateCpuSeconds,
  executionEnvironment,
  language,
} = {}) {
  const budget = {
    maximumWallTimeMs: Number(maximumWallTimeMs),
    memoryBytes: Number(memoryBytes),
    cpuCount: Number(cpuCount),
    aggregateCpuSeconds: Number(aggregateCpuSeconds),
    cpuBudgetSemantics: SYSTEM_BENCHMARK_CPU_BUDGET_SEMANTICS,
    executionEnvironment: String(executionEnvironment || ''),
  };
  const feasibility = researchAgendaIr?.resourceFeasibility;
  const maximumFeasibleCpuSeconds = Math.floor(
    Number(budget.maximumWallTimeMs) / 1000,
  ) * Number(budget.cpuCount);
  if (!hasExactObjectKeys(budget, EXECUTION_BUDGET_KEYS)
    || !Number.isSafeInteger(budget.maximumWallTimeMs) || budget.maximumWallTimeMs < 1
    || !Number.isSafeInteger(budget.memoryBytes) || budget.memoryBytes < 1
    || !Number.isSafeInteger(budget.cpuCount) || budget.cpuCount < 1
    || !Number.isSafeInteger(budget.aggregateCpuSeconds) || budget.aggregateCpuSeconds < 1
    || budget.cpuBudgetSemantics !== SYSTEM_BENCHMARK_CPU_BUDGET_SEMANTICS
    || budget.maximumWallTimeMs > feasibility.maximumWallTimeMs
    || budget.memoryBytes > feasibility.maximumMemoryBytes
    || budget.cpuCount > feasibility.maximumCpuCount
    || budget.aggregateCpuSeconds > maximumFeasibleCpuSeconds
    || !executionEnvironmentCompatible(
      feasibility.executionEnvironment,
      budget.executionEnvironment,
      language,
    )) {
    throw new Error('experiment_research_resource_feasibility_exceeded');
  }
  return Object.freeze(budget);
}

export function buildExperimentResearchBinding({
  researchAgendaIr,
  proposal,
  researchAgendaClaimBindingReceipt,
  selector,
  datasetAuthorizationSet,
  maximumWallTimeMs,
  memoryBytes,
  cpuCount,
  aggregateCpuSeconds,
  executionEnvironment,
  language,
} = {}) {
  if (!verifyResearchAgendaIr(researchAgendaIr)
    || !verifyMachineProposedScientificClaimSet(proposal).valid
    || !verifyResearchAgendaClaimBindingReceipt(
      researchAgendaClaimBindingReceipt,
      { researchAgendaIr, proposal },
    ).valid
    || proposal.paperId !== researchAgendaIr.paperId
    || proposal.protocolFamily !== researchAgendaIr.protocolFamily) {
    throw new Error('experiment_research_agenda_claim_binding_invalid');
  }
  const empiricalClaim = empiricalClaimFromProposal(
    proposal,
    researchAgendaClaimBindingReceipt.empiricalClaimKey,
  );
  const empiricalClaimRecordHash = empiricalClaim
    ? hashRecord('AutonomousResearchClaimRecord', empiricalClaim) : null;
  if (!empiricalClaim
    || empiricalClaim.statement !== researchAgendaIr.primaryClaim
    || empiricalClaimRecordHash
      !== researchAgendaClaimBindingReceipt.empiricalClaimRecordHash) {
    throw new Error('experiment_research_empirical_claim_binding_invalid');
  }
  const datasetCompatibility = canonicalDatasetCompatibility({
    researchAgendaIr,
    selector,
    datasetAuthorizationSet,
  });
  const executionBudget = canonicalExecutionBudget({
    researchAgendaIr,
    maximumWallTimeMs,
    memoryBytes,
    cpuCount,
    aggregateCpuSeconds,
    executionEnvironment,
    language,
  });
  const dataRequirements = Object.freeze(structuredClone(researchAgendaIr.dataRequirements));
  const falsifiers = Object.freeze([...researchAgendaIr.falsifiers]);
  const resourceFeasibility = Object.freeze(structuredClone(
    researchAgendaIr.resourceFeasibility,
  ));
  const payload = {
    version: 2,
    kind: 'ExperimentResearchBinding',
    status: 'experiment_research_binding_verified',
    paperId: researchAgendaIr.paperId,
    protocolFamily: researchAgendaIr.protocolFamily,
    researchAgendaIr: Object.freeze(structuredClone(researchAgendaIr)),
    researchAgendaIrHash: researchAgendaIr.researchAgendaIrHash,
    researchAgendaClaimBindingReceipt:
      Object.freeze(structuredClone(researchAgendaClaimBindingReceipt)),
    researchAgendaClaimBindingReceiptHash:
      researchAgendaClaimBindingReceipt.researchAgendaClaimBindingReceiptHash,
    proposal: Object.freeze(structuredClone(proposal)),
    proposalHash: proposal.machineProposedScientificClaimSetHash,
    empiricalClaimKey: empiricalClaim.claimKey,
    empiricalClaimRecord: Object.freeze(structuredClone(empiricalClaim)),
    empiricalClaimRecordHash,
    dataRequirements,
    dataRequirementsHash: hashRecord('ExperimentResearchDataRequirements', dataRequirements),
    estimandHash: hashRecord('ExperimentResearchEstimand', {
      estimand: dataRequirements.estimand,
    }),
    falsifiers,
    falsifiersHash: hashRecord('ExperimentResearchFalsifiers', falsifiers),
    datasetCompatibility,
    datasetResearchCompatibilityHash:
      datasetCompatibility.datasetResearchCompatibilityHash,
    resourceFeasibility,
    resourceFeasibilityHash: hashRecord(
      'ExperimentResearchResourceFeasibility', resourceFeasibility,
    ),
    executionBudget,
    executionBudgetHash: hashRecord('ExperimentResearchExecutionBudget', executionBudget),
    productionGenericEligible: true,
  };
  return Object.freeze({
    ...payload,
    experimentResearchBindingHash: hashRecord('ExperimentResearchBinding', payload),
  });
}

export function verifyExperimentResearchBinding(value) {
  try {
    if (!hasExactObjectKeys(value, BINDING_KEYS)
      || value.version !== 2 || value.kind !== 'ExperimentResearchBinding'
      || value.status !== 'experiment_research_binding_verified'
      || value.productionGenericEligible !== true
      || !verifyResearchAgendaIr(value.researchAgendaIr)
      || value.researchAgendaIrHash !== value.researchAgendaIr.researchAgendaIrHash
      || !verifyMachineProposedScientificClaimSet(value.proposal).valid
      || value.proposalHash !== value.proposal.machineProposedScientificClaimSetHash
      || !verifyResearchAgendaClaimBindingReceipt(
        value.researchAgendaClaimBindingReceipt,
        { researchAgendaIr: value.researchAgendaIr, proposal: value.proposal },
      ).valid
      || value.researchAgendaClaimBindingReceiptHash
        !== value.researchAgendaClaimBindingReceipt
          .researchAgendaClaimBindingReceiptHash
      || value.paperId !== value.researchAgendaIr.paperId
      || value.protocolFamily !== value.researchAgendaIr.protocolFamily
      || !same(value.dataRequirements, value.researchAgendaIr.dataRequirements)
      || !same(value.falsifiers, value.researchAgendaIr.falsifiers)
      || !same(value.resourceFeasibility, value.researchAgendaIr.resourceFeasibility)) {
      return false;
    }
    const empiricalClaim = empiricalClaimFromProposal(
      value.proposal,
      value.empiricalClaimKey,
    );
    if (!empiricalClaim || !same(empiricalClaim, value.empiricalClaimRecord)
      || hashRecord('AutonomousResearchClaimRecord', empiricalClaim)
        !== value.empiricalClaimRecordHash
      || value.empiricalClaimRecordHash
        !== value.researchAgendaClaimBindingReceipt.empiricalClaimRecordHash
      || hashRecord('ExperimentResearchDataRequirements', value.dataRequirements)
        !== value.dataRequirementsHash
      || hashRecord('ExperimentResearchEstimand', {
        estimand: value.dataRequirements.estimand,
      }) !== value.estimandHash
      || hashRecord('ExperimentResearchFalsifiers', value.falsifiers)
        !== value.falsifiersHash
      || hashRecord('ExperimentResearchResourceFeasibility', value.resourceFeasibility)
        !== value.resourceFeasibilityHash
      || !hasExactObjectKeys(value.executionBudget, EXECUTION_BUDGET_KEYS)
      || value.executionBudget.cpuBudgetSemantics
        !== SYSTEM_BENCHMARK_CPU_BUDGET_SEMANTICS
      || hashRecord('ExperimentResearchExecutionBudget', value.executionBudget)
        !== value.executionBudgetHash) return false;
    const compatibility = value.datasetCompatibility;
    if (!hasExactObjectKeys(compatibility, [
      ...DATASET_COMPATIBILITY_KEYS, 'datasetResearchCompatibilityHash',
    ]) || compatibility.version !== 1
      || compatibility.kind !== 'ExperimentDatasetResearchCompatibility'
      || compatibility.status !== 'experiment_dataset_research_compatibility_verified'
      || compatibility.compatible !== true
      || compatibility.schemaCompatibilityMode
        !== 'required-variable-subset-of-operator-signed-schema-v1') return false;
    const authority = validateOperatorDatasetAuthorityDocument(
      compatibility.operatorDatasetAuthority,
      {
        datasetName: compatibility.datasetName,
        datasetManifestHash: compatibility.datasetManifestHash,
      },
    );
    const semantics = authority.authority.researchSemantics;
    const { datasetResearchCompatibilityHash, ...compatibilityPayload } = compatibility;
    if (authority.authority.version !== 3 || !semantics
      || authority.operatorDatasetAuthorityDocumentHash
        !== compatibility.operatorDatasetAuthorityDocumentHash
      || researchSemanticsHash(semantics) !== compatibility.datasetResearchSemanticsHash
      || compatibility.datasetSplitManifestHash
        !== authority.authority.datasetSplitManifestHash
      || compatibility.datasetSplitIdentityHash !== compatibility.datasetSplitManifestHash
      || compatibility.population !== value.dataRequirements.population
      || compatibility.datasetPopulation !== value.dataRequirements.population
      || compatibility.intervention !== value.dataRequirements.intervention
      || compatibility.comparator !== value.dataRequirements.comparator
      || compatibility.estimand !== value.dataRequirements.estimand
      || !semantics.estimands.includes(value.dataRequirements.estimand)
      || value.dataRequirements.requiredVariables.some(
        (variable) => !semantics.variables.includes(variable),
      )
      || value.dataRequirements.datasetConstraints.some(
        (constraint) => !semantics.datasetConstraints.includes(constraint),
      )
      || !same(compatibility.requiredVariables, value.dataRequirements.requiredVariables)
      || !same(compatibility.authorizedVariables, semantics.variables)
      || !same(compatibility.datasetConstraints, value.dataRequirements.datasetConstraints)
      || !same(compatibility.eligibleSplits, semantics.eligibleSplits)
      || hashRecord('ExperimentDatasetResearchCompatibility', compatibilityPayload)
        !== datasetResearchCompatibilityHash
      || datasetResearchCompatibilityHash !== value.datasetResearchCompatibilityHash) {
      return false;
    }
    const expectedExecutionBudget = canonicalExecutionBudget({
      researchAgendaIr: value.researchAgendaIr,
      ...value.executionBudget,
      language: value.proposal?.protocolFamily === 'econometrics_panel_benchmark'
        || value.proposal?.protocolFamily === 'finance_asset_pricing_benchmark' ? 'r' : 'python',
    });
    if (!same(value.executionBudget, expectedExecutionBudget)) return false;
    const { experimentResearchBindingHash, ...payload } = value;
    return sha(experimentResearchBindingHash)
      && hashRecord('ExperimentResearchBinding', payload) === experimentResearchBindingHash;
  } catch { return false; }
}

export function experimentResearchBindingMatchesContext(value, {
  researchAgendaIr,
  proposal,
  researchAgendaClaimBindingReceipt,
} = {}) {
  return verifyExperimentResearchBinding(value)
    && same(value.researchAgendaIr, researchAgendaIr)
    && same(value.proposal, proposal)
    && same(value.researchAgendaClaimBindingReceipt, researchAgendaClaimBindingReceipt);
}

export function productionExperimentResearchBindingsMatch(left, right) {
  return verifyExperimentResearchBinding(left)
    && verifyExperimentResearchBinding(right)
    && left.experimentResearchBindingHash === right.experimentResearchBindingHash
    && left.researchAgendaIrHash === right.researchAgendaIrHash
    && left.researchAgendaClaimBindingReceiptHash
      === right.researchAgendaClaimBindingReceiptHash
    && left.empiricalClaimRecordHash === right.empiricalClaimRecordHash
    && left.datasetResearchCompatibilityHash === right.datasetResearchCompatibilityHash;
}
