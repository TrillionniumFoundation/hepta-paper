import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createPackageRecoveryDeletionLease,
  createPackageRecoveryDeletionLeaseAcquireRequest,
  createPackageRecoveryDeletionLeaseCommand,
  createPackageRecoveryDeletionLeaseOperationReceipt,
  packageRecoveryDeletionLeaseFenceTokenHash,
  renewPackageRecoveryDeletionLease,
  verifyPackageRecoveryDeletionLease,
  verifyPackageRecoveryDeletionLeaseAcquireRequest,
  verifyPackageRecoveryDeletionLeaseCommand,
  verifyPackageRecoveryDeletionLeaseOperationReceipt,
} from '../../paper-domain/automation/package-recovery-deletion-lease-contract.mjs';
import {
  createPackageRecoveryDeletionLeasePort,
} from '../../paper-application/automation/package-recovery-deletion-lease-client.mjs';
import {
  createPackageRecoveryDeletionLeaseResumeRequest,
  createPackageRecoveryDeletionLeaseResumeResolution,
} from '../../paper-domain/automation/package-recovery-deletion-lease-resume-contract.mjs';
import { assertPackageRecoveryDeletionLeasePort }
  from '../../paper-ports/package-recovery-deletion-lease-port.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const TOKEN_1 = 'opaque-recovery-deletion-token-generation-0001';
const TOKEN_2 = 'opaque-recovery-deletion-token-generation-0002';
const TIMES = Object.freeze({
  requested: '2026-08-20T06:00:00.000Z',
  acquired: '2026-08-20T06:00:01.000Z',
  acquireObserved: '2026-08-20T06:00:02.000Z',
  assertRequested: '2026-08-20T06:00:03.000Z',
  asserted: '2026-08-20T06:00:04.000Z',
  assertObserved: '2026-08-20T06:00:05.000Z',
  renewRequested: '2026-08-20T06:00:06.000Z',
  renewed: '2026-08-20T06:00:07.000Z',
  renewObserved: '2026-08-20T06:00:08.000Z',
  commitRequested: '2026-08-20T06:00:09.000Z',
  committed: '2026-08-20T06:00:10.000Z',
  commitObserved: '2026-08-20T06:00:11.000Z',
  abortRequestedAfterExpiry: '2026-08-20T06:31:00.000Z',
  abortedAfterExpiry: '2026-08-20T06:31:01.000Z',
  abortObservedAfterExpiry: '2026-08-20T06:31:02.000Z',
  initialExpiry: '2026-08-20T06:10:00.000Z',
  renewedExpiry: '2026-08-20T06:30:00.000Z',
});

function h(label) {
  return hashRecord('PackageRecoveryDeletionLeaseTest', { label });
}

function acquireRequest(overrides = {}) {
  return createPackageRecoveryDeletionLeaseAcquireRequest({
    challengeHash: h('challenge'),
    operationId: 'retention:delete:paper-42-package-a',
    deletionOperationHash: h('deletion-operation'),
    packageLifecycleReceiptHash: h('lifecycle'),
    packageRetentionRecoveryReceiptHash: h('recovery-receipt'),
    authoritySnapshotHash: h('authority-snapshot'),
    storageAuthorityId: 'worm-provider:production-a',
    storageObjectId: 'bucket/package-a.tar',
    storageObjectVersion: 'object-version-00000042',
    storageObjectBytesHash: h('archive-bytes'),
    retentionLockVersion: 'compliance-lock-version-00000007',
    retentionLockIdentityHash: h('retention-lock'),
    retainUntil: '2027-08-20T06:00:00.000Z',
    storageLedgerReceiptId: 'append-only-ledger:receipt:production-a:42',
    storageLedgerReceiptHash: h('ledger-receipt'),
    trustStoreHash: h('trust-store'),
    requestedAt: TIMES.requested,
    minimumRemainingHorizonMs: 60_000,
    ...overrides,
  });
}

function reseal(value, kind, hashField, changes = {}) {
  const payload = { ...value, ...changes };
  delete payload[hashField];
  return {
    ...payload,
    [hashField]: hashRecord(kind, payload),
  };
}

function fakeAuthority({
  initialExpiry = TIMES.initialExpiry,
  renewedExpiry = TIMES.renewedExpiry,
} = {}) {
  let authorityNow = TIMES.acquired;
  let current = null;
  let terminal = null;
  let acquireOverride = null;
  const acquireResponses = new Map();
  const commandResponses = new Map();
  const calls = {
    acquire: 0,
    lookupTerminal: 0,
    assert: 0,
    renew: 0,
    commit: 0,
    abortRelease: 0,
  };

  function commandKey(envelope) {
    return envelope.command.packageRecoveryDeletionLeaseCommandHash;
  }

  function assertCurrent(envelope) {
    assert.ok(current, 'lease must be acquired');
    assert.equal(envelope.lease.packageRecoveryDeletionLeaseHash,
      current.lease.packageRecoveryDeletionLeaseHash);
    assert.equal(envelope.fenceToken, current.fenceToken);
    assert.equal(verifyPackageRecoveryDeletionLeaseCommand(envelope.command, {
      lease: envelope.lease,
      fenceToken: envelope.fenceToken,
    }).valid, true);
    if (terminal) throw new Error('fixture_lease_terminal');
  }

  function idempotent(envelope, create) {
    const key = commandKey(envelope);
    if (commandResponses.has(key)) return commandResponses.get(key);
    assertCurrent(envelope);
    const response = create();
    commandResponses.set(key, response);
    return response;
  }

  const authority = {
    acquire(request) {
      calls.acquire += 1;
      if (acquireOverride) return acquireOverride;
      const key = request.packageRecoveryDeletionLeaseAcquireRequestHash;
      if (current?.lease.acquireRequestHash === key) return current;
      if (acquireResponses.has(key)) return acquireResponses.get(key);
      const response = Object.freeze({
        lease: createPackageRecoveryDeletionLease({
          request,
          leaseId: h('lease-id'),
          fenceToken: TOKEN_1,
          issuedAt: authorityNow,
          expiresAt: initialExpiry,
          providerAttestationHash: h('provider-acquire-attestation'),
        }),
        fenceToken: TOKEN_1,
      });
      current = response;
      acquireResponses.set(key, response);
      return response;
    },
    lookupTerminal({ acquireRequest: request, resumeRequest }) {
      calls.lookupTerminal += 1;
      assert.equal(
        request.packageRecoveryDeletionLeaseAcquireRequestHash,
        current?.lease.acquireRequestHash,
      );
      return createPackageRecoveryDeletionLeaseResumeResolution({
        status: terminal
          ? 'package_recovery_deletion_lease_resume_terminal'
          : 'package_recovery_deletion_lease_resume_active',
        acquireRequest: request,
        resumeRequest,
        handle: current,
        terminalCommand: terminal?.command || null,
        terminalReceipt: terminal?.receipt || null,
        providerAttestationHash: h('provider-resume-attestation'),
      });
    },
    assert(envelope) {
      calls.assert += 1;
      return idempotent(envelope, () =>
        createPackageRecoveryDeletionLeaseOperationReceipt({
          lease: envelope.lease,
          command: envelope.command,
          checkedAt: authorityNow,
          providerAttestationHash: h(`provider:${commandKey(envelope)}`),
        }));
    },
    renew(envelope) {
      calls.renew += 1;
      return idempotent(envelope, () => {
        const response = Object.freeze({
          lease: renewPackageRecoveryDeletionLease({
            previousLease: envelope.lease,
            renewCommand: envelope.command,
            fenceToken: TOKEN_2,
            issuedAt: authorityNow,
            expiresAt: renewedExpiry,
            providerAttestationHash: h('provider-renew-attestation'),
          }),
          fenceToken: TOKEN_2,
        });
        current = response;
        return response;
      });
    },
    commit(envelope) {
      calls.commit += 1;
      return idempotent(envelope, () => {
        const receipt = createPackageRecoveryDeletionLeaseOperationReceipt({
          lease: envelope.lease,
          command: envelope.command,
          checkedAt: authorityNow,
          providerAttestationHash: h('provider-commit-attestation'),
        });
        terminal = Object.freeze({ command: envelope.command, receipt });
        return receipt;
      });
    },
    abortRelease(envelope) {
      calls.abortRelease += 1;
      return idempotent(envelope, () => {
        const receipt = createPackageRecoveryDeletionLeaseOperationReceipt({
          lease: envelope.lease,
          command: envelope.command,
          checkedAt: authorityNow,
          providerAttestationHash: h('provider-abort-attestation'),
        });
        terminal = Object.freeze({ command: envelope.command, receipt });
        return receipt;
      });
    },
  };

  return Object.freeze({
    authority,
    calls,
    setAuthorityNow(value) { authorityNow = value; },
    setAcquireOverride(value) { acquireOverride = value; },
    current() { return current; },
  });
}

function portFixture(options = {}) {
  const provider = fakeAuthority(options);
  let observedAt = TIMES.acquireObserved;
  const port = createPackageRecoveryDeletionLeasePort({
    authority: provider.authority,
    observeNow: () => observedAt,
  });
  return Object.freeze({
    provider,
    port,
    setObservedAt(value) { observedAt = value; },
  });
}

function resumeRequestFor(request, command) {
  return createPackageRecoveryDeletionLeaseResumeRequest({
    acquireRequest: request,
    action: command.action,
    commandIdHash: command.commandIdHash,
    localDeletedFenceHash: command.localDeletedFenceHash,
    abortReasonHash: command.abortReasonHash,
  });
}

test('deletion lease records bind the exact recovery authority and reject reshaping', () => {
  const request = acquireRequest();
  assert.equal(verifyPackageRecoveryDeletionLeaseAcquireRequest(request).valid, true);
  assert.equal(verifyPackageRecoveryDeletionLeaseAcquireRequest({
    ...request,
    unexpected: true,
  }).valid, false);
  assert.equal(verifyPackageRecoveryDeletionLeaseAcquireRequest(Object.assign(
    Object.create(null),
    request,
  )).valid, false);
  assert.equal(verifyPackageRecoveryDeletionLeaseAcquireRequest(reseal(
    request,
    'PackageRecoveryDeletionLeaseAcquireRequest',
    'packageRecoveryDeletionLeaseAcquireRequestHash',
    { storageObjectVersion: 'different-version' },
  )).valid, true);

  const lease = createPackageRecoveryDeletionLease({
    request,
    leaseId: h('domain-lease'),
    fenceToken: TOKEN_1,
    issuedAt: TIMES.acquired,
    expiresAt: TIMES.initialExpiry,
    providerAttestationHash: h('domain-provider-attestation'),
  });
  assert.equal(verifyPackageRecoveryDeletionLease(lease, {
    request,
    fenceToken: TOKEN_1,
    observedAt: TIMES.acquireObserved,
    minimumRemainingHorizonMs: 60_000,
  }).valid, true);
  assert.equal(Object.hasOwn(lease, 'fenceToken'), false);
  assert.equal(
    lease.fenceTokenHash,
    packageRecoveryDeletionLeaseFenceTokenHash(TOKEN_1),
  );
  assert.equal(verifyPackageRecoveryDeletionLease(lease, {
    request: acquireRequest({ packageLifecycleReceiptHash: h('other-lifecycle') }),
    fenceToken: TOKEN_1,
  }).valid, false);
  assert.equal(verifyPackageRecoveryDeletionLease(lease, {
    request,
    fenceToken: TOKEN_2,
  }).valid, false);
  assert.equal(verifyPackageRecoveryDeletionLease(lease, {
    request,
    fenceToken: TOKEN_1,
    observedAt: '2026-08-20T06:09:30.001Z',
    minimumRemainingHorizonMs: 30_000,
  }).valid, false);
  assert.throws(() => acquireRequest({
    requestedAt: '2026-08-20T06:00:00Z',
  }), /acquire_request_invalid/);
});

test('commands and receipts are challenge, operation, generation, and token bound', () => {
  const request = acquireRequest();
  const lease = createPackageRecoveryDeletionLease({
    request,
    leaseId: h('command-lease'),
    fenceToken: TOKEN_1,
    issuedAt: TIMES.acquired,
    expiresAt: TIMES.initialExpiry,
    providerAttestationHash: h('command-provider'),
  });
  const command = createPackageRecoveryDeletionLeaseCommand({
    lease,
    fenceToken: TOKEN_1,
    action: 'commit',
    commandIdHash: h('commit-command'),
    requestedAt: TIMES.commitRequested,
    localDeletedFenceHash: h('local-deleted-fence'),
  });
  assert.equal(verifyPackageRecoveryDeletionLeaseCommand(command, {
    lease,
    fenceToken: TOKEN_1,
  }).valid, true);
  const wrongChallenge = reseal(
    command,
    'PackageRecoveryDeletionLeaseCommand',
    'packageRecoveryDeletionLeaseCommandHash',
    { challengeHash: h('wrong-challenge') },
  );
  assert.equal(verifyPackageRecoveryDeletionLeaseCommand(wrongChallenge, {
    lease,
    fenceToken: TOKEN_1,
  }).valid, false);
  const staleGeneration = reseal(
    command,
    'PackageRecoveryDeletionLeaseCommand',
    'packageRecoveryDeletionLeaseCommandHash',
    { generation: 2 },
  );
  assert.equal(verifyPackageRecoveryDeletionLeaseCommand(staleGeneration, {
    lease,
    fenceToken: TOKEN_1,
  }).valid, false);

  const receipt = createPackageRecoveryDeletionLeaseOperationReceipt({
    lease,
    command,
    checkedAt: TIMES.committed,
    providerAttestationHash: h('commit-attestation'),
  });
  assert.equal(verifyPackageRecoveryDeletionLeaseOperationReceipt(receipt, {
    lease,
    command,
    observedAt: TIMES.commitObserved,
  }).valid, true);
  assert.equal(verifyPackageRecoveryDeletionLeaseOperationReceipt(reseal(
    receipt,
    'PackageRecoveryDeletionLeaseOperationReceipt',
    'packageRecoveryDeletionLeaseOperationReceiptHash',
    { authoritySnapshotHash: h('wrong-authority-snapshot') },
  ), { lease, command, observedAt: TIMES.commitObserved }).valid, false);
});

test('port validates every provider call and preserves exact idempotent replay', () => {
  const fixture = portFixture();
  const request = acquireRequest();
  const handle = fixture.port.acquire(request);
  assert.equal(assertPackageRecoveryDeletionLeasePort(fixture.port), fixture.port);
  assert.equal(fixture.port.acquire(request).lease
    .packageRecoveryDeletionLeaseHash,
  handle.lease.packageRecoveryDeletionLeaseHash);

  const assertion = createPackageRecoveryDeletionLeaseCommand({
    lease: handle.lease,
    fenceToken: handle.fenceToken,
    action: 'assert',
    commandIdHash: h('assert-command'),
    requestedAt: TIMES.assertRequested,
    minimumRemainingHorizonMs: 60_000,
  });
  fixture.provider.setAuthorityNow(TIMES.asserted);
  fixture.setObservedAt(TIMES.assertObserved);
  const firstAssertion = fixture.port.assert(handle, assertion);
  const replayedAssertion = fixture.port.assert(handle, assertion);
  assert.deepEqual(replayedAssertion, firstAssertion);
  assert.equal(fixture.provider.calls.assert, 2);

  const renew = createPackageRecoveryDeletionLeaseCommand({
    lease: handle.lease,
    fenceToken: handle.fenceToken,
    action: 'renew',
    commandIdHash: h('renew-command'),
    requestedAt: TIMES.renewRequested,
    minimumRemainingHorizonMs: 60_000,
  });
  fixture.provider.setAuthorityNow(TIMES.renewed);
  fixture.setObservedAt(TIMES.renewObserved);
  const renewed = fixture.port.renew(handle, renew);
  const renewedReplay = fixture.port.renew(handle, renew);
  assert.deepEqual(renewedReplay, renewed);
  assert.equal(renewed.lease.generation, 2);
  assert.notEqual(renewed.lease.fenceTokenHash, handle.lease.fenceTokenHash);
  assert.equal(fixture.provider.calls.renew, 2);
  assert.deepEqual(fixture.port.acquire(request), renewed);
  const restartedPort = createPackageRecoveryDeletionLeasePort({
    authority: fixture.provider.authority,
    observeNow: () => TIMES.renewObserved,
  });
  assert.deepEqual(restartedPort.acquire(request), renewed);
  fixture.provider.setAcquireOverride(handle);
  assert.throws(() => fixture.port.acquire(request), /idempotency_violated/);
  fixture.provider.setAcquireOverride(null);

  const stale = createPackageRecoveryDeletionLeaseCommand({
    lease: handle.lease,
    fenceToken: handle.fenceToken,
    action: 'assert',
    commandIdHash: h('stale-command'),
    requestedAt: TIMES.commitRequested,
    minimumRemainingHorizonMs: 1,
  });
  assert.throws(() => fixture.port.assert(handle, stale),
    /stale_generation_or_token/);

  const commit = createPackageRecoveryDeletionLeaseCommand({
    lease: renewed.lease,
    fenceToken: renewed.fenceToken,
    action: 'commit',
    commandIdHash: h('commit-command'),
    requestedAt: TIMES.commitRequested,
    localDeletedFenceHash: h('local-deleted-fence'),
  });
  fixture.provider.setAuthorityNow(TIMES.committed);
  fixture.setObservedAt(TIMES.commitObserved);
  const committed = fixture.port.commit(renewed, commit);
  assert.equal(committed.localDeletedFenceHash, h('local-deleted-fence'));
  assert.deepEqual(fixture.port.acquire(request), renewed);
  assert.deepEqual(fixture.port.commit(renewed, commit), committed);
  assert.equal(fixture.provider.calls.commit, 2);

  const lateDifferentCommand = createPackageRecoveryDeletionLeaseCommand({
    lease: renewed.lease,
    fenceToken: renewed.fenceToken,
    action: 'abort_release',
    commandIdHash: h('late-abort-command'),
    requestedAt: TIMES.abortRequestedAfterExpiry,
    abortReasonHash: h('late-abort-reason'),
  });
  assert.throws(
    () => fixture.port.abortRelease(renewed, lateDifferentCommand),
    /deletion_lease_terminal/,
  );
});

test('fresh client exactly replays a lost commit response after lease expiry', () => {
  const fixture = portFixture();
  const request = acquireRequest({ challengeHash: h('restart-commit-challenge') });
  const handle = fixture.port.acquire(request);
  const command = createPackageRecoveryDeletionLeaseCommand({
    lease: handle.lease,
    fenceToken: handle.fenceToken,
    action: 'commit',
    commandIdHash: h('restart-commit-command'),
    requestedAt: TIMES.commitRequested,
    localDeletedFenceHash: h('restart-local-deleted-fence'),
  });
  fixture.provider.setAuthorityNow(TIMES.committed);
  fixture.setObservedAt(TIMES.commitObserved);
  const committed = fixture.port.commit(handle, command);

  const restarted = createPackageRecoveryDeletionLeasePort({
    authority: fixture.provider.authority,
    observeNow: () => TIMES.abortObservedAfterExpiry,
  });
  const replayed = restarted.resumeTerminal(
    request,
    resumeRequestFor(request, command),
  );
  assert.deepEqual(replayed, committed);
  assert.equal(fixture.provider.calls.acquire, 1);
  assert.equal(fixture.provider.calls.lookupTerminal, 1);
  assert.equal(fixture.provider.calls.commit, 1);

  const divergent = createPackageRecoveryDeletionLeaseResumeRequest({
    acquireRequest: request,
    action: 'abort_release',
    commandIdHash: h('divergent-terminal-command'),
    abortReasonHash: h('divergent-abort-reason'),
  });
  assert.throws(() => restarted.resumeTerminal(request, divergent),
    /resume_resolution_invalid/);
  assert.equal(fixture.provider.calls.abortRelease, 0);
});

test('fresh client exactly replays a lost abort response after lease expiry', () => {
  const fixture = portFixture();
  const request = acquireRequest({ challengeHash: h('restart-abort-challenge') });
  const handle = fixture.port.acquire(request);
  const command = createPackageRecoveryDeletionLeaseCommand({
    lease: handle.lease,
    fenceToken: handle.fenceToken,
    action: 'abort_release',
    commandIdHash: h('restart-abort-command'),
    requestedAt: TIMES.commitRequested,
    abortReasonHash: h('restart-exact-rollback'),
  });
  fixture.provider.setAuthorityNow(TIMES.committed);
  fixture.setObservedAt(TIMES.commitObserved);
  const aborted = fixture.port.abortRelease(handle, command);

  const restarted = createPackageRecoveryDeletionLeasePort({
    authority: fixture.provider.authority,
    observeNow: () => TIMES.abortObservedAfterExpiry,
  });
  const replayed = restarted.resumeTerminal(
    request,
    resumeRequestFor(request, command),
  );
  assert.deepEqual(replayed, aborted);
  assert.equal(fixture.provider.calls.acquire, 1);
  assert.equal(fixture.provider.calls.lookupTerminal, 1);
  assert.equal(fixture.provider.calls.abortRelease, 1);
});

test('fresh client cannot turn an expired nonterminal lease into a commit', () => {
  const fixture = portFixture();
  const request = acquireRequest({ challengeHash: h('expired-resume-challenge') });
  const handle = fixture.port.acquire(request);
  const command = createPackageRecoveryDeletionLeaseCommand({
    lease: handle.lease,
    fenceToken: handle.fenceToken,
    action: 'commit',
    commandIdHash: h('expired-resume-command'),
    requestedAt: TIMES.commitRequested,
    localDeletedFenceHash: h('expired-resume-local-fence'),
  });
  const restarted = createPackageRecoveryDeletionLeasePort({
    authority: fixture.provider.authority,
    observeNow: () => TIMES.abortObservedAfterExpiry,
  });
  assert.throws(() => restarted.resumeTerminal(
    request,
    resumeRequestFor(request, command),
  ), /resume_commit_expired/);
  assert.equal(fixture.provider.calls.acquire, 1);
  assert.equal(fixture.provider.calls.lookupTerminal, 1);
  assert.equal(fixture.provider.calls.commit, 0);
});

test('abort and release is valid after expiry but commit remains expiry-bound', () => {
  const abortFixture = portFixture();
  const abortHandle = abortFixture.port.acquire(acquireRequest());
  const abort = createPackageRecoveryDeletionLeaseCommand({
    lease: abortHandle.lease,
    fenceToken: abortHandle.fenceToken,
    action: 'abort_release',
    commandIdHash: h('abort-after-expiry'),
    requestedAt: TIMES.abortRequestedAfterExpiry,
    abortReasonHash: h('rollback-complete'),
  });
  abortFixture.provider.setAuthorityNow(TIMES.abortedAfterExpiry);
  abortFixture.setObservedAt(TIMES.abortObservedAfterExpiry);
  const released = abortFixture.port.abortRelease(abortHandle, abort);
  assert.equal(released.status,
    'package_recovery_deletion_lease_aborted_released');

  const commitFixture = portFixture();
  const commitHandle = commitFixture.port.acquire(acquireRequest({
    challengeHash: h('expired-commit-challenge'),
  }));
  const commit = createPackageRecoveryDeletionLeaseCommand({
    lease: commitHandle.lease,
    fenceToken: commitHandle.fenceToken,
    action: 'commit',
    commandIdHash: h('expired-commit'),
    requestedAt: TIMES.abortRequestedAfterExpiry,
    localDeletedFenceHash: h('local-deleted-fence-expired'),
  });
  commitFixture.provider.setAuthorityNow(TIMES.abortedAfterExpiry);
  commitFixture.setObservedAt(TIMES.abortObservedAfterExpiry);
  assert.throws(() => commitFixture.port.commit(commitHandle, commit),
    /deletion_lease_commit_invalid/);
});

test('minimum horizon and malformed provider results fail closed', () => {
  const tooShort = portFixture({
    initialExpiry: '2026-08-20T06:00:30.000Z',
  });
  assert.throws(() => tooShort.port.acquire(acquireRequest()),
    /deletion_lease_acquisition_invalid/);

  const fixture = portFixture();
  const handle = fixture.port.acquire(acquireRequest({
    challengeHash: h('horizon-challenge'),
  }));
  const assertion = createPackageRecoveryDeletionLeaseCommand({
    lease: handle.lease,
    fenceToken: handle.fenceToken,
    action: 'assert',
    commandIdHash: h('excessive-horizon'),
    requestedAt: TIMES.assertRequested,
    minimumRemainingHorizonMs: 10 * 60 * 1000,
  });
  fixture.provider.setAuthorityNow(TIMES.asserted);
  fixture.setObservedAt(TIMES.assertObserved);
  assert.throws(() => fixture.port.assert(handle, assertion),
    /deletion_lease_assertion_invalid/);

  const request = acquireRequest({ challengeHash: h('malformed-provider') });
  const malformedAuthority = {
    acquire(selectedRequest) {
      const valid = createPackageRecoveryDeletionLease({
        request: selectedRequest,
        leaseId: h('malformed-lease'),
        fenceToken: TOKEN_1,
        issuedAt: TIMES.acquired,
        expiresAt: TIMES.initialExpiry,
        providerAttestationHash: h('malformed-attestation'),
      });
      return { lease: valid, fenceToken: TOKEN_1, unexpected: true };
    },
    lookupTerminal() {},
    assert() {},
    renew() {},
    commit() {},
    abortRelease() {},
  };
  const malformedPort = createPackageRecoveryDeletionLeasePort({
    authority: malformedAuthority,
    observeNow: () => TIMES.acquireObserved,
  });
  assert.throws(() => malformedPort.acquire(request), /handle_invalid/);
});

test('missing authority, malformed port, raw token, and noncanonical time fail closed', () => {
  assert.throws(() => createPackageRecoveryDeletionLeasePort(),
    /authority_unavailable/);
  assert.throws(() => createPackageRecoveryDeletionLeasePort({
    authority: {
      acquire() {}, lookupTerminal() {}, assert() {}, renew() {}, commit() {},
    },
  }), /authority_unavailable/);
  assert.throws(() => packageRecoveryDeletionLeaseFenceTokenHash('short'),
    /fence_token_invalid/);
  assert.throws(() => assertPackageRecoveryDeletionLeasePort({
    version: 1,
    kind: 'PackageRecoveryDeletionLeasePort',
  }), /port_invalid/);
  const asynchronousPort = createPackageRecoveryDeletionLeasePort({
    authority: {
      async acquire() { return null; },
      lookupTerminal() {},
      assert() {},
      renew() {},
      commit() {},
      abortRelease() {},
    },
    observeNow: () => TIMES.acquireObserved,
  });
  assert.throws(() => asynchronousPort.acquire(acquireRequest({
    challengeHash: h('asynchronous-authority-challenge'),
  })), /async_authority_forbidden/);
  assert.throws(() => createPackageRecoveryDeletionLeaseCommand({
    lease: createPackageRecoveryDeletionLease({
      request: acquireRequest({ challengeHash: h('time-challenge') }),
      leaseId: h('time-lease'),
      fenceToken: TOKEN_1,
      issuedAt: TIMES.acquired,
      expiresAt: TIMES.initialExpiry,
      providerAttestationHash: h('time-attestation'),
    }),
    fenceToken: TOKEN_1,
    action: 'assert',
    commandIdHash: h('bad-time-command'),
    requestedAt: '2026-08-20T06:00:03Z',
    minimumRemainingHorizonMs: 1,
  }), /command_invalid/);
});
