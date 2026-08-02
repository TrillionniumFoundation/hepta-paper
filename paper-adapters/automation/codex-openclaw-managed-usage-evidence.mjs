import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

import {
  modelAttemptTraceHash,
} from './codex-openclaw-managed-runtime-common.mjs';
import {
  verifyOpenClawModelRuntimeProvenance,
} from './codex-openclaw-managed-configuration.mjs';
import {
  verifyOpenClawManagedFailureExecutionBinding,
} from './codex-openclaw-managed-failure-execution-binding.mjs';

const MANAGED_USAGE_KEYS = Object.freeze([
  'cacheRead', 'cacheWrite', 'input', 'output', 'totalTokens',
]);

function managedUsageMetric(usage, aliases, { required = true, fallback = null } = {}) {
  const values = aliases
    .filter((key) => Object.prototype.hasOwnProperty.call(usage, key)
      && usage[key] !== undefined)
    .map((key) => usage[key]);
  if (!values.length) return required ? null : fallback;
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0)
    || new Set(values).size !== 1) return null;
  return values[0];
}
function reportedManagedUsage(usage) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null;
  const input = managedUsageMetric(
    usage,
    ['input', 'inputTokens', 'input_tokens'],
  );
  const output = managedUsageMetric(
    usage,
    ['output', 'outputTokens', 'output_tokens'],
  );
  const cacheRead = managedUsageMetric(
    usage,
    ['cacheRead', 'cacheReadTokens', 'cache_read_tokens'],
    { required: false, fallback: 0 },
  );
  const cacheWrite = managedUsageMetric(
    usage,
    ['cacheWrite', 'cacheWriteTokens', 'cache_write_tokens'],
    { required: false, fallback: 0 },
  );
  const totalTokens = managedUsageMetric(
    usage,
    ['totalTokens', 'total_tokens', 'total'],
  );
  if ([input, output, cacheRead, cacheWrite, totalTokens].includes(null)
    || totalTokens === 0) return null;
  return Object.freeze({
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens,
    totalAliases: Object.freeze(
      ['totalTokens', 'total_tokens', 'total'].filter(
        (key) => Object.prototype.hasOwnProperty.call(usage, key)
          && usage[key] !== undefined,
      ),
    ),
  });
}

function canonicalManagedUsage(reported, inputSemantics) {
  if (!reported) return null;
  const cacheInclusive = inputSemantics === 'cache-inclusive';
  if (cacheInclusive
    && (reported.cacheWrite !== 0 || reported.cacheRead > reported.input)) {
    return null;
  }
  const input = cacheInclusive
    ? reported.input - reported.cacheRead : reported.input;
  const expectedTotal = input + reported.output
    + reported.cacheRead + reported.cacheWrite;
  if (!Number.isSafeInteger(expectedTotal)) return null;
  return Object.freeze({
    input,
    output: reported.output,
    cacheRead: reported.cacheRead,
    cacheWrite: reported.cacheWrite,
    totalTokens: expectedTotal,
  });
}

function exactManagedUsageProjection(reported) {
  if (!reported) return null;
  const cacheExclusive = canonicalManagedUsage(reported, 'cache-exclusive');
  if (cacheExclusive?.totalTokens === reported.totalTokens) {
    return Object.freeze({
      inputSemantics: 'cache-exclusive',
      usage: cacheExclusive,
    });
  }
  const cacheInclusive = canonicalManagedUsage(reported, 'cache-inclusive');
  if (reported?.cacheRead > 0
    && cacheInclusive?.totalTokens === reported.totalTokens) {
    return Object.freeze({
      inputSemantics: 'cache-inclusive',
      usage: cacheInclusive,
    });
  }
  return null;
}

export function normalizeManagedUsage(usage, { lastCallUsage = null } = {}) {
  const reported = reportedManagedUsage(usage);
  const exact = exactManagedUsageProjection(reported);
  const lastCallSupplied = lastCallUsage !== null && lastCallUsage !== undefined;
  const lastReported = lastCallSupplied
    ? reportedManagedUsage(lastCallUsage) : null;
  const lastProjection = exactManagedUsageProjection(lastReported);
  if (exact) {
    if (!lastCallSupplied) return exact.usage;
    if (!lastProjection
      || exact.inputSemantics !== lastProjection.inputSemantics
      || MANAGED_USAGE_KEYS.some(
        (key) => lastProjection.usage[key] > exact.usage[key],
      )) return null;
    return exact.usage;
  }

  // OpenClaw reports accumulated components, but after an internal retry its
  // `usage.total` is deliberately replaced with the final call's total. Only
  // accept that shape when a complete, internally consistent last-call usage
  // proves both the component semantics and the reported total provenance.
  const aggregate = canonicalManagedUsage(
    reported,
    lastProjection?.inputSemantics,
  );
  const cumulativeComponents = reported && [
    reported.input,
    reported.output,
    reported.cacheRead,
    reported.cacheWrite,
  ];
  const lastCallComponents = lastReported && [
    lastReported.input,
    lastReported.output,
    lastReported.cacheRead,
    lastReported.cacheWrite,
  ];
  if (JSON.stringify(reported?.totalAliases) !== JSON.stringify(['total'])
    || !lastProjection
    || !aggregate
    || reported.totalTokens !== lastReported.totalTokens
    || (reported.cacheRead > 0 && lastReported.cacheRead === 0)
    || cumulativeComponents.some((value, index) => (
      value < lastCallComponents[index]
    ))
    || MANAGED_USAGE_KEYS.some(
      (key) => lastProjection.usage[key] > aggregate[key],
    )
    || aggregate.totalTokens <= reported.totalTokens) return null;
  return aggregate;
}

export function validCanonicalManagedUsage(usage) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return false;
  const normalized = normalizeManagedUsage(usage);
  return Object.keys(usage).length === MANAGED_USAGE_KEYS.length
    && MANAGED_USAGE_KEYS.every((key) => Object.hasOwn(usage, key)
      && normalized?.[key] === usage[key]);
}

export function sameManagedUsage(left, right) {
  return validCanonicalManagedUsage(left) && validCanonicalManagedUsage(right)
    && MANAGED_USAGE_KEYS.every((key) => left[key] === right[key]);
}

export function validLegacyManagedUsage(usage) {
  if (usage === undefined) return true;
  if (usage === null || typeof usage !== 'object' || Array.isArray(usage)) {
    return usage === null;
  }
  const keys = Object.keys(usage).sort();
  return JSON.stringify(keys)
      === JSON.stringify(['cacheRead', 'cacheWrite', 'input', 'output', 'totalTokens'])
    && keys.every((key) => Number.isSafeInteger(usage[key]) && usage[key] >= 0)
    && usage.totalTokens >= usage.input
    && usage.totalTokens >= usage.output;
}

export function managedUsageHash(usage) {
  return hashRecord('OpenClawManagedCodexAppServerUsage', usage);
}

export function aggregateManagedUsage(usages) {
  if (!Array.isArray(usages) || !usages.length
    || usages.some((usage) => !validCanonicalManagedUsage(usage))) return null;
  const aggregate = Object.fromEntries(MANAGED_USAGE_KEYS.map((key) => [
    key,
    usages.reduce((total, usage) => total + usage[key], 0),
  ]));
  if (Object.values(aggregate).some((value) => !Number.isSafeInteger(value))
    || aggregate.totalTokens !== aggregate.input + aggregate.output
      + aggregate.cacheRead + aggregate.cacheWrite) return null;
  return Object.freeze(aggregate);
}

function managedAttemptUsageEntry(attempt) {
  const payload = {
    attemptNumber: attempt?.attemptNumber,
    attemptId: attempt?.attemptId,
    provider: attempt?.provider,
    model: attempt?.model,
    authProfileIdentityHash: attempt?.authProfileIdentityHash,
    usage: attempt?.usage,
    usageHash: attempt?.usageHash,
    toolCallsObserved: Number(attempt?.toolCallsObserved || 0),
    pendingToolCallCount: Number(attempt?.pendingToolCallCount || 0),
    externalDeliveryObserved: attempt?.externalDeliveryObserved === true,
  };
  return Object.freeze({
    ...payload,
    attemptUsageEntryHash: hashRecord(
      'OpenClawManagedCodexAppServerAttemptUsageEntry',
      payload,
    ),
  });
}

function validManagedAttemptUsageEntry(entry, index) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  const { attemptUsageEntryHash: claimedHash, ...payload } = entry;
  return Object.keys(entry).length === 11
    && entry.attemptNumber === index + 1
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      String(entry.attemptId || ''),
    )
    && entry.provider === 'openai'
    && typeof entry.model === 'string' && Boolean(entry.model)
    && /^sha256:[0-9a-f]{64}$/.test(String(entry.authProfileIdentityHash || ''))
    && validCanonicalManagedUsage(entry.usage)
    && entry.usageHash === hashRecord(
      'OpenClawManagedCodexAppServerAttemptUsage',
      { attemptId: entry.attemptId, usage: entry.usage },
    )
    && Number.isSafeInteger(entry.toolCallsObserved)
    && entry.toolCallsObserved >= 0
    && Number.isSafeInteger(entry.pendingToolCallCount)
    && entry.pendingToolCallCount >= 0
    && typeof entry.externalDeliveryObserved === 'boolean'
    && claimedHash === hashRecord(
      'OpenClawManagedCodexAppServerAttemptUsageEntry',
      payload,
    );
}

function managedIncompleteAttemptUsageEntry(attempt) {
  const usage = validCanonicalManagedUsage(attempt?.usage)
    ? attempt.usage : null;
  const payload = {
    attemptNumber: attempt?.attemptNumber,
    attemptId: attempt?.attemptId,
    provider: attempt?.provider,
    model: attempt?.model,
    authProfileIdentityHash: attempt?.authProfileIdentityHash,
    usageCompleteness: usage ? 'complete' : 'unknown_invalid',
    usage,
    usageHash: usage ? attempt?.usageHash : null,
    externalModelInvocationPerformed: true,
    toolCallsObserved: Number(attempt?.toolCallsObserved || 0),
    pendingToolCallCount: Number(attempt?.pendingToolCallCount || 0),
    externalDeliveryObserved: attempt?.externalDeliveryObserved === true,
  };
  return Object.freeze({
    ...payload,
    attemptUsageEntryHash: hashRecord(
      'OpenClawManagedCodexAppServerIncompleteAttemptUsageEntry',
      payload,
    ),
  });
}

function validManagedIncompleteAttemptUsageEntry(entry, index) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  const { attemptUsageEntryHash: claimedHash, ...payload } = entry;
  const complete = entry.usageCompleteness === 'complete';
  return Object.keys(entry).length === 13
    && entry.attemptNumber === index + 1
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      String(entry.attemptId || ''),
    )
    && entry.provider === 'openai'
    && typeof entry.model === 'string' && Boolean(entry.model)
    && /^sha256:[0-9a-f]{64}$/.test(String(entry.authProfileIdentityHash || ''))
    && ['complete', 'unknown_invalid'].includes(entry.usageCompleteness)
    && entry.externalModelInvocationPerformed === true
    && Number.isSafeInteger(entry.toolCallsObserved)
    && entry.toolCallsObserved >= 0
    && Number.isSafeInteger(entry.pendingToolCallCount)
    && entry.pendingToolCallCount >= 0
    && typeof entry.externalDeliveryObserved === 'boolean'
    && (complete
      ? validCanonicalManagedUsage(entry.usage)
        && entry.usageHash === hashRecord(
          'OpenClawManagedCodexAppServerAttemptUsage',
          { attemptId: entry.attemptId, usage: entry.usage },
        )
      : entry.usage === null && entry.usageHash === null)
    && claimedHash === hashRecord(
      'OpenClawManagedCodexAppServerIncompleteAttemptUsageEntry',
      payload,
    );
}

function managedFailureExternalEffectProjection(entries) {
  const deliveryObserved = entries.some(
    (entry) => entry.externalDeliveryObserved === true,
  );
  const toolCallObserved = entries.some(
    (entry) => entry.toolCallsObserved > 0,
  );
  const pendingToolObserved = entries.some(
    (entry) => entry.pendingToolCallCount > 0,
  );
  return Object.freeze({
    externalActionPerformed: deliveryObserved || toolCallObserved
      ? true : pendingToolObserved ? null : false,
    externalSideEffectPerformed: deliveryObserved
      ? true : toolCallObserved || pendingToolObserved ? null : false,
  });
}

export function buildOpenClawManagedFailureEvidence(error) {
  const failureCode = String(error?.code || error?.message || '').trim();
  const attempts = Array.isArray(error?.attemptTrace) ? error.attemptTrace : [];
  const entries = attempts.map(managedAttemptUsageEntry);
  const usage = aggregateManagedUsage(entries.map((entry) => entry.usage));
  const failureExecutionBinding =
    error?.openClawManagedFailureExecutionBinding || null;
  if (!/^codex_openclaw_managed_[a-z0-9_:-]{1,128}$/.test(failureCode)
    || !entries.length
    || !verifyOpenClawModelRuntimeProvenance(error?.runtimeProvenance)
    || (failureExecutionBinding
      && !verifyOpenClawManagedFailureExecutionBinding(
        failureExecutionBinding,
      ))
    || error?.attemptTraceHash !== modelAttemptTraceHash(attempts)) return null;
  const evidenceVersion = failureExecutionBinding ? 5 : 4;
  const executionBindingField = failureExecutionBinding
    ? { failureExecutionBinding } : {};
  if (!usage
    || entries.some((entry, index) => !validManagedAttemptUsageEntry(entry, index))) {
    const incompleteEntries = attempts.map(managedIncompleteAttemptUsageEntry);
    if (incompleteEntries.every(
      (entry) => entry.usageCompleteness === 'complete',
    ) || incompleteEntries.some(
      (entry, index) => !validManagedIncompleteAttemptUsageEntry(entry, index),
    )) return null;
    const knownEntries = incompleteEntries.filter(
      (entry) => entry.usageCompleteness === 'complete',
    );
    const knownUsage = knownEntries.length
      ? aggregateManagedUsage(knownEntries.map((entry) => entry.usage)) : null;
    const externalEffects = managedFailureExternalEffectProjection(
      incompleteEntries,
    );
    const incompletePayload = {
      version: evidenceVersion,
      kind: 'OpenClawManagedCodexFailureUsageEvidence',
      status: 'openclaw_managed_codex_execution_failed',
      failureCode,
      openClawManagedRuntimeProvenance: error.runtimeProvenance,
      modelAttemptCount: incompleteEntries.length,
      attemptTrace: Object.freeze([...attempts]),
      attemptTraceHash: error.attemptTraceHash,
      attemptUsageEntries: Object.freeze(incompleteEntries),
      attemptUsageEntriesHash: hashRecord(
        'OpenClawManagedCodexAppServerIncompleteAttemptUsageEntries',
        { entries: incompleteEntries },
      ),
      usageComplete: false,
      usage: knownUsage,
      usageHash: knownUsage ? managedUsageHash(knownUsage) : null,
      failureDisposition: 'permanent',
      externalModelInvocationPerformed: true,
      ...externalEffects,
      ...executionBindingField,
    };
    return Object.freeze({
      ...incompletePayload,
      openClawManagedCodexFailureUsageEvidenceHash: hashRecord(
        'OpenClawManagedCodexFailureUsageEvidence',
        incompletePayload,
      ),
    });
  }
  const externalEffects = managedFailureExternalEffectProjection(entries);
  const payload = {
    version: evidenceVersion,
    kind: 'OpenClawManagedCodexFailureUsageEvidence',
    status: 'openclaw_managed_codex_execution_failed',
    failureCode,
    openClawManagedRuntimeProvenance: error.runtimeProvenance,
    modelAttemptCount: entries.length,
    attemptTrace: Object.freeze([...attempts]),
    attemptTraceHash: error.attemptTraceHash,
    attemptUsageEntries: Object.freeze(entries),
    attemptUsageEntriesHash: hashRecord(
      'OpenClawManagedCodexAppServerAttemptUsageEntries',
      { entries },
    ),
    usage,
    usageHash: managedUsageHash(usage),
    usageComplete: true,
    failureDisposition: error?.retryable === true ? 'retryable' : 'permanent',
    externalModelInvocationPerformed: true,
    ...externalEffects,
    ...executionBindingField,
  };
  return Object.freeze({
    ...payload,
    openClawManagedCodexFailureUsageEvidenceHash: hashRecord(
      'OpenClawManagedCodexFailureUsageEvidence',
      payload,
    ),
  });
}

export function verifyOpenClawManagedFailureEvidence(evidence, {
  failureCode,
  model,
  expectedAuthProfileIdentityHash,
  expectedRuntimeProvenanceHash,
  expectedFailureExecutionBinding = null,
  allowLegacyAudit = false,
} = {}) {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return false;
  const {
    openClawManagedCodexFailureUsageEvidenceHash: claimedHash,
    ...payload
  } = evidence;
  const entries = payload.attemptUsageEntries;
  if (!/^sha256:[0-9a-f]{64}$/.test(
    String(expectedRuntimeProvenanceHash || ''),
  ) || !verifyOpenClawModelRuntimeProvenance(
    payload.openClawManagedRuntimeProvenance,
    { expectedProvenanceHash: expectedRuntimeProvenanceHash },
  )) return false;
  const currentExecutionEvidence = payload.version === 5
    && expectedFailureExecutionBinding !== null
    && typeof expectedFailureExecutionBinding === 'object'
    && !Array.isArray(expectedFailureExecutionBinding)
    && verifyOpenClawManagedFailureExecutionBinding(
      payload.failureExecutionBinding,
      { expected: expectedFailureExecutionBinding },
    );
  const legacyAuditEvidence = allowLegacyAudit === true
    && [1, 4].includes(payload.version)
    && !Object.hasOwn(payload, 'failureExecutionBinding');
  if (!currentExecutionEvidence && !legacyAuditEvidence) return false;
  if ([4, 5].includes(payload.version) && payload.usageComplete === false) {
    const attemptTrace = payload.attemptTrace;
    const projectedEntries = Array.isArray(attemptTrace)
      ? attemptTrace.map(managedIncompleteAttemptUsageEntry) : null;
    const knownEntries = Array.isArray(entries) ? entries.filter(
      (entry) => entry?.usageCompleteness === 'complete',
    ) : [];
    const usage = knownEntries.length
      ? aggregateManagedUsage(knownEntries.map((entry) => entry?.usage)) : null;
    const externalEffects = Array.isArray(entries)
      ? managedFailureExternalEffectProjection(entries) : null;
    return Boolean(
      Object.keys(evidence).length === (payload.version === 5 ? 19 : 18)
      && payload.kind === 'OpenClawManagedCodexFailureUsageEvidence'
      && payload.status === 'openclaw_managed_codex_execution_failed'
      && payload.failureCode === failureCode
      && Array.isArray(entries) && entries.length > 0
      && payload.modelAttemptCount === entries.length
      && Array.isArray(attemptTrace)
      && attemptTrace.length === entries.length
      && payload.attemptTraceHash === modelAttemptTraceHash(attemptTrace)
      && JSON.stringify(projectedEntries) === JSON.stringify(entries)
      && entries.some((entry) => entry.usageCompleteness === 'unknown_invalid')
      && entries.every((entry, index) => (
        validManagedIncompleteAttemptUsageEntry(entry, index)
        && entry.model === model
        && entry.authProfileIdentityHash === expectedAuthProfileIdentityHash
      ))
      && payload.attemptUsageEntriesHash === hashRecord(
        'OpenClawManagedCodexAppServerIncompleteAttemptUsageEntries',
        { entries },
      )
      && payload.usageComplete === false
      && payload.failureDisposition === 'permanent'
      && payload.externalModelInvocationPerformed === true
      && payload.externalActionPerformed
        === externalEffects?.externalActionPerformed
      && payload.externalSideEffectPerformed
        === externalEffects?.externalSideEffectPerformed
      && (usage
        ? sameManagedUsage(payload.usage, usage)
          && payload.usageHash === managedUsageHash(usage)
        : payload.usage === null && payload.usageHash === null)
      && claimedHash === hashRecord(
        'OpenClawManagedCodexFailureUsageEvidence',
        payload,
      )
    );
  }
  if ([4, 5].includes(payload.version) && payload.usageComplete === true) {
    const attemptTrace = payload.attemptTrace;
    const projectedEntries = Array.isArray(attemptTrace)
      ? attemptTrace.map(managedAttemptUsageEntry) : null;
    const usage = Array.isArray(entries)
      ? aggregateManagedUsage(entries.map((entry) => entry?.usage)) : null;
    const externalEffects = Array.isArray(entries)
      ? managedFailureExternalEffectProjection(entries) : null;
    return Boolean(
      Object.keys(evidence).length === (payload.version === 5 ? 19 : 18)
      && payload.kind === 'OpenClawManagedCodexFailureUsageEvidence'
      && payload.status === 'openclaw_managed_codex_execution_failed'
      && payload.failureCode === failureCode
      && Array.isArray(entries) && entries.length > 0
      && payload.modelAttemptCount === entries.length
      && Array.isArray(attemptTrace)
      && attemptTrace.length === entries.length
      && payload.attemptTraceHash === modelAttemptTraceHash(attemptTrace)
      && JSON.stringify(projectedEntries) === JSON.stringify(entries)
      && entries.every((entry, index) => validManagedAttemptUsageEntry(entry, index)
        && entry.model === model
        && entry.authProfileIdentityHash === expectedAuthProfileIdentityHash)
      && payload.attemptUsageEntriesHash === hashRecord(
        'OpenClawManagedCodexAppServerAttemptUsageEntries',
        { entries },
      )
      && usage
      && sameManagedUsage(payload.usage, usage)
      && payload.usageHash === managedUsageHash(usage)
      && payload.usageComplete === true
      && ['retryable', 'permanent'].includes(payload.failureDisposition)
      && payload.externalModelInvocationPerformed === true
      && payload.externalActionPerformed
        === externalEffects?.externalActionPerformed
      && payload.externalSideEffectPerformed
        === externalEffects?.externalSideEffectPerformed
      && claimedHash === hashRecord(
        'OpenClawManagedCodexFailureUsageEvidence',
        payload,
      )
    );
  }
  const usage = Array.isArray(entries)
    ? aggregateManagedUsage(entries.map((entry) => entry?.usage)) : null;
  return Boolean(
    Object.keys(evidence).length === 11
    && payload.version === 1
    && payload.kind === 'OpenClawManagedCodexFailureUsageEvidence'
    && payload.status === 'openclaw_managed_codex_execution_failed'
    && payload.failureCode === failureCode
    && Array.isArray(entries) && entries.length > 0
    && payload.modelAttemptCount === entries.length
    && /^sha256:[0-9a-f]{64}$/.test(String(payload.attemptTraceHash || ''))
    && entries.every((entry, index) => validManagedAttemptUsageEntry(entry, index)
      && entry.model === model
      && entry.authProfileIdentityHash === expectedAuthProfileIdentityHash)
    && payload.attemptUsageEntriesHash === hashRecord(
      'OpenClawManagedCodexAppServerAttemptUsageEntries',
      { entries },
    )
    && usage
    && sameManagedUsage(payload.usage, usage)
    && payload.usageHash === managedUsageHash(usage)
    && claimedHash === hashRecord(
      'OpenClawManagedCodexFailureUsageEvidence',
      payload,
    )
  );
}
