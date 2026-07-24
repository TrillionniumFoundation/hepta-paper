import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  verifyAutonomousResearchAgendaProductionReceipt,
} from './autonomous-research-agenda-production-contract.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$/;
const IR_KEYS = Object.freeze([
  'dataRequirements', 'falsifiers', 'formalTargets', 'kind', 'negativeBoundaries',
  'paperId', 'primaryClaim', 'priorArtQueryPlan', 'protocolFamily',
  'researchAgendaIrHash', 'researchQuestion', 'resourceFeasibility',
  'sourceAgendaProductionReceiptHash', 'venueConstraints', 'version',
]);

function text(value, maximum = 8_000) {
  const selected = String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  return selected && selected.length <= maximum ? selected : null;
}

function id(value) {
  const selected = String(value || '').trim();
  return ID.test(selected) ? selected : null;
}

function textList(values, { maximum = 64, itemMaximum = 2_000 } = {}) {
  if (!Array.isArray(values) || !values.length || values.length > maximum) return null;
  const selected = values.map((value) => text(value, itemMaximum));
  if (selected.some((value) => !value) || new Set(selected).size !== selected.length) return null;
  return Object.freeze(selected);
}

export function normalizePriorArtQueryPlan(values) {
  return textList(values, { maximum: 64, itemMaximum: 2_000 });
}

export function priorArtQueryPlanHash(values) {
  const queries = normalizePriorArtQueryPlan(values);
  return queries
    ? hashRecord('PriorArtQueryPlanV1', Object.freeze({ version: 1, queries }))
    : null;
}

function dataRequirements(value) {
  const payload = {
    population: text(value?.population),
    intervention: text(value?.intervention),
    comparator: text(value?.comparator),
    estimand: text(value?.estimand),
    requiredVariables: textList(value?.requiredVariables),
    datasetConstraints: textList(value?.datasetConstraints),
  };
  return Object.values(payload).every(Boolean) ? Object.freeze(payload) : null;
}

function resourceFeasibility(value) {
  const payload = {
    maximumWallTimeMs: Number(value?.maximumWallTimeMs),
    maximumMemoryBytes: Number(value?.maximumMemoryBytes),
    maximumCpuCount: Number(value?.maximumCpuCount),
    executionEnvironment: id(value?.executionEnvironment),
  };
  return Number.isSafeInteger(payload.maximumWallTimeMs) && payload.maximumWallTimeMs > 0
    && Number.isSafeInteger(payload.maximumMemoryBytes) && payload.maximumMemoryBytes > 0
    && Number.isSafeInteger(payload.maximumCpuCount) && payload.maximumCpuCount > 0
    && payload.executionEnvironment ? Object.freeze(payload) : null;
}

function venueConstraints(value) {
  const payload = {
    paperType: id(value?.paperType),
    requiredSections: textList(value?.requiredSections),
    artifactRequired: value?.artifactRequired === true,
    anonymousReviewRequired: value?.anonymousReviewRequired === true,
  };
  return payload.paperType && payload.requiredSections ? Object.freeze(payload) : null;
}

function inputFromIr(ir) {
  return {
    agendaProductionReceipt: {
      autonomousResearchAgendaProductionReceiptHash:
        ir.sourceAgendaProductionReceiptHash,
      paperId: ir.paperId,
      selectedProtocolFamily: ir.protocolFamily,
    },
    researchQuestion: ir.researchQuestion,
    primaryClaim: ir.primaryClaim,
    dataRequirements: ir.dataRequirements,
    falsifiers: ir.falsifiers,
    negativeBoundaries: ir.negativeBoundaries,
    formalTargets: ir.formalTargets,
    priorArtQueryPlan: ir.priorArtQueryPlan,
    venueConstraints: ir.venueConstraints,
    resourceFeasibility: ir.resourceFeasibility,
    skipSourceVerification: true,
  };
}

export function buildResearchAgendaIr({
  agendaProductionReceipt,
  researchQuestion,
  primaryClaim,
  dataRequirements: selectedDataRequirements,
  falsifiers,
  negativeBoundaries,
  formalTargets,
  priorArtQueryPlan,
  venueConstraints: selectedVenueConstraints,
  resourceFeasibility: selectedResourceFeasibility,
  skipSourceVerification = false,
} = {}) {
  if (!skipSourceVerification
    && !verifyAutonomousResearchAgendaProductionReceipt(agendaProductionReceipt).valid) {
    throw new Error('research_agenda_ir_source_receipt_invalid');
  }
  const payload = {
    version: 1,
    kind: 'ResearchAgendaIR',
    paperId: id(agendaProductionReceipt?.paperId),
    sourceAgendaProductionReceiptHash:
      String(agendaProductionReceipt?.autonomousResearchAgendaProductionReceiptHash || ''),
    protocolFamily: id(agendaProductionReceipt?.selectedProtocolFamily),
    researchQuestion: text(researchQuestion),
    primaryClaim: text(primaryClaim),
    dataRequirements: dataRequirements(selectedDataRequirements),
    falsifiers: textList(falsifiers),
    negativeBoundaries: textList(negativeBoundaries),
    formalTargets: textList(formalTargets),
    priorArtQueryPlan: normalizePriorArtQueryPlan(priorArtQueryPlan),
    venueConstraints: venueConstraints(selectedVenueConstraints),
    resourceFeasibility: resourceFeasibility(selectedResourceFeasibility),
  };
  if (!payload.paperId || !SHA256.test(payload.sourceAgendaProductionReceiptHash)
    || !payload.protocolFamily || Object.values(payload).some((value) => value === null)) {
    throw new Error('research_agenda_ir_invalid');
  }
  return Object.freeze({
    ...payload,
    researchAgendaIrHash: hashRecord('ResearchAgendaIR', payload),
  });
}

export function verifyResearchAgendaIr(ir, { agendaProductionReceipt = null } = {}) {
  if (!hasExactObjectKeys(ir, IR_KEYS) || ir?.version !== 1
    || ir?.kind !== 'ResearchAgendaIR') return false;
  let rebuilt = null;
  try { rebuilt = buildResearchAgendaIr(inputFromIr(ir)); } catch { return false; }
  if (JSON.stringify(rebuilt) !== JSON.stringify(ir)) return false;
  return agendaProductionReceipt === null || (
    verifyAutonomousResearchAgendaProductionReceipt(agendaProductionReceipt).valid
    && ir.sourceAgendaProductionReceiptHash
      === agendaProductionReceipt.autonomousResearchAgendaProductionReceiptHash
    && ir.paperId === agendaProductionReceipt.paperId
    && ir.protocolFamily === agendaProductionReceipt.selectedProtocolFamily
  );
}
