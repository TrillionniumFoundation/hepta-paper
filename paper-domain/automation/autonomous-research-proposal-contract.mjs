import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { normalizeText, uniqueStrings } from '../../workflow-kernel/runtime/text-utils.mjs';
import { hasExactObjectKeys as exactKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { ANALYSIS_PROTOCOL_FAMILY_PROFILES } from './analysis-protocol-contract.mjs';
import {
  AUTONOMOUS_EMPIRICAL_PLUGIN_PROTOCOL_FAMILIES,
} from './autonomous-empirical-family-plugin-registry.mjs';
import {
  AUTONOMOUS_FORMAL_MANUSCRIPT_PROOF,
  AUTONOMOUS_FORMAL_SUPPORT_TEMPLATE_REGISTRY,
  resolveAutonomousFormalSupportTemplateForClaim,
  selectAutonomousFormalSupportTemplate,
} from './autonomous-formal-support-registry.mjs';
import {
  verifyDynamicFormalClaimSeed,
} from '../research/dynamic-formal-claim-seed-contract.mjs';
import {
  verifyAutonomousResearchAgendaProductionReceipt,
} from './autonomous-research-agenda-production-contract.mjs';

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const PLACEHOLDER = /\b(?:TODO|TBD|placeholder|fill[ -]?in)\b/i;
const AGENDA_VERSION = 1;
const AGENDA_FAMILIES = AUTONOMOUS_EMPIRICAL_PLUGIN_PROTOCOL_FAMILIES;
// Compatibility-only export. Autonomous selection always uses the exact protocol family.
export const AUTONOMOUS_FORMAL_SUPPORT_TEMPLATE =
  selectAutonomousFormalSupportTemplate('ml_algorithm_benchmark');
export { AUTONOMOUS_FORMAL_MANUSCRIPT_PROOF };

function requiredText(value, field, maximum = 8_000) {
  const text = normalizeText(value);
  if (!text || text.length > maximum || PLACEHOLDER.test(text)) {
    throw new Error(`autonomous_research_${field}_invalid`);
  }
  return text;
}

function requiredList(value, field, limit = 16) {
  if (!Array.isArray(value) || value.length === 0 || value.length > limit
    || value.some((item) => typeof item !== 'string')) {
    throw new Error(`autonomous_research_${field}_invalid`);
  }
  const normalized = uniqueStrings(value, limit);
  if (normalized.length !== value.length
    || normalized.some((item) => item.length > 2_000 || PLACEHOLDER.test(item))) {
    throw new Error(`autonomous_research_${field}_invalid`);
  }
  return Object.freeze(normalized);
}

function normalizedDraft(draft) {
  if (!exactKeys(draft, ['empiricalHypothesis', 'formalSupportClaim'])
    || !exactKeys(draft?.empiricalHypothesis, [
      'statement', 'assumptions', 'quantifiers', 'negativeBoundaries', 'empiricalObligations',
    ])
    || !exactKeys(draft?.formalSupportClaim, [
      'statement', 'assumptions', 'quantifiers', 'negativeBoundaries', 'proofObligations',
    ])) throw new Error('autonomous_research_hypothesis_draft_shape_invalid');
  const normalized = Object.freeze({
    empiricalHypothesis: Object.freeze({
      statement: requiredText(draft.empiricalHypothesis.statement, 'empirical_claim_statement'),
      assumptions: requiredList(draft.empiricalHypothesis.assumptions, 'empirical_claim_assumptions'),
      quantifiers: requiredList(draft.empiricalHypothesis.quantifiers, 'empirical_claim_quantifiers'),
      negativeBoundaries: requiredList(
        draft.empiricalHypothesis.negativeBoundaries,
        'empirical_claim_negative_boundaries',
      ),
      empiricalObligations: requiredList(
        draft.empiricalHypothesis.empiricalObligations,
        'empirical_claim_obligations',
      ),
    }),
    formalSupportClaim: Object.freeze({
      statement: requiredText(draft.formalSupportClaim.statement, 'formal_claim_statement'),
      assumptions: requiredList(draft.formalSupportClaim.assumptions, 'formal_claim_assumptions'),
      quantifiers: requiredList(draft.formalSupportClaim.quantifiers, 'formal_claim_quantifiers'),
      negativeBoundaries: requiredList(
        draft.formalSupportClaim.negativeBoundaries,
        'formal_claim_negative_boundaries',
      ),
      proofObligations: requiredList(draft.formalSupportClaim.proofObligations, 'formal_claim_obligations'),
    }),
  });
  return normalized;
}

function hypothesisDraftHash(draft) {
  return hashRecord('AutonomousResearchHypothesisDraft', normalizedDraft(draft));
}

export function selectDeterministicAutonomousResearchAgenda({
  paperId,
  objective = null,
  protocolFamily = null,
  datasetAuthorityProtocolFamily = null,
  selectedAt = null,
} = {}) {
  const normalizedPaperId = requiredText(paperId, 'paper_id', 160);
  if (!IDENTIFIER.test(normalizedPaperId)) throw new Error('autonomous_research_paper_id_invalid');
  const familyOverride = normalizeText(protocolFamily) || null;
  if (familyOverride && !AGENDA_FAMILIES.includes(familyOverride)) {
    throw new Error('autonomous_research_protocol_family_unsupported');
  }
  const datasetFamily = normalizeText(datasetAuthorityProtocolFamily) || null;
  if (datasetFamily && !AGENDA_FAMILIES.includes(datasetFamily)) {
    throw new Error('autonomous_research_dataset_protocol_family_unsupported');
  }
  const selectorHash = hashRecord('AutonomousResearchAgendaSelector', {
    version: AGENDA_VERSION,
    paperId: normalizedPaperId,
  });
  const datasetAuthorityConstrainedSelection = !familyOverride && Boolean(datasetFamily);
  const selectedProtocolFamily = familyOverride || datasetFamily
    || AGENDA_FAMILIES[Number.parseInt(selectorHash.slice(-8), 16) % AGENDA_FAMILIES.length];
  const objectiveOverride = normalizeText(objective) || null;
  const selectedObjective = objectiveOverride || [
    'Evaluate a deterministic bounded candidate intervention under the fixed',
    `${selectedProtocolFamily} protocol, including treatment, control, ablation, and an isolated deterministic rerun.`,
  ].join(' ');
  const payload = {
    version: 1,
    kind: 'AutonomousResearchAgendaSelectionReceipt',
    status: 'autonomous_research_agenda_selected',
    agendaId: 'hepta-bounded-research-agenda-v1',
    agendaVersion: AGENDA_VERSION,
    paperId: normalizedPaperId,
    selectedObjective: requiredText(selectedObjective, 'objective'),
    selectedProtocolFamily,
    objectiveOverrideUsed: Boolean(objectiveOverride),
    protocolFamilyOverrideUsed: Boolean(familyOverride),
    datasetAuthorityConstrainedSelection,
    machineSelectionPerformed: !objectiveOverride || !familyOverride,
    scientificNoveltyVerified: false,
    selectedAt: selectedAt || null,
  };
  return Object.freeze({
    ...payload,
    autonomousResearchAgendaSelectionReceiptHash:
      hashRecord('AutonomousResearchAgendaSelectionReceipt', payload),
  });
}

export function selectMachineGeneratedAutonomousResearchAgenda({
  paperId,
  researchAgendaProducerReceipt,
  selectedAt = null,
} = {}) {
  const normalizedPaperId = requiredText(paperId, 'paper_id', 160);
  if (!IDENTIFIER.test(normalizedPaperId)
    || !verifyAutonomousResearchAgendaProductionReceipt(researchAgendaProducerReceipt).valid
    || researchAgendaProducerReceipt.paperId !== normalizedPaperId) {
    throw new Error('autonomous_research_machine_agenda_receipt_invalid');
  }
  const payload = {
    version: 2,
    kind: 'AutonomousResearchAgendaSelectionReceipt',
    status: 'autonomous_research_agenda_selected',
    agendaId: 'hepta-machine-generated-research-agenda-v1',
    agendaVersion: 1,
    paperId: normalizedPaperId,
    selectedObjective: requiredText(
      researchAgendaProducerReceipt.selectedObjective,
      'objective',
    ),
    selectedProtocolFamily: researchAgendaProducerReceipt.selectedProtocolFamily,
    objectiveOverrideUsed: false,
    protocolFamilyOverrideUsed: false,
    datasetAuthorityConstrainedSelection:
      Boolean(researchAgendaProducerReceipt.datasetAuthorityProtocolFamily),
    machineSelectionPerformed: true,
    scientificNoveltyVerified: false,
    agendaMode: 'machine-generated',
    researchAgendaProducerReceipt,
    selectedAt: selectedAt || researchAgendaProducerReceipt.generatedAt,
  };
  if (!AGENDA_FAMILIES.includes(payload.selectedProtocolFamily)) {
    throw new Error('autonomous_research_protocol_family_unsupported');
  }
  return Object.freeze({
    ...payload,
    autonomousResearchAgendaSelectionReceiptHash:
      hashRecord('AutonomousResearchAgendaSelectionReceipt', payload),
  });
}

export function buildDeterministicAutonomousHypothesisDraft({
  objective,
  protocolFamily,
} = {}) {
  const normalizedObjective = requiredText(objective, 'objective');
  if (!AGENDA_FAMILIES.includes(protocolFamily)
    || !Object.hasOwn(ANALYSIS_PROTOCOL_FAMILY_PROFILES, protocolFamily)) {
    throw new Error('autonomous_research_protocol_family_unsupported');
  }
  const profile = ANALYSIS_PROTOCOL_FAMILY_PROFILES[protocolFamily];
  const formalTemplate = selectAutonomousFormalSupportTemplate(protocolFamily);
  return Object.freeze({
    empiricalHypothesis: Object.freeze({
      statement: `Within the preregistered ${protocolFamily} evaluation universe, the intervention defined by "${normalizedObjective}" improves ${profile.primaryMetric} over the fixed control by at least the preregistered minimum effect.`,
      assumptions: Object.freeze([
        'The benchmark population, treatment, control, metric definitions, and exclusion rules are fixed before execution.',
        'Every reported original run has an isolated deterministic rerun under the same hash-bound code, image, data, and protocol; this is not independent scientific replication.',
      ]),
      quantifiers: Object.freeze([
        'For every seed, repetition, and preregistered evaluation cell in the authorized benchmark schedule.',
      ]),
      negativeBoundaries: Object.freeze([
        `No claim is made outside the preregistered ${protocolFamily} evaluation universe.`,
        'No empirical result is treated as a formal axiom or kernel-checked theorem.',
      ]),
      empiricalObligations: Object.freeze([
        'Run the preregistered treatment, control, and ablation schedule and preserve raw artifacts by hash.',
        'Execute an isolated deterministic rerun and bind all manuscript metrics to verified original and rerun artifacts.',
      ]),
    }),
    formalSupportClaim: Object.freeze({
      statement: formalTemplate.scope.statement,
      assumptions: formalTemplate.scope.assumptions,
      quantifiers: formalTemplate.scope.quantifiers,
      negativeBoundaries: formalTemplate.scope.negativeBoundaries,
      proofObligations: formalTemplate.scope.proofObligations,
    }),
  });
}

export function createAutonomousHypothesisGenerationReceipt({
  draft,
  principalId = 'hepta-autonomous-hypothesis-generator:v1',
  provider = 'local-deterministic-policy',
  model = null,
  externalActionPerformed = false,
  generatedAt = null,
} = {}) {
  const canonicalDraft = normalizedDraft(draft);
  const normalizedPrincipalId = requiredText(principalId, 'generator_principal', 160);
  if (!IDENTIFIER.test(normalizedPrincipalId)) {
    throw new Error('autonomous_research_generator_principal_invalid');
  }
  const payload = {
    version: 1,
    kind: 'AutonomousHypothesisGenerationReceipt',
    status: 'machine_hypothesis_generation_completed',
    generatorPrincipalId: normalizedPrincipalId,
    provider: requiredText(provider, 'generator_provider', 160),
    model: normalizeText(model) || null,
    outputHash: hypothesisDraftHash(canonicalDraft),
    machineGenerated: true,
    humanApprovalPerformed: false,
    externalActionPerformed: Boolean(externalActionPerformed),
    generatedAt: generatedAt || null,
  };
  return Object.freeze({
    ...payload,
    autonomousHypothesisGenerationReceiptHash: hashRecord('AutonomousHypothesisGenerationReceipt', payload),
  });
}

export function createMachineProposedScientificClaimSet({
  paperId,
  objective,
  protocolFamily,
  draft,
  generationReceipt,
  agendaSelectionReceipt,
  dynamicFormalClaimSeed = null,
  researchContentProducerReceipt = null,
  createdAt = null,
} = {}) {
  const normalizedPaperId = requiredText(paperId, 'paper_id', 160);
  if (!IDENTIFIER.test(normalizedPaperId)) throw new Error('autonomous_research_paper_id_invalid');
  const normalizedObjective = requiredText(objective, 'objective');
  if (!AGENDA_FAMILIES.includes(protocolFamily)
    || !Object.hasOwn(ANALYSIS_PROTOCOL_FAMILY_PROFILES, protocolFamily)) {
    throw new Error('autonomous_research_protocol_family_unsupported');
  }
  const {
    autonomousResearchAgendaSelectionReceiptHash: agendaSelectionReceiptHash,
    ...agendaPayload
  } = agendaSelectionReceipt || {};
  const machineGeneratedAgenda = agendaSelectionReceipt?.version === 2;
  if (!exactKeys(agendaSelectionReceipt, [
    'version', 'kind', 'status', 'agendaId', 'agendaVersion', 'paperId', 'selectedObjective',
    'selectedProtocolFamily', 'objectiveOverrideUsed', 'protocolFamilyOverrideUsed',
    'datasetAuthorityConstrainedSelection', 'machineSelectionPerformed',
    'scientificNoveltyVerified', 'selectedAt',
    ...(machineGeneratedAgenda ? ['agendaMode', 'researchAgendaProducerReceipt'] : []),
    'autonomousResearchAgendaSelectionReceiptHash',
  ]) || ![1, 2].includes(agendaSelectionReceipt?.version)
    || agendaSelectionReceipt?.status !== 'autonomous_research_agenda_selected'
    || agendaSelectionReceipt?.paperId !== normalizedPaperId
    || agendaSelectionReceipt?.selectedObjective !== normalizedObjective
    || agendaSelectionReceipt?.selectedProtocolFamily !== protocolFamily
    || typeof agendaSelectionReceipt?.datasetAuthorityConstrainedSelection !== 'boolean'
    || (agendaSelectionReceipt?.datasetAuthorityConstrainedSelection
      && agendaSelectionReceipt?.protocolFamilyOverrideUsed)
    || agendaSelectionReceipt?.scientificNoveltyVerified !== false
    || (machineGeneratedAgenda && (
      agendaSelectionReceipt.agendaMode !== 'machine-generated'
      || !verifyAutonomousResearchAgendaProductionReceipt(
        agendaSelectionReceipt.researchAgendaProducerReceipt,
      ).valid
      || agendaSelectionReceipt.researchAgendaProducerReceipt.paperId !== normalizedPaperId
      || agendaSelectionReceipt.researchAgendaProducerReceipt.selectedObjective
        !== normalizedObjective
      || agendaSelectionReceipt.researchAgendaProducerReceipt.selectedProtocolFamily
        !== protocolFamily
    ))
    || hashRecord('AutonomousResearchAgendaSelectionReceipt', agendaPayload)
      !== agendaSelectionReceiptHash) {
    throw new Error('autonomous_research_agenda_selection_receipt_invalid');
  }
  if (generationReceipt?.kind !== 'AutonomousHypothesisGenerationReceipt'
    || generationReceipt?.status !== 'machine_hypothesis_generation_completed'
    || generationReceipt?.machineGenerated !== true
    || generationReceipt?.humanApprovalPerformed !== false
    || generationReceipt?.outputHash !== hypothesisDraftHash(draft)) {
    throw new Error('autonomous_research_generation_receipt_invalid');
  }
  const {
    autonomousHypothesisGenerationReceiptHash: claimedReceiptHash,
    ...generationReceiptPayload
  } = generationReceipt;
  if (hashRecord('AutonomousHypothesisGenerationReceipt', generationReceiptPayload) !== claimedReceiptHash) {
    throw new Error('autonomous_research_generation_receipt_hash_invalid');
  }
  const sourceDraft = normalizedDraft(draft);
  const dynamicFormal = dynamicFormalClaimSeed !== null;
  let formalTemplate = null;
  if (dynamicFormal) {
    const dynamicVerification = verifyDynamicFormalClaimSeed(dynamicFormalClaimSeed, {
      claimKey: `${normalizedPaperId}:formal-support:1`,
    });
    const {
      autonomousResearchContentProductionReceiptHash: contentReceiptHash,
      ...contentReceiptPayload
    } = researchContentProducerReceipt || {};
    const dynamicScope = {
      statement: dynamicFormalClaimSeed?.statement,
      assumptions: dynamicFormalClaimSeed?.assumptions,
      quantifiers: dynamicFormalClaimSeed?.quantifiers,
      negativeBoundaries: dynamicFormalClaimSeed?.negativeBoundaries,
      proofObligations: dynamicFormalClaimSeed?.proofObligations,
    };
    if (!dynamicVerification.valid
      || JSON.stringify(dynamicScope) !== JSON.stringify(sourceDraft.formalSupportClaim)
      || !SHA256.test(String(contentReceiptHash || ''))
      || hashRecord('AutonomousResearchContentProductionReceipt', contentReceiptPayload)
        !== contentReceiptHash
      || researchContentProducerReceipt?.status
        !== 'autonomous_research_content_production_verified'
      || researchContentProducerReceipt?.paperId !== normalizedPaperId
      || researchContentProducerReceipt?.protocolFamily !== protocolFamily
      || researchContentProducerReceipt?.outputHash !== generationReceipt.outputHash
      || researchContentProducerReceipt?.principalId !== generationReceipt.generatorPrincipalId
      || researchContentProducerReceipt?.dynamicFormalClaimSeedHash
        !== dynamicFormalClaimSeed.dynamicFormalClaimSeedHash
      || dynamicFormalClaimSeed.generatorReceiptHash
        !== researchContentProducerReceipt.agentExecutionReceiptHash) {
      throw new Error('autonomous_research_dynamic_formal_claim_lineage_invalid');
    }
  } else {
    try { formalTemplate = resolveAutonomousFormalSupportTemplateForClaim(sourceDraft.formalSupportClaim); }
    catch { throw new Error('autonomous_research_formal_support_template_not_audited'); }
    if (formalTemplate.protocolFamily !== protocolFamily) {
      throw new Error('autonomous_research_formal_support_protocol_family_mismatch');
    }
  }
  const empirical = sourceDraft.empiricalHypothesis;
  const formal = sourceDraft.formalSupportClaim;
  const claims = Object.freeze([
    Object.freeze({
      claimKey: `${normalizedPaperId}:empirical-hypothesis:1`,
      verificationMode: 'empirical_protocol',
      statement: empirical.statement,
      assumptions: empirical.assumptions,
      quantifiers: empirical.quantifiers,
      negativeBoundaries: empirical.negativeBoundaries,
      proofObligations: Object.freeze([]),
      empiricalObligations: empirical.empiricalObligations,
    }),
    Object.freeze({
      claimKey: `${normalizedPaperId}:formal-support:1`,
      verificationMode: 'formal_kernel',
      statement: formal.statement,
      assumptions: formal.assumptions,
      quantifiers: formal.quantifiers,
      negativeBoundaries: formal.negativeBoundaries,
      proofObligations: formal.proofObligations,
      empiricalObligations: Object.freeze([]),
    }),
  ]);
  const payload = {
    version: dynamicFormal ? 2 : 1,
    kind: 'MachineProposedScientificClaimSet',
    status: 'machine_scientific_claim_set_proposed',
    paperId: normalizedPaperId,
    objective: normalizedObjective,
    protocolFamily,
    formalSupportRegistryHash: dynamicFormal ? null
      : AUTONOMOUS_FORMAL_SUPPORT_TEMPLATE_REGISTRY.autonomousFormalSupportTemplateRegistryHash,
    formalSupportTemplateId: formalTemplate?.templateId || null,
    formalSupportTemplateHash: formalTemplate?.autonomousFormalSupportTemplateHash || null,
    ...(dynamicFormal ? {
      formalSupportMode: 'dynamic-lean-type-v1',
      dynamicFormalClaimSeed,
      researchContentProducerReceipt,
    } : {}),
    claimAuthorityType: 'machine-proposed-untrusted',
    agendaSelectionReceipt,
    agendaSelectionReceiptHash,
    sourceDraft,
    generationReceipt,
    claims,
    generationReceiptHash: claimedReceiptHash,
    generatorPrincipalId: generationReceipt.generatorPrincipalId,
    limitations: Object.freeze({
      operatorApprovalClaimed: false,
      scientificNoveltyVerified: false,
      scientificCorrectnessVerified: false,
      formalProofVerified: false,
      empiricalResultVerified: false,
      universalResearchValidityClaimed: false,
      naturalLanguageToLeanEquivalenceMachineProven: false,
    }),
    createdAt: createdAt || null,
  };
  return Object.freeze({
    ...payload,
    machineProposedScientificClaimSetHash: hashRecord('MachineProposedScientificClaimSet', payload),
  });
}

export function verifyMachineProposedScientificClaimSet(value) {
  const blockers = [];
  const dynamicFormal = value?.version === 2;
  if (![1, 2].includes(value?.version) || value?.kind !== 'MachineProposedScientificClaimSet'
    || value?.status !== 'machine_scientific_claim_set_proposed'
    || value?.claimAuthorityType !== 'machine-proposed-untrusted') {
    blockers.push('autonomous_research_machine_claim_set_shape_invalid');
  }
  if (!IDENTIFIER.test(String(value?.paperId || ''))
    || !normalizeText(value?.objective)
    || !AGENDA_FAMILIES.includes(value?.protocolFamily)
    || !Object.hasOwn(ANALYSIS_PROTOCOL_FAMILY_PROFILES, value?.protocolFamily)) {
    blockers.push('autonomous_research_machine_claim_set_scope_invalid');
  }
  const expectedKeys = [
    'version', 'kind', 'status', 'paperId', 'objective', 'protocolFamily', 'claimAuthorityType',
    'formalSupportRegistryHash', 'formalSupportTemplateId', 'formalSupportTemplateHash',
    'agendaSelectionReceipt', 'agendaSelectionReceiptHash', 'sourceDraft', 'generationReceipt',
    'claims', 'generationReceiptHash', 'generatorPrincipalId',
    'limitations', 'createdAt', 'machineProposedScientificClaimSetHash',
    ...(dynamicFormal ? [
      'formalSupportMode', 'dynamicFormalClaimSeed', 'researchContentProducerReceipt',
    ] : []),
  ];
  if (!exactKeys(value, expectedKeys) || !Array.isArray(value?.claims) || value.claims.length !== 2) {
    blockers.push('autonomous_research_machine_claim_count_invalid');
  }
  let canonicalDraft = null;
  try { canonicalDraft = normalizedDraft(value?.sourceDraft); }
  catch { blockers.push('autonomous_research_machine_claim_draft_invalid'); }
  if (dynamicFormal) {
    const dynamicVerification = verifyDynamicFormalClaimSeed(value?.dynamicFormalClaimSeed, {
      claimKey: `${value?.paperId}:formal-support:1`,
    });
    const dynamicScope = {
      statement: value?.dynamicFormalClaimSeed?.statement,
      assumptions: value?.dynamicFormalClaimSeed?.assumptions,
      quantifiers: value?.dynamicFormalClaimSeed?.quantifiers,
      negativeBoundaries: value?.dynamicFormalClaimSeed?.negativeBoundaries,
      proofObligations: value?.dynamicFormalClaimSeed?.proofObligations,
    };
    const contentReceipt = value?.researchContentProducerReceipt;
    const {
      autonomousResearchContentProductionReceiptHash: contentReceiptHash,
      ...contentReceiptPayload
    } = contentReceipt || {};
    if (value?.formalSupportMode !== 'dynamic-lean-type-v1'
      || value?.formalSupportRegistryHash !== null
      || value?.formalSupportTemplateId !== null
      || value?.formalSupportTemplateHash !== null
      || !dynamicVerification.valid
      || (canonicalDraft
        && JSON.stringify(dynamicScope) !== JSON.stringify(canonicalDraft.formalSupportClaim))
      || !SHA256.test(String(contentReceiptHash || ''))
      || hashRecord('AutonomousResearchContentProductionReceipt', contentReceiptPayload)
        !== contentReceiptHash
      || contentReceipt?.status !== 'autonomous_research_content_production_verified'
      || contentReceipt?.paperId !== value?.paperId
      || contentReceipt?.protocolFamily !== value?.protocolFamily
      || contentReceipt?.outputHash !== value?.generationReceipt?.outputHash
      || contentReceipt?.principalId !== value?.generatorPrincipalId
      || contentReceipt?.dynamicFormalClaimSeedHash
        !== value?.dynamicFormalClaimSeed?.dynamicFormalClaimSeedHash
      || value?.dynamicFormalClaimSeed?.generatorReceiptHash
        !== contentReceipt?.agentExecutionReceiptHash) {
      blockers.push('autonomous_research_machine_claim_dynamic_formal_lineage_invalid');
    }
  } else {
    let formalTemplate = null;
    try {
      formalTemplate = canonicalDraft
        ? resolveAutonomousFormalSupportTemplateForClaim(canonicalDraft.formalSupportClaim) : null;
    } catch {
      blockers.push('autonomous_research_machine_claim_formal_template_invalid');
      blockers.push('autonomous_research_machine_claim_draft_invalid');
    }
    if (!formalTemplate || formalTemplate.protocolFamily !== value?.protocolFamily
      || value?.formalSupportRegistryHash
        !== AUTONOMOUS_FORMAL_SUPPORT_TEMPLATE_REGISTRY.autonomousFormalSupportTemplateRegistryHash
      || value?.formalSupportTemplateId !== formalTemplate?.templateId
      || value?.formalSupportTemplateHash !== formalTemplate?.autonomousFormalSupportTemplateHash) {
      blockers.push('autonomous_research_machine_claim_formal_template_lineage_invalid');
      blockers.push('autonomous_research_machine_claim_draft_invalid');
    }
  }
  const agenda = value?.agendaSelectionReceipt;
  const { autonomousResearchAgendaSelectionReceiptHash: agendaHash, ...agendaPayload } = agenda || {};
  const machineGeneratedAgenda = agenda?.version === 2;
  if (!exactKeys(agenda, [
    'version', 'kind', 'status', 'agendaId', 'agendaVersion', 'paperId', 'selectedObjective',
    'selectedProtocolFamily', 'objectiveOverrideUsed', 'protocolFamilyOverrideUsed',
    'datasetAuthorityConstrainedSelection', 'machineSelectionPerformed',
    'scientificNoveltyVerified', 'selectedAt',
    ...(machineGeneratedAgenda ? ['agendaMode', 'researchAgendaProducerReceipt'] : []),
    'autonomousResearchAgendaSelectionReceiptHash',
  ]) || ![1, 2].includes(agenda?.version)
    || agenda?.kind !== 'AutonomousResearchAgendaSelectionReceipt'
    || agenda?.status !== 'autonomous_research_agenda_selected'
    || agenda?.agendaId !== (machineGeneratedAgenda
      ? 'hepta-machine-generated-research-agenda-v1' : 'hepta-bounded-research-agenda-v1')
    || agenda?.agendaVersion !== AGENDA_VERSION
    || agenda?.paperId !== value?.paperId || agenda?.selectedObjective !== value?.objective
    || agenda?.selectedProtocolFamily !== value?.protocolFamily
    || typeof agenda?.datasetAuthorityConstrainedSelection !== 'boolean'
    || (agenda?.datasetAuthorityConstrainedSelection && agenda?.protocolFamilyOverrideUsed)
    || (machineGeneratedAgenda && (
      agenda?.agendaMode !== 'machine-generated'
      || !verifyAutonomousResearchAgendaProductionReceipt(
        agenda?.researchAgendaProducerReceipt,
      ).valid
      || agenda.researchAgendaProducerReceipt.paperId !== value?.paperId
      || agenda.researchAgendaProducerReceipt.selectedObjective !== value?.objective
      || agenda.researchAgendaProducerReceipt.selectedProtocolFamily !== value?.protocolFamily
    ))
    || agenda?.scientificNoveltyVerified !== false || value?.agendaSelectionReceiptHash !== agendaHash
    || hashRecord('AutonomousResearchAgendaSelectionReceipt', agendaPayload) !== agendaHash) {
    blockers.push('autonomous_research_machine_claim_agenda_lineage_invalid');
  }
  const receipt = value?.generationReceipt;
  const { autonomousHypothesisGenerationReceiptHash: receiptHash, ...receiptPayload } = receipt || {};
  if (!exactKeys(receipt, [
    'version', 'kind', 'status', 'generatorPrincipalId', 'provider', 'model', 'outputHash',
    'machineGenerated', 'humanApprovalPerformed', 'externalActionPerformed', 'generatedAt',
    'autonomousHypothesisGenerationReceiptHash',
  ]) || receipt?.kind !== 'AutonomousHypothesisGenerationReceipt'
    || receipt?.status !== 'machine_hypothesis_generation_completed'
    || receipt?.machineGenerated !== true || receipt?.humanApprovalPerformed !== false
    || receiptHash !== value?.generationReceiptHash
    || value?.generatorPrincipalId !== receipt?.generatorPrincipalId
    || (canonicalDraft && receipt?.outputHash !== hypothesisDraftHash(canonicalDraft))
    || hashRecord('AutonomousHypothesisGenerationReceipt', receiptPayload) !== receiptHash) {
    blockers.push('autonomous_research_machine_claim_generation_lineage_invalid');
  }
  const [empiricalClaim, formalClaim] = value?.claims || [];
  const claimKeys = [
    'claimKey', 'verificationMode', 'statement', 'assumptions', 'quantifiers',
    'negativeBoundaries', 'proofObligations', 'empiricalObligations',
  ];
  if (!exactKeys(empiricalClaim, claimKeys) || !exactKeys(formalClaim, claimKeys)
    || !IDENTIFIER.test(String(empiricalClaim?.claimKey || ''))
    || !IDENTIFIER.test(String(formalClaim?.claimKey || ''))
    || empiricalClaim?.verificationMode !== 'empirical_protocol'
    || formalClaim?.verificationMode !== 'formal_kernel'
    || empiricalClaim?.proofObligations?.length !== 0
    || formalClaim?.empiricalObligations?.length !== 0
    || !Array.isArray(empiricalClaim?.empiricalObligations) || !empiricalClaim.empiricalObligations.length
    || !Array.isArray(formalClaim?.proofObligations) || !formalClaim.proofObligations.length
    || (canonicalDraft && JSON.stringify(empiricalClaim) !== JSON.stringify({
      claimKey: `${value.paperId}:empirical-hypothesis:1`,
      verificationMode: 'empirical_protocol',
      statement: canonicalDraft.empiricalHypothesis.statement,
      assumptions: canonicalDraft.empiricalHypothesis.assumptions,
      quantifiers: canonicalDraft.empiricalHypothesis.quantifiers,
      negativeBoundaries: canonicalDraft.empiricalHypothesis.negativeBoundaries,
      proofObligations: [],
      empiricalObligations: canonicalDraft.empiricalHypothesis.empiricalObligations,
    }))
    || (canonicalDraft && JSON.stringify(formalClaim) !== JSON.stringify({
      claimKey: `${value.paperId}:formal-support:1`, verificationMode: 'formal_kernel',
      ...canonicalDraft.formalSupportClaim, empiricalObligations: [],
    }))) blockers.push('autonomous_research_machine_claim_invalid');
  const limitations = value?.limitations;
  if (!exactKeys(limitations, [
    'operatorApprovalClaimed', 'scientificNoveltyVerified', 'scientificCorrectnessVerified',
    'formalProofVerified', 'empiricalResultVerified', 'universalResearchValidityClaimed',
    'naturalLanguageToLeanEquivalenceMachineProven',
  ]) || limitations?.operatorApprovalClaimed !== false
    || limitations?.scientificNoveltyVerified !== false
    || limitations?.scientificCorrectnessVerified !== false
    || limitations?.formalProofVerified !== false
    || limitations?.empiricalResultVerified !== false
    || limitations?.universalResearchValidityClaimed !== false
    || limitations?.naturalLanguageToLeanEquivalenceMachineProven !== false) {
    blockers.push('autonomous_research_machine_claim_limitations_invalid');
  }
  const { machineProposedScientificClaimSetHash: claimedHash, ...payload } = value || {};
  if (!claimedHash || hashRecord('MachineProposedScientificClaimSet', payload) !== claimedHash) {
    blockers.push('autonomous_research_machine_claim_set_hash_invalid');
  }
  return Object.freeze({
    valid: blockers.length === 0,
    status: blockers.length
      ? 'machine_scientific_claim_set_blocked'
      : 'machine_scientific_claim_set_verified',
    blockers: Object.freeze([...new Set(blockers)]),
  });
}
