import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  assertImmutableReleaseHostSnapshot,
  assertImmutableReleaseDeploymentPlan,
  buildImmutableReleaseDeploymentPlan,
  immutableReleaseDeploymentReceipt,
} from '../../paper-domain/contracts/immutable-release-deployment-contract.mjs';
import {
  assertImmutableReleaseDeploymentPort,
} from '../../paper-ports/immutable-release-deployment-port.mjs';

function codedError(code, details = {}) {
  return Object.assign(new Error(code), { code, ...details });
}

function blockerFor(error) {
  return String(error?.code || error?.message || 'immutable_release_deployment_failed')
    .replace(/[^A-Za-z0-9_.:-]/gu, '_');
}

function assertHash(value, code) {
  if (!/^sha256:[0-9a-f]{64}$/u.test(String(value || ''))) throw codedError(code);
  return value;
}

async function invokeFailpoint(failpoint, stage, context) {
  if (typeof failpoint === 'function') await failpoint({ stage, ...context });
}

function rollbackRecord({ actions, complete, verification = null }) {
  const payload = Object.freeze({
    version: 1,
    kind: 'ImmutableReleaseDeploymentRollback',
    status: complete
      ? 'immutable_release_deployment_rollback_verified'
      : 'immutable_release_deployment_rollback_incomplete',
    actions: Object.freeze([...actions]),
    verification,
  });
  return Object.freeze({
    ...payload,
    rollbackHash: hashRecord('ImmutableReleaseDeploymentRollback', payload),
  });
}

export class ImmutableReleaseDeploymentTransaction {
  constructor({ port, failpoint = null } = {}) {
    this.port = assertImmutableReleaseDeploymentPort(port);
    this.failpoint = failpoint;
  }

  async plan() {
    const inspection = await this.port.inspectDeployment({ mode: 'plan' });
    const plan = buildImmutableReleaseDeploymentPlan({ inspection });
    return Object.freeze({
      plan,
      receipt: immutableReleaseDeploymentReceipt({
        plan,
        status: 'immutable_release_deployment_planned',
        completedStages: [],
      }),
    });
  }

  async execute({ plan: requestedPlan, expectedPlanHash } = {}) {
    const plan = assertImmutableReleaseDeploymentPlan(requestedPlan);
    if (expectedPlanHash !== plan.planHash) {
      throw codedError('immutable_release_deployment_plan_hash_confirmation_required');
    }
    let lock;
    let prepared = null;
    let published = null;
    let snapshot = null;
    let snapshotValidated = false;
    let closureHash = null;
    let postverificationHash = null;
    let installedArtifactIdentityHash = null;
    let cutoverAttempted = false;
    let artifactInstallAttempted = false;
    let unitRestoreAttempted = false;
    let materializeAttempted = false;
    let publishAttempted = false;
    let hostSnapshotHash = null;
    let outcome = null;
    let pendingFailure = null;
    let intent = null;
    const completedStages = [];
    const stage = async (name, context = {}) => {
      completedStages.push(name);
      await invokeFailpoint(this.failpoint, name, { plan, ...context });
    };
    try {
      lock = await this.port.acquireExclusiveDeploymentLock({
        expectedIdentityHash: plan.deploymentLock.identityHash,
        lockPath: plan.deploymentLock.path,
      });
      await this.port.assertLockHeld({ lock, expectedIdentityHash: plan.deploymentLock.identityHash });
      const recovery = await this.port.recoverUnfinishedDeployment({ lock });
      if (!['immutable_release_deployment_recovery_not_required',
        'immutable_release_deployment_recovery_completed'].includes(recovery?.status)) {
        throw codedError('immutable_release_deployment_recovery_invalid');
      }
      await stage('lock_acquired');

      const currentInspection = await this.port.inspectDeployment({
        mode: 'execute', lock, expectedPlanHash: plan.planHash,
      });
      const currentPlan = buildImmutableReleaseDeploymentPlan({ inspection: currentInspection });
      if (currentPlan.planHash !== plan.planHash) {
        throw codedError('immutable_release_deployment_preflight_drift');
      }
      await this.port.assertLockHeld({ lock, expectedIdentityHash: plan.deploymentLock.identityHash });
      await stage('preflight_reverified');
      intent = await this.port.beginDeploymentIntent({ plan, lock });

      materializeAttempted = true;
      intent = await this.port.recordDeploymentIntentPhase({
        plan, lock, intent, phase: 'materialize_attempted',
      });
      prepared = await this.port.materializeCandidate({ plan, lock });
      if (prepared?.status !== 'immutable_release_candidate_materialized') {
        throw codedError('immutable_release_deployment_materialization_invalid');
      }
      intent = await this.port.recordDeploymentIntentPhase({
        plan, lock, intent, phase: 'materialized',
      });
      await stage('candidate_materialized', { prepared });

      const closure = await this.port.generateAndVerifyClosure({
        plan, lock, prepared, inheritedFromClosureHash: plan.predecessor.closureHash,
      });
      closureHash = assertHash(
        closure?.closureHash,
        'immutable_release_deployment_closure_invalid',
      );
      if (closure?.status !== 'immutable_release_deployment_closure_verified'
        || closure?.inheritedFromClosureHash !== plan.predecessor.closureHash) {
        throw codedError('immutable_release_deployment_closure_invalid');
      }
      intent = await this.port.recordDeploymentIntentPhase({
        plan, lock, intent, phase: 'closure_verified', progress: { closureHash },
      });
      await stage('closure_verified', { closure });

      publishAttempted = true;
      intent = await this.port.recordDeploymentIntentPhase({
        plan, lock, intent, phase: 'publish_attempted',
      });
      published = await this.port.sealAndPublishCandidate({ plan, lock, prepared, closure });
      if (published?.status !== 'immutable_release_candidate_published'
        || published?.releasePath !== plan.target.releasePath) {
        throw codedError('immutable_release_deployment_publication_invalid');
      }
      const publicationIdentityHash = assertHash(
        published.publicationIdentityHash,
        'immutable_release_deployment_publication_invalid',
      );
      intent = await this.port.recordDeploymentIntentPhase({
        plan,
        lock,
        intent,
        phase: 'published',
        progress: { publicationIdentityHash },
      });
      await stage('candidate_published', { published });

      const capturedSnapshot = await this.port.captureHostSnapshot({ plan, lock });
      snapshot = assertImmutableReleaseHostSnapshot(capturedSnapshot, { plan });
      hostSnapshotHash = assertHash(snapshot.hostSnapshotHash,
        'immutable_release_deployment_host_snapshot_invalid');
      snapshotValidated = true;
      intent = await this.port.recordDeploymentIntentPhase({
        plan, lock, intent, phase: 'snapshot_persisted', hostSnapshot: snapshot,
      });
      await stage('host_snapshot_captured', { snapshot });

      intent = await this.port.recordDeploymentIntentPhase({
        plan, lock, intent, phase: 'quiesce_attempted',
      });
      await this.port.quiesceConsumers({ plan, lock, snapshot });
      await this.port.assertLockHeld({ lock, expectedIdentityHash: plan.deploymentLock.identityHash });
      intent = await this.port.recordDeploymentIntentPhase({
        plan, lock, intent, phase: 'quiesced',
      });
      await stage('consumers_quiesced');

      const unreferenced = await this.port.assertReleaseUnreferenced({
        plan, lock, snapshot, releasePath: plan.predecessor.releasePath,
      });
      if (unreferenced?.status !== 'immutable_release_release_unreferenced') {
        throw codedError('immutable_release_deployment_old_release_still_referenced');
      }
      await stage('old_release_unreferenced', { unreferenced });

      cutoverAttempted = true;
      intent = await this.port.recordDeploymentIntentPhase({
        plan, lock, intent, phase: 'cutover_attempted',
      });
      await this.port.cutoverMount({ plan, lock, snapshot, published });
      intent = await this.port.recordDeploymentIntentPhase({
        plan, lock, intent, phase: 'cutover_completed',
      });
      await stage('mount_cutover');

      artifactInstallAttempted = true;
      intent = await this.port.recordDeploymentIntentPhase({
        plan, lock, intent, phase: 'install_attempted',
      });
      const installedArtifacts = await this.port.installHostArtifacts({
        plan, lock, snapshot, published,
      });
      installedArtifactIdentityHash = assertHash(
        installedArtifacts?.installedArtifactIdentityHash,
        'immutable_release_deployment_installed_artifacts_invalid',
      );
      intent = await this.port.recordDeploymentIntentPhase({
        plan,
        lock,
        intent,
        phase: 'install_completed',
        progress: { installedArtifactIdentityHash },
      });
      await stage('host_artifacts_installed');

      const postverification = await this.port.postverifyRelease({
        plan, lock, snapshot, published, closureHash,
      });
      postverificationHash = assertHash(
        postverification?.postverificationHash,
        'immutable_release_deployment_postverify_invalid',
      );
      if (postverification?.status !== 'immutable_release_deployment_postverified') {
        throw codedError('immutable_release_deployment_postverify_invalid');
      }
      intent = await this.port.recordDeploymentIntentPhase({
        plan,
        lock,
        intent,
        phase: 'postverify_completed',
        progress: { postverificationHash },
      });
      await stage('postverify_completed', { postverification });

      unitRestoreAttempted = true;
      intent = await this.port.recordDeploymentIntentPhase({
        plan, lock, intent, phase: 'unit_restore_attempted',
      });
      await this.port.restoreUnitStates({ plan, lock, snapshot, phase: 'commit' });
      intent = await this.port.recordDeploymentIntentPhase({
        plan, lock, intent, phase: 'unit_restore_completed',
      });
      await stage('unit_states_restored');

      const postconditions = await this.port.verifyPostconditions({
        plan, lock, snapshot, published, closureHash, postverificationHash,
        installedArtifactIdentityHash,
      });
      if (postconditions?.status !== 'immutable_release_deployment_postconditions_verified'
        || postconditions.configIdentityHash !== plan.configIdentityHash) {
        throw codedError('immutable_release_deployment_postconditions_invalid');
      }
      await stage('postconditions_verified', { postconditions });
      intent = await this.port.recordDeploymentIntentPhase({
        plan, lock, intent, phase: 'committed',
      });
      await this.port.completeDeploymentIntent({ plan, lock, intent, disposition: 'committed' });
      intent = null;
      outcome = immutableReleaseDeploymentReceipt({
        plan,
        status: 'immutable_release_deployment_completed',
        completedStages,
        closureHash,
        hostSnapshotHash,
        postverificationHash,
      });
    } catch (error) {
      const originalBlocker = blockerFor(error);
      const rollbackActions = [];
      let rollbackComplete = true;
      let rollbackVerification = null;
      if (intent) {
        try {
          intent = await this.port.recordDeploymentIntentPhase({
            plan, lock, intent, phase: 'rollback_attempted',
          });
          rollbackActions.push('rollback_intent_persisted');
        } catch (intentError) {
          rollbackComplete = false;
          rollbackVerification = Object.freeze({
            status: 'immutable_release_deployment_rollback_incomplete',
            blocker: blockerFor(intentError),
          });
        }
      }
      if (snapshotValidated) {
        try {
          // Always quiesce again. A post-restore failure can occur while old
          // unit state is already running against the new mount/artifacts.
          await this.port.quiesceConsumers({ plan, lock, snapshot, phase: 'rollback' });
          rollbackActions.push('consumers_quiesced');
          const unreferenced = await this.port.assertReleaseUnreferenced({
            plan,
            lock,
            snapshot,
            phase: 'rollback',
            releasePath: plan.target.releasePath,
          });
          if (unreferenced?.status !== 'immutable_release_release_unreferenced') {
            throw codedError('immutable_release_deployment_new_release_still_referenced');
          }
          rollbackActions.push('new_release_unreferenced');
          // These restores are deliberately unconditional and idempotent. A
          // mutator may change host state and then throw before returning.
          await this.port.rollbackHostArtifacts({
            plan, lock, snapshot, attempted: artifactInstallAttempted,
          });
          rollbackActions.push('host_artifacts_restored');
          await this.port.rollbackMount({
            plan, lock, snapshot, attempted: cutoverAttempted,
          });
          rollbackActions.push('mount_restored');
          await this.port.restoreUnitStates({
            plan, lock, snapshot, phase: 'rollback', attempted: unitRestoreAttempted,
          });
          rollbackActions.push('unit_states_restored');
          rollbackVerification = await this.port.verifyRollback({ plan, lock, snapshot });
          if (rollbackVerification?.status !== 'immutable_release_deployment_rollback_verified'
            || rollbackVerification.configIdentityHash !== plan.configIdentityHash) {
            throw codedError('immutable_release_deployment_rollback_verification_invalid');
          }
          rollbackActions.push('rollback_verified');
        } catch (rollbackError) {
          rollbackComplete = false;
          rollbackVerification = Object.freeze({
            status: 'immutable_release_deployment_rollback_incomplete',
            blocker: blockerFor(rollbackError),
          });
        }
      }
      try {
        await this.port.cleanupCandidate({
          plan,
          lock,
          prepared,
          published,
          rollbackComplete,
          materializeAttempted,
          publishAttempted,
        });
        rollbackActions.push('candidate_cleanup_completed');
      } catch (cleanupError) {
        rollbackComplete = false;
        rollbackVerification = Object.freeze({
          status: 'immutable_release_deployment_rollback_incomplete',
          blocker: blockerFor(cleanupError),
        });
      }
      if (intent && rollbackComplete) {
        try {
          intent = await this.port.recordDeploymentIntentPhase({
            plan, lock, intent, phase: 'rollback_verified',
          });
          await this.port.completeDeploymentIntent({
            plan, lock, intent, disposition: 'rollback_verified',
          });
          intent = null;
          rollbackActions.push('rollback_intent_completed');
        } catch (intentError) {
          rollbackComplete = false;
          rollbackVerification = Object.freeze({
            status: 'immutable_release_deployment_rollback_incomplete',
            blocker: blockerFor(intentError),
          });
        }
      }
      pendingFailure = {
        cause: error,
        originalBlocker,
        rollbackActions,
        rollbackComplete,
        rollbackVerification,
      };
    } finally {
      if (lock) {
        const lockFinalizationBlockers = [];
        try {
          await this.port.assertLockHeld({
            lock,
            expectedIdentityHash: plan.deploymentLock.identityHash,
          });
        } catch (error) {
          lockFinalizationBlockers.push(blockerFor(error));
        }
        try {
          await lock.release();
        } catch (error) {
          lockFinalizationBlockers.push(blockerFor(error));
        }
        if (lockFinalizationBlockers.length > 0) {
          pendingFailure ||= {
            cause: codedError('immutable_release_deployment_lock_finalization_failed'),
            originalBlocker: 'immutable_release_deployment_lock_finalization_failed',
            rollbackActions: [],
            rollbackComplete: false,
            rollbackVerification: null,
          };
          pendingFailure.rollbackComplete = false;
          pendingFailure.rollbackVerification = Object.freeze({
            status: 'immutable_release_deployment_rollback_incomplete',
            blocker: `lock_finalization:${lockFinalizationBlockers.join(',')}`,
          });
        }
      }
    }
    if (pendingFailure) {
      const rollback = rollbackRecord({
        actions: pendingFailure.rollbackActions,
        complete: pendingFailure.rollbackComplete,
        verification: pendingFailure.rollbackVerification,
      });
      const receipt = immutableReleaseDeploymentReceipt({
        plan,
        status: pendingFailure.rollbackComplete
          ? 'immutable_release_deployment_rolled_back'
          : 'immutable_release_deployment_rollback_incomplete',
        completedStages,
        closureHash,
        hostSnapshotHash,
        postverificationHash,
        rollback,
        blocker: pendingFailure.originalBlocker,
      });
      throw codedError(
        pendingFailure.rollbackComplete
          ? 'immutable_release_deployment_failed_rolled_back'
          : 'immutable_release_deployment_failed_rollback_incomplete',
        { cause: pendingFailure.cause, receipt },
      );
    }
    return outcome;
  }
}
