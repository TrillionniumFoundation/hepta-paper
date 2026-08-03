import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  AUTONOMOUS_RESEARCH_ONE_SHOT_FORBIDDEN_PREPARE_ENVIRONMENT_KEYS,
  AUTONOMOUS_RESEARCH_ONE_SHOT_PROTECTED_CAMPAIGN_ID,
  AUTONOMOUS_RESEARCH_ONE_SHOT_PROVIDER_CONFIGURATION_HASH,
  AUTONOMOUS_RESEARCH_ONE_SHOT_TARGET_CAMPAIGN_ID,
  AUTONOMOUS_RESEARCH_ONE_SHOT_TARGET_OBJECTIVE,
  AUTONOMOUS_RESEARCH_ONE_SHOT_TARGET_PAPER_ID,
  autonomousResearchOneShotCampaignCodeProvenanceHash,
  autonomousResearchOneShotCampaignEnvironmentProjectionHash,
  autonomousResearchOneShotProtectedCampaignFingerprintHash,
  autonomousResearchOneShotProviderRuntimeBindingHash,
  autonomousResearchOneShotCampaignSourceExecutionSnapshotHash,
  autonomousResearchOneShotTargetCampaignDefinitionHash,
  buildAutonomousResearchOneShotCampaignAttemptReservation,
} from '../../paper-domain/automation/autonomous-research-one-shot-campaign-attempt.mjs';
import {
  createCampaignOneShotAttemptJournalRepository,
} from '../../paper-adapters/automation/campaign-one-shot-attempt-journal-repository.mjs';
import {
  createOfflineSqliteStore,
} from '../../paper-adapters/persistence/sqlite-store.mjs';
import {
  composeFixedAutonomousResearchOneShotCampaignAttempt,
  composeAutonomousResearchOneShotCampaignAttempt,
  fixedAutonomousResearchOneShotProviderEnvironment,
  inspectAutonomousResearchOneShotProviderRuntimeBinding,
  projectAutonomousResearchCampaignTerminalResult,
} from '../../paper-composition/automation/autonomous-research-one-shot-campaign-attempt-composition.mjs';
import {
  resolveAutonomousResearchProviderConfiguration,
} from '../../paper-composition/automation/autonomous-research-provider-configuration.mjs';
import {
  composeAutonomousResearchCampaignAction,
} from '../../paper-composition/automation/autonomous-research-campaign-composition.mjs';
import {
  loadDatasetMounts,
  main as runOneShotCampaignAttemptCli,
} from '../bin/autonomous-research-one-shot-campaign-attempt.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

function H(label) {
  return hashRecord('AutonomousResearchOneShotCampaignAttemptTestHash', { label });
}

function outputCollector() {
  const chunks = [];
  return {
    stream: { write: (chunk) => { chunks.push(String(chunk)); } },
    text: () => chunks.join(''),
  };
}

test('one-shot CLI exposes help without composing runtime state', async () => {
  const output = outputCollector();
  await runOneShotCampaignAttemptCli({
    argv: ['--help'],
    stdout: output.stream,
    composeAttempt() {
      throw new Error('composition_must_not_run');
    },
  });
  const report = JSON.parse(output.text());
  assert.equal(report.kind, 'AutonomousResearchOneShotCampaignAttemptUsage');
  assert.equal(report.safety.createOnly, true);
});

test('one-shot CLI forwards strict status input without dataset loading', async () => {
  const output = outputCollector();
  let captured;
  await runOneShotCampaignAttemptCli({
    argv: ['--action', 'status', '--attempt-id', 'attempt-1'],
    stdout: output.stream,
    assetRoot: '/tmp/assets',
    nativeRuntimeRoot: '/tmp/native-runtime',
    async composeAttempt(input) {
      captured = input;
      return { status: 'inspection' };
    },
  });
  assert.equal(captured.action, 'status');
  assert.equal(captured.attemptId, 'attempt-1');
  assert.deepEqual(captured.datasetMounts, []);
  assert.equal(JSON.parse(output.text()).status, 'inspection');
});

test('one-shot terminal projection recognizes application campaign statuses', () => {
  assert.deepEqual(
    projectAutonomousResearchCampaignTerminalResult({
      status: 'autonomous_research_campaign_completed',
    }),
    {
      terminalStatus: 'completed',
      outcome: { campaignStatus: 'autonomous_research_campaign_completed' },
    },
  );
  assert.deepEqual(
    projectAutonomousResearchCampaignTerminalResult({
      status: 'autonomous_research_campaign_failed',
    }),
    {
      terminalStatus: 'failed_terminal',
      outcome: { campaignStatus: 'autonomous_research_campaign_failed' },
    },
  );
  assert.deepEqual(
    projectAutonomousResearchCampaignTerminalResult({
      status: 'autonomous_research_campaign_stopped',
    }),
    {
      terminalStatus: 'failed_terminal',
      outcome: { campaignStatus: 'autonomous_research_campaign_stopped' },
    },
  );
});

test('one-shot CLI loads execute mounts and rejects malformed command input', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-one-shot-cli-'));
  const mountsPath = path.join(root, 'mounts.json');
  fs.writeFileSync(mountsPath, JSON.stringify([{ name: 'fixed-dataset' }]));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const output = outputCollector();
  let captured;
  await runOneShotCampaignAttemptCli({
    argv: ['--action', 'execute', '--dataset-mount-file', mountsPath],
    stdout: output.stream,
    assetRoot: '/tmp/assets',
    nativeRuntimeRoot: '/tmp/native-runtime',
    async composeAttempt(input) {
      captured = input;
      return { status: 'autonomous_research_one_shot_campaign_attempt_terminal' };
    },
  });
  assert.deepEqual(captured.datasetMounts, [{ name: 'fixed-dataset' }]);
  assert.match(captured.controlRoot, /one-shot-campaign-control$/);
  await assert.rejects(
    () => runOneShotCampaignAttemptCli({ argv: ['--action', 'invalid'] }),
    /autonomous_research_one_shot_action_invalid:invalid/,
  );
  await assert.rejects(
    () => runOneShotCampaignAttemptCli({ argv: ['--action', 'status'] }),
    /autonomous_research_one_shot_attempt_id_required/,
  );
  assert.throws(() => loadDatasetMounts(null),
    /autonomous_research_one_shot_dataset_mount_file_required/);
});

test('fixed provider projection is immutable and matches the protected hash', () => {
  const runtimeRoot = '/data/home-data/hepta-paper-runtime/native-runtime';
  const environment = fixedAutonomousResearchOneShotProviderEnvironment({
    runtimeRoot,
    environment: {
      HEPTA_RESEARCH_AUTHOR_MODEL: 'arbitrary-model',
      HEPTA_FORMAL_REVIEW_CODEX_HOME: '/tmp/arbitrary-home',
      PRESERVED_UNRELATED_VALUE: 'preserved',
    },
  });
  const configuration = resolveAutonomousResearchProviderConfiguration({ environment });
  assert.equal(configuration.autonomousResearchProviderConfigurationHash,
    AUTONOMOUS_RESEARCH_ONE_SHOT_PROVIDER_CONFIGURATION_HASH);
  assert.equal(configuration.researchAuthor.model, 'gpt-5.6-sol');
  assert.equal(configuration.formalReviewer.codexHome,
    '/data/home-data/hepta-paper-runtime/openclaw-managed-codex/formal-reviewer');
  assert.equal(environment.PRESERVED_UNRELATED_VALUE, 'preserved');
});

test('provider runtime binding captures the managed profile and config identities', () => {
  const providerConfiguration = {
    autonomousResearchProviderConfigurationHash:
      AUTONOMOUS_RESEARCH_ONE_SHOT_PROVIDER_CONFIGURATION_HASH,
    researchAuthor: { provider: 'codex', codexHome: '/author' },
    formalReviewer: { provider: 'codex', codexHome: '/reviewer' },
  };
  const binding = inspectAutonomousResearchOneShotProviderRuntimeBinding({
    providerConfiguration,
    environment: {},
    preflightAuthor: () => ({
      codexHome: '/author',
      capabilityReceipt: {
        codexResearchAuthorCapabilityReceiptHash: H('author-capability'),
        credentialConfigIdentityHash: H('author-config'),
        openClawManagedAuthProfileIdentityHash: H('profile'),
        openClawManagedRuntimeProvenanceHash: H('runtime'),
        openClawManagedAuthSourceIdentityHash: H('auth-source'),
      },
    }),
    preflightReviewer: () => ({
      capabilityReceipt: {
        codexFormalReviewerCapabilityReceiptHash: H('reviewer-capability'),
        credentialConfigIdentityHash: H('reviewer-config'),
        openClawManagedAuthProfileIdentityHash: H('profile'),
        openClawManagedRuntimeProvenanceHash: H('runtime'),
        openClawManagedAuthSourceIdentityHash: H('auth-source'),
      },
    }),
  });
  assert.equal(binding.researchAuthorCredentialConfigIdentityHash, H('author-config'));
  assert.equal(binding.formalReviewerCredentialConfigIdentityHash, H('reviewer-config'));
  assert.notEqual(
    autonomousResearchOneShotProviderRuntimeBindingHash(binding),
    autonomousResearchOneShotProviderRuntimeBindingHash({
      ...binding,
      researchAuthorOpenClawManagedAuthProfileIdentityHash: H('other-profile'),
    }),
  );
});

test('execute rejects provider mismatch before creating the control journal', async () => {
  let journalFactoryCalls = 0;
  await assert.rejects(
    () => composeFixedAutonomousResearchOneShotCampaignAttempt({
      workspaceRoot: '/tmp/workspace',
      root: '/tmp/assets',
      runtimeRoot: '/tmp/runtime/native-runtime',
      controlRoot: '/tmp/runtime/one-shot-control',
      datasetMounts: [{}],
      providerConfigurationResolver() {
        return { autonomousResearchProviderConfigurationHash: H('mismatch') };
      },
      journalRepositoryFactory() {
        journalFactoryCalls += 1;
        throw new Error('journal_must_not_be_created');
      },
    }),
    /autonomous_research_one_shot_provider_configuration_mismatch/,
  );
  assert.equal(journalFactoryCalls, 0);
});

test('execute rejects source blockers before creating the control journal', async () => {
  let journalFactoryCalls = 0;
  const protectedCampaign = {
    campaignId: AUTONOMOUS_RESEARCH_ONE_SHOT_PROTECTED_CAMPAIGN_ID,
    paperId: 'local-auto-20260730-51',
    status: 'failed',
  };
  const failedNode = {
    status: 'failed_terminal',
    leaseOwner: null,
    failureClass: 'agent_usage_unknown_terminal',
  };
  await assert.rejects(
    () => composeFixedAutonomousResearchOneShotCampaignAttempt({
      workspaceRoot: '/tmp/workspace',
      root: '/tmp/assets',
      runtimeRoot: '/data/home-data/hepta-paper-runtime/native-runtime',
      controlRoot: '/tmp/runtime/one-shot-control',
      datasetMounts: [{}],
      providerConfigurationResolver() {
        return {
          autonomousResearchProviderConfigurationHash:
            AUTONOMOUS_RESEARCH_ONE_SHOT_PROVIDER_CONFIGURATION_HASH,
        };
      },
      readOnlyStoreFactory() {
        return {
          query: () => ({ ok: true, rows: [{ count: 0 }] }),
          close() {},
        };
      },
      campaignStoreFactory() {
        return {
          getCampaign(campaignId) {
            return campaignId === AUTONOMOUS_RESEARCH_ONE_SHOT_PROTECTED_CAMPAIGN_ID
              ? protectedCampaign : null;
          },
          listNodes() {
            return [failedNode];
          },
        };
      },
      codeProvenanceInspector: () => ({ treeDirty: false }),
      providerRuntimeBindingInspector: () => providerRuntimeBinding(),
      sourceSnapshotInspector: () => ({ blockers: ['dirty_source'] }),
      journalRepositoryFactory() {
        journalFactoryCalls += 1;
        throw new Error('journal_must_not_be_created');
      },
    }),
    /autonomous_research_one_shot_source_snapshot_blocked:dirty_source/,
  );
  assert.equal(journalFactoryCalls, 0);
});

test('execute reports dirty code provenance before creating the control journal', async () => {
  let snapshotInspectorCalls = 0;
  let journalFactoryCalls = 0;
  await assert.rejects(
    () => composeFixedAutonomousResearchOneShotCampaignAttempt({
      workspaceRoot: '/tmp/workspace',
      root: '/tmp/assets',
      runtimeRoot: '/data/home-data/hepta-paper-runtime/native-runtime',
      controlRoot: '/tmp/runtime/one-shot-control',
      datasetMounts: [{}],
      providerConfigurationResolver() {
        return {
          autonomousResearchProviderConfigurationHash:
            AUTONOMOUS_RESEARCH_ONE_SHOT_PROVIDER_CONFIGURATION_HASH,
        };
      },
      readOnlyStoreFactory() {
        return {
          query: () => ({ ok: true, rows: [{ count: 0 }] }),
          close() {},
        };
      },
      campaignStoreFactory() {
        return {
          getCampaign(campaignId) {
            return campaignId === AUTONOMOUS_RESEARCH_ONE_SHOT_PROTECTED_CAMPAIGN_ID
              ? {
                campaignId,
                paperId: 'local-auto-20260730-51',
                status: 'failed',
              } : null;
          },
          listNodes() {
            return [{
              status: 'failed_terminal',
              leaseOwner: null,
              failureClass: 'agent_usage_unknown_terminal',
            }];
          },
        };
      },
      codeProvenanceInspector: () => ({ treeDirty: true }),
      providerRuntimeBindingInspector: () => providerRuntimeBinding(),
      sourceSnapshotInspector() {
        snapshotInspectorCalls += 1;
        throw new Error('snapshot_must_not_run');
      },
      journalRepositoryFactory() {
        journalFactoryCalls += 1;
        throw new Error('journal_must_not_be_created');
      },
    }),
    /autonomous_research_one_shot_source_snapshot_blocked:dirty_git_worktree/,
  );
  assert.equal(snapshotInspectorCalls, 0);
  assert.equal(journalFactoryCalls, 0);
});

function providerRuntimeBinding() {
  return {
    version: 1,
    kind: 'AutonomousResearchOneShotProviderRuntimeBinding',
    providerConfigurationHash:
      AUTONOMOUS_RESEARCH_ONE_SHOT_PROVIDER_CONFIGURATION_HASH,
    researchAuthorCapabilityReceiptHash: H('author-capability'),
    formalReviewerCapabilityReceiptHash: H('reviewer-capability'),
    researchAuthorCredentialConfigIdentityHash: H('author-config'),
    formalReviewerCredentialConfigIdentityHash: H('reviewer-config'),
    researchAuthorOpenClawManagedAuthProfileIdentityHash: H('author-profile'),
    formalReviewerOpenClawManagedAuthProfileIdentityHash: H('reviewer-profile'),
    openClawManagedRuntimeProvenanceHash: H('managed-runtime'),
    openClawManagedAuthSourceIdentityHash: H('managed-auth-source'),
  };
}

function executionBinding() {
  const codeProvenance = {
    version: 2,
    kind: 'CodeProvenance',
    commit: 'a'.repeat(40),
    commitTree: 'b'.repeat(40),
    treeDirty: false,
    indexStateHash: H('index'),
    repositoryContentHash: H('repository'),
    worktreeStateHash: H('worktree'),
  };
  const sourceExecutionSnapshot = {
    version: 1,
    merkleHash: H('merkle'),
    manifestHash: H('manifest'),
  };
  const protectedCampaignDefinition = {
    version: 1,
    campaignId: AUTONOMOUS_RESEARCH_ONE_SHOT_PROTECTED_CAMPAIGN_ID,
    status: 'failed',
    failedTerminalNodeCount: 1,
    skippedNodeCount: 65,
    activeNodeCount: 0,
    nodeLeaseCount: 0,
    resourceLeaseCount: 0,
    waiterCount: 0,
    failureClass: 'agent_usage_unknown_terminal',
    submissionCount: 0,
    outboxCount: 0,
    ledgerCount: 0,
    logicalStateHash: H('protected-logical-state'),
  };
  const targetCampaignDefinition = {
    version: 1,
    campaignId: AUTONOMOUS_RESEARCH_ONE_SHOT_TARGET_CAMPAIGN_ID,
    paperId: AUTONOMOUS_RESEARCH_ONE_SHOT_TARGET_PAPER_ID,
    objective: AUTONOMOUS_RESEARCH_ONE_SHOT_TARGET_OBJECTIVE,
    protocolFamily: 'finance_asset_pricing_benchmark',
    revisionRounds: 3,
    refereeCount: 3,
    requestedLaunchMode: 'local-run',
    effectiveLaunchMode: 'golden-bootstrap',
    localOnly: true,
    humanSubjects: false,
    privateData: false,
    unlimitedAggregateTokens: true,
    unlimitedAggregateCost: true,
    requireLaunchReady: true,
    requireCampaignAbsentAtLaunch: true,
    datasetMountsHash: H('dataset-mounts'),
    worker: {
      concurrency: 8,
      agentSlots: 4,
      cpuSlots: 4,
      gpuSlots: 1,
      memoryMiB: 8192,
    },
    budgets: {
      maxWallTimeMs: 7_200_000,
      maxAgentCalls: 201,
      maxCpuJobs: 14_400,
      maxGpuJobs: 16,
      maxMemoryMiB: 8192,
      maxTokenCount: Number.MAX_SAFE_INTEGER,
      maxCostUsd: Number.MAX_SAFE_INTEGER,
    },
  };
  const environmentProjection = {
    HEPTA_AUTONOMOUS_RESEARCH_CONTENT_MODE: 'deterministic-bounded',
  };
  const runtimeBinding = providerRuntimeBinding();
  return {
    version: 1,
    codeProvenance,
    codeProvenanceHash:
      autonomousResearchOneShotCampaignCodeProvenanceHash(codeProvenance),
    sourceExecutionSnapshot,
    sourceExecutionSnapshotHash:
      autonomousResearchOneShotCampaignSourceExecutionSnapshotHash(
        sourceExecutionSnapshot,
      ),
    autonomousResearchProviderConfigurationHash:
      AUTONOMOUS_RESEARCH_ONE_SHOT_PROVIDER_CONFIGURATION_HASH,
    providerRuntimeBinding: runtimeBinding,
    providerRuntimeBindingHash:
      autonomousResearchOneShotProviderRuntimeBindingHash(runtimeBinding),
    protectedCampaignDefinition,
    protectedCampaignFingerprintHash:
      autonomousResearchOneShotProtectedCampaignFingerprintHash(
        protectedCampaignDefinition,
      ),
    targetCampaignDefinition,
    targetCampaignDefinitionHash:
      autonomousResearchOneShotTargetCampaignDefinitionHash(targetCampaignDefinition),
    environmentProjection,
    preparationPolicy: {
      version: 1,
      mode: 'deterministic-bounded-offline-v1',
      contentMode: 'deterministic-bounded',
      providerFreeRequired: true,
      allowedExternalActionKinds: [],
      forbiddenEnvironmentKeys:
        AUTONOMOUS_RESEARCH_ONE_SHOT_FORBIDDEN_PREPARE_ENVIRONMENT_KEYS,
      environmentProjectionHash:
        autonomousResearchOneShotCampaignEnvironmentProjectionHash(environmentProjection),
    },
    campaignLaunchPolicy: {
      version: 1,
      createOnly: true,
      allowedRecoveryActions: ['status'],
      forbiddenActions: ['converge', 'resume'],
    },
  };
}

function fixture(t, label, repositoryOptions = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `hepta-one-shot-${label}-`));
  const runtimeRoot = path.join(root, 'native-runtime');
  const controlRoot = path.join(root, 'one-shot-control');
  fs.mkdirSync(runtimeRoot, { mode: 0o700 });
  const repository = createCampaignOneShotAttemptJournalRepository({
    controlRoot,
    runtimeRoot,
    create: true,
    clock: { now: () => new Date('2026-08-03T00:00:00.000Z') },
    ...repositoryOptions,
  });
  t.after(() => {
    repository.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const reservation = buildAutonomousResearchOneShotCampaignAttemptReservation({
    attemptId: `attempt-${label}`,
    idempotencyKey: H(`idempotency-${label}`),
    campaignId: AUTONOMOUS_RESEARCH_ONE_SHOT_TARGET_CAMPAIGN_ID,
    protectedCampaignId: AUTONOMOUS_RESEARCH_ONE_SHOT_PROTECTED_CAMPAIGN_ID,
    executionBinding: executionBinding(),
    reservedAt: '2026-08-03T00:00:00.000Z',
  });
  return { repository, reservation };
}

function appendPhase(repository, inspection, phase, evidence = { ready: true }) {
  return repository.appendEvent({
    attemptId: inspection.reservation.attemptId,
    phase,
    evidence,
    expectedSequence: inspection.events.length + 1,
    expectedPhase: inspection.headPhase,
    expectedPreviousEventHash: inspection.headEventHash,
  });
}

function callbacks(counts, overrides = {}) {
  return {
    async inspectPreconditions() {
      counts.preconditions += 1;
      return { evidence: { ready: true } };
    },
    async prepareCampaign() {
      counts.prepare += 1;
      return { evidence: { providerFree: true } };
    },
    async executeProviderAction() {
      counts.provider += 1;
      return { evidence: { providerReceiptHash: H('provider-receipt') } };
    },
    async launchCampaign() {
      counts.launch += 1;
      return {
        terminalStatus: 'completed',
        outcome: { campaignStatus: 'completed' },
      };
    },
    async inspectLaunchOutcome() {
      counts.monitor += 1;
      return { terminal: false };
    },
    ...overrides,
  };
}

test('one-shot composition completes once and terminal replay is side-effect free', async (t) => {
  const { repository, reservation } = fixture(t, 'complete');
  const counts = { preconditions: 0, prepare: 0, provider: 0, launch: 0, monitor: 0 };
  const actions = callbacks(counts);
  const first = await composeAutonomousResearchOneShotCampaignAttempt({
    repository,
    reservation,
    ...actions,
  });
  assert.equal(first.terminalReceipt.terminalStatus, 'completed');
  assert.deepEqual(counts,
    { preconditions: 1, prepare: 1, provider: 1, launch: 1, monitor: 0 });

  const replay = await composeAutonomousResearchOneShotCampaignAttempt({
    repository,
    reservation,
    ...actions,
  });
  assert.equal(replay.terminalReceipt.autonomousResearchOneShotCampaignAttemptTerminalReceiptHash,
    first.terminalReceipt.autonomousResearchOneShotCampaignAttemptTerminalReceiptHash);
  assert.deepEqual(counts,
    { preconditions: 1, prepare: 1, provider: 1, launch: 1, monitor: 0 });
});

test('commit acknowledgement loss never grants a replayed provider permit', (t) => {
  let injectAfterProviderMarker = true;
  const { repository, reservation } = fixture(t, 'ack-loss', {
    faultInjection: {
      afterCommit({ operation, value }) {
        if (operation === 'append' && value.headPhase === 'provider_started'
          && injectAfterProviderMarker) {
          injectAfterProviderMarker = false;
          throw new Error('simulated_commit_acknowledgement_loss');
        }
      },
    },
  });
  let inspection = repository.reserveAttempt({ reservation });
  inspection = appendPhase(repository, inspection, 'preconditions_verified');
  inspection = appendPhase(repository, inspection, 'prepare_verified', { providerFree: true });
  const appendInput = {
    attemptId: reservation.attemptId,
    phase: 'provider_started',
    evidence: { action: 'provider', status: 'external_action_marker_committed' },
    expectedSequence: inspection.events.length + 1,
    expectedPhase: inspection.headPhase,
    expectedPreviousEventHash: inspection.headEventHash,
  };
  assert.throws(
    () => repository.appendEvent(appendInput),
    /simulated_commit_acknowledgement_loss/,
  );
  assert.equal(repository.inspectAttempt({ attemptId: reservation.attemptId }).headPhase,
    'provider_started');
  const replay = repository.appendEvent(appendInput);
  assert.equal(replay.mutationDisposition.status, 'exact_replay');
  assert.equal(replay.mutationDisposition.externalActionPermitAvailable, false);
  assert.throws(
    () => repository.assertExternalActionSideEffectPermit({ transition: replay }),
    /campaign_one_shot_attempt_external_action_permit_invalid/,
  );
});

test('external action permit is single-use and invalid after head advancement', (t) => {
  const first = fixture(t, 'permit-single-use');
  let inspection = first.repository.reserveAttempt({ reservation: first.reservation });
  inspection = appendPhase(first.repository, inspection, 'preconditions_verified');
  inspection = appendPhase(first.repository, inspection, 'prepare_verified', { providerFree: true });
  const providerTransition = appendPhase(first.repository, inspection, 'provider_started', {
    action: 'provider', status: 'external_action_marker_committed',
  });
  assert.equal(first.repository.assertExternalActionSideEffectPermit({
    transition: providerTransition,
  }), true);
  assert.throws(
    () => first.repository.assertExternalActionSideEffectPermit({
      transition: providerTransition,
    }),
    /campaign_one_shot_attempt_external_action_permit_invalid/,
  );

  const second = fixture(t, 'permit-stale');
  inspection = second.repository.reserveAttempt({ reservation: second.reservation });
  inspection = appendPhase(second.repository, inspection, 'preconditions_verified');
  inspection = appendPhase(second.repository, inspection, 'prepare_verified', {
    providerFree: true,
  });
  const staleTransition = appendPhase(second.repository, inspection, 'provider_started', {
    action: 'provider', status: 'external_action_marker_committed',
  });
  appendPhase(second.repository, staleTransition, 'provider_completed', {
    providerReceiptHash: H('stale-provider-receipt'),
  });
  assert.throws(
    () => second.repository.assertExternalActionSideEffectPermit({
      transition: staleTransition,
    }),
    /campaign_one_shot_attempt_external_action_permit_stale/,
  );
});

test('journal schema tampering is detected before any later mutation', (t) => {
  const { repository, reservation } = fixture(t, 'schema-tamper');
  repository.reserveAttempt({ reservation });
  const databasePath = repository.databasePath;
  repository.close();
  const store = createOfflineSqliteStore({ dbPath: databasePath });
  try {
    const result = store.execute(
      'DROP TRIGGER campaign_one_shot_attempt_events_no_update;',
    );
    assert.equal(result.ok, true);
  } finally {
    store.close();
  }
  const reopened = createCampaignOneShotAttemptJournalRepository({
    controlRoot: path.dirname(databasePath),
    runtimeRoot: path.join(path.dirname(path.dirname(databasePath)), 'native-runtime'),
    create: false,
  });
  t.after(() => reopened.close());
  assert.throws(
    () => reopened.inspectAttempt({ attemptId: reservation.attemptId }),
    /campaign_one_shot_attempt_journal_(?:pragma|schema|integrity)_invalid/,
  );
});

test('provider failure becomes recovered-incomplete and is never replayed', async (t) => {
  const { repository, reservation } = fixture(t, 'provider-failure');
  const counts = { preconditions: 0, prepare: 0, provider: 0, launch: 0, monitor: 0 };
  const actions = callbacks(counts, {
    async executeProviderAction() {
      counts.provider += 1;
      throw new Error('provider_outcome_unknown');
    },
  });
  const first = await composeAutonomousResearchOneShotCampaignAttempt({
    repository,
    reservation,
    ...actions,
  });
  assert.equal(first.terminalReceipt.terminalStatus, 'recovered_incomplete');
  assert.equal(first.terminalReceipt.lastPhase, 'provider_started');

  await composeAutonomousResearchOneShotCampaignAttempt({
    repository,
    reservation,
    ...actions,
  });
  assert.equal(counts.provider, 1);
  assert.equal(counts.launch, 0);
});

test('launch-started recovery monitors without issuing another launch', async (t) => {
  const { repository, reservation } = fixture(t, 'launch-recovery');
  let inspection = repository.reserveAttempt({ reservation });
  for (const [phase, evidence] of [
    ['preconditions_verified', { ready: true }],
    ['prepare_verified', { providerFree: true }],
    ['provider_started', { action: 'provider' }],
    ['provider_completed', { providerReceiptHash: H('provider') }],
    ['launch_started', { action: 'launch' }],
  ]) {
    const head = inspection.events.at(-1);
    inspection = repository.appendEvent({
      attemptId: reservation.attemptId,
      phase,
      evidence,
      expectedSequence: head.sequence + 1,
      expectedPhase: head.phase,
      expectedPreviousEventHash:
        head.autonomousResearchOneShotCampaignAttemptEventHash,
    });
  }
  const counts = { preconditions: 0, prepare: 0, provider: 0, launch: 0, monitor: 0 };
  const report = await composeAutonomousResearchOneShotCampaignAttempt({
    repository,
    reservation,
    ...callbacks(counts, {
      async inspectLaunchOutcome() {
        counts.monitor += 1;
        return { terminal: false };
      },
    }),
  });
  assert.equal(report.status,
    'autonomous_research_one_shot_campaign_attempt_monitor_only');
  assert.equal(counts.monitor, 1);
  assert.equal(counts.launch, 0);
});

test('create-only campaign guard is accepted only by launch', async () => {
  await assert.rejects(
    () => composeAutonomousResearchCampaignAction({
      action: 'status',
      requireCampaignAbsentAtLaunch: true,
    }),
    /autonomous_research_require_campaign_absent_at_launch_requires_launch_action/,
  );
});
