import assert from 'node:assert/strict';
import test from 'node:test';

import {
  validateExternallyFencedSqliteMutationCoordinatorConfiguration,
} from '../../paper-adapters/automation/externally-fenced-sqlite-mutation-coordinator-configuration.mjs';

const DATABASE_ROLE = 'test-authority';
const REQUIRED = 'test_external_mutation_coordinator_required';

function coordinator({
  implemented = true,
  statusImplemented = true,
  status = 'externally_fenced_sqlite_mutation_coordinator_ready',
  blockers = [],
  coordinatorRoles = [DATABASE_ROLE],
  statusRoles = [DATABASE_ROLE],
} = {}) {
  return Object.freeze({
    implemented,
    coveredDatabaseRoles: Object.freeze(coordinatorRoles),
    executeMutation() {},
    recoverPendingMutations() {},
    inspectStatus() {
      return Object.freeze({
        implemented: statusImplemented,
        status,
        blockers: Object.freeze(blockers),
        coveredDatabaseRoles: Object.freeze(statusRoles),
      });
    },
  });
}

function validate(mutationCoordinator, overrides = {}) {
  return validateExternallyFencedSqliteMutationCoordinatorConfiguration({
    mutationCoordinator,
    requireExternallyFencedMutations: true,
    offlineProvision: false,
    databaseRole: DATABASE_ROLE,
    requiredErrorCode: REQUIRED,
    ...overrides,
  });
}

test('shared coordinator configuration accepts only a ready role-covered coordinator', () => {
  const candidate = coordinator();
  assert.equal(validate(candidate), candidate);
});

test('shared coordinator configuration preserves optional and port-validation semantics', () => {
  assert.equal(validate(null, { requireExternallyFencedMutations: false }), null);
  assert.throws(
    () => validate({ inspectStatus() {} }, { requireExternallyFencedMutations: false }),
    /ExternallyFencedSqliteMutationCoordinatorPort.executeMutation is required/,
  );
});

test('shared coordinator configuration fails closed with the bounded-context error', () => {
  const rejected = [
    [null, {}],
    [coordinator(), { offlineProvision: true }],
    [coordinator({ implemented: false }), {}],
    [coordinator({ statusImplemented: false }), {}],
    [coordinator({ status: 'externally_fenced_sqlite_mutation_coordinator_configured' }), {}],
    [coordinator({ blockers: ['external_authority_unavailable'] }), {}],
    [coordinator({ coordinatorRoles: [] }), {}],
    [coordinator({ statusRoles: [] }), {}],
  ];
  for (const [candidate, overrides] of rejected) {
    assert.throws(() => validate(candidate, overrides), (error) => error.message === REQUIRED);
  }
});
