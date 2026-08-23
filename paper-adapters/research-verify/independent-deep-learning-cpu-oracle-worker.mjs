import dgram from 'node:dgram';
import dns from 'node:dns';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';

import {
  DEEP_LEARNING_CPU_ORACLE_NETWORK_ISOLATION_POLICY,
  buildDeepLearningCpuOracleWorkerImplementation,
  buildProcessIsolatedDeepLearningCpuOracleReceipt,
  verifyProcessIsolatedDeepLearningCpuOracleRequest,
} from '../../paper-domain/research/process-isolated-deep-learning-independent-cpu-oracle-contract.mjs';
import {
  replayDeepLearningCheckpoint,
} from './deep-learning-independent-replay.mjs';
import { hashBytes } from '../../workflow-kernel/record-hash.mjs';

const MAXIMUM_REQUEST_BYTES = 64 * 1024 * 1024;
const REQUEST_READ_CHUNK_BYTES = 64 * 1024;
const WORKER_PATH = fileURLToPath(import.meta.url);
const SOURCE_PATHS = Object.freeze([
  Object.freeze({
    role: 'worker-entry',
    path: WORKER_PATH,
  }),
  Object.freeze({
    role: 'process-contract',
    path: fileURLToPath(new URL(
      '../../paper-domain/research/process-isolated-deep-learning-independent-cpu-oracle-contract.mjs',
      import.meta.url,
    )),
  }),
  Object.freeze({
    role: 'replay-implementation',
    path: fileURLToPath(new URL(
      './deep-learning-independent-replay.mjs',
      import.meta.url,
    )),
  }),
  Object.freeze({
    role: 'execution-contract',
    path: fileURLToPath(new URL(
      '../../paper-domain/research/deep-learning-training-execution-contract.mjs',
      import.meta.url,
    )),
  }),
  Object.freeze({
    role: 'dataset-contract',
    path: fileURLToPath(new URL(
      '../../paper-domain/research/deep-learning-training-dataset-contract.mjs',
      import.meta.url,
    )),
  }),
]);

function isMain(moduleUrl) {
  return Boolean(process.argv[1])
    && path.resolve(process.argv[1]) === fileURLToPath(moduleUrl);
}

function replaceMethod(target, name, denied) {
  if (!target || typeof target[name] !== 'function') return;
  Object.defineProperty(target, name, {
    configurable: true,
    enumerable: true,
    value: denied,
    writable: true,
  });
}

/**
 * Install an in-process network guard before any request data is consumed.
 * The OS sandbox remains the production isolation boundary; this guard is a
 * second, observable fail-closed layer for accidental network use.
 */
export function installDeepLearningCpuOracleNetworkGuard() {
  const denied = () => {
    throw new Error('deep_learning_cpu_oracle_network_forbidden');
  };
  for (const [target, methods] of [
    [net, ['connect', 'createConnection', 'createServer']],
    [net.Socket?.prototype, ['connect']],
    [http, ['get', 'request', 'createServer']],
    [https, ['get', 'request', 'createServer']],
    [tls, ['connect', 'createServer']],
    [dgram, ['createSocket']],
    [dns, [
      'lookup', 'lookupService', 'resolve', 'resolve4', 'resolve6', 'resolveAny',
      'resolveCaa', 'resolveCname', 'resolveMx', 'resolveNaptr', 'resolveNs',
      'resolvePtr', 'resolveSoa', 'resolveSrv', 'resolveTxt', 'reverse',
    ]],
    [dns.promises, [
      'lookup', 'lookupService', 'resolve', 'resolve4', 'resolve6', 'resolveAny',
      'resolveCaa', 'resolveCname', 'resolveMx', 'resolveNaptr', 'resolveNs',
      'resolvePtr', 'resolveSoa', 'resolveSrv', 'resolveTxt', 'reverse',
    ]],
  ]) {
    for (const method of methods) replaceMethod(target, method, denied);
  }
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    value: denied,
    writable: true,
  });
  if ('WebSocket' in globalThis) {
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      value: denied,
      writable: true,
    });
  }
  syncBuiltinESMExports();
  return Object.freeze({
    installed: true,
    policy: DEEP_LEARNING_CPU_ORACLE_NETWORK_ISOLATION_POLICY,
  });
}

function readBoundedRequestBytes() {
  const chunks = [];
  let totalBytes = 0;
  while (totalBytes <= MAXIMUM_REQUEST_BYTES) {
    const remaining = (MAXIMUM_REQUEST_BYTES + 1) - totalBytes;
    const chunk = Buffer.allocUnsafe(Math.min(REQUEST_READ_CHUNK_BYTES, remaining));
    const bytesRead = fs.readSync(0, chunk, 0, chunk.length, null);
    if (bytesRead === 0) break;
    chunks.push(chunk.subarray(0, bytesRead));
    totalBytes += bytesRead;
  }
  return Buffer.concat(chunks, totalBytes);
}

export function currentDeepLearningCpuOracleWorkerImplementation({
  readSource = (sourcePath) => fs.readFileSync(sourcePath),
} = {}) {
  return buildDeepLearningCpuOracleWorkerImplementation({
    sourceRecords: SOURCE_PATHS.map(({ role, path: sourcePath }) => ({
      role,
      sha256: hashBytes(readSource(sourcePath)),
    })),
  });
}

export function runIndependentDeepLearningCpuOracleWorker({
  readRequestBytes = readBoundedRequestBytes,
  writeReceipt = (receipt) => process.stdout.write(`${JSON.stringify(receipt)}\n`),
  workerPid = process.pid,
  parentPid = process.ppid,
  installNetworkGuard = installDeepLearningCpuOracleNetworkGuard,
  readSource,
} = {}) {
  const blockers = [];
  let implementation = null;
  try {
    implementation = currentDeepLearningCpuOracleWorkerImplementation({ readSource });
  } catch (error) {
    blockers.push(String(error?.message || 'deep_learning_cpu_oracle_worker_implementation_failed'));
  }

  let networkGuardInstalled = false;
  try {
    const guard = installNetworkGuard();
    networkGuardInstalled = guard?.installed === true
      && guard?.policy === DEEP_LEARNING_CPU_ORACLE_NETWORK_ISOLATION_POLICY;
  } catch (error) {
    blockers.push(String(error?.message || 'deep_learning_cpu_oracle_network_guard_failed'));
  }

  let request = null;
  try {
    const bytes = readRequestBytes();
    if (!Buffer.isBuffer(bytes) || bytes.length < 2
      || bytes.length > MAXIMUM_REQUEST_BYTES) {
      throw new Error('deep_learning_cpu_oracle_request_size_invalid');
    }
    request = JSON.parse(bytes.toString('utf8'));
    if (!verifyProcessIsolatedDeepLearningCpuOracleRequest(request, {
      workerImplementation: implementation,
    })) {
      throw new Error('deep_learning_cpu_oracle_request_invalid');
    }
  } catch (error) {
    blockers.push(String(error?.message || 'deep_learning_cpu_oracle_request_invalid'));
  }

  let replayReceipt = null;
  if (!blockers.length) {
    try {
      replayReceipt = replayDeepLearningCheckpoint({
        executionReceipt: request.executionReceipt,
        trainingDataset: request.trainingDataset,
        tensorBundleBytes: Buffer.from(request.tensorBundleBase64, 'base64'),
        expectedPredictions: request.expectedPredictions,
        expectedMetrics: request.expectedMetrics,
        replayRuntimeIdentityHash: request.replayRuntimeIdentityHash,
        replayScope: request.replayScope,
      });
      if (replayReceipt.errorBudget
        && JSON.stringify(replayReceipt.errorBudget)
          !== JSON.stringify(request.errorBudget)) {
        blockers.push('deep_learning_cpu_oracle_error_budget_binding_invalid');
      }
    } catch (error) {
      blockers.push(String(error?.message || 'deep_learning_cpu_oracle_replay_failed'));
    }
  }

  const receipt = buildProcessIsolatedDeepLearningCpuOracleReceipt({
    request,
    replayReceipt,
    workerImplementation: implementation,
    workerPid,
    parentPid,
    networkGuardInstalled,
    blockers,
  });
  writeReceipt(receipt);
  return receipt;
}

if (isMain(import.meta.url)) {
  const receipt = runIndependentDeepLearningCpuOracleWorker();
  process.exitCode = receipt.blockers.length ? 2 : 0;
}
