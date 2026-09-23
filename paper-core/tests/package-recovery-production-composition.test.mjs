import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { composeProductionPackageRecoveryAuthorities }
  from '../../paper-composition/automation/package-recovery-production-composition.mjs';
import {
  createPackageRetentionRecoveryLockRepository,
  PACKAGE_RETENTION_RECOVERY_READINESS_PROBE_HASH,
} from '../../paper-adapters/automation/package-retention-recovery-lock-repository.mjs';
import { provisionAutonomousSubmissionHandoffStore }
  from '../../paper-adapters/persistence/autonomous-submission-handoff-store.mjs';
import { createDefaultPaperStore }
  from '../../paper-adapters/persistence/store-provider.mjs';
import {
  createPackageRecoveryAuthorityReadinessInspection,
  packageRecoveryAuthorityReadinessAttestationSubject,
} from '../../paper-domain/automation/package-recovery-authority-readiness-contract.mjs';
import { createPackageRecoveryDeletionLeaseAcquireRequest }
  from '../../paper-domain/automation/package-recovery-deletion-lease-contract.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { main as runPaperCampaignCli }
  from '../bin/paper-campaign.mjs';
import { createPackageRecoveryDeletionLeaseFixture }
  from './support/package-recovery-deletion-lease-fixture.mjs';

function boundaries(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-recovery-production-'));
  const root = path.join(base, 'assets');
  const runtimeRoot = path.join(base, 'runtime');
  const restoreRoot = path.join(base, 'external', 'restore');
  const storageObjectPath = path.join(base, 'external', 'objects', 'package.archive');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(runtimeRoot, { recursive: true });
  fs.mkdirSync(restoreRoot, { recursive: true });
  fs.chmodSync(restoreRoot, 0o700);
  fs.mkdirSync(path.dirname(storageObjectPath), { recursive: true });
  fs.writeFileSync(storageObjectPath, 'immutable archive bytes\n');
  fs.chmodSync(storageObjectPath, 0o444);
  t.after(() => {
    fs.chmodSync(storageObjectPath, 0o600);
    fs.rmSync(base, { recursive: true, force: true });
  });
  return { root, runtimeRoot, restoreRoot, storageObjectPath };
}

function packageRecoveryAuthority() {
  return Object.freeze({
    version: 1,
    kind: 'PackageRecoveryAuthority',
    createRecoveryEvidence() {},
    inspectLiveRecoverySource() {},
    inspectAuthenticatedReadiness() {},
    verifyStorageAuthorityProof() { return false; },
    verifyRestoreExecutionProof() { return false; },
  });
}

function authorityFactory(authority = packageRecoveryAuthority()) {
  const calls = [];
  return Object.freeze({
    calls,
    factory: Object.freeze({
      version: 1,
      kind: 'PackageRecoveryAuthorityFactory',
      create(context) {
        calls.push(context);
        return authority;
      },
    }),
  });
}

function deletionLeaseAuthority() {
  const calls = [];
  const unavailable = (operation) => () => {
    calls.push(operation);
    throw new Error('test_external_deletion_lease_action_forbidden');
  };
  return Object.freeze({
    calls,
    authority: Object.freeze({
      acquire: unavailable('acquire'),
      lookupTerminal: unavailable('lookupTerminal'),
      assert: unavailable('assert'),
      renew: unavailable('renew'),
      commit: unavailable('commit'),
      abortRelease: unavailable('abortRelease'),
    }),
  });
}

const readinessVerifier = Object.freeze({
  verifyAuthenticatedInspection() { return false; },
});

function recoveryHash(label, value = null) {
  return hashRecord('PackageRecoveryProductionCompositionTest', { label, value });
}

function signedReadinessDeployment() {
  const signingKey = crypto.generateKeyPairSync('ed25519');
  const attestations = new Map();
  const deletionLease = createPackageRecoveryDeletionLeaseFixture();
  const authority = Object.freeze({
    version: 1,
    kind: 'PackageRecoveryAuthority',
    createRecoveryEvidence() {
      throw new Error('test_readiness_must_not_create_recovery_evidence');
    },
    inspectLiveRecoverySource() {
      throw new Error('test_readiness_must_not_inspect_recovery_source');
    },
    verifyStorageAuthorityProof(proof, { lifecycleReceipt } = {}) {
      return proof?.kind === 'ExternalStorageReadinessCanary'
        && proof.challengeHash === lifecycleReceipt?.challengeHash
        && proof.authoritySnapshotHash === lifecycleReceipt?.authoritySnapshotHash;
    },
    verifyRestoreExecutionProof(proof, { recoverySourceAuthority } = {}) {
      return proof?.kind === 'ExternalRestoreReadinessCanary'
        && proof.challengeHash === recoverySourceAuthority?.challengeHash
        && proof.authoritySnapshotHash
          === recoverySourceAuthority?.authoritySnapshotHash;
    },
    inspectAuthenticatedReadiness({ challengeHash, requestedAt }) {
      const authoritySnapshotHash = recoveryHash(
        'authority-snapshot',
        challengeHash,
      );
      const checkedAt = requestedAt;
      const expiresAt = new Date(Date.parse(requestedAt) + 120_000).toISOString();
      const canaryBinding = Object.freeze({ challengeHash, authoritySnapshotHash });
      const inspectionInput = Object.freeze({
        challengeHash,
        requestedAt,
        checkedAt,
        expiresAt,
        storageAuthorityCanary: Object.freeze({
          proof: Object.freeze({
            version: 1,
            kind: 'ExternalStorageReadinessCanary',
            ...canaryBinding,
          }),
          lifecycleReceipt: Object.freeze({
            version: 1,
            kind: 'ExternalStorageReadinessLifecycleCanary',
            ...canaryBinding,
          }),
        }),
        restoreAuthorityCanary: Object.freeze({
          proof: Object.freeze({
            version: 1,
            kind: 'ExternalRestoreReadinessCanary',
            ...canaryBinding,
          }),
          recoverySourceAuthority: Object.freeze({
            version: 1,
            kind: 'ExternalRestoreReadinessSourceCanary',
            ...canaryBinding,
          }),
        }),
        deletionLeaseAuthorityCanary: Object.freeze({
          acquireRequest: createPackageRecoveryDeletionLeaseAcquireRequest({
            challengeHash,
            operationId: 'readiness:qualified-external-launcher',
            deletionOperationHash: recoveryHash('deletion-operation', challengeHash),
            packageLifecycleReceiptHash: recoveryHash('lifecycle', challengeHash),
            packageRetentionRecoveryReceiptHash: recoveryHash('recovery', challengeHash),
            authoritySnapshotHash,
            storageAuthorityId: 'qualified-external-storage-authority',
            storageObjectId: 'readiness/package.archive',
            storageObjectVersion: 'readiness-object-version-1',
            storageObjectBytesHash: recoveryHash('storage-bytes', challengeHash),
            retentionLockVersion: 'readiness-lock-version-1',
            retentionLockIdentityHash: recoveryHash('retention-lock', challengeHash),
            retainUntil: new Date(
              Date.parse(requestedAt) + 365 * 24 * 60 * 60_000,
            ).toISOString(),
            storageLedgerReceiptId: 'readiness-ledger-receipt-1',
            storageLedgerReceiptHash: recoveryHash('ledger-receipt', challengeHash),
            trustStoreHash: recoveryHash('trust-store', challengeHash),
            requestedAt,
            minimumRemainingHorizonMs: 60_000,
          }),
        }),
        authoritySnapshotHash,
        deploymentIdentityHash: recoveryHash('deployment'),
        readinessTrustStoreHash: recoveryHash('readiness-trust-store'),
      });
      const pending = createPackageRecoveryAuthorityReadinessInspection({
        ...inspectionInput,
        authenticatedAuthorityAttestationHash: recoveryHash('pending-attestation'),
      });
      const subject = packageRecoveryAuthorityReadinessAttestationSubject(pending);
      const subjectHash = hashRecord(
        'PackageRecoveryReadinessAttestationSubject',
        subject,
      );
      const attestation = Object.freeze({
        subject,
        subjectHash,
        signature: crypto.sign(
          null,
          Buffer.from(subjectHash, 'utf8'),
          signingKey.privateKey,
        ).toString('base64'),
      });
      const attestationHash = hashRecord(
        'PackageRecoveryReadinessAttestation',
        attestation,
      );
      attestations.set(attestationHash, attestation);
      return createPackageRecoveryAuthorityReadinessInspection({
        ...inspectionInput,
        authenticatedAuthorityAttestationHash: attestationHash,
      });
    },
  });
  const recovery = authorityFactory(authority);
  return Object.freeze({
    authorityFactory: recovery.factory,
    factoryCalls: recovery.calls,
    deletionLease,
    readinessVerifier: Object.freeze({
      verifyAuthenticatedInspection(inspection, { challengeHash, requestedAt }) {
        const attestation = attestations.get(
          inspection?.authenticatedAuthorityAttestationHash,
        );
        const subject = packageRecoveryAuthorityReadinessAttestationSubject(
          inspection,
        );
        const subjectHash = hashRecord(
          'PackageRecoveryReadinessAttestationSubject',
          subject,
        );
        return Boolean(attestation
          && inspection.challengeHash === challengeHash
          && inspection.requestedAt === requestedAt
          && attestation.subjectHash === subjectHash
          && JSON.stringify(attestation.subject) === JSON.stringify(subject)
          && crypto.verify(
            null,
            Buffer.from(subjectHash, 'utf8'),
            signingKey.publicKey,
            Buffer.from(attestation.signature, 'base64'),
          ));
      },
    }),
  });
}

test('production recovery composition supplies a local exact-restore factory and wraps only the raw lease authority', (t) => {
  const fixture = boundaries(t);
  const recovery = authorityFactory();
  const deletionLease = deletionLeaseAuthority();
  const composed = composeProductionPackageRecoveryAuthorities({
    runtimeRoot: fixture.runtimeRoot,
    restoreRoot: fixture.restoreRoot,
    packageRecoveryAuthorityFactory: recovery.factory,
    packageRecoveryAuthorityReadinessVerifier: readinessVerifier,
    packageRecoveryDeletionLeaseAuthority: deletionLease.authority,
  });

  assert.equal(composed.packageRecoveryAuthority.kind, 'PackageRecoveryAuthority');
  assert.equal(composed.packageRecoveryAuthorityReadinessVerifier, readinessVerifier);
  assert.equal(composed.packageRecoveryDeletionLeasePort.kind,
    'PackageRecoveryDeletionLeasePort');
  assert.notEqual(composed.packageRecoveryDeletionLeasePort, deletionLease.authority);
  assert.deepEqual(deletionLease.calls, []);
  assert.equal(recovery.calls.length, 1);
  const [context] = recovery.calls;
  assert.equal(Object.isFrozen(context), true);
  assert.equal(context.kind, 'PackageRecoveryAuthorityFactoryContext');
  assert.equal(context.runtimeRoot, fixture.runtimeRoot);
  assert.equal(context.exactRestoreRepositoryFactory.kind,
    'PackageRecoveryExactRestoreRepositoryFactory');
  assert.equal(context.exactRestoreRepositoryFactory.create({
    storageObjectPath: fixture.storageObjectPath,
  }).kind, 'PackageRecoveryExactRestoreRepository');
});

test('production recovery composition is absent by default and rejects incomplete or malformed external authority sets before factory use', (t) => {
  const fixture = boundaries(t);
  assert.deepEqual(composeProductionPackageRecoveryAuthorities({
    runtimeRoot: fixture.runtimeRoot,
  }), {
    packageRecoveryAuthority: null,
    packageRecoveryAuthorityReadinessVerifier: null,
    packageRecoveryDeletionLeasePort: null,
  });

  const recovery = authorityFactory();
  assert.throws(() => composeProductionPackageRecoveryAuthorities({
    runtimeRoot: fixture.runtimeRoot,
    restoreRoot: fixture.restoreRoot,
    packageRecoveryAuthorityFactory: recovery.factory,
  }), /package_recovery_production_authorities_incomplete/);
  assert.deepEqual(recovery.calls, []);

  assert.throws(() => composeProductionPackageRecoveryAuthorities({
    runtimeRoot: fixture.runtimeRoot,
    restoreRoot: fixture.restoreRoot,
    packageRecoveryAuthorityFactory: recovery.factory,
    packageRecoveryAuthorityReadinessVerifier: readinessVerifier,
    packageRecoveryDeletionLeaseAuthority: {
      acquire() {}, lookupTerminal() {}, assert() {}, renew() {}, commit() {},
    },
  }), /package_recovery_deletion_lease_authority_unavailable/);
  assert.deepEqual(recovery.calls, []);
});

test('production recovery composition rejects asynchronous or readiness-incomplete authority factories', (t) => {
  const fixture = boundaries(t);
  const deletionLease = deletionLeaseAuthority();
  const common = {
    runtimeRoot: fixture.runtimeRoot,
    restoreRoot: fixture.restoreRoot,
    packageRecoveryAuthorityReadinessVerifier: readinessVerifier,
    packageRecoveryDeletionLeaseAuthority: deletionLease.authority,
  };
  assert.throws(() => composeProductionPackageRecoveryAuthorities({
    ...common,
    packageRecoveryAuthorityFactory: {
      version: 1,
      kind: 'PackageRecoveryAuthorityFactory',
      create: async () => packageRecoveryAuthority(),
    },
  }), /package_recovery_production_async_authority_factory_forbidden/);
  assert.throws(() => composeProductionPackageRecoveryAuthorities({
    ...common,
    packageRecoveryAuthorityFactory: authorityFactory(Object.freeze({
      ...packageRecoveryAuthority(),
      inspectAuthenticatedReadiness: undefined,
    })).factory,
  }), /package_recovery_production_authority_readiness_unavailable/);
  assert.deepEqual(deletionLease.calls, []);
});

test('import-safe campaign launcher passes composed recovery capabilities and stock launch stays authority-free', async (t) => {
  const fixture = boundaries(t);
  const recovery = authorityFactory();
  const deletionLease = deletionLeaseAuthority();
  const calls = [];
  let output = '';
  const executeCampaignCommand = async (request) => {
    calls.push(request);
    return Object.freeze({ status: 'test_campaign_command_completed' });
  };
  await runPaperCampaignCli({
    argv: [
      '--action', 'retention-recovery-readiness',
      '--root', fixture.root,
      '--runtime-root', fixture.runtimeRoot,
    ],
    stdout: { write(value) { output += value; } },
    environment: Object.freeze({ TEST_RECOVERY_LAUNCHER: 'qualified' }),
    executeCampaignCommand,
    packageRecoveryAuthorityFactory: recovery.factory,
    packageRecoveryAuthorityReadinessVerifier: readinessVerifier,
    packageRecoveryDeletionLeaseAuthority: deletionLease.authority,
    packageRecoveryRestoreRoot: fixture.restoreRoot,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].packageRecoveryAuthority.kind, 'PackageRecoveryAuthority');
  assert.equal(calls[0].packageRecoveryAuthorityReadinessVerifier, readinessVerifier);
  assert.equal(calls[0].packageRecoveryDeletionLeasePort.kind,
    'PackageRecoveryDeletionLeasePort');
  assert.equal(calls[0].environment.TEST_RECOVERY_LAUNCHER, 'qualified');
  assert.deepEqual(JSON.parse(output), { status: 'test_campaign_command_completed' });
  assert.deepEqual(deletionLease.calls, []);

  calls.length = 0;
  output = '';
  await runPaperCampaignCli({
    argv: [
      '--action', 'retention-recovery-readiness',
      '--root', fixture.root,
      '--runtime-root', fixture.runtimeRoot,
    ],
    stdout: { write(value) { output += value; } },
    executeCampaignCommand,
  });
  assert.equal(calls[0].packageRecoveryAuthority, null);
  assert.equal(calls[0].packageRecoveryAuthorityReadinessVerifier, null);
  assert.equal(calls[0].packageRecoveryDeletionLeasePort, null);
});

test('qualified launcher reaches the real readiness command while the real stock command remains unavailable', async (t) => {
  const fixture = boundaries(t);
  createDefaultPaperStore({
    root: fixture.root,
    runtimeRoot: fixture.runtimeRoot,
  }).close();
  provisionAutonomousSubmissionHandoffStore({
    runtimeRoot: fixture.runtimeRoot,
  });
  createPackageRetentionRecoveryLockRepository({
    runtimeRoot: fixture.runtimeRoot,
  }).withLifecycleLock(
    PACKAGE_RETENTION_RECOVERY_READINESS_PROBE_HASH,
    () => true,
  );
  const deployment = signedReadinessDeployment();
  const argv = [
    '--action', 'retention-recovery-readiness',
    '--root', fixture.root,
    '--runtime-root', fixture.runtimeRoot,
  ];
  let qualifiedOutput = '';
  await runPaperCampaignCli({
    argv,
    stdout: { write(value) { qualifiedOutput += value; } },
    packageRecoveryAuthorityFactory: deployment.authorityFactory,
    packageRecoveryAuthorityReadinessVerifier: deployment.readinessVerifier,
    packageRecoveryDeletionLeaseAuthority:
      deployment.deletionLease.rawAuthority,
    packageRecoveryRestoreRoot: fixture.restoreRoot,
  });
  const qualified = JSON.parse(qualifiedOutput);
  assert.equal(qualified.status,
    'paper_campaign_retention-recovery-readiness');
  assert.equal(qualified.result.status,
    'package_retention_recovery_authority_ready');
  assert.equal(qualified.result.recoveryAuthorityAuthenticated, true);
  assert.equal(qualified.result.lifecycleLockOperational, true);
  assert.deepEqual(qualified.result.blockers, []);
  assert.equal(deployment.factoryCalls.length, 1);
  assert.deepEqual(deployment.deletionLease.calls, {
    acquire: 1,
    lookupTerminal: 1,
    assert: 1,
    renew: 0,
    commit: 0,
    abortRelease: 1,
  });

  let stockOutput = '';
  await runPaperCampaignCli({
    argv,
    stdout: { write(value) { stockOutput += value; } },
  });
  const stock = JSON.parse(stockOutput);
  assert.equal(stock.result.status,
    'package_retention_recovery_authority_unavailable');
  assert.equal(stock.result.recoveryAuthorityConfigured, false);
  assert.equal(stock.result.deletionLeasePortConfigured, false);
  assert.deepEqual(stock.result.blockers, [
    'package_retention_recovery_authority_unavailable',
    'package_retention_recovery_deletion_lease_unavailable',
    'package_retention_recovery_lifecycle_lock_unavailable',
  ]);
});

test('campaign launcher refuses partial external recovery injection before command execution and is side-effect free when imported', async (t) => {
  const fixture = boundaries(t);
  let commandCalls = 0;
  await assert.rejects(() => runPaperCampaignCli({
    argv: [
      '--action', 'retention-recovery-readiness',
      '--root', fixture.root,
      '--runtime-root', fixture.runtimeRoot,
    ],
    stdout: { write() {} },
    executeCampaignCommand() { commandCalls += 1; },
    packageRecoveryRestoreRoot: fixture.restoreRoot,
  }), /package_recovery_production_authorities_incomplete/);
  assert.equal(commandCalls, 0);

  const imported = spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', `await import(${JSON.stringify(
      new URL('../bin/paper-campaign.mjs', import.meta.url).href,
    )})`],
    { cwd: fixture.root, encoding: 'utf8' },
  );
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(imported.stdout, '');
});
