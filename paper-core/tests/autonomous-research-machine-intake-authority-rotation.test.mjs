import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  signAuthorityDocument,
  verifyAuthoritySignatures,
  verifyAuthorityTimeWindow,
} from '../../paper-adapters/authority/authority-signatures.mjs';
import {
  installAutonomousResearchMachineIntakeRotationAuthorizationTestDouble,
  installAutonomousResearchMachineIntakeExternalAuthorityTestDouble,
} from './test-doubles/autonomous-research-machine-intake-authority-rotation-authorization.mjs';
import {
  installAutonomousResearchMachineIntakeRotationClockTestDouble,
} from './test-doubles/autonomous-research-machine-intake-authority-rotation-clock.mjs';
import {
  buildAutonomousResearchMachineIntakeConfiguration,
} from '../../paper-adapters/automation/autonomous-research-machine-intake-loader.mjs';
import {
  inspectAutonomousResearchTopicProducerImplementationIdentity,
} from '../../paper-adapters/automation/autonomous-research-topic-producer-profile-loader.mjs';
import {
  createAutonomousResearchTopicProducerRepository,
} from '../../paper-adapters/automation/autonomous-research-topic-producer-repository.mjs';
import {
  createAutonomousResearchSupervisorInstanceRepository,
} from '../../paper-adapters/automation/autonomous-research-supervisor-instance-repository.mjs';
import {
  buildAutonomousResearchMachineIntake,
} from '../../paper-domain/automation/autonomous-research-machine-intake-contract.mjs';
import {
  buildAutonomousResearchTopicProducerProfile,
} from '../../paper-domain/automation/autonomous-research-topic-producer-contract.mjs';
import {
  inspectStrictDatasetManifest,
} from '../../paper-adapters/runtime/execution-snapshot.mjs';
import {
  createMachineIntakeSchema,
} from '../../paper-adapters/automation/autonomous-research-machine-intake-repository-support.mjs';
import {
  installMachineIntakeExternalGenesisAuthority,
} from './machine-intake-external-authority-test-support.mjs';

const ROTATION_MODULE = new URL(
  '../../paper-adapters/automation/autonomous-research-machine-intake-authority-rotation.mjs',
  import.meta.url,
);
const AUTHORIZATION_MODULE = new URL(
  '../../paper-adapters/automation/autonomous-research-machine-intake-authority-rotation-authorization.mjs',
  import.meta.url,
);
const AUTHORITY_STATE_MODULE = new URL(
  '../../paper-adapters/automation/autonomous-research-machine-intake-authority.mjs',
  import.meta.url,
);
const CLOCK_MODULE = new URL(
  '../../paper-adapters/automation/autonomous-research-machine-intake-authority-rotation-clock.mjs',
  import.meta.url,
);
const AUTHORIZATION_DOUBLE = new URL(
  './test-doubles/autonomous-research-machine-intake-authority-rotation-authorization.mjs',
  import.meta.url,
);
const CLOCK_DOUBLE = new URL(
  './test-doubles/autonomous-research-machine-intake-authority-rotation-clock.mjs',
  import.meta.url,
);
const AUTHORIZATION_COVERAGE_MODULE = new URL(AUTHORIZATION_MODULE);
AUTHORIZATION_COVERAGE_MODULE.searchParams.set('test-internals', 'isolated');

registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    const parent = context.parentURL?.split('?')[0];
    if (parent === ROTATION_MODULE.href || parent === AUTHORITY_STATE_MODULE.href) {
      if (resolved.url === AUTHORIZATION_MODULE.href) {
        return { shortCircuit: true, url: AUTHORIZATION_DOUBLE.href };
      }
      if (resolved.url === CLOCK_MODULE.href) {
        return { shortCircuit: true, url: CLOCK_DOUBLE.href };
      }
    }
    return resolved;
  },
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    if (url !== AUTHORIZATION_COVERAGE_MODULE.href) return loaded;
    const source = typeof loaded.source === 'string'
      ? loaded.source
      : Buffer.from(loaded.source).toString('utf8');
    return {
      ...loaded,
      shortCircuit: true,
      source: `${source}\nexport { loadAuthorizationAtRoot as
        loadAutonomousResearchIntakeRotationAuthorizationAtRootForTest };\n`,
    };
  },
});

const {
  applyAutonomousResearchMachineIntakeAuthorityRotation,
  planAutonomousResearchMachineIntakeAuthorityRotation,
} = await import(`${ROTATION_MODULE.href}?test-dependencies=isolated`);
const {
  createAutonomousResearchMachineIntakeRepository,
} = await import(
  '../../paper-adapters/automation/autonomous-research-machine-intake-repository.mjs'
);
const {
  bindAuthorizedMachineProducerProfileHash,
  bindConfiguredSourceAuthorityHash,
  readAuthorizedMachineProducerProfileHash,
  readConfiguredSourceAuthorityHash,
  readMachineIntakeAuthorityGeneration,
} = await import(AUTHORITY_STATE_MODULE.href);
const {
  buildAutonomousResearchIntakeRotationIntentTemplate:
    buildProductionAutonomousResearchIntakeRotationIntentTemplate,
  loadAutonomousResearchIntakeRotationAuthorizationAtRootForTest,
  verifyAutonomousResearchIntakeRotationIntent:
    verifyProductionAutonomousResearchIntakeRotationIntent,
} = await import(AUTHORIZATION_COVERAGE_MODULE.href);

const H = (label) => hashRecord(
  'AutonomousResearchMachineIntakeAuthorityRotationTestHash',
  { label },
);
const BASE = new Date('2026-07-17T00:00:00.000Z');
const BUDGETS = Object.freeze({
  maxWallTimeMs: 60 * 60 * 1000,
  maxAgentCalls: 12,
  maxCpuJobs: 16,
  maxGpuJobs: 0,
  maxTokenCount: 50_000,
  maxCostUsd: 10,
  maxMemoryMiB: 4096,
});

function writeJson(candidate, value) {
  fs.writeFileSync(candidate, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(candidate, 0o600);
}

function authorityKey({ keyId, subjectId, role, pair }) {
  return {
    keyId,
    subjectId,
    organization: 'Rotation Test Authority',
    algorithm: 'ed25519',
    publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }),
    roles: [role],
    status: 'active',
    effectiveFrom: '2026-07-16T00:00:00.000Z',
    expiresAt: '2026-08-16T00:00:00.000Z',
    revokedAt: null,
  };
}

function rotationAuthority(previousConfigurationHash) {
  const rotator = crypto.generateKeyPairSync('ed25519');
  const owner = crypto.generateKeyPairSync('ed25519');
  const observer = crypto.generateKeyPairSync('ed25519');
  const rotationKey = authorityKey({
    keyId: 'intake-rotation-key',
    subjectId: 'intake-rotation-operator',
    role: 'autonomous_research_intake_authority_rotator',
    pair: rotator,
  });
  const ownerKey = authorityKey({
    keyId: 'rotation-capability-owner-key',
    subjectId: 'rotation-capability-owner',
    role: 'capability_owner',
    pair: owner,
  });
  const observerKey = authorityKey({
    keyId: 'rotation-operational-observer-key',
    subjectId: 'rotation-operational-observer',
    role: 'operational_observer',
    pair: observer,
  });
  const rotationTrustStore = {
    version: 1,
    kind: 'AuthorityTrustStore',
    keys: [rotationKey],
  };
  const ownerTrustStore = {
    version: 1,
    kind: 'AuthorityTrustStore',
    keys: [ownerKey, observerKey],
  };
  const rotatorPublicKeySnapshot = [{ ...rotationKey }];
  const rotationTrustStoreHash = hashRecord('AuthorityTrustStore', rotationTrustStore);
  const ownerTrustStoreHash = hashRecord('AuthorityTrustStore', ownerTrustStore);
  const rotatorKeySnapshotHash = hashRecord(
    'AutonomousResearchMachineIntakeAuthorityRotatorKeySnapshot',
    rotatorPublicKeySnapshot,
  );
  const unsignedBootstrap = {
    version: 1,
    kind: 'AutonomousResearchMachineIntakeAuthorityRotationBootstrapReceipt',
    status: 'external_rotation_authority_bootstrap_verified',
    previousConfigurationHash,
    expectedAuthorityGeneration: 1,
    rotationTrustStoreHash,
    ownerTrustStoreHash,
    rotatorKeySnapshotHash,
    rotatorKeyIds: ['intake-rotation-key'],
    nonce: 'bootstrap:rotation-test-authority',
    signedAt: '2026-07-16T23:00:00.000Z',
    validFrom: '2026-07-16T23:00:00.000Z',
    expiresAt: '2026-08-15T23:00:00.000Z',
    signatures: [],
  };
  const ownerSigned = signAuthorityDocument(unsignedBootstrap, {
    privateKeyPem: owner.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    keyId: ownerKey.keyId,
    role: 'capability_owner',
  });
  const bootstrapReceipt = signAuthorityDocument(ownerSigned, {
    privateKeyPem: observer.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    keyId: observerKey.keyId,
    role: 'operational_observer',
  });
  const bootstrapReceiptHash = hashRecord(
    'AutonomousResearchMachineIntakeAuthorityRotationBootstrapReceipt',
    bootstrapReceipt,
  );
  const authorityAnchorHash = hashRecord(
    'AutonomousResearchMachineIntakeAuthorityRotationAnchor',
    {
      bootstrapReceiptHash,
      previousConfigurationHash,
      expectedAuthorityGeneration: 1,
      rotationTrustStoreHash,
      ownerTrustStoreHash,
      rotatorKeySnapshotHash,
    },
  );
  const authorization = Object.freeze({
    authorityRoot: '/test-only/authority-rotation',
    rotationTrustStore,
    rotationTrustStoreHash,
    ownerTrustStore,
    ownerTrustStoreHash,
    rotatorPublicKeySnapshot: Object.freeze(rotatorPublicKeySnapshot),
    rotatorKeySnapshotHash,
    bootstrapReceipt: Object.freeze(bootstrapReceipt),
    bootstrapReceiptHash,
    bootstrapVerifiedSigners: Object.freeze([
      { keyId: ownerKey.keyId, subjectId: ownerKey.subjectId,
        organization: ownerKey.organization, role: 'capability_owner' },
      { keyId: observerKey.keyId, subjectId: observerKey.subjectId,
        organization: observerKey.organization, role: 'operational_observer' },
    ]),
    authorityAnchorHash,
    requiredRotatorRole: 'autonomous_research_intake_authority_rotator',
    privateKeyLoaded: false,
  });
  installAutonomousResearchMachineIntakeRotationAuthorizationTestDouble((input) => {
    if (input.previousConfigurationHash !== previousConfigurationHash
      || input.expectedAuthorityGeneration !== 1) {
      throw new Error(`autonomous_research_machine_intake_authority_rotation_bootstrap_invalid:
        rotation_bootstrap_binding_mismatch`);
    }
    const time = verifyAuthorityTimeWindow({
      ...bootstrapReceipt,
      now: input.now,
      maximumLifetimeMs: 31 * 24 * 60 * 60 * 1000,
    });
    assert.deepEqual(time.blockers, []);
    const signatures = verifyAuthoritySignatures({
      document: bootstrapReceipt,
      trustStore: ownerTrustStore,
      requiredRoles: ['capability_owner', 'operational_observer'],
      minSignatures: 2,
      requireDistinctSubjects: true,
    });
    assert.deepEqual(signatures.blockers, []);
    return authorization;
  });
  installAutonomousResearchMachineIntakeExternalAuthorityTestDouble(() => Object.freeze({
    authorityRoot: '/test-only/authority-rotation',
    rotationTrustStore,
    ownerTrustStore,
    bootstrapReceipt,
    genesisEnvelope: null,
  }));
  return {
    authorization,
    privateKeyPem: rotator.privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
}

function useRotationClock(value) {
  installAutonomousResearchMachineIntakeRotationClockTestDouble(() => new Date(value));
}

function signRotationIntent(document, privateKeyPem) {
  return signAuthorityDocument(document, {
    privateKeyPem,
    keyId: 'intake-rotation-key',
    role: 'autonomous_research_intake_authority_rotator',
  });
}

function intake(label, second = 0) {
  const paperId = `rotation:${label}`;
  return buildAutonomousResearchMachineIntake({
    intakeId: `intake:${paperId}`,
    paperId,
    campaignId: `autonomous-research:${paperId}`,
    launchMode: 'production-run',
    objective: `Evaluate the bounded offline authority rotation ${label} fixture.`,
    protocolFamily: 'ml_algorithm_benchmark',
    datasetMounts: [{
      name: `dataset-${label}`,
      source: `/datasets/${label}`,
      readOnly: true,
      manifestHash: H(`dataset:${label}`),
      licenseId: 'CC0-1.0',
      benchmarkFamily: 'ml_algorithm_benchmark',
    }],
    budgets: BUDGETS,
    providerConfigurationHash: H('provider'),
    revisionRounds: 2,
    refereeCount: 3,
    admissionCreatedAt: new Date(BASE.getTime() + second * 1000).toISOString(),
  });
}

function targetFiles(root) {
  const datasetSource = path.join(root, 'registered-dataset');
  const profilePath = path.join(root, 'producer-profile.json');
  const configPath = path.join(root, 'machine-intake-v2.json');
  fs.mkdirSync(datasetSource, { mode: 0o700 });
  fs.writeFileSync(path.join(datasetSource, 'observations.csv'), 'x,y\n1,2\n', { mode: 0o600 });
  const datasetManifest = inspectStrictDatasetManifest(datasetSource, root);
  assert.deepEqual(datasetManifest.blockers, []);
  const profile = buildAutonomousResearchTopicProducerProfile({
    producerId: 'rotation-producer',
    implementationSha256: inspectAutonomousResearchTopicProducerImplementationIdentity()
      .implementationSha256,
    providerConfigurationHash: H('provider'),
    minimumGenerationIntervalMs: 60 * 60 * 1000,
    maximumTopicsPerUtcDay: 12,
    maximumProviderCanaryAttemptsPerUtcDay: 24,
    maximumProviderCanaryCostUsdPerUtcDay: 24,
    registeredResearchProfiles: [{
      profileId: 'rotation-profile',
      objective: 'Evaluate the registered bounded authority rotation benchmark.',
      protocolFamily: 'ml_algorithm_benchmark',
      datasetMounts: [{
        name: 'rotation-dataset',
        source: datasetSource,
        readOnly: true,
        manifestHash: datasetManifest.hash,
        licenseId: 'CC0-1.0',
        benchmarkFamily: 'ml_algorithm_benchmark',
      }],
      budgets: BUDGETS,
      revisionRounds: 2,
      refereeCount: 3,
    }],
  });
  const configuration = buildAutonomousResearchMachineIntakeConfiguration({
    machineAppendEnabled: true,
    machineProducerProfileHash: profile.producerProfileHash,
  });
  writeJson(profilePath, profile);
  writeJson(configPath, configuration);
  return { datasetRoot: root, profilePath, configPath, profile, configuration };
}

function persistedRows(databasePath) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return {
      intakes: database.prepare(
        'SELECT * FROM autonomous_research_machine_intake ORDER BY intake_id',
      ).all(),
      leases: database.prepare(
        'SELECT * FROM autonomous_research_machine_intake_lease ORDER BY intake_id',
      ).all(),
      daily: database.prepare(
        'SELECT * FROM autonomous_research_machine_intake_daily_admission ORDER BY epoch_start',
      ).all(),
      metadata: database.prepare(
        'SELECT * FROM autonomous_research_machine_intake_metadata WHERE singleton=1',
      ).get(),
      journal: database.prepare(`SELECT * FROM sqlite_master WHERE type='table'
        AND name='autonomous_research_machine_intake_authority_rotation'`).get()
        ? database.prepare(`SELECT * FROM
          autonomous_research_machine_intake_authority_rotation
          ORDER BY authority_generation`).all() : [],
    };
  } finally { database.close(); }
}

test('authority metadata readers and binders fail closed across legacy and conflicting state', () => {
  const empty = new DatabaseSync(':memory:');
  try {
    assert.equal(readConfiguredSourceAuthorityHash(empty), null);
    assert.equal(readAuthorizedMachineProducerProfileHash(empty), null);
    assert.equal(readMachineIntakeAuthorityGeneration(empty), null);

    empty.exec(`CREATE TABLE autonomous_research_machine_intake_metadata (
      singleton INTEGER PRIMARY KEY,
      configured_source_authority_hash TEXT NOT NULL
    ) STRICT;`);
    empty.prepare(`INSERT INTO autonomous_research_machine_intake_metadata(
      singleton,configured_source_authority_hash
    ) VALUES(1,?)`).run(H('legacy-source'));
    assert.equal(readConfiguredSourceAuthorityHash(empty), H('legacy-source'));
    assert.equal(readAuthorizedMachineProducerProfileHash(empty), null);
    assert.equal(readMachineIntakeAuthorityGeneration(empty), 1);
    empty.prepare(`UPDATE autonomous_research_machine_intake_metadata
      SET configured_source_authority_hash='not-a-hash' WHERE singleton=1`).run();
    assert.throws(
      () => readConfiguredSourceAuthorityHash(empty),
      /autonomous_research_machine_intake_state_invalid/,
    );
  } finally { empty.close(); }

  const database = new DatabaseSync(':memory:');
  try {
    createMachineIntakeSchema(database);
    assert.throws(
      () => bindConfiguredSourceAuthorityHash(database, 'not-a-hash'),
      /source_authority_required/,
    );
    assert.throws(
      () => bindAuthorizedMachineProducerProfileHash(database, 'not-a-hash'),
      /producer_profile_hash_invalid/,
    );

    const configured = H('configured-source');
    const profile = H('producer-profile');
    assert.equal(bindConfiguredSourceAuthorityHash(database, configured), configured);
    assert.equal(bindConfiguredSourceAuthorityHash(database, configured), configured);
    assert.throws(
      () => bindConfiguredSourceAuthorityHash(database, H('different-source')),
      /configuration_authority_mismatch/,
    );
    assert.equal(bindAuthorizedMachineProducerProfileHash(database, profile), profile);
    assert.equal(bindAuthorizedMachineProducerProfileHash(database, profile), profile);
    assert.throws(
      () => bindAuthorizedMachineProducerProfileHash(database, H('different-profile')),
      /producer_authority_mismatch/,
    );

    database.prepare(`UPDATE autonomous_research_machine_intake_metadata
      SET authorized_machine_producer_profile_hash='invalid' WHERE singleton=1`).run();
    assert.throws(
      () => readAuthorizedMachineProducerProfileHash(database),
      /autonomous_research_machine_intake_state_invalid/,
    );
    database.exec('PRAGMA ignore_check_constraints=ON;');
    database.prepare(`UPDATE autonomous_research_machine_intake_metadata
      SET authority_generation=0 WHERE singleton=1`).run();
    assert.throws(
      () => readMachineIntakeAuthorityGeneration(database),
      /autonomous_research_machine_intake_state_invalid/,
    );
  } finally { database.close(); }

  const insertIntake = (database, {
    id, sourceAuthorityHash, admission,
  }) => database.prepare(`INSERT INTO autonomous_research_machine_intake(
    intake_id,intake_hash,paper_id,campaign_id,intake_json,admission_json,
    admission_hash,source_kind,source_ref,source_authority_hash,disposition,
    next_attempt_at,created_at,updated_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, H(`intake:${id}`), `paper:${id}`, `campaign:${id}`, '{}',
    JSON.stringify(admission), H(`admission:${id}`), 'machine', 'machine-api',
    sourceAuthorityHash, 'pending', BASE.toISOString(), BASE.toISOString(),
    BASE.toISOString(),
  );

  const ambiguous = new DatabaseSync(':memory:');
  try {
    createMachineIntakeSchema(ambiguous);
    insertIntake(ambiguous, {
      id: 'one', sourceAuthorityHash: H('source-one'), admission: {},
    });
    insertIntake(ambiguous, {
      id: 'two', sourceAuthorityHash: H('source-two'), admission: {},
    });
    assert.throws(
      () => bindConfiguredSourceAuthorityHash(ambiguous, H('source-one')),
      /configuration_authority_ambiguous/,
    );
  } finally { ambiguous.close(); }

  const legacy = new DatabaseSync(':memory:');
  try {
    createMachineIntakeSchema(legacy);
    insertIntake(legacy, {
      id: 'legacy', sourceAuthorityHash: H('legacy-source'), admission: {},
    });
    assert.throws(
      () => bindConfiguredSourceAuthorityHash(legacy, H('new-source')),
      /configuration_authority_mismatch/,
    );
    assert.equal(
      bindConfiguredSourceAuthorityHash(legacy, H('legacy-source')),
      H('legacy-source'),
    );
    assert.throws(
      () => bindAuthorizedMachineProducerProfileHash(legacy, H('new-profile')),
      /legacy_machine_admission_quarantine_required/,
    );
    legacy.prepare(`UPDATE autonomous_research_machine_intake
      SET admission_json=? WHERE intake_id='legacy'`).run(JSON.stringify({
      version: 2,
      topicProducerCapabilityReceipt: { producerProfileHash: H('new-profile') },
    }));
    assert.equal(
      bindAuthorizedMachineProducerProfileHash(legacy, H('new-profile')),
      H('new-profile'),
    );
  } finally { legacy.close(); }
});

test('production rotation authorization loads an isolated authority root and verifies intent',
  (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-rotation-authorization-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const authorityRoot = path.join(root, 'authority-rotation');
    fs.mkdirSync(authorityRoot, { recursive: true, mode: 0o700 });
    const previousConfigurationHash = H('authorization-previous-configuration');
    const authorityFixture = rotationAuthority(previousConfigurationHash);
    writeJson(
      path.join(authorityRoot, 'AUTHORITY_TRUST_STORE.json'),
      authorityFixture.authorization.rotationTrustStore,
    );
    writeJson(
      path.join(authorityRoot, 'OWNER_TRUST_STORE.json'),
      authorityFixture.authorization.ownerTrustStore,
    );
    writeJson(
      path.join(authorityRoot, 'AUTONOMOUS_RESEARCH_INTAKE_AUTHORITY_BOOTSTRAP.json'),
      authorityFixture.authorization.bootstrapReceipt,
    );
    const authorization = loadAutonomousResearchIntakeRotationAuthorizationAtRootForTest({
      authorityRoot,
      productionAuthority: false,
      previousConfigurationHash,
      expectedAuthorityGeneration: 1,
      now: BASE,
    });
    assert.equal(authorization.authorityRoot, authorityRoot);
    assert.equal(authorization.privateKeyLoaded, false);
    assert.equal(authorization.bootstrapVerifiedSigners.length, 2);

    const plan = Object.freeze({
      transition: 'v1_to_v2',
      planHash: H('authorization-plan'),
      previousConfigurationHash,
      previousProducerProfileHash: H('authorization-previous-profile'),
      previousRotationReceiptHash: null,
      nextConfigurationHash: H('authorization-next-configuration'),
      nextProducerProfileHash: H('authorization-next-profile'),
      nextProviderConfigurationHash: H('authorization-next-provider'),
      nextImplementationSha256: H('authorization-next-implementation'),
      expectedAuthorityGeneration: 1,
      nextAuthorityGeneration: 2,
      preStateHash: H('authorization-pre-state'),
      quiescenceStateHash: H('authorization-quiescence-state'),
      postStateHash: H('authorization-post-state'),
      authorityTrustStoreHash: authorization.rotationTrustStoreHash,
      bootstrapReceiptHash: authorization.bootstrapReceiptHash,
      authorityAnchorHash: authorization.authorityAnchorHash,
      rotatorKeySnapshotHash: authorization.rotatorKeySnapshotHash,
    });
    const signedAt = new Date(BASE.getTime() + 2000);
    const template = buildProductionAutonomousResearchIntakeRotationIntentTemplate(
      plan,
      signedAt,
    );
    assert.equal(template.signedAt, signedAt.toISOString());
    assert.match(template.nonce, /^rotation:/);
    const intent = signRotationIntent(template, authorityFixture.privateKeyPem);
    const intentPath = path.join(root, 'rotation-intent.json');
    writeJson(intentPath, intent);
    const verified = verifyProductionAutonomousResearchIntakeRotationIntent({
      rotationIntentPath: intentPath,
      plan,
      authorization,
      now: signedAt,
    });
    assert.equal(verified.signer.subjectId, 'intake-rotation-operator');
    assert.equal(
      verified.intentHash,
      hashRecord('AutonomousResearchMachineIntakeAuthorityRotationIntent', intent),
    );

    assert.throws(() => buildProductionAutonomousResearchIntakeRotationIntentTemplate(
      plan,
      'not-a-date',
    ), /authority_rotation_clock_invalid/);
    writeJson(intentPath, { ...intent, unexpected: true });
    assert.throws(() => verifyProductionAutonomousResearchIntakeRotationIntent({
      rotationIntentPath: intentPath,
      plan,
      authorization,
      now: signedAt,
    }), /rotation_intent_structure_invalid/);
    assert.throws(() => verifyProductionAutonomousResearchIntakeRotationIntent({
      rotationIntentPath: path.join(root, 'missing-intent.json'),
      plan,
      authorization,
      now: signedAt,
    }), /authority_rotation_intent_invalid/);
  });

test('offline v1-to-v2 rotation is plan-bound, quiescent, atomic, and preserves durable state', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-intake-authority-rotation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtimeRoot = path.join(root, 'runtime');
  const initial = buildAutonomousResearchMachineIntakeConfiguration({
    machineAppendEnabled: true,
  });
  const repository = createAutonomousResearchMachineIntakeRepository({
    runtimeRoot,
    authorizedSourceAuthorityHash: initial.configurationHash,
  });
  const pending = repository.appendMachineIntake({
    intake: intake('pending'),
    sourceAuthorityHash: initial.configurationHash,
    now: BASE,
  }).record;
  const expiredLease = repository.tryAcquireIntakeLease({
    intakeId: pending.intakeId,
    ownerId: 'rotation:expired-owner',
    leaseMs: 1000,
    now: BASE,
  });
  const enqueued = repository.appendMachineIntake({
    intake: intake('enqueued', 1),
    sourceAuthorityHash: initial.configurationHash,
    now: new Date(BASE.getTime() + 1000),
  }).record;
  const enqueueLease = repository.tryAcquireIntakeLease({
    intakeId: enqueued.intakeId,
    ownerId: 'rotation:enqueue-owner',
    leaseMs: 5000,
    now: new Date(BASE.getTime() + 1000),
  });
  repository.markIntakeEnqueued({
    intakeId: enqueued.intakeId,
    ...enqueueLease,
    autonomousResearchMachineIntakeAdmissionHash: enqueued.admissionHash,
    campaignPlanHash: H('campaign-plan'),
    autonomousResearchLoopPreparationReportHash: H('preparation'),
    now: new Date(BASE.getTime() + 1500),
  });
  const databasePath = repository.databasePath;
  repository.close();

  const supervisor = createAutonomousResearchSupervisorInstanceRepository({ runtimeRoot });
  const supervisorLease = supervisor.acquireInstanceLease({
    ownerId: 'rotation:resident',
    leaseMs: 5000,
    heartbeatMs: 1000,
    now: BASE,
  });
  const target = targetFiles(root);
  const authorityBeforeRejectedReopen = persistedRows(databasePath);
  assert.throws(() => createAutonomousResearchMachineIntakeRepository({
    runtimeRoot,
    authorizedSourceAuthorityHash: initial.configurationHash,
    authorizedMachineProducerProfileHash: target.profile.producerProfileHash,
    machineProducerAppendAuthority: { consumeAppendAuthorization() {} },
  }), /producer_authority_mismatch/);
  assert.deepEqual(
    persistedRows(databasePath).metadata,
    authorityBeforeRejectedReopen.metadata,
  );
  const authority = rotationAuthority(initial.configurationHash);
  const intentPath = path.join(root, 'rotation-intent.json');
  const options = {
    runtimeRoot,
    nextConfigurationPath: target.configPath,
    topicProducerProfilePath: target.profilePath,
    environment: {
      HEPTA_AUTONOMOUS_RESEARCH_DATASET_ROOT: target.datasetRoot,
    },
    rotationIntentPath: intentPath,
  };
  useRotationClock(new Date(BASE.getTime() + 500));
  const active = planAutonomousResearchMachineIntakeAuthorityRotation({
    ...options,
  });
  assert.equal(active.ready, false);
  assert.match(active.blockers.join(','), /supervisor_active/);
  assert.match(active.blockers.join(','), /machine_lease_active/);
  assert.equal(supervisor.releaseInstanceLease({
    lease: supervisorLease,
    now: new Date(BASE.getTime() + 500),
  }), true);
  supervisor.close();

  const planTime = new Date(BASE.getTime() + 2000);
  const beforeStat = fs.statSync(databasePath);
  const beforeEntries = fs.readdirSync(path.dirname(databasePath)).sort();
  useRotationClock(planTime);
  const planned = planAutonomousResearchMachineIntakeAuthorityRotation({
    ...options,
  });
  assert.equal(planned.ready, true, planned.blockers.join(','));
  assert.equal(planned.plan.expectedAuthorityGeneration, 1);
  assert.equal(planned.plan.quarantinedLegacyMachineIntakeIds.length, 1);
  assert.equal(fs.statSync(databasePath).mtimeMs, beforeStat.mtimeMs);
  assert.deepEqual(fs.readdirSync(path.dirname(databasePath)).sort(), beforeEntries);
  const durableBefore = persistedRows(databasePath);
  const validIntent = signRotationIntent(
    planned.rotationIntentTemplate,
    authority.privateKeyPem,
  );
  writeJson(intentPath, validIntent);
  const staleRepository = createAutonomousResearchMachineIntakeRepository({
    runtimeRoot,
    authorizedSourceAuthorityHash: initial.configurationHash,
  });
  t.after(() => {
    try { staleRepository.close(); } catch { /* already closed */ }
  });

  assert.throws(() => applyAutonomousResearchMachineIntakeAuthorityRotation({
    ...options,
    planHash: H('forged-plan'),
    expectedAuthorityGeneration: 1,
    execute: true,
  }), /plan_mismatch/);
  assert.deepEqual(persistedRows(databasePath), durableBefore);

  const attacker = crypto.generateKeyPairSync('ed25519').privateKey.export({
    type: 'pkcs8',
    format: 'pem',
  });
  writeJson(intentPath, signRotationIntent(planned.rotationIntentTemplate, attacker));
  assert.throws(() => applyAutonomousResearchMachineIntakeAuthorityRotation({
    ...options,
    planHash: planned.plan.planHash,
    expectedAuthorityGeneration: 1,
    execute: true,
  }), /authority_signature_invalid/);
  assert.deepEqual(persistedRows(databasePath), durableBefore);

  writeJson(intentPath, signRotationIntent({
    ...planned.rotationIntentTemplate,
    previousConfigurationHash: H('wrong-previous-configuration'),
  }, authority.privateKeyPem));
  assert.throws(() => applyAutonomousResearchMachineIntakeAuthorityRotation({
    ...options,
    planHash: planned.plan.planHash,
    expectedAuthorityGeneration: 1,
    execute: true,
  }), /rotation_intent_plan_binding_mismatch/);
  assert.deepEqual(persistedRows(databasePath), durableBefore);

  writeJson(intentPath, signRotationIntent({
    ...planned.rotationIntentTemplate,
    signedAt: '2026-07-15T00:00:00.000Z',
    validFrom: '2026-07-15T00:00:00.000Z',
    expiresAt: '2026-07-16T00:00:00.000Z',
  }, authority.privateKeyPem));
  assert.throws(() => applyAutonomousResearchMachineIntakeAuthorityRotation({
    ...options,
    planHash: planned.plan.planHash,
    expectedAuthorityGeneration: 1,
    execute: true,
  }), /authority_expired/);
  assert.deepEqual(persistedRows(databasePath), durableBefore);
  writeJson(intentPath, validIntent);

  const crashDatabase = new DatabaseSync(databasePath);
  crashDatabase.exec(`CREATE TRIGGER rotation_test_metadata_failure
    BEFORE UPDATE ON autonomous_research_machine_intake_metadata
    BEGIN SELECT RAISE(ABORT, 'injected-crash'); END;`);
  crashDatabase.close();
  assert.throws(() => applyAutonomousResearchMachineIntakeAuthorityRotation({
    ...options,
    planHash: planned.plan.planHash,
    expectedAuthorityGeneration: 1,
    execute: true,
  }), /injected-crash/);
  assert.deepEqual(persistedRows(databasePath), durableBefore);
  const recoveryDatabase = new DatabaseSync(databasePath);
  recoveryDatabase.exec('DROP TRIGGER rotation_test_metadata_failure;');
  recoveryDatabase.close();

  const applied = applyAutonomousResearchMachineIntakeAuthorityRotation({
    ...options,
    planHash: planned.plan.planHash,
    expectedAuthorityGeneration: 1,
    execute: true,
  });
  assert.equal(applied.ready, true);
  assert.equal(applied.receipt.authorityGeneration, 2);
  assert.equal(applied.receipt.previousRotationReceiptHash, null);
  assert.equal(applied.receipt.rotationIntentNonce, validIntent.nonce);
  assert.equal(applied.receipt.authorityTrustStoreHash,
    planned.plan.authorityTrustStoreHash);
  assert.equal(applied.receipt.verifiedSignerIdentity.subjectId,
    'intake-rotation-operator');
  const durableAfter = persistedRows(databasePath);
  assert.throws(() => staleRepository.appendMachineIntake({
    intake: intake('stale-open', 2),
    sourceAuthorityHash: initial.configurationHash,
    now: planTime,
  }), /repository_authority_stale/);
  assert.throws(() => staleRepository.reconcileExpiredIntakeLeases({ now: planTime }),
    /repository_authority_stale/);
  assert.deepEqual(persistedRows(databasePath), durableAfter);
  staleRepository.close();
  assert.deepEqual(durableAfter.daily, durableBefore.daily);
  assert.deepEqual(durableAfter.leases, durableBefore.leases);
  assert.equal(durableAfter.intakes.length, durableBefore.intakes.length);
  const enqueuedBefore = durableBefore.intakes.find((row) => row.intake_id === enqueued.intakeId);
  const enqueuedAfter = durableAfter.intakes.find((row) => row.intake_id === enqueued.intakeId);
  assert.deepEqual(enqueuedAfter, enqueuedBefore);
  const quarantined = durableAfter.intakes.find((row) => row.intake_id === pending.intakeId);
  assert.equal(quarantined.disposition, 'invalid');
  assert.match(quarantined.invalid_reason, /legacy_machine_quarantine/);
  assert.equal(quarantined.admission_json,
    durableBefore.intakes.find((row) => row.intake_id === pending.intakeId).admission_json);
  assert.equal(durableAfter.metadata.configured_source_authority_hash,
    target.configuration.configurationHash);
  assert.equal(durableAfter.metadata.authorized_machine_producer_profile_hash,
    target.profile.producerProfileHash);
  assert.equal(Number(durableAfter.metadata.authority_generation), 2);
  assert.equal(durableAfter.journal.length, 1);
  assert.equal(durableAfter.journal[0].rotation_receipt_hash,
    applied.receipt.rotationReceiptHash);
  assert.equal(durableAfter.journal[0].previous_rotation_receipt_hash, null);
  assert.equal(durableAfter.journal[0].rotation_intent_hash,
    applied.receipt.rotationIntentHash);
  assert.equal(durableAfter.journal[0].intent_nonce, validIntent.nonce);
  assert.equal(durableAfter.journal[0].verified_signer_subject_id,
    'intake-rotation-operator');
  assert.equal(JSON.parse(durableAfter.journal[0].plan_json).planHash,
    planned.plan.planHash);
  assert.equal(JSON.parse(durableAfter.journal[0].bootstrap_receipt_json).kind,
    'AutonomousResearchMachineIntakeAuthorityRotationBootstrapReceipt');
  assert.equal(JSON.parse(
    durableAfter.journal[0].rotator_public_key_snapshot_json,
  )[0].keyId, 'intake-rotation-key');
  assert.equal(durableAfter.metadata.last_authority_rotation_receipt_hash,
    applied.receipt.rotationReceiptHash);

  const database = new DatabaseSync(databasePath);
  assert.throws(() => database.exec(
    'DELETE FROM autonomous_research_machine_intake_authority_rotation;',
  ), /append_only/);
  database.close();
  const restarted = createAutonomousResearchMachineIntakeRepository({
    runtimeRoot,
    authorizedSourceAuthorityHash: target.configuration.configurationHash,
    authorizedMachineProducerProfileHash: target.profile.producerProfileHash,
    machineProducerAppendAuthority: { consumeAppendAuthorization() {} },
  });
  assert.equal(restarted.readStatus().configuredAuthorityGeneration, 2);
  restarted.close();
  assert.throws(() => applyAutonomousResearchMachineIntakeAuthorityRotation({
    ...options,
    planHash: planned.plan.planHash,
    expectedAuthorityGeneration: 1,
    execute: true,
  }), /bootstrap_invalid|plan_mismatch/);
  assert.deepEqual(persistedRows(databasePath), durableAfter);
  assert.equal(expiredLease.leaseGeneration,
    Number(durableAfter.leases[0].lease_generation));

  const persistedReceipt = JSON.parse(durableAfter.journal[0].rotation_receipt_json);
  const { rotationReceiptHash: _rotationReceiptHash, ...persistedReceiptPayload }
    = persistedReceipt;
  const tamperedAt = new Date(Date.parse(validIntent.validFrom) + 60_000).toISOString();
  const tamperedReceiptPayload = { ...persistedReceiptPayload, rotatedAt: tamperedAt };
  const tamperedReceipt = {
    ...tamperedReceiptPayload,
    rotationReceiptHash: hashRecord(
      'AutonomousResearchMachineIntakeAuthorityRotationReceipt',
      tamperedReceiptPayload,
    ),
  };
  const tamperDatabase = new DatabaseSync(databasePath);
  tamperDatabase.exec(`DROP TRIGGER
    autonomous_research_machine_intake_authority_rotation_no_update;`);
  tamperDatabase.prepare(`UPDATE autonomous_research_machine_intake_authority_rotation SET
    rotated_at=?,rotation_receipt_json=?,rotation_receipt_hash=? WHERE authority_generation=2`)
    .run(tamperedAt, JSON.stringify(tamperedReceipt), tamperedReceipt.rotationReceiptHash);
  tamperDatabase.prepare(`UPDATE autonomous_research_machine_intake_metadata SET
    last_authority_rotation_receipt_hash=? WHERE singleton=1`)
    .run(tamperedReceipt.rotationReceiptHash);
  tamperDatabase.close();
  assert.throws(() => createAutonomousResearchMachineIntakeRepository({
    runtimeRoot,
    authorizedSourceAuthorityHash: target.configuration.configurationHash,
    authorizedMachineProducerProfileHash: target.profile.producerProfileHash,
    machineProducerAppendAuthority: { consumeAppendAuthorization() {} },
  }), /authority_state_invalid/);
});

test('rotation plan rejects a live producer lease and outstanding generation', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-intake-topic-quiescence-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtimeRoot = path.join(root, 'runtime');
  const initial = buildAutonomousResearchMachineIntakeConfiguration({
    machineAppendEnabled: true,
  });
  createAutonomousResearchMachineIntakeRepository({
    runtimeRoot,
    authorizedSourceAuthorityHash: initial.configurationHash,
  }).close();
  rotationAuthority(initial.configurationHash);
  useRotationClock(new Date(BASE.getTime() + 500));
  const target = targetFiles(root);
  const topic = createAutonomousResearchTopicProducerRepository({
    runtimeRoot,
    machineIntakeConfigurationHash: target.configuration.configurationHash,
    producerProfile: target.profile,
    providerCanaryPairMaximumCostUsd: 1,
    liveMutationAuthority: { consume() {} },
  });
  t.after(() => topic.close());
  const lease = topic.tryAcquireLease({
    ownerId: 'rotation:topic-producer',
    leaseMs: 5000,
    now: BASE,
  });
  assert.ok(topic.prepareGeneration({ lease, now: BASE }));
  const active = planAutonomousResearchMachineIntakeAuthorityRotation({
    runtimeRoot,
    nextConfigurationPath: target.configPath,
    topicProducerProfilePath: target.profilePath,
    environment: {
      HEPTA_AUTONOMOUS_RESEARCH_DATASET_ROOT: target.datasetRoot,
    },
  });
  assert.equal(active.ready, false);
  assert.match(active.blockers.join(','), /topic_lease_active/);
  assert.match(active.blockers.join(','), /topic_generation_outstanding/);
  assert.equal(topic.releaseLease({ lease }), true);
  const outstanding = planAutonomousResearchMachineIntakeAuthorityRotation({
    runtimeRoot,
    nextConfigurationPath: target.configPath,
    topicProducerProfilePath: target.profilePath,
    environment: {
      HEPTA_AUTONOMOUS_RESEARCH_DATASET_ROOT: target.datasetRoot,
    },
  });
  assert.equal(outstanding.ready, false);
  assert.doesNotMatch(outstanding.blockers.join(','), /topic_lease_active/);
  assert.match(outstanding.blockers.join(','), /topic_generation_outstanding/);
});

test('production rotation surface rejects caller-controlled clocks', () => {
  assert.throws(() => planAutonomousResearchMachineIntakeAuthorityRotation({
    now: BASE,
  }), /clock_override_forbidden/);
  assert.throws(() => applyAutonomousResearchMachineIntakeAuthorityRotation({
    now: BASE,
  }), /test_override_forbidden/);
});

test('locked revalidation rejects an intent that expires after the early check', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-intake-lock-expiry-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtimeRoot = path.join(root, 'runtime');
  const initial = buildAutonomousResearchMachineIntakeConfiguration({
    machineAppendEnabled: true,
  });
  const repository = createAutonomousResearchMachineIntakeRepository({
    runtimeRoot,
    authorizedSourceAuthorityHash: initial.configurationHash,
  });
  const databasePath = repository.databasePath;
  repository.close();
  const target = targetFiles(root);
  const authority = rotationAuthority(initial.configurationHash);
  const intentPath = path.join(root, 'short-lived-rotation-intent.json');
  const options = {
    runtimeRoot,
    nextConfigurationPath: target.configPath,
    topicProducerProfilePath: target.profilePath,
    rotationIntentPath: intentPath,
    environment: { HEPTA_AUTONOMOUS_RESEARCH_DATASET_ROOT: target.datasetRoot },
  };
  useRotationClock('2026-07-17T00:00:02.000Z');
  const planned = planAutonomousResearchMachineIntakeAuthorityRotation(options);
  assert.equal(planned.ready, true, planned.blockers.join(','));
  writeJson(intentPath, signRotationIntent({
    ...planned.rotationIntentTemplate,
    expiresAt: '2026-07-17T00:00:03.000Z',
  }, authority.privateKeyPem));
  const before = persistedRows(databasePath);
  const times = [
    new Date('2026-07-17T00:00:02.500Z'),
    new Date('2026-07-17T00:00:03.500Z'),
  ];
  installAutonomousResearchMachineIntakeRotationClockTestDouble(() => times.shift()
    || new Date('2026-07-17T00:00:03.500Z'));
  assert.throws(() => applyAutonomousResearchMachineIntakeAuthorityRotation({
    ...options,
    planHash: planned.plan.planHash,
    expectedAuthorityGeneration: 1,
    execute: true,
  }), /authority_expired/);
  assert.deepEqual(persistedRows(databasePath), before);
});

test('rotation rejects malformed lease and corrupt intake evidence', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-intake-corrupt-state-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtimeRoot = path.join(root, 'runtime');
  const initial = buildAutonomousResearchMachineIntakeConfiguration({
    machineAppendEnabled: true,
  });
  const repository = createAutonomousResearchMachineIntakeRepository({
    runtimeRoot,
    authorizedSourceAuthorityHash: initial.configurationHash,
  });
  const record = repository.appendMachineIntake({
    intake: intake('corrupt-state'),
    sourceAuthorityHash: initial.configurationHash,
    now: BASE,
  }).record;
  repository.tryAcquireIntakeLease({
    intakeId: record.intakeId,
    ownerId: 'rotation:corrupt-state',
    leaseMs: 1000,
    now: BASE,
  });
  const databasePath = repository.databasePath;
  repository.close();
  const target = targetFiles(root);
  rotationAuthority(initial.configurationHash);
  useRotationClock('2026-07-17T00:00:02.000Z');
  const options = {
    runtimeRoot,
    nextConfigurationPath: target.configPath,
    topicProducerProfilePath: target.profilePath,
    environment: { HEPTA_AUTONOMOUS_RESEARCH_DATASET_ROOT: target.datasetRoot },
  };
  const database = new DatabaseSync(databasePath);
  const original = database.prepare(`SELECT intake_json,admission_json,admission_hash FROM
    autonomous_research_machine_intake WHERE intake_id=?`).get(record.intakeId);
  const leaseExpiry = database.prepare(`SELECT expires_at FROM
    autonomous_research_machine_intake_lease WHERE intake_id=?`).get(record.intakeId).expires_at;
  const rejectPlan = () => assert.throws(
    () => planAutonomousResearchMachineIntakeAuthorityRotation(options),
    /rotation_state_invalid/,
  );
  database.prepare(`UPDATE autonomous_research_machine_intake_lease SET expires_at=?
    WHERE intake_id=?`).run('not-a-time', record.intakeId);
  rejectPlan();
  database.prepare(`UPDATE autonomous_research_machine_intake_lease SET expires_at=?
    WHERE intake_id=?`).run(leaseExpiry, record.intakeId);
  database.prepare(`UPDATE autonomous_research_machine_intake SET intake_json='garbage'
    WHERE intake_id=?`).run(record.intakeId);
  rejectPlan();
  database.prepare(`UPDATE autonomous_research_machine_intake SET intake_json=?
    WHERE intake_id=?`).run(original.intake_json, record.intakeId);
  database.prepare(`UPDATE autonomous_research_machine_intake SET admission_json='garbage'
    WHERE intake_id=?`).run(record.intakeId);
  rejectPlan();
  database.prepare(`UPDATE autonomous_research_machine_intake SET admission_json=?,
    admission_hash=? WHERE intake_id=?`).run(
    original.admission_json,
    H('corrupt-admission-binding'),
    record.intakeId,
  );
  rejectPlan();
  database.close();
});

test('repository startup rejects forged generation-two metadata without a journal', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-intake-forged-authority-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtimeRoot = path.join(root, 'runtime');
  const initial = buildAutonomousResearchMachineIntakeConfiguration({
    machineAppendEnabled: true,
  });
  const repository = createAutonomousResearchMachineIntakeRepository({
    runtimeRoot,
    authorizedSourceAuthorityHash: initial.configurationHash,
  });
  const databasePath = repository.databasePath;
  repository.close();
  const target = targetFiles(root);
  const database = new DatabaseSync(databasePath);
  database.prepare(`UPDATE autonomous_research_machine_intake_metadata SET
    configured_source_authority_hash=?,authorized_machine_producer_profile_hash=?,
    authority_generation=2,last_authority_rotation_receipt_hash=? WHERE singleton=1`).run(
    target.configuration.configurationHash,
    target.profile.producerProfileHash,
    H('forged-rotation-receipt'),
  );
  database.close();
  assert.throws(() => createAutonomousResearchMachineIntakeRepository({
    runtimeRoot,
    authorizedSourceAuthorityHash: target.configuration.configurationHash,
    authorizedMachineProducerProfileHash: target.profile.producerProfileHash,
    machineProducerAppendAuthority: { consumeAppendAuthorization() {} },
  }), /authority_state_invalid/);
});

test('fresh v2 authority initialization is atomic, retryable, and fixed-anchor bound', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-intake-genesis-retry-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const mode of ['zero-byte', 'empty-schema']) {
    const caseRoot = path.join(root, mode);
    const runtimeRoot = path.join(caseRoot, 'runtime');
    const stateRoot = path.join(runtimeRoot, 'autonomous-research', 'machine-intake');
    const databasePath = path.join(stateRoot, 'machine-intake.sqlite');
    fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
    if (mode === 'zero-byte') {
      fs.closeSync(fs.openSync(databasePath, 'wx', 0o600));
    } else {
      const empty = new DatabaseSync(databasePath);
      createMachineIntakeSchema(empty);
      empty.close();
      fs.chmodSync(databasePath, 0o600);
    }
    const target = targetFiles(caseRoot);
    const documents = installMachineIntakeExternalGenesisAuthority({
      configurationHash: target.configuration.configurationHash,
      producerProfileHash: target.profile.producerProfileHash,
    });
    if (mode === 'zero-byte') {
      installAutonomousResearchMachineIntakeExternalAuthorityTestDouble(() => {
        throw new Error('injected-external-authority-read-failure');
      });
      assert.throws(() => createAutonomousResearchMachineIntakeRepository({
        runtimeRoot,
        authorizedSourceAuthorityHash: target.configuration.configurationHash,
        authorizedMachineProducerProfileHash: target.profile.producerProfileHash,
        machineProducerAppendAuthority: { consumeAppendAuthorization() {} },
      }), /injected-external-authority-read-failure/);
      const rolledBack = new DatabaseSync(databasePath, { readOnly: true });
      assert.equal(rolledBack.prepare(`SELECT COUNT(*) AS count FROM sqlite_master
        WHERE type='table' AND name NOT LIKE 'sqlite_%'`).get().count, 0);
      rolledBack.close();
      installAutonomousResearchMachineIntakeExternalAuthorityTestDouble(() => documents);
    }
    const repository = createAutonomousResearchMachineIntakeRepository({
      runtimeRoot,
      authorizedSourceAuthorityHash: target.configuration.configurationHash,
      authorizedMachineProducerProfileHash: target.profile.producerProfileHash,
      machineProducerAppendAuthority: { consumeAppendAuthorization() {} },
    });
    assert.equal(repository.readStatus().configuredAuthorityGeneration, 1);
    repository.close();
    if (mode === 'zero-byte') {
      const replaced = structuredClone(documents);
      replaced.ownerTrustStore.keys[0].subjectId = 'attacker-replaced-owner';
      installAutonomousResearchMachineIntakeExternalAuthorityTestDouble(() => replaced);
      assert.throws(() => createAutonomousResearchMachineIntakeRepository({
        runtimeRoot,
        authorizedSourceAuthorityHash: target.configuration.configurationHash,
        authorizedMachineProducerProfileHash: target.profile.producerProfileHash,
        machineProducerAppendAuthority: { consumeAppendAuthorization() {} },
      }), /authority_state_invalid/);
    }
  }

  const malformedRoot = path.join(root, 'malformed-empty-schema');
  const malformedRuntimeRoot = path.join(malformedRoot, 'runtime');
  const malformedStateRoot = path.join(
    malformedRuntimeRoot,
    'autonomous-research',
    'machine-intake',
  );
  const malformedDatabasePath = path.join(malformedStateRoot, 'machine-intake.sqlite');
  fs.mkdirSync(malformedStateRoot, { recursive: true, mode: 0o700 });
  const malformed = new DatabaseSync(malformedDatabasePath);
  malformed.exec(`CREATE TABLE autonomous_research_machine_intake (
    intake_id TEXT PRIMARY KEY
  ) STRICT;`);
  malformed.close();
  fs.chmodSync(malformedDatabasePath, 0o600);
  const malformedTarget = targetFiles(malformedRoot);
  installMachineIntakeExternalGenesisAuthority({
    configurationHash: malformedTarget.configuration.configurationHash,
    producerProfileHash: malformedTarget.profile.producerProfileHash,
  });
  assert.throws(() => createAutonomousResearchMachineIntakeRepository({
    runtimeRoot: malformedRuntimeRoot,
    authorizedSourceAuthorityHash: malformedTarget.configuration.configurationHash,
    authorizedMachineProducerProfileHash: malformedTarget.profile.producerProfileHash,
    machineProducerAppendAuthority: { consumeAppendAuthorization() {} },
  }), /producer_authority_mismatch/);
  const unchanged = new DatabaseSync(malformedDatabasePath, { readOnly: true });
  assert.deepEqual(unchanged.prepare(`SELECT name,type FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%' ORDER BY name`).all().map((row) => ({ ...row })), [{
    name: 'autonomous_research_machine_intake',
    type: 'table',
  }]);
  unchanged.close();
});

test('fresh v2 root-owned configuration genesis does not require external signers', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-intake-root-owned-genesis-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtimeRoot = path.join(root, 'runtime');
  const target = targetFiles(root);
  installAutonomousResearchMachineIntakeExternalAuthorityTestDouble(() => {
    throw new Error('external-authority-must-not-be-read');
  });
  const repository = createAutonomousResearchMachineIntakeRepository({
    runtimeRoot,
    authorizedSourceAuthorityHash: target.configuration.configurationHash,
    authorizedMachineProducerProfileHash: target.profile.producerProfileHash,
    machineProducerAppendAuthority: { consumeAppendAuthorization() {} },
    genesisAuthorityMode: 'root-owned-configuration',
  });
  assert.equal(repository.readStatus().configuredAuthorityGeneration, 1);
  repository.close();
  const databasePath = path.join(
    runtimeRoot,
    'autonomous-research',
    'machine-intake',
    'machine-intake.sqlite',
  );
  const database = new DatabaseSync(databasePath, { readOnly: true });
  const genesis = database.prepare(`SELECT * FROM
    autonomous_research_machine_intake_authority_genesis WHERE singleton=1`).get();
  database.close();
  assert.equal(genesis.origin, 'fresh-v2-root-owned-configuration');
  assert.equal(
    JSON.parse(genesis.external_genesis_envelope_json).status,
    'root_owned_configuration_genesis_verified',
  );
  assert.deepEqual(JSON.parse(genesis.verified_signers_json), []);
  const restarted = createAutonomousResearchMachineIntakeRepository({
    runtimeRoot,
    authorizedSourceAuthorityHash: target.configuration.configurationHash,
    authorizedMachineProducerProfileHash: target.profile.producerProfileHash,
    machineProducerAppendAuthority: { consumeAppendAuthorization() {} },
  });
  assert.equal(restarted.readStatus().configuredAuthorityGeneration, 1);
  restarted.close();
});
