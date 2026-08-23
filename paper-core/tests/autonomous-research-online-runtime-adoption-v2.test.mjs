import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  executeAutonomousResearchOnlineSchemaTransition,
  planAutonomousResearchOnlineSchemaTransition,
} from '../../paper-adapters/automation/autonomous-research-online-schema-transition.mjs';
import {
  autonomousResearchOnlineSchemaTransitionControlPaths,
  readAutonomousResearchOnlineSchemaTransitionJson,
} from '../../paper-adapters/automation/autonomous-research-online-schema-transition-state-repository.mjs';
import {
  buildAutonomousResearchOnlineSchemaTransitionFinalizeRequest,
  buildAutonomousResearchOnlineSchemaTransitionObserveRequest,
  buildAutonomousResearchOnlineSchemaTransitionReserveRequest,
} from '../../paper-adapters/automation/autonomous-research-online-schema-transition-state.mjs';
import {
  AUTONOMOUS_RESEARCH_ONLINE_AUTHORITY_JOURNAL_SCHEMA_CONTRACT_ID,
  AUTONOMOUS_RESEARCH_ONLINE_AUTHORITY_JOURNAL_SCHEMA_HASH,
  AUTONOMOUS_RESEARCH_ONLINE_AUTHORITY_JOURNAL_SCHEMA_STATEMENTS,
  AUTONOMOUS_RESEARCH_ONLINE_AUTHORITY_JOURNAL_SCHEMA_VERSION,
  AUTONOMOUS_RESEARCH_ONLINE_MUTATION_MARKER_SCHEMA_STATEMENTS,
} from '../../paper-adapters/automation/autonomous-research-online-authority-journal.mjs';
import {
  createAutonomousResearchOnlineSchemaTransitionAuthorityProcessClient,
} from '../../paper-adapters/automation/autonomous-research-online-schema-transition-authority.mjs';
import {
  AUTONOMOUS_RESEARCH_ONLINE_WRITER_OPERATION_MANIFEST,
} from '../../paper-adapters/automation/autonomous-research-online-writer-operation-manifest.mjs';
import {
  inspectAutonomousResearchPristineDatabaseState,
  autonomousResearchPristineRuntimeStateHash,
} from '../../paper-adapters/automation/autonomous-research-pristine-runtime-state.mjs';
import {
  buildAutonomousResearchStatePartialRootWriterQuiescenceReceipt,
  PARTIAL_ROOT_REQUIRED_QUIESCED_SERVICES,
} from '../../paper-adapters/automation/autonomous-research-state-partial-root-maintenance-inspection.mjs';
import {
  resolveAutonomousResearchStateDatabaseInventory,
} from '../../paper-adapters/automation/autonomous-research-state-database-inventory.mjs';
import {
  schemaTransitionExactSchemaHash,
} from '../../paper-adapters/automation/autonomous-research-online-schema-transition-schema.mjs';
import {
  createLocalAutonomousResearchStateAuthority,
} from '../../paper-adapters/automation/local-autonomous-research-state-authority-runtime.mjs';
import {
  buildAutonomousResearchMachineIntakeConfiguration,
} from '../../paper-adapters/automation/autonomous-research-machine-intake-loader.mjs';
import {
  inspectAutonomousResearchTopicProducerImplementationIdentity,
} from '../../paper-adapters/automation/autonomous-research-topic-producer-profile-loader.mjs';
import {
  fileSha256HashSync,
} from '../../paper-adapters/runtime/pinned-file-reader.mjs';
import {
  composeAutonomousResearchStateBusinessSchemaProvisioningService,
} from '../../paper-composition/bootstrap/autonomous-research-state-business-schema-provisioning-composition.mjs';
import {
  composeAutonomousResearchOnlineSchemaTransitionService,
} from '../../paper-composition/automation/autonomous-research-online-schema-transition-composition.mjs';
import {
  composeAutonomousResearchPristineRuntimeInspector,
} from '../../paper-composition/automation/autonomous-research-pristine-runtime-state-composition.mjs';
import {
  autonomousResearchOnlineSchemaTransitionReceiptHash,
} from '../../paper-domain/automation/autonomous-research-online-schema-transition-contract.mjs';
import {
  autonomousResearchStateDatabaseManifestHash,
} from '../../paper-domain/automation/autonomous-research-state-backup-contract.mjs';
import {
  buildAutonomousResearchTopicProducerProfile,
} from '../../paper-domain/automation/autonomous-research-topic-producer-contract.mjs';
import {
  normalizeRuntimeReproducibilityRefreshPolicy,
} from '../../paper-domain/automation/runtime-reproducibility-refresh-policy.mjs';
import {
  autonomousResearchOnlineWriterOperationManifestHash,
} from '../../paper-domain/automation/autonomous-research-online-writer-manifest.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const repositoryRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const stateDatabaseManifest = JSON.parse(fs.readFileSync(path.join(
  repositoryRoot,
  'paper-core/config/autonomous-research-state-databases.v1.json',
), 'utf8'));
const stateDatabaseManifestHash = autonomousResearchStateDatabaseManifestHash(
  stateDatabaseManifest,
);
const H = (label) => hashRecord('AutonomousResearchRuntimeAdoptionV2Test', { label });
const START = new Date('2026-08-20T04:00:00.000Z');

function controlledClock(clockPath) {
  let current = new Date(START);
  const publish = () => fs.writeFileSync(clockPath, JSON.stringify({
    now: current.toISOString(),
  }), { mode: 0o600 });
  publish();
  return Object.freeze({
    now: () => new Date(current),
    advance(milliseconds) {
      current = new Date(current.getTime() + milliseconds);
      publish();
    },
  });
}

function canonicalProvisioningInputs() {
  const providerConfigurationHash = H('provider-configuration');
  const topicProducerProfile = buildAutonomousResearchTopicProducerProfile({
    producerId: 'runtime-adoption-v2-producer',
    implementationSha256:
      inspectAutonomousResearchTopicProducerImplementationIdentity().implementationSha256,
    providerConfigurationHash,
    minimumGenerationIntervalMs: 60 * 60 * 1000,
    maximumTopicsPerUtcDay: 1,
    maximumProviderCanaryAttemptsPerUtcDay: 1,
    maximumProviderCanaryCostUsdPerUtcDay: 1,
    registeredResearchProfiles: [{
      profileId: 'runtime-adoption-v2-profile',
      objective: 'Exercise the pristine runtime adoption recovery boundary.',
      protocolFamily: 'ml_algorithm_benchmark',
      datasetMounts: [{
        name: 'runtime-adoption-v2-dataset',
        source: '/datasets/runtime-adoption-v2',
        readOnly: true,
        manifestHash: H('dataset'),
        licenseId: 'CC0-1.0',
        benchmarkFamily: 'ml_algorithm_benchmark',
      }],
      budgets: {
        maxWallTimeMs: 60 * 60 * 1000,
        maxAgentCalls: 1,
        maxCpuJobs: 1,
        maxGpuJobs: 0,
        maxTokenCount: 1000,
        maxCostUsd: 1,
        maxMemoryMiB: 512,
      },
      revisionRounds: 2,
      refereeCount: 2,
    }],
  });
  const machineIntakeConfiguration =
    buildAutonomousResearchMachineIntakeConfiguration({
      recurringGoldenTemplates: [],
      machineAppendEnabled: true,
      machineProducerProfileHash: topicProducerProfile.producerProfileHash,
    });
  return Object.freeze({
    machineIntakeConfiguration,
    topicProducerProfile,
    runtimeRefreshPolicy: normalizeRuntimeReproducibilityRefreshPolicy({
      maximumAttemptsPerEpoch: 2,
      maximumCostUsdPerEpoch: 1,
    }),
  });
}

function historicalWriterManifest() {
  return Object.freeze({
    ...AUTONOMOUS_RESEARCH_ONLINE_WRITER_OPERATION_MANIFEST,
    manifestId: 'autonomous-research-online-writer-coverage-pre-adoption-v2',
  });
}

function writeJson(candidate, value, mode = 0o600) {
  fs.writeFileSync(candidate, `${JSON.stringify(value)}\n`, { mode });
  fs.chmodSync(candidate, mode);
}

function authorityCommandSource({ localConfigurationPath, clockPath }) {
  const runtimeUrl = new URL(
    '../../paper-adapters/automation/local-autonomous-research-state-authority-runtime.mjs',
    import.meta.url,
  ).href;
  return `#!/usr/bin/node
import fs from 'node:fs';
import { createLocalAutonomousResearchStateAuthority } from ${JSON.stringify(runtimeUrl)};
const clock = Object.freeze({
  now: () => new Date(JSON.parse(fs.readFileSync(${JSON.stringify(clockPath)}, 'utf8')).now),
});
const authority = createLocalAutonomousResearchStateAuthority({
  configurationPath: ${JSON.stringify(localConfigurationPath)},
  clock,
});
try {
  const request = JSON.parse(fs.readFileSync(0, 'utf8'));
  process.stdout.write(JSON.stringify(authority.handle(request)) + '\\n');
} finally {
  authority.close();
}
`;
}

function authorityFiles({ root, databaseScopeHash, sourceWriterManifestHash, clockPath }) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const privateKeyPath = path.join(root, 'authority-private.pem');
  const publicKeyPath = path.join(root, 'authority-public.json');
  const localConfigurationPath = path.join(root, 'authority-local.json');
  const publicConfigurationPath = path.join(root, 'authority-public-config.json');
  const processConfigurationPath = path.join(root, 'authority-process.json');
  const commandPath = path.join(root, 'authority-command.mjs');
  const stateDatabasePath = path.join(root, 'authority-state.sqlite');
  fs.writeFileSync(privateKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), {
    mode: 0o600,
  });
  writeJson(publicKeyPath, {
    version: 1,
    kind: 'AutonomousResearchOnlineMutationAuthorityPublicKey',
    authorityId: 'authority:runtime-adoption-v2',
    keyId: 'key:runtime-adoption-v2',
    algorithm: 'ed25519',
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
  });
  fs.writeFileSync(commandPath, authorityCommandSource({
    localConfigurationPath,
    clockPath,
  }), { mode: 0o700 });
  fs.chmodSync(commandPath, 0o700);

  const writeConfigurations = (writerManifestHash) => {
    const localConfiguration = {
      version: 1,
      kind: 'HeptaLocalAutonomousResearchStateAuthorityConfiguration',
      authorityId: 'authority:runtime-adoption-v2',
      keyId: 'key:runtime-adoption-v2',
      scopeId: 'scope:runtime-adoption-v2',
      databaseScopeHash,
      writerManifestHash,
      privateKeyPath,
      stateDatabasePath,
      socketPath: path.join(root, 'authority.sock'),
      maximumReservationLeaseMs: 10_000,
      maximumObservationAgeMs: 10_000,
    };
    const publicConfiguration = {
      version: 1,
      kind: 'AutonomousResearchOnlineMutationAuthorityConfiguration',
      authorityId: localConfiguration.authorityId,
      keyId: localConfiguration.keyId,
      scopeId: localConfiguration.scopeId,
      databaseScopeHash,
      writerManifestHash,
      publicKeyPath,
      publicKeySha256: fileSha256HashSync(publicKeyPath),
      maximumReservationLeaseMs: localConfiguration.maximumReservationLeaseMs,
      maximumObservationAgeMs: localConfiguration.maximumObservationAgeMs,
    };
    writeJson(localConfigurationPath, localConfiguration);
    writeJson(publicConfigurationPath, publicConfiguration);
    writeJson(processConfigurationPath, {
      version: 1,
      kind: 'AutonomousResearchOnlineMutationAuthorityProcessConfiguration',
      authorityConfigurationPath: publicConfigurationPath,
      authorityConfigurationSha256: fileSha256HashSync(publicConfigurationPath),
      commandPath,
      commandSha256: fileSha256HashSync(commandPath),
      fixedArguments: [],
      timeoutMs: 120_000,
    });
    return Object.freeze({
      localConfiguration,
      localConfigurationHash: hashRecord(
        'HeptaLocalAutonomousResearchStateAuthorityConfiguration',
        localConfiguration,
      ),
    });
  };
  const source = writeConfigurations(sourceWriterManifestHash);
  return Object.freeze({
    localConfigurationPath,
    processConfigurationPath,
    stateDatabasePath,
    source,
    writeConfigurations,
  });
}

function downgradeHandoffToHistoricalV1(runtimeRoot) {
  const candidate = path.join(
    runtimeRoot,
    'autonomous-research/submission-handoff/submission-handoff.sqlite',
  );
  const database = new DatabaseSync(candidate);
  try {
    database.exec(`BEGIN IMMEDIATE;
      DROP TABLE submission_authorization_consumptions;
      DELETE FROM handoff_schema_migrations WHERE version=2;
      COMMIT;
      PRAGMA journal_mode=DELETE;
      PRAGMA synchronous=FULL;`);
  } finally { database.close(); }
}

function initializeHistoricalAuthorityState({
  runtimeRoot,
  authority,
  sourceWriterManifestHash,
  databaseScopeHash,
}) {
  const initialAuthority = createLocalAutonomousResearchStateAuthority({
    configurationPath: authority.localConfigurationPath,
    clock: { now: () => new Date(START) },
  });
  initialAuthority.close();
  const authorityDatabase = new DatabaseSync(authority.stateDatabasePath);
  const metadata = authorityDatabase.prepare(
    'SELECT global_hash FROM authority_metadata WHERE singleton=1;',
  ).get();
  const globalHash = metadata.global_hash;
  downgradeHandoffToHistoricalV1(runtimeRoot);
  const before = resolveAutonomousResearchStateDatabaseInventory({
    runtimeRoot,
    manifest: stateDatabaseManifest,
  });
  const heads = [];
  for (const instance of before.instances) {
    const candidate = path.join(runtimeRoot, instance.sourceRelativePath);
    const database = new DatabaseSync(candidate);
    try {
      for (const statement of AUTONOMOUS_RESEARCH_ONLINE_MUTATION_MARKER_SCHEMA_STATEMENTS) {
        database.exec(statement);
      }
      if (instance.role === 'resident-instance') {
        for (const statement of AUTONOMOUS_RESEARCH_ONLINE_AUTHORITY_JOURNAL_SCHEMA_STATEMENTS) {
          database.exec(statement);
        }
        database.prepare(`INSERT INTO autonomous_research_online_authority_journal_metadata(
          singleton,schema_version,schema_contract_id,schema_contract_hash
        ) VALUES(1,?,?,?);`).run(
          AUTONOMOUS_RESEARCH_ONLINE_AUTHORITY_JOURNAL_SCHEMA_VERSION,
          AUTONOMOUS_RESEARCH_ONLINE_AUTHORITY_JOURNAL_SCHEMA_CONTRACT_ID,
          AUTONOMOUS_RESEARCH_ONLINE_AUTHORITY_JOURNAL_SCHEMA_HASH,
        );
      }
      const schemaContractId = instance.role === 'submission-handoff'
        ? 'autonomous-submission-handoff-schema-v1'
        : instance.schemaContractId;
      const schemaHash = schemaTransitionExactSchemaHash(database);
      const databaseHash = H(`historical-database-head:${instance.instanceId}`);
      const stateHash = H(`historical-state-head:${instance.instanceId}`);
      database.prepare(`INSERT INTO autonomous_research_online_mutation_authority_metadata(
        singleton,schema_version,protocol,database_role,database_instance_id,
        schema_contract_id,schema_hash,database_scope_hash,writer_manifest_hash,
        genesis_global_sequence,genesis_global_hash,genesis_database_sequence,
        genesis_database_hash,genesis_state_hash,provisioned_at
      ) VALUES(1,1,?,?,?,?,?,?,?,0,?,0,?,?,?);`).run(
        'external-linearizable-reserve-apply-finalize-v1',
        instance.role,
        instance.instanceId,
        schemaContractId,
        schemaHash,
        databaseScopeHash,
        sourceWriterManifestHash,
        globalHash,
        databaseHash,
        stateHash,
        START.toISOString(),
      );
      database.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;');
      heads.push(Object.freeze({
        databaseRole: instance.role,
        databaseInstanceId: instance.instanceId,
        schemaContractId,
        schemaHash,
        databaseHash,
        stateHash,
      }));
    } finally { database.close(); }
  }
  try {
    authorityDatabase.exec('BEGIN IMMEDIATE;');
    authorityDatabase.prepare(`UPDATE authority_metadata
      SET schema_transition_state='finalized' WHERE singleton=1;`).run();
    const insertHead = authorityDatabase.prepare(`INSERT INTO authority_database_head(
      database_instance_id,database_role,sequence,hash,schema_hash,state_hash
    ) VALUES(?,?,0,?,?,?);`);
    for (const head of heads) insertHead.run(
      head.databaseInstanceId,
      head.databaseRole,
      head.databaseHash,
      head.schemaHash,
      head.stateHash,
    );
    authorityDatabase.prepare(`INSERT INTO authority_schema_transition(
      singleton,reserve_request_json,reservation_receipt_json,
      finalize_request_json,finalization_receipt_json
    ) VALUES(1,'{}','{}','{}','{"historical":true}');`).run();
    authorityDatabase.exec('COMMIT;');
  } catch (error) {
    if (authorityDatabase.isTransaction) authorityDatabase.exec('ROLLBACK;');
    throw error;
  } finally { authorityDatabase.close(); }
  return Object.freeze(heads.sort((left, right) => (
    left.databaseInstanceId.localeCompare(right.databaseInstanceId)
  )));
}

function inspectPristineRuntime(runtimeRoot, phase) {
  const inventory = resolveAutonomousResearchStateDatabaseInventory({
    runtimeRoot,
    manifest: stateDatabaseManifest,
  });
  const inspections = inventory.instances.map((instance) => {
    const database = new DatabaseSync(path.join(runtimeRoot, instance.sourceRelativePath), {
      readOnly: true,
    });
    try {
      const metadata = database.prepare(`SELECT schema_contract_id,schema_hash
        FROM autonomous_research_online_mutation_authority_metadata WHERE singleton=1;`).get();
      return inspectAutonomousResearchPristineDatabaseState({
        database,
        databaseRole: instance.role,
        databaseInstanceId: instance.instanceId,
        schemaContractId: metadata.schema_contract_id,
        schemaHash: metadata.schema_hash,
        stateDatabaseManifestHash,
        phase,
      });
    } finally { database.close(); }
  });
  return Object.freeze({
    inventory,
    inspections: Object.freeze(inspections),
    pristineRuntimeStateHash: autonomousResearchPristineRuntimeStateHash(inspections),
  });
}

function expectedInstallationHash(installation, reservation) {
  return hashRecord('AutonomousResearchOnlineSchemaTransitionDatabaseInstallation', {
    transitionId: reservation.transitionId,
    reservationReceiptHash: autonomousResearchOnlineSchemaTransitionReceiptHash(reservation),
    databaseRole: installation.databaseRole,
    databaseInstanceId: installation.databaseInstanceId,
    schemaContractId: installation.schemaContractId,
    preSchemaHash: installation.preSchemaHash,
    postSchemaHash: installation.postSchemaHash,
    prePristineStateHash: installation.prePristineStateHash,
    postPristineStateHash: installation.postPristineStateHash,
  });
}

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-runtime-adoption-v2-'));
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtimeRoot = path.join(root, 'runtime');
  const provisioning = canonicalProvisioningInputs();
  const provisioningService = composeAutonomousResearchStateBusinessSchemaProvisioningService({
    workspaceRoot: repositoryRoot,
    runtimeRoot,
    machineIntakeConfiguration: provisioning.machineIntakeConfiguration,
    machineIntakeGenesisAuthorityMode: 'root-owned-configuration',
    topicProducerProfile: provisioning.topicProducerProfile,
    runtimeReproducibilityPolicy: provisioning.runtimeRefreshPolicy,
  });
  const provisioningPlan = provisioningService.plan();
  const provisioningReceipt = provisioningService.execute({
    expectedProvisioningPlanId: provisioningPlan.provisioningPlanId,
  });
  assert.equal(provisioningReceipt.ready, true);
  const inventory = resolveAutonomousResearchStateDatabaseInventory({
    runtimeRoot,
    manifest: stateDatabaseManifest,
  });
  const sourceWriterManifest = historicalWriterManifest();
  const sourceWriterManifestHash = autonomousResearchOnlineWriterOperationManifestHash(
    sourceWriterManifest,
  );
  const targetWriterManifestHash = autonomousResearchOnlineWriterOperationManifestHash(
    AUTONOMOUS_RESEARCH_ONLINE_WRITER_OPERATION_MANIFEST,
  );
  assert.notEqual(sourceWriterManifestHash, targetWriterManifestHash);
  const clockPath = path.join(root, 'clock.json');
  const clock = controlledClock(clockPath);
  const authority = authorityFiles({
    root,
    databaseScopeHash: inventory.databaseScopeHash,
    sourceWriterManifestHash,
    clockPath,
  });
  initializeHistoricalAuthorityState({
    runtimeRoot,
    authority,
    sourceWriterManifestHash,
    databaseScopeHash: inventory.databaseScopeHash,
  });
  return Object.freeze({
    root,
    runtimeRoot,
    clock,
    authority,
    sourceWriterManifestHash,
    targetWriterManifestHash,
  });
}

test('v2 adoption recovers real-authority lease and response loss through target activation',
  async (t) => {
    const fixture = setup(t);
    const pristineBefore = inspectPristineRuntime(fixture.runtimeRoot, 'pre-rebind');
    assert.equal(pristineBefore.inspections.length, 10);
    let loseFinalizeResponse = true;
    let loseObserveResponse = true;
    let committedFinalization = null;
    let committedObservation = null;
    const createAuthorityClient = ({ processConfigurationPath }) => {
      const client = createAutonomousResearchOnlineSchemaTransitionAuthorityProcessClient({
        processConfigurationPath,
      });
      return Object.freeze({
        ...client,
        finalizeSchemaTransition(input) {
          const receipt = client.finalizeSchemaTransition(input);
          if (loseFinalizeResponse) {
            loseFinalizeResponse = false;
            committedFinalization = receipt;
            throw new Error('fixture_finalize_response_lost_after_authority_commit');
          }
          return receipt;
        },
        observeSchemaTransition(input) {
          const receipt = client.observeSchemaTransition(input);
          if (loseObserveResponse) {
            loseObserveResponse = false;
            committedObservation = receipt;
            throw new Error('fixture_observe_response_lost_after_authority_commit');
          }
          return receipt;
        },
      });
    };
    const input = Object.freeze({
      runtimeRoot: fixture.runtimeRoot,
      stateDatabaseManifest,
      writerManifest: AUTONOMOUS_RESEARCH_ONLINE_WRITER_OPERATION_MANIFEST,
      authorityProcessConfigurationPath: fixture.authority.processConfigurationPath,
      requestedLeaseMs: 3000,
      requiredExecutionWindowMs: 1000,
      commitSafetyMarginMs: 250,
      expectedPreRebindPristineRuntimeStateHash: pristineBefore.pristineRuntimeStateHash,
      clock: fixture.clock,
      createAuthorityClient,
    });
    const plan = planAutonomousResearchOnlineSchemaTransition(input).plan;
    assert.equal(plan.version, 2);
    assert.equal(plan.sourceWriterManifestHash, fixture.sourceWriterManifestHash);
    assert.equal(plan.writerManifestHash, fixture.targetWriterManifestHash);

    assert.throws(() => executeAutonomousResearchOnlineSchemaTransition({
      ...input,
      expectedTransitionId: plan.transitionId,
      faultInjector({ point, completedCount }) {
        if (point === 'after_instance_commit' && completedCount === 1) {
          throw new Error('fixture_partial_install_committed');
        }
      },
    }), /fixture_partial_install_committed/);
    const paths = autonomousResearchOnlineSchemaTransitionControlPaths(
      fixture.runtimeRoot,
      { create: false },
    );
    const partial = readAutonomousResearchOnlineSchemaTransitionJson(paths.activeStatePath);
    assert.equal(partial.phase, 'installing');
    assert.equal(partial.installations.length, 1);
    const initialReservationHash = autonomousResearchOnlineSchemaTransitionReceiptHash(
      partial.reservation,
    );
    const initialInstallationHash = partial.installations[0].installationHash;

    fixture.clock.advance(3001);
    assert.throws(() => executeAutonomousResearchOnlineSchemaTransition({
      ...input,
      expectedTransitionId: plan.transitionId,
    }), /fixture_finalize_response_lost_after_authority_commit/);
    const finalizeIntent = readAutonomousResearchOnlineSchemaTransitionJson(
      paths.activeStatePath,
    );
    assert.equal(finalizeIntent.phase, 'finalization-requested');
    assert.equal(finalizeIntent.installations.length, 10);
    assert.notEqual(
      autonomousResearchOnlineSchemaTransitionReceiptHash(finalizeIntent.reservation),
      initialReservationHash,
    );
    const rebuilt = finalizeIntent.installations.find((entry) => (
      entry.databaseInstanceId === partial.installations[0].databaseInstanceId
    ));
    assert.notEqual(rebuilt.installationHash, initialInstallationHash);
    for (const installation of finalizeIntent.installations) {
      assert.equal(
        installation.installationHash,
        expectedInstallationHash(installation, finalizeIntent.reservation),
        installation.databaseRole,
      );
    }
    assert.deepEqual(committedFinalization.installations, finalizeIntent.installations);

    fixture.clock.advance(3001);
    const restart = executeAutonomousResearchOnlineSchemaTransition({
      ...input,
      expectedTransitionId: plan.transitionId,
    });
    assert.equal(restart.ready, false);
    assert.equal(restart.status,
      'autonomous_research_pristine_schema_rebind_target_configuration_restart_required');
    const sourceAuthority = createLocalAutonomousResearchStateAuthority({
      configurationPath: fixture.authority.localConfigurationPath,
      clock: fixture.clock,
    });
    try {
      assert.equal(sourceAuthority.inspect().schemaRebindRestartRequired, true);
    } finally { sourceAuthority.close(); }

    const targetConfiguration = fixture.authority.writeConfigurations(
      fixture.targetWriterManifestHash,
    );
    assert.equal(
      targetConfiguration.localConfigurationHash,
      restart.targetAuthorityConfigurationHash,
    );
    assert.throws(() => executeAutonomousResearchOnlineSchemaTransition({
      ...input,
      expectedTransitionId: plan.transitionId,
    }), /fixture_observe_response_lost_after_authority_commit/);
    assert.ok(committedObservation);
    const observationIntent = readAutonomousResearchOnlineSchemaTransitionJson(
      paths.activeStatePath,
    );
    assert.equal(observationIntent.phase, 'observation-requested');
    assert.equal(observationIntent.observation, undefined);
    const targetAuthority = createLocalAutonomousResearchStateAuthority({
      configurationPath: fixture.authority.localConfigurationPath,
      clock: fixture.clock,
    });
    try {
      const activated = targetAuthority.inspect();
      assert.equal(activated.schemaRebindActivated, true);
      assert.equal(activated.schemaRebindRestartRequired, false);
      assert.equal(activated.authorityWriterManifestHash, fixture.targetWriterManifestHash);
    } finally { targetAuthority.close(); }

    const completed = executeAutonomousResearchOnlineSchemaTransition({
      ...input,
      expectedTransitionId: plan.transitionId,
    });
    assert.equal(completed.ready, true);
    assert.equal(completed.receipt.version, 2);
    assert.equal(completed.receipt.finalization.requestHash,
      committedFinalization.requestHash);
    assert.equal(hashRecord(
      'AutonomousResearchOnlineSchemaTransitionObserveRequest',
      completed.receipt.observeRequest,
    ), committedObservation.requestHash);
    const pristineAfter = inspectPristineRuntime(fixture.runtimeRoot, 'post-rebind');
    assert.equal(
      pristineAfter.pristineRuntimeStateHash,
      completed.receipt.postPristineRuntimeStateHash,
    );

    const quiescencePath = path.join(fixture.root, 'writer-quiescence.json');
    const inspectionInventory = resolveAutonomousResearchStateDatabaseInventory({
      runtimeRoot: fixture.runtimeRoot,
      manifest: stateDatabaseManifest,
    });
    writeJson(quiescencePath, buildAutonomousResearchStatePartialRootWriterQuiescenceReceipt({
      runtimeRoot: fixture.runtimeRoot,
      databaseScopeHash: inspectionInventory.databaseScopeHash,
      writerManifestHash: fixture.targetWriterManifestHash,
      quiescedWriterServices: PARTIAL_ROOT_REQUIRED_QUIESCED_SERVICES,
      activeWriterProcessIds: [],
      serviceInspectionComplete: true,
      processInspectionComplete: true,
      observedAt: new Date(fixture.clock.now().getTime() - 1000),
      expiresAt: new Date(fixture.clock.now().getTime() + 10 * 60 * 1000),
    }));
    const pristineInspector = composeAutonomousResearchPristineRuntimeInspector({
      workspaceRoot: repositoryRoot,
      authorityProcessConfigurationPath: fixture.authority.processConfigurationPath,
      authorityConfigurationPath: fixture.authority.localConfigurationPath,
      writerQuiescenceReceiptPath: quiescencePath,
      clock: fixture.clock,
    });
    const composedInspection = pristineInspector.inspect({
      runtimeRoot: fixture.runtimeRoot,
      planHash: H('pristine-composition-plan'),
      configurationHash: targetConfiguration.localConfigurationHash,
    });
    assert.equal(composedInspection.status,
      'autonomous_research_pristine_runtime_inspection_ready');
    assert.equal(pristineInspector.verify(composedInspection), true);

    for (const instance of pristineAfter.inventory.instances) {
      await t.test(`rejects semantic contamination in ${instance.role}`, () => {
        const candidate = path.join(fixture.runtimeRoot, instance.sourceRelativePath);
        const database = new DatabaseSync(candidate);
        try {
          database.exec(`CREATE TABLE runtime_adoption_semantic_contamination(
            value TEXT NOT NULL
          ) STRICT;
          INSERT INTO runtime_adoption_semantic_contamination(value) VALUES('contaminated');`);
          assert.throws(() => inspectAutonomousResearchPristineDatabaseState({
            database,
            databaseRole: instance.role,
            databaseInstanceId: instance.instanceId,
            schemaContractId: instance.schemaContractId,
            schemaHash: instance.schemaHash,
            stateDatabaseManifestHash,
            phase: 'adoption',
          }), /autonomous_research_pristine_state_business_rows_present/);
        } finally { database.close(); }
      });
    }
  });

test('historical v1 authority path remains fail-closed after the v2 adoption split', (t) => {
  const fixture = setup(t);
  const input = {
    runtimeRoot: fixture.runtimeRoot,
    stateDatabaseManifest,
    writerManifest: historicalWriterManifest(),
    authorityProcessConfigurationPath: fixture.authority.processConfigurationPath,
    requestedLeaseMs: 3000,
    requiredExecutionWindowMs: 1000,
    commitSafetyMarginMs: 250,
    clock: fixture.clock,
  };
  // The composition facade persists its plan checkpoint. Exercise it on an
  // isolated fixture so the historical direct-authority path below starts
  // from the untouched v1 genesis state.
  const compositionFixture = setup(t);
  const compositionPristineBefore = inspectPristineRuntime(
    compositionFixture.runtimeRoot,
    'pre-rebind',
  );
  const composed = composeAutonomousResearchOnlineSchemaTransitionService({
    workspaceRoot: repositoryRoot,
    runtimeRoot: compositionFixture.runtimeRoot,
    authorityProcessConfigurationPath: compositionFixture.authority.processConfigurationPath,
    clock: compositionFixture.clock,
  });
  assert.equal(composed.runtimeRoot, path.resolve(compositionFixture.runtimeRoot));
  assert.equal(composed.authorityProcessConfigurationPath,
    path.resolve(compositionFixture.authority.processConfigurationPath));
  const composedPlan = composed.plan({
    requestedLeaseMs: 3000,
    requiredExecutionWindowMs: 1000,
    expectedPreRebindPristineRuntimeStateHash:
      compositionPristineBefore.pristineRuntimeStateHash,
  });
  assert.equal(composedPlan.ready, true);
  const planned = planAutonomousResearchOnlineSchemaTransition(input).plan;
  assert.equal(planned.version, 1);
  assert.throws(() => executeAutonomousResearchOnlineSchemaTransition({
    ...input,
    expectedTransitionId: planned.transitionId,
  }), /autonomous_research_online_schema_transition_process_failed/u);
  const authority = createLocalAutonomousResearchStateAuthority({
    configurationPath: fixture.authority.localConfigurationPath,
    clock: fixture.clock,
  });
  try {
    assert.equal(authority.inspect().schemaTransitionState, 'finalized');
    assert.equal(authority.inspect().schemaRebindRestartRequired, false);
  } finally {
    authority.close();
  }
});

test('local authority runtime exercises the legacy v1 reservation, renewal, finalization, and observation lifecycle',
  (t) => {
    const fixture = setup(t);
    const inventory = resolveAutonomousResearchStateDatabaseInventory({
      runtimeRoot: fixture.runtimeRoot,
      manifest: stateDatabaseManifest,
    });
    const authorityRoot = path.join(fixture.root, 'legacy-v1-authority');
    fs.mkdirSync(authorityRoot, { recursive: true, mode: 0o700 });
    const authorityFilesForV1 = authorityFiles({
      root: authorityRoot,
      databaseScopeHash: inventory.databaseScopeHash,
      sourceWriterManifestHash: fixture.sourceWriterManifestHash,
      clockPath: path.join(fixture.root, 'legacy-v1-clock.json'),
    });
    const authority = createLocalAutonomousResearchStateAuthority({
      configurationPath: authorityFilesForV1.localConfigurationPath,
      clock: fixture.clock,
    });
    t.after(() => authority.close());

    const plan = planAutonomousResearchOnlineSchemaTransition({
      runtimeRoot: fixture.runtimeRoot,
      stateDatabaseManifest,
      writerManifest: historicalWriterManifest(),
      authorityProcessConfigurationPath: authorityFilesForV1.processConfigurationPath,
      requestedLeaseMs: 5_000,
      requiredExecutionWindowMs: 1_000,
      clock: fixture.clock,
      createAuthorityClient: () => Object.freeze({ trust: authority.trust }),
    }).plan;
    assert.equal(plan.version, 1);
    const reserveRequest = buildAutonomousResearchOnlineSchemaTransitionReserveRequest(
      plan,
      fixture.clock.now().toISOString(),
    );
    const reservation = authority.handle(reserveRequest);
    assert.equal(reservation.status,
      'autonomous_research_online_schema_transition_reserved');
    assert.deepEqual(authority.handle(reserveRequest), reservation);
    assert.throws(
      () => authority.handle({ ...reserveRequest, requestedLeaseMs: 4_000 }),
      /local_state_authority_schema_transition_conflict/u,
    );

    // An expired but otherwise unchanged reservation is renewed from its
    // original preimage before finalization.
    fixture.clock.advance(5_001);
    const renewedReservation = authority.handle(reserveRequest);
    assert.notEqual(renewedReservation.reservationId, reservation.reservationId);
    assert.ok(Date.parse(renewedReservation.expiresAt)
      > Date.parse(reservation.expiresAt));

    const postInventoryHash = H('legacy-v1-post-inventory');
    const postPristineRuntimeStateHash = H('legacy-v1-post-pristine-state');
    const installations = plan.instances.map((instance, index) => {
      const postPristineStateHash = H(`legacy-v1-post-state:${index}`);
      const installation = {
        databaseRole: instance.databaseRole,
        databaseInstanceId: instance.databaseInstanceId,
        schemaContractId: instance.schemaContractId,
        preSchemaHash: instance.preSchemaHash,
        postSchemaHash: instance.expectedPostSchemaHash,
        prePristineStateHash: instance.prePristineStateHash,
        postPristineStateHash,
      };
      return Object.freeze({
        ...installation,
        installationHash: hashRecord(
          'AutonomousResearchOnlineSchemaTransitionDatabaseInstallation',
          {
            transitionId: renewedReservation.transitionId,
            reservationReceiptHash:
              autonomousResearchOnlineSchemaTransitionReceiptHash(renewedReservation),
            ...installation,
          },
        ),
      });
    });
    const finalizeRequest = buildAutonomousResearchOnlineSchemaTransitionFinalizeRequest({
      plan,
      reservation: renewedReservation,
      inventory: { inventoryHash: postInventoryHash },
      installations,
      postPristineRuntimeStateHash,
      completedAt: fixture.clock.now().toISOString(),
    });
    const finalization = authority.handle(finalizeRequest);
    assert.equal(finalization.status,
      'autonomous_research_online_schema_transition_finalized');
    assert.deepEqual(authority.handle(finalizeRequest), finalization);
    assert.throws(
      () => authority.handle({ ...finalizeRequest, postInventoryHash: H('different-post') }),
      /local_state_authority_schema_transition_finalization_conflict/u,
    );

    const observeRequest = buildAutonomousResearchOnlineSchemaTransitionObserveRequest({
      plan,
      finalization,
      postInventoryHash,
      postPristineRuntimeStateHash,
      requestedAt: fixture.clock.now().toISOString(),
      nonce: 'legacy-v1-observation-1',
    });
    const observation = authority.handle(observeRequest);
    assert.equal(observation.transitionState, 'finalized');
    assert.throws(
      () => authority.handle({ ...observeRequest, transitionId: H('wrong-transition') }),
      /local_state_authority_schema_transition_observation_mismatch/u,
    );
    assert.equal(authority.inspect().schemaTransitionState, 'finalized');

    // The same valid observation request against a fresh authority reaches the
    // explicit not-finalized guard before any receipt is available.
    const pendingRoot = path.join(fixture.root, 'legacy-v1-pending-authority');
    fs.mkdirSync(pendingRoot, { recursive: true, mode: 0o700 });
    const pendingFiles = authorityFiles({
      root: pendingRoot,
      databaseScopeHash: inventory.databaseScopeHash,
      sourceWriterManifestHash: fixture.sourceWriterManifestHash,
      clockPath: path.join(fixture.root, 'legacy-v1-pending-clock.json'),
    });
    const pending = createLocalAutonomousResearchStateAuthority({
      configurationPath: pendingFiles.localConfigurationPath,
      clock: fixture.clock,
    });
    t.after(() => pending.close());
    assert.throws(
      () => pending.handle(observeRequest),
      /local_state_authority_schema_transition_not_finalized/u,
    );
    assert.throws(
      () => pending.handle({ kind: 'AutonomousResearchOnlineSchemaTransitionFinalizeRequest' }),
      /local_state_authority_schema_transition_reservation_required/u,
    );
  });

test('local authority runtime rejects malformed configuration/key material and routes every request kind',
  (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-authority-runtime-coverage-'));
    fs.chmodSync(root, 0o700);
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const privateKeyPath = path.join(root, 'authority-private.pem');
    fs.writeFileSync(privateKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), {
      mode: 0o600,
    });
    const baseConfiguration = {
      version: 1,
      kind: 'HeptaLocalAutonomousResearchStateAuthorityConfiguration',
      authorityId: 'authority:runtime-coverage',
      keyId: 'key:runtime-coverage',
      scopeId: 'scope:runtime-coverage',
      databaseScopeHash: H('runtime-coverage-database-scope'),
      writerManifestHash: H('runtime-coverage-writer-manifest'),
      privateKeyPath,
      stateDatabasePath: path.join(root, 'authority.sqlite'),
      socketPath: path.join(root, 'authority.sock'),
      maximumReservationLeaseMs: 10_000,
      maximumObservationAgeMs: 10_000,
    };
    const configurationPath = path.join(root, 'authority.json');
    writeJson(configurationPath, baseConfiguration);
    const authority = createLocalAutonomousResearchStateAuthority({
      configurationPath,
    });
    assert.equal(authority.inspect().schemaTransitionState, 'uninitialized');
    authority.close();

    assert.throws(
      () => createLocalAutonomousResearchStateAuthority({ configurationPath: 'relative.json' }),
      /local_state_authority_configuration_path_required/u,
    );
    const invalidConfigurationPath = path.join(root, 'invalid-configuration.json');
    writeJson(invalidConfigurationPath, { ...baseConfiguration, unexpected: true });
    assert.throws(
      () => createLocalAutonomousResearchStateAuthority({
        configurationPath: invalidConfigurationPath,
      }),
      /local_state_authority_configuration_invalid/u,
    );

    const broadKeyPath = path.join(root, 'broad-key.pem');
    fs.copyFileSync(privateKeyPath, broadKeyPath);
    fs.chmodSync(broadKeyPath, 0o644);
    const broadKeyConfigurationPath = path.join(root, 'broad-key-config.json');
    writeJson(broadKeyConfigurationPath, {
      ...baseConfiguration,
      privateKeyPath: broadKeyPath,
      stateDatabasePath: path.join(root, 'broad-key.sqlite'),
    });
    assert.throws(
      () => createLocalAutonomousResearchStateAuthority({
        configurationPath: broadKeyConfigurationPath,
      }),
      /local_state_authority_private_key_invalid/u,
    );

    const symlinkPath = path.join(root, 'symlink-key.pem');
    fs.symlinkSync(privateKeyPath, symlinkPath);
    const symlinkConfigurationPath = path.join(root, 'symlink-key-config.json');
    writeJson(symlinkConfigurationPath, {
      ...baseConfiguration,
      privateKeyPath: symlinkPath,
      stateDatabasePath: path.join(root, 'symlink-key.sqlite'),
    });
    assert.throws(
      () => createLocalAutonomousResearchStateAuthority({
        configurationPath: symlinkConfigurationPath,
      }),
      /local_state_authority_private_key_invalid/u,
    );

    const malformedKeyPath = path.join(root, 'malformed-key.pem');
    fs.writeFileSync(malformedKeyPath, 'not-a-private-key\n', { mode: 0o600 });
    const malformedKeyConfigurationPath = path.join(root, 'malformed-key-config.json');
    writeJson(malformedKeyConfigurationPath, {
      ...baseConfiguration,
      privateKeyPath: malformedKeyPath,
      stateDatabasePath: path.join(root, 'malformed-key.sqlite'),
    });
    assert.throws(
      () => createLocalAutonomousResearchStateAuthority({
        configurationPath: malformedKeyConfigurationPath,
      }),
      /local_state_authority_private_key_invalid/u,
    );

    const { privateKey: rsaPrivateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const rsaKeyPath = path.join(root, 'rsa-key.pem');
    fs.writeFileSync(rsaKeyPath, rsaPrivateKey.export({ type: 'pkcs1', format: 'pem' }), {
      mode: 0o600,
    });
    const rsaConfigurationPath = path.join(root, 'rsa-key-config.json');
    writeJson(rsaConfigurationPath, {
      ...baseConfiguration,
      privateKeyPath: rsaKeyPath,
      stateDatabasePath: path.join(root, 'rsa-key.sqlite'),
    });
    assert.throws(
      () => createLocalAutonomousResearchStateAuthority({ configurationPath: rsaConfigurationPath }),
      /local_state_authority_private_key_invalid/u,
    );

    // A changed persisted identity has no approved schema-rebind record and
    // must be rejected during initialization.
    const mismatchedConfigurationPath = path.join(root, 'mismatched-config.json');
    writeJson(mismatchedConfigurationPath, {
      ...baseConfiguration,
      authorityId: 'authority:runtime-coverage-other',
    });
    assert.throws(
      () => createLocalAutonomousResearchStateAuthority({
        configurationPath: mismatchedConfigurationPath,
      }),
      /local_state_authority_persisted_identity_mismatch/u,
    );

    const dispatchAuthority = createLocalAutonomousResearchStateAuthority({
      configurationPath,
    });
    t.after(() => dispatchAuthority.close());
    for (const kind of [
      'AutonomousResearchOnlineSchemaTransitionReserveRequest',
      'AutonomousResearchOnlineSchemaTransitionFinalizeRequest',
      'AutonomousResearchOnlineSchemaTransitionObserveRequest',
      'AutonomousResearchOnlineMutationReserveRequest',
      'AutonomousResearchOnlineMutationFinalizeRequest',
      'AutonomousResearchOnlineMutationAbortRequest',
      'AutonomousResearchOnlineMutationResolutionRequest',
      'AutonomousResearchOnlineUnresolvedReservationListRequest',
      'AutonomousResearchOnlineMutationCurrentHeadRequest',
      'AutonomousResearchOnlineMutationActiveChallengeRequest',
      'AutonomousResearchOnlineMutationScopeRequest',
      'AutonomousResearchStateBackupAuthorityReserveRequest',
      'AutonomousResearchStateBackupAuthorityFinalizeRequest',
      'AutonomousResearchStateBackupAuthorityCurrentHeadRequest',
      'AutonomousResearchStateBackupAuthorityJournalRangeRequest',
    ]) {
      assert.throws(() => dispatchAuthority.handle({ kind }), undefined, kind);
    }
    assert.throws(() => dispatchAuthority.handle(null), /local_state_authority_request_invalid/u);
    assert.throws(
      () => dispatchAuthority.handle({ kind: 'UnsupportedAuthorityRequest' }),
      /local_state_authority_request_kind_unsupported/u,
    );
    // Keep the generated public key exercised as a real Ed25519 key rather
    // than leaving the key-pair branch as an unobserved fixture artifact.
    assert.equal(publicKey.asymmetricKeyType, 'ed25519');
  });
