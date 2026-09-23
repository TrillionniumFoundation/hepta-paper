import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  verifyAgentExecutionReceiptProductionAuthorityBinding,
  verifyAutonomousResearchAgentProductionAuthorityBinding,
} from './autonomous-research-agent-production-authority-binding.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$/;
const REQUEST_KEYS = Object.freeze([
  'allowedProtocolFamilies', 'budgetReservationHash', 'datasetAuthorityProtocolFamily',
  'idempotencyKey', 'kind', 'maximumOutputTokens', 'maximumWallTimeMs', 'objectiveHint',
  'paperId', 'protocolFamilyHint', 'requestHash', 'version',
]);
const AUTHORITY_BOUND_REQUEST_KEYS = Object.freeze([
  ...REQUEST_KEYS, 'productionAuthorityBinding',
]);
const PRODUCER_BOUND_REQUEST_KEYS = Object.freeze([
  ...REQUEST_KEYS, 'producerContractHash',
]);
const PRODUCER_AND_AUTHORITY_BOUND_REQUEST_KEYS = Object.freeze([
  ...PRODUCER_BOUND_REQUEST_KEYS, 'productionAuthorityBinding',
]);
const RECEIPT_KEYS = Object.freeze([
  'agentExecutionReceiptHash', 'allowedProtocolFamilies',
  'autonomousResearchAgendaProductionReceiptHash', 'budgetReservationHash',
  'datasetAuthorityProtocolFamily', 'externalActionPerformed', 'generatedAt',
  'humanApprovalPerformed', 'idempotencyKey', 'kind', 'maximumOutputTokens',
  'maximumWallTimeMs', 'model', 'outputHash', 'paperId', 'principalId', 'producerId',
  'promptHash', 'provider', 'requestHash', 'scientificNoveltyVerified',
  'selectedObjective', 'selectedProtocolFamily', 'status', 'version', 'withinBudget',
]);
const AUTHORITY_BOUND_RECEIPT_KEYS = Object.freeze([
  ...RECEIPT_KEYS, 'productionAuthorityBinding',
]);
const PRODUCER_BOUND_RECEIPT_KEYS = Object.freeze([
  ...RECEIPT_KEYS, 'producerContractHash',
]);
const PRODUCER_AND_AUTHORITY_BOUND_RECEIPT_KEYS = Object.freeze([
  ...PRODUCER_BOUND_RECEIPT_KEYS, 'productionAuthorityBinding',
]);

function canonicalId(value) {
  const candidate = String(value || '').trim();
  return SAFE_ID.test(candidate) ? candidate : null;
}

function canonicalText(value, maximum = 8_000) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).normalize('NFKC').replace(/\s+/g, ' ').trim();
  return text && text.length <= maximum ? text : null;
}

function canonicalInstant(value) {
  const instant = String(value || '');
  const parsed = Date.parse(instant);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === instant ? instant : null;
}

function canonicalFamilies(values) {
  if (!Array.isArray(values) || !values.length || values.length > 128) return null;
  const families = values.map(canonicalId);
  if (families.some((family) => !family) || new Set(families).size !== families.length) return null;
  return Object.freeze([...families].sort());
}

function agentReceiptValid(receipt) {
  const { agentExecutionReceiptHash: claimedHash, ...payload } = receipt || {};
  return SHA256.test(String(claimedHash || ''))
    && hashRecord('AgentExecutionReceipt', payload) === claimedHash
    && receipt.status === 'agent_execution_completed';
}

export function buildAutonomousResearchAgendaProductionRequest({
  paperId,
  objectiveHint = null,
  protocolFamilyHint = null,
  datasetAuthorityProtocolFamily = null,
  allowedProtocolFamilies,
  productionAuthorityBinding = null,
  producerContractHash = null,
  maximumOutputTokens = 2048,
  maximumWallTimeMs = 20 * 60 * 1000,
} = {}) {
  const selectedPaperId = canonicalId(paperId);
  const selectedObjectiveHint = canonicalText(objectiveHint);
  const selectedProtocolFamilyHint = protocolFamilyHint ? canonicalId(protocolFamilyHint) : null;
  const selectedDatasetFamily = datasetAuthorityProtocolFamily
    ? canonicalId(datasetAuthorityProtocolFamily) : null;
  const families = canonicalFamilies(allowedProtocolFamilies);
  const authorityBound = productionAuthorityBinding !== null;
  const producerBound = producerContractHash !== null;
  const selectedProducerContractHash = producerBound
    ? String(producerContractHash || '').toLowerCase() : null;
  if (!selectedPaperId || !families
    || (objectiveHint && !selectedObjectiveHint)
    || (protocolFamilyHint && !selectedProtocolFamilyHint)
    || (datasetAuthorityProtocolFamily && !selectedDatasetFamily)
    || (selectedProtocolFamilyHint && !families.includes(selectedProtocolFamilyHint))
    || (selectedDatasetFamily && !families.includes(selectedDatasetFamily))
    || (producerBound && !SHA256.test(selectedProducerContractHash))
    || (authorityBound
      && !verifyAutonomousResearchAgentProductionAuthorityBinding(
        productionAuthorityBinding,
      ))
    || !Number.isSafeInteger(maximumOutputTokens) || maximumOutputTokens < 512
    || maximumOutputTokens > 16_384
    || !Number.isSafeInteger(maximumWallTimeMs) || maximumWallTimeMs < 60_000
    || maximumWallTimeMs > 60 * 60 * 1000) {
    throw new Error('autonomous_research_agenda_production_request_invalid');
  }
  const subject = Object.freeze({
    paperId: selectedPaperId,
    objectiveHint: selectedObjectiveHint,
    protocolFamilyHint: selectedProtocolFamilyHint,
    datasetAuthorityProtocolFamily: selectedDatasetFamily,
    allowedProtocolFamilies: families,
    ...(authorityBound ? { productionAuthorityBinding } : {}),
    ...(producerBound ? { producerContractHash: selectedProducerContractHash } : {}),
    maximumOutputTokens,
    maximumWallTimeMs,
  });
  const idempotencyKey = hashRecord('AutonomousResearchAgendaProductionIdempotency', subject);
  const budgetReservationHash = hashRecord('AutonomousResearchAgendaProductionBudget', {
    idempotencyKey,
    maximumOutputTokens,
    maximumWallTimeMs,
  });
  const payload = {
    version: producerBound ? 3 : authorityBound ? 2 : 1,
    kind: 'AutonomousResearchAgendaProductionRequest',
    ...subject,
    idempotencyKey,
    budgetReservationHash,
  };
  return Object.freeze({
    ...payload,
    requestHash: hashRecord('AutonomousResearchAgendaProductionRequest', payload),
  });
}

export function verifyAutonomousResearchAgendaProductionRequest(request) {
  const authorityBound = request?.productionAuthorityBinding !== undefined;
  const producerBound = request?.version === 3;
  const expectedKeys = producerBound
    ? authorityBound
      ? PRODUCER_AND_AUTHORITY_BOUND_REQUEST_KEYS
      : PRODUCER_BOUND_REQUEST_KEYS
    : authorityBound ? AUTHORITY_BOUND_REQUEST_KEYS : REQUEST_KEYS;
  if (!hasExactObjectKeys(
    request,
    expectedKeys,
  )
    || ![1, 2, 3].includes(request?.version)
    || (request?.version === 1 && authorityBound)
    || (request?.version === 2 && !authorityBound)
    || request.kind !== 'AutonomousResearchAgendaProductionRequest') return false;
  try {
    return JSON.stringify(buildAutonomousResearchAgendaProductionRequest(request))
      === JSON.stringify(request);
  } catch { return false; }
}

export function buildAutonomousResearchAgendaProductionReceipt({
  request,
  selectedObjective,
  selectedProtocolFamily,
  agentExecutionReceipt,
  producerId,
  generatedAt,
} = {}) {
  const objective = canonicalText(selectedObjective);
  const family = canonicalId(selectedProtocolFamily);
  const selectedProducerId = canonicalId(producerId);
  const selectedInstant = canonicalInstant(generatedAt);
  const productionAuthorityBinding = request?.productionAuthorityBinding || null;
  if (!verifyAutonomousResearchAgendaProductionRequest(request)
    || !objective || !family || !request.allowedProtocolFamilies.includes(family)
    || (request.datasetAuthorityProtocolFamily
      && family !== request.datasetAuthorityProtocolFamily)
    || !agentReceiptValid(agentExecutionReceipt)
    || (request?.productionAuthorityBinding
      && !verifyAgentExecutionReceiptProductionAuthorityBinding(
        agentExecutionReceipt,
        productionAuthorityBinding,
      ))
    || (productionAuthorityBinding
      && selectedProducerId !== productionAuthorityBinding.authorPrincipalId)
    || !selectedProducerId || !selectedInstant) {
    throw new Error('autonomous_research_agenda_production_receipt_input_invalid');
  }
  const payload = {
    version: request.version === 3 ? 3 : request.version === 2 ? 2 : 1,
    kind: 'AutonomousResearchAgendaProductionReceipt',
    status: 'autonomous_research_agenda_production_verified',
    producerId: selectedProducerId,
    paperId: request.paperId,
    requestHash: request.requestHash,
    idempotencyKey: request.idempotencyKey,
    budgetReservationHash: request.budgetReservationHash,
    ...(request.version === 3 ? {
      producerContractHash: request.producerContractHash,
    } : {}),
    maximumOutputTokens: request.maximumOutputTokens,
    maximumWallTimeMs: request.maximumWallTimeMs,
    allowedProtocolFamilies: request.allowedProtocolFamilies,
    datasetAuthorityProtocolFamily: request.datasetAuthorityProtocolFamily,
    ...(productionAuthorityBinding ? { productionAuthorityBinding } : {}),
    selectedObjective: objective,
    selectedProtocolFamily: family,
    outputHash: hashRecord('AutonomousResearchAgendaProductionOutput', {
      selectedObjective: objective,
      selectedProtocolFamily: family,
    }),
    agentExecutionReceiptHash: agentExecutionReceipt.agentExecutionReceiptHash,
    principalId: agentExecutionReceipt.agentId || selectedProducerId,
    provider: agentExecutionReceipt.providerMode || 'configured-agent-provider',
    model: agentExecutionReceipt.resolvedModel || agentExecutionReceipt.model || null,
    promptHash: agentExecutionReceipt.promptHash || null,
    withinBudget: true,
    humanApprovalPerformed: false,
    scientificNoveltyVerified: false,
    externalActionPerformed: false,
    generatedAt: selectedInstant,
  };
  return Object.freeze({
    ...payload,
    autonomousResearchAgendaProductionReceiptHash:
      hashRecord('AutonomousResearchAgendaProductionReceipt', payload),
  });
}

export function verifyAutonomousResearchAgendaProductionReceipt(receipt, {
  request = null,
  agentExecutionReceipt = null,
} = {}) {
  const blockers = [];
  const { autonomousResearchAgendaProductionReceiptHash: claimedHash, ...payload } = receipt || {};
  const families = canonicalFamilies(receipt?.allowedProtocolFamilies);
  const authorityBound = receipt?.productionAuthorityBinding !== undefined;
  const producerBound = receipt?.version === 3;
  const expectedKeys = producerBound
    ? authorityBound
      ? PRODUCER_AND_AUTHORITY_BOUND_RECEIPT_KEYS
      : PRODUCER_BOUND_RECEIPT_KEYS
    : authorityBound ? AUTHORITY_BOUND_RECEIPT_KEYS : RECEIPT_KEYS;
  if (!hasExactObjectKeys(
    receipt,
    expectedKeys,
  )
    || ![1, 2, 3].includes(receipt?.version)
    || (receipt?.version === 1 && authorityBound)
    || (receipt?.version === 2 && !authorityBound)
    || receipt?.kind !== 'AutonomousResearchAgendaProductionReceipt'
    || !SHA256.test(String(claimedHash || ''))
    || hashRecord('AutonomousResearchAgendaProductionReceipt', payload) !== claimedHash
    || receipt?.status !== 'autonomous_research_agenda_production_verified'
    || receipt?.withinBudget !== true
    || receipt?.humanApprovalPerformed !== false
    || receipt?.scientificNoveltyVerified !== false
    || !canonicalId(receipt?.producerId) || !canonicalId(receipt?.paperId)
    || !canonicalId(receipt?.principalId) || !canonicalText(receipt?.provider, 160)
    || !canonicalText(receipt?.selectedObjective)
    || !canonicalId(receipt?.selectedProtocolFamily)
    || !canonicalInstant(receipt?.generatedAt)
    || !families
    || JSON.stringify(families) !== JSON.stringify(receipt?.allowedProtocolFamilies)
    || !families.includes(receipt?.selectedProtocolFamily)
    || !SHA256.test(String(receipt?.requestHash || ''))
    || !SHA256.test(String(receipt?.idempotencyKey || ''))
    || !SHA256.test(String(receipt?.budgetReservationHash || ''))
    || (producerBound && !SHA256.test(String(receipt?.producerContractHash || '')))
    || !SHA256.test(String(receipt?.outputHash || ''))
    || receipt.outputHash !== hashRecord('AutonomousResearchAgendaProductionOutput', {
      selectedObjective: receipt.selectedObjective,
      selectedProtocolFamily: receipt.selectedProtocolFamily,
    })
    || !SHA256.test(String(receipt?.agentExecutionReceiptHash || ''))
    || (receipt?.promptHash !== null && !SHA256.test(String(receipt.promptHash || '')))
    || !Number.isSafeInteger(receipt?.maximumOutputTokens)
    || !Number.isSafeInteger(receipt?.maximumWallTimeMs)
    || receipt?.externalActionPerformed !== false
    || (authorityBound
      && !verifyAutonomousResearchAgentProductionAuthorityBinding(
        receipt?.productionAuthorityBinding,
      ))
    || (authorityBound && (
      receipt?.producerId !== receipt.productionAuthorityBinding.authorPrincipalId
      || receipt?.principalId !== receipt.productionAuthorityBinding.authorPrincipalId
      || receipt?.provider !== receipt.productionAuthorityBinding.authorProvider
      || receipt?.model !== receipt.productionAuthorityBinding.authorModel
    ))
    || (receipt?.datasetAuthorityProtocolFamily
      && receipt.datasetAuthorityProtocolFamily !== receipt.selectedProtocolFamily)) {
    blockers.push('autonomous_research_agenda_production_receipt_invalid');
  }
  if (request && agentExecutionReceipt) {
    let rebuilt = null;
    try {
      rebuilt = buildAutonomousResearchAgendaProductionReceipt({
        request,
        selectedObjective: receipt?.selectedObjective,
        selectedProtocolFamily: receipt?.selectedProtocolFamily,
        agentExecutionReceipt,
        producerId: receipt?.producerId,
        generatedAt: receipt?.generatedAt,
      });
    } catch {
      blockers.push('autonomous_research_agenda_production_receipt_rebuild_failed');
    }
    if (!rebuilt || JSON.stringify(rebuilt) !== JSON.stringify(receipt)) {
      blockers.push('autonomous_research_agenda_production_receipt_not_canonical');
    }
  }
  const uniqueBlockers = Object.freeze([...new Set(blockers)]);
  return Object.freeze({
    valid: uniqueBlockers.length === 0,
    status: uniqueBlockers.length
      ? 'autonomous_research_agenda_production_verification_blocked'
      : 'autonomous_research_agenda_production_verification_verified',
    blockers: uniqueBlockers,
  });
}
