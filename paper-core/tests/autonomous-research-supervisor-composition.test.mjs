import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  composeAutonomousResearchSupervisor,
} from '../../paper-composition/automation/autonomous-research-supervisor-composition.mjs';
import {
  assertAutonomousResearchSupervisorStateSafety,
} from '../../paper-composition/automation/autonomous-research-supervisor-prerequisites.mjs';
import {
  bootstrapCampaignExecutionContext,
} from '../../paper-composition/bootstrap/campaign-execution-context-bootstrap.mjs';
import { createDefaultPaperStore } from '../../paper-adapters/persistence/store-provider.mjs';
import { createSqliteCampaignStore } from '../../paper-adapters/persistence/sqlite-campaign-store.mjs';
import { createSystemClock } from '../../paper-adapters/runtime/system-clock.mjs';
import {
  createReadOnlyAutonomousSubmissionHandoffOutboxFixture,
} from './support/autonomous-submission-handoff-fixture.mjs';

const H = (label) => hashRecord('AutonomousSupervisorTestHash', { label });

function readyNativeStoreMutationCoordinator() {
  const coveredDatabaseRoles = Object.freeze(['native-store']);
  return Object.freeze({
    implemented: true,
    coveredDatabaseRoles,
    executeMutation() {
      throw new Error('strict_context_test_did_not_authorize_mutation');
    },
    recoverPendingMutations() {
      return Object.freeze([]);
    },
    inspectStatus() {
      return Object.freeze({
        implemented: true,
        status: 'externally_fenced_sqlite_mutation_coordinator_ready',
        coveredDatabaseRoles,
        blockers: Object.freeze([]),
      });
    },
  });
}

test('strict campaign context uses the canonical externally fenced native store', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-strict-context-root-'));
  const runtimeRoot = fs.mkdtempSync(path.join(
    os.tmpdir(),
    'hepta-strict-context-runtime-',
  ));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  createDefaultPaperStore({ root, runtimeRoot }).close();

  const execution = bootstrapCampaignExecutionContext({
    root,
    runtimeRoot,
    mode: 'strict-native-store-contract-test',
    execute: true,
    nativeStoreMutationCoordinator: readyNativeStoreMutationCoordinator(),
    requireExternallyFencedNativeStore: true,
    serviceOverrides: {
      autonomousSubmissionOutbox:
        createReadOnlyAutonomousSubmissionHandoffOutboxFixture(),
    },
  });
  assert.equal(execution.context.services.persistenceSession.available(), true);
  assert.equal(execution.context.services.campaignStore.getCampaign('missing'), null);
  execution.context.services.persistenceSession.close();
  assert.equal(execution.context.services.persistenceSession.available(), false);
});

test('strict campaign context fails closed before creating runtime state', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-strict-gate-root-'));
  const runtimeRoot = fs.mkdtempSync(path.join(
    os.tmpdir(),
    'hepta-strict-gate-runtime-',
  ));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));

  assert.throws(
    () => bootstrapCampaignExecutionContext({
      root,
      runtimeRoot,
      execute: true,
      serviceOverrides: { store: {} },
      nativeStoreMutationCoordinator: readyNativeStoreMutationCoordinator(),
      requireExternallyFencedNativeStore: true,
    }),
    /^Error: autonomous_research_native_store_override_forbidden$/,
  );
  assert.deepEqual(fs.readdirSync(root), []);
  assert.deepEqual(fs.readdirSync(runtimeRoot), []);

  assert.throws(
    () => bootstrapCampaignExecutionContext({
      root,
      runtimeRoot,
      execute: true,
      requireExternallyFencedNativeStore: true,
    }),
    /ExternallyFencedSqliteMutationCoordinatorPort\.executeMutation is required/,
  );
  assert.deepEqual(fs.readdirSync(root), []);
  assert.deepEqual(fs.readdirSync(runtimeRoot), []);

  assert.throws(
    () => bootstrapCampaignExecutionContext({
      root,
      runtimeRoot,
      execute: true,
      nativeStoreMutationCoordinator: readyNativeStoreMutationCoordinator(),
      requireExternallyFencedNativeStore: true,
    }),
    /^Error: paper_store_not_initialized$/,
  );
  assert.deepEqual(fs.readdirSync(root), []);
  assert.deepEqual(fs.readdirSync(runtimeRoot), []);
});

test('composition reconciles the SQLite receipt mirror once before read-only runtime status', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-supervisor-mirror-root-'));
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-supervisor-mirror-runtime-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const clock = createSystemClock();
  const store = createDefaultPaperStore({ root, runtimeRoot });
  const campaigns = createSqliteCampaignStore({ store, clock });
  campaigns.createCampaign({
    campaignId: 'autonomous-research:mirror-order-paper',
    paperId: 'mirror-order-paper',
    budgets: {
      maxWallTimeMs: 60 * 60 * 1000,
      maxAgentCalls: 1,
      maxCpuJobs: 1,
      maxGpuJobs: 1,
      maxTokenCount: 1000,
      maxCostUsd: 10,
      maxMemoryMiB: 1024,
    },
    autonomousResearchPreparation: {
      proposal: { paperId: 'mirror-order-paper' },
    },
    nodes: [{
      nodeId: 'mirror-order-node',
      kind: 'agent',
      dependencies: [],
      maxAttempts: 1,
    }],
  });
  store.close();
  const events = [];
  const runtimeReceiptHash = H('composition-runtime-receipt');
  const composition = composeAutonomousResearchSupervisor({
    root,
    runtimeRoot,
    environment: {
      HEPTA_RESEARCH_AUTHOR_MAXIMUM_COST_PER_CALL_USD: '1',
      HEPTA_FORMAL_REVIEWER_MAXIMUM_COST_PER_CALL_USD: '1',
    },
    runtimeReproducibilityPolicy: {
      maximumAttemptsPerEpoch: 2,
      maximumCostUsdPerEpoch: 10,
      leaseMs: 1000,
      baseBackoffMs: 100,
      maximumBackoffMs: 1000,
      renewalLeadMs: 5000,
      actionSafetyMarginMs: 15 * 60 * 1000,
    },
    runtimeReproducibilityOverrides: {
      reconcileMirror() { events.push('mirror-reconcile'); return null; },
      readStatus({ now }) {
        events.push('runtime-status');
        return {
          ready: true,
          configuration: {
            ready: true,
            configurationIdentityHash: H('composition-runtime-configuration'),
            maximumVerificationCostUsd: 3,
            verificationCostAuthority: 'operator_declared_worst_case_usd',
            maximumVerifierTimeoutMs: 1000,
            minimumRefreshLeadMs: 3000,
            maximumReceiptAgeMs: 24 * 60 * 60 * 1000,
            blockers: [],
          },
          inspection: {
            ready: true,
            receiptHash: runtimeReceiptHash,
            issuedAt: now.toISOString(),
            expiresAt: new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString(),
          },
          blockers: [],
        };
      },
      async publish() { throw new Error('current_status_must_not_publish'); },
    },
    reconcileRuntimeOverride() { events.push('automation-reconcile'); return null; },
    readQualificationStateOverride: async () => null,
    providerCanaryOverride: async () => ({
      verified: true,
      providerCanaryPairReceiptHash: H('composition-canary'),
    }),
    renewQualificationOverride: async () => ({ ready: false, reason: 'deferred' }),
    dispatchCampaignOverride: async () => ({
      status: 'qualification_pending',
      campaign: { status: 'running' },
      fullAutomaticResearchWritingReady: false,
    }),
    pollMs: 60_000,
    serviceOverrides: {
      autonomousSubmissionOutbox:
        createReadOnlyAutonomousSubmissionHandoffOutboxFixture(),
    },
  });
  t.after(() => composition.close());
  assert.equal(composition.machineIntakeConfigured, false);
  assert.equal(composition.coldStartAutonomyReady, false);
  await composition.supervisor.runCycle();
  await composition.supervisor.runCycle();
  assert.deepEqual(events.slice(0, 3), [
    'mirror-reconcile',
    'automation-reconcile',
    'runtime-status',
  ]);
  assert.equal(events.filter((event) => event === 'mirror-reconcile').length, 1);
  assert.equal(events.filter((event) => event === 'runtime-status').length, 1);
});

test('state-safety prerequisites reuse fresh active evidence after database activation', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-supervisor-safety-root-'));
  const runtimeRoot = fs.mkdtempSync(path.join(
    os.tmpdir(),
    'hepta-supervisor-safety-runtime-',
  ));
  const workspaceRoot = fs.mkdtempSync(path.join(
    os.tmpdir(),
    'hepta-supervisor-safety-workspace-',
  ));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  t.after(() => fs.rmSync(workspaceRoot, { recursive: true, force: true }));
  const now = new Date('2026-07-18T09:00:00.000Z');
  let stateSafetyInspections = 0;
  assert.throws(
    () => assertAutonomousResearchSupervisorStateSafety({
      required: true,
      workspaceRoot,
      runtimeRoot,
      environment: {},
      clock: { now: () => now },
      inspector(input) {
        stateSafetyInspections += 1;
        assert.equal(input.workspaceRoot, workspaceRoot);
        assert.equal(input.runtimeRoot, runtimeRoot);
        assert.equal(input.now, now);
        assert.deepEqual(input.environment, {});
        return Object.freeze({
          ready: false,
          blockers: Object.freeze(['online_mutation_authority_unavailable']),
        });
      },
    }),
    /^Error: autonomous_research_supervisor_state_safety_required$/,
  );
  assert.equal(stateSafetyInspections, 1);
  assert.deepEqual(fs.readdirSync(runtimeRoot), []);

  let activationFailureInspection = 0;
  assert.throws(
    () => assertAutonomousResearchSupervisorStateSafety({
      required: true,
      workspaceRoot,
      runtimeRoot,
      environment: {
        HEPTA_AUTONOMOUS_RESEARCH_ONLINE_MUTATION_AUTHORITY_PROCESS_CONFIG:
          '/run/hepta/online-authority-process.json',
        HEPTA_AUTONOMOUS_RESEARCH_ONLINE_MUTATION_AUTHORITY_CONFIG:
          '/run/hepta/online-authority-public.json',
      },
      clock: { now: () => now },
      composeStateBackupService() {
        return Object.freeze({
          inventory: () => Object.freeze({ status: 'inventory-ready' }),
          offhostSources: () => Object.freeze({ status: 'restore-ready' }),
        });
      },
      activateMutationRuntime() {
        throw new Error('private_activation_failure_detail');
      },
      inspector() {
        activationFailureInspection += 1;
        return Object.freeze({ ready: false, blockers: Object.freeze(['blocked']) });
      },
    }),
    /^Error: autonomous_research_supervisor_state_safety_required$/,
  );
  assert.equal(activationFailureInspection, 1);

  assert.throws(
    () => assertAutonomousResearchSupervisorStateSafety({
      required: true,
      workspaceRoot,
      runtimeRoot,
      environment: {
        HEPTA_AUTONOMOUS_RESEARCH_ONLINE_MUTATION_AUTHORITY_PROCESS_CONFIG:
          '/run/hepta/online-authority-process.json',
        HEPTA_AUTONOMOUS_RESEARCH_ONLINE_MUTATION_AUTHORITY_CONFIG:
          '/run/hepta/online-authority-public.json',
      },
      clock: { now: () => now },
      composeStateBackupService: () => Object.freeze({
        inventory: () => Object.freeze({ status: 'inventory-ready' }),
        offhostSources: () => Object.freeze({ status: 'restore-ready' }),
      }),
      activateMutationRuntime: () => Object.freeze({
        coordinator: Object.freeze({
          inspectStatus: () => Object.freeze({
            status: 'externally_fenced_sqlite_mutation_coordinator_ready',
          }),
        }),
        receipt: Object.freeze({
          status: 'autonomous_research_online_mutation_runtime_activated',
          coordinatorRuntimeReady: true,
        }),
      }),
      inspector: () => Object.freeze({ ready: true, blockers: Object.freeze([]) }),
    }),
    /^Error: autonomous_research_supervisor_state_safety_required$/,
  );

  const activeEvents = [];
  const activeInventory = Object.freeze({
    status: 'autonomous_research_state_database_inventory_ready',
    instances: Object.freeze([]),
  });
  const activeCoordinator = Object.freeze({
    kind: 'test-online-mutation-coordinator',
    inspectStatus: () => Object.freeze({
      status: 'externally_fenced_sqlite_mutation_coordinator_ready',
      blockers: Object.freeze([]),
    }),
  });
  const restoreDrill = Object.freeze({
    status: 'restore-drill-ready',
    headSequence: 7,
    headHash: H('activation-head'),
  });
  const activeInspection = Object.freeze({
    status: 'autonomous_research_online_anti_rollback_ready',
    inspectionMode: 'active-external-authority-challenge',
  });
  const result = assertAutonomousResearchSupervisorStateSafety({
      required: true,
      workspaceRoot,
      runtimeRoot,
      environment: {
        HEPTA_AUTONOMOUS_RESEARCH_ONLINE_MUTATION_AUTHORITY_PROCESS_CONFIG:
          '/run/hepta/online-authority-process.json',
        HEPTA_AUTONOMOUS_RESEARCH_ONLINE_MUTATION_AUTHORITY_CONFIG:
          '/run/hepta/online-authority-public.json',
      },
      clock: { now: () => now },
      composeStateBackupService(input) {
        activeEvents.push(['backup', input]);
        return Object.freeze({
          inventory: () => activeInventory,
          offhostSources: () => restoreDrill,
          observeBundleHead: async () => Object.freeze({ status: 'unused' }),
          restoreDrill: async () => Object.freeze({ status: 'unused' }),
          reconcilePending: async () => Object.freeze({ status: 'unused' }),
          reconcileAndRenew: async () => Object.freeze({ status: 'unused' }),
        });
      },
      activateMutationRuntime(input) {
        activeEvents.push(['activate', input]);
        return Object.freeze({
          coordinator: activeCoordinator,
          receipt: Object.freeze({
            status: 'autonomous_research_online_mutation_runtime_activated',
            coordinatorRuntimeReady: true,
            authorityGlobalSequence: 7,
            authorityGlobalHash: H('activation-head'),
          }),
          activeInspection,
        });
      },
      inspector(input) {
        activeEvents.push(['safety-inspection', input]);
        assert.equal(input.mutationCoordinator, activeCoordinator);
        assert.equal(input.onlineAntiRollbackInspection, activeInspection);
        return Object.freeze({ ready: true, blockers: Object.freeze([]) });
      },
    });
  assert.deepEqual(activeEvents.map(([event]) => event), [
    'backup', 'activate', 'safety-inspection',
  ]);
  assert.equal(activeEvents[1][1].inventory, activeInventory);
  assert.equal(activeEvents[1][1].latestRestoreDrill, restoreDrill);
  assert.equal(activeEvents[1][1].resolveInventory(), activeInventory);
  assert.equal(
    activeEvents[0][1].onlineMutationAuthorityProcessConfigurationPath,
    '/run/hepta/online-authority-process.json',
  );
  assert.equal(
    activeEvents[1][1].authorityProcessConfigurationPath,
    '/run/hepta/online-authority-process.json',
  );
  assert.equal(
    activeEvents[1][1].authorityConfigurationPath,
    '/run/hepta/online-authority-public.json',
  );
  assert.equal(result.mutationCoordinator, activeCoordinator);
  assert.equal(result.activationReceipt.coordinatorRuntimeReady, true);
});

test('fully-autonomous composition rejects strict overrides before filesystem or DB I/O', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-supervisor-gate-root-'));
  const runtimeRoot = fs.mkdtempSync(path.join(
    os.tmpdir(),
    'hepta-supervisor-gate-runtime-',
  ));
  const workspaceRoot = fs.mkdtempSync(path.join(
    os.tmpdir(),
    'hepta-supervisor-gate-workspace-',
  ));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  t.after(() => fs.rmSync(workspaceRoot, { recursive: true, force: true }));
  const base = {
    root,
    runtimeRoot,
    workspaceRoot,
    requireFullyAutonomous: true,
    environment: {},
  };
  const cases = [
    ['serviceOverrides', (called) => {
      const serviceOverrides = {};
      Object.defineProperty(serviceOverrides, 'store', {
        enumerable: true,
        get() { called.count += 1; return {}; },
      });
      return { serviceOverrides };
    }],
    ['runtimeReproducibilityOverrides', (called) => ({
      runtimeReproducibilityOverrides: {
        stateRepository: { close() { called.count += 1; } },
      },
    })],
    ['dispatchCampaignOverride', (called) => ({
      dispatchCampaignOverride() { called.count += 1; },
    })],
    ['providerCanaryOverride', (called) => ({
      providerCanaryOverride() { called.count += 1; },
    })],
    ['renewQualificationOverride', (called) => ({
      renewQualificationOverride() { called.count += 1; },
    })],
    ['readQualificationStateOverride', (called) => ({
      readQualificationStateOverride() { called.count += 1; },
    })],
    ['reconcileRuntimeOverride', (called) => ({
      reconcileRuntimeOverride() { called.count += 1; },
    })],
    ['stateSafetyInspector', (called) => ({
      stateSafetyInspector() { called.count += 1; return { ready: true }; },
    })],
    ['stateSafetyActiveAuthorityRefresh', (called) => ({
      stateSafetyActiveAuthorityRefresh() { called.count += 1; },
    })],
    ['composeStateSafetyBackupService', (called) => ({
      composeStateSafetyBackupService() { called.count += 1; return {}; },
    })],
    ['stateSafetyClock', (called) => ({
      stateSafetyClock: { now() { called.count += 1; return new Date(); } },
    })],
    ['createQualificationPointerRepository', (called) => ({
      createQualificationPointerRepository() { called.count += 1; return {}; },
    })],
    ['bootstrapExecutionContext', (called) => ({
      bootstrapExecutionContext() { called.count += 1; return {}; },
    })],
    ['composeSupervisorState', (called) => ({
      composeSupervisorState() { called.count += 1; return {}; },
    })],
  ];
  for (const [name, overrides] of cases) {
    const called = { count: 0 };
    assert.throws(
      () => composeAutonomousResearchSupervisor({ ...base, ...overrides(called) }),
      new RegExp(
        `^Error: autonomous_research_supervisor_fully_autonomous_override_forbidden:${name}$`,
      ),
    );
    assert.equal(called.count, 0, `${name} must not be invoked`);
    assert.deepEqual(fs.readdirSync(root), []);
    assert.deepEqual(fs.readdirSync(runtimeRoot), []);
    assert.deepEqual(fs.readdirSync(workspaceRoot), []);
  }
});

test('ordinary supervisor composition keeps dependency overrides compatible', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-supervisor-ordinary-root-'));
  const runtimeRoot = fs.mkdtempSync(path.join(
    os.tmpdir(),
    'hepta-supervisor-ordinary-runtime-',
  ));
  const workspaceRoot = fs.mkdtempSync(path.join(
    os.tmpdir(),
    'hepta-supervisor-ordinary-workspace-',
  ));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  t.after(() => fs.rmSync(workspaceRoot, { recursive: true, force: true }));
  let ordinaryModeSafetyInspections = 0;
  let qualificationPointerConstructions = 0;
  assert.throws(() => composeAutonomousResearchSupervisor({
    root,
    runtimeRoot,
    workspaceRoot,
    environment: {},
    stateSafetyInspector() {
      ordinaryModeSafetyInspections += 1;
      throw new Error('ordinary_mode_must_not_inspect_state_safety');
    },
    createQualificationPointerRepository() {
      qualificationPointerConstructions += 1;
      throw new Error('ordinary_mode_reached_writable_composition');
    },
  }), /ordinary_mode_reached_writable_composition/);
  assert.equal(ordinaryModeSafetyInspections, 0);
  assert.equal(qualificationPointerConstructions, 1);
});
