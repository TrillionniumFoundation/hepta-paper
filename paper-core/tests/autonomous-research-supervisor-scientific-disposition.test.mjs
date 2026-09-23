import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  createAutonomousResearchSupervisorStateRepository,
} from '../../paper-adapters/automation/autonomous-research-supervisor-state-repository.mjs';
import {
  canonicalCampaignDefinition,
} from '../../paper-adapters/persistence/campaign-definition-codec.mjs';
import { createDefaultPaperStore } from '../../paper-adapters/persistence/store-provider.mjs';
import { createSqliteCampaignStore } from '../../paper-adapters/persistence/sqlite-campaign-store.mjs';
import {
  createAutonomousResearchSupervisor,
} from '../../paper-application/automation/autonomous-research-supervisor.mjs';
import {
  runPaperCampaign,
} from '../../paper-application/automation/campaign-engine.mjs';
import {
  autonomousResearchSupervisorDispatchDecision,
  autonomousResearchSupervisorNextSchedule,
} from '../../paper-application/automation/autonomous-research-supervisor-readiness-policy.mjs';
import {
  compactAutonomousResearchSupervisorOutcome,
} from '../../paper-application/automation/autonomous-research-supervisor-progress.mjs';
import {
  AUTONOMOUS_RESEARCH_SCIENTIFIC_DISPOSITION_TYPES,
  resolveAutonomousResearchScientificDisposition,
  verifyAutonomousResearchScientificDispositionReceipt,
} from '../../paper-domain/automation/autonomous-research-scientific-disposition-contract.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const H = (label) => hashRecord('AutonomousScientificDispositionTestHash', { label });
const NOW = new Date('2026-07-23T01:00:00.000Z');

function campaign(suffix, status, overrides = {}) {
  const paperId = `scientific-disposition-${suffix}`;
  const campaignId = `autonomous-research:${paperId}`;
  return {
    campaignId,
    paperId,
    status,
    effectiveStatus: status,
    stopReason: null,
    maxRounds: 2,
    costKnown: true,
    costUsd: 1,
    spec: {
      campaignPlanHash: H(`plan:${suffix}`),
      maxRounds: 2,
      budgets: { maxCostUsd: 10 },
      autonomousResearchPreparation: {
        proposal: { paperId },
      },
    },
    ...overrides,
  };
}

function negativeNodes(suffix, replayVerdict = 'negative') {
  return [{
    nodeId: `${suffix}:empirical`,
    kind: 'empirical-python',
    status: 'completed',
    roundIndex: 0,
    result: { status: 'empirical_execution_completed', scientificVerdict: 'negative' },
    resultSha256: H(`${suffix}:empirical-result`),
    failureClass: null,
    failureSha256: null,
  }, {
    nodeId: `${suffix}:empirical-replay`,
    kind: 'empirical-reproduce-python',
    status: 'completed',
    roundIndex: 0,
    result: { status: 'empirical_execution_completed', scientificVerdict: replayVerdict },
    resultSha256: H(`${suffix}:empirical-replay-result`),
    failureClass: null,
    failureSha256: null,
  }];
}

function proofExhaustionNode(suffix, overrides = {}) {
  return {
    nodeId: `${suffix}:formal-author`,
    kind: 'formal-author',
    status: 'failed_terminal',
    roundIndex: 0,
    result: null,
    resultSha256: null,
    failureClass:
      'campaign_formal_verification_blocked:formal_proof_search_candidate_evidence_invalid',
    failureSha256: H(`${suffix}:formal-failure`),
    failureDetail: {
      receiptKind: 'FormalProofSearchFailureCertificate',
      receiptStatus: 'formal_proof_search_exhausted',
      receiptHash: H(`${suffix}:formal-certificate`),
    },
    ...overrides,
  };
}

function reviewNonConvergenceNode(suffix, accepted = false) {
  return {
    nodeId: `${suffix}:convergence`,
    kind: 'convergence',
    status: 'completed',
    roundIndex: 2,
    result: { status: 'campaign_convergence_evaluated', accepted },
    resultSha256: H(`${suffix}:convergence-result`),
    failureClass: null,
    failureSha256: null,
  };
}

function explicitRejectionDelivery(value) {
  const statePayload = {
    version: 1,
    kind: 'AutonomousSubmissionDeliveryStateReceipt',
    status: 'autonomous_submission_delivery_explicit_failure',
    campaignId: value.campaignId,
    paperId: value.paperId,
    requestHash: H(`submission-request:${value.paperId}`),
    venueId: 'venue:scientific-disposition',
    state: 'explicit_failure',
    terminal: true,
    failure: { code: 'portal_submission_rejected', httpStatus: 422 },
  };
  const deliveryStateReceipt = Object.freeze({
    ...statePayload,
    autonomousSubmissionDeliveryStateReceiptHash: hashRecord(
      'AutonomousSubmissionDeliveryStateReceipt',
      statePayload,
    ),
  });
  return Object.freeze({
    status: 'autonomous_submission_delivery_explicit_failure',
    terminal: true,
    lookupRequired: false,
    deliveryStateReceipt,
    externalActionPerformed: false,
  });
}

test('negative empirical results settle only with matching original and replay evidence', () => {
  const value = campaign('negative', 'completed');
  const receipt = resolveAutonomousResearchScientificDisposition({
    campaign: value,
    nodes: negativeNodes('negative'),
    now: NOW,
  });
  assert.equal(receipt.dispositionType,
    AUTONOMOUS_RESEARCH_SCIENTIFIC_DISPOSITION_TYPES.NEGATIVE_RESULT);
  assert.equal(receipt.nextAction, 'publish-negative-result');
  assert.equal(receipt.scientificSuccess, false);
  assert.equal(receipt.claimPromotionAuthorized, false);
  assert.equal(receipt.automaticBudgetExpansionPerformed, false);
  assert.equal(receipt.successorCampaignCreated, false);
  assert.equal(verifyAutonomousResearchScientificDispositionReceipt(receipt), true);

  assert.equal(resolveAutonomousResearchScientificDisposition({
    campaign: value,
    nodes: negativeNodes('negative-mismatch', 'positive'),
    now: NOW,
  }), null);
  assert.equal(resolveAutonomousResearchScientificDisposition({
    campaign: value,
    nodes: negativeNodes('negative-missing-replay').slice(0, 1),
    now: NOW,
  }), null);
  assert.equal(resolveAutonomousResearchScientificDisposition({
    campaign: value,
    nodes: negativeNodes('negative-submission-pending'),
    submissionRequired: true,
    now: NOW,
  }), null);
});

test('proof exhaustion and review non-convergence produce bounded non-success settlements', () => {
  const proofCampaign = campaign('proof', 'failed');
  const proof = resolveAutonomousResearchScientificDisposition({
    campaign: proofCampaign,
    nodes: [proofExhaustionNode('proof')],
    now: NOW,
  });
  assert.equal(proof.dispositionType,
    AUTONOMOUS_RESEARCH_SCIENTIFIC_DISPOSITION_TYPES.FORMAL_PROOF_SEARCH_EXHAUSTED);
  assert.equal(proof.nextAction, 'retire-claim');
  assert.equal(verifyAutonomousResearchScientificDispositionReceipt(proof), true);
  assert.equal(resolveAutonomousResearchScientificDisposition({
    campaign: proofCampaign,
    nodes: [proofExhaustionNode('proof-forged', {
      failureDetail: {
        receiptKind: 'FormalProofSearchFailureCertificate',
        receiptStatus: 'formal_proof_search_exhausted',
        receiptHash: 'sha256:forged',
      },
    })],
    now: NOW,
  }), null);

  const reviewCampaign = campaign('review', 'stopped', {
    stopReason: 'referee_convergence_not_reached_within_budget',
  });
  const review = resolveAutonomousResearchScientificDisposition({
    campaign: reviewCampaign,
    nodes: [reviewNonConvergenceNode('review')],
    now: NOW,
  });
  assert.equal(review.dispositionType,
    AUTONOMOUS_RESEARCH_SCIENTIFIC_DISPOSITION_TYPES.REVIEW_NON_CONVERGENCE);
  assert.equal(review.nextAction, 'retarget-hypothesis');
  assert.equal(verifyAutonomousResearchScientificDispositionReceipt(review), true);
  assert.equal(resolveAutonomousResearchScientificDisposition({
    campaign: reviewCampaign,
    nodes: [reviewNonConvergenceNode('review-forged', true)],
    now: NOW,
  }), null);
});

test('campaign failure persistence retains the formal exhaustion certificate hash', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-proof-disposition-lineage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let milliseconds = NOW.getTime();
  const clock = {
    now: () => new Date(milliseconds),
    nowIso: () => new Date(milliseconds += 1).toISOString(),
  };
  const store = createDefaultPaperStore({ root, runtimeRoot: root });
  const campaignStore = createSqliteCampaignStore({ store, clock });
  const value = campaign('proof-persistence', 'running');
  const nodeId = `${value.campaignId}:formal-verify`;
  const planPayload = canonicalCampaignDefinition({
    version: 2,
    kind: 'PaperCampaignPlan',
    campaignId: value.campaignId,
    paperId: value.paperId,
    sourceWorkspace: root,
    maxRounds: 1,
    budgets: {
      maxWallTimeMs: 60_000,
      maxAgentCalls: 1,
      maxCpuJobs: 1,
      maxGpuJobs: 0,
      maxTokenCount: 100,
      maxCostUsd: 1,
      maxMemoryMiB: 4096,
    },
    autonomousResearchPreparation: value.spec.autonomousResearchPreparation,
    nodes: [{
      nodeId,
      kind: 'formal-verify',
      roundIndex: 0,
      dependencies: [],
      priority: 10,
      maxAttempts: 1,
    }],
  });
  const plan = {
    ...planPayload,
    campaignPlanHash: hashRecord('PaperCampaignPlan', planPayload),
  };
  campaignStore.createCampaign(plan);
  const certificateHash = H('persisted-formal-failure-certificate');
  const result = await runPaperCampaign({
    campaignId: value.campaignId,
    campaignStore,
    concurrency: 1,
    pollMs: 1,
    clock,
    scheduler: {
      async sleep() {},
      setInterval(callback, millisecondsDelay) {
        return setInterval(callback, millisecondsDelay);
      },
      clearInterval(handle) { clearInterval(handle); },
      unref(handle) { handle.unref?.(); },
    },
    idGenerator: { next: () => 'scientific-disposition-proof-attempt' },
    executor: { async execute() {
      const error = new Error(
        'campaign_formal_verification_blocked:formal_proof_search_candidate_evidence_invalid',
      );
      error.retryable = false;
      error.receipt = {
        version: 1,
        kind: 'FormalProofSearchFailureCertificate',
        status: 'formal_proof_search_exhausted',
        blockers: ['formal_proof_search_exhausted_without_kernel_verified_candidate'],
        formalProofSearchFailureCertificateHash: certificateHash,
      };
      throw error;
    } },
  });
  assert.equal(result.campaign.status, 'failed');
  assert.equal(result.nodes[0].failureDetail.receiptHash, certificateHash);
  const receipt = resolveAutonomousResearchScientificDisposition({
    campaign: result.campaign,
    nodes: result.nodes,
    now: NOW,
  });
  assert.equal(receipt.dispositionType,
    AUTONOMOUS_RESEARCH_SCIENTIFIC_DISPOSITION_TYPES.FORMAL_PROOF_SEARCH_EXHAUSTED);
  assert.equal(verifyAutonomousResearchScientificDispositionReceipt(receipt), true);
});

test('submission rejection settles only from a hash-bound explicit terminal delivery state', () => {
  const value = campaign('submission', 'completed');
  const delivery = explicitRejectionDelivery(value);
  const receipt = resolveAutonomousResearchScientificDisposition({
    campaign: value,
    submissionRequired: true,
    submissionDelivery: delivery,
    now: NOW,
  });
  assert.equal(receipt.dispositionType,
    AUTONOMOUS_RESEARCH_SCIENTIFIC_DISPOSITION_TYPES.SUBMISSION_EXPLICIT_REJECTION);
  assert.equal(receipt.nextAction, 'venue-retarget-or-terminal-scientific-outcome');
  assert.equal(verifyAutonomousResearchScientificDispositionReceipt(receipt), true);

  const forged = structuredClone(delivery);
  forged.deliveryStateReceipt.failure.code = 'forged-success';
  assert.equal(resolveAutonomousResearchScientificDisposition({
    campaign: value,
    submissionRequired: true,
    submissionDelivery: forged,
    now: NOW,
  }), null);
});

test('supervisor readiness and persisted compact outcomes accept only verified dispositions', () => {
  const value = campaign('readiness', 'completed');
  const receipt = resolveAutonomousResearchScientificDisposition({
    campaign: value,
    nodes: negativeNodes('readiness'),
    now: NOW,
  });
  const decision = autonomousResearchSupervisorDispatchDecision({
    campaign: value,
    scientificDispositionReceipt: receipt,
  });
  assert.equal(decision.settle, true);
  assert.equal(decision.reason, receipt.settlementReason);
  const schedule = autonomousResearchSupervisorNextSchedule({
    campaign: value,
    scientificDispositionReceipt: receipt,
    now: NOW,
  });
  assert.equal(schedule.settled, true);
  const compact = compactAutonomousResearchSupervisorOutcome({
    status: receipt.status,
    campaign: { status: value.status },
    scientificDispositionReceipt: receipt,
  });
  assert.equal(compact.scientificDispositionReceiptHash,
    receipt.autonomousResearchScientificDispositionReceiptHash);

  const forged = structuredClone(receipt);
  forged.claimPromotionAuthorized = true;
  assert.deepEqual(autonomousResearchSupervisorDispatchDecision({
    campaign: value,
    scientificDispositionReceipt: forged,
  }), {
    block: true,
    reason: 'autonomous_research_scientific_disposition_receipt_invalid',
  });
  assert.throws(() => compactAutonomousResearchSupervisorOutcome({
    scientificDispositionReceipt: forged,
  }), /scientific_disposition_invalid/);
});

test('durable supervisor state rejects a tampered scientific disposition receipt', (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-disposition-tamper-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const repository = createAutonomousResearchSupervisorStateRepository({ runtimeRoot });
  t.after(() => repository.close());
  const value = campaign('tamper', 'completed');
  const receipt = resolveAutonomousResearchScientificDisposition({
    campaign: value,
    nodes: negativeNodes('tamper'),
    now: NOW,
  });
  repository.registerCampaign({
    campaignId: value.campaignId,
    paperId: value.paperId,
    now: NOW,
  });
  const lease = repository.tryAcquireCampaignLease({
    campaignId: value.campaignId,
    ownerId: 'supervisor:disposition-tamper',
    now: NOW,
  });
  repository.finishDispatch({
    lease,
    successful: true,
    settled: true,
    costKnown: true,
    outcome: compactAutonomousResearchSupervisorOutcome({
      status: receipt.status,
      campaign: { status: value.status },
      scientificDispositionReceipt: receipt,
    }),
    now: NOW,
  });
  const database = new DatabaseSync(repository.databasePath);
  try {
    const row = database.prepare(`SELECT last_outcome_json
      FROM autonomous_research_supervisor_campaign WHERE campaign_id=?`)
      .get(value.campaignId);
    const tampered = JSON.parse(row.last_outcome_json);
    tampered.scientificDispositionReceipt.claimPromotionAuthorized = true;
    database.prepare(`UPDATE autonomous_research_supervisor_campaign
      SET last_outcome_json=? WHERE campaign_id=?`)
      .run(JSON.stringify(tampered), value.campaignId);
  } finally {
    database.close();
  }
  assert.throws(() => repository.getCampaign(value.campaignId),
    /autonomous_research_supervisor_outcome_state_invalid/);
});

test('resident settles negative, proof-exhausted, and non-converged campaigns before retry actions', async (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-scientific-settlement-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const repository = createAutonomousResearchSupervisorStateRepository({ runtimeRoot });
  t.after(() => repository.close());
  const campaigns = [
    campaign('resident-negative', 'completed'),
    campaign('resident-proof', 'failed'),
    campaign('resident-review', 'stopped', {
      stopReason: 'referee_convergence_not_reached_within_budget',
    }),
  ];
  const nodes = new Map([
    [campaigns[0].campaignId, negativeNodes('resident-negative')],
    [campaigns[1].campaignId, [proofExhaustionNode('resident-proof')]],
    [campaigns[2].campaignId, [reviewNonConvergenceNode('resident-review')]],
  ]);
  let downstreamActionCount = 0;
  const supervisor = createAutonomousResearchSupervisor({
    campaignStore: {
      listCampaigns({ offset = 0 } = {}) { return offset === 0 ? campaigns : []; },
      getCampaign(campaignId) {
        return campaigns.find((candidate) => candidate.campaignId === campaignId) || null;
      },
      listNodes(campaignId) { return nodes.get(campaignId) || []; },
    },
    stateRepository: repository,
    async reconcileRuntime() { return null; },
    async ensureRuntimeReproducibility() { downstreamActionCount += 1; return null; },
    async readQualificationState() { downstreamActionCount += 1; return null; },
    async runProviderCanary() { downstreamActionCount += 1; return null; },
    async renewQualification() { downstreamActionCount += 1; return null; },
    async dispatchCampaign() { downstreamActionCount += 1; return null; },
    clock: { now: () => NOW },
    scheduler: {
      async sleep() {}, setInterval() { return {}; }, clearInterval() {}, unref() {},
    },
    ownerId: 'supervisor:scientific-settlement',
  });
  const cycle = await supervisor.runCycle();
  assert.equal(cycle.results.length, 3);
  assert.equal(cycle.results.every((result) => result.status === 'settled'), true);
  assert.deepEqual(new Set(cycle.results.map((result) => result.reason)), new Set([
    'autonomous_research_negative_result_settled',
    'autonomous_research_formal_proof_search_exhausted_settled',
    'autonomous_research_review_non_convergence_settled',
  ]));
  assert.equal(downstreamActionCount, 0);
  assert.equal(repository.listCampaigns({ disposition: 'settled' }).length, 3);
  for (const state of repository.listCampaigns({ disposition: 'settled' })) {
    assert.equal(verifyAutonomousResearchScientificDispositionReceipt(
      state.lastOutcome.scientificDispositionReceipt,
    ), true);
    assert.equal(state.lastOutcome.scientificDispositionReceipt.scientificSuccess, false);
  }
});

test('resident converts an explicit portal rejection into settled disposition', async (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-submission-rejection-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const repository = createAutonomousResearchSupervisorStateRepository({ runtimeRoot });
  t.after(() => repository.close());
  const value = campaign('resident-submission', 'completed');
  value.spec.autonomousResearchPreparation.venueProfileSelection = {
    profile: { externalSubmissionEnabled: true },
  };
  const delivery = explicitRejectionDelivery(value);
  let runtimeActionCount = 0;
  const supervisor = createAutonomousResearchSupervisor({
    campaignStore: {
      listCampaigns({ offset = 0 } = {}) { return offset === 0 ? [value] : []; },
      getCampaign() { return value; },
      listNodes() { return []; },
    },
    stateRepository: repository,
    async reconcileRuntime() { return null; },
    async recoverAutonomousSubmission() {
      return {
        required: true,
        explicitFailure: true,
        terminal: true,
        ready: false,
        stateCount: 1,
        status: 'autonomous_research_submission_recovery_explicit_failure',
        delivery,
        externalActionPerformed: false,
      };
    },
    async ensureRuntimeReproducibility() { runtimeActionCount += 1; return null; },
    async readQualificationState() { runtimeActionCount += 1; return null; },
    async runProviderCanary() { runtimeActionCount += 1; return null; },
    async renewQualification() { runtimeActionCount += 1; return null; },
    async dispatchCampaign() { runtimeActionCount += 1; return null; },
    clock: { now: () => NOW },
    scheduler: {
      async sleep() {}, setInterval() { return {}; }, clearInterval() {}, unref() {},
    },
    ownerId: 'supervisor:submission-rejection',
  });
  const cycle = await supervisor.runCycle();
  assert.equal(cycle.results[0].status, 'settled');
  assert.equal(cycle.results[0].reason,
    'autonomous_research_submission_rejection_settled');
  assert.equal(cycle.results[0].scientificDispositionReceipt.dispositionType,
    AUTONOMOUS_RESEARCH_SCIENTIFIC_DISPOSITION_TYPES.SUBMISSION_EXPLICIT_REJECTION);
  assert.equal(runtimeActionCount, 0);
  const state = repository.getCampaign(value.campaignId);
  assert.equal(state.disposition, 'settled');
  assert.equal(state.terminalReason, null);
});
