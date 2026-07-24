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
  buildProcessIsolatedTypedNumericOracleWorkerReceipt,
  buildTypedNumericOracleWorkerImplementation,
  verifyProcessIsolatedTypedNumericOracleRequest,
} from '../../paper-domain/research/process-isolated-typed-numeric-oracle-recomputation-contract.mjs';
import {
  buildIndependentTypedNumericOracleRecomputation,
  INDEPENDENT_TYPED_NUMERIC_ORACLE_IMPLEMENTATION,
} from '../../paper-domain/research/independent-typed-numeric-oracle-recomputation.mjs';
import { hashBytes } from '../../workflow-kernel/record-hash.mjs';

const MAXIMUM_REQUEST_BYTES = 24 * 1024 * 1024;
const REQUEST_READ_CHUNK_BYTES = 64 * 1024;
const WORKER_PATH = fileURLToPath(import.meta.url);
const SOURCE_PATHS = Object.freeze({
  workerImplementationSourceHash: WORKER_PATH,
  recomputationImplementationSourceHash: fileURLToPath(new URL(
    '../../paper-domain/research/independent-typed-numeric-oracle-recomputation.mjs',
    import.meta.url,
  )),
  processContractSourceHash: fileURLToPath(new URL(
    '../../paper-domain/research/process-isolated-typed-numeric-oracle-recomputation-contract.mjs',
    import.meta.url,
  )),
  producerAlgorithmRegistrySourceHash: fileURLToPath(new URL(
    '../../paper-domain/research/typed-numeric-oracle-production.mjs',
    import.meta.url,
  )),
});

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

export function installTypedNumericOracleNetworkGuard() {
  const denied = () => {
    throw new Error('typed_numeric_oracle_worker_network_forbidden');
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
    policy: 'deny-node-network-client-and-server-apis-v1',
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

function workerImplementation(sourceBytes = (sourcePath) => fs.readFileSync(sourcePath)) {
  const sourceHashes = Object.fromEntries(Object.entries(SOURCE_PATHS).map(
    ([field, sourcePath]) => [field, hashBytes(sourceBytes(sourcePath))],
  ));
  return buildTypedNumericOracleWorkerImplementation({
    ...sourceHashes,
    independentAlgorithmImplementationHash:
      INDEPENDENT_TYPED_NUMERIC_ORACLE_IMPLEMENTATION
        .independentTypedNumericOracleImplementationHash,
  });
}

export function runIndependentTypedNumericOracleRecomputationWorker({
  readRequestBytes = readBoundedRequestBytes,
  writeReceipt = (receipt) => process.stdout.write(`${JSON.stringify(receipt)}\n`),
  workerPid = process.pid,
  parentPid = process.ppid,
  installNetworkGuard = installTypedNumericOracleNetworkGuard,
  sourceBytes,
} = {}) {
  const implementation = workerImplementation(sourceBytes);
  const blockers = [];
  let networkGuardInstalled = false;
  try {
    const guard = installNetworkGuard();
    networkGuardInstalled = guard?.installed === true
      && guard?.policy === 'deny-node-network-client-and-server-apis-v1';
  } catch (error) {
    blockers.push(String(error?.message || 'typed_numeric_oracle_network_guard_failed'));
  }

  let request = null;
  try {
    const bytes = readRequestBytes();
    if (!Buffer.isBuffer(bytes) || bytes.length < 2 || bytes.length > MAXIMUM_REQUEST_BYTES) {
      throw new Error('process_isolated_typed_numeric_request_size_invalid');
    }
    request = JSON.parse(bytes.toString('utf8'));
    if (!verifyProcessIsolatedTypedNumericOracleRequest(request)) {
      throw new Error('process_isolated_typed_numeric_request_invalid');
    }
  } catch (error) {
    blockers.push(String(error?.message || 'process_isolated_typed_numeric_request_invalid'));
  }

  let recomputation = null;
  if (!blockers.length) {
    try {
      recomputation = buildIndependentTypedNumericOracleRecomputation({
        production: request.production,
        observations: request.observations,
        analysisProtocol: request.analysisProtocol,
        pluginProfile: request.pluginProfile,
        experimentIr: request.experimentIr,
      });
      blockers.push(...recomputation.blockers);
    } catch (error) {
      blockers.push(String(error?.message || 'process_isolated_typed_numeric_recomputation_failed'));
    }
  }

  const receipt = buildProcessIsolatedTypedNumericOracleWorkerReceipt({
    request,
    recomputation,
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
  const receipt = runIndependentTypedNumericOracleRecomputationWorker();
  process.exitCode = receipt.blockers.length ? 2 : 0;
}
