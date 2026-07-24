import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  createAutonomousHypothesisGenerationReceipt,
} from './autonomous-research-proposal-contract.mjs';
import {
  verifyDynamicFormalClaimSeed,
} from '../research/dynamic-formal-claim-seed-contract.mjs';
import {
  verifyAgentExecutionReceiptProductionAuthorityBinding,
  verifyAutonomousResearchAgentProductionAuthorityBinding,
} from './autonomous-research-agent-production-authority-binding.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$/;
const REQUEST_KEYS = Object.freeze([
  'allowedProtocolFamilies', 'budgetReservationHash', 'idempotencyKey', 'kind',
  'maximumOutputTokens', 'maximumWallTimeMs', 'objective', 'paperId',
  'protocolFamily', 'requestHash', 'version',
]);
const AUTHORITY_BOUND_REQUEST_KEYS = Object.freeze([
  ...REQUEST_KEYS, 'productionAuthorityBinding',
]);
const PRODUCER_BOUND_REQUEST_KEYS = Object.freeze([
  ...REQUEST_KEYS, 'capabilityScopeManifestHash', 'dynamicFormalClaimsEnabled',
  'producerContractHash',
]);
const PRODUCER_AND_AUTHORITY_BOUND_REQUEST_KEYS = Object.freeze([
  ...PRODUCER_BOUND_REQUEST_KEYS, 'productionAuthorityBinding',
]);

function normalizedText(value, maximum = 8_000) {
  const text = String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  return text && text.length <= maximum ? text : null;
}

function canonicalId(value) {
  const candidate = String(value || '').trim();
  return SAFE_ID.test(candidate) ? candidate : null;
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

export function buildAutonomousResearchContentProductionRequest({
  paperId,
  objective,
  protocolFamily,
  allowedProtocolFamilies,
  productionAuthorityBinding = null,
  producerContractHash = null,
  dynamicFormalClaimsEnabled = false,
  capabilityScopeManifestHash = null,
  maximumOutputTokens = 4096,
  maximumWallTimeMs = 20 * 60 * 1000,
} = {}) {
  const selectedPaperId = canonicalId(paperId);
  const selectedObjective = normalizedText(objective);
  const selectedProtocolFamily = canonicalId(protocolFamily);
  const families = canonicalFamilies(allowedProtocolFamilies);
  const authorityBound = productionAuthorityBinding !== null;
  const producerBound = producerContractHash !== null;
  const selectedProducerContractHash = producerBound
    ? String(producerContractHash || '').toLowerCase() : null;
  const dynamicFormal = dynamicFormalClaimsEnabled === true;
  const selectedCapabilityScopeManifestHash = dynamicFormal
    ? String(capabilityScopeManifestHash || '').toLowerCase() : null;
  if (!selectedPaperId || !selectedObjective || !selectedProtocolFamily || !families
    || !families.includes(selectedProtocolFamily)
    || (producerBound && !SHA256.test(selectedProducerContractHash))
    || (producerBound && dynamicFormal
      && !SHA256.test(selectedCapabilityScopeManifestHash))
    || (producerBound && !dynamicFormal && capabilityScopeManifestHash !== null)
    || (!producerBound && (dynamicFormalClaimsEnabled === true
      || capabilityScopeManifestHash !== null))
    || (authorityBound
      && !verifyAutonomousResearchAgentProductionAuthorityBinding(
        productionAuthorityBinding,
      ))
    || !Number.isSafeInteger(maximumOutputTokens) || maximumOutputTokens < 512
    || maximumOutputTokens > 32_768
    || !Number.isSafeInteger(maximumWallTimeMs) || maximumWallTimeMs < 60_000
    || maximumWallTimeMs > 60 * 60 * 1000) {
    throw new Error('autonomous_research_content_production_request_invalid');
  }
  const requestSubject = Object.freeze({
    paperId: selectedPaperId,
    objective: selectedObjective,
    protocolFamily: selectedProtocolFamily,
    allowedProtocolFamilies: families,
    ...(authorityBound ? { productionAuthorityBinding } : {}),
    ...(producerBound ? {
      producerContractHash: selectedProducerContractHash,
      dynamicFormalClaimsEnabled: dynamicFormal,
      capabilityScopeManifestHash: selectedCapabilityScopeManifestHash,
    } : {}),
    maximumOutputTokens,
    maximumWallTimeMs,
  });
  const idempotencyKey = hashRecord('AutonomousResearchContentProductionIdempotency', requestSubject);
  const budgetReservationHash = hashRecord('AutonomousResearchContentProductionBudget', {
    idempotencyKey,
    maximumOutputTokens,
    maximumWallTimeMs,
  });
  const payload = {
    version: producerBound ? 3 : authorityBound ? 2 : 1,
    kind: 'AutonomousResearchContentProductionRequest',
    ...requestSubject,
    idempotencyKey,
    budgetReservationHash,
  };
  return Object.freeze({
    ...payload,
    requestHash: hashRecord('AutonomousResearchContentProductionRequest', payload),
  });
}

function agentReceiptValid(receipt) {
  const { agentExecutionReceiptHash: claimedHash, ...payload } = receipt || {};
  return SHA256.test(String(claimedHash || ''))
    && hashRecord('AgentExecutionReceipt', payload) === claimedHash
    && receipt.status === 'agent_execution_completed';
}

export function buildAutonomousResearchContentProductionReceipt({
  request,
  draft,
  agentExecutionReceipt,
  dynamicFormalClaimSeed = null,
  producerId,
  generatedAt,
} = {}) {
  if (!verifyAutonomousResearchContentProductionRequest(request)
    || !agentReceiptValid(agentExecutionReceipt)
    || (request?.productionAuthorityBinding
      && !verifyAgentExecutionReceiptProductionAuthorityBinding(
        agentExecutionReceipt,
        request.productionAuthorityBinding,
      ))
    || !canonicalId(producerId) || !canonicalInstant(generatedAt)) {
    throw new Error('autonomous_research_content_production_receipt_input_invalid');
  }
  const hypothesisReceipt = createAutonomousHypothesisGenerationReceipt({
    draft,
    principalId: agentExecutionReceipt.agentId || producerId,
    provider: agentExecutionReceipt.providerMode || 'configured-agent-provider',
    model: agentExecutionReceipt.resolvedModel || agentExecutionReceipt.model || null,
    externalActionPerformed: false,
    generatedAt,
  });
  const dynamicFormal = dynamicFormalClaimSeed !== null;
  if (request?.version === 3
    && dynamicFormal !== request.dynamicFormalClaimsEnabled) {
    throw new Error('autonomous_research_content_dynamic_formal_mode_mismatch');
  }
  const productionAuthorityBinding = request.productionAuthorityBinding || null;
  if (productionAuthorityBinding
    && producerId !== productionAuthorityBinding.authorPrincipalId) {
    throw new Error('autonomous_research_content_production_authority_mismatch');
  }
  const dynamicVerification = dynamicFormal
    ? verifyDynamicFormalClaimSeed(dynamicFormalClaimSeed, {
      claimKey: `${request.paperId}:formal-support:1`,
      generatorReceiptHash: agentExecutionReceipt.agentExecutionReceiptHash,
      ...(request?.version === 3 ? {
        capabilityScopeManifestHash: request.capabilityScopeManifestHash,
      } : {}),
    })
    : Object.freeze({ valid: true });
  if (!dynamicVerification.valid) {
    throw new Error('autonomous_research_content_dynamic_formal_claim_seed_invalid');
  }
  const payload = {
    version: request.version === 3 ? 5
      : productionAuthorityBinding
        ? dynamicFormal ? 4 : 3
        : dynamicFormal ? 2 : 1,
    kind: 'AutonomousResearchContentProductionReceipt',
    status: 'autonomous_research_content_production_verified',
    producerId,
    paperId: request.paperId,
    protocolFamily: request.protocolFamily,
    requestHash: request.requestHash,
    idempotencyKey: request.idempotencyKey,
    budgetReservationHash: request.budgetReservationHash,
    ...(request.version === 3 ? {
      producerContractHash: request.producerContractHash,
      dynamicFormalClaimsEnabled: request.dynamicFormalClaimsEnabled,
      capabilityScopeManifestHash: request.capabilityScopeManifestHash,
    } : {}),
    ...(productionAuthorityBinding ? { productionAuthorityBinding } : {}),
    maximumOutputTokens: request.maximumOutputTokens,
    maximumWallTimeMs: request.maximumWallTimeMs,
    outputHash: hypothesisReceipt.outputHash,
    ...(dynamicFormal ? {
      dynamicFormalClaimSeedHash: dynamicFormalClaimSeed.dynamicFormalClaimSeedHash,
    } : {}),
    agentExecutionReceiptHash: agentExecutionReceipt.agentExecutionReceiptHash,
    principalId: hypothesisReceipt.generatorPrincipalId,
    provider: hypothesisReceipt.provider,
    model: hypothesisReceipt.model,
    promptHash: agentExecutionReceipt.promptHash || null,
    withinBudget: true,
    humanApprovalPerformed: false,
    externalActionPerformed: false,
    generatedAt,
  };
  return Object.freeze({
    ...payload,
    autonomousResearchContentProductionReceiptHash:
      hashRecord('AutonomousResearchContentProductionReceipt', payload),
  });
}

export function verifyAutonomousResearchContentProductionRequest(request) {
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
    || request.kind !== 'AutonomousResearchContentProductionRequest') return false;
  try {
    const rebuilt = buildAutonomousResearchContentProductionRequest(request);
    return JSON.stringify(rebuilt) === JSON.stringify(request);
  } catch { return false; }
}

export function verifyAutonomousResearchContentProductionReceipt(receipt, {
  request,
  draft,
  agentExecutionReceipt,
  dynamicFormalClaimSeed = null,
} = {}) {
  const blockers = [];
  const { autonomousResearchContentProductionReceiptHash: claimedHash, ...payload } = receipt || {};
  if (!SHA256.test(String(claimedHash || ''))
    || hashRecord('AutonomousResearchContentProductionReceipt', payload) !== claimedHash) {
    blockers.push('autonomous_research_content_production_receipt_hash_invalid');
  }
  let rebuilt = null;
  try {
    rebuilt = buildAutonomousResearchContentProductionReceipt({
      request,
      draft,
      agentExecutionReceipt,
      dynamicFormalClaimSeed,
      producerId: receipt?.producerId,
      generatedAt: receipt?.generatedAt,
    });
  } catch {
    blockers.push('autonomous_research_content_production_receipt_rebuild_failed');
  }
  if (!rebuilt || JSON.stringify(rebuilt) !== JSON.stringify(receipt)) {
    blockers.push('autonomous_research_content_production_receipt_not_canonical');
  }
  const uniqueBlockers = Object.freeze([...new Set(blockers)]);
  return Object.freeze({
    valid: uniqueBlockers.length === 0,
    status: uniqueBlockers.length
      ? 'autonomous_research_content_production_verification_blocked'
      : 'autonomous_research_content_production_verification_verified',
    blockers: uniqueBlockers,
  });
}
