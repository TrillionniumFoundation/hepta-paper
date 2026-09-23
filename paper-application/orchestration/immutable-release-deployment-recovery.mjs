import {
  assertImmutableReleaseDeploymentPlan,
} from '../../paper-domain/contracts/immutable-release-deployment-contract.mjs';

function codedError(code, details = {}) {
  return Object.assign(new Error(code), { code, ...details });
}

function requireOperation(operations, name) {
  if (typeof operations?.[name] !== 'function') {
    throw codedError(`immutable_release_deployment_recovery_operation_missing:${name}`);
  }
}

const REQUIRED_OPERATIONS = Object.freeze([
  'assertLockHeld',
  'quiesceConsumers',
  'assertReleaseUnreferenced',
  'rollbackHostArtifacts',
  'rollbackMount',
  'restoreUnitStates',
  'verifyRollback',
  'verifyPostconditions',
  'cleanupCandidate',
]);

/**
 * Resolve the single durable intent before a new deployment is inspected.
 *
 * All mutators are deliberately retried after a durable rollback_attempted
 * marker. A process can die after changing the host but before returning, so a
 * completed-looking previous phase is never used as permission to skip an
 * idempotent restore.
 */
export async function recoverImmutableReleaseDeploymentIntent({
  intentRepository,
  operations,
  lock,
  expectedLockIdentityHash,
} = {}) {
  if (!intentRepository || typeof intentRepository.read !== 'function'
    || typeof intentRepository.advance !== 'function'
    || typeof intentRepository.remove !== 'function') {
    throw codedError('immutable_release_deployment_recovery_intent_repository_invalid');
  }
  for (const operation of REQUIRED_OPERATIONS) requireOperation(operations, operation);
  await operations.assertLockHeld({ lock, expectedIdentityHash: expectedLockIdentityHash });
  let intent = intentRepository.read();
  if (intent === null) {
    return Object.freeze({ status: 'immutable_release_deployment_recovery_not_required' });
  }
  const plan = assertImmutableReleaseDeploymentPlan(intent.plan);

  if (intent.phase === 'committed') {
    // At boot the gate itself is still activating, so consumers ordered After
    // it cannot synchronously reach their pre-reboot active states. Reapply
    // enablement and queue the exact start/stop jobs before verifying the
    // committed target; verifyPostconditions accepts only those queued jobs.
    await operations.restoreUnitStates({
      plan,
      lock,
      snapshot: intent.hostSnapshot,
      phase: 'commit',
      recovery: true,
    });
    const verification = await operations.verifyPostconditions({
      plan,
      lock,
      snapshot: intent.hostSnapshot,
      published: Object.freeze({
        status: 'immutable_release_candidate_published',
        releasePath: plan.target.releasePath,
        publicationIdentityHash: intent.progress.publicationIdentityHash,
      }),
      closureHash: intent.progress.closureHash,
      postverificationHash: intent.progress.postverificationHash,
      installedArtifactIdentityHash: intent.progress.installedArtifactIdentityHash,
      phase: 'recovery',
    });
    if (verification?.status !== 'immutable_release_deployment_postconditions_verified'
      || verification.configIdentityHash !== plan.configIdentityHash) {
      throw codedError('immutable_release_deployment_committed_recovery_verification_invalid');
    }
    intentRepository.remove({ expectedIntentHash: intent.intentHash });
    return Object.freeze({
      status: 'immutable_release_deployment_recovery_completed',
      disposition: 'committed',
      recoveredPlanHash: plan.planHash,
    });
  }

  if (intent.phase !== 'rollback_attempted' && intent.phase !== 'rollback_verified') {
    intent = intentRepository.advance({
      expectedIntentHash: intent.intentHash,
      phase: 'rollback_attempted',
    });
  }

  if (intent.hostSnapshot !== null) {
    const snapshot = intent.hostSnapshot;
    await operations.quiesceConsumers({ plan, lock, snapshot, phase: 'recovery_rollback' });
    const unreferenced = await operations.assertReleaseUnreferenced({
      plan,
      lock,
      snapshot,
      phase: 'recovery_rollback',
      releasePath: plan.target.releasePath,
    });
    if (unreferenced?.status !== 'immutable_release_release_unreferenced') {
      throw codedError('immutable_release_deployment_recovery_target_still_referenced');
    }
    await operations.rollbackHostArtifacts({
      plan, lock, snapshot, attempted: true, phase: 'recovery_rollback',
    });
    await operations.rollbackMount({
      plan, lock, snapshot, attempted: true, phase: 'recovery_rollback',
    });
    await operations.restoreUnitStates({
      plan, lock, snapshot, attempted: true, phase: 'rollback', recovery: true,
    });
    const verification = await operations.verifyRollback({
      plan, lock, snapshot, phase: 'recovery_rollback',
    });
    if (verification?.status !== 'immutable_release_deployment_rollback_verified'
      || verification.configIdentityHash !== plan.configIdentityHash) {
      throw codedError('immutable_release_deployment_recovery_rollback_verification_invalid');
    }
  } else {
    const unreferenced = await operations.assertReleaseUnreferenced({
      plan,
      lock,
      snapshot: null,
      phase: 'recovery_cleanup',
      releasePath: plan.target.releasePath,
    });
    if (unreferenced?.status !== 'immutable_release_release_unreferenced') {
      throw codedError('immutable_release_deployment_recovery_target_still_referenced');
    }
  }

  await operations.cleanupCandidate({
    plan,
    lock,
    prepared: null,
    published: Object.freeze({
      releasePath: plan.target.releasePath,
      publicationIdentityHash: intent.progress.publicationIdentityHash,
    }),
    rollbackComplete: true,
    materializeAttempted: true,
    publishAttempted: true,
    recovery: true,
  });
  if (intent.phase !== 'rollback_verified') {
    intent = intentRepository.advance({
      expectedIntentHash: intent.intentHash,
      phase: 'rollback_verified',
    });
  }
  intentRepository.remove({ expectedIntentHash: intent.intentHash });
  return Object.freeze({
    status: 'immutable_release_deployment_recovery_completed',
    disposition: 'rollback_verified',
    recoveredPlanHash: plan.planHash,
  });
}
