import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildAutonomousResearchAgendaProductionReceipt,
  buildAutonomousResearchAgendaProductionRequest,
} from '../../paper-domain/automation/autonomous-research-agenda-production-contract.mjs';
import {
  selectMachineGeneratedAutonomousResearchAgenda,
} from '../../paper-domain/automation/autonomous-research-proposal-contract.mjs';
import {
  buildAutonomousVenueProfile,
} from '../../paper-domain/automation/autonomous-venue-profile-contract.mjs';
import {
  buildResearchAgendaIr,
  verifyResearchAgendaIr,
} from '../../paper-domain/automation/research-agenda-ir.mjs';
import {
  buildVenueRequirementIr,
} from '../../paper-domain/automation/venue-requirement-ir.mjs';
import {
  buildPriorArtClaimAlignmentReceipt,
  conservativePriorArtClaimAlignmentRecords,
  verifyPriorArtClaimAlignmentReceipt,
} from '../../paper-domain/research/prior-art-claim-alignment-contract.mjs';
import {
  buildConservativePriorArtClaimAlignment,
  verifyConservativePriorArtClaimAlignment,
} from '../../paper-application/automation/prior-art-claim-alignment-production.mjs';
import {
  priorArtV2Fixture,
} from './support/autonomous-research-generalization-fixture.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const H = (label) => hashRecord('GenericResearchSemanticIrTest', { label });

function agendaReceipt() {
  const request = buildAutonomousResearchAgendaProductionRequest({
    paperId: 'semantic-ir-paper',
    allowedProtocolFamilies: ['ml_algorithm_benchmark'],
  });
  const agentPayload = Object.freeze({
    version: 1,
    kind: 'AgentExecutionReceipt',
    status: 'agent_execution_completed',
    agentId: 'semantic-ir-producer',
    providerMode: 'fixture-provider',
    resolvedModel: 'fixture-model',
    promptHash: H('prompt'),
  });
  const agentExecutionReceipt = Object.freeze({
    ...agentPayload,
    agentExecutionReceiptHash: hashRecord('AgentExecutionReceipt', agentPayload),
  });
  return buildAutonomousResearchAgendaProductionReceipt({
    request,
    selectedObjective: 'Estimate a bounded treatment effect against the registered baseline.',
    selectedProtocolFamily: 'ml_algorithm_benchmark',
    agentExecutionReceipt,
    producerId: 'semantic-ir-producer',
    generatedAt: '2026-07-22T00:00:00.000Z',
  });
}

function researchAgendaIr() {
  return buildResearchAgendaIr({
    agendaProductionReceipt: agendaReceipt(),
    researchQuestion: 'Does the registered treatment improve the held-out primary metric?',
    primaryClaim: 'The treatment improves the primary metric relative to the baseline.',
    dataRequirements: {
      population: 'Rows admitted by the signed dataset contract.',
      intervention: 'Registered treatment implementation.',
      comparator: 'Registered baseline implementation.',
      estimand: 'Paired mean primary-metric difference.',
      requiredVariables: ['outcome', 'treatment_assignment'],
      datasetConstraints: ['read-only signed dataset mount', 'no post-freeze filtering'],
    },
    falsifiers: ['Non-positive paired primary-metric difference.'],
    negativeBoundaries: ['No claim outside the signed dataset population.'],
    formalTargets: ['Prove the metric aggregation invariant.'],
    priorArtQueryPlan: ['Search the intervention and estimand concepts together.'],
    venueConstraints: {
      paperType: 'research_article',
      requiredSections: ['methods', 'results', 'limitations'],
      artifactRequired: true,
      anonymousReviewRequired: true,
    },
    resourceFeasibility: {
      maximumWallTimeMs: 3_600_000,
      maximumMemoryBytes: 8_589_934_592,
      maximumCpuCount: 4,
      executionEnvironment: 'signed-python-runtime-v1',
    },
  });
}

test('Research Agenda IR binds a machine agenda to falsifiers and execution constraints', () => {
  const receipt = agendaReceipt();
  const ir = researchAgendaIr();
  assert.equal(verifyResearchAgendaIr(ir, { agendaProductionReceipt: receipt }), true);
  assert.equal(verifyResearchAgendaIr({ ...ir, primaryClaim: 'tampered' }), false);
  assert.throws(() => buildResearchAgendaIr({
    agendaProductionReceipt: receipt,
    researchQuestion: 'Incomplete agenda.',
  }), /research_agenda_ir_invalid/);
});

test('legacy venue profiles remain bounded-compatible but cannot mint Venue Requirement IR', () => {
  const agenda = researchAgendaIr();
  const venueProfile = buildAutonomousVenueProfile({
    venueId: 'fixture-venue',
    displayName: 'Fixture Venue',
    protocolFamilies: ['ml_algorithm_benchmark'],
    profileAuthorityReceiptHash: H('venue-profile-authority'),
    scopeTerms: ['machine learning', 'empirical evaluation'],
  });
  assert.equal(venueProfile.version, 2);
  assert.throws(() => buildVenueRequirementIr({
    researchAgendaIr: agenda,
    venueProfile,
    venueRequirementAuthorityReceiptHash: H('venue-requirement-authority'),
    anonymousReview: true,
    reviewMode: 'double-anonymous',
    wordLimit: 8_000,
    sectionLimits: [
      { section: 'abstract', maximumWords: 250 },
      { section: 'main_text', maximumWords: 8_000 },
    ],
    templateAssetHash: H('venue-template'),
    supplementPolicy: 'Supplement is permitted and must be independently archived.',
    artifactPolicy: 'A replayable artifact is required.',
    disclosureRequirements: ['funding statement', 'conflict-of-interest statement'],
  }), /venue_requirement_ir_invalid/);
});

test('prior-art alignment covers the agenda claim and every executed query', () => {
  const agenda = researchAgendaIr();
  const priorArt = priorArtV2Fixture({
    paperId: agenda.paperId,
    agendaSelectionReceiptHash: agenda.sourceAgendaProductionReceiptHash,
    researchAgendaIrHash: agenda.researchAgendaIrHash,
    priorArtQueryPlan: agenda.priorArtQueryPlan,
  });
  const receipt = buildPriorArtClaimAlignmentReceipt({
    researchAgendaIr: agenda,
    priorArtEvidenceReceipt: priorArt,
    alignments: conservativePriorArtClaimAlignmentRecords({
      researchAgendaIr: agenda,
      priorArtEvidenceReceipt: priorArt,
    }),
  });
  assert.equal(verifyPriorArtClaimAlignmentReceipt(receipt, {
    researchAgendaIr: agenda,
    priorArtEvidenceReceipt: priorArt,
  }), true);
  assert.equal(verifyPriorArtClaimAlignmentReceipt({
    ...receipt,
    researchAgendaIrHash: H('different-agenda'),
  }, {
    researchAgendaIr: agenda,
    priorArtEvidenceReceipt: priorArt,
  }), false);
  const noveltyClaim = buildPriorArtClaimAlignmentReceipt({
    researchAgendaIr: agenda,
    priorArtEvidenceReceipt: priorArt,
    alignments: [{
      ...receipt.alignments[0],
      closestWorkGap: 'This finite corpus proves universal scientific novelty.',
    }],
  });
  assert.equal(noveltyClaim.status, 'prior_art_claim_alignment_blocked');
  assert.ok(noveltyClaim.blockers.includes(
    'prior_art_claim_alignment_conservative_projection_required',
  ));
});

test('production prior-art alignment projects the exact agenda selection without novelty claims', () => {
  const agendaProductionReceipt = agendaReceipt();
  const agenda = researchAgendaIr();
  assert.equal(agenda.sourceAgendaProductionReceiptHash,
    agendaProductionReceipt.autonomousResearchAgendaProductionReceiptHash);
  const agendaSelectionReceipt = selectMachineGeneratedAutonomousResearchAgenda({
    paperId: agenda.paperId,
    researchAgendaProducerReceipt: agendaProductionReceipt,
  });
  const priorArt = priorArtV2Fixture({
    paperId: agenda.paperId,
    agendaSelectionReceiptHash:
      agendaSelectionReceipt.autonomousResearchAgendaSelectionReceiptHash,
    researchAgendaIrHash: agenda.researchAgendaIrHash,
    priorArtQueryPlan: agenda.priorArtQueryPlan,
  });
  const receipt = buildConservativePriorArtClaimAlignment({
    researchAgendaIr: agenda,
    agendaSelectionReceipt,
    priorArtEvidenceReceipt: priorArt,
  });
  assert.equal(verifyConservativePriorArtClaimAlignment(receipt, {
    researchAgendaIr: agenda,
    agendaSelectionReceipt,
    priorArtEvidenceReceipt: priorArt,
  }), true);
  assert.equal(receipt.agendaSelectionReceiptHash,
    agendaSelectionReceipt.autonomousResearchAgendaSelectionReceiptHash);
  assert.equal(receipt.openWorldCompletenessClaimed, false);
  assert.equal(receipt.scientificNoveltyVerified, false);
  assert.match(receipt.alignments[0].closestWorkGap,
    /does not establish.*scientific novelty.*open-world completeness/);
  assert.throws(() => buildConservativePriorArtClaimAlignment({
    researchAgendaIr: agenda,
    agendaSelectionReceipt: {
      ...agendaSelectionReceipt,
      selectedProtocolFamily: 'panel_econometrics_benchmark',
    },
    priorArtEvidenceReceipt: priorArt,
  }), /agenda_lineage_invalid/);
});
