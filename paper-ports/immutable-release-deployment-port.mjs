const REQUIRED_METHODS = Object.freeze([
  'acquireExclusiveDeploymentLock',
  'assertLockHeld',
  'recoverUnfinishedDeployment',
  'beginDeploymentIntent',
  'recordDeploymentIntentPhase',
  'completeDeploymentIntent',
  'inspectDeployment',
  'materializeCandidate',
  'generateAndVerifyClosure',
  'sealAndPublishCandidate',
  'captureHostSnapshot',
  'quiesceConsumers',
  'assertReleaseUnreferenced',
  'cutoverMount',
  'installHostArtifacts',
  'postverifyRelease',
  'restoreUnitStates',
  'verifyPostconditions',
  'rollbackHostArtifacts',
  'rollbackMount',
  'verifyRollback',
  'cleanupCandidate',
]);

export function assertImmutableReleaseDeploymentPort(port) {
  if (!port || typeof port !== 'object') {
    throw new Error('immutable_release_deployment_port_required');
  }
  const missing = REQUIRED_METHODS.filter((method) => typeof port[method] !== 'function');
  if (missing.length > 0) {
    throw Object.assign(new Error('immutable_release_deployment_port_incomplete'), {
      missingMethods: Object.freeze(missing),
    });
  }
  return port;
}

export function createUnsupportedImmutableReleaseDeploymentPort({
  inspectDeployment,
} = {}) {
  if (typeof inspectDeployment !== 'function') {
    throw new Error('immutable_release_deployment_inspector_required');
  }
  const unsupported = (operation) => () => {
    throw new Error(`immutable_release_deployment_host_operation_unsupported:${operation}`);
  };
  return Object.freeze({
    inspectDeployment,
    acquireExclusiveDeploymentLock: unsupported('acquireExclusiveDeploymentLock'),
    assertLockHeld: unsupported('assertLockHeld'),
    recoverUnfinishedDeployment: unsupported('recoverUnfinishedDeployment'),
    beginDeploymentIntent: unsupported('beginDeploymentIntent'),
    recordDeploymentIntentPhase: unsupported('recordDeploymentIntentPhase'),
    completeDeploymentIntent: unsupported('completeDeploymentIntent'),
    materializeCandidate: unsupported('materializeCandidate'),
    generateAndVerifyClosure: unsupported('generateAndVerifyClosure'),
    sealAndPublishCandidate: unsupported('sealAndPublishCandidate'),
    captureHostSnapshot: unsupported('captureHostSnapshot'),
    quiesceConsumers: unsupported('quiesceConsumers'),
    assertReleaseUnreferenced: unsupported('assertReleaseUnreferenced'),
    cutoverMount: unsupported('cutoverMount'),
    installHostArtifacts: unsupported('installHostArtifacts'),
    postverifyRelease: unsupported('postverifyRelease'),
    restoreUnitStates: unsupported('restoreUnitStates'),
    verifyPostconditions: unsupported('verifyPostconditions'),
    rollbackHostArtifacts: unsupported('rollbackHostArtifacts'),
    rollbackMount: unsupported('rollbackMount'),
    verifyRollback: unsupported('verifyRollback'),
    cleanupCandidate: () => {},
  });
}
