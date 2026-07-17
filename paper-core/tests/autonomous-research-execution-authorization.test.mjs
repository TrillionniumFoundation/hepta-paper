import assert from 'node:assert/strict';
import test from 'node:test';
import {
  executeAutonomousResearchCampaign,
  requireAutonomousResearchAdmissionPreflightExecutionInspection,
} from '../../paper-application/automation/autonomous-research-campaign.mjs';
import {
  issueAutonomousResearchSupervisorDispatchAuthorization,
  verifyAutonomousResearchSupervisorDispatchAuthorization,
} from '../../paper-application/automation/autonomous-research-supervisor-dispatch-authorization.mjs';
import {
  createCampaignLifecycleOperations,
} from '../../paper-adapters/persistence/sqlite-campaign-lifecycle-operations.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  buildAutonomousResearchMachineIntake,
  buildAutonomousResearchRecurringGoldenTemplate,
  materializeAutonomousResearchRecurringGoldenIntake,
} from '../../paper-domain/automation/autonomous-research-machine-intake-contract.mjs';
import {
  buildAutonomousResearchMachineIntakeAdmission,
} from '../../paper-domain/automation/autonomous-research-machine-intake-admission-contract.mjs';

const NOW = new Date('2026-07-17T08:00:00.000Z');
const H = (label) => hashRecord('AutonomousResearchExecutionAuthorizationTestHash', { label });

function machineExecutionPlan(launchMode, suffix = launchMode) {
  const paperId = `authorization-${launchMode}`;
  const campaignId = `autonomous-research:${paperId}`;
  const providerConfigurationHash = H('provider-configuration');
  const datasetMounts = [{
    name: 'authorization-dataset',
    source: '/datasets/authorization',
    readOnly: true,
    manifestHash: H('dataset-manifest'),
    licenseId: 'CC0-1.0',
    benchmarkFamily: 'ml_algorithm_benchmark',
  }];
  const budgets = {
    maxWallTimeMs: 60 * 60 * 1000,
    maxAgentCalls: 10,
    maxCpuJobs: 10,
    maxGpuJobs: 0,
    maxTokenCount: 10_000,
    maxCostUsd: 10,
    maxMemoryMiB: 2048,
  };
  const intake = launchMode === 'golden-bootstrap'
    ? materializeAutonomousResearchRecurringGoldenIntake({
      template: buildAutonomousResearchRecurringGoldenTemplate({
        templateId: `authorization-${suffix}`,
        epochDurationMs: 12 * 60 * 60 * 1000,
        objective: `Renew the authorization fixture ${suffix}.`,
        protocolFamily: 'ml_algorithm_benchmark',
        datasetMounts,
        budgets,
        providerConfigurationHash,
        revisionRounds: 1,
        refereeCount: 2,
      }),
      now: new Date('2026-07-17T00:00:00.000Z'),
      sourceAuthorityHash: H('source-authority'),
    }) : buildAutonomousResearchMachineIntake({
      intakeId: `intake:${suffix}`,
      paperId,
      campaignId,
      launchMode,
      admissionCreatedAt: '2026-07-17T00:00:00.000Z',
      objective: `Execute the authorization fixture ${suffix}.`,
      protocolFamily: 'ml_algorithm_benchmark',
      datasetMounts,
      budgets,
      providerConfigurationHash,
      revisionRounds: 1,
      refereeCount: 2,
    });
  const boundPaperId = intake.paperId;
  const boundCampaignId = intake.campaignId;
  const intakeAdmission = buildAutonomousResearchMachineIntakeAdmission({
    intake,
    sourceKind: launchMode === 'golden-bootstrap' ? 'recurring-golden' : 'machine',
    sourceAuthorityHash: H('source-authority'),
  });
  const preparation = Object.freeze({
    launchMode,
    autonomousResearchProviderConfigurationHash: providerConfigurationHash,
    autonomousResearchMachineIntakeAdmissionHash:
      intakeAdmission.autonomousResearchMachineIntakeAdmissionHash,
  });
  const executionPayload = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchCampaignExecutionAdmission',
    status: 'autonomous_research_campaign_admitted_not_authorized',
    initialCampaignStatus: 'paused',
    launchMode,
    supervisorDispatchAuthorizationRequired: true,
    autonomousResearchMachineIntakeHash: intake.intakeHash,
    autonomousResearchMachineIntakeAdmissionHash:
      intakeAdmission.autonomousResearchMachineIntakeAdmissionHash,
    providerConfigurationHash,
  });
  const planPayload = Object.freeze({
    campaignId: boundCampaignId,
    paperId: boundPaperId,
    maxRounds: 1,
    nodes: Object.freeze([Object.freeze({
      nodeId: `${boundCampaignId}:research-plan`,
      kind: 'research-plan',
      roundIndex: 0,
      priority: 10,
      dependencies: Object.freeze([]),
      maxAttempts: 1,
    })]),
    budgets: intake.budgets,
    autonomousResearchPreparation: preparation,
    autonomousResearchMachineIntake: intake,
    autonomousResearchMachineIntakeHash: intake.intakeHash,
    autonomousResearchMachineIntakeAdmission: intakeAdmission,
    autonomousResearchMachineIntakeAdmissionHash:
      intakeAdmission.autonomousResearchMachineIntakeAdmissionHash,
    executionAdmission: Object.freeze({
      ...executionPayload,
      autonomousResearchCampaignExecutionAdmissionHash: hashRecord(
        'AutonomousResearchCampaignExecutionAdmission', executionPayload,
      ),
    }),
  });
  return Object.freeze({
    ...planPayload,
    campaignPlanHash: hashRecord('PaperCampaignPlan', planPayload),
  });
}

function rehashPlan(spec) {
  const { campaignPlanHash: _claimed, ...payload } = spec;
  return Object.freeze({
    ...payload,
    campaignPlanHash: hashRecord('PaperCampaignPlan', payload),
  });
}

function campaignFixture({
  launchMode = 'production-run',
  status = 'running',
  machineIntake = true,
} = {}) {
  const spec = machineIntake ? machineExecutionPlan(launchMode) : Object.freeze({
    campaignPlanHash: H(`manual-plan:${launchMode}`),
    autonomousResearchPreparation: Object.freeze({
      launchMode,
      autonomousResearchProviderConfigurationHash: H('provider-configuration'),
    }),
    budgets: Object.freeze({ maxWallTimeMs: 60_000, maxAgentCalls: 1, maxCostUsd: 1 }),
  });
  let campaign = Object.freeze({
    campaignId: spec.campaignId || `autonomous-research:authorization-${launchMode}`,
    paperId: spec.paperId || `authorization-${launchMode}`,
    status,
    spec,
  });
  const store = Object.freeze({
    createCampaign() { throw new Error('unexpected_create'); },
    getCampaign() { return campaign; },
    listNodes() { return []; },
    resumeCampaign() {
      campaign = Object.freeze({ ...campaign, status: 'running' });
      return campaign;
    },
  });
  return Object.freeze({
    store,
    read: () => campaign,
    replace(next) { campaign = Object.freeze(next); },
  });
}

function authorizationFixture(campaign, {
  action = 'resume',
  launchMode = campaign.spec.autonomousResearchPreparation.launchMode,
  campaignPlanHash = campaign.spec.campaignPlanHash,
} = {}) {
  const campaignLease = Object.freeze({
    campaignId: campaign.campaignId,
    ownerId: 'supervisor:execution-authorization-test',
    leaseToken: 'campaign-lease-token',
    leaseGeneration: 3,
  });
  const providerCanaryState = Object.freeze({
    campaignId: campaign.campaignId,
    policy: Object.freeze({ providerCanaryIntervalMs: 15 * 60 * 1000 }),
    lastProviderCanaryAt: new Date(NOW.getTime() - 60_000).toISOString(),
    lastProviderCanaryStatus: 'verified',
    lastProviderCanaryReceiptHash: H('provider-canary'),
    leaseOwner: campaignLease.ownerId,
    leaseToken: campaignLease.leaseToken,
    leaseGeneration: campaignLease.leaseGeneration,
    leaseExpiresAt: new Date(NOW.getTime() + 30 * 60 * 1000).toISOString(),
    dispatchCount: 1,
  });
  const residentLease = Object.freeze({
    ownerId: campaignLease.ownerId,
    leaseToken: 'resident-lease-token',
    leaseGeneration: 4,
    expiresAt: new Date(NOW.getTime() + 30 * 60 * 1000).toISOString(),
  });
  const residentLeaseContext = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchResidentLeaseContext',
    stage: 'before_campaign_dispatch',
    ownerId: residentLease.ownerId,
    leaseGeneration: residentLease.leaseGeneration,
    leaseExpiresAt: residentLease.expiresAt,
    lease: residentLease,
    assertCurrent({ now }) {
      if (now.getTime() >= Date.parse(residentLease.expiresAt)) {
        throw new Error('resident_lease_lost');
      }
    },
  });
  return issueAutonomousResearchSupervisorDispatchAuthorization({
    campaignId: campaign.campaignId,
    campaignPlanHash,
    launchMode,
    action,
    providerConfigurationHash:
      campaign.spec.autonomousResearchPreparation.autonomousResearchProviderConfigurationHash,
    campaignLease,
    residentLeaseContext,
    providerCanaryState,
    now: NOW,
    assertCampaignLease({ lease, now }) {
      if (lease !== campaignLease
        || now.getTime() >= Date.parse(providerCanaryState.leaseExpiresAt)) {
        throw new Error('campaign_lease_lost');
      }
    },
    readCampaignState() { return providerCanaryState; },
  });
}

async function executeFixture(fixture, {
  action = 'resume',
  authorization = null,
  now = NOW,
  onRun = () => {},
} = {}) {
  return executeAutonomousResearchCampaign({
    action,
    campaignId: fixture.read().campaignId,
    campaignStore: fixture.store,
    executor: Object.freeze({ async execute() {} }),
    campaignRunner: async () => {
      onRun();
      return Object.freeze({ externalActionPerformed: true });
    },
    supervisorDispatchAuthorization: authorization,
    runtime: Object.freeze({ clock: Object.freeze({ now: () => new Date(now) }) }),
  });
}

for (const launchMode of ['golden-bootstrap', 'production-run']) {
  test(`${launchMode} machine intake requires and consumes one resident dispatch authorization`, async () => {
    const fixture = campaignFixture({ launchMode, status: 'paused' });
    let runnerCalls = 0;
    await assert.rejects(
      () => executeFixture(fixture, { onRun: () => { runnerCalls += 1; } }),
      /autonomous_research_supervisor_dispatch_authorization_invalid/,
    );
    assert.equal(fixture.read().status, 'paused');
    assert.equal(runnerCalls, 0);

    const authorization = authorizationFixture(fixture.read());
    await executeFixture(fixture, {
      authorization,
      onRun: () => { runnerCalls += 1; },
    });
    assert.equal(fixture.read().status, 'running');
    assert.equal(runnerCalls, 1);

    await assert.rejects(
      () => executeFixture(fixture, {
        authorization,
        onRun: () => { runnerCalls += 1; },
      }),
      /autonomous_research_supervisor_dispatch_authorization_invalid/,
    );
    assert.equal(runnerCalls, 1);
  });
}

test('dispatch authorization rejects wrong plan, mode, action, expiry, copy, and extra fields', () => {
  const fixture = campaignFixture({ status: 'paused' });
  const authorization = authorizationFixture(fixture.read());
  const common = {
    authorization,
    campaignId: fixture.read().campaignId,
    campaignPlanHash: fixture.read().spec.campaignPlanHash,
    launchMode: 'production-run',
    action: 'resume',
    providerConfigurationHash:
      fixture.read().spec.autonomousResearchPreparation
        .autonomousResearchProviderConfigurationHash,
    now: NOW,
  };
  assert.equal(verifyAutonomousResearchSupervisorDispatchAuthorization(common), true);
  assert.equal(verifyAutonomousResearchSupervisorDispatchAuthorization({
    ...common, campaignPlanHash: H('wrong-plan'),
  }), false);
  assert.equal(verifyAutonomousResearchSupervisorDispatchAuthorization({
    ...common, launchMode: 'golden-bootstrap',
  }), false);
  assert.equal(verifyAutonomousResearchSupervisorDispatchAuthorization({
    ...common, action: 'launch',
  }), false);
  assert.equal(verifyAutonomousResearchSupervisorDispatchAuthorization({
    ...common, now: new Date(NOW.getTime() + 5 * 60 * 1000),
  }), false);
  assert.equal(verifyAutonomousResearchSupervisorDispatchAuthorization({
    ...common, authorization: Object.freeze({ ...authorization }),
  }), false);
  assert.equal(verifyAutonomousResearchSupervisorDispatchAuthorization({
    ...common, authorization: Object.freeze({ ...authorization, unexpected: true }),
  }), false);
});

test('non-machine application execution remains compatible without resident authorization', async () => {
  const fixture = campaignFixture({ machineIntake: false });
  let runnerCalls = 0;
  await executeFixture(fixture, { action: 'launch', onRun: () => { runnerCalls += 1; } });
  assert.equal(runnerCalls, 1);
});

test('tampered persisted machine markers cannot bypass dispatch authorization', async () => {
  const fixture = campaignFixture({ status: 'running' });
  const tampered = structuredClone(fixture.read().spec);
  delete tampered.executionAdmission;
  fixture.replace(Object.freeze({
    ...fixture.read(),
    spec: rehashPlan(tampered),
  }));
  let runnerCalls = 0;
  await assert.rejects(() => executeFixture(fixture, {
    action: 'launch',
    onRun: () => { runnerCalls += 1; },
  }), /autonomous_research_machine_intake_dispatch_binding_invalid/);
  assert.equal(runnerCalls, 0);
});

function preflightInspection({ processCount = 8, localDockerDaemonProbeCount = 2 } = {}) {
  const payload = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchAdmissionPreflightExecutionInspection',
    sandbox: 'bubblewrap-unshare-net-read-only-root-v1',
    processCount,
    localDockerDaemonProbeCount,
    localProcessActionPerformed: processCount > 0,
    localDaemonActionPerformed: localDockerDaemonProbeCount > 0,
    networkActionPerformed: false,
    externalActionPerformed: false,
  });
  return Object.freeze({
    ...payload,
    autonomousResearchAdmissionPreflightExecutionInspectionHash: hashRecord(
      'AutonomousResearchAdmissionPreflightExecutionInspection',
      payload,
    ),
  });
}

test('self-hashed zero-observation admission preflight cannot authorize enqueue', () => {
  const observed = preflightInspection();
  assert.equal(
    requireAutonomousResearchAdmissionPreflightExecutionInspection(observed),
    observed,
  );
  assert.throws(
    () => requireAutonomousResearchAdmissionPreflightExecutionInspection(
      preflightInspection({ processCount: 0, localDockerDaemonProbeCount: 0 }),
    ),
    /autonomous_research_admission_preflight_execution_inspection_invalid/,
  );
});

function admittedPlan() {
  return machineExecutionPlan('production-run', 'admitted-plan');
}

test('machine intake create is atomically persisted paused and admitted-not-authorized', () => {
  const transactions = [];
  const plan = admittedPlan();
  const operations = createCampaignLifecycleOperations({
    clock: Object.freeze({ nowIso: () => NOW.toISOString() }),
    transaction(statements) { transactions.push(statements); },
    guarded: (sql) => sql,
    eventStatement: () => Object.freeze({ sql: 'INSERT EVENT;' }),
    readCampaignDefinitionSnapshot: () => Object.freeze({ campaign: null, nodes: [] }),
    getApi: () => Object.freeze({
      getCampaign: () => Object.freeze({ campaignId: plan.campaignId, status: 'paused' }),
    }),
  });
  const created = operations.createCampaign(plan);
  assert.equal(created.status, 'paused');
  assert.equal(transactions.length, 1);
  assert.match(transactions[0][0], /'paused'/);
  assert.match(transactions[0][0], /'admitted-not-authorized'/);
  assert.doesNotMatch(transactions[0].join('\n'), /SET status='running'/);

  const forged = structuredClone(plan);
  forged.executionAdmission.providerConfigurationHash = H('forged-provider');
  assert.throws(
    () => operations.createCampaign(forged),
    /campaign_execution_admission_invalid/,
  );
  assert.equal(transactions.length, 1);

  const missingExecutionAdmission = structuredClone(plan);
  delete missingExecutionAdmission.executionAdmission;
  assert.throws(
    () => operations.createCampaign(rehashPlan(missingExecutionAdmission)),
    /campaign_execution_admission_invalid/,
  );
  const orphanExecutionAdmission = structuredClone(plan);
  for (const marker of [
    'autonomousResearchMachineIntake',
    'autonomousResearchMachineIntakeHash',
    'autonomousResearchMachineIntakeAdmission',
    'autonomousResearchMachineIntakeAdmissionHash',
  ]) delete orphanExecutionAdmission[marker];
  assert.throws(
    () => operations.createCampaign(rehashPlan(orphanExecutionAdmission)),
    /campaign_execution_admission_invalid/,
  );
  assert.equal(transactions.length, 1);
});
