import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  AUTONOMOUS_RESEARCH_ONE_SHOT_FORBIDDEN_PREPARE_ENVIRONMENT_KEYS,
  AUTONOMOUS_RESEARCH_ONE_SHOT_PROTECTED_CAMPAIGN_ID,
  AUTONOMOUS_RESEARCH_ONE_SHOT_PROVIDER_CONFIGURATION_HASH,
  AUTONOMOUS_RESEARCH_ONE_SHOT_TARGET_CAMPAIGN_ID,
  autonomousResearchOneShotProtectedCampaignFingerprintHash,
  autonomousResearchOneShotCampaignSourceExecutionSnapshotHash,
  autonomousResearchOneShotTargetCampaignDefinitionHash,
  buildAutonomousResearchOneShotCampaignAttemptReservation,
  canonicalAutonomousResearchOneShotCampaignAttemptJson,
  verifyAutonomousResearchOneShotCampaignExecutionBindingForHistoricalAudit,
  verifyAutonomousResearchOneShotCampaignAttemptReservationForHistoricalAudit,
} from '../../paper-domain/automation/autonomous-research-one-shot-campaign-attempt.mjs';
import { canonicalAutonomousResearchOneShotSnapshot } from '../../paper-domain/automation/autonomous-research-one-shot-canonical-json.mjs';
import {
  verifyAutonomousResearchOneShotHistoricalTargetCampaignDefinition,
} from '../../paper-domain/automation/autonomous-research-one-shot-target-campaign.mjs';
import {
  createCampaignOneShotAttemptJournalRepository,
} from '../../paper-adapters/automation/campaign-one-shot-attempt-journal-repository.mjs';
import {
  createOfflineSqliteStore,
} from '../../paper-adapters/persistence/sqlite-store.mjs';
import {
  composeFixedAutonomousResearchOneShotCampaignAttempt,
  composeAutonomousResearchOneShotCampaignAttempt,
  autonomousResearchOneShotCampaignAttemptIdempotencyKey,
  fixedAutonomousResearchOneShotPrepareEnvironment,
  projectAutonomousResearchCampaignTerminalResult,
  selectAutonomousResearchOneShotCampaignAttemptReservation,
} from '../../paper-composition/automation/autonomous-research-one-shot-campaign-attempt-composition.mjs';
import {
  assertAutonomousResearchOneShotProviderCanaryReceiptBound,
  canonicalAutonomousResearchOneShotDatasetMounts,
  createAutonomousResearchOneShotCampaignExecutionBindingFence,
} from '../../paper-composition/automation/autonomous-research-one-shot-campaign-execution-fence.mjs';
import {
  loadDatasetMounts,
  main as runOneShotCampaignAttemptCli,
} from '../bin/autonomous-research-one-shot-campaign-attempt.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  executionBinding,
  gatewayProviderRuntimeBinding,
  legacyProviderRuntimeBinding,
  providerRuntimeBinding,
} from './support/autonomous-research-one-shot-campaign-attempt-fixture.mjs';

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
  const planOutput = outputCollector();
  await runOneShotCampaignAttemptCli({
    argv: ['--action', 'plan', '--dataset-mount-file', mountsPath],
    stdout: planOutput.stream,
    assetRoot: '/tmp/assets',
    nativeRuntimeRoot: '/tmp/native-runtime',
    async composeAttempt(input) {
      captured = input;
      return { status: 'autonomous_research_one_shot_campaign_preflight_passed' };
    },
  });
  assert.equal(captured.action, 'plan');
  assert.deepEqual(captured.datasetMounts, [{ name: 'fixed-dataset' }]);
  assert.equal(
    JSON.parse(planOutput.text()).status,
    'autonomous_research_one_shot_campaign_preflight_passed',
  );
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

test('fixed attempt replay binds the complete execution snapshot and refuses preseeded launch', () => {
  const currentBinding = executionBinding();
  const currentKey = autonomousResearchOneShotCampaignAttemptIdempotencyKey(
    currentBinding,
  );
  const attemptId = `campaign-57-${currentKey.slice(-24)}`;
  const candidateReservation = buildAutonomousResearchOneShotCampaignAttemptReservation({
    attemptId,
    idempotencyKey: currentKey,
    campaignId: AUTONOMOUS_RESEARCH_ONE_SHOT_TARGET_CAMPAIGN_ID,
    protectedCampaignId: AUTONOMOUS_RESEARCH_ONE_SHOT_PROTECTED_CAMPAIGN_ID,
    executionBinding: currentBinding,
    reservedAt: '2026-08-03T00:00:01.000Z',
  });
  const staleProtectedCampaignDefinition = {
    ...currentBinding.protectedCampaignDefinition,
    logicalStateHash: H('stale-protected-logical-state'),
  };
  const staleBinding = {
    ...currentBinding,
    protectedCampaignDefinition: staleProtectedCampaignDefinition,
    protectedCampaignFingerprintHash:
      autonomousResearchOneShotProtectedCampaignFingerprintHash(
        staleProtectedCampaignDefinition,
      ),
  };
  assert.notEqual(
    autonomousResearchOneShotCampaignAttemptIdempotencyKey(staleBinding),
    currentKey,
  );
  const preseededReservation = buildAutonomousResearchOneShotCampaignAttemptReservation({
    attemptId,
    idempotencyKey: currentKey,
    campaignId: AUTONOMOUS_RESEARCH_ONE_SHOT_TARGET_CAMPAIGN_ID,
    protectedCampaignId: AUTONOMOUS_RESEARCH_ONE_SHOT_PROTECTED_CAMPAIGN_ID,
    executionBinding: staleBinding,
    reservedAt: '2026-08-03T00:00:00.000Z',
  });
  assert.throws(
    () => selectAutonomousResearchOneShotCampaignAttemptReservation({
      existing: {
        reservation: preseededReservation,
        headPhase: 'attempt_reserved',
      },
      candidateReservation,
    }),
    /autonomous_research_one_shot_existing_reservation_binding_mismatch/,
  );
  assert.throws(
    () => selectAutonomousResearchOneShotCampaignAttemptReservation({
      existing: {
        reservation: candidateReservation,
        headPhase: 'provider_completed',
      },
      candidateReservation,
    }),
    /autonomous_research_one_shot_existing_provider_completion_not_launch_authority/,
  );
  assert.equal(
    selectAutonomousResearchOneShotCampaignAttemptReservation({
      existing: {
        reservation: candidateReservation,
        headPhase: 'provider_started',
      },
      candidateReservation,
    }),
    candidateReservation,
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

test('execute rejects dataset mount drift before journal or external actions', async () => {
  let journalFactoryCalls = 0;
  let campaignActionCalls = 0;
  let providerActionCalls = 0;
  const binding = executionBinding();
  const protectedCampaign = {
    campaignId: AUTONOMOUS_RESEARCH_ONE_SHOT_PROTECTED_CAMPAIGN_ID,
    paperId: 'local-auto-20260730-51',
    status: 'failed',
  };
  const nodes = [{
    status: 'failed_terminal',
    leaseOwner: null,
    failureClass: 'agent_usage_unknown_terminal',
  }, ...Array.from({ length: 65 }, () => ({
    status: 'skipped',
    leaseOwner: null,
    failureClass: null,
  }))];
  await assert.rejects(
    () => composeFixedAutonomousResearchOneShotCampaignAttempt({
      workspaceRoot: '/tmp/workspace',
      root: '/tmp/assets',
      runtimeRoot: '/data/home-data/hepta-paper-runtime/native-runtime',
      controlRoot: '/tmp/runtime/one-shot-control',
      datasetMounts: [{ name: 'hostile-unbound-dataset' }],
      environment: {
        HEPTA_AUTONOMOUS_RESEARCH_CONTENT_MODE: 'agent-evidence-bound',
        HEPTA_PRIOR_ART_SERVICE_CONFIG: '/private/hostile/prior-art.json',
      },
      providerConfigurationResolver: () => ({
        autonomousResearchProviderConfigurationHash:
          AUTONOMOUS_RESEARCH_ONE_SHOT_PROVIDER_CONFIGURATION_HASH,
      }),
      providerRuntimeBindingInspector: () => providerRuntimeBinding(),
      readOnlyStoreFactory: () => ({
        query: () => ({ ok: true, rows: [{ count: 0 }] }),
        close() {},
      }),
      campaignStoreFactory: () => ({
        getCampaign: (campaignId) => campaignId
          === AUTONOMOUS_RESEARCH_ONE_SHOT_PROTECTED_CAMPAIGN_ID
          ? protectedCampaign : null,
        listNodes: () => nodes,
      }),
      codeProvenanceInspector: () => binding.codeProvenance,
      sourceSnapshotInspector: () => ({
        ...binding.sourceExecutionSnapshot,
        blockers: [],
      }),
      campaignAction() {
        campaignActionCalls += 1;
        throw new Error('campaign_action_must_not_run');
      },
      providerCanaryRunner() {
        providerActionCalls += 1;
        throw new Error('provider_action_must_not_run');
      },
      journalRepositoryFactory() {
        journalFactoryCalls += 1;
        throw new Error('journal_must_not_be_created');
      },
    }),
    /autonomous_research_one_shot_execution_binding_invalid/,
  );
  assert.equal(journalFactoryCalls, 0);
  assert.equal(campaignActionCalls, 0);
  assert.equal(providerActionCalls, 0);
});

test('one-shot dataset mounts are isolated from caller mutation', () => {
  const callerDatasetMounts = [{
    name: 'fixed-dataset',
    readOnly: true,
    authority: { hashes: [H('dataset-authority')] },
  }];
  const boundDatasetMounts =
    canonicalAutonomousResearchOneShotDatasetMounts(callerDatasetMounts);
  callerDatasetMounts[0].name = 'mutated-after-binding';
  callerDatasetMounts[0].authority.hashes.push(H('hostile-late-hash'));
  callerDatasetMounts.push({ name: 'hostile-late-mount' });

  assert.deepEqual(boundDatasetMounts, [{
    authority: { hashes: [H('dataset-authority')] },
    name: 'fixed-dataset',
    readOnly: true,
  }]);
  assert.equal(Object.isFrozen(boundDatasetMounts), true);
  assert.equal(Object.isFrozen(boundDatasetMounts[0]), true);
  assert.equal(Object.isFrozen(boundDatasetMounts[0].authority.hashes), true);
});

test('one-shot canonical snapshots reject non-JSON own keys and invalid byte limits', () => {
  const symbolKey = Symbol('hidden');
  const value = { visible: true, [symbolKey]: 'must-not-be-discarded' };
  assert.throws(
    () => canonicalAutonomousResearchOneShotSnapshot(value, {
      code: 'canonical_snapshot_invalid', maximumBytes: 1024,
    }),
    /canonical_snapshot_invalid/,
  );
  for (const maximumBytes of [undefined, 0, -1, 1.5, Number.NaN, Infinity]) {
    assert.throws(
      () => canonicalAutonomousResearchOneShotSnapshot({ visible: true }, {
        code: 'canonical_snapshot_invalid', maximumBytes,
      }),
      /canonical_snapshot_invalid/,
    );
  }
  const arrayWithCustomPrototype = [];
  Object.setPrototypeOf(arrayWithCustomPrototype, Object.create(Array.prototype));
  assert.throws(
    () => canonicalAutonomousResearchOneShotSnapshot(arrayWithCustomPrototype, {
      code: 'canonical_snapshot_invalid', maximumBytes: 1024,
    }),
    /canonical_snapshot_invalid/,
  );
});

function providerCanaryPairReceipt(now, runtimeBinding = providerRuntimeBinding()) {
  const canary = (role) => {
    const author = role === 'research_author';
    const payload = {
      version: 1,
      kind: 'CodexModelAvailabilityCanaryReceipt',
      status: 'codex_model_live_canary_verified',
      selectedModelExecutionCanaryVerified: true,
      observedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 15 * 60 * 1000).toISOString(),
      externalActionPerformed: true,
      externalActionScope: 'single_read_only_ephemeral_model_canary',
      credentialConfigIdentityHash: author
        ? runtimeBinding.researchAuthorCredentialConfigIdentityHash
        : runtimeBinding.formalReviewerCredentialConfigIdentityHash,
      openClawManagedAuthProfileIdentityHash: author
        ? runtimeBinding.researchAuthorOpenClawManagedAuthProfileIdentityHash
        : runtimeBinding.formalReviewerOpenClawManagedAuthProfileIdentityHash,
      ...(runtimeBinding.version === 2 ? {
        openClawManagedAuthBindingMode:
          runtimeBinding.openClawManagedAuthBindingMode,
        openClawManagedGatewayRouteIdentityHash:
          runtimeBinding.openClawManagedGatewayRouteIdentityHash,
      } : {}),
      openClawManagedRuntimeProvenanceHash:
        runtimeBinding.openClawManagedRuntimeProvenanceHash,
      openClawManagedAuthSourceIdentityHash:
        runtimeBinding.openClawManagedAuthSourceIdentityHash,
      role,
    };
    return {
      ...payload,
      codexModelAvailabilityCanaryReceiptHash: hashRecord(
        'CodexModelAvailabilityCanaryReceipt',
        payload,
      ),
    };
  };
  const author = canary('research_author');
  const reviewer = canary('formal_reviewer');
  const payload = {
    version: 1,
    kind: 'AutonomousResearchProviderCanaryPairReceipt',
    status: 'autonomous_research_provider_canary_pair_verified',
    verified: true,
    autonomousResearchProviderConfigurationHash:
      runtimeBinding.providerConfigurationHash,
    researchAuthorCapabilityReceiptHash:
      runtimeBinding.researchAuthorCapabilityReceiptHash,
    formalReviewerCapabilityReceiptHash:
      runtimeBinding.formalReviewerCapabilityReceiptHash,
    researchAuthorProviderCanaryReceiptHash:
      author.codexModelAvailabilityCanaryReceiptHash,
    formalReviewerProviderCanaryReceiptHash:
      reviewer.codexModelAvailabilityCanaryReceiptHash,
    researchAuthorProviderCanaryReceipt: author,
    formalReviewerProviderCanaryReceipt: reviewer,
    observedAt: now.toISOString(),
    freshnessIntervalMs: 15 * 60 * 1000,
    externalActionPerformed: true,
    externalActionScope: 'two_read_only_ephemeral_model_canaries',
  };
  return {
    ...payload,
    providerCanaryPairReceiptHash: hashRecord(
      'AutonomousResearchProviderCanaryPairReceipt',
      payload,
    ),
  };
}

test('one-shot canary capabilities must match the reserved runtime binding', () => {
  const now = new Date('2026-08-03T00:00:00.000Z');
  const runtimeBinding = providerRuntimeBinding();
  const receipt = providerCanaryPairReceipt(now, runtimeBinding);
  assert.equal(assertAutonomousResearchOneShotProviderCanaryReceiptBound({
    receipt,
    expectedProviderConfigurationHash: runtimeBinding.providerConfigurationHash,
    expectedProviderRuntimeBinding: runtimeBinding,
    now,
  }), receipt);
  assert.throws(
    () => assertAutonomousResearchOneShotProviderCanaryReceiptBound({
      receipt,
      expectedProviderConfigurationHash: runtimeBinding.providerConfigurationHash,
      expectedProviderRuntimeBinding: {
        ...runtimeBinding,
        researchAuthorCapabilityReceiptHash: H('drifted-author-capability'),
      },
      now,
    }),
    /autonomous_research_one_shot_provider_canary_capability_mismatch/,
  );
  assert.throws(
    () => assertAutonomousResearchOneShotProviderCanaryReceiptBound({
      receipt,
      expectedProviderConfigurationHash: runtimeBinding.providerConfigurationHash,
      expectedProviderRuntimeBinding: {
        ...runtimeBinding,
        researchAuthorCredentialConfigIdentityHash: H('drifted-author-config'),
      },
      now,
    }),
    /autonomous_research_one_shot_provider_canary_capability_mismatch/,
  );

  const gatewayRuntimeBinding = gatewayProviderRuntimeBinding();
  const gatewayReceipt = providerCanaryPairReceipt(now, gatewayRuntimeBinding);
  assert.equal(assertAutonomousResearchOneShotProviderCanaryReceiptBound({
    receipt: gatewayReceipt,
    expectedProviderConfigurationHash: gatewayRuntimeBinding.providerConfigurationHash,
    expectedProviderRuntimeBinding: gatewayRuntimeBinding,
    now,
  }), gatewayReceipt);
  assert.throws(
    () => assertAutonomousResearchOneShotProviderCanaryReceiptBound({
      receipt: gatewayReceipt,
      expectedProviderConfigurationHash: gatewayRuntimeBinding.providerConfigurationHash,
      expectedProviderRuntimeBinding: {
        ...gatewayRuntimeBinding,
        openClawManagedGatewayRouteIdentityHash: H('drifted-gateway-route'),
      },
      now,
    }),
    /autonomous_research_one_shot_provider_canary_capability_mismatch/,
  );

  const legacyRuntimeBinding = legacyProviderRuntimeBinding();
  const legacyReceipt = providerCanaryPairReceipt(now, legacyRuntimeBinding);
  assert.equal(assertAutonomousResearchOneShotProviderCanaryReceiptBound({
    receipt: legacyReceipt,
    expectedProviderConfigurationHash: legacyRuntimeBinding.providerConfigurationHash,
    expectedProviderRuntimeBinding: legacyRuntimeBinding,
    now,
  }), legacyReceipt);
});

function historicalAttemptChain(ordinal, { terminal = true } = {}) {
  const paperId = `local-auto-20260730-${ordinal}`;
  const campaignId = `autonomous-research:${paperId}`;
  const currentBinding = executionBinding();
  const targetCampaignDefinition = {
    ...currentBinding.targetCampaignDefinition,
    campaignId,
    paperId,
    datasetMountsHash:
      'sha256:586dd4d1edb5ca3efee48d02726a1c7cf2044a6afe81b34bc5821c1e97d9c520',
  };
  let executionBindingValue = {
    ...currentBinding,
    targetCampaignDefinition,
    targetCampaignDefinitionHash:
      autonomousResearchOneShotTargetCampaignDefinitionHash(targetCampaignDefinition),
  };
  if (ordinal === 52) {
    executionBindingValue = Object.fromEntries(
      Object.entries(executionBindingValue).filter(([key]) => ![
        'providerRuntimeBinding',
        'providerRuntimeBindingHash',
      ].includes(key)),
    );
  }
  const attemptId = `historical-attempt-${ordinal}`;
  const idempotencyKey = H(`historical-idempotency-${ordinal}`);
  const reservedAt = '2026-08-03T00:00:00.000Z';
  const reservationPayload = {
    version: 1,
    kind: 'AutonomousResearchOneShotCampaignAttemptReservation',
    status: 'attempt_reserved',
    attemptId,
    idempotencyKey,
    campaignId,
    protectedCampaignId: AUTONOMOUS_RESEARCH_ONE_SHOT_PROTECTED_CAMPAIGN_ID,
    executionBinding: executionBindingValue,
    executionBindingHash: hashRecord(
      'AutonomousResearchOneShotCampaignExecutionBinding',
      executionBindingValue,
    ),
    reservedAt,
  };
  const reservation = {
    ...reservationPayload,
    autonomousResearchOneShotCampaignAttemptReservationHash: hashRecord(
      'AutonomousResearchOneShotCampaignAttemptReservation',
      reservationPayload,
    ),
  };
  const initialEvidence = {
    reservationHash:
      reservation.autonomousResearchOneShotCampaignAttemptReservationHash,
  };
  const initialEventPayload = {
    version: 1,
    kind: 'AutonomousResearchOneShotCampaignAttemptEvent',
    attemptId,
    idempotencyKey,
    campaignId,
    reservationHash:
      reservation.autonomousResearchOneShotCampaignAttemptReservationHash,
    sequence: 1,
    eventId: hashRecord('AutonomousResearchOneShotCampaignAttemptEventId', {
      attemptId,
      phase: 'attempt_reserved',
      reservationHash:
        reservation.autonomousResearchOneShotCampaignAttemptReservationHash,
      sequence: 1,
    }),
    phase: 'attempt_reserved',
    previousEventHash: null,
    evidence: initialEvidence,
    evidenceHash: hashRecord(
      'AutonomousResearchOneShotCampaignAttemptEventEvidence',
      initialEvidence,
    ),
    recordedAt: reservedAt,
  };
  const initialEvent = {
    ...initialEventPayload,
    autonomousResearchOneShotCampaignAttemptEventHash: hashRecord(
      'AutonomousResearchOneShotCampaignAttemptEvent',
      initialEventPayload,
    ),
  };
  if (!terminal) return { reservation, events: [initialEvent], terminalReceipt: null };

  const completedAt = '2026-08-03T00:00:01.000Z';
  const terminalReceiptPayload = {
    version: 1,
    kind: 'AutonomousResearchOneShotCampaignAttemptTerminalReceipt',
    status: 'autonomous_research_one_shot_campaign_attempt_terminal',
    attemptId,
    idempotencyKey,
    campaignId,
    reservationHash:
      reservation.autonomousResearchOneShotCampaignAttemptReservationHash,
    terminalStatus: 'blocked_pre_provider',
    lastPhase: 'attempt_reserved',
    lastEventHash:
      initialEvent.autonomousResearchOneShotCampaignAttemptEventHash,
    outcome: null,
    outcomeHash: null,
    providerMayHaveStarted: false,
    providerCompleted: false,
    launchMayHaveStarted: false,
    completedAt,
  };
  const terminalReceipt = {
    ...terminalReceiptPayload,
    autonomousResearchOneShotCampaignAttemptTerminalReceiptHash: hashRecord(
      'AutonomousResearchOneShotCampaignAttemptTerminalReceipt',
      terminalReceiptPayload,
    ),
  };
  const terminalEvidence = {
    terminalReceiptHash:
      terminalReceipt.autonomousResearchOneShotCampaignAttemptTerminalReceiptHash,
  };
  const terminalEventPayload = {
    ...initialEventPayload,
    sequence: 2,
    eventId: hashRecord('AutonomousResearchOneShotCampaignAttemptEventId', {
      attemptId,
      phase: 'terminal',
      reservationHash:
        reservation.autonomousResearchOneShotCampaignAttemptReservationHash,
      sequence: 2,
    }),
    phase: 'terminal',
    previousEventHash:
      initialEvent.autonomousResearchOneShotCampaignAttemptEventHash,
    evidence: terminalEvidence,
    evidenceHash: hashRecord(
      'AutonomousResearchOneShotCampaignAttemptEventEvidence',
      terminalEvidence,
    ),
    recordedAt: completedAt,
  };
  const terminalEvent = {
    ...terminalEventPayload,
    autonomousResearchOneShotCampaignAttemptEventHash: hashRecord(
      'AutonomousResearchOneShotCampaignAttemptEvent',
      terminalEventPayload,
    ),
  };
  return { reservation, events: [initialEvent, terminalEvent], terminalReceipt };
}

function insertHistoricalAttempt(databasePath, chain) {
  const database = new DatabaseSync(databasePath);
  database.exec('BEGIN IMMEDIATE;');
  try {
    const { reservation, events, terminalReceipt } = chain;
    database.prepare(`INSERT INTO campaign_one_shot_attempts(
      attempt_id,idempotency_key,campaign_id,protected_campaign_id,
      execution_binding_hash,reservation_hash,reservation_json,reserved_at)
      VALUES(?,?,?,?,?,?,?,?);`).run(
      reservation.attemptId,
      reservation.idempotencyKey,
      reservation.campaignId,
      reservation.protectedCampaignId,
      reservation.executionBindingHash,
      reservation.autonomousResearchOneShotCampaignAttemptReservationHash,
      canonicalAutonomousResearchOneShotCampaignAttemptJson(reservation),
      reservation.reservedAt,
    );
    const insertEvent = database.prepare(`INSERT INTO campaign_one_shot_attempt_events(
      event_id,attempt_id,sequence,phase,previous_event_hash,event_hash,
      event_json,recorded_at) VALUES(?,?,?,?,?,?,?,?);`);
    for (const event of events) {
      insertEvent.run(
        event.eventId,
        event.attemptId,
        event.sequence,
        event.phase,
        event.previousEventHash,
        event.autonomousResearchOneShotCampaignAttemptEventHash,
        canonicalAutonomousResearchOneShotCampaignAttemptJson(event),
        event.recordedAt,
      );
    }
    if (terminalReceipt) {
      database.prepare(`INSERT INTO campaign_one_shot_attempt_terminal_receipts(
        attempt_id,receipt_hash,receipt_json,terminal_event_hash,completed_at)
        VALUES(?,?,?,?,?);`).run(
        reservation.attemptId,
        terminalReceipt.autonomousResearchOneShotCampaignAttemptTerminalReceiptHash,
        canonicalAutonomousResearchOneShotCampaignAttemptJson(terminalReceipt),
        events.at(-1).autonomousResearchOneShotCampaignAttemptEventHash,
        terminalReceipt.completedAt,
      );
    }
    database.exec('COMMIT;');
  } catch (error) {
    database.exec('ROLLBACK;');
    throw error;
  } finally {
    database.close();
  }
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
    async assertProviderActionReady() {},
    async executeProviderAction() {
      counts.provider += 1;
      return { evidence: { providerReceiptHash: H('provider-receipt') } };
    },
    async assertLaunchActionReady() {},
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

function withSourceExecutionSnapshotDrift(binding, label) {
  const sourceExecutionSnapshot = {
    ...binding.sourceExecutionSnapshot,
    merkleHash: H(label),
  };
  return {
    ...binding,
    sourceExecutionSnapshot,
    sourceExecutionSnapshotHash:
      autonomousResearchOneShotCampaignSourceExecutionSnapshotHash(
        sourceExecutionSnapshot,
      ),
  };
}

test('fresh execution-binding drift blocks before the provider marker', async (t) => {
  const { repository, reservation } = fixture(t, 'pre-provider-binding-drift');
  const counts = { preconditions: 0, prepare: 0, provider: 0, launch: 0, monitor: 0 };
  let currentExecutionBinding = reservation.executionBinding;
  const fence = createAutonomousResearchOneShotCampaignExecutionBindingFence({
    expectedExecutionBinding: reservation.executionBinding,
    inspectCurrentExecutionBinding: () => currentExecutionBinding,
  });
  const report = await composeAutonomousResearchOneShotCampaignAttempt({
    repository,
    reservation,
    ...callbacks(counts, {
      async prepareCampaign() {
        counts.prepare += 1;
        currentExecutionBinding = withSourceExecutionSnapshotDrift(
          reservation.executionBinding,
          'pre-provider-drift',
        );
        return { evidence: { providerFree: true } };
      },
      async assertProviderActionReady() {
        fence.assertCurrent({ phase: 'pre_provider' });
      },
    }),
  });

  assert.equal(report.terminalReceipt.terminalStatus, 'blocked_pre_provider');
  assert.equal(report.terminalReceipt.lastPhase, 'prepare_verified');
  assert.equal(counts.provider, 0);
  assert.equal(counts.launch, 0);
  assert.equal(report.inspection.events.some((event) => (
    event.phase === 'provider_started'
  )), false);
});

test('provider marker-window drift is recovered without provider execution', async (t) => {
  const { repository, reservation } = fixture(t, 'provider-marker-binding-drift');
  const counts = { preconditions: 0, prepare: 0, provider: 0, launch: 0, monitor: 0 };
  const driftedExecutionBinding = withSourceExecutionSnapshotDrift(
    reservation.executionBinding,
    'provider-marker-drift',
  );
  let inspectionCount = 0;
  const fence = createAutonomousResearchOneShotCampaignExecutionBindingFence({
    expectedExecutionBinding: reservation.executionBinding,
    inspectCurrentExecutionBinding() {
      inspectionCount += 1;
      return inspectionCount === 1
        ? reservation.executionBinding : driftedExecutionBinding;
    },
  });
  const report = await composeAutonomousResearchOneShotCampaignAttempt({
    repository,
    reservation,
    ...callbacks(counts, {
      async assertProviderActionReady() {
        fence.assertCurrent({ phase: 'pre_provider' });
      },
      async executeProviderAction() {
        fence.assertCurrent({ phase: 'provider_started' });
        counts.provider += 1;
        return { evidence: { providerReceiptHash: H('provider-receipt') } };
      },
    }),
  });

  assert.equal(report.terminalReceipt.terminalStatus, 'recovered_incomplete');
  assert.equal(report.terminalReceipt.lastPhase, 'provider_started');
  assert.equal(counts.provider, 0);
  assert.equal(counts.launch, 0);
});

test('fresh execution-binding drift blocks before the launch marker', async (t) => {
  const { repository, reservation } = fixture(t, 'pre-launch-binding-drift');
  const counts = { preconditions: 0, prepare: 0, provider: 0, launch: 0, monitor: 0 };
  let currentExecutionBinding = reservation.executionBinding;
  const fence = createAutonomousResearchOneShotCampaignExecutionBindingFence({
    expectedExecutionBinding: reservation.executionBinding,
    inspectCurrentExecutionBinding: () => currentExecutionBinding,
  });
  const report = await composeAutonomousResearchOneShotCampaignAttempt({
    repository,
    reservation,
    ...callbacks(counts, {
      async assertProviderActionReady() {
        fence.assertCurrent({ phase: 'pre_provider' });
      },
      async executeProviderAction() {
        counts.provider += 1;
        fence.assertCurrent({ phase: 'post_provider_canary' });
        return { evidence: { providerReceiptHash: H('provider-receipt') } };
      },
      async assertLaunchActionReady() {
        currentExecutionBinding = withSourceExecutionSnapshotDrift(
          reservation.executionBinding,
          'pre-launch-drift',
        );
        fence.assertCurrent({ phase: 'pre_launch' });
      },
    }),
  });

  assert.equal(report.terminalReceipt.terminalStatus, 'blocked_post_provider');
  assert.equal(report.terminalReceipt.lastPhase, 'provider_completed');
  assert.equal(counts.provider, 1);
  assert.equal(counts.launch, 0);
  assert.equal(report.inspection.events.some((event) => (
    event.phase === 'launch_started'
  )), false);
});

test('launch marker-window drift is recovered without campaign launch', async (t) => {
  const { repository, reservation } = fixture(t, 'launch-marker-binding-drift');
  const counts = { preconditions: 0, prepare: 0, provider: 0, launch: 0, monitor: 0 };
  const driftedExecutionBinding = withSourceExecutionSnapshotDrift(
    reservation.executionBinding,
    'launch-marker-drift',
  );
  let inspectionCount = 0;
  const fence = createAutonomousResearchOneShotCampaignExecutionBindingFence({
    expectedExecutionBinding: reservation.executionBinding,
    inspectCurrentExecutionBinding() {
      inspectionCount += 1;
      return inspectionCount < 5
        ? reservation.executionBinding : driftedExecutionBinding;
    },
  });
  const report = await composeAutonomousResearchOneShotCampaignAttempt({
    repository,
    reservation,
    ...callbacks(counts, {
      async assertProviderActionReady() {
        fence.assertCurrent({ phase: 'pre_provider' });
      },
      async executeProviderAction() {
        fence.assertCurrent({ phase: 'provider_started' });
        counts.provider += 1;
        fence.assertCurrent({ phase: 'post_provider_canary' });
        return { evidence: { providerReceiptHash: H('provider-receipt') } };
      },
      async assertLaunchActionReady() {
        fence.assertCurrent({ phase: 'pre_launch' });
      },
      async launchCampaign() {
        fence.assertCurrent({ phase: 'launch_started' });
        counts.launch += 1;
        return {
          terminalStatus: 'completed',
          outcome: { campaignStatus: 'completed' },
        };
      },
    }),
  });

  assert.equal(report.terminalReceipt.terminalStatus, 'recovered_incomplete');
  assert.equal(report.terminalReceipt.lastPhase, 'launch_started');
  assert.equal(counts.provider, 1);
  assert.equal(counts.launch, 0);
});

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
  assert.equal(
    repository.inspectHistoricalAttempt({ campaignId: reservation.campaignId })
      .reservation.attemptId,
    reservation.attemptId,
  );
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

test('isolated prepare stays offline and provider runs only after durable marker', async (t) => {
  const { repository, reservation } = fixture(t, 'offline-prepare-boundary');
  const counts = { preconditions: 0, prepare: 0, provider: 0, launch: 0, monitor: 0 };
  const prepareEnvironment = fixedAutonomousResearchOneShotPrepareEnvironment({
    runtimeRoot: '/data/home-data/hepta-paper-runtime/native-runtime',
  });
  const report = await composeAutonomousResearchOneShotCampaignAttempt({
    repository,
    reservation,
    ...callbacks(counts, {
      async prepareCampaign() {
        counts.prepare += 1;
        assert.equal(counts.provider, 0);
        assert.equal(prepareEnvironment.HEPTA_AUTONOMOUS_RESEARCH_CONTENT_MODE,
          'deterministic-bounded');
        for (const key of AUTONOMOUS_RESEARCH_ONE_SHOT_FORBIDDEN_PREPARE_ENVIRONMENT_KEYS) {
          assert.equal(Object.hasOwn(prepareEnvironment, key), false);
        }
        return { evidence: { providerFree: true } };
      },
      async executeProviderAction({ inspection }) {
        counts.provider += 1;
        assert.equal(inspection.headPhase, 'provider_started');
        const durable = repository.inspectAttempt({
          attemptId: reservation.attemptId,
        });
        assert.equal(durable.headPhase, 'provider_started');
        assert.deepEqual(durable.events.at(-1).evidence, {
          action: 'provider',
          status: 'external_action_marker_committed',
        });
        return { evidence: { providerReceiptHash: H('offline-boundary-provider') } };
      },
    }),
  });
  assert.equal(report.terminalReceipt.terminalStatus, 'completed');
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
  assert.equal(first.repository.assertExternalActionMarkerCurrent({
    transition: providerTransition,
  }), true);
  assert.throws(
    () => first.repository.assertExternalActionMarkerCurrent({
      transition: { ...providerTransition },
    }),
    /campaign_one_shot_attempt_external_action_owner_invalid/,
  );
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
  assert.throws(
    () => second.repository.assertExternalActionMarkerCurrent({
      transition: staleTransition,
    }),
    /campaign_one_shot_attempt_external_action_owner_stale/,
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

test('historical journal audit rejects recomputed chains and never grants mutation', async (t) => {
  const { repository, reservation: currentReservation } = fixture(t, 'historical-audit');
  repository.reserveAttempt({ reservation: currentReservation });
  const terminal = historicalAttemptChain(56);
  const incomplete = historicalAttemptChain(55, { terminal: false });
  const legacyProviderBindingFree = historicalAttemptChain(52);
  insertHistoricalAttempt(repository.databasePath, terminal);
  insertHistoricalAttempt(repository.databasePath, incomplete);
  insertHistoricalAttempt(repository.databasePath, legacyProviderBindingFree);

  assert.throws(
    () => repository.inspectAttempt({ attemptId: terminal.reservation.attemptId }),
    /campaign_one_shot_attempt_journal_reservation_invalid/,
  );
  assert.throws(
    () => repository.reserveAttempt({ reservation: terminal.reservation }),
    /campaign_one_shot_attempt_journal_reservation_invalid/,
  );

  for (const historical of [terminal, incomplete, legacyProviderBindingFree]) {
    assert.throws(
      () => repository.inspectHistoricalAttempt({
        attemptId: historical.reservation.attemptId,
      }),
      /autonomous_research_one_shot_historical_attempt_anchor_invalid/,
    );
  }
  const legacyBinding = legacyProviderBindingFree.reservation.executionBinding;
  assert.equal(
    verifyAutonomousResearchOneShotCampaignExecutionBindingForHistoricalAudit(
      legacyBinding,
    ),
    true,
  );
  const currentProviderBinding = executionBinding();
  assert.equal(
    verifyAutonomousResearchOneShotCampaignExecutionBindingForHistoricalAudit({
      ...legacyBinding,
      providerRuntimeBinding: currentProviderBinding.providerRuntimeBinding,
      providerRuntimeBindingHash: currentProviderBinding.providerRuntimeBindingHash,
    }),
    false,
  );
  const campaign53Binding = historicalAttemptChain(53).reservation.executionBinding;
  assert.equal(
    verifyAutonomousResearchOneShotCampaignExecutionBindingForHistoricalAudit(
      Object.fromEntries(
        Object.entries(campaign53Binding).filter(([key]) => ![
          'providerRuntimeBinding',
          'providerRuntimeBindingHash',
        ].includes(key)),
      ),
    ),
    false,
  );

  const currentStatus = await composeFixedAutonomousResearchOneShotCampaignAttempt({
    action: 'status',
    workspaceRoot: '/tmp/current-audit-workspace',
    root: '/tmp/current-audit-assets',
    runtimeRoot: path.join(path.dirname(repository.controlRoot), 'native-runtime'),
    controlRoot: repository.controlRoot,
    datasetMounts: [],
    attemptId: currentReservation.attemptId,
  });
  assert.equal(currentStatus.recoveryDisposition.status, 'resume_preconditions');

  const issuedTarget = terminal.reservation.executionBinding.targetCampaignDefinition;
  assert.equal(
    verifyAutonomousResearchOneShotHistoricalTargetCampaignDefinition(issuedTarget),
    true,
  );
  for (const paperId of [
    'local-auto-20260730-51',
    'local-auto-20260730-58',
    'local-auto-20260731-56',
  ]) {
    assert.equal(verifyAutonomousResearchOneShotHistoricalTargetCampaignDefinition({
      ...issuedTarget,
      paperId,
      campaignId: `autonomous-research:${paperId}`,
    }), false);
  }
  assert.equal(
    verifyAutonomousResearchOneShotCampaignAttemptReservationForHistoricalAudit({
      ...terminal.reservation,
      autonomousResearchOneShotCampaignAttemptReservationHash: H('tampered-history'),
    }),
    false,
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

test('preexisting provider completion cannot win a replay race and authorize launch', async (t) => {
  const { repository, reservation } = fixture(t, 'preseeded-provider-completion');
  let inspection = repository.reserveAttempt({ reservation });
  inspection = appendPhase(repository, inspection, 'preconditions_verified');
  inspection = appendPhase(repository, inspection, 'prepare_verified', {
    providerFree: true,
  });
  inspection = appendPhase(repository, inspection, 'provider_started', {
    action: 'provider',
    status: 'external_action_marker_committed',
  });
  appendPhase(repository, inspection, 'provider_completed', {
    providerReceiptHash: H('preseeded-provider-receipt'),
  });
  const counts = { preconditions: 0, prepare: 0, provider: 0, launch: 0, monitor: 0 };
  await assert.rejects(
    () => composeAutonomousResearchOneShotCampaignAttempt({
      repository,
      reservation,
      ...callbacks(counts),
    }),
    /autonomous_research_one_shot_existing_provider_completion_not_launch_authority/,
  );
  assert.equal(counts.provider, 0);
  assert.equal(counts.launch, 0);
  assert.equal(
    repository.inspectAttempt({ attemptId: reservation.attemptId }).headPhase,
    'provider_completed',
  );
});

test('concurrent provider completion cannot become invocation launch authority', async (t) => {
  const { repository, reservation } = fixture(t, 'concurrent-provider-completion');
  const counts = { preconditions: 0, prepare: 0, provider: 0, launch: 0, monitor: 0 };
  const report = await composeAutonomousResearchOneShotCampaignAttempt({
    repository,
    reservation,
    ...callbacks(counts, {
      async prepareCampaign({ inspection }) {
        counts.prepare += 1;
        let concurrent = appendPhase(
          repository,
          inspection,
          'prepare_verified',
          { providerFree: true },
        );
        concurrent = appendPhase(repository, concurrent, 'provider_started', {
          action: 'provider',
          status: 'external_action_marker_committed',
        });
        appendPhase(repository, concurrent, 'provider_completed', {
          providerReceiptHash: H('concurrent-provider-receipt'),
        });
        return { evidence: { providerFree: true } };
      },
    }),
  });
  assert.equal(counts.provider, 0);
  assert.equal(counts.launch, 0);
  assert.equal(report.terminalReceipt.terminalStatus, 'blocked_post_provider');
  assert.equal(report.terminalReceipt.lastPhase, 'provider_completed');
  assert.equal(report.terminalReceipt.launchMayHaveStarted, false);
});
