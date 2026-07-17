import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  appendMachineAutonomousResearchIntake,
  AUTONOMOUS_RESEARCH_MACHINE_INTAKE_CONFIGURATION_LIMITS,
  buildAutonomousResearchMachineIntakeConfiguration,
  loadConfiguredAutonomousResearchMachineIntakes,
  readAutonomousResearchMachineIntakeConfiguration,
  verifyAutonomousResearchMachineIntakeConfiguration,
} from '../../paper-adapters/automation/autonomous-research-machine-intake-loader.mjs';
import {
  createAutonomousResearchMachineIntakeRepository,
  AUTONOMOUS_RESEARCH_MACHINE_INTAKE_ADMISSION_LIMITS,
} from '../../paper-adapters/automation/autonomous-research-machine-intake-repository.mjs';
import {
  AUTONOMOUS_RESEARCH_GOLDEN_RECURRING_HARD_BUDGETS,
  buildAutonomousResearchMachineIntake,
  buildAutonomousResearchRecurringGoldenTemplate,
  materializeAutonomousResearchRecurringGoldenIntake,
  verifyAutonomousResearchMachineIntake,
  verifyAutonomousResearchRecurringGoldenTemplate,
} from '../../paper-domain/automation/autonomous-research-machine-intake-contract.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const H = (value) => `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
const BUDGETS = Object.freeze({
  maxWallTimeMs: 60 * 60 * 1000,
  maxAgentCalls: 24,
  maxCpuJobs: 32,
  maxGpuJobs: 0,
  maxTokenCount: 100_000,
  maxCostUsd: 25,
  maxMemoryMiB: 4096,
});

function datasetMount(suffix = 'fixture') {
  return {
    name: `benchmark-${suffix}`,
    source: `/datasets/benchmark-${suffix}`,
    readOnly: true,
    manifestHash: H(`dataset-${suffix}`),
    licenseId: 'CC0-1.0',
    benchmarkFamily: 'ml_algorithm_benchmark',
  };
}

function intake(suffix = 'fixture', overrides = {}) {
  const paperId = overrides.paperId || `paper:${suffix}`;
  return buildAutonomousResearchMachineIntake({
    intakeId: overrides.intakeId || `intake:${suffix}`,
    paperId,
    campaignId: overrides.campaignId || `autonomous-research:${paperId}`,
    launchMode: overrides.launchMode || 'production-run',
    objective: overrides.objective || `Evaluate the bounded ${suffix} research objective.`,
    protocolFamily: 'ml_algorithm_benchmark',
    datasetMounts: overrides.datasetMounts || [datasetMount(suffix)],
    budgets: overrides.budgets || BUDGETS,
    providerConfigurationHash: overrides.providerConfigurationHash || H('provider'),
    revisionRounds: overrides.revisionRounds ?? 2,
    refereeCount: overrides.refereeCount ?? 3,
    admissionCreatedAt: overrides.admissionCreatedAt || '2026-07-16T00:00:00.000Z',
    recurringGoldenProvenance: overrides.recurringGoldenProvenance ?? null,
  });
}

function template(overrides = {}) {
  return buildAutonomousResearchRecurringGoldenTemplate({
    templateId: overrides.templateId || 'qualification-smoke',
    epochDurationMs: overrides.epochDurationMs || 12 * 60 * 60 * 1000,
    objective: overrides.objective
      || 'Continuously qualify the bounded autonomous research loop.',
    protocolFamily: 'ml_algorithm_benchmark',
    datasetMounts: [datasetMount('golden')],
    budgets: overrides.budgets || {},
    providerConfigurationHash: overrides.providerConfigurationHash || H('provider'),
    revisionRounds: 1,
    refereeCount: 2,
  });
}

function tempRoot(t, label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `hepta-${label}-`));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeJson(candidate, value) {
  fs.writeFileSync(candidate, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(candidate, 0o600);
}

function rehashIntake(value) {
  const { intakeHash: _oldHash, ...payload } = value;
  return { ...payload, intakeHash: hashRecord('AutonomousResearchMachineIntake', payload) };
}

function rehashTemplate(value) {
  const { templateHash: _oldHash, ...payload } = value;
  return { ...payload, templateHash: hashRecord('AutonomousResearchRecurringGoldenTemplate', payload) };
}

test('machine intake and recurring template are exact-shape and hash-bound', () => {
  const value = intake();
  assert.equal(verifyAutonomousResearchMachineIntake(value), true);
  assert.equal(verifyAutonomousResearchMachineIntake({ ...value, attacker: true }), false);

  const invalidRounds = structuredClone(value);
  invalidRounds.revisionRounds = 0;
  assert.equal(verifyAutonomousResearchMachineIntake(rehashIntake(invalidRounds)), false);
  const nestedExtra = structuredClone(value);
  nestedExtra.datasetMounts[0].untrustedOverride = true;
  assert.equal(verifyAutonomousResearchMachineIntake(rehashIntake(nestedExtra)), false);
  assert.throws(() => buildAutonomousResearchMachineIntake({
    ...value,
    campaignId: 'attacker-campaign',
  }), /autonomous_research_machine_intake_campaign_identity_invalid/);

  const recurring = template({
    budgets: Object.fromEntries(Object.entries(
      AUTONOMOUS_RESEARCH_GOLDEN_RECURRING_HARD_BUDGETS,
    ).map(([key, limit]) => [key, limit * 100])),
  });
  assert.equal(verifyAutonomousResearchRecurringGoldenTemplate(recurring), true);
  assert.deepEqual(recurring.budgets, AUTONOMOUS_RESEARCH_GOLDEN_RECURRING_HARD_BUDGETS);
  const generated = materializeAutonomousResearchRecurringGoldenIntake({
    template: recurring,
    now: new Date('2026-07-16T08:00:00.000Z'),
    sourceAuthorityHash: H('configuration'),
  });
  assert.equal(generated.launchMode, 'golden-bootstrap');
  assert.equal(generated.campaignId, `autonomous-research:${generated.paperId}`);
  assert.equal(verifyAutonomousResearchMachineIntake(generated), true);

  const productionTemplate = { ...recurring, launchMode: 'production-run' };
  assert.equal(verifyAutonomousResearchRecurringGoldenTemplate(productionTemplate), false);
  const expandedTemplate = structuredClone(recurring);
  expandedTemplate.budgets.maxCostUsd += 1;
  assert.equal(verifyAutonomousResearchRecurringGoldenTemplate(
    rehashTemplate(expandedTemplate),
  ), false);
  assert.throws(() => template({ epochDurationMs: 24 * 60 * 60 * 1000 }),
    /autonomous_research_recurring_golden_epoch_invalid/);
});

test('source privilege and downstream construction boundaries fail closed at intake', (t) => {
  assert.throws(() => intake('forged-golden', { launchMode: 'golden-bootstrap' }),
    /autonomous_research_machine_intake_launch_source_invalid/);
  assert.throws(() => intake('long-paper', { paperId: 'p'.repeat(161) }),
    /autonomous_research_machine_intake_paper_id_invalid/);
  assert.throws(() => intake('placeholder', { objective: 'TODO research objective' }),
    /autonomous_research_machine_intake_objective_invalid/);
  assert.throws(() => template({ templateId: 't'.repeat(133) }),
    /autonomous_research_machine_intake_template_id_invalid/);

  const root = tempRoot(t, 'machine-intake-source-privilege');
  const configured = buildAutonomousResearchMachineIntakeConfiguration({
    recurringGoldenTemplates: [template()],
    machineAppendEnabled: true,
  });
  const golden = materializeAutonomousResearchRecurringGoldenIntake({
    template: configured.recurringGoldenTemplates[0],
    now: new Date('2026-07-16T00:00:00.000Z'),
    sourceAuthorityHash: configured.configurationHash,
  });
  const repository = createAutonomousResearchMachineIntakeRepository({
    runtimeRoot: root,
    authorizedSourceAuthorityHash: configured.configurationHash,
  });
  t.after(() => repository.close());
  assert.throws(() => repository.appendMachineIntake({
    intake: golden,
    sourceAuthorityHash: configured.configurationHash,
    now: new Date('2026-07-16T00:00:00.000Z'),
  }), /autonomous_research_machine_intake_privileged_launch_source_invalid/);
  assert.throws(() => appendMachineAutonomousResearchIntake({
    configuration: configured,
    repository,
    intake: golden,
    now: new Date('2026-07-16T00:00:00.000Z'),
  }), /autonomous_research_machine_intake_one_shot_production_required/);
});

test('configuration and durable machine admission enforce aggregate UTC-day budgets', (t) => {
  const hourlyA = template({ templateId: 'hourly-a', epochDurationMs: 60 * 60 * 1000 });
  const hourlyB = template({ templateId: 'hourly-b', epochDurationMs: 60 * 60 * 1000 });
  assert.equal(
    AUTONOMOUS_RESEARCH_MACHINE_INTAKE_CONFIGURATION_LIMITS
      .maximumRecurringGoldenCampaignsPerUtcDay,
    24,
  );
  assert.throws(() => buildAutonomousResearchMachineIntakeConfiguration({
    recurringGoldenTemplates: [hourlyA, hourlyB],
  }), /autonomous_research_machine_intake_configuration_invalid/);

  const root = tempRoot(t, 'machine-intake-daily-budget');
  const authority = H('machine-admission-authority');
  const repository = createAutonomousResearchMachineIntakeRepository({
    runtimeRoot: root,
    authorizedSourceAuthorityHash: authority,
  });
  t.after(() => repository.close());
  const costly = (suffix, cost, second) => intake(suffix, {
    admissionCreatedAt: `2026-07-16T00:00:${String(second).padStart(2, '0')}.000Z`,
    budgets: { ...BUDGETS, maxCostUsd: cost },
  });
  const first = costly('daily-a', 1200, 0);
  repository.appendMachineIntake({
    intake: first,
    sourceAuthorityHash: authority,
    now: new Date('2026-07-16T00:00:00.000Z'),
  });
  const replay = repository.appendMachineIntake({
    intake: first,
    sourceAuthorityHash: authority,
    now: new Date('2026-07-16T00:00:01.000Z'),
  });
  assert.equal(replay.idempotent, true);
  repository.appendMachineIntake({
    intake: costly('daily-b', 1200, 2),
    sourceAuthorityHash: authority,
    now: new Date('2026-07-16T00:00:02.000Z'),
  });
  assert.equal(
    AUTONOMOUS_RESEARCH_MACHINE_INTAKE_ADMISSION_LIMITS
      .maximumMachineReservedCostUsdPerUtcDay,
    2400,
  );
  assert.throws(() => repository.appendMachineIntake({
    intake: costly('daily-c', 1, 3),
    sourceAuthorityHash: authority,
    now: new Date('2026-07-16T00:00:03.000Z'),
  }), /autonomous_research_machine_intake_daily_admission_budget_exhausted/);
});

test('loader isolates bad static one-shots while admitting current Golden first', (t) => {
  const root = tempRoot(t, 'machine-intake-isolated-load');
  const configPath = path.join(root, 'config.json');
  const missingStatic = path.join(root, 'missing-static.json');
  const configured = buildAutonomousResearchMachineIntakeConfiguration({
    staticIntakeFiles: [{ path: missingStatic, intakeHash: H('missing-static') }],
    recurringGoldenTemplates: [template()],
  });
  writeJson(configPath, configured);
  assert.throws(() => readAutonomousResearchMachineIntakeConfiguration({ configPath }),
    /autonomous_research_machine_intake_static_file_invalid/);
  const deferred = readAutonomousResearchMachineIntakeConfiguration({
    configPath,
    validateStaticContent: false,
  }).configuration;
  const repository = createAutonomousResearchMachineIntakeRepository({
    runtimeRoot: root,
    authorizedSourceAuthorityHash: deferred.configurationHash,
  });
  t.after(() => repository.close());
  const loaded = loadConfiguredAutonomousResearchMachineIntakes({
    configuration: deferred,
    repository,
    now: new Date('2026-07-16T01:00:00.000Z'),
  });
  assert.deepEqual(
    [loaded.insertedCount, loaded.errorCount, loaded.results[0].record.sourceKind],
    [1, 1, 'recurring-golden'],
  );
});

test('static one-shot and machine intake append are immutable and idempotent', (t) => {
  const root = tempRoot(t, 'machine-intake-static');
  const runtimeRoot = path.join(root, 'runtime');
  const staticPath = path.join(root, 'production-intake.json');
  const configPath = path.join(root, 'intake-config.json');
  const production = intake('static-production');
  writeJson(staticPath, production);
  const configured = buildAutonomousResearchMachineIntakeConfiguration({
    staticIntakeFiles: [{ path: staticPath, intakeHash: production.intakeHash }],
    recurringGoldenTemplates: [],
    machineAppendEnabled: true,
  });
  writeJson(configPath, configured);
  const loaded = readAutonomousResearchMachineIntakeConfiguration({
    environment: { HEPTA_AUTONOMOUS_RESEARCH_INTAKE_CONFIG: configPath },
  }).configuration;
  assert.equal(verifyAutonomousResearchMachineIntakeConfiguration(loaded), true);
  const repository = createAutonomousResearchMachineIntakeRepository({
    runtimeRoot,
    authorizedSourceAuthorityHash: loaded.configurationHash,
  });
  t.after(() => repository.close());
  const first = loadConfiguredAutonomousResearchMachineIntakes({
    configuration: loaded,
    repository,
    now: new Date('2026-07-16T00:00:00.000Z'),
  });
  const nextDay = loadConfiguredAutonomousResearchMachineIntakes({
    configuration: loaded,
    repository,
    now: new Date('2026-07-17T00:00:00.000Z'),
  });
  assert.deepEqual([first.insertedCount, nextDay.idempotentCount], [1, 1]);
  writeJson(staticPath, intake('static-file-replaced'));
  assert.throws(() => readAutonomousResearchMachineIntakeConfiguration({ configPath }),
    /autonomous_research_machine_intake_static_content_drift/);
  const machine = appendMachineAutonomousResearchIntake({
    configuration: loaded,
    repository,
    intake: intake('machine', { admissionCreatedAt: '2026-07-17T00:00:00.000Z' }),
    now: new Date('2026-07-17T00:00:00.000Z'),
  });
  assert.equal(machine.inserted, true);
  assert.equal(repository.readStatus().pendingCount, 2);

  const conflicting = intake('conflict', {
    intakeId: production.intakeId,
    paperId: 'paper:conflict',
  });
  assert.throws(() => repository.appendMachineIntake({
    intake: conflicting,
    sourceAuthorityHash: loaded.configurationHash,
    now: new Date('2026-07-16T00:00:00.000Z'),
  }),
    /autonomous_research_machine_intake_identity_conflict/);
  const disabled = buildAutonomousResearchMachineIntakeConfiguration({
    machineAppendEnabled: false,
  });
  assert.throws(() => appendMachineAutonomousResearchIntake({
    configuration: disabled,
    repository,
    intake: intake('disabled'),
  }), /autonomous_research_machine_intake_machine_append_disabled/);
});

test('recurring golden intake is same-epoch idempotent and creates one unique next epoch', (t) => {
  const root = tempRoot(t, 'machine-intake-recurring');
  const runtimeRoot = path.join(root, 'runtime');
  const configured = buildAutonomousResearchMachineIntakeConfiguration({
    recurringGoldenTemplates: [template()],
  });
  let repository = createAutonomousResearchMachineIntakeRepository({
    runtimeRoot,
    authorizedSourceAuthorityHash: configured.configurationHash,
  });
  const beforeMidnight = loadConfiguredAutonomousResearchMachineIntakes({
    configuration: configured,
    repository,
    now: new Date('2026-07-16T23:59:59.999Z'),
  });
  assert.equal(beforeMidnight.insertedCount, 1);
  const firstId = beforeMidnight.results[0].record.intakeId;
  repository.close();

  repository = createAutonomousResearchMachineIntakeRepository({
    runtimeRoot,
    authorizedSourceAuthorityHash: configured.configurationHash,
  });
  t.after(() => repository.close());
  const restartedSameEpoch = loadConfiguredAutonomousResearchMachineIntakes({
    configuration: configured,
    repository,
    now: new Date('2026-07-16T23:59:59.999Z'),
  });
  assert.equal(restartedSameEpoch.idempotentCount, 1);
  assert.equal(restartedSameEpoch.results[0].record.intakeId, firstId);
  const nextEpoch = loadConfiguredAutonomousResearchMachineIntakes({
    configuration: configured,
    repository,
    now: new Date('2026-07-17T00:00:00.000Z'),
  });
  assert.equal(nextEpoch.insertedCount, 1);
  assert.notEqual(nextEpoch.results[0].record.intakeId, firstId);
  const records = repository.listPendingIntakes({ now: new Date('2026-07-17T00:00:00.000Z') });
  assert.equal(records.length, 1);
  assert.equal(repository.readIntake(firstId).disposition, 'superseded');
  assert.equal(repository.readStatus({ now: new Date('2026-07-17T00:00:00.000Z') })
    .supersededCount, 1);
  assert.equal(records.every((record) => record.intake.launchMode === 'golden-bootstrap'), true);
});

test('repository persists its configuration authority and rejects hash-valid config rotation', (t) => {
  const runtimeRoot = tempRoot(t, 'machine-intake-configuration-authority');
  const initial = buildAutonomousResearchMachineIntakeConfiguration({
    recurringGoldenTemplates: [template()],
  });
  const writer = createAutonomousResearchMachineIntakeRepository({
    runtimeRoot,
    authorizedSourceAuthorityHash: initial.configurationHash,
  });
  const loaded = loadConfiguredAutonomousResearchMachineIntakes({
    configuration: initial,
    repository: writer,
    now: new Date('2026-07-16T00:00:00.000Z'),
  });
  assert.equal(loaded.configurationHash, initial.configurationHash);
  assert.equal(writer.readStatus().configuredSourceAuthorityHash, initial.configurationHash);
  writer.close();

  const replacement = buildAutonomousResearchMachineIntakeConfiguration({
    recurringGoldenTemplates: [template({
      objective: 'Continuously qualify a substituted but hash-valid research loop.',
    })],
  });
  assert.notEqual(replacement.configurationHash, initial.configurationHash);
  assert.throws(() => createAutonomousResearchMachineIntakeRepository({
    runtimeRoot,
    authorizedSourceAuthorityHash: replacement.configurationHash,
  }), /autonomous_research_machine_intake_configuration_authority_mismatch/);

  const reader = createAutonomousResearchMachineIntakeRepository({
    runtimeRoot,
    create: false,
  });
  t.after(() => reader.close());
  assert.equal(reader.readStatus().configuredSourceAuthorityHash, initial.configurationHash);
});

test('lease fencing rejects an old owner and enqueue requires persisted campaign bindings', (t) => {
  const root = tempRoot(t, 'machine-intake-lease');
  const repository = createAutonomousResearchMachineIntakeRepository({
    runtimeRoot: root,
    authorizedSourceAuthorityHash: H('machine-source'),
  });
  t.after(() => repository.close());
  const value = intake('lease');
  repository.appendMachineIntake({
    intake: value,
    sourceAuthorityHash: H('machine-source'),
    now: new Date('2026-07-16T00:00:00.000Z'),
  });
  const first = repository.tryAcquireIntakeLease({
    intakeId: value.intakeId,
    ownerId: 'owner:first',
    leaseMs: 1000,
    now: new Date('2026-07-16T00:00:00.000Z'),
  });
  assert.equal(repository.tryAcquireIntakeLease({
    intakeId: value.intakeId,
    ownerId: 'owner:second',
    leaseMs: 1000,
    now: new Date('2026-07-16T00:00:00.500Z'),
  }), null);
  const second = repository.tryAcquireIntakeLease({
    intakeId: value.intakeId,
    ownerId: 'owner:second',
    leaseMs: 5000,
    now: new Date('2026-07-16T00:00:02.000Z'),
  });
  assert.equal(second.leaseGeneration, first.leaseGeneration + 1);
  const admissionHash = repository.readIntake(value.intakeId).admissionHash;
  assert.throws(() => repository.markIntakeEnqueued({
    intakeId: value.intakeId,
    ...first,
    autonomousResearchMachineIntakeAdmissionHash: admissionHash,
    campaignPlanHash: H('plan'),
    autonomousResearchLoopPreparationReportHash: H('preparation'),
    now: new Date('2026-07-16T00:00:02.100Z'),
  }), /autonomous_research_machine_intake_lease_fence_conflict/);
  assert.throws(() => repository.markIntakeEnqueued({
    intakeId: value.intakeId,
    ...second,
    autonomousResearchMachineIntakeAdmissionHash: admissionHash,
    campaignPlanHash: null,
    autonomousResearchLoopPreparationReportHash: H('preparation'),
  }), /autonomous_research_machine_intake_enqueue_binding_invalid/);
  const enqueued = repository.markIntakeEnqueued({
    intakeId: value.intakeId,
    ...second,
    autonomousResearchMachineIntakeAdmissionHash: admissionHash,
    campaignPlanHash: H('plan'),
    autonomousResearchLoopPreparationReportHash: H('preparation'),
    now: new Date('2026-07-16T00:00:02.100Z'),
  });
  assert.equal(enqueued.disposition, 'enqueued');
  assert.equal(enqueued.campaignPlanHash, H('plan'));
  assert.equal(enqueued.preparationHash, H('preparation'));
  assert.equal(repository.listEnqueuedIntakes()[0].admissionHash, admissionHash);
  assert.equal(repository.tryAcquireIntakeLease({
    intakeId: value.intakeId,
    ownerId: 'owner:third',
    leaseMs: 1000,
  }), null);
  const invalid = repository.markEnqueuedIntakeInvalid({
    intakeId: value.intakeId,
    autonomousResearchMachineIntakeAdmissionHash: admissionHash,
    reason: 'campaign_store_definition_missing',
    now: new Date('2026-07-16T00:00:03.000Z'),
  });
  assert.equal(invalid.disposition, 'invalid');
  assert.equal(repository.listEnqueuedIntakes().length, 0);
  assert.equal(repository.readStatus({ now: new Date('2026-07-16T00:00:03.000Z') })
    .invalidCount, 1);
  assert.equal(repository.markEnqueuedIntakeInvalid({
    intakeId: value.intakeId,
    autonomousResearchMachineIntakeAdmissionHash: admissionHash,
    reason: 'campaign_store_definition_missing',
    now: new Date('2026-07-16T00:00:04.000Z'),
  }).disposition, 'invalid');
});

test('intake lease assertion, durable backoff, and source-aware ordering prevent starvation', (t) => {
  const root = tempRoot(t, 'machine-intake-backoff-fairness');
  const authority = H('fairness-configuration');
  const repository = createAutonomousResearchMachineIntakeRepository({
    runtimeRoot: root,
    authorizedSourceAuthorityHash: authority,
  });
  t.after(() => repository.close());
  const machine = intake('fairness-machine', {
    admissionCreatedAt: '2026-07-16T00:00:00.000Z',
  });
  repository.appendMachineIntake({
    intake: machine,
    sourceAuthorityHash: authority,
    now: new Date('2026-07-16T00:00:00.000Z'),
  });
  const goldenTemplate = template({ templateId: 'fairness-golden' });
  for (const now of [
    new Date('2026-07-16T00:00:00.000Z'),
    new Date('2026-07-16T12:00:00.000Z'),
  ]) {
    const golden = materializeAutonomousResearchRecurringGoldenIntake({
      template: goldenTemplate,
      now,
      sourceAuthorityHash: authority,
    });
    repository.appendIntake({
      intake: golden,
      sourceKind: 'recurring-golden',
      sourceRef: `${goldenTemplate.templateId}@${golden.recurringGoldenProvenance.epochStart}`,
      sourceAuthorityHash: authority,
      sourceTemplate: goldenTemplate,
      now,
    });
  }
  const ordered = repository.listPendingIntakes({
    now: new Date('2026-07-16T13:00:00.000Z'),
  });
  assert.deepEqual(ordered.map((record) => record.sourceKind), [
    'recurring-golden', 'machine',
  ]);
  assert.equal(
    ordered[0].intake.recurringGoldenProvenance.epochStart,
    '2026-07-16T12:00:00.000Z',
  );

  const lease = repository.tryAcquireIntakeLease({
    intakeId: machine.intakeId,
    ownerId: 'owner:backoff',
    leaseMs: 5000,
    now: new Date('2026-07-16T13:00:00.000Z'),
  });
  assert.equal(repository.assertIntakeLease({
    intakeId: machine.intakeId,
    ...lease,
    now: new Date('2026-07-16T13:00:00.100Z'),
  }).leaseGeneration, lease.leaseGeneration);
  const deferred = repository.deferIntake({
    intakeId: machine.intakeId,
    ...lease,
    error: 'transient_provider_unavailable',
    retryAfterMs: 60_000,
    now: new Date('2026-07-16T13:00:00.200Z'),
  });
  assert.equal(deferred.failureCount, 1);
  assert.equal(deferred.nextAttemptAt, '2026-07-16T13:01:00.200Z');
  assert.equal(repository.listPendingIntakes({
    now: new Date('2026-07-16T13:00:59.999Z'),
  }).some((record) => record.intakeId === machine.intakeId), false);
  assert.equal(repository.listPendingIntakes({
    now: new Date('2026-07-16T13:01:00.200Z'),
  }).some((record) => record.intakeId === machine.intakeId), true);
  assert.throws(() => repository.assertIntakeLease({
    intakeId: machine.intakeId,
    ...lease,
    now: new Date('2026-07-16T13:00:00.300Z'),
  }), /autonomous_research_machine_intake_lease_fence_conflict/);
});

test('expired recurring epochs cannot be acquired and current replay retires an old expired lease', (t) => {
  const root = tempRoot(t, 'machine-intake-recurring-expiry');
  const recurring = template({ templateId: 'lease-expiry' });
  const configured = buildAutonomousResearchMachineIntakeConfiguration({
    recurringGoldenTemplates: [recurring],
  });
  const repository = createAutonomousResearchMachineIntakeRepository({
    runtimeRoot: root,
    authorizedSourceAuthorityHash: configured.configurationHash,
  });
  t.after(() => repository.close());
  const firstLoad = loadConfiguredAutonomousResearchMachineIntakes({
    configuration: configured,
    repository,
    now: new Date('2026-07-16T11:59:00.000Z'),
  });
  const old = firstLoad.results[0].record;
  const oldLease = repository.tryAcquireIntakeLease({
    intakeId: old.intakeId,
    ownerId: 'owner:old-epoch',
    leaseMs: 30 * 60 * 1000,
    now: new Date('2026-07-16T11:59:00.000Z'),
  });
  const currentLoad = loadConfiguredAutonomousResearchMachineIntakes({
    configuration: configured,
    repository,
    now: new Date('2026-07-16T12:00:00.000Z'),
  });
  assert.equal(currentLoad.insertedCount, 1);
  assert.equal(repository.readIntake(old.intakeId).disposition, 'pending');
  assert.equal(repository.renewIntakeLease({
    intakeId: old.intakeId,
    ...oldLease,
    leaseMs: 30 * 60 * 1000,
    now: new Date('2026-07-16T12:00:00.001Z'),
  }), null);
  assert.throws(() => repository.assertIntakeLease({
    intakeId: old.intakeId,
    ...oldLease,
    now: new Date('2026-07-16T12:00:00.001Z'),
  }), /autonomous_research_machine_intake_lease_fence_conflict/);

  const replay = loadConfiguredAutonomousResearchMachineIntakes({
    configuration: configured,
    repository,
    now: new Date('2026-07-16T12:30:00.001Z'),
  });
  assert.equal(replay.idempotentCount, 1);
  assert.equal(repository.readIntake(old.intakeId).disposition, 'superseded');

  const nextRoot = tempRoot(t, 'machine-intake-expired-acquire');
  const secondRepository = createAutonomousResearchMachineIntakeRepository({
    runtimeRoot: nextRoot,
    authorizedSourceAuthorityHash: configured.configurationHash,
  });
  t.after(() => secondRepository.close());
  const expired = loadConfiguredAutonomousResearchMachineIntakes({
    configuration: configured,
    repository: secondRepository,
    now: new Date('2026-07-16T11:00:00.000Z'),
  }).results[0].record;
  assert.equal(secondRepository.tryAcquireIntakeLease({
    intakeId: expired.intakeId,
    ownerId: 'owner:after-epoch',
    leaseMs: 1000,
    now: new Date('2026-07-16T12:00:00.000Z'),
  }), null);
  assert.equal(secondRepository.readIntake(expired.intakeId).disposition, 'superseded');
});

test('SQLite rolls back an intake mutation when the lease owner crashes', async (t) => {
  const root = tempRoot(t, 'machine-intake-crash');
  const repository = createAutonomousResearchMachineIntakeRepository({
    runtimeRoot: root,
    authorizedSourceAuthorityHash: H('machine-source'),
  });
  t.after(() => repository.close());
  const value = intake('crash');
  repository.appendMachineIntake({
    intake: value,
    sourceAuthorityHash: H('machine-source'),
    now: new Date('2026-07-16T00:00:00.000Z'),
  });
  const child = spawn(process.execPath, ['--input-type=module', '--eval', `
    import { DatabaseSync } from 'node:sqlite';
    const database = new DatabaseSync(process.argv[1]);
    database.exec('BEGIN IMMEDIATE;');
    database.prepare("UPDATE autonomous_research_machine_intake SET disposition='enqueued' WHERE intake_id=?").run(process.argv[2]);
    process.stdout.write('transaction-mutated\\n');
    setInterval(() => {}, 1000);
  `, repository.databasePath, value.intakeId], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  while (!output.includes('transaction-mutated')) {
    const [chunk] = await once(child.stdout, 'data');
    output += chunk;
  }
  child.kill('SIGKILL');
  await once(child, 'exit');
  assert.equal(repository.readIntake(value.intakeId).disposition, 'pending');
});

test('read-only status performs zero filesystem writes', (t) => {
  const root = tempRoot(t, 'machine-intake-readonly');
  const absentRuntime = path.join(root, 'absent-runtime');
  const absent = createAutonomousResearchMachineIntakeRepository({
    runtimeRoot: absentRuntime,
    create: false,
  });
  assert.deepEqual(absent.readStatus(), {
    configuredSourceAuthorityHash: null,
    configuredMachineProducerProfileHash: null,
    configuredAuthorityGeneration: null,
    pendingCount: 0,
    pendingProductionCount: 0,
    enqueuedCount: 0,
    invalidCount: 0,
    supersededCount: 0,
    pending: [],
  });
  absent.close();
  assert.equal(fs.existsSync(absentRuntime), false);

  const runtimeRoot = path.join(root, 'existing-runtime');
  const writer = createAutonomousResearchMachineIntakeRepository({
    runtimeRoot,
    authorizedSourceAuthorityHash: H('machine-source'),
  });
  writer.appendMachineIntake({
    intake: intake('read-only'),
    sourceAuthorityHash: H('machine-source'),
    now: new Date('2026-07-16T00:00:00.000Z'),
  });
  const databasePath = writer.databasePath;
  writer.close();
  const before = fs.statSync(databasePath);
  const beforeEntries = fs.readdirSync(path.dirname(databasePath)).sort();
  const reader = createAutonomousResearchMachineIntakeRepository({
    runtimeRoot,
    create: false,
  });
  assert.equal(reader.readStatus().pendingCount, 1);
  assert.equal(reader.readStatus().configuredSourceAuthorityHash, H('machine-source'));
  assert.throws(() => reader.appendMachineIntake({ intake: intake('forbidden') }),
    /autonomous_research_machine_intake_repository_read_only/);
  reader.close();
  const after = fs.statSync(databasePath);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.deepEqual(fs.readdirSync(path.dirname(databasePath)).sort(), beforeEntries);
});
