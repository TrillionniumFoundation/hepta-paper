import {
  OUTPUT_MODES,
  PRODUCT_LINE_IDS,
  canonicalProductLineId,
  normalizeText,
} from './contracts.mjs';
import { digest } from './hash-utils.mjs';

export const PRODUCT_ROUTER_VERSION = 2;

const PRODUCT_LINE_VALUES = new Set(Object.values(PRODUCT_LINE_IDS));

const PRODUCT_LINE_OUTPUT_MODES = Object.freeze({
  [PRODUCT_LINE_IDS.VECTORIZATION]: OUTPUT_MODES.VECTOR_PACKAGE,
  [PRODUCT_LINE_IDS.LOGO_BRAND]: OUTPUT_MODES.IMAGE_SET,
  [PRODUCT_LINE_IDS.PACKAGING_DESIGN]: OUTPUT_MODES.IMAGE_SET,
  [PRODUCT_LINE_IDS.CATALOG_BROCHURE]: OUTPUT_MODES.PDF_DECK,
  [PRODUCT_LINE_IDS.PRESENTATION_DECK]: OUTPUT_MODES.PDF_DECK,
  [PRODUCT_LINE_IDS.PROPOSAL_BOARD]: OUTPUT_MODES.PDF_DECK,
  [PRODUCT_LINE_IDS.POSTER_DESIGN]: OUTPUT_MODES.IMAGE_SET,
  [PRODUCT_LINE_IDS.NAMING_TEXT]: OUTPUT_MODES.TEXT_FORM,
  [PRODUCT_LINE_IDS.PRODUCT_DESIGN]: OUTPUT_MODES.IMAGE_SET,
  [PRODUCT_LINE_IDS.ACCEPTANCE_DELIVERY]: OUTPUT_MODES.MIXED,
  [PRODUCT_LINE_IDS.HUMAN_FEEDBACK]: OUTPUT_MODES.MIXED,
  [PRODUCT_LINE_IDS.GENERIC_DESIGN]: OUTPUT_MODES.MIXED,
});

export function outputModeForProductLine(productLineId, fallback = OUTPUT_MODES.MIXED) {
  const id = canonicalProductLineId(productLineId);
  return PRODUCT_LINE_OUTPUT_MODES[id] || fallback;
}

function knownProductLine(value) {
  const id = normalizeText(value);
  const canonical = canonicalProductLineId(id);
  return PRODUCT_LINE_VALUES.has(id) || PRODUCT_LINE_VALUES.has(canonical) ? canonical : null;
}

function normalizedConfidence(value, fallback = 0.5) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.min(1, number));
}

function routeEvidenceHash(input = {}) {
  return digest({
    kind: 'ProductRouteDecisionEvidence',
    channelId: normalizeText(input.channelId || '') || null,
    taskKey: normalizeText(input.taskKey || input.externalId || '') || null,
    title: normalizeText(input.title || input.taskTitle || input.task_title || '') || null,
    category: normalizeText(input.categoryTitle || input.category || input.rawCategory || '') || null,
  });
}

function candidateFrom(value, source, evidence = {}) {
  const productLineId = knownProductLine(value);
  if (!productLineId) return null;
  return {
    productLineId,
    outputMode: evidence.outputMode || outputModeForProductLine(productLineId),
    confidence: normalizedConfidence(evidence.confidence, evidence.defaultConfidence ?? 0.92),
    source,
    matchedRule: productLineId,
    reasons: evidence.reasons || [source],
    warnings: evidence.warnings || [],
    routeAuthority: evidence.routeAuthority || source,
    routeDecisionHash: evidence.routeDecisionHash || null,
  };
}

function semanticRouteCandidates(input = {}) {
  const semantic = input.semanticRoute
    || input.agentRoute
    || input.modelRoute
    || input.routeDecision
    || input.routeContract
    || input.semanticContract?.route
    || input.semanticContract?.routeContract
    || input.semanticContract
    || input.semantic?.route
    || input.semantic?.routeContract
    || input.semantic
    || {};
  return [
    candidateFrom(input.semanticProductLineId, 'agent_semantic_product_line', {
      confidence: input.semanticProductLineConfidence,
      routeAuthority: 'agent_semantic_intake',
      routeDecisionHash: input.semanticProductLineHash,
    }),
    candidateFrom(input.agentProductLineId, 'agent_product_line', {
      confidence: input.agentProductLineConfidence,
      routeAuthority: 'agent_semantic_intake',
      routeDecisionHash: input.agentProductLineHash,
    }),
    candidateFrom(input.modelProductLineId, 'model_product_line', {
      confidence: input.modelProductLineConfidence,
      routeAuthority: 'llm_semantic_intake',
      routeDecisionHash: input.modelProductLineHash,
    }),
    candidateFrom(semantic.productLineId || semantic.workflowId || semantic.kind, 'semantic_route_contract', {
      confidence: semantic.confidence ?? semantic.productLineConfidence ?? semantic.routeConfidence,
      outputMode: semantic.outputMode,
      reasons: ['semantic_route_contract'],
      warnings: semantic.warnings || [],
      routeAuthority: semantic.selectionAuthority || semantic.source || 'agent_semantic_intake',
      routeDecisionHash: semantic.routeDecisionHash || semantic.routeContractHash || semantic.semanticContractHash || null,
    }),
  ].filter(Boolean);
}

function explicitRouteCandidates(input = {}) {
  return [
    candidateFrom(input.productLineId, 'explicit_product_line', {
      defaultConfidence: 1,
      routeAuthority: 'explicit_structured_metadata',
    }),
    candidateFrom(input.kind, 'explicit_kind', {
      defaultConfidence: 1,
      routeAuthority: 'explicit_structured_metadata',
    }),
    candidateFrom(input.workflowId, 'explicit_workflow_id', {
      defaultConfidence: 1,
      routeAuthority: 'explicit_structured_metadata',
    }),
  ].filter(Boolean);
}

function routeDecision(candidate, input = {}) {
  return {
    version: PRODUCT_ROUTER_VERSION,
    productLineId: candidate.productLineId,
    outputMode: candidate.outputMode || outputModeForProductLine(candidate.productLineId),
    confidence: candidate.confidence,
    source: candidate.source,
    matchedRule: candidate.matchedRule,
    routeAuthority: candidate.routeAuthority,
    routeDecisionHash: candidate.routeDecisionHash,
    evidenceHash: routeEvidenceHash(input),
    reasons: candidate.reasons,
    warnings: candidate.warnings,
    safety: {
      textRegexRoutingEnabled: false,
      textKeywordRoutingEnabled: false,
      agentSemanticRouteRequired: true,
      executesExternalAction: false,
    },
  };
}

export function routeProductLine(input = {}) {
  const explicit = explicitRouteCandidates(input)[0];
  if (explicit) return routeDecision(explicit, input);

  const semantic = semanticRouteCandidates(input)[0];
  if (semantic) return routeDecision(semantic, input);

  return {
    version: PRODUCT_ROUTER_VERSION,
    productLineId: PRODUCT_LINE_IDS.GENERIC_DESIGN,
    outputMode: outputModeForProductLine(PRODUCT_LINE_IDS.GENERIC_DESIGN),
    confidence: 0,
    source: 'agent_semantic_route_required',
    matchedRule: null,
    routeAuthority: null,
    routeDecisionHash: null,
    evidenceHash: routeEvidenceHash(input),
    reasons: ['missing_explicit_or_agent_semantic_product_line'],
    warnings: [
      'regex_text_routing_disabled',
      'keyword_text_routing_disabled',
      'agent_semantic_product_line_required',
    ],
    safety: {
      textRegexRoutingEnabled: false,
      textKeywordRoutingEnabled: false,
      agentSemanticRouteRequired: true,
      executesExternalAction: false,
    },
  };
}
