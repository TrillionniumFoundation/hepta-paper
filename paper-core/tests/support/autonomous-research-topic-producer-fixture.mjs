import fs from 'node:fs';
import { registerHooks } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { hashRecord } from '../../../workflow-kernel/record-hash.mjs';
import { createAutonomousResearchTopicProducer } from '../../../paper-application/automation/autonomous-research-topic-producer.mjs';
import { createAutonomousResearchTopicProducerLiveAuthority } from '../../../paper-application/automation/autonomous-research-topic-producer-live-authority.mjs';
import {
  appendMachineAutonomousResearchIntake,
  buildAutonomousResearchMachineIntakeConfiguration,
} from '../../../paper-adapters/automation/autonomous-research-machine-intake-loader.mjs';
import { inspectAutonomousResearchTopicProducerImplementationIdentity } from '../../../paper-adapters/automation/autonomous-research-topic-producer-profile-loader.mjs';
import { createAutonomousResearchTopicProducerRepository } from '../../../paper-adapters/automation/autonomous-research-topic-producer-repository.mjs';
import {
  AUTONOMOUS_RESEARCH_TOPIC_PRODUCER_MUTATION_PLANS,
  AUTONOMOUS_RESEARCH_TOPIC_PRODUCER_OPERATION_IDS,
  AUTONOMOUS_RESEARCH_TOPIC_PRODUCER_WRITER_ID,
  AUTONOMOUS_RESEARCH_TOPIC_PRODUCER_WRITER_PLAN_HASH,
  createOfflineTopicProducerMutationCoordinator,
} from '../../../paper-adapters/automation/autonomous-research-topic-producer-mutation-plan.mjs';
import {
  createExternallyFencedSqliteMutationCoordinator,
} from '../../../paper-adapters/automation/externally-fenced-sqlite-mutation-coordinator.mjs';
import {
  AUTONOMOUS_RESEARCH_ONLINE_MUTATION_MARKER_SCHEMA_STATEMENTS,
} from '../../../paper-adapters/automation/autonomous-research-online-authority-journal.mjs';
import {
  inspectAutonomousResearchTopicProducerStatus,
} from '../../../paper-adapters/automation/autonomous-research-topic-producer-status.mjs';
import {
  runAutonomousResearchProviderCanaryPair,
} from '../../../paper-composition/automation/autonomous-research-provider-canary.mjs';
import {
  resolveAutonomousResearchProviderConfiguration,
} from '../../../paper-composition/automation/autonomous-research-provider-configuration.mjs';
import {
  buildAutonomousResearchTopicProducerCapabilityReceipt,
  buildAutonomousResearchTopicProducerProfile,
} from '../../../paper-domain/automation/autonomous-research-topic-producer-contract.mjs';
import {
  providerCanaryAction,
  verifyAutonomousResearchProviderCanarySideEffectInspection,
} from '../../../paper-domain/automation/autonomous-research-provider-canary-side-effect-inspection.mjs';
import {
  buildAutonomousResearchRecurringGoldenTemplate,
} from '../../../paper-domain/automation/autonomous-research-machine-intake-contract.mjs';
import {
  AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL,
} from '../../../paper-domain/automation/autonomous-research-online-mutation-contract.mjs';
import {
  autonomousResearchOnlineWriterOperationManifestHash,
  AUTONOMOUS_RESEARCH_ONLINE_WRITER_INTEGRATED_PROTOCOL_STATUS,
  AUTONOMOUS_RESEARCH_ONLINE_WRITER_MANIFEST_KIND,
  AUTONOMOUS_RESEARCH_ONLINE_WRITER_PROTOCOL_STATUS,
} from '../../../paper-domain/automation/autonomous-research-online-writer-manifest.mjs';
import {
  AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES,
} from '../../../paper-domain/automation/autonomous-research-state-backup-contract.mjs';
import {
  installMachineIntakeExternalGenesisAuthority,
} from '../machine-intake-external-authority-test-support.mjs';

const AUTHORITY_STATE_MODULE = new URL(
  '../../../paper-adapters/automation/autonomous-research-machine-intake-authority.mjs',
  import.meta.url,
);
const AUTHORIZATION_MODULE = new URL(
  '../../../paper-adapters/automation/autonomous-research-machine-intake-authority-rotation-authorization.mjs',
  import.meta.url,
);
const AUTHORIZATION_DOUBLE = new URL(
  '../test-doubles/autonomous-research-machine-intake-authority-rotation-authorization.mjs',
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
  '../../../paper-adapters/automation/autonomous-research-machine-intake-repository.mjs'
);
const { composeAutonomousResearchMachineIntakePlane } = await import(
  '../../../paper-composition/automation/autonomous-research-machine-intake-composition.mjs'
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
  topicMutationCoordinator = null,
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
    mutationCoordinator: topicMutationCoordinator,
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

function recordingTopicMutationCoordinator(calls, {
  status = 'externally_fenced_sqlite_mutation_coordinator_ready',
  blockers = [],
  sideEffectMode = 'offline',
} = {}) {
  const local = createOfflineTopicProducerMutationCoordinator();
  const coveredDatabaseRoles = Object.freeze(['topic-producer']);
  return Object.freeze({
    implemented: true,
    coveredDatabaseRoles,
    executeMutation(input) {
      const sideEffectReservationHashes = input.sideEffectReservationHashes || [];
      calls.push(Object.freeze({
        databaseRole: input.databaseRole,
        databaseInstanceId: input.databaseInstanceId,
        schemaContractId: input.schemaContractId,
        writerId: input.writerId,
        operationId: input.operationId,
        sideEffectReservationHashes: Object.freeze([...sideEffectReservationHashes]),
      }));
      const receipt = local.executeMutation(input);
      if (sideEffectReservationHashes.length === 0 || sideEffectMode === 'offline') {
        return receipt;
      }
      if (sideEffectMode === 'pending') {
        const error = new Error(
          'externally_fenced_sqlite_mutation_committed_finalization_pending',
        );
        error.committed = true;
        error.reservationId = `reservation:${calls.length}`;
        throw error;
      }
      return Object.freeze({
        ...receipt,
        status: 'externally_fenced_sqlite_mutation_finalized',
        reservationId: `reservation:${calls.length}`,
        sideEffectPermitHash: sideEffectMode === 'finalized'
          ? H(`permit:${sideEffectReservationHashes.join(',')}`)
          : null,
      });
    },
    recoverPendingMutations() { return Object.freeze({ recovered: 0 }); },
    inspectStatus() {
      return Object.freeze({
        version: 1,
        kind: 'ExternallyFencedSqliteMutationCoordinatorStatus',
        status,
        implemented: true,
        coveredDatabaseRoles,
        blockers: Object.freeze([...blockers]),
      });
    },
  });
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


export {
  AUTONOMOUS_RESEARCH_ONLINE_MUTATION_MARKER_SCHEMA_STATEMENTS,
  AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL,
  AUTONOMOUS_RESEARCH_ONLINE_WRITER_INTEGRATED_PROTOCOL_STATUS,
  AUTONOMOUS_RESEARCH_ONLINE_WRITER_MANIFEST_KIND,
  AUTONOMOUS_RESEARCH_ONLINE_WRITER_PROTOCOL_STATUS,
  AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES,
  AUTONOMOUS_RESEARCH_TOPIC_PRODUCER_MUTATION_PLANS,
  AUTONOMOUS_RESEARCH_TOPIC_PRODUCER_OPERATION_IDS,
  AUTONOMOUS_RESEARCH_TOPIC_PRODUCER_WRITER_ID,
  AUTONOMOUS_RESEARCH_TOPIC_PRODUCER_WRITER_PLAN_HASH,
  BUDGETS,
  H,
  PROVIDER_HASH,
  appendMachineAutonomousResearchIntake,
  autonomousResearchOnlineWriterOperationManifestHash,
  buildAutonomousResearchMachineIntakeConfiguration,
  buildAutonomousResearchRecurringGoldenTemplate,
  buildAutonomousResearchTopicProducerCapabilityReceipt,
  buildAutonomousResearchTopicProducerProfile,
  canaryPair,
  canaryReservationFor,
  checkpointCanaryPair,
  composeAutonomousResearchMachineIntakePlane,
  createAutonomousResearchMachineIntakeRepository,
  createAutonomousResearchTopicProducer,
  createAutonomousResearchTopicProducerLiveAuthority,
  createAutonomousResearchTopicProducerRepository,
  createExternallyFencedSqliteMutationCoordinator,
  createOfflineTopicProducerMutationCoordinator,
  dropTopicProducerCanaryJournalColumns,
  fullAutonomyCurrent,
  hashRecord,
  innerCanary,
  inspectAutonomousResearchTopicProducerImplementationIdentity,
  inspectAutonomousResearchTopicProducerStatus,
  installMachineIntakeExternalGenesisAuthority,
  instrumentedCanaryRunner,
  producerProfile,
  providerCanaryAction,
  providerConfigurationFixture,
  recordingTopicMutationCoordinator,
  reopenProducerRepository,
  residentContext,
  runAutonomousResearchProviderCanaryPair,
  setup,
  verifyAutonomousResearchProviderCanarySideEffectInspection,
};
