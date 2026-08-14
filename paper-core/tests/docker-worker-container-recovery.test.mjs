import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createOsSandboxedWorkerRunnerForTest as createOsSandboxedWorkerRunner,
} from './support/os-sandboxed-worker-runner-test-driver.mjs';
import {
  buildDockerWorkerContainerOwnership,
  buildDockerWorkerContainerOwnershipForEnvironment,
  dockerWorkerContainerOwnershipArguments,
  recoverAbandonedDockerWorkerContainer,
  verifyDockerWorkerContainerRecoveryReceipt,
} from '../../paper-adapters/runtime/docker-worker-container-recovery.mjs';

const IMAGE = 'example.invalid/hepta-worker-recovery:test';
const IMAGE_DIGEST = `sha256:${'a'.repeat(64)}`;
const CONTAINER_ID = 'b'.repeat(64);

function dockerLabels(command) {
  const labels = {};
  for (let index = 0; index < command.length; index += 1) {
    if (command[index] !== '--label') continue;
    const [key, ...value] = String(command[index + 1] || '').split('=');
    labels[key] = value.join('=');
  }
  return labels;
}

function runLauncherFault(t, {
  launcherOutcome,
  recoveryMode = 'removed',
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-worker-recovery-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'run.py'), 'raise SystemExit(0)\n');
  let containerName = null;
  let containerIdPath = null;
  let labels = null;
  let containerPresent = true;
  let removalCount = 0;
  const runner = createOsSandboxedWorkerRunner({
    allowedExecutables: ['python3'],
    allowedRoots: [source],
    allowedContainerImages: [IMAGE],
    probe: {
      available: true,
      backend: 'docker',
      status: 'os_sandbox_available',
      processLimit: {
        available: true,
        mechanism: 'docker-pids-cgroup',
      },
    },
    imageDigestResolver: () => IMAGE_DIGEST,
    executor(_launcher, command) {
      const nameIndex = command.indexOf('--name');
      const cidfileIndex = command.indexOf('--cidfile');
      assert.ok(nameIndex > 0);
      assert.ok(cidfileIndex > 0);
      containerName = command[nameIndex + 1];
      containerIdPath = command[cidfileIndex + 1];
      labels = dockerLabels(command);
      fs.writeFileSync(containerIdPath, `${CONTAINER_ID}\n`);
      return launcherOutcome;
    },
    dockerContainerRecoveryExecutor(_docker, args) {
      if (args[0] === 'container' && args[1] === 'inspect') {
        if (!containerPresent || recoveryMode === 'absent') {
          return {
            status: 1,
            stdout: '',
            stderr: `Error: No such container: ${args[2]}`,
          };
        }
        if (recoveryMode === 'partial' && removalCount > 0) {
          return {
            status: 2,
            stdout: '',
            stderr: 'docker daemon unavailable after remove acknowledgement',
          };
        }
        return {
          status: 0,
          stdout: JSON.stringify([{
            Id: CONTAINER_ID,
            Name: `/${containerName}`,
            Config: {
              Labels: recoveryMode === 'ownership-mismatch'
                ? { ...labels, 'io.hepta.worker.ownership-hash': `sha256:${'f'.repeat(64)}` }
                : labels,
            },
          }]),
          stderr: '',
        };
      }
      if (args[0] === 'rm' && args[1] === '--force') {
        removalCount += 1;
        if (recoveryMode === 'removed') containerPresent = false;
        return { status: 0, stdout: `${CONTAINER_ID}\n`, stderr: '' };
      }
      throw new Error(`unexpected cleanup command: ${args.join(' ')}`);
    },
  });
  const receipt = runner.run({
    executable: 'python3',
    args: ['run.py'],
    cwd: source,
    sourceRoot: source,
    containerImage: IMAGE,
    containerExecutable: 'python3',
    timeoutMs: 1_000,
    env: {
      HEPTA_EXPERIMENT_RUN_ID: 'campaign:node:attempt',
      HEPTA_EXPERIMENT_ATTEMPT_ID: 'campaign:node:attempt:arm:treatment',
    },
    language: 'python',
    determinismPolicy: 'unknown',
  });
  if (containerIdPath) {
    const recoveryRoot = path.dirname(containerIdPath);
    t.after(() => fs.rmSync(recoveryRoot, { recursive: true, force: true }));
  }
  return {
    receipt,
    removalCount,
    recoveryRoot: containerIdPath ? path.dirname(containerIdPath) : null,
  };
}

test('create-to-start launcher timeout removes only the exact ownership-verified container and journals recovery', (t) => {
  const timeout = new Error('spawnSync docker ETIMEDOUT');
  timeout.code = 'ETIMEDOUT';
  const result = runLauncherFault(t, {
    launcherOutcome: {
      status: null,
      signal: 'SIGTERM',
      error: timeout,
      stdout: '',
      stderr: '',
    },
  });
  assert.equal(result.receipt.ok, false);
  assert.ok(result.receipt.blockers.includes('os_sandbox_command_timed_out'));
  assert.equal(result.receipt.blockers.includes('os_sandbox_command_failed'), false);
  assert.equal(result.removalCount, 1);
  assert.equal(
    result.receipt.dockerWorkerContainerRecoveryReceipt.status,
    'docker_worker_container_recovery_removed',
  );
  assert.equal(
    result.receipt.dockerWorkerContainerRecoveryReceipt.trigger,
    'launcher_timeout',
  );
  assert.equal(
    verifyDockerWorkerContainerRecoveryReceipt(
      result.receipt.dockerWorkerContainerRecoveryReceipt,
    ),
    true,
  );
  assert.equal(fs.existsSync(result.recoveryRoot), false);
});

test('create-to-start launcher kill removes the exact owned container without accepting the failed run', (t) => {
  const result = runLauncherFault(t, {
    launcherOutcome: {
      status: null,
      signal: 'SIGKILL',
      error: null,
      stdout: '',
      stderr: '',
    },
  });
  assert.equal(result.receipt.ok, false);
  assert.ok(result.receipt.blockers.includes('os_sandbox_command_failed'));
  assert.equal(result.receipt.blockers.includes('os_sandbox_command_timed_out'), false);
  assert.equal(result.removalCount, 1);
  assert.equal(
    result.receipt.dockerWorkerContainerRecoveryReceipt.trigger,
    'launcher_signal:SIGKILL',
  );
  assert.equal(
    verifyDockerWorkerContainerRecoveryReceipt(
      result.receipt.dockerWorkerContainerRecoveryReceipt,
    ),
    true,
  );
});

test('ownership mismatch never removes a container and preserves the recovery workspace fail-closed', (t) => {
  const timeout = new Error('spawnSync docker ETIMEDOUT');
  timeout.code = 'ETIMEDOUT';
  const result = runLauncherFault(t, {
    launcherOutcome: {
      status: null,
      signal: 'SIGTERM',
      error: timeout,
      stdout: '',
      stderr: '',
    },
    recoveryMode: 'ownership-mismatch',
  });
  assert.equal(result.receipt.ok, false);
  assert.ok(result.receipt.blockers.includes('os_sandbox_command_timed_out'));
  assert.equal(
    result.receipt.dockerWorkerContainerRecoveryReceipt.trigger,
    'launcher_timeout',
  );
  assert.equal(result.removalCount, 0);
  assert.ok(result.receipt.blockers.includes(
    'worker_container_recovery_ownership_mismatch',
  ));
  assert.equal(
    result.receipt.dockerWorkerContainerRecoveryReceipt.status,
    'docker_worker_container_recovery_blocked',
  );
  assert.equal(fs.existsSync(result.recoveryRoot), true);
});

test('partial cleanup action remains blocked and preserves its recovery workspace', (t) => {
  const timeout = new Error('spawnSync docker ETIMEDOUT');
  timeout.code = 'ETIMEDOUT';
  const result = runLauncherFault(t, {
    launcherOutcome: {
      status: null,
      signal: 'SIGTERM',
      error: timeout,
      stdout: '',
      stderr: '',
    },
    recoveryMode: 'partial',
  });
  assert.equal(result.receipt.ok, false);
  assert.ok(result.receipt.blockers.includes('os_sandbox_command_timed_out'));
  assert.equal(
    result.receipt.dockerWorkerContainerRecoveryReceipt.trigger,
    'launcher_timeout',
  );
  assert.equal(result.removalCount, 1);
  assert.ok(result.receipt.blockers.includes(
    'worker_container_recovery_unresolved',
  ));
  assert.equal(
    result.receipt.dockerWorkerContainerRecoveryReceipt.externalActionPerformed,
    true,
  );
  assert.equal(fs.existsSync(result.recoveryRoot), true);
});

test('ownership helpers reject invalid inputs and preserve exact Docker labels', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-worker-ownership-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(buildDockerWorkerContainerOwnershipForEnvironment({
    executionBackend: 'host',
  }), null);
  assert.throws(
    () => buildDockerWorkerContainerOwnership({}),
    /docker_worker_container_ownership_invalid/,
  );
  assert.throws(
    () => dockerWorkerContainerOwnershipArguments({}),
    /docker_worker_container_ownership_invalid/,
  );

  const ownership = buildDockerWorkerContainerOwnership({
    processInvocationId: `sha256:${'c'.repeat(64)}`,
    experimentRunId: 'campaign:node:attempt',
    experimentAttemptId: 'campaign:node:attempt:arm:treatment',
    containerIdPath: path.join(root, 'worker.cid'),
  });
  const args = dockerWorkerContainerOwnershipArguments(ownership);
  assert.deepEqual(args.slice(0, 4), [
    '--name', ownership.containerName,
    '--cidfile', ownership.containerIdPath,
  ]);
  assert.ok(args.includes(
    `io.hepta.worker.ownership-hash=${ownership.dockerWorkerContainerOwnershipHash}`,
  ));
});

test('recovery blocks invalid ownership and remote Docker endpoints without cleanup', (t) => {
  const invalid = recoverAbandonedDockerWorkerContainer({
    ownership: {},
    retryDelaysMs: [],
  });
  assert.equal(invalid.status, 'docker_worker_container_recovery_blocked');
  assert.deepEqual(invalid.blockers, ['worker_container_recovery_ownership_invalid']);
  assert.equal(verifyDockerWorkerContainerRecoveryReceipt(invalid), false);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-worker-remote-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ownership = buildDockerWorkerContainerOwnership({
    processInvocationId: `sha256:${'d'.repeat(64)}`,
    containerIdPath: path.join(root, 'worker.cid'),
  });
  let cleanupCalled = false;
  const remote = recoverAbandonedDockerWorkerContainer({
    ownership,
    environment: {
      DOCKER_HOST: 'tcp://docker.example.invalid:2376',
    },
    spawnSyncImpl() {
      cleanupCalled = true;
      return { status: 1, stdout: '', stderr: '' };
    },
  });
  assert.equal(cleanupCalled, false);
  assert.equal(remote.status, 'docker_worker_container_recovery_blocked');
  assert.deepEqual(remote.blockers, [
    'worker_container_recovery_remote_docker_endpoint_forbidden',
  ]);
  assert.equal(verifyDockerWorkerContainerRecoveryReceipt(remote), true);
  assert.equal(verifyDockerWorkerContainerRecoveryReceipt({
    ...remote,
    trigger: 'tampered',
  }), false);
});
