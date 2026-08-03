import { hasExactPlainObjectKeys as exactKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord, stableStringify } from '../../workflow-kernel/record-hash.mjs';
import { AUTONOMOUS_RESEARCH_ONE_SHOT_EVENT_KEYS as EVENT_KEYS,
  AUTONOMOUS_RESEARCH_ONE_SHOT_RECEIPT_KEYS as RECEIPT_KEYS,
  AUTONOMOUS_RESEARCH_ONE_SHOT_RESERVATION_KEYS as RESERVATION_KEYS }
  from './autonomous-research-one-shot-campaign-attempt-keys.data.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/;
const MAXIMUM_BINDING_BYTES = 64 * 1024;
const MAXIMUM_EVIDENCE_BYTES = 128 * 1024;
const MAXIMUM_OUTCOME_BYTES = 128 * 1024;
const SAFE_ENVIRONMENT_KEY = /^[A-Z][A-Z0-9_]{0,127}$/;
const SENSITIVE_ENVIRONMENT_KEY = /(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|COOKIE|API_KEY|AUTHORIZATION)/;
const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
export const AUTONOMOUS_RESEARCH_ONE_SHOT_PROTECTED_CAMPAIGN_ID = 'autonomous-research:local-auto-20260730-51';
export const AUTONOMOUS_RESEARCH_ONE_SHOT_TARGET_CAMPAIGN_ID = 'autonomous-research:local-auto-20260730-52';
export const AUTONOMOUS_RESEARCH_ONE_SHOT_TARGET_PAPER_ID = 'local-auto-20260730-52';
export const AUTONOMOUS_RESEARCH_ONE_SHOT_PROVIDER_CONFIGURATION_HASH = 'sha256:7fe1d221302fb8e5b1c1c7ccb33ea341311d00a994ff9b3f6dd433af82964792';
export const AUTONOMOUS_RESEARCH_ONE_SHOT_TARGET_OBJECTIVE = 'Evaluate a deterministic bounded candidate intervention under the fixed finance_asset_pricing_benchmark protocol, including treatment, control, ablation, and an isolated deterministic rerun.';
export const AUTONOMOUS_RESEARCH_ONE_SHOT_FORBIDDEN_PREPARE_ENVIRONMENT_KEYS =
  Object.freeze([
    'HEPTA_AUTONOMOUS_EXTERNAL_QUALIFICATION_CONFIG', 'HEPTA_EXTERNAL_REPLAY_CONFIG',
    'HEPTA_EXTERNAL_REPLAY_CONFIG_HASH', 'HEPTA_EXTERNAL_REPLAY_SERVICE_TOKEN_FILE',
    'HEPTA_PRIOR_ART_SERVICE_CONFIG', 'HEPTA_PRIOR_ART_SERVICE_CONFIG_HASH',
    'HEPTA_PRIOR_ART_SERVICE_TOKEN_FILE',
  ].sort());

export const AUTONOMOUS_RESEARCH_ONE_SHOT_CAMPAIGN_ATTEMPT_PHASES = Object.freeze([
  'attempt_reserved', 'preconditions_verified', 'prepare_verified', 'provider_started',
  'provider_completed', 'launch_started', 'terminal',
]);

export const AUTONOMOUS_RESEARCH_ONE_SHOT_CAMPAIGN_ATTEMPT_TERMINAL_STATUSES = Object.freeze([
    'blocked_pre_provider',
    'blocked_post_provider',
    'completed',
    'failed_terminal',
    'recovered_incomplete',
]);

const PHASE_INDEX = new Map(AUTONOMOUS_RESEARCH_ONE_SHOT_CAMPAIGN_ATTEMPT_PHASES
  .map((phase, index) => [phase, index]));
const TERMINAL_STATUSES = new Set(
  AUTONOMOUS_RESEARCH_ONE_SHOT_CAMPAIGN_ATTEMPT_TERMINAL_STATUSES,
);

function invalid(code) {
  throw new Error(code);
}

function canonicalInstant(value) {
  const milliseconds = Date.parse(String(value || ''));
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function assertJsonShape(value, code, depth = 0) {
  if (depth > 64) invalid(code);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
      invalid(code);
    }
    return;
  }
  if (!value || typeof value !== 'object') invalid(code);
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype) invalid(code);
  const descriptors = Object.entries(Object.getOwnPropertyDescriptors(value))
    .filter(([key]) => !(Array.isArray(value) && key === 'length'))
    .map(([, descriptor]) => descriptor);
  if (descriptors.some((descriptor) => (
    !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true
  ))) invalid(code);
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length) invalid(code);
    value.forEach((child) => assertJsonShape(child, code, depth + 1));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (!key || key.length > 256 || child === undefined) invalid(code);
    assertJsonShape(child, code, depth + 1);
  }
}

function canonicalSnapshot(value, { code, maximumBytes, allowNull = false }) {
  if (value === null && allowNull) return null;
  assertJsonShape(value, code);
  const source = stableStringify(value);
  if (Buffer.byteLength(source) > maximumBytes) invalid(code);
  return deepFreeze(JSON.parse(source));
}

export function autonomousResearchOneShotCampaignEnvironmentProjectionHash(projection) {
  const canonicalProjection = canonicalSnapshot(projection, {
    code: 'autonomous_research_one_shot_campaign_environment_projection_invalid',
    maximumBytes: 32 * 1024,
  });
  return hashRecord(
    'AutonomousResearchOneShotCampaignEnvironmentProjection',
    canonicalProjection,
  );
}

function executionBindingRecordHash(kind, value) {
  const canonicalValue = canonicalSnapshot(value, {
    code: 'autonomous_research_one_shot_campaign_execution_binding_record_invalid',
    maximumBytes: MAXIMUM_BINDING_BYTES,
  });
  return hashRecord(kind, canonicalValue);
}

export function autonomousResearchOneShotCampaignCodeProvenanceHash(value) {
  return executionBindingRecordHash(
    'AutonomousResearchOneShotCampaignCodeProvenance',
    value,
  );
}

export function autonomousResearchOneShotCampaignSourceExecutionSnapshotHash(value) {
  return executionBindingRecordHash(
    'AutonomousResearchOneShotCampaignSourceExecutionSnapshot',
    value,
  );
}

export function autonomousResearchOneShotProtectedCampaignFingerprintHash(value) {
  return executionBindingRecordHash(
    'AutonomousResearchOneShotProtectedCampaignFingerprint',
    value,
  );
}

export function autonomousResearchOneShotTargetCampaignDefinitionHash(value) {
  return executionBindingRecordHash(
    'AutonomousResearchOneShotTargetCampaignDefinition',
    value,
  );
}

function protectedCampaignDefinitionValid(value) {
  return exactKeys(value, [
    'activeNodeCount', 'campaignId', 'failedTerminalNodeCount', 'failureClass',
    'ledgerCount', 'logicalStateHash', 'nodeLeaseCount', 'outboxCount',
    'resourceLeaseCount', 'skippedNodeCount', 'status', 'submissionCount',
    'version', 'waiterCount',
  ].sort())
    && value.version === 1
    && value.campaignId === AUTONOMOUS_RESEARCH_ONE_SHOT_PROTECTED_CAMPAIGN_ID
    && value.status === 'failed'
    && value.failedTerminalNodeCount === 1 && value.skippedNodeCount === 65
    && value.activeNodeCount === 0 && value.nodeLeaseCount === 0
    && value.resourceLeaseCount === 0 && value.waiterCount === 0
    && value.failureClass === 'agent_usage_unknown_terminal'
    && value.submissionCount === 0 && value.outboxCount === 0
    && value.ledgerCount === 0 && SHA256.test(String(value.logicalStateHash || ''));
}

function targetCampaignDefinitionValid(value) {
  const worker = value?.worker;
  const budgets = value?.budgets;
  return exactKeys(value, [
    'budgets', 'campaignId', 'datasetMountsHash', 'effectiveLaunchMode',
    'humanSubjects', 'localOnly', 'objective', 'paperId', 'privateData',
    'protocolFamily', 'refereeCount', 'requireCampaignAbsentAtLaunch',
    'requireLaunchReady', 'requestedLaunchMode', 'revisionRounds',
    'unlimitedAggregateCost', 'unlimitedAggregateTokens', 'version', 'worker',
  ].sort())
    && value.version === 1
    && value.campaignId === AUTONOMOUS_RESEARCH_ONE_SHOT_TARGET_CAMPAIGN_ID
    && value.paperId === AUTONOMOUS_RESEARCH_ONE_SHOT_TARGET_PAPER_ID
    && value.objective === AUTONOMOUS_RESEARCH_ONE_SHOT_TARGET_OBJECTIVE
    && value.protocolFamily === 'finance_asset_pricing_benchmark'
    && value.revisionRounds === 3 && value.refereeCount === 3
    && value.requestedLaunchMode === 'local-run'
    && value.effectiveLaunchMode === 'golden-bootstrap'
    && value.localOnly === true && value.humanSubjects === false
    && value.privateData === false && value.unlimitedAggregateTokens === true
    && value.unlimitedAggregateCost === true && value.requireLaunchReady === true
    && value.requireCampaignAbsentAtLaunch === true
    && SHA256.test(String(value.datasetMountsHash || ''))
    && exactKeys(worker, [
      'agentSlots', 'concurrency', 'cpuSlots', 'gpuSlots', 'memoryMiB',
    ].sort())
    && worker.concurrency === 8 && worker.agentSlots === 4
    && worker.cpuSlots === 4 && worker.gpuSlots === 1 && worker.memoryMiB === 8192
    && exactKeys(budgets, [
      'maxAgentCalls', 'maxCostUsd', 'maxCpuJobs', 'maxGpuJobs',
      'maxMemoryMiB', 'maxTokenCount', 'maxWallTimeMs',
    ].sort())
    && budgets.maxWallTimeMs === 7_200_000 && budgets.maxAgentCalls === 201
    && budgets.maxCpuJobs === 14_400 && budgets.maxGpuJobs === 16
    && budgets.maxMemoryMiB === 8192
    && budgets.maxTokenCount === Number.MAX_SAFE_INTEGER
    && budgets.maxCostUsd === Number.MAX_SAFE_INTEGER;
}

function preparationPolicyValid(binding) {
  const policy = binding?.preparationPolicy;
  const projection = binding?.environmentProjection;
  const launchPolicy = binding?.campaignLaunchPolicy;
  const codeProvenance = binding?.codeProvenance;
  const sourceExecutionSnapshot = binding?.sourceExecutionSnapshot;
  const protectedCampaignDefinition = binding?.protectedCampaignDefinition;
  const targetCampaignDefinition = binding?.targetCampaignDefinition;
  if (!SHA256.test(String(binding?.codeProvenanceHash || ''))
    || !SHA256.test(String(binding?.sourceExecutionSnapshotHash || ''))
    || !SHA256.test(String(
      binding?.autonomousResearchProviderConfigurationHash || '',
    ))
    || binding.autonomousResearchProviderConfigurationHash
      !== AUTONOMOUS_RESEARCH_ONE_SHOT_PROVIDER_CONFIGURATION_HASH
    || !SHA256.test(String(binding?.protectedCampaignFingerprintHash || ''))
    || !SHA256.test(String(binding?.targetCampaignDefinitionHash || ''))
    || !codeProvenance || codeProvenance.version !== 2
    || !GIT_OBJECT_ID.test(String(codeProvenance.commit || ''))
    || !GIT_OBJECT_ID.test(String(codeProvenance.commitTree || ''))
    || codeProvenance.treeDirty !== false
    || !SHA256.test(String(codeProvenance.indexStateHash || ''))
    || !SHA256.test(String(codeProvenance.repositoryContentHash || ''))
    || !SHA256.test(String(codeProvenance.worktreeStateHash || ''))
    || binding.codeProvenanceHash
      !== autonomousResearchOneShotCampaignCodeProvenanceHash(codeProvenance)
    || !sourceExecutionSnapshot
    || !SHA256.test(String(sourceExecutionSnapshot.merkleHash || ''))
    || !SHA256.test(String(sourceExecutionSnapshot.manifestHash || ''))
    || binding.sourceExecutionSnapshotHash
      !== autonomousResearchOneShotCampaignSourceExecutionSnapshotHash(
        sourceExecutionSnapshot,
      )
    || !protectedCampaignDefinitionValid(protectedCampaignDefinition)
    || binding.protectedCampaignFingerprintHash
      !== autonomousResearchOneShotProtectedCampaignFingerprintHash(
        protectedCampaignDefinition,
      )
    || !targetCampaignDefinitionValid(targetCampaignDefinition)
    || binding.targetCampaignDefinitionHash
      !== autonomousResearchOneShotTargetCampaignDefinitionHash(targetCampaignDefinition)
    || !exactKeys(policy, [
    'allowedExternalActionKinds',
    'contentMode',
    'environmentProjectionHash',
    'forbiddenEnvironmentKeys',
    'mode',
    'providerFreeRequired',
    'version',
  ].sort())
    || policy.version !== 1
    || policy.mode !== 'deterministic-bounded-offline-v1'
    || policy.contentMode !== 'deterministic-bounded'
    || policy.providerFreeRequired !== true
    || !Array.isArray(policy.allowedExternalActionKinds)
    || policy.allowedExternalActionKinds.length !== 0
    || !Array.isArray(policy.forbiddenEnvironmentKeys)
    || stableStringify(policy.forbiddenEnvironmentKeys)
      !== stableStringify(AUTONOMOUS_RESEARCH_ONE_SHOT_FORBIDDEN_PREPARE_ENVIRONMENT_KEYS)
    || !SHA256.test(String(policy.environmentProjectionHash || ''))
    || !projection || typeof projection !== 'object' || Array.isArray(projection)
    || Object.getPrototypeOf(projection) !== Object.prototype
    || Object.entries(projection).some(([key, value]) => (
      !SAFE_ENVIRONMENT_KEY.test(key)
      || SENSITIVE_ENVIRONMENT_KEY.test(key)
      || typeof value !== 'string'
      || Buffer.byteLength(value) > 4096
      || AUTONOMOUS_RESEARCH_ONE_SHOT_FORBIDDEN_PREPARE_ENVIRONMENT_KEYS.includes(key)
    ))
    || projection.HEPTA_AUTONOMOUS_RESEARCH_CONTENT_MODE !== policy.contentMode
    || policy.environmentProjectionHash
      !== autonomousResearchOneShotCampaignEnvironmentProjectionHash(projection)
    || !exactKeys(launchPolicy, [
      'allowedRecoveryActions',
      'createOnly',
      'forbiddenActions',
      'version',
    ].sort())
    || launchPolicy.version !== 1
    || launchPolicy.createOnly !== true
    || stableStringify(launchPolicy.allowedRecoveryActions) !== stableStringify(['status'])
    || stableStringify(launchPolicy.forbiddenActions)
      !== stableStringify(['converge', 'resume'])) return false;
  return true;
}

export function verifyAutonomousResearchOneShotCampaignExecutionBinding(value) {
  try {
    const binding = canonicalSnapshot(value, {
      code: 'autonomous_research_one_shot_campaign_attempt_binding_invalid',
      maximumBytes: MAXIMUM_BINDING_BYTES,
    });
    return stableStringify(binding) === stableStringify(value)
      && preparationPolicyValid(binding);
  } catch { return false; }
}

function snapshotHash(kind, value) {
  return value === null ? null : hashRecord(kind, value);
}

function reservationPayload(value) {
  const {
    autonomousResearchOneShotCampaignAttemptReservationHash: claimedHash,
    ...payload
  } = value;
  return { claimedHash, payload };
}

function eventPayload(value) {
  const {
    autonomousResearchOneShotCampaignAttemptEventHash: claimedHash,
    ...payload
  } = value;
  return { claimedHash, payload };
}

function terminalReceiptPayload(value) {
  const {
    autonomousResearchOneShotCampaignAttemptTerminalReceiptHash: claimedHash,
    ...payload
  } = value;
  return { claimedHash, payload };
}

export function canonicalAutonomousResearchOneShotCampaignAttemptJson(value) {
  assertJsonShape(value, 'autonomous_research_one_shot_campaign_attempt_json_invalid');
  return stableStringify(value);
}

export function buildAutonomousResearchOneShotCampaignAttemptReservation({
  attemptId,
  idempotencyKey,
  campaignId,
  protectedCampaignId,
  executionBinding,
  reservedAt,
} = {}) {
  const binding = canonicalSnapshot(executionBinding, {
    code: 'autonomous_research_one_shot_campaign_attempt_binding_invalid',
    maximumBytes: MAXIMUM_BINDING_BYTES,
  });
  if (!SAFE_ID.test(String(attemptId || ''))
    || !SHA256.test(String(idempotencyKey || ''))
    || !SAFE_ID.test(String(campaignId || ''))
    || !SAFE_ID.test(String(protectedCampaignId || ''))
    || campaignId === protectedCampaignId
    || !canonicalInstant(reservedAt)
    || !preparationPolicyValid(binding)
    || binding.targetCampaignDefinition.campaignId !== campaignId
    || binding.protectedCampaignDefinition.campaignId !== protectedCampaignId) {
    invalid('autonomous_research_one_shot_campaign_attempt_reservation_invalid');
  }
  const payload = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchOneShotCampaignAttemptReservation',
    status: 'attempt_reserved',
    attemptId,
    idempotencyKey,
    campaignId,
    protectedCampaignId,
    executionBinding: binding,
    executionBindingHash: hashRecord(
      'AutonomousResearchOneShotCampaignExecutionBinding',
      binding,
    ),
    reservedAt,
  });
  return Object.freeze({
    ...payload,
    autonomousResearchOneShotCampaignAttemptReservationHash: hashRecord(
      'AutonomousResearchOneShotCampaignAttemptReservation',
      payload,
    ),
  });
}

export function verifyAutonomousResearchOneShotCampaignAttemptReservation(value) {
  if (!exactKeys(value, RESERVATION_KEYS)
    || value.version !== 1
    || value.kind !== 'AutonomousResearchOneShotCampaignAttemptReservation'
    || value.status !== 'attempt_reserved'
    || !SAFE_ID.test(String(value.attemptId || ''))
    || !SHA256.test(String(value.idempotencyKey || ''))
    || !SAFE_ID.test(String(value.campaignId || ''))
    || !SAFE_ID.test(String(value.protectedCampaignId || ''))
    || value.campaignId === value.protectedCampaignId
    || !canonicalInstant(value.reservedAt)
    || !SHA256.test(String(value.executionBindingHash || ''))) return false;
  let binding;
  try {
    binding = canonicalSnapshot(value.executionBinding, {
      code: 'autonomous_research_one_shot_campaign_attempt_binding_invalid',
      maximumBytes: MAXIMUM_BINDING_BYTES,
    });
  } catch { return false; }
  if (stableStringify(binding) !== stableStringify(value.executionBinding)
    || !preparationPolicyValid(binding)
    || binding.targetCampaignDefinition.campaignId !== value.campaignId
    || binding.protectedCampaignDefinition.campaignId !== value.protectedCampaignId
    || hashRecord('AutonomousResearchOneShotCampaignExecutionBinding', binding)
      !== value.executionBindingHash) return false;
  const { claimedHash, payload } = reservationPayload(value);
  return SHA256.test(String(claimedHash || ''))
    && hashRecord('AutonomousResearchOneShotCampaignAttemptReservation', payload)
      === claimedHash;
}

export function buildAutonomousResearchOneShotCampaignAttemptEvent({
  reservation,
  previousEvent = null,
  phase,
  evidence = null,
  eventId = null,
  recordedAt,
} = {}) {
  if (!verifyAutonomousResearchOneShotCampaignAttemptReservation(reservation)) {
    invalid('autonomous_research_one_shot_campaign_attempt_event_reservation_invalid');
  }
  if (!PHASE_INDEX.has(phase)) {
    invalid('autonomous_research_one_shot_campaign_attempt_event_phase_invalid');
  }
  const sequence = previousEvent === null ? 1 : previousEvent.sequence + 1;
  const previousEventHash = previousEvent === null ? null
    : previousEvent.autonomousResearchOneShotCampaignAttemptEventHash;
  if (previousEvent === null) {
    if (phase !== 'attempt_reserved') {
      invalid('autonomous_research_one_shot_campaign_attempt_event_transition_invalid');
    }
  } else if (!verifyAutonomousResearchOneShotCampaignAttemptEvent(previousEvent, {
    reservation,
  }) || previousEvent.phase === 'terminal'
    || (phase !== 'terminal'
      && PHASE_INDEX.get(phase) !== PHASE_INDEX.get(previousEvent.phase) + 1)) {
    invalid('autonomous_research_one_shot_campaign_attempt_event_transition_invalid');
  }
  const canonicalEvidence = canonicalSnapshot(evidence, {
    code: 'autonomous_research_one_shot_campaign_attempt_event_evidence_invalid',
    maximumBytes: MAXIMUM_EVIDENCE_BYTES,
    allowNull: phase !== 'attempt_reserved',
  });
  if (phase === 'attempt_reserved'
    && (stableStringify(canonicalEvidence) !== stableStringify({
      reservationHash:
        reservation.autonomousResearchOneShotCampaignAttemptReservationHash,
    }))) {
    invalid('autonomous_research_one_shot_campaign_attempt_event_evidence_invalid');
  }
  const effectiveEventId = eventId || hashRecord(
    'AutonomousResearchOneShotCampaignAttemptEventId',
    {
      attemptId: reservation.attemptId,
      phase,
      reservationHash:
        reservation.autonomousResearchOneShotCampaignAttemptReservationHash,
      sequence,
    },
  );
  if (!SHA256.test(String(effectiveEventId || '')) || !canonicalInstant(recordedAt)
    || (previousEvent && Date.parse(recordedAt) < Date.parse(previousEvent.recordedAt))) {
    invalid('autonomous_research_one_shot_campaign_attempt_event_invalid');
  }
  const payload = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchOneShotCampaignAttemptEvent',
    attemptId: reservation.attemptId,
    idempotencyKey: reservation.idempotencyKey,
    campaignId: reservation.campaignId,
    reservationHash:
      reservation.autonomousResearchOneShotCampaignAttemptReservationHash,
    sequence,
    eventId: effectiveEventId,
    phase,
    previousEventHash,
    evidence: canonicalEvidence,
    evidenceHash: snapshotHash(
      'AutonomousResearchOneShotCampaignAttemptEventEvidence',
      canonicalEvidence,
    ),
    recordedAt,
  });
  return Object.freeze({
    ...payload,
    autonomousResearchOneShotCampaignAttemptEventHash: hashRecord(
      'AutonomousResearchOneShotCampaignAttemptEvent',
      payload,
    ),
  });
}

export function verifyAutonomousResearchOneShotCampaignAttemptEvent(value, {
  reservation = null,
  previousEvent = undefined,
} = {}) {
  if (!exactKeys(value, EVENT_KEYS)
    || value.version !== 1
    || value.kind !== 'AutonomousResearchOneShotCampaignAttemptEvent'
    || !SAFE_ID.test(String(value.attemptId || ''))
    || !SHA256.test(String(value.idempotencyKey || ''))
    || !SAFE_ID.test(String(value.campaignId || ''))
    || !SHA256.test(String(value.reservationHash || ''))
    || !Number.isSafeInteger(value.sequence) || value.sequence < 1
    || !SHA256.test(String(value.eventId || ''))
    || !PHASE_INDEX.has(value.phase)
    || (value.previousEventHash !== null
      && !SHA256.test(String(value.previousEventHash || '')))
    || (value.evidenceHash !== null && !SHA256.test(String(value.evidenceHash || '')))
    || !canonicalInstant(value.recordedAt)) return false;
  let evidence;
  try {
    evidence = canonicalSnapshot(value.evidence, {
      code: 'autonomous_research_one_shot_campaign_attempt_event_evidence_invalid',
      maximumBytes: MAXIMUM_EVIDENCE_BYTES,
      allowNull: value.phase !== 'attempt_reserved',
    });
  } catch { return false; }
  if (stableStringify(evidence) !== stableStringify(value.evidence)
    || snapshotHash('AutonomousResearchOneShotCampaignAttemptEventEvidence', evidence)
      !== value.evidenceHash) return false;
  if (reservation && (!verifyAutonomousResearchOneShotCampaignAttemptReservation(reservation)
    || value.attemptId !== reservation.attemptId
    || value.idempotencyKey !== reservation.idempotencyKey
    || value.campaignId !== reservation.campaignId
    || value.reservationHash
      !== reservation.autonomousResearchOneShotCampaignAttemptReservationHash)) return false;
  if (previousEvent !== undefined) {
    if (previousEvent === null) {
      if (value.sequence !== 1 || value.phase !== 'attempt_reserved'
        || value.previousEventHash !== null
        || !reservation
        || stableStringify(value.evidence) !== stableStringify({
          reservationHash:
            reservation.autonomousResearchOneShotCampaignAttemptReservationHash,
        })) return false;
    } else if (!verifyAutonomousResearchOneShotCampaignAttemptEvent(previousEvent, {
      reservation,
    }) || value.sequence !== previousEvent.sequence + 1
      || value.previousEventHash
        !== previousEvent.autonomousResearchOneShotCampaignAttemptEventHash
      || Date.parse(value.recordedAt) < Date.parse(previousEvent.recordedAt)
      || previousEvent.phase === 'terminal'
      || (value.phase !== 'terminal'
        && PHASE_INDEX.get(value.phase) !== PHASE_INDEX.get(previousEvent.phase) + 1)) {
      return false;
    }
  }
  const { claimedHash, payload } = eventPayload(value);
  return SHA256.test(String(claimedHash || ''))
    && hashRecord('AutonomousResearchOneShotCampaignAttemptEvent', payload) === claimedHash;
}

export function verifyAutonomousResearchOneShotCampaignAttemptEventSequence({
  reservation,
  events,
} = {}) {
  if (!verifyAutonomousResearchOneShotCampaignAttemptReservation(reservation)
    || !Array.isArray(events) || events.length < 1
    || events.length > AUTONOMOUS_RESEARCH_ONE_SHOT_CAMPAIGN_ATTEMPT_PHASES.length) {
    return false;
  }
  let previous = null;
  for (const event of events) {
    if (!verifyAutonomousResearchOneShotCampaignAttemptEvent(event, {
      reservation,
      previousEvent: previous,
    })) return false;
    previous = event;
  }
  return true;
}

export function buildAutonomousResearchOneShotCampaignAttemptTerminalReceipt({
  reservation,
  lastEvent,
  terminalStatus,
  outcome = null,
  completedAt,
} = {}) {
  if (!verifyAutonomousResearchOneShotCampaignAttemptReservation(reservation)
    || !verifyAutonomousResearchOneShotCampaignAttemptEvent(lastEvent, { reservation })
    || lastEvent.phase === 'terminal'
    || !TERMINAL_STATUSES.has(terminalStatus)
    || !canonicalInstant(completedAt)
    || Date.parse(completedAt) < Date.parse(lastEvent.recordedAt)) {
    invalid('autonomous_research_one_shot_campaign_attempt_terminal_receipt_invalid');
  }
  const lastPhaseIndex = PHASE_INDEX.get(lastEvent.phase);
  if ((lastEvent.phase === 'provider_started' && terminalStatus !== 'recovered_incomplete')
    || (terminalStatus === 'recovered_incomplete'
      && !['provider_started', 'launch_started'].includes(lastEvent.phase))
    || (terminalStatus === 'blocked_pre_provider'
      && lastPhaseIndex >= PHASE_INDEX.get('provider_started'))
    || (terminalStatus === 'blocked_post_provider'
      && lastEvent.phase !== 'provider_completed')
    || (['completed', 'failed_terminal'].includes(terminalStatus)
      && lastEvent.phase !== 'launch_started')) {
    invalid('autonomous_research_one_shot_campaign_attempt_terminal_status_invalid');
  }
  const canonicalOutcome = canonicalSnapshot(outcome, {
    code: 'autonomous_research_one_shot_campaign_attempt_terminal_outcome_invalid',
    maximumBytes: MAXIMUM_OUTCOME_BYTES,
    allowNull: true,
  });
  const payload = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchOneShotCampaignAttemptTerminalReceipt',
    status: 'autonomous_research_one_shot_campaign_attempt_terminal',
    attemptId: reservation.attemptId,
    idempotencyKey: reservation.idempotencyKey,
    campaignId: reservation.campaignId,
    reservationHash:
      reservation.autonomousResearchOneShotCampaignAttemptReservationHash,
    terminalStatus,
    lastPhase: lastEvent.phase,
    lastEventHash:
      lastEvent.autonomousResearchOneShotCampaignAttemptEventHash,
    outcome: canonicalOutcome,
    outcomeHash: snapshotHash(
      'AutonomousResearchOneShotCampaignAttemptTerminalOutcome',
      canonicalOutcome,
    ),
    providerMayHaveStarted: lastPhaseIndex >= PHASE_INDEX.get('provider_started'),
    providerCompleted: lastPhaseIndex >= PHASE_INDEX.get('provider_completed'),
    launchMayHaveStarted: lastPhaseIndex >= PHASE_INDEX.get('launch_started'),
    completedAt,
  });
  return Object.freeze({
    ...payload,
    autonomousResearchOneShotCampaignAttemptTerminalReceiptHash: hashRecord(
      'AutonomousResearchOneShotCampaignAttemptTerminalReceipt',
      payload,
    ),
  });
}

export function verifyAutonomousResearchOneShotCampaignAttemptTerminalReceipt(value, {
  reservation = null,
  lastEvent = null,
} = {}) {
  if (!exactKeys(value, RECEIPT_KEYS)
    || value.version !== 1
    || value.kind !== 'AutonomousResearchOneShotCampaignAttemptTerminalReceipt'
    || value.status !== 'autonomous_research_one_shot_campaign_attempt_terminal'
    || !SAFE_ID.test(String(value.attemptId || ''))
    || !SHA256.test(String(value.idempotencyKey || ''))
    || !SAFE_ID.test(String(value.campaignId || ''))
    || !SHA256.test(String(value.reservationHash || ''))
    || !TERMINAL_STATUSES.has(value.terminalStatus)
    || !PHASE_INDEX.has(value.lastPhase) || value.lastPhase === 'terminal'
    || !SHA256.test(String(value.lastEventHash || ''))
    || (value.outcomeHash !== null && !SHA256.test(String(value.outcomeHash || '')))
    || typeof value.providerMayHaveStarted !== 'boolean'
    || typeof value.providerCompleted !== 'boolean'
    || typeof value.launchMayHaveStarted !== 'boolean'
    || !canonicalInstant(value.completedAt)) return false;
  let outcome;
  try {
    outcome = canonicalSnapshot(value.outcome, {
      code: 'autonomous_research_one_shot_campaign_attempt_terminal_outcome_invalid',
      maximumBytes: MAXIMUM_OUTCOME_BYTES,
      allowNull: true,
    });
  } catch { return false; }
  if (stableStringify(outcome) !== stableStringify(value.outcome)
    || snapshotHash('AutonomousResearchOneShotCampaignAttemptTerminalOutcome', outcome)
      !== value.outcomeHash) return false;
  if (reservation && (!verifyAutonomousResearchOneShotCampaignAttemptReservation(reservation)
    || value.attemptId !== reservation.attemptId
    || value.idempotencyKey !== reservation.idempotencyKey
    || value.campaignId !== reservation.campaignId
    || value.reservationHash
      !== reservation.autonomousResearchOneShotCampaignAttemptReservationHash)) return false;
  if (lastEvent && (!verifyAutonomousResearchOneShotCampaignAttemptEvent(lastEvent, {
    reservation,
  }) || value.lastPhase !== lastEvent.phase
    || value.lastEventHash
      !== lastEvent.autonomousResearchOneShotCampaignAttemptEventHash
    || Date.parse(value.completedAt) < Date.parse(lastEvent.recordedAt))) return false;
  const phaseIndex = PHASE_INDEX.get(value.lastPhase);
  if (value.providerMayHaveStarted !== (phaseIndex >= PHASE_INDEX.get('provider_started'))
    || value.providerCompleted !== (phaseIndex >= PHASE_INDEX.get('provider_completed'))
    || value.launchMayHaveStarted !== (phaseIndex >= PHASE_INDEX.get('launch_started'))
    || (value.lastPhase === 'provider_started'
      && value.terminalStatus !== 'recovered_incomplete')
    || (value.terminalStatus === 'recovered_incomplete'
      && !['provider_started', 'launch_started'].includes(value.lastPhase))
    || (value.terminalStatus === 'blocked_pre_provider'
      && phaseIndex >= PHASE_INDEX.get('provider_started'))
    || (value.terminalStatus === 'blocked_post_provider'
      && value.lastPhase !== 'provider_completed')
    || (['completed', 'failed_terminal'].includes(value.terminalStatus)
      && value.lastPhase !== 'launch_started')) return false;
  const { claimedHash, payload } = terminalReceiptPayload(value);
  return SHA256.test(String(claimedHash || ''))
    && hashRecord('AutonomousResearchOneShotCampaignAttemptTerminalReceipt', payload)
      === claimedHash;
}

export function deriveAutonomousResearchOneShotCampaignAttemptRecoveryDisposition({
  reservation,
  events,
  terminalReceipt = null,
} = {}) {
  if (!verifyAutonomousResearchOneShotCampaignAttemptEventSequence({ reservation, events })) {
    invalid('autonomous_research_one_shot_campaign_attempt_sequence_invalid');
  }
  const head = events.at(-1);
  if (head.phase !== 'terminal' && terminalReceipt !== null) {
    invalid('autonomous_research_one_shot_campaign_attempt_terminal_chain_invalid');
  }
  if (head.phase === 'terminal') {
    const previous = events.at(-2);
    if (!previous || !verifyAutonomousResearchOneShotCampaignAttemptTerminalReceipt(
      terminalReceipt,
      { reservation, lastEvent: previous },
    ) || head.evidence?.terminalReceiptHash
      !== terminalReceipt.autonomousResearchOneShotCampaignAttemptTerminalReceiptHash) {
      invalid('autonomous_research_one_shot_campaign_attempt_terminal_chain_invalid');
    }
    return Object.freeze({
      status: 'terminal_replay',
      headPhase: head.phase,
      mayAppendProviderStarted: false,
      mayAppendLaunchStarted: false,
      monitorOnly: false,
      terminalReceipt,
    });
  }
  const dispositionByPhase = Object.freeze({
    attempt_reserved: ['resume_preconditions', false, false, false],
    preconditions_verified: ['resume_prepare', false, false, false],
    prepare_verified: ['provider_marker_append_permitted', true, false, false],
    provider_started: ['provider_outcome_unknown_no_replay', false, false, false],
    provider_completed: ['launch_marker_append_permitted', false, true, false],
    launch_started: ['launch_outcome_unknown_monitor_only', false, false, true],
  });
  const [status, mayAppendProviderStarted, mayAppendLaunchStarted, monitorOnly] =
    dispositionByPhase[head.phase];
  return Object.freeze({
    status,
    headPhase: head.phase,
    mayAppendProviderStarted,
    mayAppendLaunchStarted,
    monitorOnly,
    terminalReceipt: null,
  });
}
