import {
  createPackageRecoveryDeletionLease,
  createPackageRecoveryDeletionLeaseOperationReceipt,
  renewPackageRecoveryDeletionLease,
} from '../../../paper-domain/automation/package-recovery-deletion-lease-contract.mjs';
import { createPackageRecoveryDeletionLeaseResumeResolution }
  from '../../../paper-domain/automation/package-recovery-deletion-lease-resume-contract.mjs';
import { createPackageRecoveryDeletionLeasePort }
  from '../../../paper-application/automation/package-recovery-deletion-lease-client.mjs';
import { hashRecord } from '../../../workflow-kernel/record-hash.mjs';

function h(label, value) {
  return hashRecord('PackageRecoveryDeletionLeaseFixture', { label, value });
}

function plusMilliseconds(iso, milliseconds) {
  return new Date(Date.parse(iso) + milliseconds).toISOString();
}

export function createPackageRecoveryDeletionLeaseFixture({
  clock = { nowIso: () => new Date().toISOString() },
  leaseDurationMs = 10 * 60_000,
} = {}) {
  const byAcquireRequest = new Map();
  const commandResponses = new Map();
  const calls = {
    acquire: 0,
    lookupTerminal: 0,
    assert: 0,
    renew: 0,
    commit: 0,
    abortRelease: 0,
  };
  let available = true;
  let bindingCurrent = true;
  let forcedNow = null;

  const nowIso = () => forcedNow || clock.nowIso();

  function stateForEnvelope(envelope) {
    const state = byAcquireRequest.get(envelope.lease.acquireRequestHash);
    if (!state
      || state.handle.lease.packageRecoveryDeletionLeaseHash
        !== envelope.lease.packageRecoveryDeletionLeaseHash
      || state.handle.fenceToken !== envelope.fenceToken) {
      throw new Error('fixture_package_recovery_deletion_lease_stale');
    }
    return state;
  }

  function idempotent(envelope, operation) {
    const key = envelope.command.packageRecoveryDeletionLeaseCommandHash;
    if (commandResponses.has(key)) return commandResponses.get(key);
    if (!available || !bindingCurrent) {
      throw new Error('fixture_package_recovery_deletion_lease_unavailable');
    }
    const state = stateForEnvelope(envelope);
    if (state.terminal) throw new Error('fixture_package_recovery_deletion_lease_terminal');
    const response = operation(state);
    commandResponses.set(key, response);
    return response;
  }

  const authority = Object.freeze({
    acquire(request) {
      calls.acquire += 1;
      if (!available || !bindingCurrent) {
        throw new Error('fixture_package_recovery_deletion_lease_unavailable');
      }
      const key = request.packageRecoveryDeletionLeaseAcquireRequestHash;
      const existing = byAcquireRequest.get(key);
      if (existing) return existing.handle;
      const issuedAt = nowIso();
      const fenceToken = `fixture-package-deletion-${key.slice(7)}`;
      const handle = Object.freeze({
        lease: createPackageRecoveryDeletionLease({
          request,
          leaseId: h('lease-id', key),
          fenceToken,
          issuedAt,
          expiresAt: plusMilliseconds(issuedAt, leaseDurationMs),
          providerAttestationHash: h('acquire-attestation', key),
        }),
        fenceToken,
      });
      byAcquireRequest.set(key, { handle, terminal: null });
      return handle;
    },
    lookupTerminal({ acquireRequest, resumeRequest }) {
      calls.lookupTerminal += 1;
      if (!available || !bindingCurrent) {
        throw new Error('fixture_package_recovery_deletion_lease_unavailable');
      }
      const state = byAcquireRequest.get(
        acquireRequest.packageRecoveryDeletionLeaseAcquireRequestHash,
      );
      if (!state) {
        throw new Error('fixture_package_recovery_deletion_lease_unknown');
      }
      return createPackageRecoveryDeletionLeaseResumeResolution({
        status: state.terminal
          ? 'package_recovery_deletion_lease_resume_terminal'
          : 'package_recovery_deletion_lease_resume_active',
        acquireRequest,
        resumeRequest,
        handle: state.handle,
        terminalCommand: state.terminal?.command || null,
        terminalReceipt: state.terminal?.receipt || null,
        providerAttestationHash: h(
          'resume-attestation',
          `${resumeRequest.packageRecoveryDeletionLeaseResumeRequestHash}:${state.handle.lease.packageRecoveryDeletionLeaseHash}`,
        ),
      });
    },
    assert(envelope) {
      calls.assert += 1;
      return idempotent(envelope, () => createPackageRecoveryDeletionLeaseOperationReceipt({
        lease: envelope.lease,
        command: envelope.command,
        checkedAt: nowIso(),
        providerAttestationHash: h(
          'assert-attestation',
          envelope.command.packageRecoveryDeletionLeaseCommandHash,
        ),
      }));
    },
    renew(envelope) {
      calls.renew += 1;
      return idempotent(envelope, (state) => {
        const issuedAt = nowIso();
        const fenceToken = `fixture-package-deletion-renewed-${envelope.lease.generation + 1}-${envelope.lease.acquireRequestHash.slice(7)}`;
        const handle = Object.freeze({
          lease: renewPackageRecoveryDeletionLease({
            previousLease: envelope.lease,
            renewCommand: envelope.command,
            fenceToken,
            issuedAt,
            expiresAt: plusMilliseconds(issuedAt, leaseDurationMs),
            providerAttestationHash: h(
              'renew-attestation',
              envelope.command.packageRecoveryDeletionLeaseCommandHash,
            ),
          }),
          fenceToken,
        });
        state.handle = handle;
        return handle;
      });
    },
    commit(envelope) {
      calls.commit += 1;
      return idempotent(envelope, (state) => {
        const receipt = createPackageRecoveryDeletionLeaseOperationReceipt({
          lease: envelope.lease,
          command: envelope.command,
          checkedAt: nowIso(),
          providerAttestationHash: h(
            'commit-attestation',
            envelope.command.packageRecoveryDeletionLeaseCommandHash,
          ),
        });
        state.terminal = Object.freeze({
          command: envelope.command,
          receipt,
        });
        return receipt;
      });
    },
    abortRelease(envelope) {
      calls.abortRelease += 1;
      return idempotent(envelope, (state) => {
        const receipt = createPackageRecoveryDeletionLeaseOperationReceipt({
          lease: envelope.lease,
          command: envelope.command,
          checkedAt: nowIso(),
          providerAttestationHash: h(
            'abort-attestation',
            envelope.command.packageRecoveryDeletionLeaseCommandHash,
          ),
        });
        state.terminal = Object.freeze({
          command: envelope.command,
          receipt,
        });
        return receipt;
      });
    },
  });

  const createPort = () => createPackageRecoveryDeletionLeasePort({
      authority,
      observeNow: nowIso,
    });

  return Object.freeze({
    port: createPort(),
    rawAuthority: authority,
    calls,
    createRestartedPort: createPort,
    expireLeases() {
      const expiries = [...byAcquireRequest.values()].map(
        (state) => Date.parse(state.handle.lease.expiresAt),
      );
      if (!expiries.length) {
        throw new Error('fixture_package_recovery_deletion_lease_missing');
      }
      forcedNow = new Date(Math.max(...expiries) + 1).toISOString();
      return forcedNow;
    },
    setAvailable(value) { available = value === true; },
    setBindingCurrent(value) { bindingCurrent = value === true; },
    setNow(value) { forcedNow = value; },
  });
}
