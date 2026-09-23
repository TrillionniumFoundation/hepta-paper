import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createAutonomousResearchQualificationStateRepository,
} from '../../paper-adapters/automation/autonomous-research-qualification-state-repository.mjs';
import {
  AUTONOMOUS_RESEARCH_EXTERNAL_QUALIFICATION_DATABASE_INSTANCE_ID,
  AUTONOMOUS_RESEARCH_EXTERNAL_QUALIFICATION_MUTATION_PLANS,
  AUTONOMOUS_RESEARCH_EXTERNAL_QUALIFICATION_WRITER_ID,
  AUTONOMOUS_RESEARCH_EXTERNAL_QUALIFICATION_WRITER_PLAN_HASH,
  createOfflineExternalQualificationMutationCoordinator,
} from '../../paper-adapters/automation/autonomous-research-qualification-state-mutation-plan.mjs';
import {
  createAutonomousExternalQualificationState,
} from '../../paper-domain/automation/autonomous-external-qualification-state-contract.mjs';
import {
  requestExternalResearchQualification,
} from '../../paper-application/automation/external-qualification-recovery.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const PAPER_ID = 'external-qualification-online-test';
const DATABASE_INSTANCE_ID =
  AUTONOMOUS_RESEARCH_EXTERNAL_QUALIFICATION_DATABASE_INSTANCE_ID;
const H = (label) => hashRecord('ExternalQualificationOnlineMutationTest', { label });

function qualificationState(generation, attemptCount = 0) {
  return createAutonomousExternalQualificationState(Object.freeze({
    version: 4,
    kind: 'AutonomousExternalQualificationState',
    generation,
    campaignId: `autonomous-research:${PAPER_ID}`,
    paperId: PAPER_ID,
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
      totalAttemptCount: attemptCount,
      maximumTotalAttempts: 16,
      maximumTotalCostUsd: 10,
      reservedCostUsd: attemptCount * 0.05,
      attemptReservationCostUsd: 0.05,
      firstAttemptAt: '2026-07-18T00:00:00.000Z',
      nextAttemptAt: '2026-07-18T00:00:01.000Z',
      deadlineAt: '2026-07-18T01:00:00.000Z',
      globalFirstAttemptAt: '2026-07-18T00:00:00.000Z',
      globalDeadlineAt: '2026-07-19T00:00:00.000Z',
    }),
  }));
}

function coordinator({
  calls = [],
  status = 'externally_fenced_sqlite_mutation_coordinator_ready',
  blockers = [],
  failBeforeApply = false,
  sideEffectMode = 'offline',
} = {}) {
  const local = createOfflineExternalQualificationMutationCoordinator({
    databaseInstanceId: DATABASE_INSTANCE_ID,
  });
  const coveredDatabaseRoles = Object.freeze(['external-qualification']);
  return Object.freeze({
    implemented: true,
    coveredDatabaseRoles,
    executeMutation(input) {
      calls.push(Object.freeze({
        databaseRole: input.databaseRole,
        databaseInstanceId: input.databaseInstanceId,
        schemaContractId: input.schemaContractId,
        writerId: input.writerId,
        operationId: input.operationId,
        authorizationReceiptHashes: Object.freeze([...input.authorizationReceiptHashes]),
        sideEffectReservationHashes: Object.freeze([
          ...input.sideEffectReservationHashes,
        ]),
      }));
      if (failBeforeApply) throw new Error('fixture_authority_reservation_unavailable');
      const committed = local.executeMutation(input);
      if (input.sideEffectReservationHashes.length === 0 || sideEffectMode === 'offline') {
        return committed;
      }
      if (sideEffectMode === 'finalization-pending') {
        const error = new Error(
          'externally_fenced_sqlite_mutation_committed_finalization_pending',
        );
        error.committed = true;
        error.reservationId = 'reservation:external-qualification:test';
        throw error;
      }
      return Object.freeze({
        ...committed,
        kind: 'ExternallyFencedSqliteMutationReceipt',
        status: 'externally_fenced_sqlite_mutation_finalized',
        reservationId: 'reservation:external-qualification:test',
        sideEffectPermitHash: sideEffectMode === 'finalized'
          ? H('external-request-side-effect-permit') : null,
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

test('external qualification recovery owns fail-closed preflight exits', async () => {
  const authority = Object.freeze({
    campaignId: `autonomous-research:${PAPER_ID}`,
    paperId: PAPER_ID,
    campaignReleaseBundleHash: H('preflight-release'),
  });
  const completeReleaseBinding = Object.freeze({
    qualificationScope: 'full_research_generalization',
    genericContentCanaryVerified: true,
    trustedAutonomousManuscriptRenderReceiptHash: H('preflight-render-receipt'),
    evidenceBoundManuscriptIrHash: H('preflight-manuscript-ir'),
    manuscriptIrFileHash: H('preflight-manuscript-ir-file'),
    renderedManuscriptHash: H('preflight-rendered-manuscript'),
    agentExecutionReceiptHash: H('preflight-agent-execution'),
    isolatedAgentMergeReceiptHash: H('preflight-agent-merge'),
    agentAuthoredSourceDraftHash: H('preflight-agent-source-draft'),
    agentAuthoredSourceDraftFileHash: H('preflight-agent-source-draft-file'),
    agentWorkspacePostimageBindingHash: H('preflight-agent-postimage'),
    venueProfileSelectionHash: H('preflight-venue-profile'),
    submissionMetadataReceiptHash: H('preflight-submission-metadata'),
  });
  const boundAuthority = Object.freeze({
    ...authority,
    releaseBundle: Object.freeze({
      autonomousResearchReleaseBinding: completeReleaseBinding,
    }),
  });
  const preparation = Object.freeze({
    proposal: Object.freeze({ machineProposedScientificClaimSetHash: H('preflight-proposal') }),
    policyAuthorization: Object.freeze({
      autonomousResearchPolicyAuthorizationHash: H('preflight-policy'),
    }),
    seedBinding: Object.freeze({ autonomousResearchSeedBindingHash: H('preflight-seed') }),
  });
  assert.equal((await requestExternalResearchQualification({})).status,
    'qualification_release_not_ready');
  assert.equal((await requestExternalResearchQualification({
    campaignReleaseAuthority: authority,
    qualificationStateStore: Object.freeze({
      readExternalQualificationState() { throw new Error('corrupt state'); },
    }),
  })).status, 'qualification_external_state_invalid');
  assert.equal((await requestExternalResearchQualification({
    campaignReleaseAuthority: authority,
    qualificationStateStore: Object.freeze({ readExternalQualificationState: () => null }),
    allowRequest: false,
  })).status, 'qualification_pending_explicit_resume');

  for (const services of [
    Object.freeze({}),
    Object.freeze({
      externalQualificationClient: Object.freeze({
        kind: 'ExternalResearchQualificationClient',
      }),
    }),
    Object.freeze({
      externalQualificationClient: Object.freeze({
        kind: 'ExternalResearchQualificationClient',
        requestQualification() {},
      }),
      externalQualificationVerifier: Object.freeze({
        kind: 'IndependentExternalResearchQualificationVerifier',
      }),
    }),
  ]) {
    assert.equal((await requestExternalResearchQualification({
      ...services,
      campaignReleaseAuthority: authority,
      preparation,
      allowRequest: true,
    })).status, 'qualification_pending_external_service');
  }

  const shared = Object.freeze({
    configurationIdentityHash: H('preflight-configuration'),
    trustIdentityHash: H('preflight-trust'),
    maximumQualificationCostUsd: 5,
    qualificationCostAuthority: 'operator_declared_worst_case_usd',
  });
  const externalQualificationClient = Object.freeze({
    kind: 'ExternalResearchQualificationClient',
    ...shared,
    serviceIdentityHash: H('preflight-client'),
    requestQualification() {},
  });
  const externalQualificationVerifier = Object.freeze({
    kind: 'IndependentExternalResearchQualificationVerifier',
    ...shared,
    serviceIdentityHash: H('preflight-verifier'),
    verify() {},
  });
  assert.equal((await requestExternalResearchQualification({
    externalQualificationClient,
    externalQualificationVerifier,
    campaignReleaseAuthority: authority,
    preparation,
    allowRequest: true,
    qualificationStateStore: Object.freeze({}),
  })).status, 'qualification_durable_state_store_required');
  await assert.rejects(requestExternalResearchQualification({
    externalQualificationClient,
    externalQualificationVerifier,
    campaignReleaseAuthority: authority,
    preparation,
    allowRequest: true,
    qualificationStateStore: Object.freeze({
      kind: 'AutonomousResearchQualificationStateRepository',
      durable: true,
      compareAndSwap: true,
      systemOwnedRuntimeState: true,
      readExternalQualificationState: () => null,
      compareAndSwapExternalQualificationState() {},
    }),
    retry: Object.freeze({ maximumTotalCostUsd: 1 }),
  }), /autonomous_research_qualification_cost_envelope_insufficient/);

  const zeroCost = Object.freeze({
    configurationIdentityHash: H('preflight-zero-configuration'),
    trustIdentityHash: H('preflight-zero-trust'),
    maximumQualificationCostUsd: 0,
    qualificationCostAuthority: 'externally_operated_zero_cost',
  });
  let currentState = null;
  let requestedInput = null;
  const nonRecoverableStore = {
    kind: 'AutonomousResearchQualificationStateRepository',
    durable: true,
    compareAndSwap: true,
    systemOwnedRuntimeState: true,
    readExternalQualificationState: () => currentState,
    compareAndSwapExternalQualificationState({ state }) { currentState = state; },
  };
  const zeroClient = Object.freeze({
    kind: 'ExternalResearchQualificationClient',
    ...zeroCost,
    serviceIdentityHash: H('preflight-zero-client'),
    async requestQualification(input) {
      requestedInput = input;
      return Object.freeze({ kind: 'UnverifiedQualificationReceipt' });
    },
  });
  const zeroVerifier = Object.freeze({
    kind: 'IndependentExternalResearchQualificationVerifier',
    ...zeroCost,
    serviceIdentityHash: H('preflight-zero-verifier'),
    async verify() { throw new Error('independent verification unavailable'); },
  });
  const recoveryRetry = Object.freeze({
    maximumAttempts: 1,
    maximumEpochs: 1,
    maximumTotalAttempts: 1,
    clock: Object.freeze({ now: () => new Date('2026-07-20T00:00:00.000Z') }),
    scheduler: Object.freeze({ delay: async () => {} }),
  });
  const exhausted = await requestExternalResearchQualification({
    externalQualificationClient: zeroClient,
    externalQualificationVerifier: zeroVerifier,
    campaignReleaseAuthority: authority,
    preparation,
    allowRequest: true,
    qualificationStateStore: nonRecoverableStore,
    retry: recoveryRetry,
    evaluateEligibility() { throw new Error('unverified inspection must not be eligible'); },
  });
  assert.equal(exhausted.status, 'qualification_external_service_recovery_budget_exhausted');
  assert.equal(requestedInput.qualificationScope, null);
  assert.equal(requestedInput.submissionMetadataReceiptHash, null);
  assert.equal(currentState.recovery.status, 'qualification_recovery_budget_exhausted');

  const stateVariant = ({ status, receipt = null, verifiedInspection = null,
    recovery = {} }) => {
    const { autonomousExternalQualificationStateHash: _stateHash, ...statePayload } = currentState;
    return createAutonomousExternalQualificationState(Object.freeze({
      ...statePayload,
      generation: statePayload.generation + 1,
      receipt,
      verifiedInspection,
      recovery: Object.freeze({ ...statePayload.recovery, status, ...recovery }),
    }));
  };
  const invoke = (allowRequest = true) => requestExternalResearchQualification({
    externalQualificationClient: zeroClient,
    externalQualificationVerifier: zeroVerifier,
    campaignReleaseAuthority: authority,
    preparation,
    allowRequest,
    qualificationStateStore: nonRecoverableStore,
    retry: recoveryRetry,
    evaluateEligibility: () => Object.freeze({}),
  });
  assert.equal((await invoke()).status, 'qualification_external_service_recovery_cooldown');

  currentState = stateVariant({ status: 'qualification_terminal_blocked' });
  assert.equal((await invoke()).status, 'qualification_external_service_terminal_blocked');

  currentState = stateVariant({
    status: 'qualification_attempt_in_progress',
    recovery: Object.freeze({ nextAttemptAt: '2026-07-20T00:05:00.000Z' }),
  });
  assert.equal((await invoke()).status, 'qualification_external_service_attempt_in_progress');

  currentState = stateVariant({
    status: 'qualification_retry_scheduled',
    recovery: Object.freeze({ nextAttemptAt: '2026-07-20T00:00:01.000Z' }),
  });
  assert.equal((await invoke()).status, 'qualification_external_service_recovery_budget_exhausted');

  const verifiedReceipt = Object.freeze({ expiresAt: '2026-07-20T01:00:00.000Z' });
  const verifiedInspection = Object.freeze({
    kind: 'FullResearchQualificationInspection',
    ready: true,
    receiptAccepted: true,
    campaignId: authority.campaignId,
    paperId: authority.paperId,
    campaignReleaseBundleHash: authority.campaignReleaseBundleHash,
    configurationIdentityHash: currentState.recovery.configurationIdentityHash,
    trustIdentityHash: currentState.recovery.trustIdentityHash,
    clientServiceIdentityHash: currentState.recovery.clientServiceIdentityHash,
    verifierServiceIdentityHash: currentState.recovery.verifierServiceIdentityHash,
  });
  currentState = stateVariant({
    status: 'qualification_verified',
    receipt: verifiedReceipt,
    verifiedInspection,
  });
  assert.equal((await invoke(false)).status, 'qualification_cached_verified_locally');
  currentState = stateVariant({
    status: 'qualification_verified',
    receipt: Object.freeze({ expiresAt: '2026-07-19T23:59:59.000Z' }),
    verifiedInspection,
  });
  assert.equal((await invoke(false)).status,
    'qualification_cached_verification_expired_resume_required');
  assert.equal((await invoke(true)).status,
    'qualification_external_service_recovery_budget_exhausted');

  currentState = stateVariant({
    status: 'qualification_recovery_budget_exhausted',
    recovery: Object.freeze({ nextAttemptAt: '2026-07-20T00:00:00.000Z' }),
  });
  assert.equal((await invoke(true)).status,
    'qualification_external_service_recovery_budget_exhausted');

  currentState = stateVariant({
    status: 'qualification_retry_scheduled',
    recovery: Object.freeze({
      recoveryIdentityHash: H('mismatched-recovery-identity'),
      nextAttemptAt: '2026-07-20T00:00:00.000Z',
    }),
  });
  assert.equal((await invoke(true)).status,
    'qualification_external_service_recovery_budget_exhausted');

  currentState = stateVariant({
    status: 'qualification_attempt_in_progress',
    recovery: Object.freeze({ nextAttemptAt: '2026-07-20T00:00:00.000Z' }),
  });
  assert.equal((await invoke(true)).status,
    'qualification_external_service_recovery_budget_exhausted');

  for (const scenario of [
    Object.freeze({
      name: 'verified',
      inspection: Object.freeze({
        kind: 'FullResearchQualificationInspection',
        ready: true,
        receiptAccepted: true,
        campaignId: authority.campaignId,
        paperId: authority.paperId,
        campaignReleaseBundleHash: authority.campaignReleaseBundleHash,
        failureCodes: Object.freeze([]),
      }),
      eligibility: Object.freeze({ fullAutomaticResearchWritingReady: true }),
      expectedStatus: 'qualification_external_service_verified',
    }),
    Object.freeze({
      name: 'terminal',
      inspection: Object.freeze({
        kind: 'FullResearchQualificationInspection',
        ready: false,
        receiptAccepted: false,
        campaignId: authority.campaignId,
        paperId: authority.paperId,
        campaignReleaseBundleHash: authority.campaignReleaseBundleHash,
        failureCodes: Object.freeze([
          'external_qualification.receipt_signature_invalid',
        ]),
      }),
      eligibility: Object.freeze({}),
      expectedStatus: 'qualification_external_service_blocked',
    }),
  ]) {
    let scenarioState = null;
    let scenarioRequest = null;
    const scenarioStore = {
      ...nonRecoverableStore,
      readExternalQualificationState: () => scenarioState,
      compareAndSwapExternalQualificationState({ state }) { scenarioState = state; },
    };
    const scenarioReceipt = Object.freeze({
      kind: `QualificationReceipt:${scenario.name}`,
      expiresAt: '2026-07-20T01:00:00.000Z',
    });
    const result = await requestExternalResearchQualification({
      externalQualificationClient: Object.freeze({
        ...zeroClient,
        async requestQualification(input) {
          scenarioRequest = input;
          return scenarioReceipt;
        },
      }),
      externalQualificationVerifier: Object.freeze({
        ...zeroVerifier,
        async verify() { return scenario.inspection; },
      }),
      campaignReleaseAuthority: scenario.name === 'verified' ? boundAuthority : authority,
      preparation,
      allowRequest: true,
      qualificationStateStore: scenarioStore,
      retry: recoveryRetry,
      evaluateEligibility: () => scenario.eligibility,
    });
    assert.equal(result.status, scenario.expectedStatus, scenario.name);
    assert.equal(scenarioState.recovery.status,
      scenario.name === 'verified' ? 'qualification_verified'
        : 'qualification_terminal_blocked');
    if (scenario.name === 'verified') {
      for (const [field, value] of Object.entries(completeReleaseBinding)) {
        assert.equal(scenarioRequest[field], value, field);
      }
    }
  }

  for (const scenario of [
    Object.freeze({
      name: 'lease-unavailable',
      lease: null,
      expectedStatus: 'qualification_external_service_attempt_in_progress',
      expectedReleases: 0,
    }),
    Object.freeze({
      name: 'state-cas-conflict',
      casMessage: 'autonomous_research_qualification_state_fence_conflict',
      expectedStatus: 'qualification_external_service_attempt_in_progress',
      expectedReleases: 1,
    }),
    Object.freeze({
      name: 'lease-cas-conflict',
      casMessage: 'autonomous_research_qualification_attempt_lease_fence_conflict',
      expectedStatus: 'qualification_external_service_attempt_lease_lost',
      expectedReleases: 1,
    }),
    Object.freeze({
      name: 'committed-cas-failure',
      casMessage: 'fixture_committed_cas_failure',
      committed: true,
      expectedError: 'fixture_committed_cas_failure',
      expectedReleases: 0,
    }),
  ]) {
    const attemptLease = scenario.lease === null ? null : Object.freeze({
      ownerId: `qualification:${scenario.name}`,
      leaseToken: H(`lease-token:${scenario.name}`),
      leaseGeneration: 1,
    });
    let releases = 0;
    const store = {
      kind: 'AutonomousResearchQualificationStateRepository',
      durable: true,
      compareAndSwap: true,
      systemOwnedRuntimeState: true,
      recoverableAttemptLease: true,
      readExternalQualificationState: () => null,
      tryAcquireQualificationAttemptLease: () => attemptLease,
      renewQualificationAttemptLease: () => attemptLease,
      releaseQualificationAttemptLease() { releases += 1; },
      compareAndSwapExternalQualificationState() {
        if (!scenario.casMessage) {
          throw new Error('lease-unavailable must return before CAS');
        }
        const error = new Error(scenario.casMessage);
        if (scenario.committed) error.committed = true;
        throw error;
      },
    };
    const invocation = requestExternalResearchQualification({
      externalQualificationClient: zeroClient,
      externalQualificationVerifier: zeroVerifier,
      campaignReleaseAuthority: authority,
      preparation,
      allowRequest: true,
      qualificationStateStore: store,
      retry: recoveryRetry,
      evaluateEligibility() { throw new Error('CAS failure must precede eligibility'); },
    });
    if (scenario.expectedError) {
      await assert.rejects(invocation, new RegExp(scenario.expectedError));
    } else {
      assert.equal((await invocation).status, scenario.expectedStatus, scenario.name);
    }
    assert.equal(releases, scenario.expectedReleases, scenario.name);
  }

  for (const scenario of [
    Object.freeze({ name: 'progress-renew-throws', expectedClientCalls: 0 }),
    Object.freeze({ name: 'background-renew-lost', expectedClientCalls: 1 }),
  ]) {
    const attemptLease = Object.freeze({
      ownerId: `qualification:${scenario.name}`,
      leaseToken: H(`lease-token:${scenario.name}`),
      leaseGeneration: 1,
    });
    let state = null;
    let renewals = 0;
    let releases = 0;
    let clientCalls = 0;
    const requestFixture = externalRequestFixture({
      onRequest() { clientCalls += 1; },
    });
    const store = {
      kind: 'AutonomousResearchQualificationStateRepository',
      durable: true,
      compareAndSwap: true,
      systemOwnedRuntimeState: true,
      recoverableAttemptLease: true,
      readExternalQualificationState: () => state,
      compareAndSwapExternalQualificationState({ state: next }) { state = next; },
      tryAcquireQualificationAttemptLease: () => attemptLease,
      renewQualificationAttemptLease() {
        renewals += 1;
        if (scenario.name === 'progress-renew-throws') {
          throw new Error('fixture_renew_transport_failure');
        }
        return renewals === 2 ? null : attemptLease;
      },
      releaseQualificationAttemptLease() {
        releases += 1;
        throw new Error('fixture_stale_lease_release_rejected');
      },
    };
    const result = await requestExternalResearchQualification({
      ...requestFixture,
      qualificationStateStore: store,
      allowRequest: true,
      retry: Object.freeze({
        maximumAttempts: 1,
        maximumEpochs: 1,
        maximumTotalAttempts: 1,
        clock: Object.freeze({ now: () => new Date('2026-07-20T00:00:00.000Z') }),
        scheduler: Object.freeze({
          async delay() {},
          setInterval(callback) {
            callback();
            return Object.freeze({ unref() {} });
          },
          clearInterval() {},
        }),
      }),
      evaluateEligibility() { throw new Error('lost lease must precede eligibility'); },
    });
    assert.equal(result.status, 'qualification_external_service_attempt_lease_lost');
    assert.equal(clientCalls, scenario.expectedClientCalls, scenario.name);
    assert.equal(releases, 1, scenario.name);
  }

  for (const scenario of [
    Object.freeze({
      name: 'verified-persist-fence',
      inspection: Object.freeze({
        kind: 'FullResearchQualificationInspection',
        ready: true,
        receiptAccepted: true,
        campaignId: `autonomous-research:${PAPER_ID}`,
        paperId: PAPER_ID,
        campaignReleaseBundleHash: H('infrastructure-refund-release'),
        failureCodes: Object.freeze([]),
      }),
      eligibility: Object.freeze({ fullAutomaticResearchWritingReady: true }),
    }),
    Object.freeze({
      name: 'terminal-persist-fence',
      inspection: Object.freeze({
        kind: 'FullResearchQualificationInspection',
        ready: false,
        receiptAccepted: false,
        campaignId: `autonomous-research:${PAPER_ID}`,
        paperId: PAPER_ID,
        campaignReleaseBundleHash: H('infrastructure-refund-release'),
        failureCodes: Object.freeze([
          'external_qualification.receipt_signature_invalid',
        ]),
      }),
      eligibility: Object.freeze({}),
    }),
    Object.freeze({
      name: 'retry-persist-fence',
      inspection: null,
      eligibility: Object.freeze({}),
    }),
  ]) {
    const attemptLease = Object.freeze({
      ownerId: `qualification:${scenario.name}`,
      leaseToken: H(`lease-token:${scenario.name}`),
      leaseGeneration: 1,
    });
    let state = null;
    let writes = 0;
    let releases = 0;
    const requestFixture = externalRequestFixture({
      onRequest: () => Object.freeze({
        kind: 'QualificationReceipt:lease-fence',
        expiresAt: '2026-07-20T01:00:00.000Z',
      }),
      onVerify: scenario.inspection
        ? () => scenario.inspection
        : () => { throw new Error('fixture_transient_verification_failure'); },
    });
    const store = {
      kind: 'AutonomousResearchQualificationStateRepository',
      durable: true,
      compareAndSwap: true,
      systemOwnedRuntimeState: true,
      recoverableAttemptLease: true,
      readExternalQualificationState: () => state,
      tryAcquireQualificationAttemptLease: () => attemptLease,
      renewQualificationAttemptLease: () => attemptLease,
      releaseQualificationAttemptLease() { releases += 1; },
      compareAndSwapExternalQualificationState({ state: next }) {
        writes += 1;
        if (writes > 1) {
          throw new Error(
            'autonomous_research_qualification_attempt_lease_fence_conflict',
          );
        }
        state = next;
      },
    };
    const result = await requestExternalResearchQualification({
      ...requestFixture,
      qualificationStateStore: store,
      allowRequest: true,
      retry: Object.freeze({
        maximumAttempts: 1,
        maximumEpochs: 1,
        maximumTotalAttempts: 1,
        clock: Object.freeze({ now: () => new Date('2026-07-20T00:00:00.000Z') }),
        scheduler: Object.freeze({ async delay() {} }),
      }),
      evaluateEligibility: () => scenario.eligibility,
    });
    assert.equal(result.status, 'qualification_external_service_attempt_lease_lost',
      scenario.name);
    assert.equal(writes, 2, scenario.name);
    assert.equal(releases, 0, scenario.name);
  }

  for (const abortStage of [
    'qualification_recovery_after_external_request',
    'qualification_recovery_after_external_verification',
  ]) {
    let state = null;
    const signal = { aborted: false, reason: null };
    const requestFixture = externalRequestFixture({
      onVerify: () => Object.freeze({
        kind: 'FullResearchQualificationInspection',
        ready: true,
        receiptAccepted: true,
        failureCodes: Object.freeze([]),
      }),
    });
    const result = await requestExternalResearchQualification({
      ...requestFixture,
      qualificationStateStore: {
        kind: 'AutonomousResearchQualificationStateRepository',
        durable: true,
        compareAndSwap: true,
        systemOwnedRuntimeState: true,
        readExternalQualificationState: () => state,
        compareAndSwapExternalQualificationState({ state: next }) { state = next; },
      },
      allowRequest: true,
      retry: Object.freeze({
        maximumAttempts: 1,
        maximumEpochs: 1,
        maximumTotalAttempts: 1,
        signal,
        clock: Object.freeze({ now: () => new Date('2026-07-20T00:00:00.000Z') }),
        scheduler: Object.freeze({ async delay() {} }),
        onProgress({ stage }) {
          if (stage === abortStage) signal.aborted = true;
        },
      }),
      evaluateEligibility() { throw new Error('aborted attempt must not be eligible'); },
    });
    assert.equal(result.status, 'qualification_external_service_recovery_budget_exhausted',
      abortStage);
    assert.equal(state.recovery.status, 'qualification_recovery_budget_exhausted',
      abortStage);
  }

  for (const scenario of [
    Object.freeze({
      name: 'committed-marker-failure',
      markerError: 'fixture_committed_marker_failure',
      committed: true,
      expectedError: /fixture_committed_marker_failure/,
    }),
    Object.freeze({
      name: 'cancelled-marker-failure',
      markerError:
        'autonomous_research_qualification_attempt_external_action_marker_fixture',
      cancellation: Object.freeze({ cancelled: true, releasedLease: true }),
      expectedError: /attempt_external_action_marker_fixture/,
    }),
    Object.freeze({
      name: 'invalid-cancellation-result',
      markerError:
        'autonomous_research_qualification_attempt_external_action_marker_fixture',
      cancellation: Object.freeze({ cancelled: false, releasedLease: false }),
      expectedError: /infrastructure_reservation_cancel_failed/,
    }),
    Object.freeze({
      name: 'side-effect-callback-failure',
      expectedError: /side_effect_marker_failed/,
    }),
  ]) {
    let state = null;
    let cancellations = 0;
    let clientCalls = 0;
    const requestFixture = externalRequestFixture({
      onRequest() { clientCalls += 1; },
    });
    const store = {
      kind: 'AutonomousResearchQualificationStateRepository',
      durable: true,
      compareAndSwap: true,
      systemOwnedRuntimeState: true,
      recoverableInfrastructureReservation: true,
      readExternalQualificationState: () => state,
      compareAndSwapExternalQualificationState({ state: next }) { state = next; },
      markQualificationAttemptExternalActionStarted() {
        if (!scenario.markerError) {
          return Object.freeze({ sideEffectPermitHash: H('marker-side-effect-permit') });
        }
        const error = new Error(scenario.markerError);
        if (scenario.committed) error.committed = true;
        throw error;
      },
      cancelQualificationAttemptInfrastructureDeferred() {
        cancellations += 1;
        return scenario.cancellation;
      },
      reconcileStaleQualificationAttemptReservation() {
        return Object.freeze({ handled: false });
      },
    };
    await assert.rejects(() => requestExternalResearchQualification({
      ...requestFixture,
      qualificationStateStore: store,
      allowRequest: true,
      retry: Object.freeze({
        maximumAttempts: 1,
        maximumEpochs: 1,
        maximumTotalAttempts: 1,
        clock: Object.freeze({ now: () => new Date('2026-07-20T00:00:00.000Z') }),
        scheduler: Object.freeze({ async delay() {} }),
        onExternalSideEffectStarted: scenario.name === 'side-effect-callback-failure'
          ? () => { throw new Error('fixture_side_effect_callback_failure'); }
          : null,
      }),
      evaluateEligibility() { throw new Error('marker failure must precede eligibility'); },
    }), scenario.expectedError, scenario.name);
    assert.equal(clientCalls, 0, scenario.name);
    assert.equal(cancellations,
      scenario.name === 'cancelled-marker-failure'
        || scenario.name === 'invalid-cancellation-result' ? 1 : 0,
      scenario.name);
  }
});

test('external qualification strict mode rejects inactive fencing before filesystem I/O', (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-qualification-strict-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const configured = coordinator({
    status: 'externally_fenced_sqlite_mutation_coordinator_configured',
    blockers: ['autonomous_research_online_mutation_runtime_activation_required'],
  });

  assert.throws(() => createAutonomousResearchQualificationStateRepository({
    runtimeRoot,
    paperId: PAPER_ID,
    offlineProvision: false,
    mutationCoordinator: configured,
    requireExternallyFencedMutations: true,
  }), /external_mutation_coordinator_required/);
  assert.throws(() => createAutonomousResearchQualificationStateRepository({
    runtimeRoot,
    paperId: PAPER_ID,
    offlineProvision: false,
    requireExternallyFencedMutations: true,
  }), /external_mutation_coordinator_required/);
  assert.throws(() => createAutonomousResearchQualificationStateRepository({
    runtimeRoot,
    paperId: PAPER_ID,
    offlineProvision: true,
    mutationCoordinator: coordinator(),
    requireExternallyFencedMutations: true,
  }), /external_mutation_coordinator_required/);
  assert.deepEqual(fs.readdirSync(runtimeRoot), []);
});

test('external qualification eight-operation writer preserves CAS and lease semantics', (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-qualification-online-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const provisioner = createAutonomousResearchQualificationStateRepository({
    runtimeRoot,
    paperId: PAPER_ID,
  });
  provisioner.close();

  const calls = [];
  const repository = createAutonomousResearchQualificationStateRepository({
    runtimeRoot,
    paperId: PAPER_ID,
    offlineProvision: false,
    mutationCoordinator: coordinator({ calls }),
    requireExternallyFencedMutations: true,
  });
  t.after(() => repository.close());

  assert.equal(repository.offlineProvisioningPerformed, false);
  assert.equal(repository.externallyFencedMutations, true);
  assert.equal(repository.databaseInstanceId, DATABASE_INSTANCE_ID);
  assert.equal(repository.schemaContractId, 'external-qualification-schema-v1');
  assert.equal(repository.writerId, AUTONOMOUS_RESEARCH_EXTERNAL_QUALIFICATION_WRITER_ID);
  assert.equal(Object.keys(
    AUTONOMOUS_RESEARCH_EXTERNAL_QUALIFICATION_MUTATION_PLANS,
  ).length, 8);
  assert.equal(
    AUTONOMOUS_RESEARCH_EXTERNAL_QUALIFICATION_WRITER_PLAN_HASH,
    'sha256:d8ecd791324df439177b2220cdb941500f6bb15442995f861ec4720332616351',
  );

  const firstState = qualificationState(1);
  repository.compareAndSwapExternalQualificationState({ state: firstState });
  const acquired = repository.tryAcquireQualificationAttemptLease({
    ownerId: 'qualification:test',
    leaseMs: 1_000,
    now: new Date('2026-07-18T02:00:00.000Z'),
  });
  const renewed = repository.renewQualificationAttemptLease({
    ...acquired,
    leaseMs: 1_000,
    now: new Date('2026-07-18T02:00:00.500Z'),
  });
  const secondState = qualificationState(2, 1);
  repository.compareAndSwapExternalQualificationState({
    expectedStateHash: firstState.autonomousExternalQualificationStateHash,
    state: secondState,
    attemptLease: renewed,
    now: new Date('2026-07-18T02:00:00.750Z'),
  });
  assert.deepEqual(repository.reconcileStaleQualificationAttemptLease({
    now: new Date('2026-07-18T02:00:01.501Z'),
  }), {
    recoveredLeaseCount: 1,
    reconciledAt: '2026-07-18T02:00:01.501Z',
  });
  assert.equal(repository.releaseQualificationAttemptLease(renewed), false);
  assert.deepEqual(repository.readExternalQualificationState(), secondState);

  assert.deepEqual([...new Set(calls.map((call) => call.operationId))].sort(),
    Object.keys(AUTONOMOUS_RESEARCH_EXTERNAL_QUALIFICATION_MUTATION_PLANS)
      .filter((operationId) => !operationId.includes('InfrastructureDeferred')
        && !operationId.includes('ExternalActionStarted')
        && !operationId.includes('StaleQualificationAttemptReservation'))
      .sort());
  for (const call of calls) {
    assert.equal(call.databaseRole, 'external-qualification');
    assert.equal(call.databaseInstanceId, DATABASE_INSTANCE_ID);
    assert.equal(call.schemaContractId, 'external-qualification-schema-v1');
    assert.equal(call.writerId, AUTONOMOUS_RESEARCH_EXTERNAL_QUALIFICATION_WRITER_ID);
    assert.deepEqual(call.authorizationReceiptHashes, []);
    assert.deepEqual(call.sideEffectReservationHashes, []);
  }
});

test('external qualification authority failure leaves local state unchanged', (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-qualification-fail-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const provisioner = createAutonomousResearchQualificationStateRepository({
    runtimeRoot,
    paperId: PAPER_ID,
  });
  provisioner.close();
  const calls = [];
  const repository = createAutonomousResearchQualificationStateRepository({
    runtimeRoot,
    paperId: PAPER_ID,
    offlineProvision: false,
    mutationCoordinator: coordinator({ calls, failBeforeApply: true }),
    requireExternallyFencedMutations: true,
  });
  t.after(() => repository.close());

  assert.throws(() => repository.compareAndSwapExternalQualificationState({
    state: qualificationState(1),
  }), /fixture_authority_reservation_unavailable/);
  assert.equal(repository.readExternalQualificationState(), null);
  assert.equal(calls.length, 1);
  assert.throws(() => repository.tryAcquireQualificationAttemptLease({
    ownerId: 'invalid owner',
    leaseMs: 1_000,
  }), /lease_owner_invalid/);
  assert.equal(calls.length, 1);
});

test('external request intent requires its finalized epoch permit before client invocation',
  async (t) => {
  for (const sideEffectMode of ['no-permit', 'finalization-pending', 'finalized']) {
    const runtimeRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), `hepta-qualification-side-effect-${sideEffectMode}-`),
    );
    t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
    const provisioner = createAutonomousResearchQualificationStateRepository({
      runtimeRoot,
      paperId: PAPER_ID,
    });
    provisioner.close();
    const calls = [];
    const repository = createAutonomousResearchQualificationStateRepository({
      runtimeRoot,
      paperId: PAPER_ID,
      offlineProvision: false,
      mutationCoordinator: coordinator({ calls, sideEffectMode }),
      requireExternallyFencedMutations: true,
    });
    t.after(() => repository.close());
    let clientCalls = 0;
    let clientRequest = null;
    let verifierCalls = 0;
    const shared = Object.freeze({
      configurationIdentityHash: H('external-request-configuration'),
      trustIdentityHash: H('external-request-trust'),
      maximumQualificationCostUsd: 0,
      qualificationCostAuthority: 'externally_operated_zero_cost',
    });
    const externalQualificationClient = Object.freeze({
      kind: 'ExternalResearchQualificationClient',
      ...shared,
      serviceIdentityHash: H('external-request-client'),
      async requestQualification(input) {
        clientCalls += 1;
        clientRequest = input;
        throw new Error('external_client_must_not_run_without_finalized_permit');
      },
    });
    const externalQualificationVerifier = Object.freeze({
      kind: 'IndependentExternalResearchQualificationVerifier',
      ...shared,
      serviceIdentityHash: H('external-request-verifier'),
      async verify() {
        verifierCalls += 1;
        throw new Error('external_verifier_must_not_run_without_client_receipt');
      },
    });
    let failure;
    let result = null;
    try {
      result = await requestExternalResearchQualification({
        externalQualificationClient,
        externalQualificationVerifier,
        campaignReleaseAuthority: Object.freeze({
          campaignId: `autonomous-research:${PAPER_ID}`,
          paperId: PAPER_ID,
          campaignReleaseBundleHash: H('external-request-release'),
        }),
        preparation: Object.freeze({
          proposal: Object.freeze({
            machineProposedScientificClaimSetHash: H('external-request-proposal'),
          }),
          policyAuthorization: Object.freeze({
            autonomousResearchPolicyAuthorizationHash: H('external-request-policy'),
          }),
          seedBinding: Object.freeze({
            autonomousResearchSeedBindingHash: H('external-request-seed'),
          }),
        }),
        qualificationStateStore: repository,
        allowRequest: true,
        retry: Object.freeze({
          maximumAttempts: 1,
          maximumEpochs: 1,
          maximumTotalAttempts: 1,
          clock: Object.freeze({
            now: () => new Date('2026-07-18T02:00:00.000Z'),
          }),
        }),
        evaluateEligibility() {
          throw new Error('eligibility_must_not_run_without_external_verification');
        },
      });
    } catch (error) { failure = error; }
    if (sideEffectMode === 'finalized') {
      assert.equal(failure, undefined);
      assert.equal(
        result?.status,
        'qualification_external_service_recovery_budget_exhausted',
      );
      assert.equal(clientCalls, 1);
      assert.match(clientRequest?.sideEffectPermitHash,
        /^sha256:[0-9a-f]{64}$/);
    } else {
      assert.equal(failure?.committed, true, sideEffectMode);
      assert.equal(clientCalls, 0, sideEffectMode);
    }
    assert.equal(verifierCalls, 0, sideEffectMode);
    const state = repository.readExternalQualificationState();
    assert.equal(
      state?.recovery?.status,
      sideEffectMode === 'finalized'
        ? 'qualification_recovery_budget_exhausted'
        : 'qualification_attempt_in_progress',
    );
    const casCall = calls.find((call) => (
      call.operationId
        === 'external-qualification.qualification-state-repository.compareAndSwapExternalQualificationState.v1'
    ));
    const expectedIdempotencyKey = hashRecord(
      'AutonomousExternalQualificationEpochIdempotency',
      {
        recoveryIdentityHash: state.recovery.recoveryIdentityHash,
        cycle: state.recovery.cycle,
        epoch: state.recovery.epoch,
      },
    );
    assert.deepEqual(casCall?.sideEffectReservationHashes, [expectedIdempotencyKey]);
  }
});

function externalRequestFixture({ onLookup = null, onRequest = null, onVerify = null } = {}) {
  const shared = Object.freeze({
    configurationIdentityHash: H('infrastructure-refund-configuration'),
    trustIdentityHash: H('infrastructure-refund-trust'),
    maximumQualificationCostUsd: 0,
    qualificationCostAuthority: 'externally_operated_zero_cost',
  });
  return Object.freeze({
    campaignReleaseAuthority: Object.freeze({
      campaignId: `autonomous-research:${PAPER_ID}`,
      paperId: PAPER_ID,
      campaignReleaseBundleHash: H('infrastructure-refund-release'),
    }),
    preparation: Object.freeze({
      proposal: Object.freeze({
        machineProposedScientificClaimSetHash: H('infrastructure-refund-proposal'),
      }),
      policyAuthorization: Object.freeze({
        autonomousResearchPolicyAuthorizationHash: H('infrastructure-refund-policy'),
      }),
      seedBinding: Object.freeze({
        autonomousResearchSeedBindingHash: H('infrastructure-refund-seed'),
      }),
    }),
    externalQualificationClient: Object.freeze({
      kind: 'ExternalResearchQualificationClient',
      ...shared,
      serviceIdentityHash: H('infrastructure-refund-client'),
      async lookupQualification(input) {
        return onLookup?.(input) || Object.freeze({
          status: 'qualification_in_progress',
        });
      },
      async requestQualification(input) {
        return onRequest?.(input) || Object.freeze({ receipt: 'unused' });
      },
    }),
    externalQualificationVerifier: Object.freeze({
      kind: 'IndependentExternalResearchQualificationVerifier',
      ...shared,
      serviceIdentityHash: H('infrastructure-refund-verifier'),
      verifyLookup({ candidate }) { return candidate; },
      async verify(input) {
        if (onVerify) return onVerify(input);
        throw new Error('verification_must_not_run');
      },
    }),
  });
}
