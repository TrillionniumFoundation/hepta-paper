export function assertGpuSelectorExecutionLeasePort(port) {
  if (port?.version !== 1
    || port?.kind !== 'GpuSelectorExecutionLeasePort'
    || typeof port?.capabilities !== 'function'
    || typeof port?.acquire !== 'function'
    || typeof port?.withLease !== 'function'
    || typeof port?.currentLease !== 'function') {
    throw new Error('GpuSelectorExecutionLeasePort v1 is required');
  }
  const capabilities = port.capabilities();
  if (capabilities?.version !== 1
    || capabilities?.kind !== 'GpuSelectorExecutionLeaseCapabilities'
    || capabilities?.crossProcess !== true
    || capabilities?.perGpuUuid !== true
    || capabilities?.deadlineBound !== false
    || capabilities?.acquisitionWaitDeadlineBound !== true
    || capabilities?.holderHardDeadlineBound !== false
    || capabilities?.holderDeadlineEnforcement
      !== 'cooperative_same_event_loop_watchdog_v1'
    || capabilities?.abortableWait !== true
    || capabilities?.asyncContextReentrant !== false
    || capabilities?.productionExclusivityClaimed !== false) {
    throw new Error('GpuSelectorExecutionLeasePort capabilities invalid');
  }
  return port;
}
