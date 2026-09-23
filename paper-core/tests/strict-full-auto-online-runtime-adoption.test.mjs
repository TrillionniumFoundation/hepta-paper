import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  autonomousResearchPristineRuntimeStateHash,
} from '../../paper-adapters/automation/autonomous-research-pristine-runtime-state.mjs';
import {
  runtimeRootIdentity,
} from '../../paper-adapters/automation/strict-full-auto-acceptance-control-paths.mjs';
import {
  AUTONOMOUS_SUBMISSION_HANDOFF_SCHEMA_MIGRATIONS,
} from '../../paper-adapters/persistence/autonomous-submission-handoff-store.mjs';
import {
  AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES,
} from '../../paper-domain/automation/autonomous-research-state-backup-contract.mjs';
import {
  strictFullAutoAcceptanceHash,
} from '../../paper-domain/automation/strict-full-auto-acceptance-contract.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  STRICT_FULL_AUTO_ACCEPTANCE_TEST_NOW as NOW,
  strictFullAutoAcceptanceFixture as fixture,
  strictFullAutoAcceptanceOrchestratorFor as orchestratorFor,
  strictFullAutoAcceptanceSuccessfulOutput as successfulOutput,
  strictFullAutoAcceptanceSuccessfulRunner as successfulRunner,
} from './support/strict-full-auto-acceptance-fixture.mjs';

const fixtureHash = (label) => strictFullAutoAcceptanceHash({ fixture: label });

function pristineRuntimeInspection(runtimeRoot, mutate = () => {}) {
  const runtimeIdentity = runtimeRootIdentity({ runtimeRoot });
  const stateDatabaseManifestHash = fixtureHash('state-database-manifest');
  const instances = [...AUTONOMOUS_RESEARCH_STATE_DATABASE_ROLES].sort().map((role) => ({
    databaseRole: role,
    databaseInstanceId: role,
    sourceRelativePath: `autonomous-research/${role}.sqlite`,
    fileIdentityHash: fixtureHash(`identity:${role}`),
    sha256: fixtureHash(`database:${role}`),
    schemaContractId: `${role}-schema-v1`,
    schemaHash: fixtureHash(`schema:${role}`),
    stateHeadSequence: 0,
    stateHeadHash: fixtureHash(`head:${role}`),
    stateHeadStateHash: fixtureHash(`state:${role}`),
    markerCount: 0,
    finalizationCount: 0,
    businessRowCount: 0,
  }));
  const pristineRuntimeStateHash = autonomousResearchPristineRuntimeStateHash(
    instances.map((instance) => {
      const cutoverId = 'fixture-cutover';
      const instanceNonce = 'fixture-instance-nonce';
      const cutoverIdentityHash = hashRecord(
        'AutonomousSubmissionHandoffDatabaseIdentity',
        {
          cutoverId,
          databasePath: 'submission-handoff.sqlite',
          migrationHash: AUTONOMOUS_SUBMISSION_HANDOFF_SCHEMA_MIGRATIONS[0].migrationHash,
          instanceNonce,
        },
      );
      const roleBindings = instance.databaseRole === 'native-store'
        ? { cutoverId, handoffDatabaseIdentityHash: cutoverIdentityHash }
        : instance.databaseRole === 'submission-handoff'
          ? { cutoverId, instanceNonce, nativeCutoverIdentityHash: cutoverIdentityHash }
          : ['machine-intake', 'topic-producer'].includes(instance.databaseRole)
            ? {
              machineIntakeConfigurationHash: fixtureHash('machine-intake-config'),
              producerProfileHash: fixtureHash('producer-profile'),
            }
            : {};
      const semanticBindings = {
        ...roleBindings,
        onlineAuthority: {
          databaseScopeHash: fixtureHash('database-scope'),
          writerManifestHash: fixtureHash('writer-manifest'),
          globalSequence: 0,
          globalHash: fixtureHash('authority-global-head'),
          databaseSequence: instance.stateHeadSequence,
          databaseHash: instance.stateHeadHash,
          stateHash: instance.stateHeadStateHash,
        },
      };
      return {
        version: 1,
        kind: 'AutonomousResearchPristineDatabaseStateInspection',
        status: 'autonomous_research_pristine_database_state_ready',
        databaseRole: instance.databaseRole,
        databaseInstanceId: instance.databaseInstanceId,
        schemaContractId: instance.schemaContractId,
        schemaHash: instance.schemaHash,
        phase: 'adoption',
        policyHash: fixtureHash('pristine-policy'),
        semanticBindings,
        businessRowCount: 0,
        pristineStateHash: fixtureHash(`pristine:${instance.databaseRole}`),
      };
    }),
  );
  const evidenceFreshThrough = new Date(Date.parse(NOW) + 4 * 60 * 1000).toISOString();
  const body = {
    version: 1,
    kind: 'AutonomousResearchPristineRuntimeInspectionReceipt',
    status: 'autonomous_research_pristine_runtime_inspection_ready',
    inspectedAt: NOW,
    runtimeRootIdentityHash: runtimeIdentity.runtimeRootIdentityHash,
    stateDatabaseManifestHash,
    databaseScopeHash: fixtureHash('database-scope'),
    writerManifestHash: fixtureHash('writer-manifest'),
    inventoryHash: fixtureHash('inventory'),
    pristineRuntimeStateHash,
    authority: {
      authorityId: 'fixture-authority',
      keyId: 'fixture-key',
      scopeId: 'fixture-scope',
      configurationHash: fixtureHash('authority-configuration'),
      writerManifestHash: fixtureHash('writer-manifest'),
      observationReceiptHash: fixtureHash('authority-observation'),
      schemaTransitionState: 'finalized',
      schemaRebindFinalizationReceiptHash: fixtureHash('schema-rebind-finalization'),
      schemaRebindTargetConfigurationHash: fixtureHash('authority-configuration'),
      globalSequence: 0,
      globalHash: fixtureHash('authority-global-head'),
      databaseHeads: instances.map((instance) => ({
        databaseInstanceId: instance.databaseInstanceId,
        schemaHash: instance.schemaHash,
        sequence: instance.stateHeadSequence,
        hash: instance.stateHeadHash,
        stateHash: instance.stateHeadStateHash,
      })),
      writerQuiescenceStatus: 'pre_resident_writer_quiescence_verified',
      writerQuiescenceReceiptHash: fixtureHash('writer-quiescence'),
      writerQuiescenceScopeHash: fixtureHash('database-scope'),
      writerQuiescenceFreshThrough: evidenceFreshThrough,
      unfinishedSchemaTransitionCount: 0,
      unfinishedSchemaRebindCount: 0,
      unfinishedMutationCount: 0,
      unfinishedBackupCount: 0,
    },
    instances,
    businessRowCount: 0,
    adoptionMutationPerformed: false,
    preResidentSchemaRebindVerified: true,
    evidenceFreshThrough,
  };
  mutate(body);
  return Object.freeze({
    ...body,
    receiptHash: strictFullAutoAcceptanceHash(body),
  });
}

function enablePristineRuntimeAdoption(configuration, inspection) {
  configuration.runtimeRootAdoption = {
    version: 1,
    kind: 'StrictFullAutoAcceptanceRuntimeRootAdoptionPolicy',
    mode: 'verified-pristine-existing-runtime',
    expectedRuntimeRootIdentityHash: inspection.runtimeRootIdentityHash,
    expectedPristineRuntimeStateHash: inspection.pristineRuntimeStateHash,
    adoptionMutationPerformed: false,
    preResidentSchemaRebindRequired: true,
  };
}

test('pre-resident pristine adoption is explicit and adopted provisioning verifies without dispatch',
  async (t) => {
    let inspection;
    const value = fixture(t, ({ configuration, runtimeRoot }) => {
      fs.mkdirSync(runtimeRoot, { mode: 0o700 });
      inspection = pristineRuntimeInspection(runtimeRoot);
      enablePristineRuntimeAdoption(configuration, inspection);
    });
    let inspectionCalls = 0;
    const pristineRuntimeInspector = {
      inspect() {
        inspectionCalls += 1;
        return structuredClone(inspection);
      },
    };
    const calls = [];
    const service = orchestratorFor(value.configurationPath, {
      async run({ step, phase, invocation }) {
        calls.push(`${step.stepId}:${phase}`);
        return successfulOutput(invocation, { stepId: step.stepId, phase });
      },
    }, { pristineRuntimeInspector });
    const plan = service.plan();
    await assert.rejects(
      service.execute({ expectedPlanHash: plan.planHash }),
      /pristine_runtime_adoption_required/,
    );
    assert.equal(inspectionCalls, 0);
    assert.equal(service.repository.readState(plan), null);
    assert.equal(service.repository.readPristineRuntimeAdoption(plan), null);

    const candidate = service.inspectRuntimeAdoptionCandidate();
    assert.equal(candidate.expectedRuntimeRootIdentityHash,
      plan.runtimeRootAdoption.expectedRuntimeRootIdentityHash);
    assert.equal(candidate.expectedPristineRuntimeStateHash,
      plan.runtimeRootAdoption.expectedPristineRuntimeStateHash);
    assert.equal(candidate.adoptionMutationPerformed, false);
    assert.equal(candidate.preResidentSchemaRebindVerified, true);
    assert.equal(inspectionCalls, 2);
    assert.equal(service.repository.readState(plan), null);
    assert.equal(service.repository.readPristineRuntimeAdoption(plan), null);

    await assert.rejects(service.adoptRuntime({
      expectedPlanHash: fixtureHash('wrong-plan'),
    }), /explicit_plan_hash_required/);
    const adopted = await service.adoptRuntime({ expectedPlanHash: plan.planHash });
    assert.equal(adopted.ready, true);
    assert.equal(adopted.adoptionRequired, true);
    assert.equal(inspectionCalls, 4);
    assert.equal(service.repository.readState(plan), null);
    const adoption = service.repository.readPristineRuntimeAdoption(plan);
    const activation = service.repository.readRuntimeRootActivation(plan);
    assert.equal(activation.version, 2);
    assert.equal(activation.adoptionReceiptHash, adoption.adoptionReceiptHash);

    const result = await service.execute({ expectedPlanHash: plan.planHash });
    assert.equal(result.strictFullAutoAccepted, true);
    assert.equal(inspectionCalls, 4);
    assert.equal(calls.includes('state-provisioning:execute'), false);
    assert.equal(calls.includes('state-provisioning:verify'), true);
    const state = service.repository.readState(plan);
    const provisioning = state.completedStepReceipts.find((receipt) => (
      receipt.stepId === 'state-provisioning'
    ));
    assert.equal(provisioning.executionBasis.kind,
      'StrictFullAutoAcceptanceAdoptedProvisioningExecutionBasis');
    assert.equal(provisioning.executionBasis.adoptionReceiptHash,
      adoption.adoptionReceiptHash);
    assert.equal(provisioning.executionOutputHash,
      strictFullAutoAcceptanceHash(provisioning.executionBasis));
    const provisioningDispatch = path.join(
      value.controlRoot,
      'plans',
      plan.planHash.slice('sha256:'.length),
      'dispatches',
      '01-state-provisioning.json',
    );
    assert.equal(fs.existsSync(provisioningDispatch), false);
  });

test('pristine adoption rejects double-read drift, missing quiescence and durable receipt drift',
  async (t) => {
    let base;
    const drifted = fixture(t, ({ configuration, runtimeRoot }) => {
      fs.mkdirSync(runtimeRoot, { mode: 0o700 });
      base = pristineRuntimeInspection(runtimeRoot);
      enablePristineRuntimeAdoption(configuration, base);
    });
    let reads = 0;
    const driftService = orchestratorFor(drifted.configurationPath, successfulRunner(), {
      pristineRuntimeInspector: {
        inspect() {
          reads += 1;
          return reads === 1 ? structuredClone(base) : pristineRuntimeInspection(
            drifted.runtimeRoot,
            (receipt) => { receipt.authority.observationReceiptHash = fixtureHash('drift'); },
          );
        },
      },
    });
    const driftPlan = driftService.plan();
    await assert.rejects(
      driftService.adoptRuntime({ expectedPlanHash: driftPlan.planHash }),
      /double_inspection_drift/,
    );
    assert.equal(driftService.repository.readState(driftPlan), null);
    assert.equal(driftService.repository.readPristineRuntimeAdoption(driftPlan), null);

    let noQuiescence;
    const unquiesced = fixture(t, ({ configuration, runtimeRoot }) => {
      fs.mkdirSync(runtimeRoot, { mode: 0o700 });
      noQuiescence = pristineRuntimeInspection(runtimeRoot,
        (receipt) => { receipt.authority.writerQuiescenceStatus = 'writers_active'; });
      enablePristineRuntimeAdoption(configuration, noQuiescence);
    });
    const unquiescedService = orchestratorFor(
      unquiesced.configurationPath,
      successfulRunner(),
      { pristineRuntimeInspector: { inspect: () => structuredClone(noQuiescence) } },
    );
    const unquiescedPlan = unquiescedService.plan();
    await assert.rejects(
      unquiescedService.adoptRuntime({ expectedPlanHash: unquiescedPlan.planHash }),
      /pristine_runtime_inspection_invalid/,
    );
    assert.equal(unquiescedService.repository.readState(unquiescedPlan), null);

    let stable;
    const tampered = fixture(t, ({ configuration, runtimeRoot }) => {
      fs.mkdirSync(runtimeRoot, { mode: 0o700 });
      stable = pristineRuntimeInspection(runtimeRoot);
      enablePristineRuntimeAdoption(configuration, stable);
    });
    const tamperedService = orchestratorFor(tampered.configurationPath, successfulRunner(), {
      pristineRuntimeInspector: { inspect: () => structuredClone(stable) },
    });
    const tamperedPlan = tamperedService.plan();
    await tamperedService.adoptRuntime({ expectedPlanHash: tamperedPlan.planHash });
    const adoptionPath = tamperedService.repository.controlStore
      .pristineRuntimeAdoptionPath(tamperedPlan);
    const changed = JSON.parse(fs.readFileSync(adoptionPath, 'utf8'));
    changed.authorityGlobalHash = fixtureHash('changed-authority-head');
    const { adoptionReceiptHash: _oldHash, ...changedBody } = changed;
    changed.adoptionReceiptHash = strictFullAutoAcceptanceHash(changedBody);
    fs.writeFileSync(adoptionPath, `${JSON.stringify(changed)}\n`);
    await assert.rejects(
      tamperedService.execute({ expectedPlanHash: tamperedPlan.planHash }),
      /runtime_root_adoption_binding_invalid/,
    );
    assert.equal(tamperedService.repository.readState(tamperedPlan), null);
  });
