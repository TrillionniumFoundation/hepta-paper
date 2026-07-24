import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { hasExactPlainObjectKeys as exactKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import {
  AUTONOMOUS_RESEARCH_POLICY_PROFILE,
} from './autonomous-research-policy-contract.mjs';
import {
  buildAutonomousResearchMachineIntake,
  verifyAutonomousResearchMachineIntake,
} from './autonomous-research-machine-intake-contract.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,47}$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const MINIMUM_INTERVAL_MS = 60 * 60 * 1000;
const MAXIMUM_INTERVAL_MS = DAY_MS;
const MAXIMUM_CAPABILITY_VALIDITY_MS = 15 * 60 * 1000;
const IMPLEMENTATION_ID = 'hepta-registered-bounded-topic-producer-v1';
const PROFILE_KEYS = Object.freeze([
  'budgets', 'canonicalResearchTopicHash', 'datasetMounts', 'kind', 'objective',
  'profileId', 'protocolFamily', 'refereeCount', 'replicationPolicy',
  'researchProfileHash', 'revisionRounds', 'version',
].sort());
const PRODUCER_KEYS = Object.freeze([
  'capabilityValidityMs', 'implementationId', 'implementationSha256', 'kind',
  'maximumProviderCanaryAttemptsPerUtcDay', 'maximumProviderCanaryCostUsdPerUtcDay',
  'maximumTopicsPerUtcDay', 'minimumGenerationIntervalMs', 'policyId',
  'policyProfileHash', 'producerId', 'producerProfileHash', 'providerConfigurationHash',
  'registeredResearchProfiles', 'version',
].sort());
const CANARY_PAIR_KEYS = Object.freeze([
  'autonomousResearchProviderConfigurationHash', 'externalActionPerformed',
  'externalActionScope', 'formalReviewerCapabilityReceiptHash',
  'formalReviewerProviderCanaryReceipt', 'formalReviewerProviderCanaryReceiptHash',
  'freshnessIntervalMs', 'kind', 'observedAt', 'providerCanaryPairReceiptHash',
  'researchAuthorCapabilityReceiptHash', 'researchAuthorProviderCanaryReceipt',
  'researchAuthorProviderCanaryReceiptHash', 'status', 'verified', 'version',
].sort());
const CAPABILITY_KEYS = Object.freeze([
  'admissionCreatedAt', 'autonomousResearchMachineIntakeHash',
  'autonomousResearchProviderConfigurationHash',
  'autonomousResearchTopicProducerCapabilityReceiptHash', 'budgetEpochStart',
  'budgetReservationId',
  'canProduce', 'canonicalResearchTopicHash', 'capabilityNonce', 'expiresAt',
  'generationSequence', 'implementationId',
  'implementationSha256', 'issuedAt', 'kind', 'machineIntakeConfigurationHash',
  'plannedGenerationHash', 'policyProfileHash', 'producerId', 'producerLeaseGeneration',
  'producerLeaseTokenHash', 'producerTopicId', 'residentLeaseGeneration',
  'residentLeaseTokenHash',
  'producerProfileHash', 'providerCanaryPairReceipt', 'providerCanaryPairReceiptHash',
  'registeredResearchProfileId', 'researchProfileHash', 'safety', 'status',
  'topicFingerprint', 'version',
].sort());

export const AUTONOMOUS_RESEARCH_TOPIC_PRODUCER_LIMITS = Object.freeze({
  maximumRegisteredResearchProfiles: 16,
  maximumTopicsPerUtcDay: 24,
  maximumProviderCanaryAttemptsPerUtcDay: 48,
  maximumProviderCanaryCostUsdPerUtcDay: 100,
});

function canonicalInstant(value, code) {
  const parsed = Date.parse(String(value || ''));
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) throw new Error(code);
  return value;
}

function canonicalId(value, code) {
  const selected = String(value || '');
  if (!SAFE_ID.test(selected)) throw new Error(code);
  return selected;
}

function profilePayload(value) {
  const profileId = canonicalId(
    value?.profileId,
    'autonomous_research_topic_producer_research_profile_id_invalid',
  );
  const objective = String(value?.objective || '').trim();
  if (!objective || objective.length > 6000) {
    throw new Error('autonomous_research_topic_producer_objective_invalid');
  }
  const probe = buildAutonomousResearchMachineIntake({
    intakeId: `intake:producer-probe:${profileId}`,
    paperId: `producer-probe:${profileId}`,
    campaignId: `autonomous-research:producer-probe:${profileId}`,
    launchMode: 'production-run',
    objective,
    protocolFamily: value?.protocolFamily,
    datasetMounts: value?.datasetMounts,
    budgets: value?.budgets,
    providerConfigurationHash: value?.providerConfigurationHash
      || `sha256:${'0'.repeat(64)}`,
    revisionRounds: value?.revisionRounds,
    refereeCount: value?.refereeCount,
    admissionCreatedAt: '2026-01-01T00:00:00.000Z',
  });
  return Object.freeze({
    version: 1,
    kind: 'AutonomousResearchRegisteredTopicProfile',
    profileId,
    objective: probe.objective,
    protocolFamily: probe.protocolFamily,
    datasetMounts: probe.datasetMounts,
    budgets: probe.budgets,
    revisionRounds: probe.revisionRounds,
    refereeCount: probe.refereeCount,
    replicationPolicy: 'bounded-independent-epoch-replication-v1',
    canonicalResearchTopicHash: hashRecord('AutonomousResearchCanonicalTopic', {
      objective: probe.objective,
      protocolFamily: probe.protocolFamily,
      datasetMounts: probe.datasetMounts,
    }),
  });
}

function canonicalRegisteredProfile(value) {
  const payload = profilePayload(value);
  return Object.freeze({
    ...payload,
    researchProfileHash: hashRecord('AutonomousResearchRegisteredTopicProfile', payload),
  });
}

function canaryReceiptValid(receipt, expectedHash, nowMs) {
  const observedAt = Date.parse(String(receipt?.observedAt || ''));
  const expiresAt = Date.parse(String(receipt?.expiresAt || ''));
  const { codexModelAvailabilityCanaryReceiptHash: claimedHash, ...payload } = receipt || {};
  return receipt?.version === 1
    && receipt?.kind === 'CodexModelAvailabilityCanaryReceipt'
    && receipt?.status === 'codex_model_live_canary_verified'
    && receipt?.selectedModelExecutionCanaryVerified === true
    && receipt?.externalActionPerformed === true
    && receipt?.externalActionScope === 'single_read_only_ephemeral_model_canary'
    && claimedHash === expectedHash && SHA256.test(String(claimedHash || ''))
    && hashRecord('CodexModelAvailabilityCanaryReceipt', payload) === claimedHash
    && Number.isFinite(observedAt) && Number.isFinite(expiresAt)
    && expiresAt - observedAt === MAXIMUM_CAPABILITY_VALIDITY_MS
    && nowMs >= observedAt && nowMs < expiresAt;
}

export function verifyAutonomousResearchProviderCanaryPairReceipt(receipt, {
  expectedProviderConfigurationHash,
  now,
} = {}) {
  const observedAt = Date.parse(String(receipt?.observedAt || ''));
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now || ''));
  const { providerCanaryPairReceiptHash: claimedHash, ...payload } = receipt || {};
  return exactKeys(receipt, CANARY_PAIR_KEYS)
    && receipt.version === 1
    && receipt.kind === 'AutonomousResearchProviderCanaryPairReceipt'
    && receipt.status === 'autonomous_research_provider_canary_pair_verified'
    && receipt.verified === true
    && receipt.externalActionPerformed === true
    && receipt.externalActionScope === 'two_read_only_ephemeral_model_canaries'
    && receipt.freshnessIntervalMs === MAXIMUM_CAPABILITY_VALIDITY_MS
    && receipt.autonomousResearchProviderConfigurationHash
      === expectedProviderConfigurationHash
    && SHA256.test(String(receipt.researchAuthorCapabilityReceiptHash || ''))
    && SHA256.test(String(receipt.formalReviewerCapabilityReceiptHash || ''))
    && Number.isFinite(observedAt) && Number.isFinite(nowMs)
    && canaryReceiptValid(
      receipt.researchAuthorProviderCanaryReceipt,
      receipt.researchAuthorProviderCanaryReceiptHash,
      nowMs,
    )
    && canaryReceiptValid(
      receipt.formalReviewerProviderCanaryReceipt,
      receipt.formalReviewerProviderCanaryReceiptHash,
      nowMs,
    )
    && receipt.researchAuthorProviderCanaryReceipt.observedAt <= receipt.observedAt
    && receipt.formalReviewerProviderCanaryReceipt.observedAt <= receipt.observedAt
    && receipt.researchAuthorProviderCanaryReceipt.credentialRootIdentityHash
      !== receipt.formalReviewerProviderCanaryReceipt.credentialRootIdentityHash
    && receipt.researchAuthorProviderCanaryReceipt.credentialConfigIdentityHash
      !== receipt.formalReviewerProviderCanaryReceipt.credentialConfigIdentityHash
    && SHA256.test(String(claimedHash || ''))
    && hashRecord('AutonomousResearchProviderCanaryPairReceipt', payload) === claimedHash;
}

export function buildAutonomousResearchTopicProducerProfile({
  producerId,
  implementationSha256,
  providerConfigurationHash,
  registeredResearchProfiles,
  minimumGenerationIntervalMs = 60 * 60 * 1000,
  maximumTopicsPerUtcDay = 24,
  maximumProviderCanaryAttemptsPerUtcDay = 24,
  maximumProviderCanaryCostUsdPerUtcDay = 50,
  capabilityValidityMs = MAXIMUM_CAPABILITY_VALIDITY_MS,
} = {}) {
  if (!SHA256.test(String(implementationSha256 || ''))
    || !SHA256.test(String(providerConfigurationHash || ''))
    || !Array.isArray(registeredResearchProfiles) || !registeredResearchProfiles.length
    || registeredResearchProfiles.length
      > AUTONOMOUS_RESEARCH_TOPIC_PRODUCER_LIMITS.maximumRegisteredResearchProfiles
    || !Number.isSafeInteger(minimumGenerationIntervalMs)
    || minimumGenerationIntervalMs < MINIMUM_INTERVAL_MS
    || minimumGenerationIntervalMs > MAXIMUM_INTERVAL_MS
    || DAY_MS % minimumGenerationIntervalMs !== 0
    || !Number.isSafeInteger(maximumTopicsPerUtcDay) || maximumTopicsPerUtcDay < 1
    || maximumTopicsPerUtcDay
      > Math.min(DAY_MS / minimumGenerationIntervalMs,
        AUTONOMOUS_RESEARCH_TOPIC_PRODUCER_LIMITS.maximumTopicsPerUtcDay)
    || !Number.isSafeInteger(maximumProviderCanaryAttemptsPerUtcDay)
    || maximumProviderCanaryAttemptsPerUtcDay < maximumTopicsPerUtcDay
    || maximumProviderCanaryAttemptsPerUtcDay
      > AUTONOMOUS_RESEARCH_TOPIC_PRODUCER_LIMITS.maximumProviderCanaryAttemptsPerUtcDay
    || typeof maximumProviderCanaryCostUsdPerUtcDay !== 'number'
    || !Number.isFinite(maximumProviderCanaryCostUsdPerUtcDay)
    || maximumProviderCanaryCostUsdPerUtcDay <= 0
    || maximumProviderCanaryCostUsdPerUtcDay
      > AUTONOMOUS_RESEARCH_TOPIC_PRODUCER_LIMITS.maximumProviderCanaryCostUsdPerUtcDay
    || !Number.isSafeInteger(capabilityValidityMs) || capabilityValidityMs < 60_000
    || capabilityValidityMs > MAXIMUM_CAPABILITY_VALIDITY_MS) {
    throw new Error('autonomous_research_topic_producer_profile_invalid');
  }
  const profiles = Object.freeze(registeredResearchProfiles.map(canonicalRegisteredProfile));
  if (new Set(profiles.map((profile) => profile.profileId)).size !== profiles.length
    || new Set(profiles.map((profile) => profile.canonicalResearchTopicHash)).size
      !== profiles.length
    || registeredResearchProfiles.some((value) => value?.providerConfigurationHash
      && value.providerConfigurationHash !== providerConfigurationHash)) {
    throw new Error('autonomous_research_topic_producer_profile_invalid');
  }
  const payload = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchTopicProducerProfile',
    producerId: canonicalId(producerId, 'autonomous_research_topic_producer_id_invalid'),
    implementationId: IMPLEMENTATION_ID,
    implementationSha256,
    providerConfigurationHash,
    policyId: AUTONOMOUS_RESEARCH_POLICY_PROFILE.policyId,
    policyProfileHash: hashRecord(
      'AutonomousResearchPolicyProfile',
      AUTONOMOUS_RESEARCH_POLICY_PROFILE,
    ),
    registeredResearchProfiles: profiles,
    minimumGenerationIntervalMs,
    maximumTopicsPerUtcDay,
    maximumProviderCanaryAttemptsPerUtcDay,
    maximumProviderCanaryCostUsdPerUtcDay,
    capabilityValidityMs,
  });
  return Object.freeze({
    ...payload,
    producerProfileHash: hashRecord('AutonomousResearchTopicProducerProfile', payload),
  });
}

export function verifyAutonomousResearchTopicProducerProfile(value) {
  if (!exactKeys(value, PRODUCER_KEYS) || value.version !== 1
    || value.kind !== 'AutonomousResearchTopicProducerProfile'
    || value.implementationId !== IMPLEMENTATION_ID
    || !Array.isArray(value.registeredResearchProfiles)
    || value.registeredResearchProfiles.some((profile) => !exactKeys(profile, PROFILE_KEYS))) {
    return false;
  }
  try {
    const expected = buildAutonomousResearchTopicProducerProfile(value);
    return hashRecord('AutonomousResearchTopicProducerProfileEquality', value)
      === hashRecord('AutonomousResearchTopicProducerProfileEquality', expected);
  } catch { return false; }
}

export function materializeAutonomousResearchTopicProducerIntake({
  producerProfile,
  generationSequence,
  admissionCreatedAt,
} = {}) {
  if (!verifyAutonomousResearchTopicProducerProfile(producerProfile)
    || !Number.isSafeInteger(generationSequence) || generationSequence < 1) {
    throw new Error('autonomous_research_topic_producer_generation_invalid');
  }
  const createdAt = canonicalInstant(
    admissionCreatedAt,
    'autonomous_research_topic_producer_admission_time_invalid',
  );
  const selected = producerProfile.registeredResearchProfiles[
    (generationSequence - 1) % producerProfile.registeredResearchProfiles.length
  ];
  const suffix = ` Preregistered bounded replication epoch ${generationSequence}; this run does not assert scientific novelty, correctness, or validity outside the registered evaluation universe.`;
  const paperId = `prod:${producerProfile.producerId}:${selected.profileId}:${generationSequence}`;
  return Object.freeze({
    registeredResearchProfile: selected,
    intake: buildAutonomousResearchMachineIntake({
      intakeId: `intake:${paperId}`,
      paperId,
      campaignId: `autonomous-research:${paperId}`,
      launchMode: 'production-run',
      objective: `${selected.objective}${suffix}`,
      protocolFamily: selected.protocolFamily,
      datasetMounts: selected.datasetMounts,
      budgets: selected.budgets,
      providerConfigurationHash: producerProfile.providerConfigurationHash,
      revisionRounds: selected.revisionRounds,
      refereeCount: selected.refereeCount,
      admissionCreatedAt: createdAt,
    }),
  });
}

export function buildAutonomousResearchTopicProducerPlannedGeneration({
  producerProfile,
  generationSequence,
  admissionCreatedAt,
  budgetReservationId,
} = {}) {
  const generated = materializeAutonomousResearchTopicProducerIntake({
    producerProfile,
    generationSequence,
    admissionCreatedAt,
  });
  const reservationId = canonicalId(
    budgetReservationId,
    'autonomous_research_topic_producer_budget_reservation_id_invalid',
  );
  const budgetEpochStart = new Date(
    Math.floor(Date.parse(generated.intake.admissionCreatedAt) / DAY_MS) * DAY_MS,
  ).toISOString();
  const producerTopicId = `${producerProfile.producerId}:${generated.registeredResearchProfile.profileId}:${generationSequence}`;
  const topicFingerprint = hashRecord('AutonomousResearchTopicFingerprint', {
    producerProfileHash: producerProfile.producerProfileHash,
    canonicalResearchTopicHash:
      generated.registeredResearchProfile.canonicalResearchTopicHash,
    replicationPolicy: generated.registeredResearchProfile.replicationPolicy,
    replicationEpoch: generationSequence,
  });
  const payload = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchTopicProducerPlannedGeneration',
    producerId: producerProfile.producerId,
    producerProfileHash: producerProfile.producerProfileHash,
    providerConfigurationHash: producerProfile.providerConfigurationHash,
    generationSequence,
    producerTopicId,
    topicFingerprint,
    registeredResearchProfileId: generated.registeredResearchProfile.profileId,
    researchProfileHash: generated.registeredResearchProfile.researchProfileHash,
    canonicalResearchTopicHash:
      generated.registeredResearchProfile.canonicalResearchTopicHash,
    autonomousResearchMachineIntakeHash: generated.intake.intakeHash,
    admissionCreatedAt: generated.intake.admissionCreatedAt,
    budgetReservationId: reservationId,
    budgetEpochStart,
  });
  return Object.freeze({
    ...payload,
    plannedGenerationHash: hashRecord(
      'AutonomousResearchTopicProducerPlannedGeneration',
      payload,
    ),
    intake: generated.intake,
  });
}

export function buildAutonomousResearchTopicProducerCapabilityReceipt({
  producerProfile,
  machineIntakeConfigurationHash,
  generationSequence,
  intake,
  providerCanaryPairReceipt,
  plannedGeneration,
  producerLeaseGeneration,
  producerLeaseTokenHash,
  residentLeaseGeneration,
  residentLeaseTokenHash,
  capabilityNonce,
  now,
} = {}) {
  const generated = buildAutonomousResearchTopicProducerPlannedGeneration({
    producerProfile,
    generationSequence,
    admissionCreatedAt: intake?.admissionCreatedAt,
    budgetReservationId: plannedGeneration?.budgetReservationId,
  });
  const observedAt = now instanceof Date ? now : new Date(now);
  if (!SHA256.test(String(machineIntakeConfigurationHash || ''))
    || !verifyAutonomousResearchMachineIntake(intake)
    || generated.intake.intakeHash !== intake.intakeHash
    || generated.plannedGenerationHash !== plannedGeneration?.plannedGenerationHash
    || !Number.isSafeInteger(producerLeaseGeneration) || producerLeaseGeneration < 1
    || !SHA256.test(String(producerLeaseTokenHash || ''))
    || !Number.isSafeInteger(residentLeaseGeneration) || residentLeaseGeneration < 1
    || !SHA256.test(String(residentLeaseTokenHash || ''))
    || !/^producer-nonce:[0-9a-f]{32}$/.test(String(capabilityNonce || ''))
    || !Number.isFinite(observedAt.getTime())
    || !verifyAutonomousResearchProviderCanaryPairReceipt(providerCanaryPairReceipt, {
      expectedProviderConfigurationHash: producerProfile.providerConfigurationHash,
      now: observedAt,
    })) throw new Error('autonomous_research_topic_producer_capability_invalid');
  const issuedAt = providerCanaryPairReceipt.observedAt;
  const pairExpiresAt = Math.min(
    Date.parse(providerCanaryPairReceipt.researchAuthorProviderCanaryReceipt.expiresAt),
    Date.parse(providerCanaryPairReceipt.formalReviewerProviderCanaryReceipt.expiresAt),
    Date.parse(issuedAt) + producerProfile.capabilityValidityMs,
  );
  const payload = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchTopicProducerCapabilityReceipt',
    status: 'autonomous_research_topic_producer_capability_ready',
    canProduce: true,
    producerId: producerProfile.producerId,
    implementationId: producerProfile.implementationId,
    implementationSha256: producerProfile.implementationSha256,
    producerProfileHash: producerProfile.producerProfileHash,
    policyProfileHash: producerProfile.policyProfileHash,
    machineIntakeConfigurationHash,
    autonomousResearchProviderConfigurationHash: producerProfile.providerConfigurationHash,
    generationSequence,
    producerLeaseGeneration,
    producerLeaseTokenHash,
    residentLeaseGeneration,
    residentLeaseTokenHash,
    budgetReservationId: plannedGeneration.budgetReservationId,
    budgetEpochStart: plannedGeneration.budgetEpochStart,
    plannedGenerationHash: plannedGeneration.plannedGenerationHash,
    producerTopicId: plannedGeneration.producerTopicId,
    topicFingerprint: plannedGeneration.topicFingerprint,
    canonicalResearchTopicHash: plannedGeneration.canonicalResearchTopicHash,
    registeredResearchProfileId: plannedGeneration.registeredResearchProfileId,
    researchProfileHash: plannedGeneration.researchProfileHash,
    autonomousResearchMachineIntakeHash: intake.intakeHash,
    admissionCreatedAt: intake.admissionCreatedAt,
    providerCanaryPairReceiptHash: providerCanaryPairReceipt.providerCanaryPairReceiptHash,
    providerCanaryPairReceipt,
    capabilityNonce,
    issuedAt,
    expiresAt: new Date(pairExpiresAt).toISOString(),
    safety: Object.freeze({
      boundedRegisteredResearchOnly: true,
      scientificNoveltyVerified: false,
      scientificCorrectnessVerified: false,
      externalSubmissionAuthorized: false,
      automaticBudgetExpansionPerformed: false,
    }),
  });
  return Object.freeze({
    ...payload,
    autonomousResearchTopicProducerCapabilityReceiptHash: hashRecord(
      'AutonomousResearchTopicProducerCapabilityReceipt',
      payload,
    ),
  });
}

export function verifyAutonomousResearchTopicProducerCapabilityReceipt(value, {
  producerProfile,
  machineIntakeConfigurationHash,
  intake,
  now = null,
  requireFresh = false,
} = {}) {
  if (!exactKeys(value, CAPABILITY_KEYS) || value.version !== 1
    || value.kind !== 'AutonomousResearchTopicProducerCapabilityReceipt'
    || value.status !== 'autonomous_research_topic_producer_capability_ready'
    || value.canProduce !== true || !verifyAutonomousResearchTopicProducerProfile(producerProfile)
    || value.producerProfileHash !== producerProfile.producerProfileHash
    || value.machineIntakeConfigurationHash !== machineIntakeConfigurationHash
    || value.autonomousResearchMachineIntakeHash !== intake?.intakeHash
    || value.providerCanaryPairReceiptHash
      !== value.providerCanaryPairReceipt?.providerCanaryPairReceiptHash
    || value.safety?.boundedRegisteredResearchOnly !== true
    || value.safety?.scientificNoveltyVerified !== false
    || value.safety?.scientificCorrectnessVerified !== false
    || value.safety?.externalSubmissionAuthorized !== false
    || value.safety?.automaticBudgetExpansionPerformed !== false) return false;
  const checkedAt = now instanceof Date ? now : new Date(now || value.issuedAt);
  if (!Number.isFinite(checkedAt.getTime())) return false;
  try {
    const expected = buildAutonomousResearchTopicProducerCapabilityReceipt({
      producerProfile,
      machineIntakeConfigurationHash,
      generationSequence: value.generationSequence,
      intake,
      providerCanaryPairReceipt: value.providerCanaryPairReceipt,
      plannedGeneration: buildAutonomousResearchTopicProducerPlannedGeneration({
        producerProfile,
        generationSequence: value.generationSequence,
        admissionCreatedAt: value.admissionCreatedAt,
        budgetReservationId: value.budgetReservationId,
      }),
      producerLeaseGeneration: value.producerLeaseGeneration,
      producerLeaseTokenHash: value.producerLeaseTokenHash,
      residentLeaseGeneration: value.residentLeaseGeneration,
      residentLeaseTokenHash: value.residentLeaseTokenHash,
      capabilityNonce: value.capabilityNonce,
      now: new Date(value.issuedAt),
    });
    return hashRecord('AutonomousResearchTopicProducerCapabilityReceiptEquality', value)
        === hashRecord('AutonomousResearchTopicProducerCapabilityReceiptEquality', expected)
      && (!requireFresh || (checkedAt >= new Date(value.issuedAt)
        && checkedAt < new Date(value.expiresAt)));
  } catch { return false; }
}

export function verifyAutonomousResearchTopicProducerCapabilityEnvelope(value, {
  intake,
} = {}) {
  if (!exactKeys(value, CAPABILITY_KEYS)
    || !verifyAutonomousResearchMachineIntake(intake)
    || value.version !== 1
    || value.kind !== 'AutonomousResearchTopicProducerCapabilityReceipt'
    || value.status !== 'autonomous_research_topic_producer_capability_ready'
    || value.canProduce !== true
    || value.autonomousResearchMachineIntakeHash !== intake.intakeHash
    || value.admissionCreatedAt !== intake.admissionCreatedAt
    || value.autonomousResearchProviderConfigurationHash
      !== intake.providerConfigurationHash
    || value.providerCanaryPairReceiptHash
      !== value.providerCanaryPairReceipt?.providerCanaryPairReceiptHash
    || value.safety?.boundedRegisteredResearchOnly !== true
    || value.safety?.scientificNoveltyVerified !== false
    || value.safety?.scientificCorrectnessVerified !== false
    || value.safety?.externalSubmissionAuthorized !== false
    || value.safety?.automaticBudgetExpansionPerformed !== false) return false;
  const {
    autonomousResearchTopicProducerCapabilityReceiptHash: claimedHash,
    ...payload
  } = value;
  return SHA256.test(String(claimedHash || ''))
    && hashRecord('AutonomousResearchTopicProducerCapabilityReceipt', payload) === claimedHash;
}
