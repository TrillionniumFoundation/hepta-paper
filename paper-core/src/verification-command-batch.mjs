export function runVerificationCommandsUntilFailure(commands, execute) {
  if (!Array.isArray(commands) || typeof execute !== 'function') {
    throw new TypeError('verification_command_batch_invalid');
  }
  for (const args of commands) {
    if (!Array.isArray(args)) {
      throw new TypeError('verification_command_arguments_invalid');
    }
    const result = execute(args);
    if (
      result === null
      || typeof result !== 'object'
      || Array.isArray(result)
      || typeof result.then === 'function'
      || !Number.isInteger(result.status)
    ) {
      throw new TypeError('verification_command_result_invalid');
    }
    if (result.status !== 0) return result;
  }
  return null;
}

export function createBoundedVerificationCommandExecutor({
  spawnSyncImpl,
  executable,
  cwd,
  env,
  timeoutMs,
  maxBuffer,
}) {
  if (
    typeof spawnSyncImpl !== 'function'
    || typeof executable !== 'string'
    || executable.length === 0
    || typeof cwd !== 'string'
    || cwd.length === 0
    || !Number.isSafeInteger(timeoutMs)
    || timeoutMs <= 0
    || !Number.isSafeInteger(maxBuffer)
    || maxBuffer <= 0
  ) {
    throw new TypeError('verification_command_executor_configuration_invalid');
  }
  return (args) => {
    const result = spawnSyncImpl(executable, args, {
      cwd,
      env,
      encoding: 'utf8',
      maxBuffer,
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
    });
    if (result?.error) throw result.error;
    return result;
  };
}
