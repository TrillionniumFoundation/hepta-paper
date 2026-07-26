import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  produceConfiguredFormalDomainQualificationExternalEvidence,
} from '../../paper-composition/automation/formal-domain-qualification-external-evidence-composition.mjs';
import {
  formalDomainQualificationRecoveryIdempotencyKey,
  formalDomainQualificationRecoveryOperationId,
  openFormalDomainQualificationRecoveryJournal,
} from '../../paper-adapters/automation/formal-domain-qualification-recovery-journal.mjs';
import {
  appendFormalDomainQualificationRecoveryEntry,
  readFormalDomainQualificationRecoverySequence,
} from '../../paper-adapters/automation/formal-domain-qualification-recovery-append-only-repository.mjs';
import {
  resolveFormalDomainQualificationEvidence,
} from '../../paper-composition/automation/generic-domain-capability-evidence-convergence.mjs';
import {
  REQUIRED_GENERIC_FORMAL_DOMAIN_PROFILE_IDS,
} from '../../paper-domain/research/formal-domain-profile-registry.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const H = (label) => hashRecord(
  'FormalDomainQualificationCrashRecoveryTest',
  { label },
);

function temporaryRoot(t) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hepta-formal-recovery-'),
  );
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function coverageReceipt() {
  const profileEvidence = REQUIRED_GENERIC_FORMAL_DOMAIN_PROFILE_IDS.map(
    (profileId) => Object.freeze({
      profileId,
      formalProofSearchOperationReceiptHash: H(`proof:${profileId}`),
      replayExecutionReceiptHash: H(`replay:${profileId}`),
    }),
  );
  return Object.freeze({
    formalDomainCoverageReceiptHash: H('coverage'),
    profileEvidence: Object.freeze(profileEvidence),
  });
}

function externalReplayReceipt(expiresAt = null) {
  return Object.freeze({
    version: 3,
    kind: 'ExternalResearchReplayReceipt',
    cryptographicAuthorityReady: true,
    identityIndependenceReady: true,
    externalResearchReplayReceiptHash: H('external-replay'),
    ...(expiresAt ? {
      resultAuthorityEnvelope: Object.freeze({ expiresAt }),
    } : {}),
  });
}

function unsignedReviewerReceipt() {
  return Object.freeze({
    version: 1,
    kind: 'UnsignedFormalDomainReviewerReceipt',
    unsignedFormalDomainReviewerReceiptHash: H('unsigned-reviewer'),
  });
}

function signedReviewerAgentReceipt(
  coverage,
  replayReceipt,
  expiresAt = null,
) {
  const structuredOutput = Object.freeze({
    version: 1,
    kind: 'FormalDomainQualificationIndependentReview',
    status: 'approved',
    summary: 'All exact formal-domain obligations were independently reviewed.',
    blockers: Object.freeze([]),
    formalDomainCoverageReceiptHash:
      coverage.formalDomainCoverageReceiptHash,
    externalReplayReceiptHash:
      replayReceipt.externalResearchReplayReceiptHash,
    reviewedProfileIds: REQUIRED_GENERIC_FORMAL_DOMAIN_PROFILE_IDS,
    reviewedProfileEvidenceHashes: Object.freeze(
      [...coverage.profileEvidence]
        .sort((left, right) => left.profileId.localeCompare(right.profileId))
        .map((item) => item.formalProofSearchOperationReceiptHash),
    ),
  });
  const signedReviewerReceipt = Object.freeze({
    version: 2,
    cryptographicAuthorityReady: true,
    identityIndependenceReady: true,
    signedReviewerReceiptHash: H('signed-reviewer'),
    ...(expiresAt ? {
      authorityEnvelope: Object.freeze({ expiresAt }),
    } : {}),
  });
  const payload = {
    version: 1,
    kind: 'AgentExecutionReceipt',
    status: 'agent_execution_completed',
    structuredOutput,
    reviewerCryptographicAuthorityReady: true,
    reviewerIdentityIndependenceReady: true,
    unsignedAgentExecutionReceiptHash: H('unsigned-agent'),
    reviewPrincipalId: 'formal-reviewer-1',
    reviewPrincipalDescriptorHash: H('reviewer-descriptor'),
    reviewerSignerIdentityHash: H('reviewer-signer'),
    researchPrincipalPoolHash: H('reviewer-pool'),
    reviewerTrustSetHash: H('reviewer-trust'),
    reviewerSignatureVerificationPolicyHash: H('reviewer-policy'),
    signedReviewerReceipt,
    signedReviewerReceiptHash:
      signedReviewerReceipt.signedReviewerReceiptHash,
  };
  return Object.freeze({
    ...payload,
    agentExecutionReceiptHash: hashRecord('AgentExecutionReceipt', payload),
  });
}

function recoverableOperationPort({ kind, configurationIdentityHash, receipt }) {
  const remote = new Map();
  const counts = {
    lookup: 0,
    resume: 0,
    action: 0,
    lookupSignals: [],
    resumeSignals: [],
    actionSignals: [],
  };
  const port = {
    version: 1,
    kind,
    crashRecoveryReady: true,
    configurationIdentityHash,
    recoveryOutcomeCryptographicAuthorityReady: true,
    recoveryOutcomeVerificationPolicyHash:
      H(`${kind}:recovery-outcome-policy`),
    counts,
    verifyReceipt: ({ receipt: candidate }) => (
      JSON.stringify(candidate) === JSON.stringify(receipt)
    ),
    async lookup({ idempotencyKey, signal }) {
      counts.lookup += 1;
      counts.lookupSignals.push(signal);
      return remote.has(idempotencyKey)
        ? { status: 'completed', receipt: remote.get(idempotencyKey) }
        : { status: 'not_found', receipt: null };
    },
    async resume({ idempotencyKey, signal }) {
      counts.resume += 1;
      counts.resumeSignals.push(signal);
      if (!remote.has(idempotencyKey)) remote.set(idempotencyKey, receipt);
      return { status: 'completed', receipt: remote.get(idempotencyKey) };
    },
    async execute({ idempotencyKey, signal }) {
      counts.action += 1;
      counts.actionSignals.push(signal);
      remote.set(idempotencyKey, receipt);
      return receipt;
    },
  };
  return Object.freeze(port);
}

function recoveryFixture({ evidenceExpiresAt = null } = {}) {
  const coverage = coverageReceipt();
  const replayReceipt = externalReplayReceipt(evidenceExpiresAt);
  const finalReviewerReceipt =
    signedReviewerAgentReceipt(
      coverage,
      replayReceipt,
      evidenceExpiresAt,
    );
  const reviewerRecoveryPort = recoverableOperationPort({
    kind: 'FormalDomainQualificationReviewerRecoveryPort',
    configurationIdentityHash: H('reviewer-recovery-configuration'),
    receipt: unsignedReviewerReceipt(),
  });
  const signerRecoveryPort = recoverableOperationPort({
    kind: 'FormalDomainQualificationSignerRecoveryPort',
    configurationIdentityHash: H('signer-recovery-configuration'),
    receipt: finalReviewerReceipt,
  });
  const replayRemote = new Map();
  const replayCounts = {
    lookup: 0,
    resume: 0,
    action: 0,
    lookupSignals: [],
    resumeSignals: [],
    actionSignals: [],
  };
  const receiptVerifier = Object.freeze({
    kind: 'ExternalResearchReplayReceiptVerifier',
    verify: ({ receipt }) => (
      JSON.stringify(receipt) === JSON.stringify(replayReceipt)
    ),
  });
  const externalResearchReplay = Object.freeze({
    version: 1,
    kind: 'ExternalResearchReplayPort',
    configurationHash: H('external-replay-configuration'),
    recoveryConfigurationIdentityHash:
      H('external-replay-recovery-configuration'),
    crashRecoveryReady: true,
    recoveryOutcomeCryptographicAuthorityReady: true,
    recoveryOutcomeVerificationPolicyHash:
      H('external-replay-recovery-outcome-policy'),
    cryptographicAuthorityReady: true,
    identityIndependenceReady: true,
    trustSetHash: H('external-replay-trust'),
    signatureVerificationPolicyHash: H('external-replay-policy'),
    receiptVerifier,
    verifyReceipt: ({ receipt }) => (
      JSON.stringify(receipt) === JSON.stringify(replayReceipt)
    ),
    async lookup({ idempotencyKey, signal }) {
      replayCounts.lookup += 1;
      replayCounts.lookupSignals.push(signal);
      return replayRemote.has(idempotencyKey)
        ? { status: 'completed', receipt: replayRemote.get(idempotencyKey) }
        : { status: 'not_found', receipt: null };
    },
    async resume({ idempotencyKey, signal }) {
      replayCounts.resume += 1;
      replayCounts.resumeSignals.push(signal);
      if (!replayRemote.has(idempotencyKey)) {
        replayRemote.set(idempotencyKey, replayReceipt);
      }
      return {
        status: 'completed',
        receipt: replayRemote.get(idempotencyKey),
      };
    },
    async replay({ idempotencyKey, signal }) {
      replayCounts.action += 1;
      replayCounts.actionSignals.push(signal);
      replayRemote.set(idempotencyKey, replayReceipt);
      return replayReceipt;
    },
  });
  const reviewerExecutorPool = Object.freeze({
    version: 2,
    cryptographicAuthorityReady: true,
    identityIndependenceReady: true,
    trustSetHash: H('reviewer-trust'),
    signatureVerificationPolicyHash: H('reviewer-policy'),
    pool: Object.freeze({
      researchPrincipalPoolHash: H('reviewer-pool'),
    }),
    verifySignedReviewerReceipt: () => true,
    reviewerRecoveryPort,
    signerRecoveryPort,
  });
  return {
    coverage,
    externalResearchReplay,
    reviewerExecutorPool,
    replayCounts,
    reviewerCounts: reviewerRecoveryPort.counts,
    signerCounts: signerRecoveryPort.counts,
  };
}

test('recovery journal rejects out-of-order stages and forged idempotency lineage', (t) => {
  const runtimeRoot = temporaryRoot(t);
  const operationId = formalDomainQualificationRecoveryOperationId({
    lineageId: H('journal-sequence-lineage'),
    generation: 1,
  });
  const journal = openFormalDomainQualificationRecoveryJournal({
    runtimeRoot,
    operationId,
  });
  try {
    assert.throws(() => journal.append({
      stage: 'reviewer',
      event: 'stage_started',
      idempotencyKey: formalDomainQualificationRecoveryIdempotencyKey({
        operationId,
        stage: 'reviewer',
      }),
    }), /formal_domain_qualification_recovery_journal_sequence_invalid/);
    assert.throws(() => journal.append({
      stage: 'external-replay',
      event: 'stage_started',
      idempotencyKey: H('forged-external-replay-idempotency-key'),
    }), /formal_domain_qualification_recovery_journal_sequence_invalid/);
    assert.throws(() => journal.append({
      stage: 'evidence',
      event: 'evidence_completed',
      idempotencyKey: operationId,
      result: {
        formalDomainQualificationExternalEvidenceHash: H('evidence'),
      },
    }), /formal_domain_qualification_recovery_journal_sequence_invalid/);
    assert.deepEqual(journal.entries(), []);
  } finally {
    journal.close();
  }
});

test('append-only recovery storage rejects clobber and noncanonical JSON', (t) => {
  const runtimeRoot = temporaryRoot(t);
  const collisionDirectory = path.join(runtimeRoot, 'append-collision');
  fs.mkdirSync(collisionDirectory, { mode: 0o700 });
  const entry = Object.freeze({ sequence: 1, value: 'stable' });
  const entryHash = H('append-collision-entry');
  const targetName =
    `00000001-${entryHash.slice('sha256:'.length)}.json`;
  const targetPath = path.join(collisionDirectory, targetName);
  fs.writeFileSync(targetPath, 'SENTINEL\n', { mode: 0o600 });
  assert.throws(() => appendFormalDomainQualificationRecoveryEntry({
    containerPath: collisionDirectory,
    entry,
    entryHash: () => entryHash,
    invalidCode: 'test_append_invalid',
  }), (error) => error?.code === 'EEXIST');
  assert.equal(fs.readFileSync(targetPath, 'utf8'), 'SENTINEL\n');
  assert.deepEqual(fs.readdirSync(collisionDirectory), [targetName]);

  for (const [label, source] of [
    ['duplicate-key', '{"sequence":1,"value":1,"value":2}\n'],
    ['noncanonical-whitespace', '{"sequence":1, "value":2}\n'],
  ]) {
    const directory = path.join(runtimeRoot, label);
    fs.mkdirSync(directory, { mode: 0o700 });
    const parsedHash = H(`${label}:entry`);
    fs.writeFileSync(
      path.join(
        directory,
        `00000001-${parsedHash.slice('sha256:'.length)}.json`,
      ),
      source,
      { mode: 0o600 },
    );
    assert.throws(() => readFormalDomainQualificationRecoverySequence({
      containerPath: directory,
      identity: label,
      maximumBytes: 1024,
      invalidCode: 'test_append_invalid',
      driftCode: 'test_append_drifted',
      verifyEntry: (candidate) => candidate,
      entryHash: () => parsedHash,
    }), /test_append_invalid/);
  }

  const crashDirectory = path.join(runtimeRoot, 'link-publish-crash');
  fs.mkdirSync(crashDirectory, { mode: 0o700 });
  const crashEntry = Object.freeze({ sequence: 1, value: 'crash-safe' });
  const crashEntryHash = H('link-publish-crash-entry');
  const crashTarget = path.join(
    crashDirectory,
    `00000001-${crashEntryHash.slice('sha256:'.length)}.json`,
  );
  const crashTemporary = path.join(
    crashDirectory,
    '.00000001-00000000-0000-4000-8000-000000000000.tmp',
  );
  fs.writeFileSync(
    crashTemporary,
    `${JSON.stringify(crashEntry)}\n`,
    { mode: 0o600 },
  );
  fs.linkSync(crashTemporary, crashTarget);
  const recovered = readFormalDomainQualificationRecoverySequence({
    containerPath: crashDirectory,
    identity: 'link-publish-crash',
    maximumBytes: 1024,
    invalidCode: 'test_append_invalid',
    driftCode: 'test_append_drifted',
    verifyEntry: (candidate) => candidate,
    entryHash: () => crashEntryHash,
  });
  assert.deepEqual(recovered, [crashEntry]);
  assert.deepEqual(
    fs.readdirSync(crashDirectory),
    [path.basename(crashTarget)],
  );
});

test('append-only recovery reads reject symlinks, hardlinks, and path swaps', (t) => {
  const runtimeRoot = temporaryRoot(t);
  const source = '{"sequence":1,"value":"stable"}\n';
  const entryHash = H('pinned-read-entry');
  const targetName =
    `00000001-${entryHash.slice('sha256:'.length)}.json`;
  const read = (directory) => (
    readFormalDomainQualificationRecoverySequence({
      containerPath: directory,
      identity: 'pinned-read',
      maximumBytes: 1024,
      invalidCode: 'test_pinned_read_invalid',
      driftCode: 'test_pinned_read_drifted',
      verifyEntry: (candidate) => candidate,
      entryHash: () => entryHash,
    })
  );

  const outside = path.join(runtimeRoot, 'outside.json');
  fs.writeFileSync(outside, source, { mode: 0o600 });
  const symlinkDirectory = path.join(runtimeRoot, 'symlink');
  fs.mkdirSync(symlinkDirectory, { mode: 0o700 });
  fs.symlinkSync(outside, path.join(symlinkDirectory, targetName));
  assert.throws(() => read(symlinkDirectory), /test_pinned_read_invalid/);

  const hardlinkDirectory = path.join(runtimeRoot, 'hardlink');
  fs.mkdirSync(hardlinkDirectory, { mode: 0o700 });
  fs.linkSync(outside, path.join(hardlinkDirectory, targetName));
  assert.throws(() => read(hardlinkDirectory), /test_pinned_read_invalid/);

  const swapDirectory = path.join(runtimeRoot, 'path-swap');
  fs.mkdirSync(swapDirectory, { mode: 0o700 });
  const swapTarget = path.join(swapDirectory, targetName);
  fs.writeFileSync(swapTarget, source, { mode: 0o600 });
  const originalReadSync = fs.readSync;
  let swapped = false;
  fs.readSync = (...arguments_) => {
    const count = originalReadSync(...arguments_);
    if (!swapped) {
      swapped = true;
      const displaced = `${swapTarget}.displaced`;
      fs.renameSync(swapTarget, displaced);
      fs.writeFileSync(swapTarget, source, { mode: 0o600 });
      fs.unlinkSync(displaced);
    }
    return count;
  };
  try {
    assert.throws(() => read(swapDirectory), /test_pinned_read_drifted/);
  } finally {
    fs.readSync = originalReadSync;
  }
  assert.equal(swapped, true);
});

test('recovery lock fsyncs its private staging directory before publish', (t) => {
  if (process.platform !== 'linux' || !fs.existsSync('/proc/self/fd')) {
    t.skip('descriptor path observation requires Linux procfs');
    return;
  }
  const runtimeRoot = temporaryRoot(t);
  const originalFsyncSync = fs.fsyncSync;
  const fsyncedLockStagingDirectories = [];
  fs.fsyncSync = (descriptor) => {
    try {
      const descriptorPath = fs.readlinkSync(`/proc/self/fd/${descriptor}`);
      if (descriptorPath.endsWith('.lock.tmp')
        && fs.fstatSync(descriptor).isDirectory()) {
        fsyncedLockStagingDirectories.push(descriptorPath);
      }
    } catch { /* descriptor observation is test-only */ }
    return originalFsyncSync(descriptor);
  };
  let journal;
  try {
    journal = openFormalDomainQualificationRecoveryJournal({
      runtimeRoot,
      operationId: formalDomainQualificationRecoveryOperationId({
        lineageId: H('lock-staging-fsync-lineage'),
        generation: 1,
      }),
    });
  } finally {
    fs.fsyncSync = originalFsyncSync;
    journal?.close();
  }
  assert.equal(fsyncedLockStagingDirectories.length, 1);
});

test('recovery lock owner reads reject a same-bytes path swap', (t) => {
  if (process.platform !== 'linux' || !fs.existsSync('/proc/self/fd')) {
    t.skip('descriptor path observation requires Linux procfs');
    return;
  }
  const runtimeRoot = temporaryRoot(t);
  const operationId = formalDomainQualificationRecoveryOperationId({
    lineageId: H('lock-owner-path-swap-lineage'),
    generation: 1,
  });
  const journal = openFormalDomainQualificationRecoveryJournal({
    runtimeRoot,
    operationId,
  });
  const journalRoot = path.join(
    runtimeRoot,
    'formal-domain-qualification-recovery-journals',
  );
  const lockDirectory = fs.readdirSync(journalRoot)
    .find((name) => name.endsWith('.lock'));
  const lockPath = path.join(journalRoot, lockDirectory);
  const ownerName = fs.readdirSync(lockPath)[0];
  const ownerPath = path.join(lockPath, ownerName);
  const ownerSource = fs.readFileSync(ownerPath, 'utf8');
  const originalReadSync = fs.readSync;
  let swapped = false;
  fs.readSync = (...arguments_) => {
    const count = originalReadSync(...arguments_);
    let descriptorPath = null;
    try {
      descriptorPath =
        fs.readlinkSync(`/proc/self/fd/${arguments_[0]}`);
    } catch { /* non-Linux descriptor observation remains null */ }
    if (!swapped && descriptorPath === ownerPath) {
      swapped = true;
      const displaced = `${ownerPath}.displaced`;
      fs.renameSync(ownerPath, displaced);
      fs.writeFileSync(ownerPath, ownerSource, { mode: 0o600 });
      fs.unlinkSync(displaced);
    }
    return count;
  };
  try {
    assert.throws(() => openFormalDomainQualificationRecoveryJournal({
      runtimeRoot,
      operationId,
    }), /formal_domain_qualification_recovery_lock_invalid/);
  } finally {
    fs.readSync = originalReadSync;
    journal.close();
  }
  assert.equal(swapped, true);
});

for (const crashedStage of ['external-replay', 'reviewer', 'signer']) {
  test(`recovery looks up ${crashedStage} after remote success and never repeats the action`, async (t) => {
    const runtimeRoot = temporaryRoot(t);
    const fixture = recoveryFixture();
    let injected = false;
    await assert.rejects(() => (
      produceConfiguredFormalDomainQualificationExternalEvidence({
        coverageReceipt: fixture.coverage,
        root: runtimeRoot,
        runtimeRoot,
        environment: {},
        externalResearchReplay: fixture.externalResearchReplay,
        reviewerExecutorPool: fixture.reviewerExecutorPool,
        faultInjector({ point, stage }) {
          if (!injected
            && point === 'after_remote_success_before_journal_append'
            && stage === crashedStage) {
            injected = true;
            throw new Error(`injected_crash_after_${stage}`);
          }
        },
      })
    ), new RegExp(`injected_crash_after_${crashedStage}`));
    const before = {
      replay: fixture.replayCounts.action,
      reviewer: fixture.reviewerCounts.action,
      signer: fixture.signerCounts.action,
    };
    const evidence =
      await produceConfiguredFormalDomainQualificationExternalEvidence({
        coverageReceipt: fixture.coverage,
        root: runtimeRoot,
        runtimeRoot,
        environment: {},
        externalResearchReplay: fixture.externalResearchReplay,
        reviewerExecutorPool: fixture.reviewerExecutorPool,
      });
    assert.match(
      evidence.formalDomainQualificationExternalEvidenceHash,
      /^sha256:[0-9a-f]{64}$/,
    );
    assert.equal(
      crashedStage === 'external-replay'
        ? fixture.replayCounts.action
        : crashedStage === 'reviewer'
          ? fixture.reviewerCounts.action
          : fixture.signerCounts.action,
      before[crashedStage === 'external-replay' ? 'replay' : crashedStage],
    );
    assert.ok(
      crashedStage === 'external-replay'
        ? fixture.replayCounts.lookup >= 2
        : crashedStage === 'reviewer'
          ? fixture.reviewerCounts.lookup >= 2
          : fixture.signerCounts.lookup >= 2,
    );
    const journalRoot = path.join(
      runtimeRoot,
      'formal-domain-qualification-recovery-journals',
    );
    const journalDirectories = fs.readdirSync(journalRoot)
      .filter((name) => name.endsWith('.journal'));
    assert.equal(journalDirectories.length, 1);
    assert.ok(fs.readdirSync(
      path.join(journalRoot, journalDirectories[0]),
    ).length >= 7);
  });
}

test('a rejected action gate leaves no started intent and the next attempt executes fresh', async (t) => {
  const runtimeRoot = temporaryRoot(t);
  const fixture = recoveryFixture();
  let rejectAction = true;
  const gate = async ({ action }) => {
    if (rejectAction
      && action === 'formal_domain_qualification_external-replay') {
      throw new Error('injected_external_replay_gate_rejection');
    }
  };
  gate.assertCurrent = () => {};
  gate.markStarted = async () => {};
  await assert.rejects(() => (
    produceConfiguredFormalDomainQualificationExternalEvidence({
      coverageReceipt: fixture.coverage,
      root: runtimeRoot,
      runtimeRoot,
      environment: {},
      externalResearchReplay: fixture.externalResearchReplay,
      reviewerExecutorPool: fixture.reviewerExecutorPool,
      assertExternalSideEffectReady: gate,
    })
  ), /injected_external_replay_gate_rejection/);
  assert.equal(fixture.replayCounts.lookup, 1);
  assert.equal(fixture.replayCounts.action, 0);
  assert.equal(fixture.replayCounts.resume, 0);
  const journalRoot = path.join(
    runtimeRoot,
    'formal-domain-qualification-recovery-journals',
  );
  assert.equal(
    fs.readdirSync(journalRoot)
      .filter((name) => name.endsWith('.journal')).length,
    0,
  );

  rejectAction = false;
  await produceConfiguredFormalDomainQualificationExternalEvidence({
    coverageReceipt: fixture.coverage,
    root: runtimeRoot,
    runtimeRoot,
    environment: {},
    externalResearchReplay: fixture.externalResearchReplay,
    reviewerExecutorPool: fixture.reviewerExecutorPool,
    assertExternalSideEffectReady: gate,
  });
  assert.equal(fixture.replayCounts.lookup, 2);
  assert.equal(fixture.replayCounts.action, 1);
  assert.equal(fixture.replayCounts.resume, 0);
});

test('a stale attempt is rejected before any recovery network lookup', async (t) => {
  const runtimeRoot = temporaryRoot(t);
  const fixture = recoveryFixture();
  const gate = async () => {};
  gate.assertCurrent = () => {
    throw new Error('injected_stale_qualification_attempt');
  };
  await assert.rejects(() => (
    produceConfiguredFormalDomainQualificationExternalEvidence({
      coverageReceipt: fixture.coverage,
      root: runtimeRoot,
      runtimeRoot,
      environment: {},
      externalResearchReplay: fixture.externalResearchReplay,
      reviewerExecutorPool: fixture.reviewerExecutorPool,
      assertExternalSideEffectReady: gate,
    })
  ), /injected_stale_qualification_attempt/);
  assert.equal(fixture.replayCounts.lookup, 0);
  assert.equal(fixture.replayCounts.action, 0);
  assert.equal(fixture.reviewerCounts.lookup, 0);
  assert.equal(fixture.signerCounts.lookup, 0);
  assert.equal(fs.existsSync(path.join(
    runtimeRoot,
    'formal-domain-qualification-recovery-journals',
  )), false);
});

test('a pre-aborted execution signal performs zero recovery network calls', async (t) => {
  const runtimeRoot = temporaryRoot(t);
  const fixture = recoveryFixture();
  const controller = new AbortController();
  controller.abort(new Error('injected_qualification_abort'));
  await assert.rejects(() => (
    produceConfiguredFormalDomainQualificationExternalEvidence({
      coverageReceipt: fixture.coverage,
      root: runtimeRoot,
      runtimeRoot,
      environment: {},
      externalResearchReplay: fixture.externalResearchReplay,
      reviewerExecutorPool: fixture.reviewerExecutorPool,
      executionSignal: controller.signal,
    })
  ), /injected_qualification_abort/);
  assert.equal(fixture.replayCounts.lookup, 0);
  assert.equal(fixture.replayCounts.action, 0);
  assert.equal(fixture.reviewerCounts.lookup, 0);
  assert.equal(fixture.signerCounts.lookup, 0);
  assert.equal(fs.existsSync(path.join(
    runtimeRoot,
    'formal-domain-qualification-recovery-journals',
  )), false);
});

test('lookup, resume, and fresh actions receive the same execution signal', async (t) => {
  const runtimeRoot = temporaryRoot(t);
  const fixture = recoveryFixture();
  const controller = new AbortController();
  const baseReviewerPort =
    fixture.reviewerExecutorPool.reviewerRecoveryPort;
  const reviewerRecoveryPort = Object.freeze({
    ...baseReviewerPort,
    async lookup(input) {
      baseReviewerPort.counts.lookup += 1;
      baseReviewerPort.counts.lookupSignals.push(input.signal);
      return { status: 'in_progress', receipt: null };
    },
  });
  const reviewerExecutorPool = Object.freeze({
    ...fixture.reviewerExecutorPool,
    reviewerRecoveryPort,
  });
  await produceConfiguredFormalDomainQualificationExternalEvidence({
    coverageReceipt: fixture.coverage,
    root: runtimeRoot,
    runtimeRoot,
    environment: {},
    externalResearchReplay: fixture.externalResearchReplay,
    reviewerExecutorPool,
    executionSignal: controller.signal,
  });
  assert.equal(fixture.reviewerCounts.action, 0);
  assert.equal(fixture.reviewerCounts.resume, 1);
  for (const signals of [
    fixture.replayCounts.lookupSignals,
    fixture.replayCounts.actionSignals,
    fixture.reviewerCounts.lookupSignals,
    fixture.reviewerCounts.resumeSignals,
    fixture.signerCounts.lookupSignals,
    fixture.signerCounts.actionSignals,
  ]) {
    assert.ok(signals.length > 0);
    assert.ok(signals.every((signal) => signal === controller.signal));
  }
});

test('expired external evidence selects a durable superseding generation for unchanged coverage', async (t) => {
  const runtimeRoot = temporaryRoot(t);
  const fixture = recoveryFixture();
  const producerArguments = {
    root: runtimeRoot,
    runtimeRoot,
    environment: {},
    externalResearchReplay: fixture.externalResearchReplay,
    reviewerExecutorPool: fixture.reviewerExecutorPool,
  };
  const expiredEvidence =
    await produceConfiguredFormalDomainQualificationExternalEvidence({
      ...producerArguments,
      coverageReceipt: fixture.coverage,
    });
  assert.equal(fixture.replayCounts.action, 1);
  assert.equal(fixture.reviewerCounts.action, 1);
  assert.equal(fixture.signerCounts.action, 1);

  const resolved = await resolveFormalDomainQualificationEvidence({
    existingCoverageReceipt: fixture.coverage,
    existingExternalEvidence: expiredEvidence,
    coverageReceiptCurrent: true,
    qualificationRunner: async () => {
      throw new Error('qualification_renewal_not_expected');
    },
    externalEvidenceProducer: async (input) => (
      produceConfiguredFormalDomainQualificationExternalEvidence({
        ...producerArguments,
        ...input,
      })
    ),
    verifyExternalEvidence: (candidate) => (
      candidate !== expiredEvidence
      && Boolean(candidate?.formalDomainQualificationExternalEvidenceHash)
    ),
  });
  assert.equal(resolved.qualificationPerformed, false);
  assert.equal(resolved.externalQualificationPerformed, true);
  assert.equal(resolved.externalQualificationCrashSafe, true);
  assert.equal(fixture.replayCounts.action, 2);
  assert.equal(fixture.reviewerCounts.action, 2);
  assert.equal(fixture.signerCounts.action, 2);

  const journalRoot = path.join(
    runtimeRoot,
    'formal-domain-qualification-recovery-journals',
  );
  const operationJournals = fs.readdirSync(journalRoot)
    .filter((name) => name.endsWith('.journal'));
  assert.equal(operationJournals.length, 2);
  const generationsRoot = path.join(journalRoot, 'generations');
  const generationLedgers = fs.readdirSync(generationsRoot)
    .filter((name) => name.endsWith('.generations'));
  assert.equal(generationLedgers.length, 1);
  const generationEntries = fs.readdirSync(
    path.join(generationsRoot, generationLedgers[0]),
  ).sort().map((name) => JSON.parse(fs.readFileSync(
    path.join(generationsRoot, generationLedgers[0], name),
    'utf8',
  )));
  const selections = generationEntries.filter(
    (entry) => entry.event === 'generation_selected',
  );
  assert.equal(selections.length, 2);
  assert.equal(selections[0].generation, 1);
  assert.equal(selections[1].generation, 2);
  assert.notEqual(selections[1].operationId, selections[0].operationId);
  assert.equal(
    selections[1].supersedesOperationId,
    selections[0].operationId,
  );
  assert.equal(
    selections[1].supersededExternalEvidenceHash,
    expiredEvidence.formalDomainQualificationExternalEvidenceHash,
  );
});

test('missing evidence does not revive a completed generation after its signed validity expires', async (t) => {
  const runtimeRoot = temporaryRoot(t);
  const evidenceExpiresAt = '2026-07-24T01:00:00.000Z';
  const fixture = recoveryFixture({ evidenceExpiresAt });
  const producerArguments = {
    coverageReceipt: fixture.coverage,
    root: runtimeRoot,
    runtimeRoot,
    environment: {},
    externalResearchReplay: fixture.externalResearchReplay,
    reviewerExecutorPool: fixture.reviewerExecutorPool,
  };
  await produceConfiguredFormalDomainQualificationExternalEvidence({
    ...producerArguments,
    clock: { now: () => new Date('2026-07-24T00:30:00.000Z') },
  });
  assert.equal(fixture.replayCounts.action, 1);

  await produceConfiguredFormalDomainQualificationExternalEvidence({
    ...producerArguments,
    clock: { now: () => new Date('2026-07-24T01:30:00.000Z') },
  });
  assert.equal(fixture.replayCounts.action, 2);
  assert.equal(fixture.reviewerCounts.action, 2);
  assert.equal(fixture.signerCounts.action, 2);
  const journalRoot = path.join(
    runtimeRoot,
    'formal-domain-qualification-recovery-journals',
  );
  assert.equal(
    fs.readdirSync(journalRoot)
      .filter((name) => name.endsWith('.journal')).length,
    2,
  );
});

for (const missingStage of ['external-replay', 'reviewer', 'signer']) {
  test(`convergence fails before replay when ${missingStage} lacks verifiable recovery`, async (t) => {
    const runtimeRoot = temporaryRoot(t);
    const fixture = recoveryFixture();
    const externalResearchReplay = missingStage === 'external-replay'
      ? Object.freeze({
        ...fixture.externalResearchReplay,
        crashRecoveryReady: false,
      }) : fixture.externalResearchReplay;
    const reviewerExecutorPool = missingStage === 'reviewer'
      ? Object.freeze({
        ...fixture.reviewerExecutorPool,
        reviewerRecoveryPort: Object.freeze({
          ...fixture.reviewerExecutorPool.reviewerRecoveryPort,
          recoveryOutcomeCryptographicAuthorityReady: false,
        }),
      }) : missingStage === 'signer'
        ? Object.freeze({
          ...fixture.reviewerExecutorPool,
          signerRecoveryPort: Object.freeze({
            ...fixture.reviewerExecutorPool.signerRecoveryPort,
            recoveryOutcomeCryptographicAuthorityReady: false,
          }),
        }) : fixture.reviewerExecutorPool;
    await assert.rejects(() => (
      produceConfiguredFormalDomainQualificationExternalEvidence({
        coverageReceipt: fixture.coverage,
        root: runtimeRoot,
        runtimeRoot,
        environment: {},
        externalResearchReplay,
        reviewerExecutorPool,
      })
    ), new RegExp(`${missingStage.replace('-', '_')}.*lookup_resume_required`));
    assert.equal(fixture.replayCounts.action, 0);
    assert.equal(fixture.reviewerCounts.action, 0);
    assert.equal(fixture.signerCounts.action, 0);
  });
}
