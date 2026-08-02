import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  createAutonomousExternalQualificationState,
} from '../../paper-domain/automation/autonomous-external-qualification-state-contract.mjs';
import {
  createAutonomousResearchQualificationStateRepository,
} from '../../paper-adapters/automation/autonomous-research-qualification-state-repository.mjs';
import {
  createAutonomousResearchSupervisorStateRepository,
} from '../../paper-adapters/automation/autonomous-research-supervisor-state-repository.mjs';
import {
  createAutonomousResearchSupervisor,
  selectFairAutonomousCampaignWindow,
} from '../../paper-application/automation/autonomous-research-supervisor.mjs';
import {
  autonomousResearchSupervisorDispatchDecision,
  autonomousResearchSupervisorNextSchedule,
} from '../../paper-application/automation/autonomous-research-supervisor-readiness-policy.mjs';
import {
  createFencedAutonomousResearchProviderCanary,
  resolveAutonomousResearchSupervisorDispatchPolicy,
} from '../../paper-composition/automation/autonomous-research-supervisor-composition.mjs';
import {
  campaignWorkerOptions,
  configuredMaximumCost,
  providerBoundReadinessEnvironment,
  qualificationRetryBoundToExternalCostAuthority,
  requireExistingProductionPricingEnvelope,
} from '../../paper-composition/automation/autonomous-research-qualification-composition.mjs';
import {
  resolvePersistedAutonomousResearchLaunchMode,
} from '../../paper-domain/automation/autonomous-research-launch-mode-policy.mjs';
import {
  requestExternalResearchQualification,
} from '../../paper-application/automation/external-qualification-recovery.mjs';
import { H, campaign, readinessLifecycle } from './support/autonomous-research-supervisor-fixture.mjs';

test('fair campaign windows eventually cover more campaigns than one cycle limit', () => {
  const campaigns = Array.from({ length: 250 }, (_, index) => ({
    campaignId: `autonomous-research:fair-${String(index).padStart(3, '0')}`,
    paperId: `fair-${index}`,
    effectiveStatus: 'running',
    spec: {
      autonomousResearchPreparation: {
        proposal: { paperId: `fair-${index}` },
      },
    },
  }));
  const visited = new Set();
  let cursor = null;
  for (let cycle = 0; cycle < 3; cycle += 1) {
    const window = selectFairAutonomousCampaignWindow(campaigns, {
      afterCampaignId: cursor,
      limit: 100,
    });
    window.campaigns.forEach((campaign) => visited.add(campaign.campaignId));
    cursor = window.nextCursor;
  }
  assert.equal(visited.size, 250);
});

function qualificationState(generation, { attemptCount = 0, totalAttemptCount = 0 } = {}) {
  return createAutonomousExternalQualificationState(Object.freeze({
    version: 4,
    kind: 'AutonomousExternalQualificationState',
    generation,
    campaignId: 'autonomous-research:sqlite-cas-paper',
    paperId: 'sqlite-cas-paper',
    campaignReleaseBundleHash: H('release'),
    receipt: null,
    verifiedInspection: null,
    recovery: Object.freeze({
      status: 'qualification_retry_scheduled',
      recoveryIdentityHash: H('recovery'),
      recoveryConfigurationIdentityHash: H('recovery-configuration'),
      retryPolicyIdentityHash: H('retry-policy'),
      configurationIdentityHash: H('configuration'),
      trustIdentityHash: H('trust'),
      clientServiceIdentityHash: H('client'),
      verifierServiceIdentityHash: H('verifier'),
      terminalFailure: null,
      cycle: 1,
      epoch: 1,
      maximumEpochs: 4,
      attemptCount,
      maximumAttempts: 4,
      totalAttemptCount,
      maximumTotalAttempts: 16,
      maximumTotalCostUsd: 10,
      reservedCostUsd: totalAttemptCount * 0.05,
      attemptReservationCostUsd: 0.05,
      firstAttemptAt: '2026-07-16T00:00:00.000Z',
      nextAttemptAt: '2026-07-16T00:00:01.000Z',
      deadlineAt: '2026-07-16T01:00:00.000Z',
      globalFirstAttemptAt: '2026-07-16T00:00:00.000Z',
      globalDeadlineAt: '2026-07-17T00:00:00.000Z',
    }),
  }));
}

test('qualification state uses SQLite CAS and a renewable stale-recoverable lease', (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-qualification-cas-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const first = createAutonomousResearchQualificationStateRepository({
    runtimeRoot,
    paperId: 'sqlite-cas-paper',
  });
  const second = createAutonomousResearchQualificationStateRepository({
    runtimeRoot,
    paperId: 'sqlite-cas-paper',
  });
  t.after(() => { first.close(); second.close(); });

  const generationOne = qualificationState(1);
  first.compareAndSwapExternalQualificationState({ state: generationOne });
  assert.deepEqual(second.readExternalQualificationState(), generationOne);
  const staleHash = generationOne.autonomousExternalQualificationStateHash;
  const generationTwo = qualificationState(2, { attemptCount: 1, totalAttemptCount: 1 });
  first.compareAndSwapExternalQualificationState({
    expectedStateHash: staleHash,
    state: generationTwo,
  });
  assert.throws(() => second.compareAndSwapExternalQualificationState({
    expectedStateHash: staleHash,
    state: qualificationState(2),
  }), /qualification_state_fence_conflict/);

  const acquired = first.tryAcquireQualificationAttemptLease({
    ownerId: 'worker:first',
    leaseMs: 1000,
    now: new Date('2026-07-16T02:00:00.000Z'),
  });
  assert.ok(acquired);
  assert.equal(second.tryAcquireQualificationAttemptLease({
    ownerId: 'worker:second',
    leaseMs: 1000,
    now: new Date('2026-07-16T02:00:00.500Z'),
  }), null);
  const renewed = first.renewQualificationAttemptLease({
    ...acquired,
    leaseMs: 1000,
    now: new Date('2026-07-16T02:00:00.750Z'),
  });
  assert.ok(renewed);
  assert.equal(second.tryAcquireQualificationAttemptLease({
    ownerId: 'worker:second',
    leaseMs: 1000,
    now: new Date('2026-07-16T02:00:01.100Z'),
  }), null);
  const recovered = second.tryAcquireQualificationAttemptLease({
    ownerId: 'worker:second',
    leaseMs: 1000,
    now: new Date('2026-07-16T02:00:01.800Z'),
  });
  assert.ok(recovered);
  assert.ok(recovered.leaseGeneration > acquired.leaseGeneration);
  assert.equal(first.renewQualificationAttemptLease({
    ...acquired,
    leaseMs: 1000,
    now: new Date('2026-07-16T02:00:01.900Z'),
  }), null);
  assert.equal(first.releaseQualificationAttemptLease(acquired), false);
  const generationThree = qualificationState(3, { attemptCount: 2, totalAttemptCount: 2 });
  assert.throws(() => first.compareAndSwapExternalQualificationState({
    expectedStateHash: generationTwo.autonomousExternalQualificationStateHash,
    state: generationThree,
    attemptLease: acquired,
    now: new Date('2026-07-16T02:00:01.900Z'),
  }), /qualification_attempt_lease_fence_conflict/);
  second.compareAndSwapExternalQualificationState({
    expectedStateHash: generationTwo.autonomousExternalQualificationStateHash,
    state: generationThree,
    attemptLease: recovered,
    now: new Date('2026-07-16T02:00:01.900Z'),
  });
  assert.equal(fs.existsSync(path.join(path.dirname(first.statePath),
    'external-qualification-state.lock')), false);
  assert.match(first.statePath, /\.sqlite$/);
  fs.mkdirSync(path.dirname(first.legacyStatePath), { recursive: true });
  fs.writeFileSync(first.legacyStatePath, '{invalid legacy json', { mode: 0o600 });
  const reopened = createAutonomousResearchQualificationStateRepository({
    runtimeRoot,
    paperId: 'sqlite-cas-paper',
  });
  try {
    assert.deepEqual(reopened.readExternalQualificationState(), generationThree);
  } finally { reopened.close(); }
});

test('read-only qualification inspection preserves database and directory metadata', (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-qualification-readonly-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const writable = createAutonomousResearchQualificationStateRepository({
    runtimeRoot,
    paperId: 'sqlite-cas-paper',
  });
  const state = qualificationState(1);
  writable.compareAndSwapExternalQualificationState({ state });
  const { statePath } = writable;
  writable.close();

  const stateRoot = path.dirname(statePath);
  fs.chmodSync(stateRoot, 0o750);
  const fixed = new Date('2026-07-15T12:34:56.000Z');
  fs.utimesSync(stateRoot, fixed, fixed);
  const before = {
    bytes: fs.readFileSync(statePath),
    entries: fs.readdirSync(stateRoot).sort(),
    directory: fs.statSync(stateRoot, { bigint: true }),
  };
  assert.deepEqual(before.entries, ['external-qualification-state.sqlite']);

  const readonly = createAutonomousResearchQualificationStateRepository({
    runtimeRoot,
    paperId: 'sqlite-cas-paper',
    create: false,
  });
  try { assert.deepEqual(readonly.readExternalQualificationState(), state); }
  finally { readonly.close(); }

  const afterDirectory = fs.statSync(stateRoot, { bigint: true });
  assert.deepEqual(fs.readFileSync(statePath), before.bytes);
  assert.deepEqual(fs.readdirSync(stateRoot).sort(), before.entries);
  assert.equal(afterDirectory.mode, before.directory.mode);
  assert.equal(afterDirectory.mtimeNs, before.directory.mtimeNs);
});

test('legacy same-release qualification state cannot reset an unknown cost budget', async (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-qualification-legacy-cost-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const repository = createAutonomousResearchQualificationStateRepository({
    runtimeRoot,
    paperId: 'sqlite-cas-paper',
  });
  t.after(() => repository.close());
  const extended = structuredClone(qualificationState(1, {
    attemptCount: 1,
    totalAttemptCount: 1,
  }));
  delete extended.recovery.maximumTotalCostUsd;
  delete extended.recovery.reservedCostUsd;
  delete extended.recovery.attemptReservationCostUsd;
  delete extended.autonomousExternalQualificationStateHash;
  const legacy = createAutonomousExternalQualificationState(extended);
  repository.compareAndSwapExternalQualificationState({ state: legacy });
  let requests = 0;
  const configurationIdentityHash = H('legacy-cost-configuration');
  const trustIdentityHash = H('legacy-cost-trust');
  const result = await requestExternalResearchQualification({
    externalQualificationClient: {
      kind: 'ExternalResearchQualificationClient',
      configurationIdentityHash,
      trustIdentityHash,
      serviceIdentityHash: H('legacy-cost-client'),
      maximumQualificationCostUsd: 0.75,
      qualificationCostAuthority: 'operator_declared_worst_case_usd',
      async requestQualification() { requests += 1; return {}; },
    },
    externalQualificationVerifier: {
      kind: 'IndependentExternalResearchQualificationVerifier',
      configurationIdentityHash,
      trustIdentityHash,
      serviceIdentityHash: H('legacy-cost-verifier'),
      maximumQualificationCostUsd: 0.75,
      qualificationCostAuthority: 'operator_declared_worst_case_usd',
      async verify() { throw new Error('unreachable'); },
    },
    campaignReleaseAuthority: {
      campaignId: legacy.campaignId,
      paperId: legacy.paperId,
      campaignReleaseBundleHash: legacy.campaignReleaseBundleHash,
    },
    preparation: {
      proposal: { machineProposedScientificClaimSetHash: H('legacy-cost-proposal') },
      policyAuthorization: { autonomousResearchPolicyAuthorizationHash: H('legacy-cost-policy') },
      seedBinding: { autonomousResearchSeedBindingHash: H('legacy-cost-seed') },
    },
    qualificationStateStore: repository,
    allowRequest: true,
    evaluateEligibility: () => ({ fullAutomaticResearchWritingReady: false }),
    retry: { clock: { now: () => new Date('2026-07-16T00:00:02.000Z') } },
  });
  assert.equal(result.status, 'qualification_external_service_legacy_cost_state_unpriced');
  assert.equal(requests, 0);
  assert.deepEqual(repository.readExternalQualificationState(), legacy);
});

test('SQLite qualification lifetime attempt and cost fences cannot be reset by retry-policy growth', async (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-qualification-lifetime-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const repository = createAutonomousResearchQualificationStateRepository({
    runtimeRoot,
    paperId: 'lifetime-paper',
  });
  t.after(() => repository.close());
  const authority = {
    campaignId: 'autonomous-research:lifetime-paper',
    paperId: 'lifetime-paper',
    campaignReleaseBundleHash: H('lifetime-release'),
  };
  const preparation = {
    proposal: { machineProposedScientificClaimSetHash: H('lifetime-proposal') },
    policyAuthorization: { autonomousResearchPolicyAuthorizationHash: H('lifetime-policy') },
    seedBinding: { autonomousResearchSeedBindingHash: H('lifetime-seed') },
  };
  const configurationIdentityHash = H('lifetime-configuration');
  const trustIdentityHash = H('lifetime-trust');
  let requests = 0;
  const client = {
    kind: 'ExternalResearchQualificationClient',
    configurationIdentityHash,
    trustIdentityHash,
    serviceIdentityHash: H('lifetime-client'),
    maximumQualificationCostUsd: 0.75,
    qualificationCostAuthority: 'operator_declared_worst_case_usd',
    async requestQualification() { requests += 1; throw new Error('offline'); },
  };
  const verifier = {
    kind: 'IndependentExternalResearchQualificationVerifier',
    configurationIdentityHash,
    trustIdentityHash,
    serviceIdentityHash: H('lifetime-verifier'),
    maximumQualificationCostUsd: 0.75,
    qualificationCostAuthority: 'operator_declared_worst_case_usd',
    async verify() { throw new Error('unreachable'); },
  };
  let nowMs = Date.parse('2026-07-16T02:30:00.000Z');
  const invoke = (maximumTotalAttempts) => requestExternalResearchQualification({
    externalQualificationClient: client,
    externalQualificationVerifier: verifier,
    campaignReleaseAuthority: authority,
    preparation,
    qualificationStateStore: repository,
    allowRequest: true,
    evaluateEligibility: () => ({ fullAutomaticResearchWritingReady: false }),
    retry: {
      maximumAttempts: 1,
      maximumEpochs: 1,
      maximumTotalAttempts,
      maximumTotalCostUsd: 1,
      attemptReservationCostUsd: 0.25,
      initialBackoffMs: 0,
      exhaustedCooldownMs: 1000,
      clock: { now: () => new Date(nowMs) },
    },
  });
  const first = await invoke(1);
  assert.equal(first.status, 'qualification_external_service_recovery_budget_exhausted');
  assert.equal(requests, 1);
  nowMs += 1001;
  const afterPolicyGrowth = await invoke(4);
  assert.equal(afterPolicyGrowth.status,
    'qualification_external_service_recovery_budget_exhausted');
  assert.equal(requests, 1);
  const state = repository.readExternalQualificationState();
  assert.equal(state.recovery.maximumTotalAttempts, 1);
  assert.equal(state.recovery.totalAttemptCount, 1);
  assert.equal(state.recovery.attemptReservationCostUsd, 0.75);
  assert.equal(state.recovery.reservedCostUsd, 0.75);

  const unpricedClient = { ...client };
  const unpricedVerifier = { ...verifier };
  delete unpricedClient.maximumQualificationCostUsd;
  delete unpricedClient.qualificationCostAuthority;
  delete unpricedVerifier.maximumQualificationCostUsd;
  delete unpricedVerifier.qualificationCostAuthority;
  await assert.rejects(() => requestExternalResearchQualification({
    externalQualificationClient: unpricedClient,
    externalQualificationVerifier: unpricedVerifier,
    campaignReleaseAuthority: authority,
    preparation,
    qualificationStateStore: repository,
    allowRequest: true,
    evaluateEligibility: () => ({ fullAutomaticResearchWritingReady: false }),
    retry: { clock: { now: () => new Date(nowMs) } },
  }), /autonomous_research_external_qualification_identity_invalid/);
});

test('qualification cost authority cannot be lowered by a composition caller', () => {
  const configurationInspection = {
    ready: true,
    maximumQualificationCostUsd: 0.75,
    qualificationCostAuthority: 'operator_declared_worst_case_usd',
  };
  const bounded = qualificationRetryBoundToExternalCostAuthority({
    launchMode: 'production-run',
    action: 'resume',
    qualificationRetry: {
      maximumTotalCostUsd: 1,
      attemptReservationCostUsd: 0.01,
    },
    configurationInspection,
  });
  assert.equal(bounded.maximumTotalCostUsd, 1);
  assert.equal(bounded.attemptReservationCostUsd, 0.75);
  assert.throws(() => qualificationRetryBoundToExternalCostAuthority({
    launchMode: 'production-run',
    action: 'resume',
    qualificationRetry: {
      maximumTotalCostUsd: 0.5,
      attemptReservationCostUsd: 0.01,
    },
    configurationInspection,
  }), /autonomous_research_qualification_cost_envelope_insufficient/);
  assert.throws(() => qualificationRetryBoundToExternalCostAuthority({
    launchMode: 'production-run',
    action: 'resume',
    externalQualificationClient: {},
    externalQualificationVerifier: {},
  }), /autonomous_research_qualification_cost_authority_invalid/);
});

test('qualification composition binds worker, provider, pricing, and retry configuration', () => {
  assert.deepEqual(campaignWorkerOptions(), {});
  assert.deepEqual(campaignWorkerOptions({
    agentProvider: 'openai',
    model: 'author-model',
    formalReviewProvider: 'codex',
    formalReviewModel: 'reviewer-model',
    formalReviewCodexBinary: '/opt/codex-reviewer',
    formalReviewCodexHome: '/srv/reviewer-home',
    codexHome: '/srv/author-home',
    codexBinary: '/opt/codex-author',
    budgets: { maxWallTimeMs: 1234 },
    workerMemoryMiB: 768,
    workerCpuSeconds: 45,
  }), {
    'agent-provider': 'openai',
    model: 'author-model',
    'formal-review-provider': 'codex',
    'formal-review-model': 'reviewer-model',
    'formal-review-codex-binary': '/opt/codex-reviewer',
    'formal-review-codex-home': '/srv/reviewer-home',
    'codex-home': '/srv/author-home',
    'codex-binary': '/opt/codex-author',
    'max-wall-ms': 1234,
    'worker-memory-mib': 768,
    'worker-cpu-seconds': 45,
  });

  const fullyBound = providerBoundReadinessEnvironment(
    { PRESERVED: 'yes' },
    {
      researchAuthor: {
        provider: 'openai',
        codexBinary: '/opt/codex-author',
        codexHome: '/srv/author-home',
        model: 'author-model',
      },
      formalReviewer: {
        provider: 'codex',
        codexBinary: '/opt/codex-reviewer',
        codexHome: '/srv/reviewer-home',
        model: 'reviewer-model',
      },
    },
  );
  assert.equal(fullyBound.PRESERVED, 'yes');
  assert.equal(fullyBound.HEPTA_RESEARCH_AUTHOR_CODEX_HOME, '/srv/author-home');
  assert.equal(fullyBound.HEPTA_RESEARCH_AUTHOR_MODEL, 'author-model');
  assert.equal(fullyBound.HEPTA_FORMAL_REVIEW_CODEX_HOME, '/srv/reviewer-home');
  assert.equal(fullyBound.HEPTA_FORMAL_REVIEW_MODEL, 'reviewer-model');
  const minimallyBound = providerBoundReadinessEnvironment({}, {
    researchAuthor: { provider: 'openai', codexBinary: '/opt/codex-author' },
    formalReviewer: { provider: 'codex', codexBinary: '/opt/codex-reviewer' },
  });
  assert.equal('HEPTA_RESEARCH_AUTHOR_CODEX_HOME' in minimallyBound, false);
  assert.equal('HEPTA_RESEARCH_AUTHOR_MODEL' in minimallyBound, false);
  assert.equal('HEPTA_FORMAL_REVIEW_CODEX_HOME' in minimallyBound, false);
  assert.equal('HEPTA_FORMAL_REVIEW_MODEL' in minimallyBound, false);

  assert.equal(configuredMaximumCost({
    HEPTA_REVIEW_MAXIMUM_COST_PER_CALL_USD: '2.5',
    HEPTA_REVIEW_MAX_COST_PER_CALL_USD: '1.5',
  }, 'REVIEW'), '2.5');
  assert.equal(configuredMaximumCost({
    HEPTA_REVIEW_MAX_COST_PER_CALL_USD: '1.5',
  }, 'REVIEW'), '1.5');
  assert.equal(configuredMaximumCost({}, 'REVIEW'), null);

  const persistedCampaign = { spec: { budgets: { maxAgentCalls: 4 } } };
  const productionGate = {
    productionRun: true,
    effectiveBudgets: { maxAgentCalls: 5 },
  };
  assert.doesNotThrow(() => requireExistingProductionPricingEnvelope({
    action: 'resume',
    existingCampaign: persistedCampaign,
    launchModeGate: productionGate,
  }));
  for (const options of [
    { action: 'resume', launchModeGate: productionGate },
    { action: 'status', existingCampaign: persistedCampaign, launchModeGate: productionGate },
    {
      action: 'resume',
      existingCampaign: persistedCampaign,
      launchModeGate: { productionRun: false },
    },
  ]) assert.doesNotThrow(() => requireExistingProductionPricingEnvelope(options));
  for (const [requested, effective] of [
    ['not-a-number', 5],
    [0, 5],
    [4, Number.NaN],
    [4, 0],
    [6, 5],
  ]) {
    assert.throws(() => requireExistingProductionPricingEnvelope({
      action: 'resume',
      existingCampaign: persistedCampaign,
      requestedBudgets: { maxAgentCalls: requested },
      launchModeGate: {
        productionRun: true,
        effectiveBudgets: { maxAgentCalls: effective },
      },
    }), /autonomous_research_production_provider_price_drift_exceeds_campaign_envelope/);
  }

  const unchangedRetry = { maximumTotalCostUsd: 7 };
  assert.equal(qualificationRetryBoundToExternalCostAuthority({
    launchMode: 'invalid-mode',
    action: 'resume',
    qualificationRetry: unchangedRetry,
  }), unchangedRetry);
  assert.equal(qualificationRetryBoundToExternalCostAuthority({
    launchMode: 'production-run',
    action: 'status',
    qualificationRetry: unchangedRetry,
  }), unchangedRetry);
  assert.equal(qualificationRetryBoundToExternalCostAuthority({
    launchMode: 'production-run',
    action: 'resume',
    qualificationRetry: unchangedRetry,
  }), unchangedRetry);
  assert.equal(qualificationRetryBoundToExternalCostAuthority({
    launchMode: 'production-run',
    action: 'resume',
    configurationInspection: {
      ready: true,
      maximumQualificationCostUsd: 0,
      qualificationCostAuthority: 'externally_operated_zero_cost',
    },
  }).attemptReservationCostUsd, 0);
  assert.throws(() => qualificationRetryBoundToExternalCostAuthority({
    launchMode: 'production-run',
    action: 'resume',
    configurationInspection: {
      ready: true,
      maximumQualificationCostUsd: 1001,
      qualificationCostAuthority: 'operator_declared_worst_case_usd',
    },
  }), /autonomous_research_qualification_cost_authority_invalid/);
  const paidAuthority = {
    maximumQualificationCostUsd: 0.75,
    qualificationCostAuthority: 'operator_declared_worst_case_usd',
  };
  assert.equal(qualificationRetryBoundToExternalCostAuthority({
    launchMode: 'production-run',
    action: 'resume',
    externalQualificationClient: paidAuthority,
    externalQualificationVerifier: { ...paidAuthority },
  }).attemptReservationCostUsd, 0.75);
  for (const qualificationRetry of [
    { maximumTotalCostUsd: Number.POSITIVE_INFINITY },
    { maximumTotalCostUsd: 0 },
    { maximumTotalCostUsd: 1, attemptReservationCostUsd: Number.NaN },
    { maximumTotalCostUsd: 1, attemptReservationCostUsd: -0.01 },
  ]) {
    assert.throws(() => qualificationRetryBoundToExternalCostAuthority({
      launchMode: 'production-run',
      action: 'resume',
      qualificationRetry,
      externalQualificationClient: paidAuthority,
      externalQualificationVerifier: { ...paidAuthority },
    }), /autonomous_research_qualification_cost_envelope_insufficient/);
  }
  assert.throws(() => qualificationRetryBoundToExternalCostAuthority({
    launchMode: 'production-run',
    action: 'resume',
    externalQualificationClient: paidAuthority,
    externalQualificationVerifier: {
      maximumQualificationCostUsd: 0.5,
      qualificationCostAuthority: 'operator_declared_worst_case_usd',
    },
  }), /autonomous_research_qualification_cost_authority_invalid/);
});

function supervisorDispatchCampaign(launchMode, { legacy = false } = {}) {
  const preparationPayload = {
    version: 1,
    kind: 'AutonomousResearchLoopPreparationReport',
    proposal: { paperId: 'dispatch-paper' },
    ...(!legacy ? { launchMode } : {}),
  };
  return {
    campaignId: 'autonomous-research:dispatch-paper',
    paperId: 'dispatch-paper',
    spec: {
      budgets: { maxCostUsd: 25, maxAgentCalls: 10 },
      autonomousResearchPreparation: {
        ...preparationPayload,
        autonomousResearchLoopPreparationReportHash:
          hashRecord('AutonomousResearchLoopPreparationReport', preparationPayload),
      },
    },
  };
}

test('supervisor resumes the hash-bound campaign launch mode without production downgrade', () => {
  const golden = resolveAutonomousResearchSupervisorDispatchPolicy(
    supervisorDispatchCampaign('golden-bootstrap'),
  );
  assert.equal(golden.launchMode, 'golden-bootstrap');
  assert.equal(golden.legacyLaunchModeMissing, false);
  assert.deepEqual(golden.budgets, { maxCostUsd: 25, maxAgentCalls: 10 });

  const production = resolveAutonomousResearchSupervisorDispatchPolicy(
    supervisorDispatchCampaign('production-run'),
  );
  assert.equal(production.launchMode, 'production-run');
  assert.throws(() => resolvePersistedAutonomousResearchLaunchMode({
    campaign: supervisorDispatchCampaign('production-run'),
    requestedLaunchMode: 'golden-bootstrap',
  }), /autonomous_research_launch_mode_mismatch:production-run:golden-bootstrap/);

  const legacy = resolveAutonomousResearchSupervisorDispatchPolicy(
    supervisorDispatchCampaign(null, { legacy: true }),
  );
  assert.equal(legacy.launchMode, 'production-run');
  assert.equal(legacy.legacyLaunchModeMissing, true);

  const tampered = structuredClone(supervisorDispatchCampaign('production-run'));
  tampered.spec.autonomousResearchPreparation.launchMode = 'golden-bootstrap';
  assert.throws(() => resolveAutonomousResearchSupervisorDispatchPolicy(tampered),
    /autonomous_research_persisted_preparation_hash_invalid/);
});

test('provider canary completion is rejected after its supervisor lease is replaced', async () => {
  const configurationHash = H('fenced-provider-configuration');
  let leaseValid = true;
  let assertions = 0;
  let completeProbe;
  const probe = new Promise((resolve) => { completeProbe = resolve; });
  const runProviderCanary = createFencedAutonomousResearchProviderCanary({
    stateRepository: {
      assertCampaignLease() { assertions += 1;
        if (!leaseValid) throw new Error('autonomous_research_supervisor_lease_lost'); },
      renewCampaignLease() {
        return leaseValid ? { expiresAt: '2026-07-16T03:20:00.000Z' } : null;
      },
      recordExternalActionProgress() {} },
    providerConfiguration: {
      autonomousResearchProviderConfigurationHash: configurationHash,
    },
    environment: {},
    clock: { now: () => new Date('2026-07-16T03:10:00.000Z') },
    async providerCanaryRunner() {
      await probe;
      return { verified: true, providerCanaryPairReceiptHash: H('late-canary') };
    },
  });
  const pending = runProviderCanary({
    campaign: {
      spec: {
        autonomousResearchPreparation: {
          autonomousResearchProviderConfigurationHash: configurationHash,
        },
      },
    },
    supervisorLease: {
      campaignId: 'autonomous-research:fenced-canary',
      ownerId: 'supervisor:old',
      leaseToken: 'lease:old',
      leaseGeneration: 1,
    },
  });
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.equal(assertions, 1);
  leaseValid = false;
  completeProbe();
  await assert.rejects(pending, /autonomous_research_supervisor_lease_lost/);
  assert.equal(assertions, 2);
});

test('supervisor leases recover after expiry and dispatch budget cannot reset across restarts', (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-supervisor-budget-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  let repository = createAutonomousResearchSupervisorStateRepository({ runtimeRoot });
  t.after(() => repository.close());
  const now = new Date('2026-07-16T04:00:00.000Z');
  const recoveredAt = new Date(now.getTime() + 15 * 60 * 1000 + 1);
  repository.registerCampaign({
    campaignId: 'autonomous-research:budget-paper',
    paperId: 'budget-paper',
    policy: { maximumDispatches: 1 },
    now,
  });
  const firstLease = repository.tryAcquireCampaignLease({
    campaignId: 'autonomous-research:budget-paper', ownerId: 'supervisor:first', leaseMs: 1000, now,
  });
  assert.ok(firstLease);
  assert.equal(repository.getCampaign('autonomous-research:budget-paper').policy.leaseMs,
    15 * 60 * 1000);
  assert.equal(firstLease.expiresAt,
    new Date(now.getTime() + 15 * 60 * 1000).toISOString());
  assert.equal(repository.reconcileStaleLeases({
    now: new Date(recoveredAt.getTime() - 2),
  }).recoveredLeaseCount, 0);
  assert.equal(repository.reconcileStaleLeases({
    now: recoveredAt,
  }).recoveredLeaseCount, 1);
  const recoveredLease = repository.tryAcquireCampaignLease({
    campaignId: 'autonomous-research:budget-paper',
    ownerId: 'supervisor:replacement',
    leaseMs: 1000,
    now: recoveredAt,
  });
  assert.ok(recoveredLease.leaseGeneration > firstLease.leaseGeneration);
  assert.equal(repository.beginDispatch({
    lease: recoveredLease,
    campaignCostLimitUsd: 100,
    now: recoveredAt,
  }).authorized, true);
  repository.finishDispatch({
    lease: recoveredLease,
    successful: false,
    observedCampaignCostUsd: 0,
    observedQualificationReservedCostUsd: 0,
    costKnown: true,
    nextDispatchAt: recoveredAt,
    now: recoveredAt,
  });
  repository.close();
  repository = createAutonomousResearchSupervisorStateRepository({ runtimeRoot });
  assert.throws(() => repository.registerCampaign({
    campaignId: 'autonomous-research:budget-paper',
    paperId: 'budget-paper',
    policy: { maximumDispatches: 2 },
    now: recoveredAt,
  }), /lifecycle_policy_immutable/);
  const lastLease = repository.tryAcquireCampaignLease({
    campaignId: 'autonomous-research:budget-paper',
    ownerId: 'supervisor:last',
    leaseMs: 1000,
    now: recoveredAt,
  });
  const blocked = repository.beginDispatch({
    lease: lastLease,
    campaignCostLimitUsd: 100,
    now: recoveredAt,
  });
  assert.deepEqual(blocked, {
    authorized: false,
    blocker: 'supervisor_lifecycle_dispatch_budget_exhausted',
  });
  assert.equal(repository.getCampaign('autonomous-research:budget-paper').disposition, 'blocked');
});

test('supervisor hard deadline and unknown observed cost fail closed', (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-supervisor-fences-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const repository = createAutonomousResearchSupervisorStateRepository({ runtimeRoot });
  t.after(() => repository.close());
  const now = new Date('2026-07-16T04:15:00.000Z');
  repository.registerCampaign({
    campaignId: 'autonomous-research:deadline-paper',
    paperId: 'deadline-paper',
    policy: { maximumLifetimeMs: 60_000 },
    now,
  });
  assert.equal(repository.tryAcquireCampaignLease({
    campaignId: 'autonomous-research:deadline-paper',
    ownerId: 'supervisor:late',
    leaseMs: 1000,
    now: new Date(now.getTime() + 60_001),
  }), null);
  const deadlineState = repository.getCampaign('autonomous-research:deadline-paper');
  assert.equal(deadlineState.disposition, 'blocked');
  assert.equal(deadlineState.terminalReason, 'supervisor_lifecycle_deadline_exhausted');

  repository.registerCampaign({
    campaignId: 'autonomous-research:unknown-cost-paper',
    paperId: 'unknown-cost-paper',
    policy: {},
    now,
  });
  const lease = repository.tryAcquireCampaignLease({
    campaignId: 'autonomous-research:unknown-cost-paper',
    ownerId: 'supervisor:cost',
    leaseMs: 1000,
    now,
  });
  assert.equal(repository.beginDispatch({
    lease,
    campaignCostLimitUsd: 100,
    now,
  }).authorized, true);
  const unknownCostState = repository.finishDispatch({
    lease,
    costKnown: false,
    successful: false,
    nextDispatchAt: now,
    now,
  });
  assert.equal(unknownCostState.disposition, 'blocked');
  assert.equal(unknownCostState.terminalReason, 'supervisor_lifecycle_cost_unknown');
});

test('dispatch reserves only the next live canary instead of deadlocking on the lifetime maximum', (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-supervisor-canary-cost-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const repository = createAutonomousResearchSupervisorStateRepository({ runtimeRoot });
  t.after(() => repository.close());
  const now = new Date('2026-07-16T04:20:00.000Z');
  repository.registerCampaign({
    campaignId: 'autonomous-research:canary-cost-paper',
    paperId: 'canary-cost-paper',
    policy: {
      maximumLifecycleCostUsd: 150,
      qualificationMaximumTotalCostUsd: 25,
      providerCanaryReservationCostUsd: 20,
      maximumProviderCanaries: 6,
    },
    now,
  });
  const lease = repository.tryAcquireCampaignLease({
    campaignId: 'autonomous-research:canary-cost-paper',
    ownerId: 'supervisor:canary-cost',
    leaseMs: 5000,
    now,
  });
  const dispatch = repository.beginDispatch({
    lease,
    campaignCostLimitUsd: 100,
    now,
  });
  assert.equal(dispatch.authorized, true);
  assert.equal(dispatch.resumed, false);
  assert.equal(dispatch.dispatchCount, 1);
  assert.match(dispatch.dispatchReservationHash, /^sha256:[0-9a-f]{64}$/);
  const canaryReservation = repository.beginProviderCanary({ lease,
    providerConfigurationHash: H('canary-cost-provider-configuration'), now });
  assert.equal(canaryReservation.authorized, true);
  assert.equal(canaryReservation.required, true);
  assert.equal(canaryReservation.externalActionAttempt.status, 'in_progress');
  const after = repository.finishProviderCanary({
    lease,
    attempt: canaryReservation.externalActionAttempt,
    verified: true,
    receiptHash: H('expensive-canary-pair'),
    now,
  });
  assert.equal(after.providerCanaryReservedCostUsd, 20);
  assert.equal(after.lastProviderCanaryReceiptHash, H('expensive-canary-pair'));
});

test('verified qualification is renewed automatically at its persisted lead time', async (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-supervisor-renewal-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const repository = createAutonomousResearchSupervisorStateRepository({ runtimeRoot });
  t.after(() => repository.close());
  const value = campaign('autonomous-research:renewal-paper', 'completed');
  let nowMs = Date.parse('2026-07-16T04:30:00.000Z');
  let dispatches = 0;
  let canaries = 0;
  const runtimeReceiptHash = H('renewal-runtime-receipt');
  let state = {
    recovery: { status: 'qualification_verified', totalAttemptCount: 1, reservedCostUsd: 0.05 },
    receipt: {
      expiresAt: new Date(nowMs + 10_000).toISOString(),
      runtimeImageReproducibilityReceiptHash: runtimeReceiptHash,
    },
  };
  const supervisor = createAutonomousResearchSupervisor({
    campaignStore: {
      listCampaigns() { return [value]; },
      getCampaign() { return value; },
    },
    stateRepository: repository,
    async reconcileRuntime() { return null; },
    async ensureRuntimeReproducibility() {
      return {
        ready: true,
        receiptHash: runtimeReceiptHash,
        expiresAt: new Date(nowMs + 120_000).toISOString(),
        renewAt: new Date(nowMs + 115_000).toISOString(),
      };
    },
    async readQualificationState() { return state; },
    async runProviderCanary() {
      canaries += 1;
      return { verified: true, providerCanaryPairReceiptHash: H('renewal-canary') };
    },
    async renewQualification() {
      state = {
        recovery: {
          status: 'qualification_verified', totalAttemptCount: 2, reservedCostUsd: 0.1,
        },
        receipt: {
          expiresAt: new Date(nowMs + 120_000).toISOString(),
          runtimeImageReproducibilityReceiptHash: runtimeReceiptHash,
        },
      };
      return { ready: true };
    },
    async dispatchCampaign() {
      dispatches += 1;
      state = {
        recovery: { status: 'qualification_verified', totalAttemptCount: 2, reservedCostUsd: 0.1 },
        receipt: {
          expiresAt: new Date(nowMs + 120_000).toISOString(),
          runtimeImageReproducibilityReceiptHash: runtimeReceiptHash,
        },
      };
      return {
        status: 'autonomous_research_campaign_completed_and_qualified',
        campaign: { status: 'completed' },
        externalQualification: { status: 'qualification_external_service_verified' },
        campaignFullyQualified: true,
        fullAutomaticResearchWritingReady: true,
        autonomousResearchCampaignExecutionReportHash: H('renewal-report'),
      };
    },
    lifecyclePolicy: {
      maximumLifetimeMs: 60_000,
      qualificationRenewalLeadMs: 5000,
    },
    clock: { now: () => new Date(nowMs) },
    scheduler: {
      async sleep() {}, setInterval() { return {}; }, clearInterval() {}, unref() {},
    },
    ownerId: 'supervisor:renewal',
    pollMs: 100,
  });
  const deferred = await supervisor.runCycle();
  assert.equal(deferred.results[0].reason, 'qualification_renewal_scheduled');
  assert.equal(dispatches, 0);
  assert.equal(canaries, 0);
  nowMs += 5001;
  const renewed = await supervisor.runCycle();
  assert.equal(renewed.results[0].status, 'settled');
  assert.equal(dispatches, 1);
  assert.equal(canaries, 1);
});

test('a completed campaign with a qualification for an old runtime must requalify', () => {
  const now = new Date('2026-07-16T04:45:00.000Z');
  const currentRuntimeHash = H('current-runtime-binding');
  const decision = autonomousResearchSupervisorDispatchDecision({
    campaign: campaign('autonomous-research:old-runtime-binding', 'completed'),
    lifecycle: readinessLifecycle(now),
    qualificationState: {
      recovery: { status: 'qualification_verified', totalAttemptCount: 1, reservedCostUsd: 0.05 },
      receipt: {
        expiresAt: new Date(now.getTime() + 8 * 60 * 60 * 1000).toISOString(),
        runtimeImageReproducibilityReceiptHash: H('old-runtime-binding'),
      },
    },
    runtimeReadiness: {
      ready: true,
      receiptHash: currentRuntimeHash,
      renewAt: new Date(now.getTime() + 7 * 60 * 60 * 1000).toISOString(),
    },
    now,
  });
  assert.equal(decision.action, 'resume');
  assert.equal(decision.qualificationRenewalRequired, true);
  assert.equal(Object.hasOwn(decision, 'settle'), false);
  assert.equal(Object.hasOwn(decision, 'deferUntil'), false);
});

test('qualification validity covers remaining campaign wall time plus fifteen minutes', () => {
  const now = new Date('2026-07-16T04:46:00.000Z');
  const runtimeReceiptHash = H('wall-validity-runtime');
  const active = campaign('autonomous-research:wall-validity', 'running');
  active.lastResumedAt = now.toISOString();
  active.spec.budgets.maxWallTimeMs = 6 * 60 * 60 * 1000;
  const decision = autonomousResearchSupervisorDispatchDecision({
    campaign: active,
    lifecycle: readinessLifecycle(now),
    qualificationState: {
      recovery: { status: 'qualification_verified', totalAttemptCount: 1, reservedCostUsd: 0.05 },
      receipt: {
        expiresAt: new Date(now.getTime() + 16 * 60 * 1000).toISOString(),
        runtimeImageReproducibilityReceiptHash: runtimeReceiptHash,
      },
    },
    runtimeReadiness: {
      ready: true,
      receiptHash: runtimeReceiptHash,
      renewAt: new Date(now.getTime() + 8 * 60 * 60 * 1000).toISOString(),
    },
    now,
  });
  assert.equal(decision.action, 'resume');
  assert.equal(decision.qualificationRenewalRequired, true);
  assert.equal(decision.requiredQualificationValidityMs, 6 * 60 * 60 * 1000 + 15 * 60 * 1000);
  assert.equal(decision.qualificationRetry.renewalLeadMs,
    6 * 60 * 60 * 1000 + 15 * 60 * 1000);

  active.spec.budgets.maxWallTimeMs = 24 * 60 * 60 * 1000;
  const uncoverable = autonomousResearchSupervisorDispatchDecision({
    campaign: active,
    lifecycle: readinessLifecycle(now),
    qualificationState: null,
    runtimeReadiness: {
      ready: true,
      receiptHash: runtimeReceiptHash,
      renewAt: new Date(now.getTime() + 8 * 60 * 60 * 1000).toISOString(),
    },
    now,
  });
  assert.equal(uncoverable.block, true);
  assert.equal(uncoverable.reason, 'supervisor_qualification_campaign_window_uncoverable');
});

test('resident wake-up uses the earliest runtime, qualification, or lifecycle renewal boundary', () => {
  const now = new Date('2026-07-16T04:47:00.000Z');
  const runtimeReceiptHash = H('skewed-renewal-runtime');
  const schedule = autonomousResearchSupervisorNextSchedule({
    report: { fullAutomaticResearchWritingReady: true },
    campaign: campaign('autonomous-research:skewed-renewal', 'completed'),
    qualificationState: {
      recovery: { status: 'qualification_verified' },
      receipt: {
        expiresAt: new Date(now.getTime() + 44 * 60 * 1000).toISOString(),
        runtimeImageReproducibilityReceiptHash: runtimeReceiptHash,
      },
    },
    runtimeReadiness: {
      ready: true,
      receiptHash: runtimeReceiptHash,
      renewAt: new Date(now.getTime() + 24 * 60 * 1000).toISOString(),
    },
    lifecycle: readinessLifecycle(now),
    now,
    pollMs: 1000,
  });
  assert.equal(schedule.settled, false);
  assert.equal(schedule.reason, 'qualification_renewal_scheduled');
  assert.equal(schedule.nextAt.toISOString(),
    new Date(now.getTime() + 24 * 60 * 1000).toISOString());
});

test('bounded Golden publication settles only with its current runtime-bound qualification', () => {
  const now = new Date('2026-07-16T04:47:30.000Z');
  const runtimeReceiptHash = H('bounded-golden-publication-runtime');
  const candidate = campaign('autonomous-research:bounded-golden-publication', 'completed');
  const lifecycle = readinessLifecycle(now);
  const runtimeReadiness = {
    ready: true,
    receiptHash: runtimeReceiptHash,
    renewAt: new Date(now.getTime() + 7 * 60 * 60 * 1000).toISOString(),
  };
  const currentQualificationState = {
    recovery: { status: 'qualification_verified' },
    receipt: {
      expiresAt: new Date(now.getTime() + 8 * 60 * 60 * 1000).toISOString(),
      runtimeImageReproducibilityReceiptHash: runtimeReceiptHash,
    },
  };
  const report = {
    boundedGoldenQualificationPublished: true,
    campaignFullyQualified: false,
    fullAutomaticResearchWritingReady: false,
  };

  const published = autonomousResearchSupervisorNextSchedule({
    report,
    campaign: candidate,
    qualificationState: currentQualificationState,
    runtimeReadiness,
    lifecycle,
    now,
    pollMs: 1000,
  });
  assert.equal(published.settled, true);
  assert.equal(published.reason,
    'bounded_golden_qualification_published_beyond_lifecycle');

  const staleRuntimeBinding = autonomousResearchSupervisorNextSchedule({
    report,
    campaign: candidate,
    qualificationState: {
      ...currentQualificationState,
      receipt: {
        ...currentQualificationState.receipt,
        runtimeImageReproducibilityReceiptHash: H('stale-bounded-golden-runtime'),
      },
    },
    runtimeReadiness,
    lifecycle,
    now,
    pollMs: 1000,
  });
  assert.equal(staleRuntimeBinding.settled, false);
  assert.equal(staleRuntimeBinding.reason,
    'qualification_runtime_binding_renewal_required');

  const unpublished = autonomousResearchSupervisorNextSchedule({
    report: { ...report, boundedGoldenQualificationPublished: false },
    campaign: candidate,
    qualificationState: currentQualificationState,
    runtimeReadiness,
    lifecycle,
    now,
    pollMs: 1000,
  });
  assert.equal(unpublished.settled, false);
  assert.equal(unpublished.reason, 'supervisor_retry_scheduled');
});

test('submission-enabled campaigns cannot settle while durable delivery is uncertain', () => {
  const now = new Date('2026-07-16T04:48:00.000Z');
  const runtimeReceiptHash = H('submission-recovery-runtime');
  const candidate = campaign('autonomous-research:submission-recovery', 'completed');
  candidate.spec.autonomousResearchPreparation.venueProfileSelection = {
    requireExternalSubmission: true,
  };
  const lifecycle = readinessLifecycle(now);
  const qualificationState = {
    recovery: {
      status: 'qualification_verified',
      totalAttemptCount: 1,
      reservedCostUsd: 0.05,
    },
    receipt: {
      expiresAt: new Date(now.getTime() + 8 * 60 * 60 * 1000).toISOString(),
      runtimeImageReproducibilityReceiptHash: runtimeReceiptHash,
    },
  };
  const runtimeReadiness = {
    ready: true,
    receiptHash: runtimeReceiptHash,
    renewAt: new Date(now.getTime() + 7 * 60 * 60 * 1000).toISOString(),
  };
  const decision = autonomousResearchSupervisorDispatchDecision({
    campaign: candidate,
    lifecycle,
    qualificationState,
    runtimeReadiness,
    submissionRecovery: {
      required: true,
      status: 'autonomous_research_submission_recovery_not_started',
      delivery: null,
    },
    now,
  });
  assert.equal(decision.action, 'resume');
  assert.equal(decision.qualificationRenewalRequired, false);

  const uncertain = autonomousResearchSupervisorNextSchedule({
    report: {
      fullAutomaticResearchWritingReady: true,
      autonomousSubmission: {
        delivery: {
          status: 'autonomous_submission_delivery_uncertain',
          terminal: false,
          lookupRequired: true,
        },
      },
    },
    campaign: candidate,
    qualificationState,
    runtimeReadiness,
    lifecycle,
    now,
    pollMs: 1000,
  });
  assert.equal(uncertain.settled, false);
  assert.equal(uncertain.reason, 'autonomous_submission_recovery_scheduled');

  const completed = autonomousResearchSupervisorNextSchedule({
    report: {
      fullAutomaticResearchWritingReady: true,
      autonomousSubmission: {
        delivery: {
          status: 'autonomous_submission_delivery_completed',
          terminal: true,
          lookupRequired: false,
        },
      },
    },
    campaign: candidate,
    qualificationState,
    runtimeReadiness,
    lifecycle,
    now,
    pollMs: 1000,
  });
  assert.equal(completed.settled, true);
  assert.equal(completed.reason, 'qualified_beyond_lifecycle');
});
