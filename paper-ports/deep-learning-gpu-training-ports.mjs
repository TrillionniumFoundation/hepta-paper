function assertAuthorityPort(port, {
  kind,
  method,
  scope,
} = {}) {
  if (port?.version !== 1
    || port?.kind !== kind
    || port?.authorityScope !== scope
    || typeof port?.[method] !== 'function') {
    throw new Error(`${kind} version 1 is required`);
  }
  return port;
}

export function assertDeepLearningGpuTrainingExecutorPort(port) {
  if (port?.version !== 1
    || port?.kind !== 'DeepLearningGpuTrainingExecutor'
    || typeof port?.execute !== 'function'
    || typeof port?.capabilities !== 'function') {
    throw new Error('DeepLearningGpuTrainingExecutorPort version 1 is required');
  }
  const capabilities = port.capabilities();
  if (capabilities?.runtimeProfile !== 'pythonGpu'
    || capabilities?.framework !== 'cupy'
    || capabilities?.modelFamily !== 'declarative-sequential-mlp-v1'
    || capabilities?.customCodeAllowed !== false
    || capabilities?.customCudaAllowed !== false
    || capabilities?.pickleAllowed !== false
    || capabilities?.singleGpuUuidRequired !== true
    || capabilities?.trainingDatasetAuthorityRequired !== true
    || capabilities?.hiddenEvaluationAuthorityProvided !== false
    || capabilities?.predictorAuthorityProvided !== false
    || capabilities?.selfAuthorizesProductionPromotion !== false) {
    throw new Error('DeepLearningGpuTrainingExecutorPort capabilities invalid');
  }
  return port;
}

export function assertDeepLearningPredictorAuthorityPort(port) {
  return assertAuthorityPort(port, {
    kind: 'DeepLearningPredictorAuthorityPort',
    method: 'predict',
    scope: 'checkpoint-bound-prediction-only-v1',
  });
}

export function assertDeepLearningHiddenEvaluatorAuthorityPort(port) {
  return assertAuthorityPort(port, {
    kind: 'DeepLearningHiddenEvaluatorAuthorityPort',
    method: 'evaluateHiddenHoldout',
    scope: 'sealed-hidden-holdout-evaluation-only-v1',
  });
}
