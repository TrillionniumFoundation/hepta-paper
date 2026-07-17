import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
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
  buildAutonomousResearchMachineIntake,
} from '../../paper-domain/automation/autonomous-research-machine-intake-contract.mjs';
import {
  buildAutonomousResearchMachineIntakeAdmission,
} from '../../paper-domain/automation/autonomous-research-machine-intake-admission-contract.mjs';
import {
  createAutonomousResearchSupervisor,
  selectFairAutonomousCampaignWindow,
  verifyAutonomousResearchMachineIntakeEnqueueCommit,
} from '../../paper-application/automation/autonomous-research-supervisor.mjs';
import {
  autonomousResearchSupervisorDispatchDecision,
  autonomousResearchSupervisorNextSchedule,
} from '../../paper-application/automation/autonomous-research-supervisor-readiness-policy.mjs';
import {
  composeAutonomousResearchSupervisor,
  createFencedAutonomousResearchProviderCanary,
  resolveAutonomousResearchSupervisorDispatchPolicy,
} from '../../paper-composition/automation/autonomous-research-supervisor-composition.mjs';
import {
  qualificationRetryBoundToExternalCostAuthority,
} from '../../paper-composition/automation/autonomous-research-qualification-composition.mjs';
import {
  resolvePersistedAutonomousResearchLaunchMode,
} from '../../paper-domain/automation/autonomous-research-launch-mode-policy.mjs';
import {
  requestExternalResearchQualification,
} from '../../paper-application/automation/external-qualification-recovery.mjs';
import { runPaperCampaign } from '../../paper-application/automation/campaign-engine.mjs';
import { createDefaultPaperStore } from '../../paper-adapters/persistence/store-provider.mjs';
import { createSqliteCampaignStore } from '../../paper-adapters/persistence/sqlite-campaign-store.mjs';
import { createSystemClock } from '../../paper-adapters/runtime/system-clock.mjs';
import { createSystemScheduler } from '../../paper-adapters/runtime/system-scheduler.mjs';
import { createRandomIdGenerator } from '../../paper-adapters/runtime/random-id-generator.mjs';
import { buildCanonicalAdmissionPreflightExecutionInspection, buildExecutionAdmittedSupervisorCampaign, buildMachineIntakeExecutionAdmission } from './autonomous-research-supervisor-enqueue-test-support.mjs';
const H = (label) => hashRecord('AutonomousSupervisorTestHash', { label });
const repositoryRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');

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

function campaign(campaignId, status, stopReason = null) {
  return {
    campaignId,
    paperId: campaignId.split(':').at(-1),
    status,
    stopReason,
    costKnown: true,
    costUsd: 2,
    spec: {
      budgets: { maxCostUsd: 100 },
      autonomousResearchPreparation: {
        proposal: { paperId: campaignId.split(':').at(-1) },
        autonomousResearchProviderConfigurationHash: H('supervisor-provider-configuration'),
      },
    },
  };
}

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

test('composition reconciles the SQLite receipt mirror once before read-only runtime status', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-supervisor-mirror-root-'));
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-supervisor-mirror-runtime-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const clock = createSystemClock();
  const store = createDefaultPaperStore({ root, runtimeRoot });
  const campaigns = createSqliteCampaignStore({ store, clock });
  campaigns.createCampaign({
    campaignId: 'autonomous-research:mirror-order-paper',
    paperId: 'mirror-order-paper',
    budgets: {
      maxWallTimeMs: 60 * 60 * 1000,
      maxAgentCalls: 1,
      maxCpuJobs: 1,
      maxGpuJobs: 1,
      maxTokenCount: 1000,
      maxCostUsd: 10,
      maxMemoryMiB: 1024,
    },
    autonomousResearchPreparation: {
      proposal: { paperId: 'mirror-order-paper' },
    },
    nodes: [{
      nodeId: 'mirror-order-node',
      kind: 'agent',
      dependencies: [],
      maxAttempts: 1,
    }],
  });
  store.close();
  const events = [];
  const runtimeReceiptHash = H('composition-runtime-receipt');
  const composition = composeAutonomousResearchSupervisor({
    root,
    runtimeRoot,
    environment: {
      HEPTA_RESEARCH_AUTHOR_MAXIMUM_COST_PER_CALL_USD: '1',
      HEPTA_FORMAL_REVIEWER_MAXIMUM_COST_PER_CALL_USD: '1',
    },
    runtimeReproducibilityPolicy: {
      maximumAttemptsPerEpoch: 2,
      maximumCostUsdPerEpoch: 10,
      leaseMs: 1000,
      baseBackoffMs: 100,
      maximumBackoffMs: 1000,
      renewalLeadMs: 5000,
      actionSafetyMarginMs: 15 * 60 * 1000,
    },
    runtimeReproducibilityOverrides: {
      reconcileMirror() { events.push('mirror-reconcile'); return null; },
      readStatus({ now }) {
        events.push('runtime-status');
        return {
          ready: true,
          configuration: {
            ready: true,
            configurationIdentityHash: H('composition-runtime-configuration'),
            maximumVerificationCostUsd: 3,
            verificationCostAuthority: 'operator_declared_worst_case_usd',
            maximumVerifierTimeoutMs: 1000,
            minimumRefreshLeadMs: 3000,
            maximumReceiptAgeMs: 24 * 60 * 60 * 1000,
            blockers: [],
          },
          inspection: {
            ready: true,
            receiptHash: runtimeReceiptHash,
            issuedAt: now.toISOString(),
            expiresAt: new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString(),
          },
          blockers: [],
        };
      },
      async publish() { throw new Error('current_status_must_not_publish'); },
    },
    reconcileRuntimeOverride() { events.push('automation-reconcile'); return null; },
    readQualificationStateOverride: async () => null,
    providerCanaryOverride: async () => ({
      verified: true,
      providerCanaryPairReceiptHash: H('composition-canary'),
    }),
    renewQualificationOverride: async () => ({ ready: false, reason: 'deferred' }),
    dispatchCampaignOverride: async () => ({
      status: 'qualification_pending',
      campaign: { status: 'running' },
      fullAutomaticResearchWritingReady: false,
    }),
    pollMs: 60_000,
  });
  t.after(() => composition.close());
  assert.equal(composition.machineIntakeConfigured, false);
  assert.equal(composition.coldStartAutonomyReady, false);
  await composition.supervisor.runCycle();
  await composition.supervisor.runCycle();
  assert.deepEqual(events.slice(0, 3), [
    'mirror-reconcile',
    'automation-reconcile',
    'runtime-status',
  ]);
  assert.equal(events.filter((event) => event === 'mirror-reconcile').length, 1);
  assert.equal(events.filter((event) => event === 'runtime-status').length, 1);
});

test('canonical resident mode rejects pointer drift and fully-autonomous startup without intake', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-supervisor-startup-fence-root-'));
  const runtimeRoot = fs.mkdtempSync(path.join(
    os.tmpdir(),
    'hepta-supervisor-startup-fence-runtime-',
  ));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  assert.throws(() => composeAutonomousResearchSupervisor({
    root,
    runtimeRoot,
    requireFullyAutonomous: true,
    environment: {},
  }), /machine_intake_configuration_required/);
  assert.throws(() => composeAutonomousResearchSupervisor({
    root,
    runtimeRoot,
    environment: {
      HEPTA_FULL_RESEARCH_QUALIFICATION_RECEIPT: path.join(root, 'attacker-pointer.json'),
    },
  }), /qualification_pointer_path_mismatch/);
});

test('resident cold start loads and enqueues a machine intake under its fenced lease', async (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-supervisor-intake-cycle-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const stateRepository = createAutonomousResearchSupervisorStateRepository({ runtimeRoot });
  t.after(() => stateRepository.close());
  const now = new Date('2026-07-16T03:40:00.000Z');
  const machineIntake = buildAutonomousResearchMachineIntake({
    intakeId: 'intake:cold-start-test',
    paperId: 'cold-start-test',
    campaignId: 'autonomous-research:cold-start-test',
    launchMode: 'production-run',
    admissionCreatedAt: now.toISOString(),
    objective: 'Evaluate the bounded cold-start supervisor intake.',
    protocolFamily: 'ml_algorithm_benchmark',
    datasetMounts: [{
      name: 'cold-start-dataset',
      source: '/datasets/cold-start',
      readOnly: true,
      manifestHash: H('cold-start-dataset'),
      licenseId: 'CC0-1.0',
      benchmarkFamily: 'ml_algorithm_benchmark',
    }],
    budgets: {
      maxWallTimeMs: 60 * 60 * 1000,
      maxAgentCalls: 10,
      maxCpuJobs: 10,
      maxGpuJobs: 0,
      maxTokenCount: 10_000,
      maxCostUsd: 10,
      maxMemoryMiB: 2048,
    },
    providerConfigurationHash: H('cold-start-provider'),
    recurringGoldenProvenance: null,
    revisionRounds: 1,
    refereeCount: 2,
  });
  const persistedAdmission = buildAutonomousResearchMachineIntakeAdmission({
    intake: machineIntake,
    sourceKind: 'machine',
    sourceAuthorityHash: H('cold-start-source-authority'),
  });
  const record = Object.freeze({
    intakeId: machineIntake.intakeId,
    intakeHash: machineIntake.intakeHash,
    campaignId: machineIntake.campaignId,
    sourceKind: 'machine',
    sourceRef: 'machine-api',
    sourceAuthorityHash: H('cold-start-source-authority'),
    disposition: 'pending',
    admission: persistedAdmission,
    admissionHash: persistedAdmission.autonomousResearchMachineIntakeAdmissionHash,
    intake: machineIntake,
  });
  const lease = Object.freeze({
    ownerId: 'supervisor:intake-cycle',
    leaseToken: 'intake-lease:test',
    leaseGeneration: 1,
  });
  let listedAt = null;
  let marked = null;
  let released = false;
  let persistedCampaign = null;
  let emittedAdmission = null;
  let emittedReceipt = null;
  const machineRepository = {
    reconcileExpiredIntakeLeases() { return { recoveredLeaseCount: 0 }; },
    listPendingIntakes({ now: listedNow }) {
      listedAt = listedNow;
      return [record];
    },
    listEnqueuedIntakes() { return []; },
    readIntake() { return null; },
    tryAcquireIntakeLease() { return lease; },
    renewIntakeLease() { return { ...lease, expiresAt: '2026-07-16T03:45:00.000Z' }; },
    assertIntakeLease() { return lease; },
    markIntakeEnqueued(input) {
      marked = input;
      return {
        campaignPlanHash: input.campaignPlanHash,
        preparationHash: input.autonomousResearchLoopPreparationReportHash,
        admissionHash: input.autonomousResearchMachineIntakeAdmissionHash,
      };
    },
    markEnqueuedIntakeInvalid() {
      throw new Error('valid_enqueued_intake_must_not_be_invalidated');
    },
    deferIntake() { throw new Error('successful_intake_must_not_be_deferred'); },
    releaseIntakeLease() { released = true; },
  };
  const supervisor = createAutonomousResearchSupervisor({
    campaignStore: {
      listCampaigns() { return []; },
      getCampaign() { return persistedCampaign; },
    },
    stateRepository,
    async dispatchCampaign() { throw new Error('enqueue_only_must_not_dispatch'); },
    async readQualificationState() { return null; },
    async ensureRuntimeReproducibility() { return { ready: false }; },
    async runProviderCanary() { throw new Error('no_campaign_canary_must_not_run'); },
    async renewQualification() { throw new Error('no_campaign_renewal_must_not_run'); },
    async reconcileRuntime() { return null; },
    machineIntake: {
      repository: machineRepository,
      async loadConfiguredIntakes({ now: loadedAt }) {
        assert.equal(loadedAt.toISOString(), now.toISOString());
        return { attemptedCount: 1, insertedCount: 1, idempotentCount: 0, errorCount: 0 };
      },
      async enqueueIntake({ intake, machineIntakeAdmission, intakeLease, signal }) {
        emittedAdmission = machineIntakeAdmission;
        assert.equal(intake, record.intake);
        assert.equal(intakeLease.intakeId, record.intakeId);
        assert.equal(intakeLease.leaseToken, lease.leaseToken);
        assert.equal(signal.aborted, false);
        const preparationHash = H('cold-start-preparation');
        const executionAdmission = buildMachineIntakeExecutionAdmission(H('execution-admission'));
        const planPayload = {
          version: 4,
          kind: 'PaperCampaignPlan',
          autonomousResearchMachineIntakeHash: record.intakeHash,
          autonomousResearchMachineIntakeAdmissionHash:
            machineIntakeAdmission.autonomousResearchMachineIntakeAdmissionHash,
          executionAdmission,
          autonomousResearchPreparation: {
            proposal: { paperId: record.intake.paperId },
            autonomousResearchLoopPreparationReportHash: preparationHash,
            autonomousResearchMachineIntakeAdmissionHash:
              machineIntakeAdmission.autonomousResearchMachineIntakeAdmissionHash,
          },
        };
        const planHash = hashRecord('PaperCampaignPlan', planPayload);
        const admissionPreflightExecutionInspection =
          buildCanonicalAdmissionPreflightExecutionInspection();
        const payload = {
          version: 1,
          kind: 'AutonomousResearchCampaignEnqueueReceipt',
          status: 'autonomous_research_campaign_enqueued',
          campaignId: record.campaignId,
          paperId: record.intake.paperId,
          campaignPlanHash: planHash,
          autonomousResearchMachineIntakeHash: record.intakeHash,
          autonomousResearchMachineIntakeAdmission: machineIntakeAdmission,
          autonomousResearchMachineIntakeAdmissionHash:
            machineIntakeAdmission.autonomousResearchMachineIntakeAdmissionHash,
          autonomousResearchLoopPreparationReportHash: preparationHash,
          autonomousResearchCampaignExecutionAdmissionHash:
            executionAdmission.autonomousResearchCampaignExecutionAdmissionHash,
          admissionPreflightExecutionInspection,
          admissionOnly: true,
          executionAuthorized: false,
          initialCampaignStatus: 'paused',
          created: true,
          executionStarted: false,
          externalActionPerformed: false,
        };
        persistedCampaign = {
          campaignId: record.campaignId,
          paperId: record.intake.paperId,
          status: 'paused',
          currentPhase: 'admitted-not-authorized',
          spec: { ...planPayload, campaignPlanHash: planHash },
        };
        emittedReceipt = {
          ...payload,
          campaign: persistedCampaign,
          autonomousResearchCampaignEnqueueReceiptHash:
            hashRecord('AutonomousResearchCampaignEnqueueReceipt', payload),
        };
        return emittedReceipt;
      },
    },
    clock: { now: () => new Date(now) },
    scheduler: {
      async sleep() {}, setInterval() { return {}; }, clearInterval() {}, unref() {},
    },
    ownerId: lease.ownerId,
  });
  const cycle = await supervisor.runCycle();
  assert.equal(listedAt.toISOString(), now.toISOString());
  assert.equal(cycle.machineIntake.processedCount, 1);
  assert.equal(cycle.machineIntake.results[0].status, 'machine_intake_enqueued');
  assert.equal(marked.campaignPlanHash, persistedCampaign.spec.campaignPlanHash);
  assert.equal(released, false);

  const { campaign: _campaign, autonomousResearchCampaignEnqueueReceiptHash: _hash,
    ...attackerPayload } = { ...emittedReceipt, attackerControlled: true };
  const attackerReceipt = {
    ...attackerPayload,
    campaign: persistedCampaign,
    autonomousResearchCampaignEnqueueReceiptHash:
      hashRecord('AutonomousResearchCampaignEnqueueReceipt', attackerPayload),
  };
  assert.throws(() => verifyAutonomousResearchMachineIntakeEnqueueCommit({
    receipt: attackerReceipt,
    record,
    admission: emittedAdmission,
    campaignStore: { getCampaign: () => persistedCampaign },
  }), /enqueue_receipt_invalid/);
  assert.throws(() => verifyAutonomousResearchMachineIntakeEnqueueCommit({
    receipt: emittedReceipt,
    record,
    admission: emittedAdmission,
    campaignStore: { getCampaign: () => null },
  }), /campaign_commit_invalid/);
  const mismatchedCampaign = structuredClone(persistedCampaign);
  mismatchedCampaign.spec.autonomousResearchMachineIntakeHash = H('attacker-intake');
  assert.throws(() => verifyAutonomousResearchMachineIntakeEnqueueCommit({
    receipt: emittedReceipt,
    record,
    admission: emittedAdmission,
    campaignStore: { getCampaign: () => mismatchedCampaign },
  }), /campaign_commit_invalid/);
});

test('runtime reproducibility deferral prevents every qualification and campaign dispatch side effect', async (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-supervisor-runtime-gate-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const repository = createAutonomousResearchSupervisorStateRepository({ runtimeRoot });
  t.after(() => repository.close());
  const value = campaign(
    'autonomous-research:runtime-gated-paper',
    'paused',
    'supervisor_transient_failure',
  );
  const now = new Date('2026-07-16T03:30:00.000Z');
  let qualificationReads = 0;
  let dispatches = 0;
  const supervisor = createAutonomousResearchSupervisor({
    campaignStore: {
      listCampaigns() { return [value]; },
      getCampaign() { return value; },
    },
    stateRepository: repository,
    async reconcileRuntime() { return null; },
    async ensureRuntimeReproducibility() {
      return {
        ready: false,
        reason: 'runtime_reproducibility_refresh_leased',
        deferUntil: new Date(now.getTime() + 1000).toISOString(),
      };
    },
    async readQualificationState() { qualificationReads += 1; return null; },
    async runProviderCanary() { throw new Error('provider_canary_must_not_run'); },
    async renewQualification() { throw new Error('qualification_renewal_must_not_run'); },
    async dispatchCampaign() { dispatches += 1; return null; },
    lifecyclePolicy: {},
    clock: { now: () => new Date(now) },
    scheduler: {
      async sleep() {}, setInterval() { return {}; }, clearInterval() {}, unref() {},
    },
    ownerId: 'supervisor:runtime-gate',
  });
  const cycle = await supervisor.runCycle();
  assert.equal(cycle.results[0].reason, 'runtime_reproducibility_refresh_leased');
  assert.equal(qualificationReads, 0);
  assert.equal(dispatches, 0);
  assert.equal(repository.getCampaign(value.campaignId).disposition, 'active');
});

test('a fresh recurring Golden campaign executes before its first releasable qualification exists', async (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-supervisor-golden-first-run-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const repository = createAutonomousResearchSupervisorStateRepository({ runtimeRoot });
  t.after(() => repository.close());
  const base = buildExecutionAdmittedSupervisorCampaign({
    launchMode: 'golden-bootstrap',
    suffix: 'golden-first-run',
  });
  let value = base;
  const now = new Date('2026-07-16T03:45:00.000Z');
  const runtimeReceiptHash = H('golden-first-run-runtime');
  let qualificationState = null;
  const events = [];
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
        expiresAt: '2026-07-17T03:45:00.000Z',
        renewAt: '2026-07-17T03:30:00.000Z',
      };
    },
    async readQualificationState() { return qualificationState; },
    async runProviderCanary() {
      events.push('provider-canary');
      return {
        verified: true,
        providerCanaryPairReceiptHash: H('golden-first-run-canary'),
      };
    },
    async renewQualification({ campaign: renewingCampaign }) {
      events.push('pre-release-renewal');
      assert.equal(
        renewingCampaign.spec.autonomousResearchPreparation.launchMode,
        'golden-bootstrap',
      );
      assert.equal(qualificationState, null);
      return {
        ready: true,
        preReleaseExecutionAuthorized: true,
        reason: 'golden_bootstrap_must_produce_fresh_promotable_release',
      };
    },
    async dispatchCampaign({ action }) {
      events.push('golden-execution');
      assert.equal(action, 'resume');
      value = { ...value, status: 'completed', effectiveStatus: 'completed' };
      qualificationState = {
        recovery: {
          status: 'qualification_verified',
          totalAttemptCount: 1,
          reservedCostUsd: 0.05,
        },
        receipt: {
          expiresAt: '2026-07-17T03:45:00.000Z',
          runtimeImageReproducibilityReceiptHash: runtimeReceiptHash,
        },
      };
      return {
        status: 'autonomous_research_campaign_completed_and_qualified',
        campaign: { status: 'completed' },
        externalQualification: { status: 'qualification_external_service_verified' },
        campaignFullyQualified: true,
        fullAutomaticResearchWritingReady: true,
        autonomousResearchCampaignExecutionReportHash: H('golden-first-run-report'),
      };
    },
    lifecyclePolicy: {
      maximumLifetimeMs: 2 * 60 * 60 * 1000,
      providerCanaryReservationCostUsd: 1,
      maximumProviderCanaries: 8,
    },
    clock: { now: () => new Date(now) },
    scheduler: {
      async sleep() {}, setInterval() { return {}; }, clearInterval() {}, unref() {},
    },
    ownerId: 'supervisor:golden-first-run',
    pollMs: 1000,
  });
  const receipt = await supervisor.runCycle();
  assert.deepEqual(events, [
    'provider-canary',
    'pre-release-renewal',
    'golden-execution',
  ]);
  assert.equal(receipt.results[0].status, 'settled');
  assert.equal(receipt.results[0].outcome.campaignFullyQualified, true);
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
  assert.deepEqual(repository.beginDispatch({
    lease,
    campaignCostLimitUsd: 100,
    now,
  }), { authorized: true, dispatchCount: 1 });
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

function readinessLifecycle(now, overrides = {}) {
  return {
    absoluteDeadlineAt: new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString(),
    policy: {
      qualificationRenewalLeadMs: 15 * 60 * 1000,
      qualificationActionSafetyMarginMs: 15 * 60 * 1000,
      qualificationMaximumTotalAttempts: 48,
      qualificationMaximumTotalCostUsd: 25,
      qualificationAttemptReservationCostUsd: 0.05,
      ...overrides,
    },
  };
}

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

test('dispatcher signal aborts the active execution and durably pauses it for restart', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-supervisor-signal-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createDefaultPaperStore({ root, runtimeRoot: root, dbPath: path.join(root, 'paper.sqlite') });
  t.after(() => store.close());
  const clock = createSystemClock();
  const campaigns = createSqliteCampaignStore({ store, clock });
  const campaignId = 'autonomous-research:signal-paper';
  campaigns.createCampaign({
    campaignId,
    paperId: 'signal-paper',
    budgets: {
      maxWallTimeMs: 60_000,
      maxAgentCalls: 2,
      maxCpuJobs: 2,
      maxGpuJobs: 1,
      maxTokenCount: 1000,
      maxCostUsd: 10,
      maxMemoryMiB: 2048,
    },
    nodes: [{ nodeId: 'signal-node', kind: 'agent', dependencies: [], maxAttempts: 2 }],
  });
  const controller = new AbortController();
  let executionStarted;
  const started = new Promise((resolve) => { executionStarted = resolve; });
  const running = runPaperCampaign({
    campaignId,
    campaignStore: campaigns,
    executor: {
      async execute({ executionSignal }) {
        executionStarted();
        await new Promise((resolve, reject) => {
          executionSignal.addEventListener('abort', () => reject(
            Object.assign(new Error(String(executionSignal.reason)), { retryable: true }),
          ), { once: true });
        });
      },
    },
    concurrency: 1,
    leaseSeconds: 2,
    clock,
    scheduler: createSystemScheduler(),
    idGenerator: createRandomIdGenerator(),
    signal: controller.signal,
  });
  await started;
  controller.abort('supervisor_process_shutdown');
  const receipt = await running;
  assert.equal(receipt.campaign.status, 'paused');
  assert.equal(receipt.campaign.stopReason, 'supervisor_process_shutdown');
  assert.equal(campaigns.listNodes(campaignId)[0].status, 'queued');
});

test('canonical resident command forwards SIGTERM and exits through the graceful receipt', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-supervisor-cli-signal-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const assetRoot = path.join(base, 'assets');
  const runtimeRoot = path.join(base, 'runtime');
  fs.mkdirSync(assetRoot, { recursive: true });
  fs.mkdirSync(runtimeRoot, { recursive: true });
  const store = createDefaultPaperStore({ root: assetRoot, runtimeRoot });
  store.close();
  const child = spawn(process.execPath, [
    'paper-core/bin/hepta-paper.mjs',
    'operator',
    'autonomous-supervisor',
    '--',
    '--root', assetRoot,
    '--runtime-root', runtimeRoot,
    '--poll-ms', '5000',
  ], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      HEPTA_RESEARCH_AUTHOR_MAXIMUM_COST_PER_CALL_USD: '1',
      HEPTA_FORMAL_REVIEWER_MAXIMUM_COST_PER_CALL_USD: '1',
      HEPTA_RUNTIME_IMAGE_REPRODUCIBILITY_MAXIMUM_REFRESH_ATTEMPTS_PER_EPOCH: '2',
      HEPTA_RUNTIME_IMAGE_REPRODUCIBILITY_MAXIMUM_REFRESH_COST_USD_PER_EPOCH: '10',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let signaled = false;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    if (!signaled && stdout.includes('AutonomousResearchSupervisorCycleReceipt')) {
      signaled = true;
      child.kill('SIGTERM');
    }
  });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const watchdog = setTimeout(() => child.kill('SIGKILL'), 15_000);
  const result = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(watchdog);
  assert.equal(signaled, true, stderr);
  assert.deepEqual(result, { code: 0, signal: null }, stderr);
  assert.match(stdout, /AutonomousResearchSupervisorRunReceipt/);
  assert.match(stdout, /autonomous_research_supervisor_stopped_gracefully/);
});
