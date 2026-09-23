import assert from 'node:assert/strict';
import test from 'node:test';

import {
  executeAutonomousResearchOnlineSchemaTransition,
  planAutonomousResearchOnlineSchemaTransition,
} from '../../paper-adapters/automation/autonomous-research-online-schema-transition.mjs';
import {
  autonomousResearchOnlineSchemaTransitionControlPaths,
  readAutonomousResearchOnlineSchemaTransitionJson,
} from '../../paper-adapters/automation/autonomous-research-online-schema-transition-state-repository.mjs';
import {
  controlledClock,
  createAuthority,
  fixture,
  stateDatabaseManifest,
  transitionInput,
} from './support/autonomous-research-online-schema-transition-fixture.mjs';

test('crash after a committed instance resumes under the stored signed reservation', (context) => {
  const setup = fixture(context);
  const clock = controlledClock();
  const authority = createAuthority(setup.runtimeRoot);
  const input = transitionInput(setup, clock, authority);
  const planned = planAutonomousResearchOnlineSchemaTransition(input);
  assert.throws(() => executeAutonomousResearchOnlineSchemaTransition({
    ...input,
    expectedTransitionId: planned.plan.transitionId,
    faultInjector(event) {
      if (event.point === 'after_instance_commit' && event.completedCount === 1) {
        throw new Error('schema_transition_test_crash');
      }
    },
  }), /schema_transition_test_crash/);
  const paths = autonomousResearchOnlineSchemaTransitionControlPaths(setup.runtimeRoot, {
    create: false,
  });
  const interrupted = readAutonomousResearchOnlineSchemaTransitionJson(paths.activeStatePath);
  assert.equal(interrupted.phase, 'installing');
  assert.equal(interrupted.installations.length, 1);
  assert.equal(authority.calls.reserve, 1);

  const resumePlan = planAutonomousResearchOnlineSchemaTransition(input);
  assert.equal(resumePlan.status, 'autonomous_research_online_schema_transition_resume_ready');
  assert.deepEqual(resumePlan.completedInstanceIds,
    interrupted.installations.map((entry) => entry.databaseInstanceId));
  clock.advance(1000);
  const resumed = executeAutonomousResearchOnlineSchemaTransition({
    ...input,
    expectedTransitionId: planned.plan.transitionId,
  });
  assert.equal(resumed.status, 'autonomous_research_online_schema_transition_ready');
  assert.equal(resumed.installedDatabaseCount, stateDatabaseManifest.databases.length);
  assert.equal(authority.calls.reserve, 1);
  assert.equal(authority.calls.finalize, 1);
});

test('reserve intent survives an authority-committed response loss', (context) => {
  const setup = fixture(context);
  const clock = controlledClock();
  const authority = createAuthority(setup.runtimeRoot);
  let committedReservation = null;
  let committedRequest = null;
  const responseLostClient = Object.freeze({
    ...authority.client,
    reserveSchemaTransition(input) {
      if (!committedReservation) {
        committedRequest = structuredClone(input.request);
        committedReservation = authority.client.reserveSchemaTransition(input);
        throw new Error('fixture_reserve_response_lost_after_authority_commit');
      }
      assert.deepEqual(input.request, committedRequest);
      return committedReservation;
    },
  });
  const input = Object.freeze({
    ...transitionInput(setup, clock, authority),
    createAuthorityClient: () => responseLostClient,
  });
  const plan = planAutonomousResearchOnlineSchemaTransition(input).plan;
  assert.throws(() => executeAutonomousResearchOnlineSchemaTransition({
    ...input,
    expectedTransitionId: plan.transitionId,
  }), /fixture_reserve_response_lost_after_authority_commit/);
  const paths = autonomousResearchOnlineSchemaTransitionControlPaths(
    setup.runtimeRoot,
    { create: false },
  );
  const intent = readAutonomousResearchOnlineSchemaTransitionJson(paths.activeStatePath);
  assert.equal(intent.phase, 'reserve-requested');
  assert.deepEqual(intent.reserveRequest, committedRequest);
  assert.equal(intent.reservation, undefined);
  const report = executeAutonomousResearchOnlineSchemaTransition({
    ...input,
    expectedTransitionId: plan.transitionId,
  });
  assert.equal(report.ready, true);
  assert.equal(authority.calls.reserve, 1);
});

test('finalize intent recovers an authority response after the reservation lease expires', (
  context,
) => {
  const setup = fixture(context);
  const clock = controlledClock();
  const authority = createAuthority(setup.runtimeRoot);
  let committedFinalization = null;
  let committedRequest = null;
  const responseLostClient = Object.freeze({
    ...authority.client,
    finalizeSchemaTransition(input) {
      if (!committedFinalization) {
        committedRequest = structuredClone(input.request);
        committedFinalization = authority.client.finalizeSchemaTransition(input);
        throw new Error('fixture_finalize_response_lost_after_authority_commit');
      }
      assert.deepEqual(input.request, committedRequest);
      return committedFinalization;
    },
  });
  const input = Object.freeze({
    ...transitionInput(setup, clock, authority),
    createAuthorityClient: () => responseLostClient,
  });
  const plan = planAutonomousResearchOnlineSchemaTransition(input).plan;
  assert.throws(() => executeAutonomousResearchOnlineSchemaTransition({
    ...input,
    expectedTransitionId: plan.transitionId,
  }), /fixture_finalize_response_lost_after_authority_commit/);
  const paths = autonomousResearchOnlineSchemaTransitionControlPaths(
    setup.runtimeRoot,
    { create: false },
  );
  const intent = readAutonomousResearchOnlineSchemaTransitionJson(paths.activeStatePath);
  assert.equal(intent.phase, 'finalization-requested');
  assert.deepEqual(intent.finalizeRequest, committedRequest);
  assert.equal(intent.finalization, undefined);
  clock.advance(120001);
  const report = executeAutonomousResearchOnlineSchemaTransition({
    ...input,
    expectedTransitionId: plan.transitionId,
  });
  assert.equal(report.ready, true);
  assert.equal(authority.calls.finalize, 1);
  assert.deepEqual(report.receipt.finalizeRequest, committedRequest);
  assert.deepEqual(report.receipt.finalization, committedFinalization);
});
