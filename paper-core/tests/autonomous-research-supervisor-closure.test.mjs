import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createAutonomousResearchSupervisorInstanceRepository,
} from '../../paper-adapters/automation/autonomous-research-supervisor-instance-repository.mjs';
import {
  createAutonomousResearchSupervisorStateRepository,
} from '../../paper-adapters/automation/autonomous-research-supervisor-state-repository.mjs';
import {
  createAutonomousResearchSupervisor,
  inspectAutonomousResearchMachineIntakeCampaignBinding,
} from '../../paper-application/automation/autonomous-research-supervisor.mjs';
import {
  discoverAutonomousResearchCampaignWindow,
} from '../../paper-application/automation/autonomous-research-supervisor-cycle.mjs';
import {
  createAutonomousResearchSupervisorAutonomyFence,
} from '../../paper-application/automation/autonomous-research-supervisor-autonomy-fence.mjs';
import {
  buildAutonomousResearchMachineIntakeAdmission,
} from '../../paper-domain/automation/autonomous-research-machine-intake-admission-contract.mjs';
import {
  buildAutonomousResearchMachineIntake,
  buildAutonomousResearchRecurringGoldenTemplate,
  materializeAutonomousResearchRecurringGoldenIntake,
} from '../../paper-domain/automation/autonomous-research-machine-intake-contract.mjs';
import {
  buildAutonomousResearchCapabilityScopeManifest,
} from '../../paper-domain/automation/autonomous-research-capability-scope-manifest.mjs';
import {
  inspectAutonomousResearchCampaignExecutionAdmission,
} from '../../paper-domain/automation/autonomous-research-campaign-execution-admission.mjs';
import {
  createAutonomousResearchSupervisorMachineIntakeAdapter,
} from '../../paper-composition/automation/autonomous-research-machine-intake-composition.mjs';
import {
  createAutonomousResearchAdmissionPreflightSandbox,
  createAutonomousResearchMachineIntakeActionFence,
} from '../../paper-composition/automation/autonomous-research-readiness-composition.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const H = (label) => hashRecord('AutonomousSupervisorClosureTestHash', { label });
const repositoryRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');

function residentPrerequisiteReceipt(operationMode, now) {
  const observedAt = now instanceof Date ? now : new Date(now);
  const infrastructureReady = operationMode !== 'blocked';
  const globalQualificationReady = operationMode === 'full';
  const identity = Object.freeze({
    externalQualificationConfigurationInspectionHash: H('resident-external-inspection'),
    externalQualificationConfigurationIdentityHash: H('resident-external-configuration'),
    externalQualificationTrustIdentityHash: H('resident-external-trust'),
    externalQualificationMaximumCostUsd: 1,
    externalQualificationCostAuthority: 'operator_declared_worst_case_usd',
    runtimeImageReproducibilityConfigurationIdentityHash: H('resident-runtime-configuration'),
    runtimeImageReproducibilityTrustIdentityHash: H('resident-runtime-trust'),
    externalActionRecoveryConfigurationIdentityHash: H('resident-external-action-recovery'),
    codeWorktreeStateHash: H('resident-code-worktree'),
  });
  const infrastructureBlockers = Object.freeze(infrastructureReady
    ? [] : ['autonomous_research_static_infrastructure_not_ready']);
  const globalQualificationBlockers = Object.freeze(globalQualificationReady
    ? [] : ['autonomous_research_full_qualification_pointer_not_ready']);
  const payload = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchResidentPrerequisiteReceipt',
    status: !infrastructureReady ? 'autonomous_research_resident_infrastructure_blocked'
      : globalQualificationReady ? 'autonomous_research_resident_prerequisites_ready'
        : 'autonomous_research_resident_bootstrap_only',
    ready: infrastructureReady && globalQualificationReady,
    infrastructureReady,
    globalQualificationReady,
    operationMode,
    inspectedAt: observedAt.toISOString(),
    ...identity,
    autonomousResearchResidentPrerequisiteIdentityHash: hashRecord(
      'AutonomousResearchResidentPrerequisiteIdentity', identity,
    ),
    zeroCostAuthorityEvidenceScope: null,
    fullResearchQualificationExpiresAt: globalQualificationReady
      ? new Date(observedAt.getTime() + 24 * 60 * 60 * 1000).toISOString() : null,
    runtimeImageReproducibilityExpiresAt: globalQualificationReady
      ? new Date(observedAt.getTime() + 24 * 60 * 60 * 1000).toISOString() : null,
    externalActionPerformed: false,
    networkActionPerformed: false,
    providerCanaryPerformed: false,
    releaseSignerChallengePerformed: false,
    infrastructureBlockers,
    globalQualificationBlockers,
    blockers: Object.freeze([...infrastructureBlockers, ...globalQualificationBlockers]),
  });
  return Object.freeze({
    ...payload,
    autonomousResearchResidentPrerequisiteReceiptHash: hashRecord(
      'AutonomousResearchResidentPrerequisiteReceipt', payload,
    ),
  });
}

function machineBoundSupervisorCampaign(launchMode, suffix) {
  const providerConfigurationHash = H(`resident-provider:${suffix}`);
  const sourceAuthorityHash = H(`resident-source:${suffix}`);
  const capabilityScopeManifest = launchMode === 'golden-bootstrap'
    ? buildAutonomousResearchCapabilityScopeManifest({
      empiricalFamilies: ['ml_algorithm_benchmark'],
    }) : null;
  const datasetMounts = [{
    name: `resident-dataset-${suffix}`,
    source: `/datasets/resident-${suffix}`,
    readOnly: true,
    manifestHash: H(`resident-dataset:${suffix}`),
    licenseId: 'CC0-1.0',
    benchmarkFamily: 'ml_algorithm_benchmark',
  }];
  const intake = launchMode === 'golden-bootstrap'
    ? materializeAutonomousResearchRecurringGoldenIntake({
      template: buildAutonomousResearchRecurringGoldenTemplate({
        templateId: `resident-${suffix}`,
        epochDurationMs: 12 * 60 * 60 * 1000,
        objective: `Renew the bounded resident qualification for ${suffix}.`,
        protocolFamily: 'ml_algorithm_benchmark',
        datasetMounts,
        providerConfigurationHash,
        revisionRounds: 1,
        refereeCount: 2,
      }),
      now: new Date('2026-07-17T00:00:00.000Z'),
      sourceAuthorityHash,
    }) : buildAutonomousResearchMachineIntake({
      intakeId: `intake:${suffix}`,
      paperId: `paper-${suffix}`,
      campaignId: `autonomous-research:paper-${suffix}`,
      launchMode: 'production-run',
      admissionCreatedAt: '2026-07-17T00:00:00.000Z',
      objective: `Execute the bounded production campaign for ${suffix}.`,
      protocolFamily: 'ml_algorithm_benchmark',
      datasetMounts,
      budgets: {
        maxWallTimeMs: 60 * 60 * 1000,
        maxAgentCalls: 10,
        maxCpuJobs: 10,
        maxGpuJobs: 0,
        maxTokenCount: 10_000,
        maxCostUsd: 10,
        maxMemoryMiB: 2048,
      },
      providerConfigurationHash,
      revisionRounds: 1,
      refereeCount: 2,
    });
  const sourceKind = launchMode === 'golden-bootstrap' ? 'recurring-golden' : 'machine';
  const admission = buildAutonomousResearchMachineIntakeAdmission({
    intake,
    sourceKind,
    sourceAuthorityHash,
  });
  const preparationPayload = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchLoopPreparationReport',
    launchMode,
    autonomousResearchProviderConfigurationHash: providerConfigurationHash,
    ...(capabilityScopeManifest ? {
      capabilityScopeManifest,
      capabilityScopeManifestHash:
        capabilityScopeManifest.autonomousResearchCapabilityScopeManifestHash,
    } : {}),
    autonomousResearchMachineIntakeAdmissionHash:
      admission.autonomousResearchMachineIntakeAdmissionHash,
    proposal: Object.freeze({
      paperId: intake.paperId,
      machineProposedScientificClaimSetHash: H(`resident-proposal:${suffix}`),
    }),
    policyAuthorization: Object.freeze({
      autonomousResearchPolicyAuthorizationHash: H(`resident-policy:${suffix}`),
    }),
    seedBinding: Object.freeze({
      autonomousResearchSeedBindingHash: H(`resident-seed:${suffix}`),
    }),
  });
  const preparation = Object.freeze({
    ...preparationPayload,
    autonomousResearchLoopPreparationReportHash: hashRecord(
      'AutonomousResearchLoopPreparationReport', preparationPayload,
    ),
  });
  const executionAdmissionPayload = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchCampaignExecutionAdmission',
    status: 'autonomous_research_campaign_admitted_not_authorized',
    initialCampaignStatus: 'paused',
    launchMode,
    supervisorDispatchAuthorizationRequired: true,
    autonomousResearchMachineIntakeHash: intake.intakeHash,
    autonomousResearchMachineIntakeAdmissionHash:
      admission.autonomousResearchMachineIntakeAdmissionHash,
    providerConfigurationHash,
  });
  const planPayload = Object.freeze({
    version: 4,
    kind: 'PaperCampaignPlan',
    campaignId: intake.campaignId,
    paperId: intake.paperId,
    budgets: intake.budgets,
    autonomousResearchPreparation: preparation,
    autonomousResearchMachineIntake: intake,
    autonomousResearchMachineIntakeHash: intake.intakeHash,
    autonomousResearchMachineIntakeAdmission: admission,
    autonomousResearchMachineIntakeAdmissionHash:
      admission.autonomousResearchMachineIntakeAdmissionHash,
    executionAdmission: Object.freeze({
      ...executionAdmissionPayload,
      autonomousResearchCampaignExecutionAdmissionHash: hashRecord(
        'AutonomousResearchCampaignExecutionAdmission', executionAdmissionPayload,
      ),
    }),
  });
  const campaignPlanHash = hashRecord('PaperCampaignPlan', planPayload);
  return Object.freeze({
    campaign: Object.freeze({
      campaignId: intake.campaignId,
      paperId: intake.paperId,
      status: 'paused',
      effectiveStatus: 'paused',
      currentPhase: 'admitted-not-authorized',
      stopReason: null,
      costKnown: true,
      costUsd: 0,
      spec: Object.freeze({ ...planPayload, campaignPlanHash }),
    }),
    record: Object.freeze({
      intakeId: intake.intakeId,
      intakeHash: intake.intakeHash,
      campaignId: intake.campaignId,
      sourceKind,
      sourceAuthorityHash,
      disposition: 'enqueued',
      campaignPlanHash,
      preparationHash: preparation.autonomousResearchLoopPreparationReportHash,
      admissionHash: admission.autonomousResearchMachineIntakeAdmissionHash,
      intake,
    }),
  });
}

test('full autonomous discovery and processing reject legacy minimal campaigns', () => {
  const now = new Date('2026-07-17T00:05:00.000Z');
  const machine = machineBoundSupervisorCampaign('production-run', 'full-fence');
  const legacy = Object.freeze({
    campaignId: 'autonomous-research:legacy-minimal',
    paperId: 'legacy-minimal',
    status: 'completed',
    effectiveStatus: 'completed',
    spec: Object.freeze({
      autonomousResearchPreparation: Object.freeze({
        proposal: Object.freeze({ paperId: 'legacy-minimal' }),
        capabilityScopeManifest: Object.freeze({
          manuscriptMode: 'minimal-report-evidence-bound-ir-v1',
        }),
      }),
    }),
  });
  const fence = createAutonomousResearchSupervisorAutonomyFence({
    required: true,
    inspectPrerequisites: ({ now: inspectedAt }) =>
      residentPrerequisiteReceipt('full', inspectedAt),
    clock: { now: () => now },
  });
  fence.inspectStartup();
  const machineIntake = {
    repository: {
      readIntake(intakeId) {
        return intakeId === machine.record.intakeId ? machine.record : null;
      },
    },
  };
  const window = discoverAutonomousResearchCampaignWindow({
    campaignStore: {
      listCampaigns({ offset }) { return offset === 0 ? [legacy, machine.campaign] : []; },
    },
    autonomyFence: fence,
    operationMode: 'full',
    machineIntake,
    limit: 10,
  });
  assert.deepEqual(window.campaigns.map((candidate) => candidate.campaignId), [
    machine.campaign.campaignId,
  ]);
  assert.equal(window.suppressedCampaignCount, 1);
  const processingBinding = inspectAutonomousResearchMachineIntakeCampaignBinding({
    campaign: legacy,
    requireRecord: true,
  });
  assert.equal(processingBinding.ready, false);
  assert.equal(processingBinding.reason, 'autonomous_research_machine_intake_campaign_missing');
});

test('machine execution admission remains fail-closed when all five top-level markers are stripped', () => {
  const fixture = machineBoundSupervisorCampaign('production-run', 'admission-strip');
  assert.deepEqual(inspectAutonomousResearchCampaignExecutionAdmission(fixture.campaign.spec), {
    present: true,
    valid: true,
    binding: {
      campaignId: fixture.campaign.campaignId,
      campaignPlanHash: fixture.campaign.spec.campaignPlanHash,
      launchMode: 'production-run',
      providerConfigurationHash:
        fixture.campaign.spec.executionAdmission.providerConfigurationHash,
      executionAdmissionHash: fixture.campaign.spec.executionAdmission
        .autonomousResearchCampaignExecutionAdmissionHash,
    },
  });
  const stripped = structuredClone(fixture.campaign.spec);
  for (const marker of [
    'autonomousResearchMachineIntake',
    'autonomousResearchMachineIntakeHash',
    'autonomousResearchMachineIntakeAdmission',
    'autonomousResearchMachineIntakeAdmissionHash',
    'executionAdmission',
  ]) delete stripped[marker];
  const { campaignPlanHash: _claimedHash, ...payload } = stripped;
  const inspection = inspectAutonomousResearchCampaignExecutionAdmission({
    ...payload,
    campaignPlanHash: hashRecord('PaperCampaignPlan', payload),
  });
  assert.equal(inspection.present, true);
  assert.equal(inspection.valid, false);
  assert.equal(inspection.binding, null);
});

function scheduler() {
  return Object.freeze({
    async sleep() {},
    setInterval() { return {}; },
    clearInterval() {},
    unref() {},
  });
}

test('supervisor machine-intake adapter forwards bootstrap-only without fallback', async () => {
  let received = null;
  let fallbackCalls = 0;
  const adapter = createAutonomousResearchSupervisorMachineIntakeAdapter({
    repository: {},
    plane: {
      async loadConfiguredIntakes(input) { received = input; return { ready: true }; },
    },
    loadFallback() { fallbackCalls += 1; return null; },
    enqueueIntake() {},
  });
  const now = new Date('2026-07-17T00:00:00.000Z');
  const residentLeaseContext = Object.freeze({ ownerId: 'resident:test' });
  assert.deepEqual(await adapter.loadConfiguredIntakes({
    now,
    residentLeaseContext,
    operationMode: 'bootstrap-only',
  }), { ready: true });
  assert.deepEqual(received, {
    now,
    residentLeaseContext,
    operationMode: 'bootstrap-only',
    assertAutonomyCurrent: undefined,
  });
  assert.equal(fallbackCalls, 0);
});

test('enqueue preflight rejects remote endpoints before spawn and sandboxes local argv', () => {
  let externalSpawns = 0;
  for (const environment of [
    { DOCKER_HOST: 'tcp://attacker.example:2375' },
    { DOCKER_CONTEXT: 'remote-production' },
    { OLLAMA_HOST: 'https://attacker.example:11434' },
    { OPENCLAW_GATEWAY_URL: 'wss://attacker.example/gateway' },
  ]) {
    assert.throws(() => createAutonomousResearchAdmissionPreflightSandbox({
      environment,
      spawnSyncImpl() { externalSpawns += 1; return { status: 0 }; },
    }), /autonomous_research_enqueue_remote_endpoint_forbidden/);
  }
  assert.equal(externalSpawns, 0);

  const calls = [];
  const sandbox = createAutonomousResearchAdmissionPreflightSandbox({
    environment: { DOCKER_HOST: 'unix:///var/run/docker.sock' },
    spawnSyncImpl(executable, args, options) {
      calls.push({ executable, args, options });
      return { status: 0, signal: null, stdout: 'ok', stderr: '' };
    },
  });
  sandbox.spawnSyncImpl('/usr/bin/codex', ['--version'], {
    env: { PATH: '/usr/bin', HTTPS_PROXY: 'https://attacker.example' },
  });
  sandbox.spawnSyncImpl('docker', ['image', 'inspect', 'runtime@sha256:test'], {});
  assert.equal(calls.length, 2);
  assert.equal(calls[0].executable, 'bwrap');
  assert.deepEqual(calls[0].args.slice(0, 4), [
    '--unshare-user-try', '--unshare-net', '--die-with-parent', '--new-session',
  ]);
  assert.deepEqual(calls[0].args.slice(-2), ['/usr/bin/codex', '--version']);
  assert.equal(calls[0].options.env.DOCKER_HOST, 'unix:///var/run/docker.sock');
  assert.equal(Object.hasOwn(calls[0].options.env, 'HTTPS_PROXY'), false);
  assert.throws(() => sandbox.spawnSyncImpl('ollama', ['list'], {}),
    /autonomous_research_enqueue_preflight_command_forbidden/);
  assert.deepEqual(sandbox.inspection(), {
    ...sandbox.inspection(),
    processCount: 2,
    localDockerDaemonProbeCount: 1,
    localProcessActionPerformed: true,
    localDaemonActionPerformed: true,
    networkActionPerformed: false,
    externalActionPerformed: false,
  });
});

test('machine-intake action fence requires a synchronous ready operation mode', () => {
  const now = new Date('2026-07-17T00:00:00.000Z');
  const createFence = ({ launchMode = 'production-run', inspection }) =>
    createAutonomousResearchMachineIntakeActionFence({
      intake: Object.freeze({ launchMode }),
      machineIntakeAdmission: Object.freeze({}),
      intakeLeaseRepository: Object.freeze({
        assertIntakeLease() {},
        renewIntakeLease() { return true; },
      }),
      intakeLease: Object.freeze({ intakeId: 'intake:fence' }),
      residentLeaseContext: Object.freeze({ ownerId: 'resident:fence' }),
      assertAutonomyCurrent() { return inspection; },
      currentTime: () => now,
      productionLaunchMode: 'production-run',
    });
  for (const inspection of [
    { ready: false, operationMode: 'full' },
    { ready: true, operationMode: 'bootstrap-only' },
    { ready: true, operationMode: 'blocked' },
  ]) {
    assert.throws(() => createFence({ inspection })(),
      /autonomous_research_machine_intake_autonomy_fence_blocked/);
  }
  assert.equal(createFence({ inspection: { ready: true, operationMode: 'full' } })()
    .operationMode, 'full');
  assert.equal(createFence({ inspection: { ready: true, operationMode: 'unrestricted' } })()
    .operationMode, 'unrestricted');
  assert.equal(createFence({
    launchMode: 'golden-bootstrap',
    inspection: { ready: true, operationMode: 'bootstrap-only' },
  })().operationMode, 'bootstrap-only');
  assert.throws(() => createFence({ inspection: Promise.resolve({ ready: true }) })(),
    /autonomous_research_machine_intake_autonomy_fence_must_be_synchronous/);
});

test('missing global pointer runs only recurring golden then automatically admits production', async (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-supervisor-bootstrap-mode-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const stateRepository = createAutonomousResearchSupervisorStateRepository({ runtimeRoot });
  const instanceRepository = createAutonomousResearchSupervisorInstanceRepository({ runtimeRoot });
  t.after(() => { stateRepository.close(); instanceRepository.close(); });
  const golden = machineBoundSupervisorCampaign('golden-bootstrap', 'bootstrap-golden');
  const production = machineBoundSupervisorCampaign('production-run', 'bootstrap-production');
  const campaigns = [golden.campaign, production.campaign];
  const records = new Map([golden, production].map((fixture) => [
    fixture.record.intakeId,
    fixture.record,
  ]));
  let operationMode = 'bootstrap-only';
  let now = new Date('2026-07-17T00:10:00.000Z');
  let prerequisiteInspections = 0;
  let topicProducerCanaries = 0;
  let topicProducerGenerations = 0;
  let productionIntakeLeaseAttempts = 0;
  let includePendingProduction = true;
  let runtimeRefreshes = 0;
  let providerCanaries = 0;
  let goldenDispatches = 0;
  let productionDispatches = 0;
  const controller = new AbortController();
  const cycles = [];
  const snapshots = [];
  const machineRepository = {
    reconcileExpiredIntakeLeases() { return { recoveredLeaseCount: 0 }; },
    listPendingIntakes() { return includePendingProduction ? [production.record] : []; },
    listEnqueuedIntakes() { return [golden.record, production.record]; },
    readIntake(intakeId) { return records.get(intakeId) || null; },
    tryAcquireIntakeLease() { productionIntakeLeaseAttempts += 1; return null; },
    renewIntakeLease() { throw new Error('pending_production_must_not_be_leased'); },
    assertIntakeLease() { throw new Error('pending_production_must_not_be_leased'); },
    markIntakeEnqueued() { throw new Error('pending_production_must_not_be_enqueued'); },
    markEnqueuedIntakeInvalid() { throw new Error('valid_binding_must_not_be_invalidated'); },
    deferIntake() { throw new Error('pending_production_must_not_be_deferred'); },
    releaseIntakeLease() { throw new Error('pending_production_must_not_be_released'); },
  };
  const supervisor = createAutonomousResearchSupervisor({
    campaignStore: {
      listCampaigns() { return campaigns; },
      getCampaign(campaignId) {
        return campaigns.find((campaign) => campaign.campaignId === campaignId) || null;
      },
    },
    stateRepository,
    residentInstanceRepository: instanceRepository,
    machineIntake: {
      repository: machineRepository,
      async loadConfiguredIntakes({ operationMode: requestedMode }) {
        if (requestedMode === 'full') {
          topicProducerCanaries += 1;
          topicProducerGenerations += 1;
        }
        return {
          configurationHash: H('bootstrap-machine-configuration'),
          attemptedCount: requestedMode === 'bootstrap-only' ? 1 : 2,
          insertedCount: 0,
          idempotentCount: requestedMode === 'bootstrap-only' ? 1 : 2,
          errorCount: 0,
          topicProducer: requestedMode === 'full' ? { ready: true } : null,
          topicProducerDatasetSnapshot: {
            datasetSnapshotHash: H('bootstrap-topic-producer-dataset'),
          },
          results: [],
        };
      },
      async enqueueIntake() { throw new Error('pending_production_must_not_be_enqueued'); },
    },
    requireFullyAutonomous: true,
    inspectFullyAutonomousPrerequisites({ now: inspectedAt }) {
      prerequisiteInspections += 1;
      return residentPrerequisiteReceipt(operationMode, inspectedAt);
    },
    async reconcileRuntime() { return null; },
    async ensureRuntimeReproducibility() {
      runtimeRefreshes += 1;
      return {
        ready: true,
        receiptHash: H('bootstrap-runtime-receipt'),
        expiresAt: '2026-07-18T00:10:00.000Z',
        renewAt: '2026-07-17T23:55:00.000Z',
      };
    },
    async readQualificationState() { return null; },
    async runProviderCanary() {
      providerCanaries += 1;
      return { verified: true, providerCanaryPairReceiptHash: H('bootstrap-canary') };
    },
    async renewQualification({ campaign: candidate }) {
      if (candidate.spec.autonomousResearchPreparation.launchMode === 'golden-bootstrap') {
        operationMode = 'full';
      }
      return { ready: true, preReleaseExecutionAuthorized: true };
    },
    async dispatchCampaign({ campaign: candidate }) {
      if (candidate.spec.autonomousResearchPreparation.launchMode === 'golden-bootstrap') {
        goldenDispatches += 1;
      } else { productionDispatches += 1; }
      return {
        status: 'qualification_pending',
        campaign: { status: 'running' },
        fullAutomaticResearchWritingReady: false,
      };
    },
    lifecyclePolicy: { providerCanaryReservationCostUsd: 0.1 },
    clock: { now: () => new Date(now) },
    scheduler: scheduler(),
    ownerId: 'supervisor:bootstrap-mode',
    maximumCampaignsPerCycle: 1,
    pollMs: 1000,
    signal: controller.signal,
    onCycle(receipt) {
      cycles.push(receipt);
      snapshots.push(Object.freeze({
        prerequisiteInspections,
        topicProducerCanaries,
        topicProducerGenerations,
        productionIntakeLeaseAttempts,
        runtimeRefreshes,
        providerCanaries,
        goldenDispatches,
        productionDispatches,
      }));
      if (cycles.length === 1) {
        includePendingProduction = false;
        now = new Date(now.getTime() + 2000);
      } else if (cycles.length === 2) {
        operationMode = 'blocked';
        now = new Date(now.getTime() + 2000);
      } else controller.abort('closure_test_complete');
    },
  });

  await supervisor.run();
  const [bootstrapCycle, fullCycle, blockedCycle] = cycles;
  const [bootstrapSnapshot, fullSnapshot, blockedSnapshot] = snapshots;
  assert.equal(bootstrapCycle.autonomyOperationMode, 'bootstrap-only');
  assert.equal(bootstrapCycle.discoveredCampaignCount, 1);
  assert.equal(bootstrapCycle.suppressedCampaignCount, 1);
  assert.equal(bootstrapSnapshot.goldenDispatches, 1);
  assert.equal(bootstrapSnapshot.productionDispatches, 0);
  assert.equal(bootstrapSnapshot.productionIntakeLeaseAttempts, 0);
  assert.equal(bootstrapSnapshot.topicProducerCanaries, 0);
  assert.equal(bootstrapSnapshot.topicProducerGenerations, 0);
  assert.equal(bootstrapSnapshot.runtimeRefreshes, 1);
  assert.equal(bootstrapSnapshot.providerCanaries, 1);
  assert.ok(bootstrapSnapshot.prerequisiteInspections >= 7);

  assert.equal(fullCycle.autonomyOperationMode, 'full');
  assert.equal(fullSnapshot.productionDispatches, 1);
  assert.equal(fullSnapshot.topicProducerCanaries, 1);
  assert.equal(fullSnapshot.topicProducerGenerations, 1);
  assert.ok(fullSnapshot.prerequisiteInspections
    > bootstrapSnapshot.prerequisiteInspections);

  assert.equal(blockedCycle.status, 'autonomous_research_supervisor_autonomy_fence_blocked');
  assert.equal(blockedCycle.discoveredCampaignCount, 0);
  assert.equal(blockedCycle.processedCampaignCount, 0);
  assert.equal(blockedSnapshot.goldenDispatches, 1);
  assert.equal(blockedSnapshot.productionDispatches, 1);
  assert.equal(blockedSnapshot.topicProducerCanaries, 1);
  assert.equal(blockedSnapshot.topicProducerGenerations, 1);
  assert.equal(blockedSnapshot.prerequisiteInspections,
    fullSnapshot.prerequisiteInspections + 1);
});

test('infrastructure drift after runtime refresh blocks provider and campaign actions', async (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-supervisor-action-fence-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const stateRepository = createAutonomousResearchSupervisorStateRepository({ runtimeRoot });
  const instanceRepository = createAutonomousResearchSupervisorInstanceRepository({ runtimeRoot });
  t.after(() => { stateRepository.close(); instanceRepository.close(); });
  const fixture = machineBoundSupervisorCampaign('production-run', 'action-fence');
  let operationMode = 'full';
  let prerequisiteInspections = 0;
  let runtimeRefreshes = 0;
  let providerCanaries = 0;
  let qualificationRenewals = 0;
  let dispatches = 0;
  const controller = new AbortController();
  let cycle = null;
  const machineRepository = {
    reconcileExpiredIntakeLeases() { return { recoveredLeaseCount: 0 }; },
    listPendingIntakes() { return []; },
    listEnqueuedIntakes() { return [fixture.record]; },
    readIntake(intakeId) {
      return intakeId === fixture.record.intakeId ? fixture.record : null;
    },
    tryAcquireIntakeLease() { return null; },
    renewIntakeLease() { return null; },
    assertIntakeLease() {},
    markIntakeEnqueued() {},
    markEnqueuedIntakeInvalid() {},
    deferIntake() {},
    releaseIntakeLease() {},
  };
  const supervisor = createAutonomousResearchSupervisor({
    campaignStore: {
      listCampaigns() { return [fixture.campaign]; },
      getCampaign() { return fixture.campaign; },
    },
    stateRepository,
    residentInstanceRepository: instanceRepository,
    machineIntake: {
      repository: machineRepository,
      async loadConfiguredIntakes() {
        return {
          configurationHash: H('action-fence-machine-configuration'),
          attemptedCount: 1,
          insertedCount: 0,
          idempotentCount: 1,
          errorCount: 0,
          topicProducer: { ready: true },
          topicProducerDatasetSnapshot: {
            datasetSnapshotHash: H('action-fence-dataset-snapshot'),
          },
          results: [],
        };
      },
      async enqueueIntake() { throw new Error('no_pending_intake_expected'); },
    },
    requireFullyAutonomous: true,
    inspectFullyAutonomousPrerequisites({ now: inspectedAt }) {
      prerequisiteInspections += 1;
      return residentPrerequisiteReceipt(operationMode, inspectedAt);
    },
    async reconcileRuntime() { return null; },
    async ensureRuntimeReproducibility() {
      runtimeRefreshes += 1;
      operationMode = 'blocked';
      return {
        ready: true,
        receiptHash: H('action-fence-runtime-receipt'),
        expiresAt: '2026-07-18T00:10:00.000Z',
        renewAt: '2026-07-17T23:55:00.000Z',
      };
    },
    async readQualificationState() { return null; },
    async runProviderCanary() { providerCanaries += 1; return { verified: true }; },
    async renewQualification() { qualificationRenewals += 1; return { ready: true }; },
    async dispatchCampaign() { dispatches += 1; return { status: 'unreachable' }; },
    lifecyclePolicy: { providerCanaryReservationCostUsd: 0.1 },
    clock: { now: () => new Date('2026-07-17T00:10:00.000Z') },
    scheduler: scheduler(),
    ownerId: 'supervisor:action-fence',
    pollMs: 1000,
    signal: controller.signal,
    onCycle(receipt) { cycle = receipt; controller.abort('closure_test_complete'); },
  });

  await supervisor.run();
  assert.equal(cycle.processedCampaignCount, 1);
  assert.equal(cycle.results[0].status, 'cooldown');
  assert.match(cycle.results[0].error,
    /autonomous_research_supervisor_autonomy_fence_blocked/);
  assert.equal(runtimeRefreshes, 1);
  assert.equal(providerCanaries, 0);
  assert.equal(qualificationRenewals, 0);
  assert.equal(dispatches, 0);
  assert.ok(prerequisiteInspections >= 5);
});

test('systemd and Kubernetes contracts host canonical resident probes without secrets', () => {
  const systemd = fs.readFileSync(path.join(repositoryRoot,
    'paper-core/deploy/autonomous-research-supervisor.service'), 'utf8');
  const environment = fs.readFileSync(path.join(repositoryRoot,
    'paper-core/deploy/autonomous-research-supervisor.env.example'), 'utf8');
  const dispatcherSystemd = fs.readFileSync(path.join(repositoryRoot,
    'paper-core/deploy/autonomous-submission-dispatcher.service'), 'utf8');
  const dispatcherEnvironment = fs.readFileSync(path.join(repositoryRoot,
    'paper-core/deploy/autonomous-submission-dispatcher.env.example'), 'utf8');
  const kubernetes = fs.readFileSync(path.join(repositoryRoot,
    'paper-core/deploy/autonomous-research-supervisor.k8s.yaml'), 'utf8');
  const operations = fs.readFileSync(path.join(repositoryRoot,
    'paper-core/docs/autonomous-research-supervisor.md'), 'utf8');
  assert.match(systemd, /hepta-paper\.mjs operator autonomous-supervisor --/);
  assert.match(systemd, /Restart=always/);
  assert.match(systemd, /^StartLimitIntervalSec=15min$/m);
  assert.match(systemd, /^StartLimitBurst=5$/m);
  assert.match(systemd, /^TimeoutStartSec=1h$/m);
  assert.match(systemd, /KillSignal=SIGTERM/);
  assert.match(systemd, /KillMode=mixed/);
  assert.match(systemd,
    /ReadOnlyPaths=\/srv\/hepta-paper\/assets \/srv\/hepta-paper\/datasets/);
  assert.match(systemd, /\/etc\/hepta-paper\/authority-rotation/);
  assert.match(systemd, /ReadWritePaths=-\/var\/lib\/hepta-paper\/runtime/);
  assert.match(systemd, /--qualification-action-safety-margin-ms/);
  assert.match(systemd, /--require-fully-autonomous/);
  assert.match(systemd,
    /ExecStartPre=\/usr\/bin\/flock --exclusive --nonblock \/run\/hepta-paper-state-backup\/renew\.lock .*--action reconcile-and-renew/);
  assert.match(systemd,
    /--authority-config \$\{HEPTA_AUTONOMOUS_RESEARCH_STATE_BACKUP_AUTHORITY_CONFIG\}/);
  assert.match(systemd,
    /--online-authority-process-config \$\{HEPTA_AUTONOMOUS_RESEARCH_ONLINE_MUTATION_AUTHORITY_PROCESS_CONFIG\}/);
  assert.match(systemd, /--root \$\{HEPTA_PAPER_ASSET_ROOT\}/);
  assert.match(systemd, /--runtime-root \$\{HEPTA_PAPER_RUNTIME_ROOT\}/);
  assert.match(systemd,
    /^ExecCondition=\/usr\/bin\/test -r \$\{HEPTA_FORMAL_SANDBOX_RUNTIME_CONFIG\}$/m);
  assert.match(systemd,
    /^ExecCondition=\/usr\/bin\/test -r \$\{HEPTA_PRODUCTION_MATHLIB_BUILD_AUTHORITY_CONFIG\}$/m);
  assert.match(systemd, /--machine-intake-config/);
  assert.match(systemd, /--topic-producer-profile/);
  assert.match(systemd, /--resident-instance-lease-ms/);
  assert.match(systemd, /--resident-instance-heartbeat-ms/);
  assert.match(systemd,
    /EnvironmentFile=\/etc\/hepta-paper\/autonomous-research-provider\.secrets\.env/);
  assert.match(environment,
    /^PAPER_FACTORY_LEGACY_ROOT=\/var\/lib\/hepta-paper\/legacy-reference$/m);
  assert.match(environment,
    /^HEPTA_FORMAL_SANDBOX_RUNTIME_CONFIG=\/etc\/hepta-paper\/formal\/formal-sandbox-runtime\.json$/m);
  assert.match(environment,
    /^HEPTA_FORMAL_SANDBOX_RUNTIME_CONFIG_HASH=REPLACE_WITH_SHA256_CONFIGURATION_HASH$/m);
  assert.match(environment,
    /^HEPTA_PRODUCTION_MATHLIB_BUILD_AUTHORITY_CONFIG=\/run\/hepta-authority\/production-mathlib-build-authority\.json$/m);
  assert.match(environment,
    /^HEPTA_PRODUCTION_MATHLIB_BUILD_AUTHORITY_CONFIGURATION_HASH=REPLACE_WITH_SHA256_CONFIGURATION_HASH$/m);
  assert.doesNotMatch(systemd, /autonomous-submission-dispatcher\.secrets\.env/);
  assert.match(systemd, /\/etc\/hepta-paper\/capabilities-public/);
  assert.match(systemd, /\/etc\/hepta-paper\/online-mutation-authority/);
  assert.match(systemd, /\/etc\/hepta-paper\/state-backup-authority/);
  assert.match(systemd,
    /^ConditionPathExists=\/etc\/hepta-paper\/submission-portal$/m);
  assert.match(systemd,
    /^ConditionPathExists=\/etc\/hepta-paper\/submission-dispatcher-signer$/m);
  assert.match(systemd,
    /^InaccessiblePaths=\/etc\/hepta-paper\/submission-portal \/etc\/hepta-paper\/submission-dispatcher-signer$/m);
  assert.doesNotMatch(systemd,
    /^InaccessiblePaths=.*(?:^|\s)-\/etc\/hepta-paper\/(?:submission-portal|submission-dispatcher-signer)/m);
  assert.match(systemd, /^PrivateTmp=yes$/m);
  assert.match(systemd,
    /^SupplementaryGroups=docker hepta-runtime-handoff$/m);
  assert.match(systemd, /^UMask=0007$/m);
  assert.match(systemd, /^ExecStartPre=\/usr\/bin\/test -w \/var\/lib\/hepta-paper\/runtime$/m);
  assert.match(systemd, /^ExecStartPre=\/usr\/bin\/test ! -g \/var\/lib\/hepta-paper\/runtime$/m);
  assert.match(systemd,
    /^ExecStartPre=\/usr\/bin\/test -g \/var\/lib\/hepta-paper\/runtime\/autonomous-research\/submission-handoff$/m);
  assert.match(systemd,
    /^RuntimeDirectory=hepta-paper-worker hepta-paper-state-backup$/m);
  assert.match(systemd, /^RuntimeDirectoryMode=0700$/m);
  assert.match(systemd, /^Environment=TMPDIR=\/run\/hepta-paper-worker$/m);
  assert.match(systemd,
    /^ReadWritePaths=-\/var\/lib\/hepta-paper\/runtime \/run\/hepta-paper-worker \/run\/hepta-paper-state-backup$/m);
  assert.match(systemd, /docker\.sock access is root-equivalent/);
  assert.match(systemd, /only on a dedicated host/);
  assert.doesNotMatch(systemd, /(?:ReadOnlyPaths|ReadWritePaths)=\$\{/);
  assert.match(kubernetes, /restartPolicy: Always/);
  assert.match(kubernetes, /terminationGracePeriodSeconds: 900/);
  assert.match(kubernetes, /^\s+automountServiceAccountToken: false$/m);
  assert.match(kubernetes,
    /^\s+runtimeClassName: REPLACE_WITH_EXTERNALLY_QUALIFIED_NESTED_CONTAINER_RUNTIME_CLASS$/m);
  assert.match(kubernetes,
    /hepta\.paper\/nested-runtime-admission: required/);
  assert.match(kubernetes,
    /hepta\.paper\/nested-runtime-contract: hepta-nested-container-runtime-v1/);
  assert.match(kubernetes,
    /hepta\.paper\/nested-runtime-profile-id: REPLACE_WITH_EXTERNALLY_QUALIFIED_PROFILE_ID/);
  assert.match(kubernetes,
    /hepta\.paper\/nested-runtime-qualification-receipt-sha256: REPLACE_WITH_SHA256_OF_SIGNED_QUALIFICATION_RECEIPT/);
  assert.match(kubernetes,
    /hepta\.paper\/nested-runtime-conformance-receipt-sha256: REPLACE_WITH_SHA256_OF_CURRENT_POD_SIGNED_CONFORMANCE_RECEIPT/);
  assert.match(kubernetes,
    /hepta\.paper\/nested-runtime-qualification-signer: REPLACE_WITH_INDEPENDENT_QUALIFIER_KEY_ID/);
  assert.match(kubernetes,
    /hepta\.paper\/nested-runtime-conformance: bind-rw-uid-gid-network-none-memory-cpu-pids-parent-pod-v1/);
  assert.match(kubernetes,
    /hepta\.paper\/dedicated-autonomous-research-node: "true"/);
  assert.match(kubernetes,
    /hepta\.paper\/nested-runtime-profile-id: REPLACE_WITH_EXTERNALLY_QUALIFIED_PROFILE_ID/);
  assert.match(kubernetes, /readOnlyRootFilesystem: true/);
  assert.match(kubernetes, /claimName: hepta-runtime/);
  assert.match(kubernetes, /mountPath: \/datasets\n\s+readOnly: true/);
  assert.match(kubernetes, /claimName: hepta-research-datasets/);
  assert.match(kubernetes,
    /mountPath: \/etc\/hepta-paper\/authority-rotation\n\s+readOnly: true/);
  assert.match(kubernetes, /claimName: hepta-autonomous-research-intake-authority/);
  assert.doesNotMatch(kubernetes, /^\s*fsGroup:/m);
  assert.match(kubernetes, /- autonomous-supervisor/);
  assert.match(kubernetes, /- --require-fully-autonomous/);
  assert.match(kubernetes, /- --machine-intake-config/);
  assert.match(kubernetes, /startupProbe:/);
  assert.match(kubernetes, /readinessProbe:/);
  assert.match(kubernetes, /livenessProbe:/);
  assert.match(kubernetes, /autonomous-research-supervisor-health\.mjs/);
  assert.match(kubernetes, /HEPTA_AUTONOMOUS_RESEARCH_INTAKE_CONFIG/);
  assert.match(kubernetes, /HEPTA_PAPER_ASSET_ROOT\n\s+value: \/hepta\/assets/);
  assert.match(kubernetes, /HEPTA_PAPER_RUNTIME_ROOT\n\s+value: \/hepta\/runtime/);
  assert.match(kubernetes, /HEPTA_AUTONOMOUS_RESEARCH_TOPIC_PRODUCER_PROFILE/);
  assert.match(kubernetes, /- --topic-producer-profile/);
  assert.match(kubernetes, /HEPTA_RUNTIME_IMAGE_REPRODUCIBILITY_CONFIG/);
  assert.match(kubernetes, /HEPTA_RUNTIME_IMAGE_REPRODUCIBILITY_CONFIG_HASH/);
  assert.match(kubernetes,
    /HEPTA_RUNTIME_IMAGE_REPRODUCIBILITY_MAXIMUM_REFRESH_ATTEMPTS_PER_EPOCH/);
  assert.match(kubernetes,
    /HEPTA_RUNTIME_IMAGE_REPRODUCIBILITY_MAXIMUM_REFRESH_COST_USD_PER_EPOCH/);
  assert.match(kubernetes,
    /HEPTA_RUNTIME_IMAGE_REPRODUCIBILITY_REFRESH_RENEWAL_LEAD_MS/);
  assert.match(kubernetes,
    /HEPTA_RUNTIME_IMAGE_REPRODUCIBILITY_REFRESH_ACTION_SAFETY_MARGIN_MS/);
  assert.match(kubernetes, /mountPath: \/hepta\/runtime-reproducibility/);
  assert.match(kubernetes,
    /mountPath: \/hepta\/online-mutation-authority\n\s+readOnly: true/);
  assert.match(kubernetes,
    /mountPath: \/hepta\/state-backup-authority\n\s+readOnly: true/);
  assert.match(kubernetes,
    /claimName: hepta-autonomous-research-online-mutation-authority/);
  assert.match(kubernetes,
    /claimName: hepta-autonomous-research-state-backup-authority/);
  assert.match(kubernetes, /mountPath: \/hepta\/capabilities-public\n\s+readOnly: true/);
  assert.match(kubernetes,
    /claimName: hepta-autonomous-research-public-capability-config/);
  assert.match(kubernetes,
    /secretRef:\n\s+name: hepta-autonomous-research-provider-tokens/);
  const qualificationGateStart = kubernetes.indexOf(
    '- name: nested-runtime-platform-qualification-gate',
  );
  const applicationStart = kubernetes.indexOf('      containers:');
  assert.ok(qualificationGateStart > 0);
  assert.ok(applicationStart > qualificationGateStart);
  const qualificationGate = kubernetes.slice(qualificationGateStart, applicationStart);
  assert.match(qualificationGate, /image: REPLACE_WITH_PINNED_HEPTA_IMAGE_DIGEST/);
  assert.match(qualificationGate,
    /paper-core\/bin\/nested-runtime-platform-qualification\.mjs/);
  assert.match(qualificationGate, /fieldPath: metadata\.uid/);
  assert.match(qualificationGate,
    /HEPTA_NESTED_RUNTIME_CONFORMANCE_RECEIPT_SHA256/);
  assert.doesNotMatch(qualificationGate, /exit 78/);
  assert.match(qualificationGate, /runAsUser: 10001/);
  assert.match(qualificationGate, /allowPrivilegeEscalation: false/);
  assert.match(qualificationGate, /readOnlyRootFilesystem: true/);
  assert.match(kubernetes,
    /name: qualified-runtime-run\n\s+emptyDir:\n\s+medium: Memory/);
  assert.match(kubernetes,
    /name: qualified-runtime-run\n\s+mountPath: \/var\/run/);
  assert.match(kubernetes, /name: tmp\n\s+emptyDir:/);
  assert.match(kubernetes, /name: tmp\n\s+mountPath: \/tmp/);
  assert.match(kubernetes,
    /name: DOCKER_HOST\n\s+value: unix:\/\/\/var\/run\/docker\.sock/);
  assert.doesNotMatch(kubernetes, /dockerd-rootless\.sh/);
  assert.doesNotMatch(kubernetes, /ROOTLESS_DOCKER/);
  assert.doesNotMatch(kubernetes, /name: rootless-docker-daemon/);
  assert.doesNotMatch(kubernetes, /name: load-pinned-runtime-images/);
  assert.doesNotMatch(kubernetes,
    /paper-core\/bin\/automation-runtime-image-bundle-loader\.mjs/);
  assert.doesNotMatch(kubernetes, /claimName: hepta-runtime-image-oci-bundle/);
  assert.doesNotMatch(kubernetes, /^\s+hostUsers:/m);
  assert.doesNotMatch(kubernetes, /^\s*hostPath:/m);
  assert.doesNotMatch(kubernetes, /privileged: true/);
  assert.doesNotMatch(kubernetes, /seccompProfile:\n\s+type: Unconfined/);
  assert.match(environment,
    /HEPTA_SUPERVISOR_QUALIFICATION_ACTION_SAFETY_MARGIN_MS=900000/);
  assert.match(environment, /HEPTA_AUTONOMOUS_RESEARCH_INTAKE_CONFIG=/);
  assert.match(environment, /HEPTA_PAPER_ASSET_ROOT=\/srv\/hepta-paper\/assets/);
  assert.match(environment, /HEPTA_PAPER_RUNTIME_ROOT=\/var\/lib\/hepta-paper\/runtime/);
  assert.doesNotMatch(environment, /^HEPTA_(?:ASSET|RUNTIME)_ROOT=/m);
  assert.match(environment, /HEPTA_AUTONOMOUS_RESEARCH_TOPIC_PRODUCER_PROFILE=/);
  assert.match(environment,
    /HEPTA_AUTONOMOUS_RESEARCH_DATASET_ROOT=\/srv\/hepta-paper\/datasets/);
  assert.match(kubernetes,
    /HEPTA_AUTONOMOUS_RESEARCH_DATASET_ROOT\n\s+value: \/datasets/);
  assert.match(environment, /HEPTA_SUPERVISOR_INSTANCE_LEASE_MS=900000/);
  assert.match(environment, /HEPTA_SUPERVISOR_INSTANCE_HEARTBEAT_MS=30000/);
  assert.match(systemd, /RuntimeMaxSec=8h/);
  assert.match(systemd, /TimeoutStopSec=15min/);
  assert.match(kubernetes, /failureThreshold: 180/);
  assert.match(kubernetes, /--require-startup-reconciliation/);
  assert.match(kubernetes, /readinessProbe:[\s\S]*periodSeconds: 30/);
  assert.match(kubernetes, /readinessProbe:[\s\S]*timeoutSeconds: 25/);
  assert.match(environment,
    /HEPTA_RUNTIME_IMAGE_REPRODUCIBILITY_REFRESH_ACTION_SAFETY_MARGIN_MS=900000/);
  assert.match(environment,
    /^HEPTA_RUNTIME_IMAGE_REPRODUCIBILITY_CONFIG_HASH=REPLACE_WITH_SHA256_CONFIGURATION_IDENTITY_HASH$/m);
  assert.match(environment,
    /^HEPTA_AUTONOMOUS_RESEARCH_ONLINE_MUTATION_AUTHORITY_PROCESS_CONFIG=\/etc\/hepta-paper\/online-mutation-authority\/process-config\.json$/m);
  assert.match(environment,
    /^HEPTA_AUTONOMOUS_RESEARCH_ONLINE_MUTATION_AUTHORITY_CONFIG=\/etc\/hepta-paper\/online-mutation-authority\/authority-config\.json$/m);
  assert.match(environment,
    /^HEPTA_AUTONOMOUS_RESEARCH_STATE_BACKUP_AUTHORITY_CONFIG=\/etc\/hepta-paper\/state-backup-authority\/process-config\.json$/m);
  assert.match(kubernetes,
    /name: HEPTA_AUTONOMOUS_RESEARCH_ONLINE_MUTATION_AUTHORITY_PROCESS_CONFIG\n\s+value: \/hepta\/online-mutation-authority\/process-config\.json/);
  assert.match(kubernetes,
    /name: HEPTA_AUTONOMOUS_RESEARCH_ONLINE_MUTATION_AUTHORITY_CONFIG\n\s+value: \/hepta\/online-mutation-authority\/authority-config\.json/);
  assert.match(kubernetes,
    /name: HEPTA_AUTONOMOUS_RESEARCH_STATE_BACKUP_AUTHORITY_CONFIG\n\s+value: \/hepta\/state-backup-authority\/process-config\.json/);
  const genericCapabilityEnvironment = Object.freeze({
    HEPTA_AUTONOMOUS_RESEARCH_CONTENT_MODE: 'agent-evidence-bound',
    HEPTA_DYNAMIC_FORMAL_CLAIMS_ENABLED: '1',
    HEPTA_PRIOR_ART_SERVICE_CONFIG:
      '/etc/hepta-paper/capabilities-public/prior-art-service.json',
    HEPTA_EXTERNAL_REPLAY_CONFIG:
      '/etc/hepta-paper/capabilities-public/external-replay-service.json',
    HEPTA_AUTONOMOUS_VENUE_PROFILE_CONFIG:
      '/etc/hepta-paper/capabilities-public/venue-profiles.json',
    HEPTA_AUTONOMOUS_SUBMISSION_PORTAL_DESCRIPTOR_CONFIG:
      '/etc/hepta-paper/capabilities-public/submission-portal-descriptor.json',
    HEPTA_AUTONOMOUS_SUBMISSION_METADATA_CONFIG:
      '/etc/hepta-paper/capabilities-public/submission-metadata.json',
  });
  for (const [name, value] of Object.entries(genericCapabilityEnvironment)) {
    const escapePattern = (candidate) => String(candidate)
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(environment, new RegExp(`^${name}=${escapePattern(value)}$`, 'm'));
    const kubernetesValue = value === '1'
      ? '"1"'
      : String(value).replace('/etc/hepta-paper', '/hepta');
    assert.match(kubernetes, new RegExp(
      `name: ${name}\\n\\s+value: ${escapePattern(kubernetesValue)}`,
    ));
  }
  assert.match(environment,
    /^HEPTA_RESEARCH_AUTHOR_IDENTITY_CONFIG=\/etc\/hepta-paper\/capabilities-public\/research-author-identity\.json$/m);
  assert.match(environment,
    /^HEPTA_RESEARCH_AUTHOR_IDENTITY_CONFIG_HASH=REPLACE_WITH_SHA256_CONFIGURATION_HASH$/m);
  assert.match(environment,
    /^# HEPTA_REVIEWER_PRINCIPAL_POOL_CONFIG=\/etc\/hepta-paper\/capabilities-public\/reviewer-principals\.json$/m);
  assert.match(kubernetes,
    /name: HEPTA_RESEARCH_AUTHOR_IDENTITY_CONFIG\n\s+value: \/hepta\/capabilities-public\/research-author-identity\.json/);
  assert.match(kubernetes,
    /name: HEPTA_REVIEWER_PRINCIPAL_POOL_CONFIG\n\s+value: \/hepta\/capabilities-public\/reviewer-principals\.json/);
  assert.match(environment,
    /^HEPTA_PRIOR_ART_SERVICE_CONFIG_HASH=REPLACE_WITH_SHA256_CONFIGURATION_HASH$/m);
  assert.match(environment,
    /^HEPTA_EXTERNAL_REPLAY_CONFIG_HASH=REPLACE_WITH_SHA256_CONFIGURATION_HASH$/m);
  assert.match(environment,
    /^HEPTA_AUTONOMOUS_VENUE_PROFILE_CONFIG_HASH=REPLACE_WITH_SHA256_CONFIGURATION_HASH$/m);
  assert.match(environment,
    /^HEPTA_AUTONOMOUS_SUBMISSION_PORTAL_CONFIGURATION_HASH=REPLACE_WITH_SHA256_CONFIGURATION_HASH$/m);
  assert.match(environment,
    /^HEPTA_AUTONOMOUS_SUBMISSION_PORTAL_DESCRIPTOR_HASH=REPLACE_WITH_SHA256_PUBLIC_DESCRIPTOR_HASH$/m);
  assert.match(environment,
    /^HEPTA_AUTONOMOUS_SUBMISSION_METADATA_CONFIG_HASH=REPLACE_WITH_SHA256_CONFIGURATION_HASH$/m);
  assert.match(kubernetes,
    /name: HEPTA_RESEARCH_AUTHOR_IDENTITY_CONFIG_HASH\n\s+valueFrom:\n\s+configMapKeyRef:\n\s+name: hepta-autonomous-research-supervisor\n\s+key: research-author-identity-configuration-hash/);
  assert.match(kubernetes,
    /name: HEPTA_PRIOR_ART_SERVICE_CONFIG_HASH\n\s+valueFrom:\n\s+configMapKeyRef:\n\s+name: hepta-autonomous-research-supervisor\n\s+key: prior-art-service-configuration-hash/);
  assert.match(kubernetes,
    /name: HEPTA_EXTERNAL_REPLAY_CONFIG_HASH\n\s+valueFrom:\n\s+configMapKeyRef:\n\s+name: hepta-autonomous-research-supervisor\n\s+key: external-replay-service-configuration-hash/);
  assert.match(kubernetes,
    /name: HEPTA_RUNTIME_IMAGE_REPRODUCIBILITY_CONFIG_HASH\n\s+valueFrom:\n\s+configMapKeyRef:\n\s+name: hepta-autonomous-research-supervisor\n\s+key: runtime-reproducibility-configuration-identity-hash/);
  assert.match(kubernetes,
    /name: HEPTA_AUTONOMOUS_VENUE_PROFILE_CONFIG_HASH\n\s+valueFrom:\n\s+configMapKeyRef:\n\s+name: hepta-autonomous-research-supervisor\n\s+key: venue-profile-configuration-hash/);
  assert.match(kubernetes,
    /name: HEPTA_AUTONOMOUS_SUBMISSION_PORTAL_CONFIGURATION_HASH\n\s+valueFrom:\n\s+configMapKeyRef:\n\s+name: hepta-autonomous-research-supervisor\n\s+key: submission-portal-configuration-hash/);
  assert.match(kubernetes,
    /name: HEPTA_AUTONOMOUS_SUBMISSION_PORTAL_DESCRIPTOR_HASH\n\s+valueFrom:\n\s+configMapKeyRef:\n\s+name: hepta-autonomous-research-supervisor\n\s+key: submission-portal-descriptor-hash/);
  assert.match(kubernetes,
    /name: HEPTA_AUTONOMOUS_SUBMISSION_METADATA_CONFIG_HASH\n\s+valueFrom:\n\s+configMapKeyRef:\n\s+name: hepta-autonomous-research-supervisor\n\s+key: submission-metadata-configuration-hash/);
  assert.doesNotMatch(environment, /^HEPTA_AUTONOMOUS_SUBMISSION_PORTAL_CONFIG=/m);
  const supervisorDeployment = kubernetes.slice(0, kubernetes.indexOf('\n---\n'));
  assert.doesNotMatch(supervisorDeployment,
    /HEPTA_AUTONOMOUS_SUBMISSION_PORTAL_CONFIG(?:\s|$)/);
  assert.doesNotMatch(supervisorDeployment,
    /hepta-autonomous-submission-portal-token/);
  assert.match(supervisorDeployment,
    /hepta\.paper\/submission-dispatch-capability: "denied"/);
  assert.match(dispatcherSystemd, /^User=hepta-submission-dispatcher$/m);
  assert.match(dispatcherSystemd, /^SupplementaryGroups=hepta-runtime-handoff$/m);
  assert.match(dispatcherSystemd, /^UMask=0007$/m);
  assert.match(dispatcherSystemd,
    /^ExecStartPre=\/usr\/bin\/test ! -w \/var\/lib\/hepta-paper\/runtime\/hepta-paper\.sqlite$/m);
  assert.match(dispatcherSystemd,
    /^ExecStartPre=\/usr\/bin\/test -w \/var\/lib\/hepta-paper\/runtime\/autonomous-research\/submission-handoff\/submission-handoff\.sqlite$/m);
  assert.match(dispatcherSystemd,
    /EnvironmentFile=\/etc\/hepta-paper\/autonomous-submission-dispatcher\.secrets\.env/);
  assert.match(dispatcherSystemd,
    /operator autonomous-submission-dispatcher -- --resident/);
  assert.match(dispatcherEnvironment,
    /^HEPTA_AUTONOMOUS_SUBMISSION_PORTAL_CONFIG=\/etc\/hepta-paper\/submission-portal\/config\.json$/m);
  assert.match(dispatcherEnvironment,
    /^HEPTA_AUTONOMOUS_SUBMISSION_PORTAL_DESCRIPTOR_HASH=REPLACE_WITH_SHA256_PUBLIC_DESCRIPTOR_HASH$/m);
  assert.match(kubernetes, /name: hepta-autonomous-submission-dispatcher/);
  assert.match(kubernetes,
    /serviceAccountName: hepta-autonomous-submission-dispatcher/);
  assert.equal((kubernetes.match(/supplementalGroups: \[20001\]/g) || []).length, 2);
  assert.equal((kubernetes.match(/test "\$\(stat -c %g \/hepta\/runtime\/autonomous-research\/submission-handoff\)" = "20001"/g)
    || []).length, 2);
  assert.equal((kubernetes.match(/test "\$\(stat -c %a \/hepta\/runtime\/autonomous-research\/submission-handoff\)" = "3770"/g)
    || []).length, 2);
  assert.equal((kubernetes.match(/umask 0007/g) || []).length, 2);
  assert.match(kubernetes, /name: hepta-autonomous-submission-portal-token/);
  assert.match(kubernetes,
    /name: hepta-autonomous-submission-dispatcher-egress/);
  assert.match(kubernetes, /cidr: 192\.0\.2\.1\/32/);
  assert.match(operations, /HEPTA_RESEARCH_AUTHOR_IDENTITY_CONFIG_HASH/);
  assert.match(operations,
    /HEPTA_AUTONOMOUS_RESEARCH_ONLINE_MUTATION_AUTHORITY_PROCESS_CONFIG/);
  assert.match(operations,
    /HEPTA_AUTONOMOUS_RESEARCH_ONLINE_MUTATION_AUTHORITY_CONFIG/);
  assert.match(operations,
    /HEPTA_AUTONOMOUS_RESEARCH_STATE_BACKUP_AUTHORITY_CONFIG/);
  assert.match(operations, /out-of-band deployment pin/);
  assert.match(operations, /reconcileMirror\(\)/);
  assert.match(operations, /fixed UTC 24-hour budget epochs/);
  assert.match(operations, /datasetMounts\[\]\.source/);
  assert.match(operations,
    /remaining persisted campaign wall-time budget plus a minimum 15-minute/);
  assert.match(operations, /checked-in Kubernetes manifest is fail-closed/);
  assert.match(operations, /nested-runtime-platform-qualification-gate/);
  assert.match(operations, /RuntimeClass name alone is only a\s+CRI selector/);
  assert.match(operations, /static qualification payload binds one exact platform profile/);
  assert.match(operations, /fixed-digest worker/);
  assert.match(operations, /bind sources are visible and writable/);
  assert.match(operations, /parent Pod resource ceiling/);
  assert.match(operations, /privileged or unconfined container/);
  assert.match(operations,
    /operator nested-runtime-platform-qualification/);
  assert.match(operations, /trusting\s+annotations by\s+themselves is not qualification/);
  assert.match(operations, /AUTHORITY_TRUST_STORE\.json/);
  assert.match(operations, /OWNER_TRUST_STORE\.json/);
  assert.match(operations, /AUTONOMOUS_RESEARCH_INTAKE_AUTHORITY_BOOTSTRAP\.json/);
  assert.doesNotMatch(operations, /AUTONOMOUS_RESEARCH_INTAKE_AUTHORITY_GENESIS\.json/);
  assert.match(operations, /--rotation-intent/);
  assert.match(operations, /projected ConfigMap or Secret/);
  assert.match(operations,
    /linearizable authority head controlled by a different security\s+identity/);
  assert.match(operations, /bundled `hepta-paper-state-authority` service/);
  assert.match(operations, /remote durable authority state/);
  assert.match(operations, /Every\s+trust-bearing SQLite transaction/);
  assert.match(operations, /replayable SQLite changeset/);
  assert.match(operations, /authoritative database-scope inventory/);
  assert.match(operations, /Provider or KMS actions/);
  assert.match(operations, /same-host profile remains \*\*No-Go\*\*/);
  assert.doesNotMatch(`${systemd}\n${environment}\n${kubernetes}`,
    /(?:api[_-]?key|access[_-]?token|private[_-]?key|password)\s*[:=]\s*[A-Za-z0-9+/]{16,}/i);
});
