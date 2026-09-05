import { addAbortListener as subscribeAbort } from 'node:events';
import {
  campaignEmpiricalNodeClassification,
  isCampaignAgentNode,
} from './campaign-node-kind-policy.mjs';
import {
  GPU_SCIENTIFIC_CAMPAIGN_RESOURCE_BUDGET,
  gpuScientificCampaignNodeBinding,
} from '../../paper-domain/automation/gpu-scientific-campaign-execution-contract.mjs';

const DEFAULTS = Object.freeze({ agent: 4, cpu: 4, gpu: 1, memoryMiB: 8192 });

const DIMENSIONS = Object.freeze(Object.keys(DEFAULTS));
// Fairness barriers require independent workloads; legacy nested calls retain first-fit.
const POLICY_DEFAULTS = Object.freeze({ maximumWaitingRequests: 1024, maximumConflictingBypasses: null });
const abortedGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get;
const reasonGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'reason').get;

function failure(code) {
  return Object.assign(new Error(code), { code });
}

// Do not coerce numbers, execute property getters, or silently drop dimensions.
function recordValues(record, allowed, code) {
  if (record === null || typeof record !== 'object'
    || ![Object.prototype, null].includes(Object.getPrototypeOf(record))) throw failure(code);
  const keys = Reflect.ownKeys(record);
  if (keys.length > allowed.length || keys.some((key) => !allowed.includes(key))) throw failure(code);
  const descriptors = Object.getOwnPropertyDescriptors(record);
  const values = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) throw failure(code);
    values[key] = descriptor.value;
  }
  return values;
}

function normalize(request = {}, defaults = { agent: 0, cpu: 0, gpu: 0, memoryMiB: 0 }) {
  const values = recordValues(request, DIMENSIONS, 'resource_vector_invalid');
  const normalized = {};
  for (const key of DIMENSIONS) {
    const value = Object.hasOwn(values, key) ? values[key] : defaults[key];
    if (!Number.isSafeInteger(value) || value < 0) throw failure(`resource_value_invalid:${key}`);
    normalized[key] = value === 0 ? 0 : value;
  }
  return normalized;
}

function admissionPolicy(options) {
  const values = recordValues(options, Object.keys(POLICY_DEFAULTS), 'resource_admission_policy_invalid');
  const policy = { ...POLICY_DEFAULTS, ...values };
  if (!Number.isSafeInteger(policy.maximumWaitingRequests) || policy.maximumWaitingRequests < 1
    || policy.maximumWaitingRequests > 4096
    || (policy.maximumConflictingBypasses !== null && (!Number.isSafeInteger(policy.maximumConflictingBypasses)
      || policy.maximumConflictingBypasses < 0 || policy.maximumConflictingBypasses > 1024))) {
    throw failure('resource_admission_policy_invalid');
  }
  return Object.freeze(policy);
}

function aborted(signal) {
  if (signal === null) return false;
  try { return abortedGetter.call(signal); }
  catch { throw failure('resource_abort_signal_invalid'); }
}

function abortFailure(signal) {
  const reason = reasonGetter.call(signal);
  const detail = typeof reason === 'string' ? reason.slice(0, 256) : 'aborted';
  return Object.assign(new Error(`resource_acquire_aborted:${detail}`),
    { name: 'AbortError', code: 'resource_acquire_aborted' });
}

export function resourcesForCampaignNode(campaign, node) {
  if (node.kind === 'gpu-scientific-execution') {
    if (gpuScientificCampaignNodeBinding(node).resourceBudgetHash
      !== GPU_SCIENTIFIC_CAMPAIGN_RESOURCE_BUDGET
        .gpuScientificCampaignResourceBudgetHash) {
      throw new Error('gpu_scientific_campaign_resource_budget_binding_invalid');
    }
    return normalize(GPU_SCIENTIFIC_CAMPAIGN_RESOURCE_BUDGET.nodeReservation);
  }
  const classification = campaignEmpiricalNodeClassification(node.kind);
  const agent = isCampaignAgentNode(node.kind);
  const empirical = classification.empirical || ['advanced-numerical-analysis', 'gpu-scientific-execution', 'formal-verify', 'package', 'revalidate-citations', 'revalidate-artifacts'].includes(node.kind);
  const gpuExecution = classification.primary || classification.reproduction
    || classification.revalidate || ['advanced-numerical-analysis', 'gpu-scientific-execution'].includes(node.kind);
  const gpu = gpuExecution && Boolean(node.spec?.requiresGpu || node.requiresGpu || campaign?.spec?.requiresGpu);
  const workerMemoryBytes = campaign?.spec?.workerMemoryBytes === undefined
    ? 4 * 1024 * 1024 * 1024 : campaign.spec.workerMemoryBytes;
  if (empirical && (!Number.isSafeInteger(workerMemoryBytes) || workerMemoryBytes <= 0)) {
    throw failure('resource_worker_memory_bytes_invalid');
  }
  const empiricalMemoryMiB = empirical ? Math.ceil(workerMemoryBytes / (1024 * 1024)) : 0;
  return normalize({ agent: agent ? 1 : 0, cpu: empirical ? 1 : 0, gpu: gpu ? 1 : 0, memoryMiB: agent ? 2048 : empirical ? empiricalMemoryMiB : 128 });
}

export function createResourceGovernor(limits = {}, options = {}) {
  const maximum = Object.freeze(normalize(limits, DEFAULTS));
  const policy = admissionPolicy(options);
  const used = normalize();
  const peak = normalize();
  const queue = [];
  // Subtraction prevents overflow before comparison, even at MAX_SAFE_INTEGER.
  const fits = (request) => DIMENSIONS.every((key) => request[key] <= maximum[key] - used[key]);
  const conflicts = (left, right) => DIMENSIONS.some((key) => left[key] > 0 && right[key] > 0);
  const detach = (waiter) => {
    // Disposable unsubscription must run on grant and cancellation alike.
    waiter.abortSubscription?.[Symbol.dispose]();
    waiter.abortSubscription = null;
  };
  const drain = () => {
    const blocked = [];
    for (let index = 0; index < queue.length;) {
      const waiter = queue[index];
      if (aborted(waiter.signal)) {
        queue.splice(index, 1);
        detach(waiter);
        waiter.reject(abortFailure(waiter.signal));
        continue;
      }
      const heldBack = policy.maximumConflictingBypasses !== null && blocked.some((older) => older.bypasses >= policy.maximumConflictingBypasses
        && conflicts(older.request, waiter.request));
      if (!fits(waiter.request) || heldBack) {
        blocked.push(waiter);
        index += 1;
        continue;
      }
      queue.splice(index, 1);
      detach(waiter);
      for (const older of blocked) {
        if (policy.maximumConflictingBypasses !== null && conflicts(older.request, waiter.request)) {
          older.bypasses = Math.min(policy.maximumConflictingBypasses, older.bypasses + 1);
        }
      }
      for (const key of DIMENSIONS) {
        used[key] += waiter.request[key];
        peak[key] = Math.max(peak[key], used[key]);
      }
      let released = false;
      waiter.resolve(() => {
        // A retained release handle cannot refund a newer holder's allocation.
        if (released) return;
        released = true;
        for (const key of DIMENSIONS) used[key] -= waiter.request[key];
        drain();
      });
    }
  };
  const governor = Object.freeze({
    version: 1,
    kind: 'GlobalResourceGovernor',
    limits: maximum,
    admissionPolicy: policy,
    snapshot: () => Object.freeze({ limits: Object.freeze({ ...maximum }),
      used: Object.freeze({ ...used }), peak: Object.freeze({ ...peak }), waiting: queue.length }),
    acquireEnvelope(definition, options = {}) {
      return acquireResourceEnvelope(governor, definition, options);
    },
    acquire(request = {}, { signal = null } = {}) {
      const normalized = normalize(request);
      for (const key of DIMENSIONS) {
        if (normalized[key] > maximum[key]) throw failure(`resource_request_exceeds_limit:${key}`);
      }
      if (aborted(signal)) return Promise.reject(abortFailure(signal));
      if (queue.length >= policy.maximumWaitingRequests) {
        return Promise.reject(failure('resource_wait_queue_full'));
      }
      return new Promise((resolve, reject) => {
        const waiter = { request: normalized, resolve, reject, signal, abort: null,
          abortSubscription: null, bypasses: 0 };
        waiter.abort = () => {
          const index = queue.indexOf(waiter);
          if (index < 0) return; // Granted work remains charged until explicit release.
          queue.splice(index, 1);
          detach(waiter);
          reject(abortFailure(signal));
          drain(); // Removing a fairness barrier may unblock eligible followers.
        };
        // Native abort listeners can stop propagation; this Node subscription
        // preserves cancellation even when an earlier listener does so.
        if (signal) waiter.abortSubscription = subscribeAbort(signal, waiter.abort);
        queue.push(waiter);
        drain();
      });
    },
  });
  return governor;
}

// A root reservation includes retained parent resources AND a dedicated pool
// for independent child operations. Children never enter the root wait queue.
// This is an opt-in in-process API, not durable leases or OS enforcement.
async function acquireResourceEnvelope(governor, definition, options) {
  const declared = recordValues(definition, ['retained', 'childCapacity'],
    'resource_envelope_definition_invalid');
  if (!Object.hasOwn(declared, 'retained') || !Object.hasOwn(declared, 'childCapacity')
    || declared.retained === undefined || declared.childCapacity === undefined) {
    throw failure('resource_envelope_definition_invalid');
  }
  const retained = Object.freeze(normalize(declared.retained));
  const childCapacity = Object.freeze(normalize(declared.childCapacity));
  const selected = recordValues(options,
    ['signal', 'maximumChildren', 'maximumWaitingRequests'], 'resource_envelope_options_invalid');
  const signal = Object.hasOwn(selected, 'signal') ? selected.signal : null;
  const maximumChildren = Object.hasOwn(selected, 'maximumChildren') ? selected.maximumChildren : 1024;
  const maximumWaitingRequests = Object.hasOwn(selected, 'maximumWaitingRequests')
    ? selected.maximumWaitingRequests : 1024;
  if (!Number.isSafeInteger(maximumChildren) || maximumChildren < 1 || maximumChildren > 4096) {
    throw failure('resource_envelope_child_limit_invalid');
  }
  if (aborted(signal)) throw abortFailure(signal);
  const envelope = {};
  for (const key of DIMENSIONS) {
    if (retained[key] > Number.MAX_SAFE_INTEGER - childCapacity[key]) {
      throw failure(`resource_envelope_overflow:${key}`);
    }
    envelope[key] = retained[key] + childCapacity[key];
  }
  if (!DIMENSIONS.some((key) => envelope[key] > 0)) throw failure('resource_envelope_empty');
  Object.freeze(envelope);
  // Explicit zeroes prevent the child's absent dimensions inheriting defaults.
  // Child operations must be leaves/independent; local first-fit is deliberate.
  const children = createResourceGovernor(childCapacity, { maximumWaitingRequests });
  const releaseRoot = await governor.acquire(envelope, { signal });
  // An abort between the root grant and handoff cannot expose a cancelled owner.
  if (aborted(signal)) { releaseRoot(); throw abortFailure(signal); }
  let phase = 'open';
  let ownerFinished = false;
  let activeChildren = 0;
  let ownerSubscription = null;
  const pending = new Set();
  const detachOwner = () => {
    ownerSubscription?.[Symbol.dispose]();
    ownerSubscription = null;
  };
  const snapshot = () => Object.freeze({
    version: 1, kind: 'ResourceEnvelopeV1', phase, retained, childCapacity,
    envelope, maximumChildren, activeChildren, pendingChildren: pending.size,
    ownerFinished, rootChargeRetained: phase !== 'released', children: children.snapshot(),
  });
  const settle = () => {
    if (!ownerFinished || activeChildren !== 0 || pending.size !== 0 || phase === 'released') return;
    releaseRoot();
    phase = 'released';
    detachOwner();
  };
  const seal = () => {
    if (phase === 'released') return snapshot();
    phase = ownerFinished ? 'closing' : 'sealed';
    detachOwner();
    for (const waiter of pending) waiter.controller.abort('resource_envelope_sealed');
    settle();
    return snapshot();
  };
  const childGovernor = Object.freeze({
    version: 1, kind: 'ResourceEnvelopeChildGovernor', limits: childCapacity,
    admissionPolicy: children.admissionPolicy, snapshot: children.snapshot,
    async acquire(request = {}, { signal: childSignal = null } = {}) {
      const vector = normalize(request);
      if (phase !== 'open') throw failure('resource_envelope_not_open');
      if (aborted(childSignal)) throw abortFailure(childSignal);
      if (activeChildren + pending.size >= maximumChildren) {
        throw failure('resource_envelope_child_limit');
      }
      const waiter = { controller: new AbortController() };
      let subscription = null;
      let releaseLocal = null;
      pending.add(waiter);
      try {
        if (childSignal) subscription = subscribeAbort(childSignal,
          () => waiter.controller.abort('resource_child_cancelled'));
        releaseLocal = await children.acquire(vector, { signal: waiter.controller.signal });
        if (phase !== 'open' || aborted(waiter.controller.signal)) {
          throw failure('resource_envelope_handoff_cancelled');
        }
        activeChildren += 1;
        const ownedRelease = releaseLocal;
        releaseLocal = null;
        let released = false;
        return () => {
          if (released) return;
          released = true;
          ownedRelease();
          activeChildren -= 1;
          settle();
        };
      } finally {
        releaseLocal?.();
        subscription?.[Symbol.dispose]();
        pending.delete(waiter);
        settle();
      }
    },
  });
  try {
    if (signal) ownerSubscription = subscribeAbort(signal, seal);
  } catch {
    // Construction failed before owner handoff; no retained work was started.
    ownerFinished = true;
    seal();
    throw failure('resource_envelope_subscription_failed');
  }
  return Object.freeze({
    version: 1, kind: 'ResourceEnvelopeOwner', childGovernor, snapshot, seal,
    close() {
      // This explicit call declares that retained parent work is reconciled.
      // Abort alone MUST NOT make that declaration or refund any active work.
      ownerFinished = true;
      return seal();
    },
  });
}
