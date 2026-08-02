import fs from 'node:fs';
import path from 'node:path';

import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { writeDurableJsonSync } from '../runtime/durable-json-repository.mjs';
import { readRegularJsonFileSync } from '../runtime/pinned-file-reader.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const MAXIMUM_RECEIPT_BYTES = 4 * 1024 * 1024;
export const DYNAMIC_FORMAL_SANDBOX_PROBE_QUALIFICATION_MAXIMUM_AGE_MS =
  24 * 60 * 60 * 1_000;

const RECEIPT_KEYS = Object.freeze([
  'dynamicFormalProjectClosureReadiness',
  'dynamicFormalSandboxProbeQualificationReceiptHash',
  'expiresAt',
  'issuedAt',
  'kind',
  'runtimeRoot',
  'status',
  'version',
]);

function canonicalInstant(value) {
  const milliseconds = Date.parse(String(value || ''));
  return Number.isFinite(milliseconds)
    && new Date(milliseconds).toISOString() === value
    ? milliseconds : null;
}

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort())
      === JSON.stringify([...keys].sort());
}

function readinessHashValid(readiness) {
  if (!readiness || readiness.version !== 1
    || readiness.kind !== 'DynamicFormalProjectClosureReadiness'
    || readiness.status !== 'dynamic_formal_project_closure_ready'
    || readiness.ready !== true
    || readiness.executableProbeVerified !== true
    || readiness.postProbeReinspectionVerified !== true
    || readiness.blockers?.length !== 0
    || !SHA256.test(String(
      readiness.dynamicFormalProjectClosureReadinessHash || '',
    ))) return false;
  const {
    dynamicFormalProjectClosureReadinessHash: claimedHash,
    ...payload
  } = readiness;
  return hashRecord('DynamicFormalProjectClosureReadiness', payload)
    === claimedHash;
}

export function dynamicFormalSandboxProbeQualificationReceiptPath({
  runtimeRoot,
} = {}) {
  const selectedRuntimeRoot = path.resolve(String(runtimeRoot || ''));
  if (!runtimeRoot || !path.isAbsolute(selectedRuntimeRoot)) {
    throw new Error('dynamic_formal_sandbox_probe_runtime_root_required');
  }
  return path.join(
    selectedRuntimeRoot,
    'formal-readiness',
    'dynamic-formal-sandbox-probe-qualification.json',
  );
}

export function verifyDynamicFormalSandboxProbeQualificationReceipt(
  receipt,
  { runtimeRoot, now = new Date() } = {},
) {
  const selectedRuntimeRoot = path.resolve(String(runtimeRoot || ''));
  const inspectedAt = now instanceof Date ? now : new Date(now);
  if (!exactKeys(receipt, RECEIPT_KEYS)
    || receipt.version !== 1
    || receipt.kind !== 'DynamicFormalSandboxProbeQualificationReceipt'
    || receipt.status !== 'dynamic_formal_sandbox_probe_qualified'
    || receipt.runtimeRoot !== selectedRuntimeRoot
    || !Number.isFinite(inspectedAt.getTime())
    || !readinessHashValid(receipt.dynamicFormalProjectClosureReadiness)
    || !SHA256.test(String(
      receipt.dynamicFormalSandboxProbeQualificationReceiptHash || '',
    ))) return false;
  const issuedAt = canonicalInstant(receipt.issuedAt);
  const expiresAt = canonicalInstant(receipt.expiresAt);
  if (issuedAt === null || expiresAt === null
    || expiresAt <= issuedAt
    || inspectedAt.getTime() < issuedAt
    || inspectedAt.getTime() >= expiresAt) return false;
  const {
    dynamicFormalSandboxProbeQualificationReceiptHash: claimedHash,
    ...payload
  } = receipt;
  return hashRecord('DynamicFormalSandboxProbeQualificationReceipt', payload)
    === claimedHash;
}

export function createDynamicFormalSandboxProbeQualificationRepository({
  runtimeRoot,
  clock = { now: () => new Date() },
  maximumAgeMs =
    DYNAMIC_FORMAL_SANDBOX_PROBE_QUALIFICATION_MAXIMUM_AGE_MS,
} = {}) {
  const selectedRuntimeRoot = path.resolve(String(runtimeRoot || ''));
  const receiptPath = dynamicFormalSandboxProbeQualificationReceiptPath({
    runtimeRoot: selectedRuntimeRoot,
  });
  if (!Number.isSafeInteger(maximumAgeMs) || maximumAgeMs < 60_000
    || maximumAgeMs > 7 * 24 * 60 * 60 * 1_000) {
    throw new Error('dynamic_formal_sandbox_probe_maximum_age_invalid');
  }
  const observedAt = () => {
    const value = clock.now();
    const selected = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(selected.getTime())) {
      throw new Error('dynamic_formal_sandbox_probe_clock_invalid');
    }
    return selected;
  };
  return Object.freeze({
    version: 1,
    kind: 'DynamicFormalSandboxProbeQualificationRepository',
    receiptPath,
    inspect() {
      const now = observedAt();
      let receipt = null;
      const blockers = [];
      try {
        const stat = fs.lstatSync(receiptPath);
        if (!stat.isFile() || stat.isSymbolicLink()
          || fs.realpathSync.native(receiptPath) !== receiptPath
          || Number(stat.nlink) !== 1
          || (stat.mode & 0o022) !== 0
          || stat.size < 2 || stat.size > MAXIMUM_RECEIPT_BYTES) {
          throw new Error('receipt_file_invalid');
        }
        receipt = readRegularJsonFileSync(receiptPath);
      } catch { receipt = null; }
      if (!receipt) {
        blockers.push(
          'dynamic_formal_sandbox_probe_qualification_receipt_missing',
        );
      } else if (!verifyDynamicFormalSandboxProbeQualificationReceipt(
        receipt,
        { runtimeRoot: selectedRuntimeRoot, now },
      )) {
        blockers.push(
          'dynamic_formal_sandbox_probe_qualification_receipt_invalid_or_expired',
        );
      }
      return Object.freeze({
        version: 1,
        kind: 'DynamicFormalSandboxProbeQualificationInspection',
        status: blockers.length
          ? 'dynamic_formal_sandbox_probe_qualification_blocked'
          : 'dynamic_formal_sandbox_probe_qualification_ready',
        ready: blockers.length === 0,
        statusReadOnly: true,
        receiptPath,
        receipt: blockers.length ? null : receipt,
        inspectedAt: now.toISOString(),
        blockers: Object.freeze(blockers),
      });
    },
    publish(dynamicFormalProjectClosureReadiness) {
      if (!readinessHashValid(dynamicFormalProjectClosureReadiness)) {
        throw new Error(
          'dynamic_formal_sandbox_probe_qualification_readiness_invalid',
        );
      }
      const issuedAt = observedAt();
      const payload = Object.freeze({
        version: 1,
        kind: 'DynamicFormalSandboxProbeQualificationReceipt',
        status: 'dynamic_formal_sandbox_probe_qualified',
        runtimeRoot: selectedRuntimeRoot,
        issuedAt: issuedAt.toISOString(),
        expiresAt: new Date(
          issuedAt.getTime() + maximumAgeMs,
        ).toISOString(),
        dynamicFormalProjectClosureReadiness,
      });
      const receipt = Object.freeze({
        ...payload,
        dynamicFormalSandboxProbeQualificationReceiptHash: hashRecord(
          'DynamicFormalSandboxProbeQualificationReceipt',
          payload,
        ),
      });
      writeDurableJsonSync(receiptPath, receipt, { mode: 0o400 });
      return receipt;
    },
  });
}
