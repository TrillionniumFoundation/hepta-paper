import {
  verifyFormalDomainCoverageReceipt,
} from '../../paper-adapters/research-verify/formal-domain-coverage-receipt.mjs';
import {
  assertCurrentDynamicFormalExecutionAuthority,
} from '../../paper-adapters/research-verify/dynamic-formal-project-closure-readiness.mjs';
import {
  inspectGenericDomainCapabilityEvidenceBindings,
  composeGenericDomainCapabilityEvidencePublication,
} from './generic-domain-capability-evidence-publication.mjs';
import {
  runConfiguredFormalDomainQualification,
} from './formal-domain-qualification-composition.mjs';
import {
  produceConfiguredFormalDomainQualificationExternalEvidence,
} from './formal-domain-qualification-external-evidence-composition.mjs';
import {
  verifyFormalDomainQualificationExternalEvidence,
} from '../../paper-domain/research/formal-domain-qualification-external-evidence.mjs';
import { queryAutomationReadiness } from './automation-readiness-query.mjs';

function genericVerificationContext(report) {
  return Object.freeze({
    autonomousResearchAssuranceAuthorityInspection:
      report.autonomousResearchAssuranceAuthorityInspection,
    externalResearchReplayReceiptVerifier:
      report.autonomousResearchCapabilityScopeInspection
        ?.externalResearchReplayReceiptVerifier || null,
    reviewerReceiptVerificationAuthority:
      report.autonomousResearchCapabilityScopeInspection
        ?.reviewerReceiptVerificationAuthority || null,
  });
}

function convergencePrerequisiteBlockers(report, expectedPaperId = null) {
  const agenda = report?.autonomousResearchAgendaAuthorityInspection;
  const experiment = report?.experimentIrExecutionAuthorityInspection;
  const venue = report?.autonomousResearchVenueRequirementAuthorityInspection;
  const researchAssurance = report?.autonomousResearchAssuranceAuthorityInspection;
  const blockers = [
    ...(agenda?.ready === true ? []
      : agenda?.blockers || ['generic_domain_convergence_agenda_authority_required']),
    ...(agenda?.priorArtClaimAlignmentReady === true ? []
      : ['generic_domain_convergence_prior_art_alignment_authority_required']),
    ...(experiment?.ready === true ? []
      : experiment?.blockers
        || ['generic_domain_convergence_experiment_execution_authority_required']),
    ...(venue?.ready === true ? []
      : venue?.blockers || ['generic_domain_convergence_venue_authority_required']),
    ...(researchAssurance?.ready === true ? []
      : researchAssurance?.blockers
        || ['generic_domain_convergence_research_assurance_authority_required']),
  ];
  const campaignIds = new Set([
    agenda?.campaignId || null,
    experiment?.campaignId || null,
    venue?.campaignId || null,
    researchAssurance?.campaignId || null,
  ]);
  const paperIds = new Set([
    agenda?.paperId || null,
    experiment?.paperId || null,
    venue?.paperId || null,
    researchAssurance?.paperId || null,
  ]);
  const campaignPlanHashes = new Set([
    agenda?.campaignPlanHash || null,
    experiment?.campaignPlanHash || null,
    venue?.campaignPlanHash || null,
    researchAssurance?.campaignPlanHash || null,
  ]);
  if (agenda?.ready === true && experiment?.ready === true && venue?.ready === true
    && researchAssurance?.ready === true
    && (campaignIds.size !== 1 || campaignIds.has(null)
      || paperIds.size !== 1 || paperIds.has(null)
      || campaignPlanHashes.size !== 1 || campaignPlanHashes.has(null))) {
    blockers.push('generic_domain_convergence_campaign_lineage_mismatch');
  }
  if (expectedPaperId && (paperIds.size !== 1 || !paperIds.has(expectedPaperId))) {
    blockers.push('generic_domain_convergence_paper_binding_mismatch');
  }
  return Object.freeze([...new Set(blockers)]);
}

export async function resolveFormalDomainQualificationEvidence({
  existingCoverageReceipt = null,
  existingExternalEvidence = null,
  coverageReceiptCurrent = false,
  qualificationRunner,
  externalEvidenceProducer,
  verifyExternalEvidence,
  qualificationArguments = {},
  externalEvidenceArguments = {},
} = {}) {
  if (typeof qualificationRunner !== 'function'
    || typeof externalEvidenceProducer !== 'function'
    || typeof verifyExternalEvidence !== 'function') {
    throw new Error('formal_domain_qualification_resolution_dependencies_required');
  }
  let coverageReceipt = existingCoverageReceipt;
  let qualificationPerformed = false;
  if (!coverageReceiptCurrent) {
    coverageReceipt = await qualificationRunner(qualificationArguments);
    qualificationPerformed = true;
  }
  let externalEvidence = existingExternalEvidence;
  let externalQualificationPerformed = false;
  if (!verifyExternalEvidence(externalEvidence, coverageReceipt)) {
    externalEvidence = await externalEvidenceProducer({
      ...externalEvidenceArguments,
      coverageReceipt,
    });
    externalQualificationPerformed = true;
  }
  if (!verifyExternalEvidence(externalEvidence, coverageReceipt)) {
    throw new Error('formal_domain_qualification_external_evidence_invalid');
  }
  return Object.freeze({
    coverageReceipt,
    externalEvidence,
    qualificationPerformed,
    externalQualificationPerformed,
  });
}

export function buildGenericDomainCapabilityEvidenceCandidate({
  report,
  formalDomainCoverageReceipt,
  formalDomainQualificationExternalEvidence,
  paperId = null,
} = {}) {
  const blockers = [...convergencePrerequisiteBlockers(report, paperId)];
  if (!verifyFormalDomainCoverageReceipt(formalDomainCoverageReceipt)) {
    blockers.push('generic_domain_convergence_formal_coverage_receipt_invalid');
  }
  const dynamicFormalExecutionAuthority = formalDomainCoverageReceipt
    ?.evidencePackages?.[0]?.formalProofSearchOperationReceipt
    ?.dynamicFormalExecutionAuthority || null;
  if (formalDomainCoverageReceipt?.dynamicFormalExecutionAuthorityHash
    !== dynamicFormalExecutionAuthority?.dynamicFormalExecutionAuthorityHash) {
    blockers.push('generic_domain_convergence_formal_execution_authority_mismatch');
  }
  if (blockers.length) {
    throw new Error(`generic_domain_capability_convergence_blocked:${[
      ...new Set(blockers),
    ].join(',')}`);
  }
  const candidate = Object.freeze({
    ...report.genericDomainCapabilityEvidenceCandidate,
    dynamicFormalExecutionAuthority,
    formalDomainCoverageReceipt,
    formalDomainQualificationExternalEvidence,
  });
  const researchAgendaProducerReceipt = report
    .autonomousResearchAgendaAuthorityInspection.researchAgendaProducerReceipt;
  const inspection = inspectGenericDomainCapabilityEvidenceBindings({
    evidence: candidate,
    researchAgendaProducerReceipt,
    genericDomainCapabilityVerificationContext: genericVerificationContext(report),
  });
  if (!inspection.ready) {
    throw new Error(`generic_domain_capability_convergence_binding_invalid:${
      inspection.blockers.join(',')}`);
  }
  return Object.freeze({ candidate, researchAgendaProducerReceipt, inspection });
}

export async function convergeGenericDomainCapabilityEvidence({
  root,
  runtimeRoot,
  paperId,
  environment = process.env,
  now = new Date(),
  spawnSyncImpl = undefined,
  formalDomainQualificationRunner = runConfiguredFormalDomainQualification,
  formalDomainExternalEvidenceProducer =
    produceConfiguredFormalDomainQualificationExternalEvidence,
} = {}) {
  if (!root || !runtimeRoot
    || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$/.test(String(paperId || ''))) {
    throw new Error('generic_domain_capability_convergence_roots_required');
  }
  const queryOptions = {
    root,
    runtimeRoot,
    environment,
    now,
    ...(spawnSyncImpl ? { spawnSyncImpl } : {}),
  };
  const { report } = queryAutomationReadiness(queryOptions);
  const prerequisiteBlockers = convergencePrerequisiteBlockers(report, paperId);
  if (prerequisiteBlockers.length) {
    throw new Error(`generic_domain_capability_convergence_blocked:${
      prerequisiteBlockers.join(',')}`);
  }
  let formalDomainCoverageReceipt = report.genericDomainCapabilityEvidenceCandidate
    .formalDomainCoverageReceipt;
  let qualificationPerformed = false;
  let currentFormalAuthorityReady = false;
  if (verifyFormalDomainCoverageReceipt(formalDomainCoverageReceipt)) {
    try {
      assertCurrentDynamicFormalExecutionAuthority(
        formalDomainCoverageReceipt.evidencePackages[0]
          .formalProofSearchOperationReceipt.dynamicFormalExecutionAuthority,
        {
          environment,
          ...(spawnSyncImpl ? { spawnSyncImpl } : {}),
        },
      );
      currentFormalAuthorityReady = true;
    } catch { currentFormalAuthorityReady = false; }
  }
  const verificationContext = genericVerificationContext(report);
  const resolvedFormalEvidence = await resolveFormalDomainQualificationEvidence({
    existingCoverageReceipt: formalDomainCoverageReceipt,
    existingExternalEvidence: report.genericDomainCapabilityEvidenceCandidate
      .formalDomainQualificationExternalEvidence,
    coverageReceiptCurrent: currentFormalAuthorityReady,
    qualificationRunner: formalDomainQualificationRunner,
    externalEvidenceProducer: formalDomainExternalEvidenceProducer,
    verifyExternalEvidence: (evidence, coverageReceipt) => (
      verifyFormalDomainQualificationExternalEvidence(evidence, {
        coverageReceipt,
        externalResearchReplayReceiptVerifier:
          verificationContext.externalResearchReplayReceiptVerifier,
        reviewerReceiptVerificationAuthority:
          verificationContext.reviewerReceiptVerificationAuthority,
      })
    ),
    qualificationArguments: {
      environment,
      ...(spawnSyncImpl ? { spawnSyncImpl } : {}),
    },
    externalEvidenceArguments: {
      root,
      runtimeRoot,
      environment,
      clock: Object.freeze({ now: () => new Date(now) }),
      ...(spawnSyncImpl ? { spawnSyncImpl } : {}),
    },
  });
  formalDomainCoverageReceipt = resolvedFormalEvidence.coverageReceipt;
  qualificationPerformed = resolvedFormalEvidence.qualificationPerformed;
  const formalDomainQualificationExternalEvidence =
    resolvedFormalEvidence.externalEvidence;
  const { externalQualificationPerformed } = resolvedFormalEvidence;
  const assembled = buildGenericDomainCapabilityEvidenceCandidate({
    report,
    formalDomainCoverageReceipt,
    formalDomainQualificationExternalEvidence,
    paperId,
  });
  const publication = composeGenericDomainCapabilityEvidencePublication({
    runtimeRoot,
    evidence: assembled.candidate,
    researchAgendaProducerReceipt: assembled.researchAgendaProducerReceipt,
    genericDomainCapabilityVerificationContext: verificationContext,
    expectedCurrentEvidenceHash:
      report.genericDomainCapabilityEvidenceInspection.ready === true
        ? report.genericDomainCapabilityEvidenceInspection.evidenceHash : null,
    environment,
    ...(spawnSyncImpl ? { spawnSyncImpl } : {}),
  });
  return Object.freeze({
    version: 1,
    kind: 'GenericDomainCapabilityEvidenceConvergenceReport',
    status: publication.published
      ? 'generic_domain_capability_evidence_converged'
      : 'generic_domain_capability_evidence_already_converged',
    ready: true,
    qualificationPerformed,
    externalQualificationPerformed,
    campaignId: report.autonomousResearchAgendaAuthorityInspection.campaignId,
    paperId: report.autonomousResearchAgendaAuthorityInspection.paperId,
    evidenceHash: publication.evidenceHash,
    path: publication.path,
    published: publication.published,
    externalActionPerformed: externalQualificationPerformed,
    blockers: Object.freeze([]),
  });
}
