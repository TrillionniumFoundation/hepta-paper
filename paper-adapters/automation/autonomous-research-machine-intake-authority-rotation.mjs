import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  materializeAutonomousResearchRecurringGoldenIntake,
} from '../../paper-domain/automation/autonomous-research-machine-intake-contract.mjs';
import {
  readAutonomousResearchMachineIntakeConfiguration,
  readStaticAutonomousResearchMachineIntake,
} from './autonomous-research-machine-intake-loader.mjs';
import {
  readAutonomousResearchTopicProducerProfile,
} from './autonomous-research-topic-producer-profile-loader.mjs';
import {
  createMachineIntakeSchema,
  legacySchemaRequiresMigration,
} from './autonomous-research-machine-intake-repository-support.mjs';
import {
  assertMachineIntakeAuthorityState,
} from './autonomous-research-machine-intake-authority.mjs';
import {
  buildAutonomousResearchIntakeRotationIntentTemplate,
  loadAutonomousResearchIntakeRotationAuthorization,
  verifyAutonomousResearchIntakeRotationIntent,
} from './autonomous-research-machine-intake-authority-rotation-authorization.mjs';
import {
  attachExisting,
  databasePaths,
  machineSnapshot,
  openReadOnly,
  supervisorSnapshot,
  topicSnapshot,
  validateAttachedDatabaseIntegrity,
  validateDatabaseFile,
} from './autonomous-research-machine-intake-authority-rotation-state.mjs';
import {
  readAutonomousResearchMachineIntakeAuthorityRotationClock,
} from './autonomous-research-machine-intake-authority-rotation-clock.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;

function observedDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error('autonomous_research_machine_intake_authority_rotation_clock_invalid');
  }
  return date;
}

function loadTarget({
  nextConfigurationPath,
  topicProducerProfilePath,
  environment,
  now,
}) {
  const configuration = readAutonomousResearchMachineIntakeConfiguration({
    configPath: nextConfigurationPath,
  }).configuration;
  if (configuration.version !== 2 || configuration.machineAppendEnabled !== true) {
    throw new Error('autonomous_research_machine_intake_authority_rotation_v2_target_required');
  }
  const loadedProfile = readAutonomousResearchTopicProducerProfile({
    profilePath: topicProducerProfilePath,
    environment,
    expectedProfileHash: configuration.machineProducerProfileHash,
  });
  const datasetRoot = fs.realpathSync(
    path.resolve(environment.HEPTA_AUTONOMOUS_RESEARCH_DATASET_ROOT),
  );
  const targetSources = [];
  for (const candidate of configuration.staticIntakeFiles) {
    const intake = readStaticAutonomousResearchMachineIntake(candidate.path).intake;
    targetSources.push(Object.freeze({
      sourceKind: 'static-file',
      sourceRef: candidate.path,
      intakeId: intake.intakeId,
      intakeHash: intake.intakeHash,
      paperId: intake.paperId,
      campaignId: intake.campaignId,
    }));
  }
  for (const template of configuration.recurringGoldenTemplates) {
    const intake = materializeAutonomousResearchRecurringGoldenIntake({
      template,
      now,
      sourceAuthorityHash: configuration.configurationHash,
    });
    targetSources.push(Object.freeze({
      sourceKind: 'recurring-golden',
      sourceRef: `${template.templateId}@${intake.recurringGoldenProvenance.epochStart}`,
      intakeId: intake.intakeId,
      intakeHash: intake.intakeHash,
      paperId: intake.paperId,
      campaignId: intake.campaignId,
    }));
  }
  targetSources.sort((left, right) => left.intakeId.localeCompare(right.intakeId));
  return Object.freeze({
    configuration,
    producerProfile: loadedProfile.producerProfile,
    implementationIdentity: loadedProfile.implementationIdentity,
    datasetRoot,
    targetSources: Object.freeze(targetSources),
  });
}

function derivePlan({
  machine,
  supervisor,
  topic,
  target,
  authorization,
  now,
  schemaMigrationRequired,
}) {
  const timestamp = observedDate(now).toISOString();
  const intakeRows = machine.tables.autonomous_research_machine_intake;
  const pendingLegacyMachineIds = intakeRows
    .filter((row) => row.source_kind === 'machine' && row.disposition === 'pending')
    .map((row) => row.intake_id).sort();
  const identityConflicts = target.targetSources.flatMap((candidate) => intakeRows
    .filter((row) => row.intake_id === candidate.intakeId
      || row.intake_hash === candidate.intakeHash
      || row.paper_id === candidate.paperId
      || row.campaign_id === candidate.campaignId)
    .map((row) => Object.freeze({
      targetIntakeId: candidate.intakeId,
      existingIntakeId: row.intake_id,
      existingDisposition: row.disposition,
    })));
  const activeMachineLeases = machine.tables.autonomous_research_machine_intake_lease
    .filter((row) => String(row.expires_at || '') > timestamp)
    .map((row) => Object.freeze({
      intakeId: row.intake_id,
      leaseGeneration: Number(row.lease_generation),
      expiresAt: row.expires_at,
    }));
  const activeSupervisorLeases = supervisor.rows
    .filter((row) => row.status === 'running' && String(row.lease_expires_at || '') > timestamp)
    .map((row) => Object.freeze({
      scopeId: row.scope_id,
      leaseGeneration: Number(row.lease_generation),
      expiresAt: row.lease_expires_at,
    }));
  const topicMetadata = topic.tables.autonomous_research_topic_producer_metadata?.[0] || null;
  const activeTopicLeases = (topic.tables.autonomous_research_topic_producer_lease || [])
    .filter((row) => String(row.expires_at || '') > timestamp)
    .map((row) => Object.freeze({
      leaseGeneration: Number(row.lease_generation),
      expiresAt: row.expires_at,
    }));
  const outstandingTopicGenerations = (
    topic.tables.autonomous_research_topic_producer_generation || []
  ).filter((row) => ['planned', 'authorized'].includes(row.status))
    .map((row) => Object.freeze({
      generationSequence: Number(row.generation_sequence),
      status: row.status,
    }));
  const topicAuthorityMatches = !topic.databasePresent || Boolean(topicMetadata
    && topicMetadata.machine_intake_configuration_hash
      === target.configuration.configurationHash
    && topicMetadata.producer_profile_hash === target.producerProfile.producerProfileHash
    && topicMetadata.provider_configuration_hash
      === target.producerProfile.providerConfigurationHash
    && topicMetadata.implementation_sha256
      === target.implementationIdentity.implementationSha256);
  const blockers = [
    ...(schemaMigrationRequired
      ? ['autonomous_research_machine_intake_authority_rotation_schema_migration_required'] : []),
    ...(machine.metadata.authorizedMachineProducerProfileHash !== null
      || machine.metadata.authorityGeneration !== 1
      || machine.metadata.lastAuthorityRotationReceiptHash !== null
      || machine.tables.autonomous_research_machine_intake_authority_rotation.length !== 0
      ? ['autonomous_research_machine_intake_authority_rotation_v1_source_required'] : []),
    ...(activeMachineLeases.length
      ? ['autonomous_research_machine_intake_authority_rotation_machine_lease_active'] : []),
    ...(activeSupervisorLeases.length
      ? ['autonomous_research_machine_intake_authority_rotation_supervisor_active'] : []),
    ...(!topicAuthorityMatches
      ? ['autonomous_research_machine_intake_authority_rotation_topic_authority_mismatch'] : []),
    ...(activeTopicLeases.length
      ? ['autonomous_research_machine_intake_authority_rotation_topic_lease_active'] : []),
    ...(outstandingTopicGenerations.length
      ? ['autonomous_research_machine_intake_authority_rotation_topic_generation_outstanding']
      : []),
    ...(identityConflicts.length
      ? ['autonomous_research_machine_intake_authority_rotation_target_identity_conflict'] : []),
  ];
  const preStateHash = hashRecord(
    'AutonomousResearchMachineIntakeAuthorityRotationPreState',
    machine,
  );
  const quiescenceStateHash = hashRecord(
    'AutonomousResearchMachineIntakeAuthorityRotationQuiescenceState',
    { supervisor, topic },
  );
  const postStateHash = hashRecord(
    'AutonomousResearchMachineIntakeAuthorityRotationPostState',
    {
      preStateHash,
      nextAuthorityGeneration: machine.metadata.authorityGeneration + 1,
      nextConfigurationHash: target.configuration.configurationHash,
      nextProducerProfileHash: target.producerProfile.producerProfileHash,
      quarantinedLegacyMachineIntakeIds: pendingLegacyMachineIds,
    },
  );
  const payload = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchMachineIntakeAuthorityRotationPlan',
    transition: 'v1-to-v2',
    expectedAuthorityGeneration: machine.metadata.authorityGeneration,
    nextAuthorityGeneration: machine.metadata.authorityGeneration + 1,
    previousConfigurationHash: machine.metadata.configuredSourceAuthorityHash,
    previousProducerProfileHash: machine.metadata.authorizedMachineProducerProfileHash,
    previousRotationReceiptHash: machine.metadata.lastAuthorityRotationReceiptHash,
    nextConfigurationHash: target.configuration.configurationHash,
    nextProducerProfileHash: target.producerProfile.producerProfileHash,
    nextProviderConfigurationHash: target.producerProfile.providerConfigurationHash,
    nextImplementationSha256: target.implementationIdentity.implementationSha256,
    datasetRoot: target.datasetRoot,
    authorityTrustStoreHash: authorization.rotationTrustStoreHash,
    ownerTrustStoreHash: authorization.ownerTrustStoreHash,
    bootstrapReceiptHash: authorization.bootstrapReceiptHash,
    authorityAnchorHash: authorization.authorityAnchorHash,
    rotatorKeySnapshotHash: authorization.rotatorKeySnapshotHash,
    preStateHash,
    quiescenceStateHash,
    postStateHash,
    quarantinedLegacyMachineIntakeIds: Object.freeze(pendingLegacyMachineIds),
    targetSourceIdentities: target.targetSources,
    activeMachineLeases: Object.freeze(activeMachineLeases),
    activeSupervisorLeases: Object.freeze(activeSupervisorLeases),
    activeTopicLeases: Object.freeze(activeTopicLeases),
    outstandingTopicGenerations: Object.freeze(outstandingTopicGenerations),
    identityConflicts: Object.freeze(identityConflicts),
    topicProducerDatabasePresent: topic.databasePresent,
  });
  return Object.freeze({
    plan: Object.freeze({
      ...payload,
      planHash: hashRecord('AutonomousResearchMachineIntakeAuthorityRotationPlan', payload),
    }),
    blockers: Object.freeze([...new Set(blockers)]),
  });
}

function inspectState({ paths, target, authorizationReader, now }) {
  const machineDatabase = openReadOnly(paths.machine, { required: true });
  const supervisorDatabase = openReadOnly(paths.supervisor);
  const topicDatabase = openReadOnly(paths.topic);
  try {
    const machine = machineSnapshot(machineDatabase);
    const authorization = authorizationReader({
      previousConfigurationHash: machine.metadata.configuredSourceAuthorityHash,
      expectedAuthorityGeneration: machine.metadata.authorityGeneration,
      now,
    });
    const derived = derivePlan({
      machine,
      supervisor: supervisorSnapshot(supervisorDatabase),
      topic: topicSnapshot(topicDatabase),
      target,
      authorization,
      now,
      schemaMigrationRequired: legacySchemaRequiresMigration(machineDatabase),
    });
    return Object.freeze({ ...derived, authorization });
  } finally {
    topicDatabase?.close();
    supervisorDatabase?.close();
    machineDatabase.close();
  }
}

function planRotation({
  runtimeRoot,
  nextConfigurationPath,
  topicProducerProfilePath,
  environment = process.env,
} = {}, authorizationReader, clock) {
  const observedAt = observedDate(clock());
  const paths = databasePaths(runtimeRoot);
  const target = loadTarget({
    nextConfigurationPath,
    topicProducerProfilePath,
    environment,
    now: observedAt,
  });
  const inspected = inspectState({
    paths,
    target,
    authorizationReader,
    now: observedAt,
  });
  return Object.freeze({
    version: 1,
    kind: 'AutonomousResearchMachineIntakeAuthorityRotationPlanReport',
    status: inspected.blockers.length
      ? 'autonomous_research_machine_intake_authority_rotation_blocked'
      : 'autonomous_research_machine_intake_authority_rotation_planned',
    ready: inspected.blockers.length === 0,
    executeRequired: true,
    plan: inspected.plan,
    rotationIntentTemplate: buildAutonomousResearchIntakeRotationIntentTemplate(
      inspected.plan,
      observedAt,
    ),
    authorizationBundle: Object.freeze({
      authorityRoot: inspected.authorization.authorityRoot,
      authorityTrustStoreHash: inspected.authorization.rotationTrustStoreHash,
      ownerTrustStoreHash: inspected.authorization.ownerTrustStoreHash,
      bootstrapReceiptHash: inspected.authorization.bootstrapReceiptHash,
      authorityAnchorHash: inspected.authorization.authorityAnchorHash,
      rotatorKeySnapshotHash: inspected.authorization.rotatorKeySnapshotHash,
      requiredRole: inspected.authorization.requiredRotatorRole,
      privateKeyLoaded: inspected.authorization.privateKeyLoaded,
    }),
    blockers: inspected.blockers,
    externalActionPerformed: false,
    networkUse: false,
    providerCostUsd: 0,
  });
}

export function planAutonomousResearchMachineIntakeAuthorityRotation(options = {}) {
  if (Object.hasOwn(options, 'now')) {
    throw new Error('autonomous_research_machine_intake_authority_rotation_clock_override_forbidden');
  }
  return planRotation(
    options,
    loadAutonomousResearchIntakeRotationAuthorization,
    readAutonomousResearchMachineIntakeAuthorityRotationClock,
  );
}

function applyRotation({
  runtimeRoot,
  nextConfigurationPath,
  topicProducerProfilePath,
  rotationIntentPath,
  environment = process.env,
  planHash,
  expectedAuthorityGeneration,
  execute = false,
} = {}, authorizationReader, clock) {
  if (execute !== true) {
    throw new Error('autonomous_research_machine_intake_authority_rotation_execute_required');
  }
  if (!SHA256.test(String(planHash || ''))
    || !Number.isSafeInteger(expectedAuthorityGeneration)
    || expectedAuthorityGeneration < 1) {
    throw new Error('autonomous_research_machine_intake_authority_rotation_confirmation_invalid');
  }
  const observedAt = observedDate(clock());
  const candidate = planRotation({
    runtimeRoot,
    nextConfigurationPath,
    topicProducerProfilePath,
    environment,
    now: observedAt,
  }, authorizationReader, () => observedAt);
  if (!candidate.ready || candidate.plan.planHash !== planHash
    || candidate.plan.expectedAuthorityGeneration !== expectedAuthorityGeneration) {
    throw new Error('autonomous_research_machine_intake_authority_rotation_plan_mismatch');
  }
  const earlyAuthorization = authorizationReader({
    previousConfigurationHash: candidate.plan.previousConfigurationHash,
    expectedAuthorityGeneration: candidate.plan.expectedAuthorityGeneration,
    now: observedAt,
  });
  verifyAutonomousResearchIntakeRotationIntent({
    rotationIntentPath,
    plan: candidate.plan,
    authorization: earlyAuthorization,
    now: observedAt,
  });
  const paths = databasePaths(runtimeRoot);
  validateDatabaseFile(paths.machine, { required: true });
  fs.chmodSync(paths.machine, 0o600);
  const database = new DatabaseSync(paths.machine);
  database.exec('PRAGMA busy_timeout=10000; PRAGMA synchronous=FULL;');
  let supervisorAttached = false;
  let topicAttached = false;
  try {
    supervisorAttached = attachExisting(database, paths.supervisor, 'supervisor');
    topicAttached = attachExisting(database, paths.topic, 'topic');
    if (topicAttached !== candidate.plan.topicProducerDatabasePresent) {
      throw new Error('autonomous_research_machine_intake_authority_rotation_plan_mismatch');
    }
    database.exec('BEGIN IMMEDIATE;');
    const lockedObservedAt = observedDate(clock());
    validateAttachedDatabaseIntegrity(database, { supervisorAttached, topicAttached });
    const target = loadTarget({
      nextConfigurationPath,
      topicProducerProfilePath,
      environment,
      now: lockedObservedAt,
    });
    const machine = machineSnapshot(database);
    const lockedAuthorization = authorizationReader({
      previousConfigurationHash: machine.metadata.configuredSourceAuthorityHash,
      expectedAuthorityGeneration: machine.metadata.authorityGeneration,
      now: lockedObservedAt,
    });
    const locked = derivePlan({
      machine,
      supervisor: supervisorSnapshot(
        supervisorAttached ? database : null,
        supervisorAttached ? 'supervisor' : 'main',
      ),
      topic: topicSnapshot(topicAttached ? database : null, topicAttached ? 'topic' : 'main'),
      target,
      authorization: lockedAuthorization,
      now: lockedObservedAt,
      schemaMigrationRequired: legacySchemaRequiresMigration(database),
    });
    if (locked.blockers.length || locked.plan.planHash !== planHash
      || locked.plan.expectedAuthorityGeneration !== expectedAuthorityGeneration) {
      throw new Error('autonomous_research_machine_intake_authority_rotation_plan_mismatch');
    }
    const verifiedIntent = verifyAutonomousResearchIntakeRotationIntent({
      rotationIntentPath,
      plan: locked.plan,
      authorization: lockedAuthorization,
      now: lockedObservedAt,
    });
    createMachineIntakeSchema(database);
    const appliedAt = lockedObservedAt.toISOString();
    const rotatedAt = verifiedIntent.intent.validFrom;
    const quarantine = database.prepare(`UPDATE autonomous_research_machine_intake SET
      disposition='invalid',invalid_reason=?,updated_at=?
      WHERE intake_id=? AND source_kind='machine' AND disposition='pending'`);
    let quarantinedCount = 0;
    for (const intakeId of locked.plan.quarantinedLegacyMachineIntakeIds) {
      quarantinedCount += Number(quarantine.run(
        'autonomous_research_machine_intake_authority_rotation_legacy_machine_quarantine',
        appliedAt,
        intakeId,
      ).changes);
    }
    if (quarantinedCount !== locked.plan.quarantinedLegacyMachineIntakeIds.length) {
      throw new Error('autonomous_research_machine_intake_authority_rotation_quarantine_cas_failed');
    }
    const receiptPayload = Object.freeze({
      version: 1,
      kind: 'AutonomousResearchMachineIntakeAuthorityRotationReceipt',
      status: 'autonomous_research_machine_intake_authority_rotated',
      transition: locked.plan.transition,
      authorityGeneration: locked.plan.nextAuthorityGeneration,
      previousConfigurationHash: locked.plan.previousConfigurationHash,
      previousProducerProfileHash: locked.plan.previousProducerProfileHash,
      previousRotationReceiptHash: locked.plan.previousRotationReceiptHash,
      nextConfigurationHash: locked.plan.nextConfigurationHash,
      nextProducerProfileHash: locked.plan.nextProducerProfileHash,
      nextProviderConfigurationHash: locked.plan.nextProviderConfigurationHash,
      nextImplementationSha256: locked.plan.nextImplementationSha256,
      datasetRoot: locked.plan.datasetRoot,
      planHash,
      plan: locked.plan,
      rotationIntentHash: verifiedIntent.intentHash,
      rotationIntentNonce: verifiedIntent.intent.nonce,
      authorityTrustStoreHash: lockedAuthorization.rotationTrustStoreHash,
      ownerTrustStoreHash: lockedAuthorization.ownerTrustStoreHash,
      ownerTrustStoreSnapshot: lockedAuthorization.ownerTrustStore,
      rotationTrustStoreSnapshot: lockedAuthorization.rotationTrustStore,
      bootstrapReceiptHash: lockedAuthorization.bootstrapReceiptHash,
      bootstrapReceipt: lockedAuthorization.bootstrapReceipt,
      authorityAnchorHash: lockedAuthorization.authorityAnchorHash,
      bootstrapVerifiedSignerIdentities: lockedAuthorization.bootstrapVerifiedSigners,
      rotatorPublicKeySnapshot: lockedAuthorization.rotatorPublicKeySnapshot,
      rotatorKeySnapshotHash: lockedAuthorization.rotatorKeySnapshotHash,
      verifiedSignerIdentity: verifiedIntent.signer,
      preStateHash: locked.plan.preStateHash,
      quiescenceStateHash: locked.plan.quiescenceStateHash,
      postStateHash: locked.plan.postStateHash,
      quarantinedLegacyMachineAdmissionCount: quarantinedCount,
      rotatedAt,
      externalActionPerformed: false,
    });
    const receipt = Object.freeze({
      ...receiptPayload,
      rotationReceiptHash: hashRecord(
        'AutonomousResearchMachineIntakeAuthorityRotationReceipt',
        receiptPayload,
      ),
    });
    database.prepare(`INSERT INTO autonomous_research_machine_intake_authority_rotation(
      authority_generation,transition,previous_configuration_hash,
      previous_producer_profile_hash,previous_rotation_receipt_hash,
      next_configuration_hash,next_producer_profile_hash,next_provider_configuration_hash,
      next_implementation_sha256,plan_hash,plan_json,rotation_intent_hash,intent_nonce,
      authority_trust_store_hash,owner_trust_store_hash,bootstrap_receipt_hash,
      authority_anchor_hash,bootstrap_receipt_json,owner_trust_store_snapshot_json,
      rotation_trust_store_snapshot_json,bootstrap_verified_signers_json,
      rotator_key_snapshot_hash,
      rotator_public_key_snapshot_json,verified_signer_key_id,verified_signer_subject_id,
      verified_signer_role,verified_signer_json,rotation_intent_json,
      pre_state_hash,quiescence_state_hash,post_state_hash,
      quarantined_legacy_machine_admission_count,rotation_receipt_hash,
      rotation_receipt_json,rotated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      locked.plan.nextAuthorityGeneration,
      locked.plan.transition,
      locked.plan.previousConfigurationHash,
      locked.plan.previousProducerProfileHash,
      locked.plan.previousRotationReceiptHash,
      locked.plan.nextConfigurationHash,
      locked.plan.nextProducerProfileHash,
      locked.plan.nextProviderConfigurationHash,
      locked.plan.nextImplementationSha256,
      planHash,
      JSON.stringify(locked.plan),
      verifiedIntent.intentHash,
      verifiedIntent.intent.nonce,
      lockedAuthorization.rotationTrustStoreHash,
      lockedAuthorization.ownerTrustStoreHash,
      lockedAuthorization.bootstrapReceiptHash,
      lockedAuthorization.authorityAnchorHash,
      JSON.stringify(lockedAuthorization.bootstrapReceipt),
      JSON.stringify(lockedAuthorization.ownerTrustStore),
      JSON.stringify(lockedAuthorization.rotationTrustStore),
      JSON.stringify(lockedAuthorization.bootstrapVerifiedSigners),
      lockedAuthorization.rotatorKeySnapshotHash,
      JSON.stringify(lockedAuthorization.rotatorPublicKeySnapshot),
      verifiedIntent.signer.keyId,
      verifiedIntent.signer.subjectId,
      verifiedIntent.signer.role,
      JSON.stringify(verifiedIntent.signer),
      JSON.stringify(verifiedIntent.intent),
      locked.plan.preStateHash,
      locked.plan.quiescenceStateHash,
      locked.plan.postStateHash,
      quarantinedCount,
      receipt.rotationReceiptHash,
      JSON.stringify(receipt),
      rotatedAt,
    );
    const updated = database.prepare(`UPDATE autonomous_research_machine_intake_metadata SET
      configured_source_authority_hash=?,authorized_machine_producer_profile_hash=?,
      authority_generation=?,last_authority_rotation_receipt_hash=?
      WHERE singleton=1 AND configured_source_authority_hash=?
      AND authorized_machine_producer_profile_hash IS NULL AND authority_generation=?`).run(
      locked.plan.nextConfigurationHash,
      locked.plan.nextProducerProfileHash,
      locked.plan.nextAuthorityGeneration,
      receipt.rotationReceiptHash,
      locked.plan.previousConfigurationHash,
      expectedAuthorityGeneration,
    );
    if (Number(updated.changes) !== 1) {
      throw new Error('autonomous_research_machine_intake_authority_rotation_authority_cas_failed');
    }
    assertMachineIntakeAuthorityState(database);
    database.exec('COMMIT;');
    return Object.freeze({
      version: 1,
      kind: 'AutonomousResearchMachineIntakeAuthorityRotationApplyReport',
      status: 'autonomous_research_machine_intake_authority_rotated',
      ready: true,
      applied: true,
      receipt,
      preserved: Object.freeze({
        intakeHistory: true,
        campaignBindings: true,
        dailyAdmissionBudgets: true,
        leaseTokensAndGenerations: true,
        topicProducerHistory: true,
      }),
      externalActionPerformed: false,
      networkUse: false,
      providerCostUsd: 0,
    });
  } catch (error) {
    if (database.isTransaction) {
      try { database.exec('ROLLBACK;'); } catch { /* retain the original failure */ }
    }
    throw error;
  } finally {
    database.close();
  }
}

export function applyAutonomousResearchMachineIntakeAuthorityRotation(options = {}) {
  if (Object.hasOwn(options, 'now') || Object.hasOwn(options, 'rotationHooks')) {
    throw new Error('autonomous_research_machine_intake_authority_rotation_test_override_forbidden');
  }
  return applyRotation(
    options,
    loadAutonomousResearchIntakeRotationAuthorization,
    readAutonomousResearchMachineIntakeAuthorityRotationClock,
  );
}
