import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  AUTONOMOUS_RESEARCH_ONE_SHOT_PROTECTED_CAMPAIGN_ID,
  AUTONOMOUS_RESEARCH_ONE_SHOT_TARGET_CAMPAIGN_ID,
  autonomousResearchOneShotCampaignCodeProvenanceHash,
  autonomousResearchOneShotCampaignSourceExecutionSnapshotHash,
  buildAutonomousResearchOneShotCampaignAttemptReservation,
  verifyAutonomousResearchOneShotCampaignExecutionBinding,
} from '../../paper-domain/automation/autonomous-research-one-shot-campaign-attempt.mjs';
import {
  createCampaignOneShotAttemptJournalRepository,
} from '../../paper-adapters/automation/campaign-one-shot-attempt-journal-repository.mjs';
import {
  composeAutonomousResearchOneShotCampaignAttempt,
} from '../../paper-composition/automation/autonomous-research-one-shot-campaign-attempt-composition.mjs';
import {
  composeAutonomousResearchCampaignAction,
} from '../../paper-composition/automation/autonomous-research-campaign-composition.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  executionBinding,
} from './support/autonomous-research-one-shot-campaign-attempt-fixture.mjs';

function H(label) {
  return hashRecord('AutonomousResearchOneShotCampaignAttemptTestHash', { label });
}

function fixture(t, label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `hepta-one-shot-safety-${label}-`));
  const runtimeRoot = path.join(root, 'native-runtime');
  const controlRoot = path.join(root, 'one-shot-control');
  fs.mkdirSync(runtimeRoot, { mode: 0o700 });
  const repository = createCampaignOneShotAttemptJournalRepository({
    controlRoot,
    runtimeRoot,
    create: true,
    clock: { now: () => new Date('2026-08-03T00:00:00.000Z') },
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
      return { terminalStatus: 'completed', outcome: { campaignStatus: 'completed' } };
    },
    async inspectLaunchOutcome() {
      counts.monitor += 1;
      return { terminal: false };
    },
    ...overrides,
  };
}

test('one-shot execution binding requires exact provenance and source snapshot schemas', () => {
  const binding = executionBinding();
  assert.equal(verifyAutonomousResearchOneShotCampaignExecutionBinding(binding), true);

  for (const codeProvenance of [
    { ...binding.codeProvenance, unexpected: true },
    Object.fromEntries(Object.entries(binding.codeProvenance)
      .filter(([key]) => key !== 'packageVersion')),
    { ...binding.codeProvenance, repositoryEntryCount: 0 },
  ]) {
    assert.equal(verifyAutonomousResearchOneShotCampaignExecutionBinding({
      ...binding,
      codeProvenance,
      codeProvenanceHash:
        autonomousResearchOneShotCampaignCodeProvenanceHash(codeProvenance),
    }), false);
  }

  for (const sourceExecutionSnapshot of [
    { ...binding.sourceExecutionSnapshot, unexpected: true },
    { ...binding.sourceExecutionSnapshot, version: 2 },
  ]) {
    assert.equal(verifyAutonomousResearchOneShotCampaignExecutionBinding({
      ...binding,
      sourceExecutionSnapshot,
      sourceExecutionSnapshotHash:
        autonomousResearchOneShotCampaignSourceExecutionSnapshotHash(sourceExecutionSnapshot),
    }), false);
  }
});

test('one-shot terminal receipts persist only normalized provider failure diagnostics', async (t) => {
  const safeErrorCode =
    'autonomous_research_supervisor_author_canary_model_live_canary_failed';
  const runFailure = async ({
    label,
    failureClass,
    diagnosticHash,
    rawDiagnostic,
    errorMessage = safeErrorCode,
    errorCode = null,
    expectedErrorCode = safeErrorCode,
    expectedFailureClass = 'unknown',
    expectedDiagnosticHash = null,
    additionalSensitive = [],
  }) => {
    const { repository, reservation } = fixture(t, label);
    const counts = { preconditions: 0, prepare: 0, provider: 0, launch: 0, monitor: 0 };
    const error = Object.assign(new Error(errorMessage), {
      failureClass,
      diagnosticHash,
      stderr: rawDiagnostic,
      credentialPath: '/private/provider/credential.json',
      responseText: 'provider-specific response prose',
    });
    if (errorCode !== null) error.code = errorCode;
    const report = await composeAutonomousResearchOneShotCampaignAttempt({
      repository,
      reservation,
      ...callbacks(counts, {
        async executeProviderAction() {
          counts.provider += 1;
          throw error;
        },
      }),
    });
    const serializedInspection = JSON.stringify(report.inspection);
    const databaseBytes = fs.readFileSync(repository.databasePath);
    for (const sensitive of [
      rawDiagnostic,
      'sk-live-one-shot-secret',
      '/private/provider/credential.json',
      'provider-specific response prose',
      ...additionalSensitive,
    ]) {
      assert.equal(serializedInspection.includes(sensitive), false);
      assert.equal(databaseBytes.includes(Buffer.from(sensitive)), false);
    }
    assert.equal(report.terminalReceipt.terminalStatus, 'recovered_incomplete');
    assert.equal(report.terminalReceipt.lastPhase, 'provider_started');
    const effectiveDiagnosticHash = expectedDiagnosticHash || hashRecord(
      'AutonomousResearchOneShotCampaignAttemptFailureDiagnostic',
      {
        version: 1,
        phase: 'provider_started',
        failureClass: expectedFailureClass,
        diagnosticSource: 'unclassified_failure',
      },
    );
    assert.deepEqual(report.terminalReceipt.outcome, {
      version: 1,
      kind: 'AutonomousResearchOneShotCampaignAttemptFailure',
      phase: 'provider_started',
      errorCode: expectedErrorCode,
      failureClass: expectedFailureClass,
      diagnosticHash: effectiveDiagnosticHash,
    });
    return report.terminalReceipt.outcome;
  };

  const quotaHash = H('verified-managed-quota-diagnostic');
  const quota = await runFailure({
    label: 'safe-quota-receipt',
    failureClass: 'quota',
    diagnosticHash: quotaHash,
    rawDiagnostic: 'insufficient_quota credential=sk-live-one-shot-secret',
  });
  assert.equal(quota.failureClass, 'unknown');
  assert.notEqual(quota.diagnosticHash, quotaHash);

  const reviewerErrorCode =
    'autonomous_research_supervisor_reviewer_canary_model_live_canary_failed';
  const reviewer = await runFailure({
    label: 'safe-reviewer-quota-receipt',
    failureClass: 'quota',
    diagnosticHash: H('verified-reviewer-managed-quota-diagnostic'),
    rawDiagnostic: 'reviewer quota credential=sk-live-one-shot-secret',
    errorMessage: reviewerErrorCode,
    expectedErrorCode: reviewerErrorCode,
  });
  assert.equal(reviewer.errorCode, reviewerErrorCode);

  const unknownHash = H('forged-unknown-provider-diagnostic');
  const firstUnknown = await runFailure({
    label: 'safe-unknown-receipt-a',
    failureClass: 'unknown',
    diagnosticHash: unknownHash,
    rawDiagnostic: 'opaque failure credential=sk-live-one-shot-secret variant=a',
    errorMessage: 'opaque failure credential=sk-live-one-shot-secret variant=a',
    errorCode: 'codex_sk-proj-one-shot-secret',
    expectedErrorCode: 'unknown_error',
    additionalSensitive: ['codex_sk-proj-one-shot-secret', 'sk-proj-one-shot-secret'],
  });
  let diagnosticToStringCallCount = 0;
  let errorCodeToStringCallCount = 0;
  const fallbackUnknownHash = hashRecord(
    'AutonomousResearchOneShotCampaignAttemptFailureDiagnostic',
    {
      version: 1,
      phase: 'provider_started',
      failureClass: 'unknown',
      diagnosticSource: 'unclassified_failure',
    },
  );
  const secondUnknown = await runFailure({
    label: 'safe-unknown-receipt-b',
    failureClass: 'unknown',
    diagnosticHash: {
      secret: 'sk-object-diagnostic-secret',
      toString() {
        diagnosticToStringCallCount += 1;
        return unknownHash;
      },
    },
    rawDiagnostic: 'different prose credential=sk-live-one-shot-secret variant=b',
    errorMessage: 'autonomous_research_token_sk-live-message-secret',
    errorCode: {
      secret: 'sk-object-error-code-secret',
      toString() {
        errorCodeToStringCallCount += 1;
        return safeErrorCode;
      },
    },
    expectedErrorCode: 'unknown_error',
    expectedDiagnosticHash: fallbackUnknownHash,
    additionalSensitive: [
      'sk-object-diagnostic-secret',
      'sk-object-error-code-secret',
      'autonomous_research_token_sk-live-message-secret',
      'sk-live-message-secret',
    ],
  });
  assert.equal(diagnosticToStringCallCount, 0);
  assert.equal(errorCodeToStringCallCount, 0);
  assert.equal(firstUnknown.diagnosticHash, secondUnknown.diagnosticHash);
  assert.equal(firstUnknown.diagnosticHash, quota.diagnosticHash);
  assert.equal(firstUnknown.diagnosticHash, fallbackUnknownHash);
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
  assert.equal(
    report.status,
    'autonomous_research_one_shot_campaign_attempt_monitor_only',
  );
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
