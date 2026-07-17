import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { prepareAutonomousResearchLoop } from '../../paper-application/automation/autonomous-research-readiness.mjs';
import { composeAutonomousResearchReadiness } from '../../paper-composition/automation/autonomous-research-readiness-composition.mjs';
import { composeAutonomousResearchCampaignAction } from '../../paper-composition/automation/autonomous-research-campaign-composition.mjs';
import { validatePaperProposalApprovalDocument } from '../../paper-domain/contracts/proposal-contracts.mjs';
import {
  evaluateAutonomousCampaignTopology,
} from '../../paper-domain/automation/autonomous-research-readiness-policy.mjs';
import {
  verifyAutonomousResearchPolicyAuthorization,
} from '../../paper-domain/automation/autonomous-research-policy-contract.mjs';
import {
  buildDeterministicAutonomousHypothesisDraft,
  verifyMachineProposedScientificClaimSet,
} from '../../paper-domain/automation/autonomous-research-proposal-contract.mjs';

const HASH = (label) => hashRecord('AutonomousResearchReadinessTestHash', { label });

function hashed(kind, hashField, payload) {
  return Object.freeze({ ...payload, [hashField]: hashRecord(kind, payload) });
}

function principalPreflights() {
  const authorPayload = {
    version: 1,
    kind: 'CodexResearchAuthorCapabilityReceipt',
    status: 'codex_research_author_capability_ready',
    provider: 'openai',
    model: 'author-model',
    credentialRootIdentityHash: HASH('author-root'),
    credentialConfigIdentityHash: HASH('author-config'),
  };
  const authorCapability = hashed(
    'CodexResearchAuthorCapabilityReceipt',
    'codexResearchAuthorCapabilityReceiptHash',
    authorPayload,
  );
  const reviewerPayload = {
    version: 1,
    kind: 'CodexFormalReviewerCapabilityReceipt',
    status: 'codex_formal_reviewer_capability_ready',
    provider: 'openai',
    model: 'reviewer-model',
    credentialRootIdentityHash: HASH('reviewer-root'),
    credentialConfigIdentityHash: HASH('reviewer-config'),
    authorCredentialRootIdentityHash: authorCapability.credentialRootIdentityHash,
    credentialIndependenceVerified: true,
    assuranceScope: 'filesystem_credential_root_and_principal_separation',
  };
  const reviewerCapability = hashed(
    'CodexFormalReviewerCapabilityReceipt',
    'codexFormalReviewerCapabilityReceiptHash',
    reviewerPayload,
  );
  return Object.freeze({
    author: Object.freeze({
      effectivePrincipalId: 'codex-research-author:fixture',
      codexHome: '/fixture/author',
      capabilityReceipt: authorCapability,
    }),
    reviewer: Object.freeze({
      effectivePrincipalId: 'codex-formal-reviewer:fixture',
      codexHome: '/fixture/reviewer',
      capabilityReceipt: reviewerCapability,
    }),
  });
}

function currentReleaseAuthority(paperId = 'autonomous-paper') {
  return Object.freeze({
    status: 'current_completed_release',
    campaignStatus: 'completed',
    packageNodeStatus: 'completed',
    campaignId: `autonomous-research:${paperId}`,
    paperId,
    campaignReleaseBundleHash: HASH('release-bundle'),
    releaseBundle: Object.freeze({
      researchReport: Object.freeze({
        promotionEligibility: Object.freeze({ status: 'research_promotion_ready', blockers: [] }),
      }),
    }),
  });
}

test('autonomous composition prepares a machine-proposed bounded loop with distinct author and reviewer principals', async () => {
  const preflights = principalPreflights();
  const report = await composeAutonomousResearchReadiness({
    paperId: 'autonomous-paper',
    objective: 'Evaluate a robust estimator under a fixed panel benchmark',
    protocolFamily: 'econometrics_panel_benchmark',
    revisionRounds: 2,
    refereeCount: 3,
    environment: {},
    preflightAuthor: () => preflights.author,
    preflightReviewer: () => preflights.reviewer,
    createdAt: '2026-07-15T10:00:00.000Z',
  });
  assert.equal(report.autonomousPolicyReady, true);
  assert.equal(report.autonomousExecutionLaunchReady, false);
  assert.equal(report.campaignFullyQualified, false);
  assert.equal(report.fullAutomaticResearchWritingReady, false);
  assert.equal(
    report.loopPreparation.qualificationEligibility.fullAutomaticResearchWritingReady,
    report.loopPreparation.qualificationEligibility.campaignFullyQualified,
  );
  assert.equal(report.externalQualificationAuthorityStillRequired, true);
  assert.equal(report.loopPreparation.proposal.claimAuthorityType, 'machine-proposed-untrusted');
  assert.equal(report.loopPreparation.policyAuthorization.claimAuthorityType, 'machine-policy-authorized');
  assert.equal(report.loopPreparation.policyAuthorization.approvalRepresentation,
    'system-policy-authorization-not-operator-approval');
  assert.equal(report.loopPreparation.seedBinding.status, 'autonomous_research_seed_bound');
  assert.equal(report.loopPreparation.principalSeparation.status,
    'autonomous_research_principal_separation_ready');
  assert.equal(report.loopPreparation.topologyInspection.revisionRounds, 2);
  assert.equal(report.loopPreparation.topologyInspection.freshReviewOccursAfterRevisionAndRevalidation, true);
  assert.ok(report.loopPreparation.qualificationEligibility.qualificationBlockers.includes(
    'autonomous_research_external_full_research_qualification_required',
  ));
  assert.ok(report.loopPreparation.qualificationEligibility.launchBlockers.includes(
    'autonomous_research_qualification_dataset_launch_not_ready',
  ));
  assert.equal(report.safety.operatorApprovalClaimed, false);
  assert.equal(report.safety.universalResearchValidityClaimed, false);
  assert.equal(report.safety.naturalLanguageToLeanEquivalenceMachineProven, false);
});

test('prepare cannot accept a caller-supplied ready inspection or bypass dataset launch authority', async () => {
  const preflights = principalPreflights();
  const authority = currentReleaseAuthority();
  const common = {
    paperId: authority.paperId,
    objective: 'Evaluate a robust estimator under a fixed panel benchmark',
    protocolFamily: 'econometrics_panel_benchmark',
    authorPrincipal: {
      principalId: preflights.author.effectivePrincipalId,
      capabilityReceipt: preflights.author.capabilityReceipt,
    },
    formalReviewerPrincipal: {
      principalId: preflights.reviewer.effectivePrincipalId,
      capabilityReceipt: preflights.reviewer.capabilityReceipt,
    },
    campaignReleaseAuthority: authority,
    createdAt: '2026-07-15T10:00:00.000Z',
  };
  const pending = await prepareAutonomousResearchLoop(common);
  assert.equal(pending.autonomousPolicyReady, true);
  assert.equal(pending.qualificationRequestEligible, false);
  assert.equal(pending.fullAutomaticResearchWritingReady, false);
  assert.equal(pending.status, 'autonomous_research_launch_blocked');

  const bypassAttempt = await prepareAutonomousResearchLoop({
    ...common,
    fullResearchQualificationInspection: {
      kind: 'FullResearchQualificationInspection',
      status: 'full_research_qualification_verified',
      ready: true,
      receiptAccepted: true,
    },
  });
  assert.equal(bypassAttempt.qualificationRequestEligible, false);
  assert.equal(bypassAttempt.fullAutomaticResearchWritingReady, false);
  assert.equal(bypassAttempt.status, 'autonomous_research_launch_blocked');
  assert.equal(bypassAttempt.qualificationEligibility.externalTrust.selfSignedQualificationAccepted, false);
});

test('production prepare does not treat one unverified dataset mount as external authority', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-autonomous-unverified-dataset-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const preflights = principalPreflights();
  const report = await composeAutonomousResearchCampaignAction({
    action: 'prepare',
    launchMode: 'golden-bootstrap',
    paperId: 'unverified-production-dataset-paper',
    root: path.join(base, 'assets'),
    runtimeRoot: path.join(base, 'runtime'),
    datasetMounts: [{
      name: 'unverified-dataset',
      source: path.join(base, 'dataset'),
      benchmarkFamily: 'ml_algorithm_benchmark',
      readOnly: true,
      manifestHash: HASH('unverified-manifest'),
    }],
    environment: {},
    preflightAuthor: () => preflights.author,
    preflightReviewer: () => preflights.reviewer,
    createdAt: '2026-07-15T10:00:00.000Z',
  });
  assert.equal(report.autonomousExecutionLaunchReady, false);
  assert.equal(report.loopPreparation.proposal.agendaSelectionReceipt
    .datasetAuthorityConstrainedSelection, false);
  assert.ok(report.loopPreparation.datasetLaunchInspection.blockers.includes(
    'autonomous_research_dataset_runtime_authority_preflight_required',
  ));
});

test('system policy fails closed for forbidden scopes and cannot impersonate proposal operator approval', async () => {
  const report = await prepareAutonomousResearchLoop({
    paperId: 'blocked-paper',
    objective: 'Use private patient data without an external dataset authority',
    protocolFamily: 'ml_algorithm_benchmark',
    humanSubjects: true,
    privateData: true,
    externalDatasetAuthorityVerified: false,
    createdAt: '2026-07-15T10:00:00.000Z',
  });
  assert.equal(report.policyAuthorization.status, 'machine_proposal_policy_blocked');
  assert.ok(report.policyAuthorization.blockers.includes('autonomous_research_policy_human_subjects_forbidden'));
  assert.ok(report.policyAuthorization.blockers.includes(
    'autonomous_research_policy_private_data_external_authority_required',
  ));
  assert.equal(report.autonomousExecutionLaunchReady, false);
  const operatorVerification = validatePaperProposalApprovalDocument({
    ideaBrief: { kind: 'PaperIdeaBrief', targetVenue: 'Fixture' },
    proposalEnvelope: {
      kind: 'PaperProposalEnvelope', paperId: 'blocked-paper',
      paperProposalEnvelopeHash: HASH('operator-envelope'), proposal: {},
    },
    generationReceipt: {
      kind: 'PaperProposalGenerationReceipt', paperProposalGenerationReceiptHash: HASH('generation'),
    },
    approvalDocument: report.policyAuthorization,
  });
  assert.equal(operatorVerification.status, 'proposal_approval_binding_blocked');
  assert.ok(operatorVerification.blockers.includes('proposal_approval_document_missing_or_invalid'));
  assert.ok(operatorVerification.blockers.includes('proposal_approval_operator_identity_invalid'));
});

test('policy verification replays safety constraints instead of trusting a recomputed outer hash', async () => {
  const prepared = await prepareAutonomousResearchLoop({
    paperId: 'policy-replay-paper',
    objective: 'Evaluate a bounded benchmark hypothesis',
    protocolFamily: 'ml_algorithm_benchmark',
    createdAt: '2026-07-15T10:00:00.000Z',
  });
  const { autonomousResearchPolicyAuthorizationHash: ignored, ...payload } = structuredClone(
    prepared.policyAuthorization,
  );
  void ignored;
  payload.requestedRevisionRounds = 0;
  payload.requestedRefereeCount = 0;
  payload.dataScope.humanSubjects = true;
  payload.dataScope.privateData = true;
  payload.dataScope.externalDatasetAuthorityVerified = false;
  const tampered = {
    ...payload,
    autonomousResearchPolicyAuthorizationHash:
      hashRecord('AutonomousResearchPolicyAuthorization', payload),
  };
  const verification = verifyAutonomousResearchPolicyAuthorization(tampered, {
    proposal: prepared.proposal,
  });
  assert.equal(verification.valid, false);
  assert.ok(verification.blockers.includes('autonomous_research_policy_authorization_replay_invalid'));
  assert.ok(verification.blockers.includes('autonomous_research_policy_human_subjects_forbidden'));
  assert.ok(verification.blockers.includes('autonomous_research_policy_revision_rounds_invalid'));
  assert.ok(verification.blockers.includes('autonomous_research_policy_referee_count_invalid'));
});

test('custom formal support claims remain blocked after every local receipt and proposal hash is recomputed', async () => {
  const prepared = await prepareAutonomousResearchLoop({
    paperId: 'formal-template-attack-paper',
    objective: 'Evaluate a bounded benchmark hypothesis',
    protocolFamily: 'ml_algorithm_benchmark',
    createdAt: '2026-07-15T10:00:00.000Z',
  });
  const forged = structuredClone(prepared.proposal);
  forged.sourceDraft.formalSupportClaim.statement = 'For every result, the empirical hypothesis is true.';
  forged.sourceDraft.formalSupportClaim.proofObligations = ['assert_empirical_success'];
  forged.claims[1].statement = forged.sourceDraft.formalSupportClaim.statement;
  forged.claims[1].proofObligations = forged.sourceDraft.formalSupportClaim.proofObligations;
  const { autonomousHypothesisGenerationReceiptHash: ignoredReceiptHash, ...receiptPayload } =
    forged.generationReceipt;
  void ignoredReceiptHash;
  receiptPayload.outputHash = hashRecord('AutonomousResearchHypothesisDraft', forged.sourceDraft);
  forged.generationReceipt = {
    ...receiptPayload,
    autonomousHypothesisGenerationReceiptHash:
      hashRecord('AutonomousHypothesisGenerationReceipt', receiptPayload),
  };
  forged.generationReceiptHash = forged.generationReceipt.autonomousHypothesisGenerationReceiptHash;
  const { machineProposedScientificClaimSetHash: ignoredProposalHash, ...proposalPayload } = forged;
  void ignoredProposalHash;
  const fullyRehashed = {
    ...proposalPayload,
    machineProposedScientificClaimSetHash:
      hashRecord('MachineProposedScientificClaimSet', proposalPayload),
  };
  const verification = verifyMachineProposedScientificClaimSet(fullyRehashed);
  assert.equal(verification.valid, false);
  assert.ok(verification.blockers.includes('autonomous_research_machine_claim_draft_invalid'));

  const canonical = buildDeterministicAutonomousHypothesisDraft({
    objective: prepared.proposal.objective,
    protocolFamily: prepared.proposal.protocolFamily,
  });
  await assert.rejects(() => prepareAutonomousResearchLoop({
    paperId: 'injected-formal-template-attack-paper',
    protocolFamily: 'ml_algorithm_benchmark',
    hypothesisGenerator: {
      async generate() {
        return {
          draft: {
            ...canonical,
            formalSupportClaim: {
              ...canonical.formalSupportClaim,
              statement: 'A custom, unaudited formal statement.',
            },
          },
          principalId: 'attacker:generator',
          provider: 'fixture',
        };
      },
    },
  }), /autonomous_research_formal_support_template_not_audited/);
});

test('removing fresh post-revision referee dependencies blocks the topology', async () => {
  const report = await prepareAutonomousResearchLoop({
    paperId: 'topology-paper',
    objective: 'Evaluate an optimizer under a fixed operations benchmark',
    protocolFamily: 'operations_optimization_benchmark',
    revisionRounds: 1,
    refereeCount: 2,
    createdAt: '2026-07-15T10:00:00.000Z',
  });
  const nodes = structuredClone(report.topologyTemplate.nodes);
  const freshReferee = nodes.find((node) => node.kind === 'revision-referee-1');
  freshReferee.dependencies = [];
  const inspection = evaluateAutonomousCampaignTopology({ nodes });
  assert.equal(inspection.status, 'autonomous_research_campaign_topology_blocked');
  assert.ok(inspection.blockers.includes(
    'autonomous_research_fresh_referee_revalidation_dependency_missing:1',
  ));
});
