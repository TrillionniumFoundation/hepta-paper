import fs from 'node:fs';
import path from 'node:path';

import { ImmutableReleaseDeploymentTransaction } from '../../paper-application/orchestration/immutable-release-deployment-transaction.mjs';
import {
  recoverImmutableReleaseDeploymentIntent,
} from '../../paper-application/orchestration/immutable-release-deployment-recovery.mjs';
import {
  cleanupImmutableReleaseCandidateForPlan,
  materializeImmutableReleaseCandidate,
  publishSealedImmutableReleaseCandidate,
} from '../../paper-adapters/runtime/immutable-release-candidate-repository.mjs';
import {
  buildAndSealImmutableReleaseDeploymentClosure,
} from '../../paper-adapters/runtime/immutable-release-deployment-closure-repository.mjs';
import {
  createImmutableReleaseDeploymentIntentRepository,
} from '../../paper-adapters/runtime/immutable-release-deployment-intent-repository.mjs';
import {
  acquireExclusiveImmutableReleaseDeploymentLock,
  adoptInheritedExclusiveImmutableReleaseDeploymentLock,
  inspectImmutableReleaseDeploymentLock,
} from '../../paper-adapters/runtime/immutable-release-deployment-lock-repository.mjs';
import {
  createLinuxImmutableReleaseHostAdapter,
} from '../../paper-adapters/runtime/immutable-release-linux-host-repository.mjs';
import { currentCodeProvenance } from '../../paper-adapters/runtime/code-provenance.mjs';
import {
  inspectSealedDeploymentClosure,
} from '../../paper-adapters/runtime/release-environment-deployment-closure.mjs';
import {
  assertReleaseDependencyTreeContract,
} from '../../paper-adapters/runtime/release-dependency-tree.mjs';
import {
  inspectRootOwnedTree,
} from '../../paper-adapters/runtime/release-environment-entrypoint.mjs';
import {
  assertImmutableReleaseDeploymentPlan,
  IMMUTABLE_RELEASE_DEPLOYMENT_LOCK,
  IMMUTABLE_RELEASE_LIVE_ROOT,
} from '../../paper-domain/contracts/immutable-release-deployment-contract.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

function codedError(code, details = {}) {
  return Object.assign(new Error(code), { code, ...details });
}

function exactWorkspaceRoot(candidate) {
  if (typeof candidate !== 'string' || !path.isAbsolute(candidate)
    || path.resolve(candidate) !== candidate || fs.realpathSync(candidate) !== candidate) {
    throw codedError('immutable_release_deployment_candidate_workspace_invalid');
  }
  const stat = fs.lstatSync(candidate, { bigint: true });
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw codedError('immutable_release_deployment_candidate_workspace_invalid');
  }
  return candidate;
}

function productionProvenance(workspaceRoot) {
  return Object.freeze({
    ...currentCodeProvenance({
      workspaceRoot,
      allowReleaseCommitEnvironment: false,
      ignoreSubmoduleWorktreeStatus: true,
    }),
    evidenceEnvironment: 'production',
    evidenceClass: 'runtime_unclassified',
  });
}

export function createProductionImmutableReleaseDeployment({
  candidateWorkspaceRoot,
  inspectReleaseState,
  assertReleaseReady,
  hostAdapterOptions = {},
  intentRepositoryOptions = {},
  failpoint = null,
  inheritedLockFd = null,
  trustedPredecessorClosureHash = null,
} = {}) {
  const candidateRoot = candidateWorkspaceRoot === null || candidateWorkspaceRoot === undefined
    ? null : exactWorkspaceRoot(candidateWorkspaceRoot);
  if (typeof inspectReleaseState !== 'function' || typeof assertReleaseReady !== 'function') {
    throw codedError('immutable_release_deployment_release_state_adapter_required');
  }
  const intentRepository = createImmutableReleaseDeploymentIntentRepository(
    intentRepositoryOptions,
  );
  let host;
  const verifyPublishedRelease = ({ plan, closureHash }) => {
    const provenance = productionProvenance(IMMUTABLE_RELEASE_LIVE_ROOT);
    if (hashRecord('ImmutableReleaseDeploymentCodeProvenance', provenance)
      !== plan.codeProvenanceHash) {
      throw codedError('immutable_release_postverify_provenance_mismatch');
    }
    const releaseStateSnapshot = assertReleaseReady({
      workspaceRoot: IMMUTABLE_RELEASE_LIVE_ROOT,
      expectedSnapshotHash: plan.releaseStateSnapshotHash,
    });
    const dependencyInspection = assertReleaseDependencyTreeContract({
      workspaceRoot: IMMUTABLE_RELEASE_LIVE_ROOT,
      readOnly: true,
    });
    const closure = inspectSealedDeploymentClosure({
      workspaceRoot: IMMUTABLE_RELEASE_LIVE_ROOT,
      provenance,
      dependencyInspection,
      approvedPredecessorClosureHashes: Object.freeze([plan.predecessor.closureHash]),
      expectedClosureHash: closureHash,
    });
    if (closure.closureHash !== closureHash
      || closure.inheritedFromClosureHash !== plan.predecessor.closureHash) {
      throw codedError('immutable_release_postverify_closure_mismatch');
    }
    inspectRootOwnedTree({ workspaceRoot: IMMUTABLE_RELEASE_LIVE_ROOT });
    host.inspectMount({ expectedReleasePath: plan.target.releasePath });
    return Object.freeze({
      status: 'immutable_release_published_release_verified',
      commit: provenance.commit,
      releaseStateSnapshotHash: releaseStateSnapshot.workspaceReleaseStateSnapshotHash,
      dependencyContractHash: dependencyInspection.contractHash,
      closureHash: closure.closureHash,
    });
  };
  host = createLinuxImmutableReleaseHostAdapter({
    ...hostAdapterOptions,
    verifyPublishedRelease,
  });

  const inspectDeployment = async () => {
    if (candidateRoot === null) {
      throw codedError('immutable_release_deployment_candidate_workspace_required');
    }
    if (!/^sha256:[0-9a-f]{64}$/u.test(String(trustedPredecessorClosureHash || ''))) {
      throw codedError('immutable_release_deployment_trusted_predecessor_closure_required');
    }
    const codeProvenance = productionProvenance(candidateRoot);
    const releaseStateSnapshot = inspectReleaseState({ workspaceRoot: candidateRoot });
    // Both pieces which make boot-time recovery possible must predate the
    // transaction. A normal deployment may preserve them, but may never use a
    // partially installed candidate as a bootstrap migration mechanism.
    host.assertDeploymentBootstrapCompatible({ candidateRoot });
    const recoveryGate = host.inspectRecoveryGate();
    const deploymentLock = inspectImmutableReleaseDeploymentLock({
      lockPath: IMMUTABLE_RELEASE_DEPLOYMENT_LOCK,
    });
    const mount = host.inspectMount();
    const predecessorProvenance = productionProvenance(IMMUTABLE_RELEASE_LIVE_ROOT);
    if (predecessorProvenance.commit !== mount.sourceCommit) {
      throw codedError('immutable_release_predecessor_mount_commit_mismatch');
    }
    const predecessorDependency = assertReleaseDependencyTreeContract({
      workspaceRoot: IMMUTABLE_RELEASE_LIVE_ROOT,
      readOnly: true,
    });
    const predecessorClosure = inspectSealedDeploymentClosure({
      workspaceRoot: IMMUTABLE_RELEASE_LIVE_ROOT,
      provenance: predecessorProvenance,
      dependencyInspection: predecessorDependency,
      expectedClosureHash: trustedPredecessorClosureHash,
    });
    return Object.freeze({
      version: 1,
      codeProvenance,
      releaseStateSnapshot,
      deploymentLock: Object.freeze({
        path: deploymentLock.path,
        identityHash: deploymentLock.identityHash,
      }),
      predecessorClosureHash: predecessorClosure.closureHash,
      mount,
      configIdentityHash: host.inspectConfigurationIdentity(),
      recoveryGateIdentityHash: recoveryGate.identityHash,
      units: Object.freeze(host.inspectUnits()),
      installedArtifacts: Object.freeze(host.inspectInstalledArtifacts()),
    });
  };

  let port;
  const acquireExclusiveDeploymentLock = async ({ lockPath, expectedIdentityHash }) => {
    const acquired = inheritedLockFd === null
      ? acquireExclusiveImmutableReleaseDeploymentLock({ lockPath, expectedIdentityHash })
      : adoptInheritedExclusiveImmutableReleaseDeploymentLock({
        lockPath, expectedIdentityHash, descriptor: inheritedLockFd,
      });
    let released = false;
    const lock = Object.freeze({
      identityHash: acquired.identityHash,
      assertHeld: acquired.assertHeld,
      release() {
        if (released) return false;
        host.unbindLock(lock);
        released = true;
        return acquired.release();
      },
    });
    host.bindLock(lock);
    return lock;
  };

  port = Object.freeze({
    acquireExclusiveDeploymentLock,
    assertLockHeld: host.assertLockHeld,
    async recoverUnfinishedDeployment({ lock }) {
      return recoverImmutableReleaseDeploymentIntent({
        intentRepository,
        operations: port,
        lock,
        expectedLockIdentityHash: lock.identityHash,
      });
    },
    beginDeploymentIntent({ plan }) { return intentRepository.begin({ plan }); },
    recordDeploymentIntentPhase({ intent, phase, hostSnapshot, progress }) {
      return intentRepository.advance({
        expectedIntentHash: intent.intentHash,
        phase,
        ...(hostSnapshot === undefined ? {} : { hostSnapshot }),
        ...(progress === undefined ? {} : { progress }),
      });
    },
    completeDeploymentIntent({ intent, disposition }) {
      if ((disposition === 'committed' && intent.phase !== 'committed')
        || (disposition === 'rollback_verified' && intent.phase !== 'rollback_verified')) {
        throw codedError('immutable_release_deployment_intent_disposition_invalid');
      }
      return intentRepository.remove({ expectedIntentHash: intent.intentHash });
    },
    inspectDeployment,
    async materializeCandidate({ plan }) {
      if (candidateRoot === null) {
        throw codedError('immutable_release_deployment_candidate_workspace_required');
      }
      return materializeImmutableReleaseCandidate({
        plan,
        candidateWorkspaceRoot: candidateRoot,
        inspectReleaseState: ({ workspaceRoot, expectedSnapshotHash }) => assertReleaseReady({
          workspaceRoot,
          expectedSnapshotHash,
        }),
      });
    },
    async generateAndVerifyClosure({ prepared, inheritedFromClosureHash }) {
      return buildAndSealImmutableReleaseDeploymentClosure({
        workspaceRoot: prepared.releaseRoot,
        inheritedFromClosureHash,
        // Approval is derived from the already sealed live predecessor during
        // this transaction's preflight. A static genesis allowlist would make
        // the first deployed closure impossible to inherit on the next release.
        approvedPredecessorClosureHashes: Object.freeze([inheritedFromClosureHash]),
        expectedUid: 0,
        expectedGid: 0,
      });
    },
    async sealAndPublishCandidate({ plan, prepared }) {
      return publishSealedImmutableReleaseCandidate({ plan, prepared });
    },
    captureHostSnapshot: host.captureHostSnapshot,
    quiesceConsumers: host.quiesceConsumers,
    assertReleaseUnreferenced: host.assertReleaseUnreferenced,
    cutoverMount: host.cutoverMount,
    installHostArtifacts: host.installHostArtifacts,
    postverifyRelease: host.postverifyRelease,
    restoreUnitStates: host.restoreUnitStates,
    verifyPostconditions: host.verifyPostconditions,
    rollbackHostArtifacts: host.rollbackHostArtifacts,
    rollbackMount: host.rollbackMount,
    verifyRollback: host.verifyRollback,
    async cleanupCandidate(options) {
      const plan = assertImmutableReleaseDeploymentPlan(options.plan);
      const removePublishedTarget = options.rollbackComplete === true
        && options.publishAttempted === true;
      if (removePublishedTarget) {
        const unreferenced = await host.assertReleaseUnreferenced({
          plan,
          lock: options.lock,
          releasePath: plan.target.releasePath,
          phase: options.recovery ? 'recovery_cleanup' : 'rollback_cleanup',
        });
        if (unreferenced.status !== 'immutable_release_release_unreferenced') {
          throw codedError('immutable_release_candidate_cleanup_target_referenced');
        }
      }
      return cleanupImmutableReleaseCandidateForPlan({
        plan,
        removePublishedTarget,
        expectedPublicationIdentityHash:
          options.published?.publicationIdentityHash || null,
      });
    },
  });

  const transaction = new ImmutableReleaseDeploymentTransaction({ port, failpoint });
  return Object.freeze({
    port,
    transaction,
    async recover() {
      const inspected = inspectImmutableReleaseDeploymentLock({
        lockPath: IMMUTABLE_RELEASE_DEPLOYMENT_LOCK,
      });
      const lock = await acquireExclusiveDeploymentLock({
        lockPath: inspected.path,
        expectedIdentityHash: inspected.identityHash,
      });
      try {
        return await port.recoverUnfinishedDeployment({ lock });
      } finally {
        lock.release();
      }
    },
  });
}
