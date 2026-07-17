import assert from 'node:assert/strict';
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { createAutonomousResearchTopicProducer } from '../../paper-application/automation/autonomous-research-topic-producer.mjs';
import { createAutonomousResearchTopicProducerLiveAuthority } from '../../paper-application/automation/autonomous-research-topic-producer-live-authority.mjs';
import {
  appendMachineAutonomousResearchIntake,
  buildAutonomousResearchMachineIntakeConfiguration,
} from '../../paper-adapters/automation/autonomous-research-machine-intake-loader.mjs';
import { inspectAutonomousResearchTopicProducerImplementationIdentity } from '../../paper-adapters/automation/autonomous-research-topic-producer-profile-loader.mjs';
import { createAutonomousResearchTopicProducerRepository } from '../../paper-adapters/automation/autonomous-research-topic-producer-repository.mjs';
import {
  inspectAutonomousResearchTopicProducerStatus,
} from '../../paper-adapters/automation/autonomous-research-topic-producer-status.mjs';
import {
  runAutonomousResearchProviderCanaryPair,
} from '../../paper-composition/automation/autonomous-research-provider-canary.mjs';
import {
  resolveAutonomousResearchProviderConfiguration,
} from '../../paper-composition/automation/autonomous-research-provider-configuration.mjs';
import {
  buildAutonomousResearchTopicProducerCapabilityReceipt,
  buildAutonomousResearchTopicProducerProfile,
} from '../../paper-domain/automation/autonomous-research-topic-producer-contract.mjs';
import {
  providerCanaryAction,
  verifyAutonomousResearchProviderCanarySideEffectInspection,
} from '../../paper-domain/automation/autonomous-research-provider-canary-side-effect-inspection.mjs';
import {
  buildAutonomousResearchRecurringGoldenTemplate,
} from '../../paper-domain/automation/autonomous-research-machine-intake-contract.mjs';
import {
  installMachineIntakeExternalGenesisAuthority,
} from './machine-intake-external-authority-test-support.mjs';

const AUTHORITY_STATE_MODULE = new URL(
  '../../paper-adapters/automation/autonomous-research-machine-intake-authority.mjs',
  import.meta.url,
);
const AUTHORIZATION_MODULE = new URL(
  '../../paper-adapters/automation/autonomous-research-machine-intake-authority-rotation-authorization.mjs',
  import.meta.url,
);
const AUTHORIZATION_DOUBLE = new URL(
  './test-doubles/autonomous-research-machine-intake-authority-rotation-authorization.mjs',
  import.meta.url,
);
registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    if (context.parentURL?.split('?')[0] === AUTHORITY_STATE_MODULE.href
      && resolved.url === AUTHORIZATION_MODULE.href) {
      return { shortCircuit: true, url: AUTHORIZATION_DOUBLE.href };
    }
    return resolved;
  },
});
const { createAutonomousResearchMachineIntakeRepository } = await import(
  '../../paper-adapters/automation/autonomous-research-machine-intake-repository.mjs'
);
const { composeAutonomousResearchMachineIntakePlane } = await import(
  '../../paper-composition/automation/autonomous-research-machine-intake-composition.mjs'
);

const H = (label) => hashRecord('AutonomousResearchTopicProducerTestHash', { label });
const PROVIDER_HASH = H('provider-configuration');
const BUDGETS = Object.freeze({
  maxWallTimeMs: 60 * 60 * 1000,
  maxAgentCalls: 12,
  maxCpuJobs: 16,
  maxGpuJobs: 0,
  maxTokenCount: 50_000,
  maxCostUsd: 10,
  maxMemoryMiB: 4096,
});

function innerCanary({ role, now }) {
  const payload = Object.freeze({
    version: 1,
    kind: 'CodexModelAvailabilityCanaryReceipt',
    status: 'codex_model_live_canary_verified',
    provider: 'openai',
    model: `model-${role}`,
    codexVersion: 'codex-cli 1.0.0',
    codexBinaryIdentityHash: H(`binary:${role}`),
    credentialRootIdentityHash: H(`root:${role}`),
    credentialConfigIdentityHash: H(`config:${role}`),
    authenticationStatus: 'codex_authentication_verified',
    selectedModelExecutionCanaryVerified: true,
    challengeHash: H(`challenge:${role}:${now.toISOString()}`),
    responseHash: H(`response:${role}:${now.toISOString()}`),
    observedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 15 * 60 * 1000).toISOString(),
    externalActionPerformed: true,
    externalActionScope: 'single_read_only_ephemeral_model_canary',
  });
  return Object.freeze({
    ...payload,
    codexModelAvailabilityCanaryReceiptHash: hashRecord(
      'CodexModelAvailabilityCanaryReceipt', payload,
    ),
  });
}

function canaryPair(now) {
  const author = innerCanary({ role: 'author', now });
  const reviewer = innerCanary({ role: 'reviewer', now });
  const payload = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchProviderCanaryPairReceipt',
    status: 'autonomous_research_provider_canary_pair_verified',
    verified: true,
    autonomousResearchProviderConfigurationHash: PROVIDER_HASH,
    researchAuthorCapabilityReceiptHash: H('author-capability'),
    formalReviewerCapabilityReceiptHash: H('reviewer-capability'),
    researchAuthorProviderCanaryReceiptHash: author.codexModelAvailabilityCanaryReceiptHash,
    formalReviewerProviderCanaryReceiptHash: reviewer.codexModelAvailabilityCanaryReceiptHash,
    researchAuthorProviderCanaryReceipt: author,
    formalReviewerProviderCanaryReceipt: reviewer,
    observedAt: now.toISOString(),
    freshnessIntervalMs: 15 * 60 * 1000,
    externalActionPerformed: true,
    externalActionScope: 'two_read_only_ephemeral_model_canaries',
  });
  return Object.freeze({
    ...payload,
    providerCanaryPairReceiptHash: hashRecord(
      'AutonomousResearchProviderCanaryPairReceipt', payload,
    ),
  });
}

function checkpointCanaryPair(input, receipt) {
  input.beforeCanaryAction?.({
    role: 'research_author',
    failurePhase: 'research_author_canary',
  });
  input.afterCanaryAction?.({
    action: providerCanaryAction({
      role: 'research_author',
      receipt: receipt.researchAuthorProviderCanaryReceipt,
    }),
    failurePhase: 'research_author_canary',
  });
  input.betweenCanaryChecks?.();
  input.beforeCanaryAction?.({
    role: 'formal_reviewer',
    failurePhase: 'formal_reviewer_canary',
  });
  input.afterCanaryAction?.({
    action: providerCanaryAction({
      role: 'formal_reviewer',
      receipt: receipt.formalReviewerProviderCanaryReceipt,
    }),
    failurePhase: 'formal_reviewer_canary',
  });
}

function canaryReservationFor(plannedGeneration) {
  return Object.freeze({
    generationSequence: plannedGeneration.generationSequence,
    plannedGenerationHash: plannedGeneration.plannedGenerationHash,
    budgetReservationId: plannedGeneration.budgetReservationId,
    budgetEpochStart: plannedGeneration.budgetEpochStart,
    providerCanaryReservedAttemptCount: 1,
    providerCanaryReservedCostUsd: 1,
  });
}

function producerProfile(providerConfigurationHash = PROVIDER_HASH) {
  const implementationSha256 = inspectAutonomousResearchTopicProducerImplementationIdentity()
    .implementationSha256;
  return buildAutonomousResearchTopicProducerProfile({
    producerId: 'production-replication-producer',
    implementationSha256,
    providerConfigurationHash,
    minimumGenerationIntervalMs: 60 * 60 * 1000,
    maximumTopicsPerUtcDay: 12,
    maximumProviderCanaryAttemptsPerUtcDay: 24,
    maximumProviderCanaryCostUsdPerUtcDay: 24,
    registeredResearchProfiles: [{
      profileId: 'ml-registered-replication',
      objective: 'Evaluate the registered bounded algorithm comparison under the fixed benchmark protocol.',
      protocolFamily: 'ml_algorithm_benchmark',
      datasetMounts: [{
        name: 'registered-benchmark',
        source: '/datasets/registered-benchmark',
        readOnly: true,
        manifestHash: H('dataset'),
        licenseId: 'CC0-1.0',
        benchmarkFamily: 'ml_algorithm_benchmark',
      }],
      budgets: BUDGETS,
      revisionRounds: 2,
      refereeCount: 2,
    }],
  });
}

function residentContext(generation = 1) {
  const lease = Object.freeze({
    ownerId: 'resident:test',
    leaseToken: `resident-lease:${generation}`,
    leaseGeneration: generation,
    expiresAt: '2099-01-01T00:00:00.000Z',
  });
  return Object.freeze({ lease, assertCurrent() { return lease; } });
}

function fullAutonomyCurrent() {
  return Object.freeze({ ready: true, operationMode: 'full' });
}

function providerConfigurationFixture() {
  return resolveAutonomousResearchProviderConfiguration({
    options: {
      'agent-provider': 'codex',
      'codex-binary': 'codex',
      'codex-home': '/tmp/hepta-topic-author-home',
      model: 'author-model',
      'formal-review-provider': 'codex',
      'formal-review-codex-binary': 'codex',
      'formal-review-codex-home': '/tmp/hepta-topic-reviewer-home',
      'formal-review-model': 'reviewer-model',
    },
  });
}

function instrumentedCanaryRunner(providerConfiguration, {
  probeRoles,
  reviewerError = null,
} = {}) {
  return (input, { clock }) => runAutonomousResearchProviderCanaryPair({
    ...input,
    providerConfiguration,
    clock,
    preflightAuthor(configuration) {
      return Object.freeze({
        codexHome: configuration.codexHome,
        capabilityReceipt: Object.freeze({
          codexResearchAuthorCapabilityReceiptHash: H('author-capability'),
        }),
      });
    },
    preflightReviewer() {
      return Object.freeze({
        capabilityReceipt: Object.freeze({
          codexFormalReviewerCapabilityReceiptHash: H('reviewer-capability'),
        }),
      });
    },
    probeModelAvailability(configuration) {
      const role = configuration.errorPrefix.includes('author') ? 'author' : 'reviewer';
      probeRoles?.push(role);
      if (role === 'reviewer' && reviewerError) throw reviewerError;
      return innerCanary({ role, now: clock.now() });
    },
  });
}

function setup(t, {
  initialNow = new Date('2026-07-17T00:00:00.000Z'),
  canaryFailure = null,
  providerConfigurationHash = PROVIDER_HASH,
  providerCanaryRunner = null,
  authorityRemeasure = null,
  failGenerationError = null,
} = {}) {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-topic-producer-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  let observedAt = new Date(initialNow);
  let canaryCalls = 0;
  const clock = { now: () => new Date(observedAt) };
  const profile = producerProfile(providerConfigurationHash);
  const configuration = buildAutonomousResearchMachineIntakeConfiguration({
    machineAppendEnabled: true,
    machineProducerProfileHash: profile.producerProfileHash,
  });
  installMachineIntakeExternalGenesisAuthority({
    configurationHash: configuration.configurationHash,
    producerProfileHash: profile.producerProfileHash,
  });
  const liveMutationAuthority = createAutonomousResearchTopicProducerLiveAuthority({
    clock,
    hashRecord,
    providerCanaryPairMaximumCostUsd: 1,
    remeasureAuthorities(expected) {
      return authorityRemeasure?.(expected)
        || { ready: true, authorityMeasurementHash: H('current-authority') };
    },
    async runProviderCanary(input) {
      canaryCalls += 1;
      if (canaryFailure) throw new Error(canaryFailure);
      if (providerCanaryRunner) return providerCanaryRunner(input, { clock });
      const receipt = canaryPair(clock.now());
      checkpointCanaryPair(input, receipt);
      return receipt;
    },
  });
  const producerRepository = createAutonomousResearchTopicProducerRepository({
    runtimeRoot,
    machineIntakeConfigurationHash: configuration.configurationHash,
    producerProfile: profile,
    providerCanaryPairMaximumCostUsd: 1,
    liveMutationAuthority,
  });
  const machineIntakeRepository = createAutonomousResearchMachineIntakeRepository({
    runtimeRoot,
    authorizedSourceAuthorityHash: configuration.configurationHash,
    authorizedMachineProducerProfileHash: profile.producerProfileHash,
    machineProducerAppendAuthority: producerRepository,
  });
  const producerRepositoryForProducer = failGenerationError
    ? Object.freeze({
      ...producerRepository,
      failGeneration() { throw failGenerationError; },
    })
    : producerRepository;
  const producer = createAutonomousResearchTopicProducer({
    configuration,
    producerProfile: profile,
    producerRepository: producerRepositoryForProducer,
    machineIntakeRepository,
    liveMutationAuthority,
    clock,
    ownerId: 'producer:test',
  });
  t.after(() => {
    try { machineIntakeRepository.close(); } catch { /* already closed */ }
    try { producerRepository.close(); } catch { /* already closed */ }
  });
  return {
    runtimeRoot,
    clock,
    profile,
    configuration,
    liveMutationAuthority,
    producerRepository,
    machineIntakeRepository,
    producer,
    resident: residentContext(),
    assertAutonomyCurrent: fullAutonomyCurrent,
    canaryCalls: () => canaryCalls,
    setNow(value) { observedAt = new Date(value); },
  };
}

function dropTopicProducerCanaryJournalColumns(databasePath) {
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`BEGIN IMMEDIATE;
    ALTER TABLE autonomous_research_topic_producer_generation
      DROP COLUMN provider_canary_attempt_journal_json;
    ALTER TABLE autonomous_research_topic_producer_generation
      DROP COLUMN provider_canary_attempt_started;
    ALTER TABLE autonomous_research_topic_producer_generation
      DROP COLUMN provider_canary_side_effect_inspection_json;
    COMMIT;`);
  legacy.close();
}

function reopenProducerRepository(fixture, create = true) {
  return createAutonomousResearchTopicProducerRepository({
    runtimeRoot: fixture.runtimeRoot,
    machineIntakeConfigurationHash: fixture.configuration.configurationHash,
    producerProfile: fixture.profile,
    providerCanaryPairMaximumCostUsd: 1,
    liveMutationAuthority: fixture.liveMutationAuthority,
    create,
  });
}

test('bootstrap-only machine intake plane admits recurring golden without producer canaries', async (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-bootstrap-only-plane-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const profile = producerProfile();
  const recurringGolden = buildAutonomousResearchRecurringGoldenTemplate({
    templateId: 'bootstrap-only-golden',
    epochDurationMs: 12 * 60 * 60 * 1000,
    objective: 'Renew the global autonomous research qualification without production intake.',
    protocolFamily: 'ml_algorithm_benchmark',
    datasetMounts: profile.registeredResearchProfiles[0].datasetMounts,
    providerConfigurationHash: PROVIDER_HASH,
    revisionRounds: 1,
    refereeCount: 2,
  });
  const configuration = buildAutonomousResearchMachineIntakeConfiguration({
    recurringGoldenTemplates: [recurringGolden],
    machineAppendEnabled: true,
    machineProducerProfileHash: profile.producerProfileHash,
  });
  installMachineIntakeExternalGenesisAuthority({
    configurationHash: configuration.configurationHash,
    producerProfileHash: profile.producerProfileHash,
  });
  const configPath = path.join(runtimeRoot, 'machine-intake.json');
  fs.writeFileSync(configPath, `${JSON.stringify(configuration)}\n`, { mode: 0o600 });
  let providerCanaryCalls = 0;
  const now = new Date('2026-07-17T00:00:00.000Z');
  const plane = composeAutonomousResearchMachineIntakePlane({
    runtimeRoot,
    configuration,
    configPath,
    providerConfiguration: {
      autonomousResearchProviderConfigurationHash: PROVIDER_HASH,
    },
    environment: {},
    producerInspection: {
      ready: true,
      producerProfile: profile,
      implementationIdentity: { ready: true, implementationSha256: profile.implementationSha256 },
      datasetSnapshot: { datasetSnapshotHash: H('bootstrap-dataset-snapshot') },
      profilePath: path.join(runtimeRoot, 'unused-profile.json'),
    },
    providerCanaryPairMaximumCostUsd: 1,
    async providerCanaryRunner(input) {
      providerCanaryCalls += 1;
      const receipt = canaryPair(now);
      checkpointCanaryPair(input, receipt);
      return receipt;
    },
    clock: { now: () => new Date(now) },
    ownerId: 'producer:bootstrap-only',
  });
  t.after(() => plane.close());

  const loaded = await plane.loadConfiguredIntakes({
    now,
    residentLeaseContext: residentContext(),
    operationMode: 'bootstrap-only',
    assertAutonomyCurrent() {
      return Object.freeze({ ready: true, operationMode: 'bootstrap-only' });
    },
  });
  assert.equal(providerCanaryCalls, 0);
  assert.equal(loaded.topicProducer, null);
  assert.equal(loaded.results.length, 1);
  assert.equal(loaded.results[0].record.sourceKind, 'recurring-golden');
  assert.equal(plane.producerRepository.readStatus({ now }).providerCanaryAttemptCount, 0);
  assert.equal(plane.machineIntakeRepository.listPendingIntakes({ now, limit: 10 })
    .every((record) => record.sourceKind === 'recurring-golden'), true);
});

test('second autonomy check downgrade prevents topic reservation, canary, and generation', async (t) => {
  const fixture = setup(t);
  let autonomyChecks = 0;
  const result = await fixture.producer.reconcile({
    residentLeaseContext: fixture.resident,
    assertAutonomyCurrent() {
      autonomyChecks += 1;
      return Object.freeze({
        ready: true,
        operationMode: autonomyChecks === 1 ? 'full' : 'bootstrap-only',
      });
    },
  });
  const status = fixture.producerRepository.readStatus({ now: fixture.clock.now() });
  assert.equal(autonomyChecks, 2);
  assert.equal(result.ready, false);
  assert.match(result.error, /autonomy_fence_invalid/);
  assert.equal(fixture.canaryCalls(), 0);
  assert.equal(status.providerCanaryAttemptCount, 0);
  assert.equal(status.providerCanaryReservedCostUsd, 0);
  assert.equal(status.producedTopicCount, 0);
  assert.equal(fixture.machineIntakeRepository.readStatus().pendingProductionCount, 0);
});

test('machine intake plane preserves the supervisor autonomy callback into producer actions', async (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-plane-autonomy-fence-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const profile = producerProfile();
  const configuration = buildAutonomousResearchMachineIntakeConfiguration({
    machineAppendEnabled: true,
    machineProducerProfileHash: profile.producerProfileHash,
  });
  installMachineIntakeExternalGenesisAuthority({
    configurationHash: configuration.configurationHash,
    producerProfileHash: profile.producerProfileHash,
  });
  const configPath = path.join(runtimeRoot, 'machine-intake.json');
  fs.writeFileSync(configPath, `${JSON.stringify(configuration)}\n`, { mode: 0o600 });
  const now = new Date('2026-07-17T00:00:00.000Z');
  let autonomyChecks = 0;
  let providerCanaryCalls = 0;
  const plane = composeAutonomousResearchMachineIntakePlane({
    runtimeRoot,
    configuration,
    configPath,
    providerConfiguration: {
      autonomousResearchProviderConfigurationHash: PROVIDER_HASH,
    },
    environment: {},
    producerInspection: {
      ready: true,
      producerProfile: profile,
      implementationIdentity: { ready: true, implementationSha256: profile.implementationSha256 },
      datasetSnapshot: { datasetSnapshotHash: H('fenced-dataset-snapshot') },
      profilePath: path.join(runtimeRoot, 'unused-profile.json'),
    },
    providerCanaryPairMaximumCostUsd: 1,
    async providerCanaryRunner(input) {
      providerCanaryCalls += 1;
      const receipt = canaryPair(now);
      checkpointCanaryPair(input, receipt);
      return receipt;
    },
    clock: { now: () => new Date(now) },
    ownerId: 'producer:plane-autonomy-fence',
  });
  t.after(() => plane.close());
  const loaded = await plane.loadConfiguredIntakes({
    now,
    residentLeaseContext: residentContext(),
    operationMode: 'full',
    assertAutonomyCurrent() {
      autonomyChecks += 1;
      return Object.freeze({
        ready: true,
        operationMode: autonomyChecks === 1 ? 'full' : 'bootstrap-only',
      });
    },
  });
  const status = plane.producerRepository.readStatus({ now });
  assert.equal(autonomyChecks, 2);
  assert.equal(loaded.topicProducer.ready, false);
  assert.equal(providerCanaryCalls, 0);
  assert.equal(status.providerCanaryAttemptCount, 0);
  assert.equal(status.producedTopicCount, 0);
  assert.equal(plane.machineIntakeRepository.readStatus().pendingProductionCount, 0);
});

test('production producer emits one bounded v2 admission and suppresses paid work while pending', async (t) => {
  const fixture = setup(t);
  const first = await fixture.producer.reconcile({
    residentLeaseContext: fixture.resident,
    assertAutonomyCurrent: fixture.assertAutonomyCurrent,
  });
  assert.equal(first.status, 'autonomous_research_topic_producer_intake_generated');
  assert.equal(fixture.canaryCalls(), 1);
  const record = fixture.machineIntakeRepository.readIntake(first.intakeId);
  assert.equal(record.sourceKind, 'machine');
  assert.equal(record.intake.launchMode, 'production-run');
  assert.equal(record.intake.recurringGoldenProvenance, null);
  assert.equal(record.admission.version, 2);
  assert.equal(record.admission.topicProducerCapabilityReceipt.safety
    .scientificNoveltyVerified, false);
  assert.equal(record.admission.topicProducerCapabilityReceipt.producerProfileHash,
    fixture.profile.producerProfileHash);
  assert.match(record.intake.objective, /does not assert scientific novelty/);

  fixture.setNow('2026-07-17T00:01:00.000Z');
  const suppressed = await fixture.producer.reconcile({
    residentLeaseContext: fixture.resident,
    assertAutonomyCurrent: fixture.assertAutonomyCurrent,
  });
  assert.equal(suppressed.status,
    'autonomous_research_topic_producer_suppressed_by_pending_production');
  assert.equal(suppressed.externalActionPerformed, false);
  assert.equal(fixture.canaryCalls(), 1);
  assert.equal(fixture.producerRepository.readStatus({ now: fixture.clock.now() })
    .providerCanaryAttemptCount, 1);
});

test('self-hashed forged capability and replay cannot cross the opaque append authority', async (t) => {
  const fixture = setup(t);
  const lease = fixture.producerRepository.tryAcquireLease({
    ownerId: 'producer:attacker', leaseMs: 15 * 60 * 1000, now: fixture.clock.now(),
  });
  const plan = fixture.producerRepository.prepareGeneration({ lease, now: fixture.clock.now() });
  const forged = buildAutonomousResearchTopicProducerCapabilityReceipt({
    producerProfile: fixture.profile,
    machineIntakeConfigurationHash: fixture.configuration.configurationHash,
    generationSequence: plan.generationSequence,
    intake: plan.plannedGeneration.intake,
    plannedGeneration: plan.plannedGeneration,
    providerCanaryPairReceipt: canaryPair(fixture.clock.now()),
    producerLeaseGeneration: lease.leaseGeneration,
    producerLeaseTokenHash: hashRecord(
      'AutonomousResearchTopicProducerLeaseToken', lease.leaseToken,
    ),
    residentLeaseGeneration: fixture.resident.lease.leaseGeneration,
    residentLeaseTokenHash: hashRecord(
      'AutonomousResearchResidentLeaseToken', fixture.resident.lease.leaseToken,
    ),
    capabilityNonce: 'producer-nonce:00000000000000000000000000000000',
    now: fixture.clock.now(),
  });
  assert.throws(() => fixture.machineIntakeRepository.appendMachineIntake({
    intake: plan.plannedGeneration.intake,
    sourceAuthorityHash: fixture.configuration.configurationHash,
    topicProducerCapabilityReceipt: forged,
    topicProducerAppendAuthorization: Object.freeze({ forged: true }),
    now: fixture.clock.now(),
  }), /append_authorization_invalid_or_replayed/);
  assert.equal(fixture.machineIntakeRepository.readStatus().pendingProductionCount, 0);
  fixture.producerRepository.releaseLease({ lease });

  const produced = await fixture.producer.reconcile({
    residentLeaseContext: fixture.resident,
    assertAutonomyCurrent: fixture.assertAutonomyCurrent,
  });
  assert.equal(produced.generated, true);
  const record = fixture.machineIntakeRepository.readIntake(produced.intakeId);
  assert.throws(() => fixture.machineIntakeRepository.appendMachineIntake({
    intake: record.intake,
    sourceAuthorityHash: fixture.configuration.configurationHash,
    topicProducerCapabilityReceipt: record.admission.topicProducerCapabilityReceipt,
    topicProducerAppendAuthorization: Object.freeze({ replay: true }),
    now: fixture.clock.now(),
  }), /append_authorization_invalid_or_replayed/);
});

test('v2 direct API bypass and legacy preseed upgrade both fail closed', (t) => {
  const fixture = setup(t);
  const bypassLease = fixture.producerRepository.tryAcquireLease({
    ownerId: 'producer:direct-bypass', leaseMs: 15 * 60 * 1000, now: fixture.clock.now(),
  });
  const generated = fixture.producerRepository.prepareGeneration({
    lease: bypassLease,
    now: fixture.clock.now(),
  });
  assert.throws(() => appendMachineAutonomousResearchIntake({
    configuration: fixture.configuration,
    repository: fixture.machineIntakeRepository,
    intake: generated.plannedGeneration.intake,
    now: fixture.clock.now(),
  }), /producer_capability_required/);

  const preseedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-topic-preseed-'));
  t.after(() => fs.rmSync(preseedRoot, { recursive: true, force: true }));
  const legacy = createAutonomousResearchMachineIntakeRepository({
    runtimeRoot: preseedRoot,
    authorizedSourceAuthorityHash: fixture.configuration.configurationHash,
  });
  legacy.appendMachineIntake({
    intake: generated.plannedGeneration.intake,
    sourceAuthorityHash: fixture.configuration.configurationHash,
    now: fixture.clock.now(),
  });
  legacy.close();
  assert.throws(() => createAutonomousResearchMachineIntakeRepository({
    runtimeRoot: preseedRoot,
    authorizedSourceAuthorityHash: fixture.configuration.configurationHash,
    authorizedMachineProducerProfileHash: fixture.profile.producerProfileHash,
    machineProducerAppendAuthority: fixture.producerRepository,
  }), /producer_authority_mismatch/);
  fixture.producerRepository.releaseLease({ lease: bypassLease });
});

test('append-before-complete crash is recovered without a second canary or topic charge', async (t) => {
  const fixture = setup(t);
  const lease = fixture.producerRepository.tryAcquireLease({
    ownerId: 'producer:crash', leaseMs: 1000, now: fixture.clock.now(),
  });
  const plan = fixture.producerRepository.prepareGeneration({ lease, now: fixture.clock.now() });
  const live = await fixture.liveMutationAuthority.authorize({
    producerLease: lease,
    assertProducerLease: fixture.producerRepository.assertLease,
    residentLeaseContext: fixture.resident,
    assertAutonomyCurrent: fixture.assertAutonomyCurrent,
    plannedGeneration: plan.plannedGeneration,
    expected: {
      machineIntakeConfigurationHash: fixture.configuration.configurationHash,
      producerProfileHash: fixture.profile.producerProfileHash,
      providerConfigurationHash: fixture.profile.providerConfigurationHash,
      implementationSha256: fixture.profile.implementationSha256,
    },
    beginProviderCanaryAction: fixture.producerRepository.beginProviderCanaryAction,
    finishProviderCanaryAction: fixture.producerRepository.finishProviderCanaryAction,
  });
  const capability = buildAutonomousResearchTopicProducerCapabilityReceipt({
    producerProfile: fixture.profile,
    machineIntakeConfigurationHash: fixture.configuration.configurationHash,
    generationSequence: plan.generationSequence,
    intake: plan.plannedGeneration.intake,
    plannedGeneration: plan.plannedGeneration,
    providerCanaryPairReceipt: live.providerCanaryPairReceipt,
    producerLeaseGeneration: lease.leaseGeneration,
    producerLeaseTokenHash: hashRecord(
      'AutonomousResearchTopicProducerLeaseToken', lease.leaseToken,
    ),
    residentLeaseGeneration: fixture.resident.lease.leaseGeneration,
    residentLeaseTokenHash: hashRecord(
      'AutonomousResearchResidentLeaseToken', fixture.resident.lease.leaseToken,
    ),
    capabilityNonce: live.capabilityNonce,
    now: fixture.clock.now(),
  });
  const opaque = fixture.producerRepository.issueAppendAuthorization({
    lease,
    plannedGeneration: plan.plannedGeneration,
    capability,
    intake: plan.plannedGeneration.intake,
    liveMutationAuthorization: live.authorization,
    now: fixture.clock.now(),
  });
  fixture.machineIntakeRepository.appendMachineIntake({
    intake: plan.plannedGeneration.intake,
    sourceAuthorityHash: fixture.configuration.configurationHash,
    topicProducerCapabilityReceipt: capability,
    topicProducerAppendAuthorization: opaque,
    now: fixture.clock.now(),
  });
  fixture.producerRepository.releaseLease({ lease });
  assert.equal(fixture.canaryCalls(), 1);
  fixture.setNow('2026-07-17T00:00:02.000Z');
  const recovered = await fixture.producer.reconcile({
    residentLeaseContext: fixture.resident,
    assertAutonomyCurrent: fixture.assertAutonomyCurrent,
  });
  assert.equal(recovered.status,
    'autonomous_research_topic_producer_committed_append_recovered');
  assert.equal(recovered.recovered, true);
  assert.equal(fixture.canaryCalls(), 1);
  assert.equal(fixture.producerRepository.readStatus({ now: fixture.clock.now() })
    .producedTopicCount, 1);
});

test('provider failure, cross-midnight plan, and clock rollback are fail-closed and bounded', async (t) => {
  const unavailable = setup(t, { canaryFailure: 'provider_unavailable' });
  const failed = await unavailable.producer.reconcile({
    residentLeaseContext: unavailable.resident,
    assertAutonomyCurrent: unavailable.assertAutonomyCurrent,
  });
  assert.equal(failed.ready, false);
  assert.equal(failed.error, 'provider_canary_runner_unattributed_failed');
  assert.equal(failed.externalActionPerformed, false);
  assert.equal(failed.externalActionMayHaveOccurred, true);
  assert.equal(unavailable.machineIntakeRepository.readStatus().pendingProductionCount, 0);
  const retrySuppressed = await unavailable.producer.reconcile({
    residentLeaseContext: unavailable.resident,
    assertAutonomyCurrent: unavailable.assertAutonomyCurrent,
  });
  assert.equal(retrySuppressed.externalActionPerformed, false);
  assert.equal(unavailable.canaryCalls(), 1);

  const midnight = setup(t, { initialNow: new Date('2026-07-17T23:59:59.000Z') });
  const oldLease = midnight.producerRepository.tryAcquireLease({
    ownerId: 'producer:midnight-old', leaseMs: 1000, now: midnight.clock.now(),
  });
  const oldPlan = midnight.producerRepository.prepareGeneration({
    lease: oldLease, now: midnight.clock.now(),
  });
  assert.equal(oldPlan.plannedGeneration.budgetEpochStart, '2026-07-17T00:00:00.000Z');
  midnight.producerRepository.releaseLease({ lease: oldLease });
  midnight.setNow('2026-07-18T00:00:01.000Z');
  const current = await midnight.producer.reconcile({
    residentLeaseContext: midnight.resident,
    assertAutonomyCurrent: midnight.assertAutonomyCurrent,
  });
  assert.equal(current.generated, true);
  assert.equal(midnight.canaryCalls(), 1);
  assert.equal(midnight.producerRepository.readGeneration(1).status, 'failed');
  assert.equal(midnight.producerRepository.readGeneration(2).plannedGeneration
    .budgetEpochStart, '2026-07-18T00:00:00.000Z');
  assert.equal(midnight.producerRepository.readStatus({ now: midnight.clock.now() })
    .providerCanaryAttemptCount, 1);

  const rollback = setup(t, { initialNow: new Date('2026-07-17T23:50:00.000Z') });
  const rollbackLease = rollback.producerRepository.tryAcquireLease({
    ownerId: 'producer:rollback', leaseMs: 15 * 60 * 1000, now: rollback.clock.now(),
  });
  rollback.setNow('2026-07-18T00:00:00.000Z');
  rollback.producerRepository.renewLease({
    lease: rollbackLease, leaseMs: 15 * 60 * 1000, now: rollback.clock.now(),
  });
  rollback.setNow('2026-07-17T23:55:00.000Z');
  assert.throws(() => rollback.producerRepository.prepareGeneration({
    lease: rollbackLease, now: rollback.clock.now(),
  }), /clock_rollback_detected/);
});

test('durable author checkpoint survives process loss and forbids same-reservation replay',
  (t) => {
    const fixture = setup(t);
    const lease = fixture.producerRepository.tryAcquireLease({
      ownerId: 'producer:sigkill', leaseMs: 1000, now: fixture.clock.now(),
    });
    const plan = fixture.producerRepository.prepareGeneration({
      lease,
      now: fixture.clock.now(),
    });
    const reservation = canaryReservationFor(plan.plannedGeneration);
    fixture.producerRepository.beginProviderCanaryAction({
      lease,
      generationSequence: plan.generationSequence,
      reservation,
      role: 'research_author',
      failurePhase: 'research_author_canary',
      now: fixture.clock.now(),
    });
    // The external author call may now have succeeded, but SIGKILL prevented its outcome checkpoint.
    assert.equal(fixture.producerRepository.readGeneration(1)
      .providerCanaryAttemptJournal.currentRole, 'research_author');

    // SIGKILL equivalent: the durable author checkpoint exists, but no failure catch ran.
    fixture.producerRepository.close();
    fixture.setNow('2026-07-17T00:00:02.000Z');
    const reopened = createAutonomousResearchTopicProducerRepository({
      runtimeRoot: fixture.runtimeRoot,
      machineIntakeConfigurationHash: fixture.configuration.configurationHash,
      producerProfile: fixture.profile,
      providerCanaryPairMaximumCostUsd: 1,
      liveMutationAuthority: fixture.liveMutationAuthority,
    });
    t.after(() => { try { reopened.close(); } catch { /* already closed */ } });
    const recoveryLease = reopened.tryAcquireLease({
      ownerId: 'producer:restart', leaseMs: 1000, now: fixture.clock.now(),
    });
    assert.ok(recoveryLease);
    assert.equal(reopened.prepareGeneration({
      lease: recoveryLease,
      now: fixture.clock.now(),
    }), null);
    const recovered = reopened.readGeneration(1);
    assert.equal(recovered.status, 'failed');
    assert.equal(recovered.providerCanarySideEffectInspection.actionAccountingComplete, false);
    assert.equal(recovered.providerCanarySideEffectInspection.externalActionMayHaveOccurred, true);
    assert.equal(recovered.providerCanarySideEffectInspection.actions.length, 0);
    const afterRecovery = reopened.readStatus({ now: fixture.clock.now() });
    assert.equal(afterRecovery.providerCanaryAttemptCount, 1);
    assert.equal(afterRecovery.providerCanaryReservedCostUsd, 1);
    assert.equal(afterRecovery.producedTopicCount, 1);
    reopened.releaseLease({ lease: recoveryLease });

    fixture.setNow(afterRecovery.nextAttemptAt);
    const retryLease = reopened.tryAcquireLease({
      ownerId: 'producer:new-reservation', leaseMs: 1000, now: fixture.clock.now(),
    });
    const retry = reopened.prepareGeneration({ lease: retryLease, now: fixture.clock.now() });
    assert.equal(retry.generationSequence, 2);
    assert.notEqual(retry.plannedGeneration.budgetReservationId,
      plan.plannedGeneration.budgetReservationId);
    assert.notEqual(retry.plannedGeneration.producerTopicId,
      plan.plannedGeneration.producerTopicId);
    const afterRetry = reopened.readStatus({ now: fixture.clock.now() });
    assert.equal(afterRetry.providerCanaryAttemptCount, 2);
    assert.equal(afterRetry.providerCanaryReservedCostUsd, 2);
    assert.equal(afterRetry.producedTopicCount, 2);
    reopened.releaseLease({ lease: retryLease });
  });

test('authorized uncommitted generation is conservatively closed without canary replay',
  async (t) => {
    const fixture = setup(t);
    const lease = fixture.producerRepository.tryAcquireLease({
      ownerId: 'producer:authorized-crash', leaseMs: 1000, now: fixture.clock.now(),
    });
    const plan = fixture.producerRepository.prepareGeneration({
      lease,
      now: fixture.clock.now(),
    });
    const live = await fixture.liveMutationAuthority.authorize({
      producerLease: lease,
      assertProducerLease: fixture.producerRepository.assertLease,
      residentLeaseContext: fixture.resident,
      assertAutonomyCurrent: fixture.assertAutonomyCurrent,
      plannedGeneration: plan.plannedGeneration,
      expected: {
        machineIntakeConfigurationHash: fixture.configuration.configurationHash,
        producerProfileHash: fixture.profile.producerProfileHash,
        providerConfigurationHash: fixture.profile.providerConfigurationHash,
        implementationSha256: fixture.profile.implementationSha256,
      },
      beginProviderCanaryAction: fixture.producerRepository.beginProviderCanaryAction,
      finishProviderCanaryAction: fixture.producerRepository.finishProviderCanaryAction,
    });
    const capability = buildAutonomousResearchTopicProducerCapabilityReceipt({
      producerProfile: fixture.profile,
      machineIntakeConfigurationHash: fixture.configuration.configurationHash,
      generationSequence: plan.generationSequence,
      intake: plan.plannedGeneration.intake,
      plannedGeneration: plan.plannedGeneration,
      providerCanaryPairReceipt: live.providerCanaryPairReceipt,
      producerLeaseGeneration: lease.leaseGeneration,
      producerLeaseTokenHash: hashRecord(
        'AutonomousResearchTopicProducerLeaseToken', lease.leaseToken,
      ),
      residentLeaseGeneration: fixture.resident.lease.leaseGeneration,
      residentLeaseTokenHash: hashRecord(
        'AutonomousResearchResidentLeaseToken', fixture.resident.lease.leaseToken,
      ),
      capabilityNonce: live.capabilityNonce,
      now: fixture.clock.now(),
    });
    fixture.producerRepository.issueAppendAuthorization({
      lease,
      plannedGeneration: plan.plannedGeneration,
      capability,
      intake: plan.plannedGeneration.intake,
      liveMutationAuthorization: live.authorization,
      now: fixture.clock.now(),
    });
    assert.equal(fixture.producerRepository.readGeneration(1).status, 'authorized');
    assert.equal(fixture.canaryCalls(), 1);

    fixture.producerRepository.close();
    fixture.setNow('2026-07-17T00:00:02.000Z');
    const reopened = createAutonomousResearchTopicProducerRepository({
      runtimeRoot: fixture.runtimeRoot,
      machineIntakeConfigurationHash: fixture.configuration.configurationHash,
      producerProfile: fixture.profile,
      providerCanaryPairMaximumCostUsd: 1,
      liveMutationAuthority: fixture.liveMutationAuthority,
    });
    t.after(() => { try { reopened.close(); } catch { /* already closed */ } });
    const recoveryLease = reopened.tryAcquireLease({
      ownerId: 'producer:authorized-restart', leaseMs: 1000, now: fixture.clock.now(),
    });
    assert.equal(reopened.prepareGeneration({
      lease: recoveryLease,
      now: fixture.clock.now(),
    }), null);
    const recovered = reopened.readGeneration(1);
    assert.equal(recovered.status, 'failed');
    assert.equal(recovered.providerCanarySideEffectInspection.actionAccountingComplete, false);
    assert.equal(recovered.providerCanarySideEffectInspection.actions.length, 2);
    assert.equal(reopened.readStatus({ now: fixture.clock.now() }).providerCanaryAttemptCount, 1);
    assert.equal(fixture.canaryCalls(), 1);
    reopened.releaseLease({ lease: recoveryLease });
  });

test('author success and reviewer failure persist a restart-auditable bounded side-effect receipt',
  async (t) => {
    const providerConfiguration = providerConfigurationFixture();
    const probeRoles = [];
    const secretBearingError = new Error('reviewer failed token=do-not-persist');
    const fixture = setup(t, {
      providerConfigurationHash:
        providerConfiguration.autonomousResearchProviderConfigurationHash,
      providerCanaryRunner: instrumentedCanaryRunner(providerConfiguration, {
        probeRoles,
        reviewerError: secretBearingError,
      }),
    });

    const failed = await fixture.producer.reconcile({
      residentLeaseContext: fixture.resident,
      assertAutonomyCurrent: fixture.assertAutonomyCurrent,
    });
    assert.equal(failed.ready, false);
    assert.deepEqual(probeRoles, ['author', 'reviewer']);
    const generation = fixture.producerRepository.readGeneration(1);
    const inspection = generation.providerCanarySideEffectInspection;
    assert.equal(generation.status, 'failed');
    assert.equal(generation.error, 'formal_reviewer_canary_failed');
    assert.equal(inspection.actionAccountingComplete, true);
    assert.equal(inspection.providerCanaryActionCount, 2);
    assert.equal(inspection.successfulProviderCanaryActionCount, 1);
    assert.equal(inspection.failedProviderCanaryActionCount, 1);
    assert.equal(inspection.researchAuthorCanaryAttemptCount, 1);
    assert.equal(inspection.formalReviewerCanaryAttemptCount, 1);
    assert.equal(inspection.actions[0].status, 'succeeded');
    assert.equal(inspection.actions[1].status, 'failed');
    assert.equal(inspection.reservation.providerCanaryReservedAttemptCount, 1);
    assert.equal(inspection.reservation.providerCanaryReservedCostUsd, 1);
    assert.equal(inspection.reservation.budgetReservationId,
      generation.plannedGeneration.budgetReservationId);
    assert.equal(verifyAutonomousResearchProviderCanarySideEffectInspection(inspection, {
      providerConfigurationHash: fixture.profile.providerConfigurationHash,
      reservation: inspection.reservation,
    }), true);
    assert.equal(JSON.stringify(inspection).includes('do-not-persist'), false);
    const status = fixture.producerRepository.readStatus({ now: fixture.clock.now() });
    assert.equal(status.providerCanaryAttemptCount, 1);
    assert.equal(status.providerCanaryReservedCostUsd, 1);
    const retryDeferred = await fixture.producer.reconcile({
      residentLeaseContext: fixture.resident,
      assertAutonomyCurrent: fixture.assertAutonomyCurrent,
    });
    assert.equal(retryDeferred.externalActionPerformed, false);
    assert.deepEqual(probeRoles, ['author', 'reviewer']);

    const databasePath = fixture.producerRepository.databasePath;
    fixture.producerRepository.close();
    const reopened = createAutonomousResearchTopicProducerRepository({
      runtimeRoot: fixture.runtimeRoot,
      machineIntakeConfigurationHash: fixture.configuration.configurationHash,
      producerProfile: fixture.profile,
      providerCanaryPairMaximumCostUsd: 1,
      liveMutationAuthority: fixture.liveMutationAuthority,
      create: false,
    });
    assert.equal(reopened.readGeneration(1)
      .providerCanarySideEffectInspection
      .autonomousResearchProviderCanarySideEffectInspectionHash,
    inspection.autonomousResearchProviderCanarySideEffectInspectionHash);
    reopened.close();

    const database = new DatabaseSync(databasePath);
    const stored = database.prepare(`SELECT provider_canary_side_effect_inspection_json
      FROM autonomous_research_topic_producer_generation
      WHERE generation_sequence=1`).get();
    const corrupted = JSON.parse(stored.provider_canary_side_effect_inspection_json);
    corrupted.successfulProviderCanaryActionCount = 2;
    database.prepare(`UPDATE autonomous_research_topic_producer_generation
      SET provider_canary_side_effect_inspection_json=?
      WHERE generation_sequence=1`).run(JSON.stringify(corrupted));
    database.close();
    const corruptedRepository = createAutonomousResearchTopicProducerRepository({
      runtimeRoot: fixture.runtimeRoot,
      machineIntakeConfigurationHash: fixture.configuration.configurationHash,
      producerProfile: fixture.profile,
      providerCanaryPairMaximumCostUsd: 1,
      liveMutationAuthority: fixture.liveMutationAuthority,
      create: false,
    });
    assert.throws(() => corruptedRepository.readGeneration(1),
      /autonomous_research_topic_producer_state_invalid/);
    corruptedRepository.close();
  });

test('receipt persistence failure is explicit, non-retryable, and recovered without replay',
  async (t) => {
    const providerConfiguration = providerConfigurationFixture();
    const probeRoles = [];
    const fixture = setup(t, {
      providerConfigurationHash:
        providerConfiguration.autonomousResearchProviderConfigurationHash,
      providerCanaryRunner: instrumentedCanaryRunner(providerConfiguration, {
        probeRoles,
        reviewerError: new Error('reviewer_failed'),
      }),
      failGenerationError: new Error('injected_sqlite_ioerr'),
    });
    const failed = await fixture.producer.reconcile({
      residentLeaseContext: fixture.resident,
      assertAutonomyCurrent: fixture.assertAutonomyCurrent,
    });
    assert.equal(failed.ready, false);
    assert.equal(failed.status,
      'autonomous_research_topic_producer_failure_persistence_failed');
    assert.equal(failed.persistenceVerified, false);
    assert.equal(failed.retryable, false);
    assert.equal(failed.externalActionPerformed, true);
    assert.equal(failed.externalActionMayHaveOccurred, true);
    assert.equal(failed.error,
      'autonomous_research_topic_producer_failure_persistence_failed');
    assert.deepEqual(probeRoles, ['author', 'reviewer']);
    const unfinalized = fixture.producerRepository.readGeneration(1);
    assert.equal(unfinalized.status, 'planned');
    assert.equal(unfinalized.providerCanaryAttemptStarted, true);
    assert.equal(unfinalized.providerCanaryAttemptJournal.actions.length, 2);
    assert.equal(unfinalized.providerCanarySideEffectInspection, null);

    const recovered = await fixture.producer.reconcile({
      residentLeaseContext: fixture.resident,
      assertAutonomyCurrent: fixture.assertAutonomyCurrent,
    });
    assert.equal(recovered.status,
      'autonomous_research_topic_producer_interrupted_canary_recovered');
    assert.equal(recovered.persistenceVerified, true);
    assert.equal(recovered.externalActionPerformed, false);
    assert.equal(recovered.externalActionMayHaveOccurred, true);
    assert.equal(recovered.generation.providerCanarySideEffectInspection
      .actionAccountingComplete, false);
    assert.equal(recovered.generation.providerCanarySideEffectInspection
      .externalActionMayHaveOccurred, true);
    assert.deepEqual(probeRoles, ['author', 'reviewer']);
    const budget = fixture.producerRepository.readStatus({ now: fixture.clock.now() });
    assert.equal(budget.providerCanaryAttemptCount, 1);
    assert.equal(budget.providerCanaryReservedCostUsd, 1);
  });

test('failed provider-attempt receipt deletion is rejected while pre-provider failures remain readable',
  async (t) => {
    const providerConfiguration = providerConfigurationFixture();
    const fixture = setup(t, {
      providerConfigurationHash:
        providerConfiguration.autonomousResearchProviderConfigurationHash,
      providerCanaryRunner: instrumentedCanaryRunner(providerConfiguration, {
        reviewerError: new Error('reviewer_failed'),
      }),
    });
    await fixture.producer.reconcile({
      residentLeaseContext: fixture.resident,
      assertAutonomyCurrent: fixture.assertAutonomyCurrent,
    });
    const databasePath = fixture.producerRepository.databasePath;
    fixture.producerRepository.close();
    const database = new DatabaseSync(databasePath);
    database.prepare(`UPDATE autonomous_research_topic_producer_generation
      SET provider_canary_side_effect_inspection_json=NULL
      WHERE generation_sequence=1`).run();
    database.close();
    const tampered = createAutonomousResearchTopicProducerRepository({
      runtimeRoot: fixture.runtimeRoot,
      machineIntakeConfigurationHash: fixture.configuration.configurationHash,
      producerProfile: fixture.profile,
      providerCanaryPairMaximumCostUsd: 1,
      liveMutationAuthority: fixture.liveMutationAuthority,
      create: false,
    });
    assert.throws(() => tampered.readGeneration(1),
      /autonomous_research_topic_producer_state_invalid/);
    tampered.close();
    assert.equal(inspectAutonomousResearchTopicProducerStatus({
      runtimeRoot: fixture.runtimeRoot,
      machineIntakeConfigurationHash: fixture.configuration.configurationHash,
      producerProfile: fixture.profile,
      implementationSha256: fixture.profile.implementationSha256,
      now: fixture.clock.now(),
    }).blocker, 'autonomous_research_topic_producer_state_invalid');

    const clean = setup(t);
    const lease = clean.producerRepository.tryAcquireLease({
      ownerId: 'producer:pre-provider-failure',
      leaseMs: 1000,
      now: clean.clock.now(),
    });
    const plan = clean.producerRepository.prepareGeneration({
      lease,
      now: clean.clock.now(),
    });
    clean.producerRepository.failGeneration({
      lease,
      generationSequence: plan.generationSequence,
      error: new Error('autonomy_changed_before_provider_action'),
      retryAfterMs: 60_000,
      now: clean.clock.now(),
    });
    const preProvider = clean.producerRepository.readGeneration(1);
    assert.equal(preProvider.status, 'failed');
    assert.equal(preProvider.providerCanaryAttemptStarted, false);
    assert.equal(preProvider.providerCanaryAttemptJournal, null);
    assert.equal(preProvider.providerCanarySideEffectInspection, null);
    clean.producerRepository.close();
    const cleanReopened = createAutonomousResearchTopicProducerRepository({
      runtimeRoot: clean.runtimeRoot,
      machineIntakeConfigurationHash: clean.configuration.configurationHash,
      producerProfile: clean.profile,
      providerCanaryPairMaximumCostUsd: 1,
      liveMutationAuthority: clean.liveMutationAuthority,
      create: false,
    });
    assert.equal(cleanReopened.readGeneration(1).error,
      'autonomy_changed_before_provider_action');
    cleanReopened.close();
  });

test('between-role fence failure records the completed author action without reviewer execution',
  async (t) => {
    const providerConfiguration = providerConfigurationFixture();
    const probeRoles = [];
    const fixture = setup(t, {
      providerConfigurationHash:
        providerConfiguration.autonomousResearchProviderConfigurationHash,
      providerCanaryRunner: instrumentedCanaryRunner(providerConfiguration, { probeRoles }),
    });
    const failed = await fixture.producer.reconcile({
      residentLeaseContext: fixture.resident,
      assertAutonomyCurrent({ action }) {
        return Object.freeze({
          ready: true,
          operationMode: action === 'topic_producer_provider_canary_between_roles'
            ? 'bootstrap-only' : 'full',
        });
      },
    });
    assert.equal(failed.ready, false);
    assert.deepEqual(probeRoles, ['author']);
    const inspection = fixture.producerRepository.readGeneration(1)
      .providerCanarySideEffectInspection;
    assert.equal(inspection.failurePhase, 'between_role_fence');
    assert.equal(inspection.providerCanaryActionCount, 1);
    assert.equal(inspection.successfulProviderCanaryActionCount, 1);
    assert.equal(inspection.failedProviderCanaryActionCount, 0);
    assert.equal(inspection.formalReviewerCanaryAttemptCount, 0);
    assert.equal(fixture.producerRepository.readStatus({ now: fixture.clock.now() })
      .providerCanaryReservedCostUsd, 1);
  });

test('post-canary authority fence failure preserves both successful external actions', async (t) => {
  const providerConfiguration = providerConfigurationFixture();
  const probeRoles = [];
  let measurements = 0;
  const fixture = setup(t, {
    providerConfigurationHash:
      providerConfiguration.autonomousResearchProviderConfigurationHash,
    providerCanaryRunner: instrumentedCanaryRunner(providerConfiguration, { probeRoles }),
    authorityRemeasure() {
      measurements += 1;
      return Object.freeze({
        ready: true,
        authorityMeasurementHash: H(measurements === 1 ? 'current-authority' : 'rotated-authority'),
      });
    },
  });
  const failed = await fixture.producer.reconcile({
    residentLeaseContext: fixture.resident,
    assertAutonomyCurrent: fixture.assertAutonomyCurrent,
  });
  assert.equal(failed.ready, false);
  assert.deepEqual(probeRoles, ['author', 'reviewer']);
  const inspection = fixture.producerRepository.readGeneration(1)
    .providerCanarySideEffectInspection;
  assert.equal(inspection.failurePhase, 'post_canary_authority_fence');
  assert.equal(inspection.providerCanaryActionCount, 2);
  assert.equal(inspection.successfulProviderCanaryActionCount, 2);
  assert.equal(inspection.failedProviderCanaryActionCount, 0);
  assert.equal(inspection.reservation.providerCanaryReservedCostUsd, 1);
  const status = fixture.producerRepository.readStatus({ now: fixture.clock.now() });
  assert.equal(status.providerCanaryAttemptCount, 1);
  assert.equal(status.providerCanaryReservedCostUsd, 1);
});

test('generation-authorization fence failure persists the completed canary pair', async (t) => {
  const providerConfiguration = providerConfigurationFixture();
  const probeRoles = [];
  const fixture = setup(t, {
    providerConfigurationHash:
      providerConfiguration.autonomousResearchProviderConfigurationHash,
    providerCanaryRunner: instrumentedCanaryRunner(providerConfiguration, { probeRoles }),
  });
  const failed = await fixture.producer.reconcile({
    residentLeaseContext: fixture.resident,
    assertAutonomyCurrent({ action }) {
      return Object.freeze({
        ready: true,
        operationMode: action === 'topic_producer_generation_authorization'
          ? 'bootstrap-only' : 'full',
      });
    },
  });
  assert.equal(failed.ready, false);
  assert.deepEqual(probeRoles, ['author', 'reviewer']);
  const generation = fixture.producerRepository.readGeneration(1);
  const inspection = generation.providerCanarySideEffectInspection;
  assert.equal(generation.status, 'failed');
  assert.equal(inspection.failurePhase, 'post_canary_generation_fence');
  assert.equal(inspection.actionAccountingComplete, true);
  assert.equal(inspection.providerCanaryActionCount, 2);
  assert.equal(inspection.successfulProviderCanaryActionCount, 2);
  assert.equal(inspection.failedProviderCanaryActionCount, 0);
  assert.equal(fixture.producerRepository.readStatus({ now: fixture.clock.now() })
    .providerCanaryReservedCostUsd, 1);
});

for (const migrationCase of [
  Object.freeze({ label: 'planned', authorize: false, committed: false }),
  Object.freeze({ label: 'authorized', authorize: true, committed: false }),
  Object.freeze({ label: 'authorized committed', authorize: true, committed: true }),
]) {
  test(`legacy ${migrationCase.label} in-flight upgrade cannot replay its canary reservation`,
    async (t) => {
      const fixture = setup(t);
      const lease = fixture.producerRepository.tryAcquireLease({
        ownerId: `producer:legacy-${migrationCase.label.replace(' ', '-')}`,
        leaseMs: 1000,
        now: fixture.clock.now(),
      });
      const plan = fixture.producerRepository.prepareGeneration({
        lease,
        now: fixture.clock.now(),
      });
      const live = await fixture.liveMutationAuthority.authorize({
        producerLease: lease,
        assertProducerLease: fixture.producerRepository.assertLease,
        residentLeaseContext: fixture.resident,
        assertAutonomyCurrent: fixture.assertAutonomyCurrent,
        plannedGeneration: plan.plannedGeneration,
        expected: {
          machineIntakeConfigurationHash: fixture.configuration.configurationHash,
          producerProfileHash: fixture.profile.producerProfileHash,
          providerConfigurationHash: fixture.profile.providerConfigurationHash,
          implementationSha256: fixture.profile.implementationSha256,
        },
        beginProviderCanaryAction: fixture.producerRepository.beginProviderCanaryAction,
        finishProviderCanaryAction: fixture.producerRepository.finishProviderCanaryAction,
      });
      if (migrationCase.authorize) {
        const capability = buildAutonomousResearchTopicProducerCapabilityReceipt({
          producerProfile: fixture.profile,
          machineIntakeConfigurationHash: fixture.configuration.configurationHash,
          generationSequence: plan.generationSequence,
          intake: plan.plannedGeneration.intake,
          plannedGeneration: plan.plannedGeneration,
          providerCanaryPairReceipt: live.providerCanaryPairReceipt,
          producerLeaseGeneration: lease.leaseGeneration,
          producerLeaseTokenHash: hashRecord(
            'AutonomousResearchTopicProducerLeaseToken', lease.leaseToken,
          ),
          residentLeaseGeneration: fixture.resident.lease.leaseGeneration,
          residentLeaseTokenHash: hashRecord(
            'AutonomousResearchResidentLeaseToken', fixture.resident.lease.leaseToken,
          ),
          capabilityNonce: live.capabilityNonce,
          now: fixture.clock.now(),
        });
        const appendAuthorization = fixture.producerRepository.issueAppendAuthorization({
          lease,
          plannedGeneration: plan.plannedGeneration,
          capability,
          intake: plan.plannedGeneration.intake,
          liveMutationAuthorization: live.authorization,
          now: fixture.clock.now(),
        });
        if (migrationCase.committed) {
          fixture.machineIntakeRepository.appendMachineIntake({
            intake: plan.plannedGeneration.intake,
            sourceAuthorityHash: fixture.configuration.configurationHash,
            topicProducerCapabilityReceipt: capability,
            topicProducerAppendAuthorization: appendAuthorization,
            now: fixture.clock.now(),
          });
        }
      }
      assert.equal(fixture.canaryCalls(), 1);
      assert.equal(fixture.producerRepository.readGeneration(1).status,
        migrationCase.authorize ? 'authorized' : 'planned');

      const databasePath = fixture.producerRepository.databasePath;
      fixture.machineIntakeRepository.close();
      fixture.producerRepository.close();
      dropTopicProducerCanaryJournalColumns(databasePath);
      fixture.setNow('2026-07-17T00:00:02.000Z');

      const reopened = reopenProducerRepository(fixture);
      t.after(() => { try { reopened.close(); } catch { /* already closed */ } });
      const migrated = reopened.readGeneration(1);
      assert.equal(migrated.status, migrationCase.authorize ? 'authorized' : 'planned');
      assert.equal(migrated.providerCanaryAttemptStarted, true);
      assert.equal(migrated.providerCanaryAttemptJournal.failurePhase,
        'provider_canary_reserved');
      assert.deepEqual(migrated.providerCanaryAttemptJournal.actions, []);
      assert.equal(migrated.providerCanarySideEffectInspection, null);

      const reopenedMachine = createAutonomousResearchMachineIntakeRepository({
        runtimeRoot: fixture.runtimeRoot,
        authorizedSourceAuthorityHash: fixture.configuration.configurationHash,
        authorizedMachineProducerProfileHash: fixture.profile.producerProfileHash,
        machineProducerAppendAuthority: reopened,
      });
      t.after(() => { try { reopenedMachine.close(); } catch { /* already closed */ } });
      const coldProducer = createAutonomousResearchTopicProducer({
        configuration: fixture.configuration,
        producerProfile: fixture.profile,
        producerRepository: reopened,
        machineIntakeRepository: reopenedMachine,
        liveMutationAuthority: fixture.liveMutationAuthority,
        clock: fixture.clock,
        ownerId: `producer:legacy-restart-${migrationCase.label.replace(' ', '-')}`,
      });
      const coldResult = await coldProducer.reconcile({
        residentLeaseContext: fixture.resident,
        assertAutonomyCurrent: fixture.assertAutonomyCurrent,
      });
      assert.equal(fixture.canaryCalls(), 1);

      if (migrationCase.committed) {
        assert.equal(coldResult.status,
          'autonomous_research_topic_producer_committed_append_recovered');
        assert.equal(coldResult.externalActionPerformed, false);
        assert.equal(reopened.readGeneration(1).status, 'produced');
        assert.equal(reopened.readGeneration(1).providerCanarySideEffectInspection, null);
        assert.equal(reopened.readStatus({ now: fixture.clock.now() })
          .providerCanaryAttemptCount, 1);
        return;
      }

      assert.equal(coldResult.status,
        'autonomous_research_topic_producer_interrupted_canary_recovered');
      assert.equal(coldResult.externalActionPerformed, false);
      assert.equal(coldResult.externalActionMayHaveOccurred, true);
      const recovered = reopened.readGeneration(1);
      assert.equal(recovered.status, 'failed');
      assert.equal(recovered.providerCanarySideEffectInspection.actionAccountingComplete, false);
      assert.equal(recovered.providerCanarySideEffectInspection.externalActionPerformed, false);
      assert.equal(recovered.providerCanarySideEffectInspection.externalActionMayHaveOccurred, true);
      assert.deepEqual(recovered.providerCanarySideEffectInspection.actions, []);
      const afterRecovery = reopened.readStatus({ now: fixture.clock.now() });
      assert.equal(afterRecovery.providerCanaryAttemptCount, 1);
      assert.equal(afterRecovery.providerCanaryReservedCostUsd, 1);
      assert.equal(afterRecovery.producedTopicCount, 1);

      fixture.setNow(afterRecovery.nextAttemptAt);
      const retryLease = reopened.tryAcquireLease({
        ownerId: `producer:legacy-retry-${migrationCase.label}`,
        leaseMs: 1000,
        now: fixture.clock.now(),
      });
      const retry = reopened.prepareGeneration({
        lease: retryLease,
        now: fixture.clock.now(),
      });
      assert.equal(retry.generationSequence, 2);
      assert.notEqual(retry.plannedGeneration.budgetReservationId,
        plan.plannedGeneration.budgetReservationId);
      assert.notEqual(retry.plannedGeneration.producerTopicId,
        plan.plannedGeneration.producerTopicId);
      assert.equal(fixture.canaryCalls(), 1);
      const afterRetry = reopened.readStatus({ now: fixture.clock.now() });
      assert.equal(afterRetry.providerCanaryAttemptCount, 2);
      assert.equal(afterRetry.providerCanaryReservedCostUsd, 2);
      assert.equal(afterRetry.producedTopicCount, 2);
      reopened.releaseLease({ lease: retryLease });
    });
}

test('legacy schema upgrade and ambiguity-journal backfill roll back atomically', (t) => {
  const fixture = setup(t);
  const lease = fixture.producerRepository.tryAcquireLease({
    ownerId: 'producer:legacy-atomic-migration', leaseMs: 1000, now: fixture.clock.now(),
  });
  fixture.producerRepository.prepareGeneration({ lease, now: fixture.clock.now() });
  const databasePath = fixture.producerRepository.databasePath;
  fixture.machineIntakeRepository.close();
  fixture.producerRepository.close();
  dropTopicProducerCanaryJournalColumns(databasePath);
  const corrupt = new DatabaseSync(databasePath);
  corrupt.prepare(`UPDATE autonomous_research_topic_producer_generation
    SET planned_generation_json='{}' WHERE generation_sequence=1`).run();
  corrupt.close();

  assert.throws(() => reopenProducerRepository(fixture), /topic_producer_state_invalid/);
  const afterFailure = new DatabaseSync(databasePath, { readOnly: true });
  const columns = new Set(afterFailure.prepare(
    'PRAGMA table_info(autonomous_research_topic_producer_generation)',
  ).all().map((column) => column.name));
  assert.equal(columns.has('provider_canary_attempt_started'), false);
  assert.equal(columns.has('provider_canary_attempt_journal_json'), false);
  assert.equal(columns.has('provider_canary_side_effect_inspection_json'), false);
  afterFailure.close();
});

test('read-only startup rejects the legacy schema without mutating it before writable migration',
  (t) => {
    const fixture = setup(t);
    const lease = fixture.producerRepository.tryAcquireLease({
      ownerId: 'producer:legacy-pre-provider-failure',
      leaseMs: 1000,
      now: fixture.clock.now(),
    });
    const plan = fixture.producerRepository.prepareGeneration({
      lease,
      now: fixture.clock.now(),
    });
    const failed = fixture.producerRepository.failGeneration({
      lease,
      generationSequence: plan.generationSequence,
      error: new Error('legacy_pre_provider_failure'),
      retryAfterMs: 15 * 60 * 1000,
      now: fixture.clock.now(),
    });
    assert.equal(failed.providerCanaryAttemptStarted, false);
    assert.equal(failed.providerCanarySideEffectInspection, null);
    fixture.producerRepository.releaseLease({ lease });
    const databasePath = fixture.producerRepository.databasePath;
    fixture.producerRepository.close();
    dropTopicProducerCanaryJournalColumns(databasePath);
    const legacyBytes = fs.readFileSync(databasePath);
    const legacyMtimeMs = fs.statSync(databasePath).mtimeMs;
    const open = (create) => createAutonomousResearchTopicProducerRepository({
      runtimeRoot: fixture.runtimeRoot,
      machineIntakeConfigurationHash: fixture.configuration.configurationHash,
      producerProfile: fixture.profile,
      providerCanaryPairMaximumCostUsd: 1,
      liveMutationAuthority: fixture.liveMutationAuthority,
      create,
    });
    assert.equal(inspectAutonomousResearchTopicProducerStatus({
      runtimeRoot: fixture.runtimeRoot,
      machineIntakeConfigurationHash: fixture.configuration.configurationHash,
      producerProfile: fixture.profile,
      implementationSha256: fixture.profile.implementationSha256,
      now: fixture.clock.now(),
    }).blocker, 'autonomous_research_topic_producer_schema_upgrade_required');
    assert.throws(() => open(false), /topic_producer_schema_upgrade_required/);
    assert.deepEqual(fs.readFileSync(databasePath), legacyBytes);
    assert.equal(fs.statSync(databasePath).mtimeMs, legacyMtimeMs);
    const stillLegacy = new DatabaseSync(databasePath, { readOnly: true });
    const legacyColumns = new Set(stillLegacy.prepare(
      'PRAGMA table_info(autonomous_research_topic_producer_generation)',
    ).all().map((column) => column.name));
    assert.equal(legacyColumns.has('provider_canary_attempt_started'), false);
    assert.equal(legacyColumns.has('provider_canary_attempt_journal_json'), false);
    assert.equal(legacyColumns.has('provider_canary_side_effect_inspection_json'), false);
    stillLegacy.close();
    const migrated = open(true);
    const preserved = migrated.readGeneration(plan.generationSequence);
    assert.equal(preserved.status, 'failed');
    assert.equal(preserved.error, 'legacy_pre_provider_failure');
    assert.equal(preserved.providerCanaryAttemptStarted, false);
    assert.equal(preserved.providerCanaryAttemptJournal, null);
    assert.equal(preserved.providerCanarySideEffectInspection, null);
    migrated.close();
    const current = new DatabaseSync(databasePath, { readOnly: true });
    const currentColumns = new Set(current.prepare(
      'PRAGMA table_info(autonomous_research_topic_producer_generation)',
    ).all().map((column) => column.name));
    assert.equal(currentColumns.has('provider_canary_attempt_started'), true);
    assert.equal(currentColumns.has('provider_canary_attempt_journal_json'), true);
    assert.equal(currentColumns.has('provider_canary_side_effect_inspection_json'), true);
    current.close();
  });
