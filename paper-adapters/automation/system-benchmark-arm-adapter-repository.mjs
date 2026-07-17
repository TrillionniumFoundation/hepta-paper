import path from 'node:path';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { readScopedFileSync } from '../../workflow-kernel/runtime/scoped-file-identity.mjs';
import { armProtocolFor, verifySystemBenchmarkArmAdapterSet } from '../../paper-domain/automation/system-benchmark-arm-protocol.mjs';

const ARMS = Object.freeze(['treatment', 'baseline', 'ablation']);

function relativeArmEntrypoint(entrypoint, arm) {
  const normalized = String(entrypoint || '').split(path.sep).join('/');
  const extension = path.posix.extname(normalized);
  const base = extension ? normalized.slice(0, -extension.length) : normalized;
  return `${base}.${arm}${extension}`;
}

export function resolveSystemBenchmarkArmAdapterSet({ sourceRoot, entrypoint, protocolSet } = {}) {
  const root = path.resolve(sourceRoot || '.');
  const blockers = [];
  const adapters = [];
  for (const arm of ARMS) {
    const protocol = armProtocolFor(protocolSet, arm);
    const relativePath = relativeArmEntrypoint(entrypoint, arm);
    const read = readScopedFileSync({ scopeRoot: root, candidate: path.resolve(root, relativePath), maximumBytes: 4 * 1024 * 1024 });
    if (!protocol) blockers.push(`benchmark_arm_protocol_missing:${arm}`);
    if (read.status !== 'scoped_file_read_verified') {
      blockers.push(`benchmark_arm_adapter_unavailable:${arm}:${read.blockers.join(',') || 'unreadable'}`);
      continue;
    }
    adapters.push(Object.freeze({
      version: 1,
      kind: 'SystemBenchmarkArmAdapterIdentity',
      arm,
      relativePath,
      sourceHash: read.hash,
      systemBenchmarkArmProtocolHash: protocol.systemBenchmarkArmProtocolHash,
      sourceReadReceiptHash: read.scopedFileReadReceiptHash,
    }));
  }
  const payload = {
    version: 1,
    kind: 'SystemBenchmarkArmAdapterSet',
    entrypointConvention: 'sibling-arm-entrypoints-v1',
    adapters,
  };
  const adapterSet = Object.freeze({ ...payload, systemBenchmarkArmAdapterSetHash: hashRecord('SystemBenchmarkArmAdapterSet', payload) });
  if (!verifySystemBenchmarkArmAdapterSet(adapterSet, protocolSet)) blockers.push('benchmark_arm_adapter_set_invalid_or_not_distinct');
  return Object.freeze({
    status: blockers.length ? 'system_benchmark_arm_adapters_blocked' : 'system_benchmark_arm_adapters_verified',
    blockers: [...new Set(blockers)],
    adapterSet,
  });
}
