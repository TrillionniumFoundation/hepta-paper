import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createAutonomousResearchOnlineAuthorityEvidenceRenewalAdapter,
} from '../../paper-adapters/automation/autonomous-research-online-authority-evidence-renewal.mjs';
import {
  AUTONOMOUS_RESEARCH_ONLINE_WRITER_OPERATION_MANIFEST,
} from '../../paper-adapters/automation/autonomous-research-online-writer-operation-manifest.mjs';
import {
  createAutonomousResearchOnlineAuthorityEvidenceRenewalController,
} from '../../paper-application/automation/autonomous-research-online-authority-evidence-renewal-controller.mjs';
import {
  runAutonomousResearchResident,
} from '../../paper-application/automation/autonomous-research-resident-lifecycle.mjs';
import {
  createAutonomousResearchSupervisor,
} from '../../paper-application/automation/autonomous-research-supervisor.mjs';
import {
  AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES,
  autonomousResearchStateDatabaseInventoryHash,
  autonomousResearchStateDatabaseScopeHash,
} from '../../paper-domain/automation/autonomous-research-state-backup-contract.mjs';
import {
  AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL,
} from '../../paper-domain/automation/autonomous-research-online-mutation-contract.mjs';
import {
  autonomousResearchOnlineRuntimeActivationReceiptHash,
} from '../../paper-domain/automation/autonomous-research-online-runtime-activation-contract.mjs';
import {
  autonomousResearchOnlineWriterOperationManifestHash,
} from '../../paper-domain/automation/autonomous-research-online-writer-manifest.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const H = (label) => hashRecord('AutonomousResearchAuthorityRenewalTest', { label });

function stateInventory({ schemaDrift = false, contentRevision = 0 } = {}) {
  const instances = Object.freeze(AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES.map(
    (role, index) => Object.freeze({
      instanceId: role,
      role,
      paperId: null,
      sourceRelativePath: `autonomous-research/${role}.sqlite`,
      schemaContractId: `${role}-schema-v1`,
      missingSchemaObjects: Object.freeze([]),
      sourceFileIdentity: Object.freeze({ revision: contentRevision }),
      sourceSha256: H(`source:${role}:${contentRevision}`),
      walFileIdentity: null,
      walSha256: null,
      quickCheck: 'ok',
      foreignKeyViolationCount: 0,
      schemaHash: schemaDrift && index === 0
        ? H(`schema:${role}:drift`) : H(`schema:${role}`),
      schemaObjects: Object.freeze([]),
      userVersion: 1,
      applicationId: 0,
    }),
  ));
  const base = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchStateDatabaseInventory',
    status: 'autonomous_research_state_database_inventory_ready',
    manifestId: 'hepta-paper-autonomous-research-state-databases-v1',
    manifestHash: H('state-database-manifest'),
    databaseScopeHash: autonomousResearchStateDatabaseScopeHash(instances),
    instances,
    blockers: Object.freeze([]),
  });
  return Object.freeze({
    ...base,
    inventoryHash: autonomousResearchStateDatabaseInventoryHash(base),
  });
}

function activationReceipt(inventory) {
  const manifestHash = autonomousResearchOnlineWriterOperationManifestHash(
    AUTONOMOUS_RESEARCH_ONLINE_WRITER_OPERATION_MANIFEST,
  );
  const base = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchOnlineRuntimeActivationReceipt',
    status: 'autonomous_research_online_mutation_runtime_activated',
    protocol: AUTONOMOUS_RESEARCH_ONLINE_MUTATION_PROTOCOL,
    inventoryHash: inventory.inventoryHash,
    databaseScopeHash: inventory.databaseScopeHash,
    writerManifestHash: manifestHash,
    authorityId: 'authority:test',
    keyId: 'key:test',
    authorityGlobalSequence: 1,
    authorityGlobalHash: H('global:1'),
    databaseActivations: Object.freeze(inventory.instances.map((instance) => Object.freeze({
      databaseRole: instance.role,
      databaseInstanceId: instance.instanceId,
      schemaContractId: instance.schemaContractId,
      schemaHash: instance.schemaHash,
      startupReconciliationReceiptHash: H(`startup:${instance.instanceId}`),
      finalizedHeadInspectionReceiptHash: H(`head:${instance.instanceId}`),
      databaseSequence: 0,
      databaseHash: H(`database:${instance.instanceId}`),
      stateHash: H(`state:${instance.instanceId}`),
    })).sort((left, right) => (
      left.databaseInstanceId.localeCompare(right.databaseInstanceId)
    ))),
    activeRefreshReceiptHash: H('active-refresh'),
    authorityEvidenceCacheReceiptHash: H('cache'),
    restoreDrillReceiptHash: H('restore-drill'),
    schemaTransitionReceiptHash: H('schema-transition'),
    activatedAt: '2026-07-20T00:00:00.000Z',
    coordinatorRuntimeReady: true,
    remainingBlockers: Object.freeze([]),
  });
  return Object.freeze({
    ...base,
    activationReceiptHash: autonomousResearchOnlineRuntimeActivationReceiptHash(base),
  });
}

function scheduler() {
  return Object.freeze({
    async sleep() {},
    setInterval() { return Object.freeze({}); },
    clearInterval() {},
    unref() {},
  });
}

function supervisorDependencies({
  campaignStore,
  stateRepository,
  onlineAuthorityEvidenceController,
  residentInstanceRepository = null,
  clock,
} = {}) {
  return Object.freeze({
    campaignStore,
    stateRepository,
    onlineAuthorityEvidenceController,
    residentInstanceRepository,
    async dispatchCampaign() {
      throw new Error('test_external_dispatch_must_not_run');
    },
    async readQualificationState() {
      throw new Error('test_qualification_read_must_not_run');
    },
    async ensureRuntimeReproducibility() {
      throw new Error('test_runtime_refresh_must_not_run');
    },
    async runProviderCanary() {
      throw new Error('test_provider_canary_must_not_run');
    },
    async renewQualification() {
      throw new Error('test_qualification_renewal_must_not_run');
    },
    async reconcileRuntime() { return null; },
    scheduler: scheduler(),
    ownerId: 'supervisor:authority-renewal-test',
    clock,
  });
}

test('resident authority evidence renews across two fifteen-minute windows', () => {
  let nowMs = Date.parse('2026-07-20T00:00:00.000Z');
  let expiresAtMs = nowMs + 15 * 60 * 1000;
  let renewals = 0;
  const clock = Object.freeze({ now: () => new Date(nowMs) });
  const adapter = Object.freeze({
    authorityOperationTimeoutMs: 1_000,
    authorityTrust: Object.freeze({
      maximumObservationAgeMs: 15 * 60 * 1000,
      maximumReservationLeaseMs: 15 * 60 * 1000,
    }),
    inspectCurrent({ now, minimumRemainingValidityMs }) {
      const remainingValidityMs = expiresAtMs - now.getTime();
      return Object.freeze({
        ready: remainingValidityMs > minimumRemainingValidityMs,
        status: remainingValidityMs > minimumRemainingValidityMs
          ? 'autonomous_research_online_authority_evidence_current'
          : 'autonomous_research_online_authority_evidence_renewal_required',
        reason: remainingValidityMs > minimumRemainingValidityMs
          ? null : 'autonomous_research_online_authority_evidence_validity_insufficient',
        expiresAt: new Date(expiresAtMs).toISOString(),
        remainingValidityMs: Math.max(0, remainingValidityMs),
        externalActionPerformed: false,
      });
    },
    renew({ now, minimumRemainingValidityMs, assertResidentFence }) {
      assertResidentFence({ now });
      renewals += 1;
      expiresAtMs = now.getTime() + 15 * 60 * 1000;
      assert.ok(expiresAtMs - now.getTime() > minimumRemainingValidityMs);
      return Object.freeze({
        ready: true,
        status: 'autonomous_research_online_authority_evidence_renewed',
        expiresAt: new Date(expiresAtMs).toISOString(),
        remainingValidityMs: expiresAtMs - now.getTime(),
        externalActionPerformed: true,
      });
    },
  });
  const controller = createAutonomousResearchOnlineAuthorityEvidenceRenewalController({
    adapter,
    clock,
    random: () => 0,
    requireResidentFence: false,
    residentLeaseMs: 15 * 60 * 1000,
    renewalLeadMs: 60_000,
    baseBackoffMs: 1_000,
    maximumBackoffMs: 1_000,
  });

  assert.equal(controller.reconcile().renewed, false);
  for (let window = 0; window < 2; window += 1) {
    nowMs += 14 * 60 * 1000 + 1;
    const receipt = controller.reconcile();
    assert.equal(receipt.ready, true);
    assert.equal(receipt.renewed, true);
    assert.equal(receipt.externalActionPerformed, true);
    assert.equal(controller.assertCurrent({
      requiredValidityMs: 60_000,
      action: `window-${window + 1}`,
    }).ready, true);
  }
  assert.equal(renewals, 2);
  assert.equal(controller.inspectStatus().consecutiveFailures, 0);
});

test('renewal adapter ignores content churn, writes then reads back, and rejects scope drift', () => {
  let nowMs = Date.parse('2026-07-20T00:00:00.000Z');
  const clock = Object.freeze({ now: () => new Date(nowMs) });
  const initialInventory = stateInventory();
  const receipt = activationReceipt(initialInventory);
  const manifestHash = autonomousResearchOnlineWriterOperationManifestHash(
    AUTONOMOUS_RESEARCH_ONLINE_WRITER_OPERATION_MANIFEST,
  );
  let currentInventory = stateInventory({ contentRevision: 1 });
  let expiryMs = nowMs + 30_000;
  let cacheHash = H('cache:initial');
  let sequence = 1;
  let cacheWrites = 0;
  let residentFences = 0;
  const cachedEvidence = () => Object.freeze({
    cacheHash,
    currentHead: Object.freeze({ receipt: Object.freeze({
      expiresAt: new Date(expiryMs).toISOString(),
    }) }),
    activeChallenge: Object.freeze({ receipt: Object.freeze({
      expiresAt: new Date(expiryMs).toISOString(),
    }) }),
    brokerScope: Object.freeze({ receipt: Object.freeze({
      expiresAt: new Date(expiryMs).toISOString(),
    }) }),
  });
  const coordinator = Object.freeze({
    executeMutation() { throw new Error('test_business_dml_must_not_run'); },
    recoverPendingMutations() {},
    inspectStatus: () => Object.freeze({
      status: 'externally_fenced_sqlite_mutation_coordinator_ready',
      activationReceiptHash: receipt.activationReceiptHash,
    }),
  });
  const adapter = createAutonomousResearchOnlineAuthorityEvidenceRenewalAdapter({
    workspaceRoot: '/workspace',
    runtimeRoot: '/runtime',
    activationReceipt: receipt,
    activationInventory: initialInventory,
    coordinator,
    authorityProcessConfigurationPath: '/authority-process.json',
    authorityConfigurationPath: '/authority-public.json',
    authorityClient: Object.freeze({
      operationTimeoutMs: 1_000,
      trust: Object.freeze({
        databaseScopeHash: initialInventory.databaseScopeHash,
        writerManifestHash: manifestHash,
        maximumObservationAgeMs: 15 * 60 * 1000,
        maximumReservationLeaseMs: 15 * 60 * 1000,
      }),
    }),
    manifest: AUTONOMOUS_RESEARCH_ONLINE_WRITER_OPERATION_MANIFEST,
    resolveInventory: () => currentInventory,
    clock,
    refreshAuthorityEvidence() {
      sequence += 1;
      expiryMs = nowMs + 15 * 60 * 1000;
      const evidence = cachedEvidence();
      return Object.freeze({
        status: 'autonomous_research_online_mutation_active_refresh_complete',
        externalActionPerformed: true,
        globalSequence: sequence,
        globalHash: H(`global:${sequence}`),
        authorityEvidence: evidence,
        journalRecorded: false,
        journalReceipt: null,
        recordedAt: new Date(nowMs).toISOString(),
      });
    },
    inspectActiveEvidence: () => Object.freeze({
      status: 'autonomous_research_online_anti_rollback_ready',
      blockers: Object.freeze([]),
      currentHeadReceipt: Object.freeze({ expiresAt: new Date(expiryMs).toISOString() }),
      activeChallengeReceipt: Object.freeze({ expiresAt: new Date(expiryMs).toISOString() }),
      writerCoverage: Object.freeze({ brokerScopeReceipt: Object.freeze({
        expiresAt: new Date(expiryMs).toISOString(),
      }) }),
    }),
    inspectPassiveEvidence: () => Object.freeze({
      status: 'autonomous_research_online_anti_rollback_ready',
      blockers: Object.freeze([]),
    }),
    createCacheReader: () => Object.freeze({
      readPassiveAuthorityEvidence: () => cachedEvidence(),
    }),
    createCacheWriter: () => Object.freeze({
      recordActiveAuthorityEvidence({ expiresAt }) {
        cacheWrites += 1;
        assert.equal(expiresAt, new Date(expiryMs).toISOString());
        cacheHash = H(`cache:${sequence}`);
        return Object.freeze({ cacheHash, expiresAt });
      },
    }),
  });

  assert.equal(adapter.inspectCurrent({ minimumRemainingValidityMs: 60_000 }).ready, false);
  const renewed = adapter.renew({
    minimumRemainingValidityMs: 60_000,
    assertResidentFence() { residentFences += 1; },
  });
  assert.equal(renewed.ready, true);
  assert.equal(renewed.cacheHash, cacheHash);
  assert.equal(cacheWrites, 1);
  assert.equal(residentFences, 1);

  nowMs += 1_000;
  assert.equal(adapter.inspectCurrent({ minimumRemainingValidityMs: 60_000 }).ready, true);
  currentInventory = stateInventory({ schemaDrift: true, contentRevision: 2 });
  assert.throws(() => adapter.inspectCurrent(), (error) => (
    error.authorityEvidenceRenewalFatal === true
      && /inventory_scope_changed/.test(error.message)
  ));
});

test('renewal policy rejects unsafe resident and authority validity windows', () => {
  const adapter = Object.freeze({
    authorityOperationTimeoutMs: 1_000,
    authorityTrust: Object.freeze({
      maximumObservationAgeMs: 15 * 60 * 1000,
      maximumReservationLeaseMs: 15 * 60 * 1000,
    }),
    inspectCurrent: () => Object.freeze({ ready: true }),
    renew: () => Object.freeze({ ready: true }),
  });
  const common = Object.freeze({
    adapter,
    requireResidentFence: false,
    renewalLeadMs: 60_000,
    pollMs: 5_000,
    residentHeartbeatMs: 30_000,
  });
  assert.throws(() => createAutonomousResearchOnlineAuthorityEvidenceRenewalController({
    ...common,
    residentLeaseMs: 90_000,
  }), /autonomous_research_online_authority_evidence_policy_incompatible/);
  assert.throws(() => createAutonomousResearchOnlineAuthorityEvidenceRenewalController({
    ...common,
    residentLeaseMs: 15 * 60 * 1000,
    adapter: Object.freeze({
      ...adapter,
      authorityTrust: Object.freeze({
        maximumObservationAgeMs: 60_000,
        maximumReservationLeaseMs: 15 * 60 * 1000,
      }),
    }),
  }), /autonomous_research_online_authority_evidence_policy_incompatible/);
  assert.throws(() => createAutonomousResearchOnlineAuthorityEvidenceRenewalController({
    ...common,
    residentLeaseMs: 15 * 60 * 1000,
    adapter: Object.freeze({
      ...adapter,
      authorityTrust: Object.freeze({
        maximumObservationAgeMs: 15 * 60 * 1000,
        maximumReservationLeaseMs: 60_000,
      }),
    }),
  }), /autonomous_research_online_authority_evidence_policy_incompatible/);
});

test('transient authority renewal failure defers the whole cycle before campaign budgets',
  async () => {
    const calls = {
      campaignDiscovery: 0,
      campaignRegistration: 0,
      campaignLease: 0,
      dispatchReservation: 0,
      dispatchFinalization: 0,
      externalAction: 0,
    };
    const authorityEvidence = Object.freeze({
      ready: false,
      status: 'autonomous_research_online_authority_evidence_renewal_deferred',
      reason: 'test_authority_temporarily_unavailable',
      retryAt: '2026-07-20T00:00:01.000Z',
      consecutiveFailures: 1,
      externalActionPerformed: false,
    });
    const onlineAuthorityEvidenceController = Object.freeze({
      policy: Object.freeze({ renewalLeadMs: 60_000 }),
      reconcile() { return authorityEvidence; },
      assertCurrent() {
        calls.externalAction += 1;
        const error = new Error('test_authority_evidence_not_current');
        error.authorityEvidenceRenewalDeferred = true;
        throw error;
      },
    });
    const stateRepository = Object.freeze({
      registerCampaign() { calls.campaignRegistration += 1; },
      reconcileStaleLeases() { return Object.freeze({ recovered: 0 }); },
      tryAcquireCampaignLease() { calls.campaignLease += 1; return null; },
      beginDispatch() { calls.dispatchReservation += 1; return null; },
      finishDispatch() { calls.dispatchFinalization += 1; return null; },
    });
    const supervisor = createAutonomousResearchSupervisor(supervisorDependencies({
      campaignStore: Object.freeze({
        listCampaigns() { calls.campaignDiscovery += 1; return []; },
        getCampaign() { return null; },
      }),
      stateRepository,
      onlineAuthorityEvidenceController,
      clock: Object.freeze({
        now: () => new Date('2026-07-20T00:00:00.000Z'),
      }),
    }));

    const receipt = await supervisor.runCycle();
    assert.equal(receipt.status,
      'autonomous_research_supervisor_authority_evidence_deferred');
    assert.equal(receipt.automaticBudgetExpansionPerformed, false);
    assert.equal(receipt.externalSubmissionPerformed, false);
    assert.equal(receipt.authorityEvidence, authorityEvidence);
    assert.deepEqual(calls, {
      campaignDiscovery: 0,
      campaignRegistration: 0,
      campaignLease: 0,
      dispatchReservation: 0,
      dispatchFinalization: 0,
      externalAction: 0,
    });
  });

test('fatal authority scope drift exits the resident and releases its instance lease',
  async () => {
    const now = new Date('2026-07-20T00:00:00.000Z');
    let released = 0;
    let lease = Object.freeze({
      ownerId: 'supervisor:authority-renewal-test',
      leaseGeneration: 1,
      heartbeatMs: 30_000,
      expiresAt: new Date(now.getTime() + 15 * 60 * 1000).toISOString(),
    });
    const renewLease = () => {
      lease = Object.freeze({ ...lease });
      return lease;
    };
    const residentInstanceRepository = Object.freeze({
      acquireInstanceLease() { return lease; },
      markStartupReconciled: renewLease,
      markMachineIntakeReconciled: renewLease,
      markMachineIntakeReconciliationFailed: renewLease,
      heartbeatInstanceLease: renewLease,
      assertInstanceLease() { return lease; },
      releaseInstanceLease() { released += 1; return true; },
    });
    const fatal = new Error(
      'autonomous_research_online_authority_evidence_renewal_inventory_scope_changed',
    );
    fatal.authorityEvidenceRenewalFatal = true;
    const onlineAuthorityEvidenceController = Object.freeze({
      policy: Object.freeze({ renewalLeadMs: 60_000 }),
      reconcile() { throw fatal; },
      assertCurrent() { throw fatal; },
    });
    const supervisor = createAutonomousResearchSupervisor(supervisorDependencies({
      campaignStore: Object.freeze({
        listCampaigns() { return []; },
        getCampaign() { return null; },
      }),
      stateRepository: Object.freeze({
        registerCampaign() {},
        reconcileStaleLeases() { return Object.freeze({ recovered: 0 }); },
      }),
      onlineAuthorityEvidenceController,
      residentInstanceRepository,
      clock: Object.freeze({ now: () => now }),
    }));

    await assert.rejects(supervisor.run(), (error) => (
      error === fatal && error.authorityEvidenceRenewalFatal === true
    ));
    assert.equal(released, 1);
  });

test('fatal state recoverability failure exits the resident and releases its instance lease',
  async () => {
    const now = new Date('2026-07-20T00:00:00.000Z');
    let released = 0;
    const lease = Object.freeze({
      ownerId: 'supervisor:state-recoverability-test',
      leaseGeneration: 1,
      heartbeatMs: 30_000,
      expiresAt: new Date(now.getTime() + 15 * 60 * 1000).toISOString(),
    });
    const residentInstanceRepository = Object.freeze({
      acquireInstanceLease() { return lease; },
      markStartupReconciled() { return lease; },
      markMachineIntakeReconciled() { return lease; },
      markMachineIntakeReconciliationFailed() { return lease; },
      heartbeatInstanceLease() { return lease; },
      assertInstanceLease() { return lease; },
      releaseInstanceLease() { released += 1; return true; },
    });
    const fatal = new Error('autonomous_research_state_recoverability_inventory_drift');
    fatal.stateRecoverabilityFatal = true;
    const stateRecoverabilityController = Object.freeze({
      reconcile() { throw fatal; },
      assertCurrent() { throw fatal; },
      markMutationFinalized() {},
      epochStatus() { return Object.freeze({ status: 'fatal' }); },
    });
    const executionController = new AbortController();
    const scheduler = Object.freeze({
      setInterval() { return Object.freeze({ interval: true }); },
      clearInterval() {},
      async sleep() {},
    });

    await assert.rejects(runAutonomousResearchResident({
      residentInstanceRepository,
      residentInstanceLeaseMs: 15 * 60 * 1000,
      residentInstanceHeartbeatMs: 30_000,
      ownerId: lease.ownerId,
      clock: Object.freeze({ now: () => now }),
      scheduler,
      executionController,
      runCycle: async () => stateRecoverabilityController.reconcile({
        reason: 'test_resident_cycle',
      }),
      pollMs: 1,
    }), (error) => (
      error === fatal && error.stateRecoverabilityFatal === true
    ));
    assert.equal(released, 1);
  });
