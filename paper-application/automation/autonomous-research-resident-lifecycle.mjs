function observedDate(clock) {
  const value = clock?.now ? clock.now() : new Date();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error('autonomous_research_supervisor_clock_invalid');
  }
  return date;
}

async function sleepWithSignal(scheduler, milliseconds, signal) {
  if (milliseconds <= 0 || signal?.aborted) return;
  let onAbort = null;
  const aborted = new Promise((resolve) => {
    onAbort = resolve;
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  try {
    await Promise.race([scheduler.sleep(milliseconds, { signal }), aborted]);
  } finally {
    signal?.removeEventListener?.('abort', onAbort);
  }
}

export function assertAutonomousResearchResidentInstanceConfiguration({
  repository,
  leaseMs,
  heartbeatMs,
  minimumLeaseMs = 15 * 60 * 1000,
} = {}) {
  if (!repository) return;
  if (typeof repository.acquireInstanceLease !== 'function'
    || typeof repository.markStartupReconciled !== 'function'
    || typeof repository.markMachineIntakeReconciled !== 'function'
    || typeof repository.markMachineIntakeReconciliationFailed !== 'function'
    || typeof repository.heartbeatInstanceLease !== 'function'
    || typeof repository.assertInstanceLease !== 'function'
    || typeof repository.releaseInstanceLease !== 'function') {
    throw new Error('autonomous_research_supervisor_instance_repository_invalid');
  }
  if (!Number.isSafeInteger(Number(leaseMs)) || Number(leaseMs) < minimumLeaseMs
    || !Number.isSafeInteger(Number(heartbeatMs)) || Number(heartbeatMs) < 250
    || Number(heartbeatMs) * 2 >= Number(leaseMs)) {
    throw new Error('autonomous_research_supervisor_instance_timing_unsafe');
  }
}

export async function runAutonomousResearchResident({
  residentInstanceRepository,
  residentInstanceLeaseMs,
  residentInstanceHeartbeatMs,
  requireFullyAutonomous = false,
  ownerId,
  clock,
  scheduler,
  executionController,
  runCycle,
  cycleAuthority = null,
  onCycle,
  pollMs,
} = {}) {
  const executionSignal = executionController.signal;
  let cycles = 0;
  let lastCycle = null;
  let instanceLease = null;
  let instanceHeartbeat = null;
  let instanceFailure = null;
  const loseInstanceLease = (error) => {
    if (!instanceFailure) instanceFailure = error instanceof Error
      ? error : new Error(String(error
        || 'autonomous_research_supervisor_instance_lease_lost'));
    if (!executionSignal.aborted) {
      executionController.abort('autonomous_research_supervisor_instance_lease_lost');
    }
  };
  const heartbeat = (cycleReceipt = null) => {
    if (!instanceLease) return null;
    try {
      const renewed = residentInstanceRepository.heartbeatInstanceLease({
        lease: instanceLease,
        cycleReceipt,
        now: observedDate(clock),
      });
      if (!renewed) throw new Error('autonomous_research_supervisor_instance_lease_lost');
      instanceLease = renewed;
      return renewed;
    } catch (error) { loseInstanceLease(error); }
    return null;
  };
  const publishStartupReconciliation = (receipt) => {
    try {
      const renewed = residentInstanceRepository.markStartupReconciled({
        lease: instanceLease,
        receiptHash: receipt.autonomousResearchSupervisorStartupReconciliationReceiptHash,
        fullyAutonomousPrerequisiteReceipt:
          receipt.fullyAutonomousPrerequisiteReceipt,
        now: observedDate(clock),
      });
      if (!renewed) throw new Error('autonomous_research_supervisor_instance_lease_lost');
      instanceLease = renewed;
    } catch (error) {
      loseInstanceLease(error);
      throw instanceFailure;
    }
  };
  const publishMachineIntakeReconciliation = (receipt) => {
    try {
      const renewed = residentInstanceRepository.markMachineIntakeReconciled({
        lease: instanceLease,
        receiptHash:
          receipt.autonomousResearchSupervisorMachineIntakeReconciliationReceiptHash,
        configurationHash: receipt.machineIntakeConfigurationHash,
        datasetSnapshotHash: receipt.topicProducerDatasetSnapshotHash,
        now: observedDate(clock),
      });
      if (!renewed) throw new Error('autonomous_research_supervisor_instance_lease_lost');
      instanceLease = renewed;
    } catch (error) {
      loseInstanceLease(error);
      throw instanceFailure;
    }
  };
  const publishMachineIntakeFailure = (reason) => {
    try {
      const renewed = residentInstanceRepository.markMachineIntakeReconciliationFailed({
        lease: instanceLease,
        reason,
        now: observedDate(clock),
      });
      if (!renewed) throw new Error('autonomous_research_supervisor_instance_lease_lost');
      instanceLease = renewed;
    } catch (error) {
      loseInstanceLease(error);
      throw instanceFailure;
    }
  };
  const publishResidentProgress = ({ stage = 'unspecified' } = {}) => {
    const progressLease = heartbeat();
    if (instanceFailure) throw instanceFailure;
    if (!progressLease) return null;
    return Object.freeze({
      version: 1,
      kind: 'AutonomousResearchResidentLeaseContext',
      stage: String(stage),
      ownerId: progressLease.ownerId,
      leaseGeneration: progressLease.leaseGeneration,
      leaseExpiresAt: progressLease.expiresAt,
      lease: progressLease,
      assertCurrent({ now = observedDate(clock) } = {}) {
        return residentInstanceRepository.assertInstanceLease({
          lease: progressLease,
          now,
        });
      },
    });
  };
  try {
    if (residentInstanceRepository && !executionSignal.aborted) {
      instanceLease = residentInstanceRepository.acquireInstanceLease({
        ownerId,
        leaseMs: residentInstanceLeaseMs,
        heartbeatMs: residentInstanceHeartbeatMs,
        fullyAutonomousRequired: requireFullyAutonomous,
        now: observedDate(clock),
      });
      if (!instanceLease) {
        throw new Error('autonomous_research_supervisor_instance_already_active');
      }
      instanceHeartbeat = scheduler.setInterval(() => heartbeat(), instanceLease.heartbeatMs);
      scheduler.unref?.(instanceHeartbeat);
      publishResidentProgress({ stage: 'resident_started' });
    }
    while (!executionSignal.aborted) {
      lastCycle = await runCycle({
        cycleAuthority,
        onStartupReconciled: instanceLease ? publishStartupReconciliation : null,
        onMachineIntakeReconciled:
          instanceLease ? publishMachineIntakeReconciliation : null,
        onMachineIntakeReconciliationFailed:
          instanceLease ? publishMachineIntakeFailure : null,
        onResidentProgress: instanceLease ? publishResidentProgress : null,
      });
      cycles += 1;
      if (instanceLease) heartbeat(lastCycle);
      if (instanceFailure) throw instanceFailure;
      await onCycle?.(lastCycle);
      if (!executionSignal.aborted) {
        await sleepWithSignal(scheduler, pollMs, executionSignal);
      }
    }
    if (instanceFailure) throw instanceFailure;
    return Object.freeze({
      version: 1,
      kind: 'AutonomousResearchSupervisorRunReceipt',
      status: 'autonomous_research_supervisor_stopped_gracefully',
      ownerId,
      cycleCount: cycles,
      lastCycle,
      stoppedAt: observedDate(clock).toISOString(),
    });
  } finally {
    if (instanceHeartbeat) scheduler.clearInterval(instanceHeartbeat);
    if (instanceLease) {
      try {
        residentInstanceRepository.releaseInstanceLease({
          lease: instanceLease,
          reason: executionSignal.reason || 'supervisor_process_shutdown',
          now: observedDate(clock),
        });
      } catch { /* an expired/replaced instance fence must not be cleared */ }
    }
  }
}
