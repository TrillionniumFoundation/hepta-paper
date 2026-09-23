import {
  inspectGenericDomainCapabilityEvidence,
  publishGenericDomainCapabilityEvidence,
  verifyGenericDomainCapabilityEvidenceShape,
} from '../../paper-adapters/automation/generic-domain-capability-evidence-repository.mjs';
import {
  assertCurrentDynamicFormalExecutionAuthority,
  verifyDynamicFormalExecutionAuthority,
} from '../../paper-adapters/research-verify/dynamic-formal-project-closure-readiness.mjs';
import {
  verifyFormalDomainCoverageReceipt,
} from '../../paper-adapters/research-verify/formal-domain-coverage-receipt.mjs';
import {
  verifyAutonomousResearchAgendaProductionReceipt,
} from '../../paper-domain/automation/autonomous-research-agenda-production-contract.mjs';
import { verifyResearchAgendaIr } from '../../paper-domain/automation/research-agenda-ir.mjs';
import { verifyVenueRequirementIr } from '../../paper-domain/automation/venue-requirement-ir.mjs';
import {
  verifySystemBenchmarkHarnessExecutionReceipt,
} from '../../paper-domain/automation/experiment-run-contract.mjs';
import {
  verifyExperimentIrExecutionAuthorityReceipt,
} from '../../paper-domain/automation/experiment-ir-execution-authority-contract.mjs';
import {
  verifyPriorArtClaimAlignmentReceipt,
} from '../../paper-domain/research/prior-art-claim-alignment-contract.mjs';
import {
  inspectFormalDomainQualificationExternalEvidence,
  verifyFormalDomainQualificationExternalEvidence,
} from '../../paper-domain/research/formal-domain-qualification-external-evidence.mjs';

export function inspectGenericDomainCapabilityEvidenceBindings({
  evidence,
  researchAgendaProducerReceipt,
  genericDomainCapabilityVerificationContext = null,
} = {}) {
  const blockers = [];
  if (!verifyGenericDomainCapabilityEvidenceShape(evidence)) {
    blockers.push('generic_domain_capability_evidence_shape_invalid');
  }
  const researchAgendaProducerReceiptValid =
    researchAgendaProducerReceipt?.version === 3
    && researchAgendaProducerReceipt?.productionAuthorityBinding
    && verifyAutonomousResearchAgendaProductionReceipt(
      researchAgendaProducerReceipt,
    ).valid;
  if (!researchAgendaProducerReceiptValid) {
    blockers.push('generic_domain_capability_agenda_production_authority_invalid');
  }
  const researchAgendaIrValid = verifyResearchAgendaIr(evidence?.researchAgendaIr, {
    agendaProductionReceipt: researchAgendaProducerReceipt,
  });
  if (!researchAgendaIrValid) {
    blockers.push('generic_domain_capability_research_agenda_ir_invalid');
  }
  const experimentAuthority = evidence?.experimentIrExecutionAuthorityReceipt;
  const experimentReplay = evidence?.experimentReplayReceipt;
  const originalResearchBinding = experimentReplay?.originalRunReceipt
    ?.harnessExecutionReceipt?.experimentIr?.researchBinding || null;
  const experimentIrExecutionAuthorityValid = verifySystemBenchmarkHarnessExecutionReceipt(
    evidence?.experimentHarnessExecutionReceipt,
  ) && verifyExperimentIrExecutionAuthorityReceipt(experimentAuthority, {
    campaignId: experimentAuthority?.campaignId,
    paperId: experimentAuthority?.paperId,
    campaignPlanHash: experimentAuthority?.campaignPlanHash,
    nodeId: experimentAuthority?.nodeId,
    nodeKind: experimentAuthority?.nodeKind,
    researchAgendaIr: evidence?.researchAgendaIr,
    researchAgendaProducerReceipt,
    proposal: originalResearchBinding?.proposal,
    researchAgendaClaimBindingReceipt:
      originalResearchBinding?.researchAgendaClaimBindingReceipt,
    experimentReplayReceipt: experimentReplay,
  })
    && experimentReplay?.replayRunReceipt?.harnessExecutionReceipt
      ?.systemBenchmarkHarnessExecutionReceiptHash
      === evidence?.experimentHarnessExecutionReceipt
        ?.systemBenchmarkHarnessExecutionReceiptHash
    && evidence?.experimentHarnessExecutionReceipt?.experimentIr?.version === 5
    && evidence?.experimentHarnessExecutionReceipt?.experimentIr?.benchmarkFamily
      === evidence?.researchAgendaIr?.protocolFamily;
  if (!experimentIrExecutionAuthorityValid) {
    blockers.push('generic_domain_capability_experiment_execution_invalid');
  }
  const priorArtClaimAlignmentValid = verifyPriorArtClaimAlignmentReceipt(
    evidence?.priorArtClaimAlignmentReceipt, {
      researchAgendaIr: evidence?.researchAgendaIr,
      priorArtEvidenceReceipt: evidence?.priorArtEvidenceReceipt,
    },
  );
  if (!priorArtClaimAlignmentValid) {
    blockers.push('generic_domain_capability_prior_art_alignment_invalid');
  }
  const venueRequirementIrValid = verifyVenueRequirementIr(evidence?.venueRequirementIr, {
    researchAgendaIr: evidence?.researchAgendaIr,
    venueProfile: evidence?.venueProfile,
  });
  if (!venueRequirementIrValid) {
    blockers.push('generic_domain_capability_venue_requirement_invalid');
  }
  const dynamicFormalExecutionAuthorityValid = verifyDynamicFormalExecutionAuthority(
    evidence?.dynamicFormalExecutionAuthority,
  );
  const formalDomainCoverageReceiptValid = verifyFormalDomainCoverageReceipt(
    evidence?.formalDomainCoverageReceipt,
  ) && evidence?.formalDomainCoverageReceipt?.dynamicFormalExecutionAuthorityHash
    === evidence?.dynamicFormalExecutionAuthority?.dynamicFormalExecutionAuthorityHash;
  if (!dynamicFormalExecutionAuthorityValid || !formalDomainCoverageReceiptValid) {
    blockers.push('generic_domain_capability_formal_coverage_invalid');
  }
  const formalDomainExternalEvidenceInspection =
    inspectFormalDomainQualificationExternalEvidence({
      evidence: evidence?.formalDomainQualificationExternalEvidence,
      coverageReceipt: evidence?.formalDomainCoverageReceipt,
      externalResearchReplayReceiptVerifier:
        genericDomainCapabilityVerificationContext
          ?.externalResearchReplayReceiptVerifier || null,
      reviewerReceiptVerificationAuthority:
        genericDomainCapabilityVerificationContext
          ?.reviewerReceiptVerificationAuthority || null,
    });
  const formalDomainQualificationExternalEvidenceValid = formalDomainCoverageReceiptValid
    && verifyFormalDomainQualificationExternalEvidence(
      evidence?.formalDomainQualificationExternalEvidence,
      {
        coverageReceipt: evidence?.formalDomainCoverageReceipt,
        externalResearchReplayReceiptVerifier:
          genericDomainCapabilityVerificationContext
            ?.externalResearchReplayReceiptVerifier || null,
        reviewerReceiptVerificationAuthority:
          genericDomainCapabilityVerificationContext
            ?.reviewerReceiptVerificationAuthority || null,
      },
    );
  const formalDomainCoverageExternallyReplayed =
    formalDomainQualificationExternalEvidenceValid
    && formalDomainExternalEvidenceInspection.replayReceiptValid === true;
  if (!formalDomainCoverageExternallyReplayed) {
    blockers.push('generic_domain_capability_formal_coverage_external_replay_required');
  }
  const formalDomainIndependentReviewValid =
    formalDomainQualificationExternalEvidenceValid
    && formalDomainExternalEvidenceInspection.independentReviewReady === true;
  if (!formalDomainIndependentReviewValid) {
    blockers.push('generic_domain_capability_formal_coverage_independent_review_required');
  }
  const researchAssurance = genericDomainCapabilityVerificationContext
    ?.autonomousResearchAssuranceAuthorityInspection || null;
  const externalResearchReplayReceiptValid = researchAssurance?.ready === true
    && JSON.stringify(evidence?.externalResearchReplayRequest)
      === JSON.stringify(researchAssurance.externalResearchReplayRequest)
    && JSON.stringify(evidence?.externalResearchReplayReceipt)
      === JSON.stringify(researchAssurance.externalResearchReplayReceipt)
    && evidence?.externalResearchReplayRequest?.campaignId
      === researchAssurance.campaignId
    && evidence?.externalResearchReplayRequest?.paperId
      === researchAssurance.paperId
    && evidence?.externalResearchReplayReceipt?.campaignId
      === researchAssurance.campaignId
    && evidence?.externalResearchReplayReceipt?.paperId
      === researchAssurance.paperId
    && experimentAuthority?.campaignId === researchAssurance.campaignId
    && experimentAuthority?.paperId === researchAssurance.paperId;
  if (!externalResearchReplayReceiptValid) {
    blockers.push('generic_domain_capability_external_research_replay_invalid');
  }
  const independentFormalReviewReceiptValid = researchAssurance?.ready === true
    && JSON.stringify(evidence?.independentFormalReviewReceipt)
      === JSON.stringify(researchAssurance.independentFormalReviewReceipt)
    && evidence?.independentFormalReviewReceipt?.campaignId
      === researchAssurance.campaignId
    && evidence?.independentFormalReviewReceipt?.paperId
      === researchAssurance.paperId
    && evidence?.independentFormalReviewReceipt?.dynamicFormalExecutionAuthority
      ?.dynamicFormalExecutionAuthorityHash
      === evidence?.dynamicFormalExecutionAuthority
        ?.dynamicFormalExecutionAuthorityHash
    && evidence?.externalResearchReplayRequest?.formalReplayReceiptHashes?.length > 0
    && JSON.stringify(evidence.externalResearchReplayRequest.formalReplayReceiptHashes)
      === JSON.stringify([
        ...(evidence.independentFormalReviewReceipt
          ?.formalReplayReceiptHashes || []),
      ].sort());
  if (!independentFormalReviewReceiptValid) {
    blockers.push('generic_domain_capability_independent_formal_review_invalid');
  }
  const uniqueBlockers = Object.freeze([...new Set(blockers)]);
  return Object.freeze({
    version: 1,
    kind: 'GenericDomainCapabilityEvidenceBindingInspection',
    status: uniqueBlockers.length
      ? 'generic_domain_capability_evidence_bindings_blocked'
      : 'generic_domain_capability_evidence_bindings_verified',
    ready: uniqueBlockers.length === 0,
    researchAgendaProducerReceiptValid,
    researchAgendaIrValid,
    experimentIrExecutionAuthorityValid,
    priorArtClaimAlignmentValid,
    venueRequirementIrValid,
    dynamicFormalExecutionAuthorityValid,
    formalDomainCoverageReceiptValid,
    formalDomainCoverageExternallyReplayed,
    formalDomainIndependentReviewValid,
    formalDomainQualificationExternalEvidenceValid,
    externalResearchReplayReceiptValid,
    independentFormalReviewReceiptValid,
    blockers: uniqueBlockers,
  });
}

export function composeGenericDomainCapabilityEvidenceStatus(options = {}) {
  return inspectGenericDomainCapabilityEvidence(options);
}

export function composeGenericDomainCapabilityEvidencePublication({
  runtimeRoot,
  evidence,
  researchAgendaProducerReceipt,
  genericDomainCapabilityVerificationContext = null,
  expectedCurrentEvidenceHash = null,
  environment = process.env,
  spawnSyncImpl = undefined,
} = {}) {
  const inspection = inspectGenericDomainCapabilityEvidenceBindings({
    evidence,
    researchAgendaProducerReceipt,
    genericDomainCapabilityVerificationContext,
  });
  if (!inspection.ready) {
    throw new Error(`generic_domain_capability_evidence_publication_blocked:${inspection.blockers.join(',')}`);
  }
  const current = assertCurrentDynamicFormalExecutionAuthority(
    evidence.dynamicFormalExecutionAuthority,
    {
      environment,
      ...(spawnSyncImpl ? { spawnSyncImpl } : {}),
    },
  ).authority;
  if (current.dynamicFormalExecutionAuthorityHash
    !== evidence.dynamicFormalExecutionAuthority.dynamicFormalExecutionAuthorityHash) {
    throw new Error('generic_domain_capability_dynamic_formal_authority_drift');
  }
  const publication = publishGenericDomainCapabilityEvidence({
    runtimeRoot,
    evidence,
    expectedCurrentEvidenceHash,
  });
  return Object.freeze({
    version: 1,
    kind: 'GenericDomainCapabilityEvidencePublicationReport',
    status: publication.status,
    ready: true,
    evidenceHash: publication.evidenceHash,
    path: publication.path,
    published: publication.published,
    externalActionPerformed: false,
    blockers: Object.freeze([]),
  });
}
