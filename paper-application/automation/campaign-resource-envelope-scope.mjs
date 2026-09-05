import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

function failure(code) {
  return Object.assign(new Error(code), { code, retryable: false });
}

// Trusted composition input only; campaign/node payloads cannot enable this mode.
export function normalizeCampaignResourceEnvelopePolicy(value = null) {
  if (value === null) return null;
  const fields = ['version', 'nodeKinds', 'childAgentSlots', 'maximumChildren', 'maximumWaitingRequests'];
  if (!value || typeof value !== 'object'
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw failure('campaign_resource_envelope_policy_invalid');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => !fields.includes(key)
    || !Object.hasOwn(descriptors[key], 'value') || !descriptors[key].enumerable)) {
    throw failure('campaign_resource_envelope_policy_invalid');
  }
  const data = Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
  if (data.version !== 1 || !Array.isArray(data.nodeKinds)
    || data.nodeKinds.length < 1 || data.nodeKinds.length > 64) {
    throw failure('campaign_resource_envelope_policy_invalid');
  }
  const kindDescriptors = Object.getOwnPropertyDescriptors(data.nodeKinds);
  if (Reflect.ownKeys(kindDescriptors).length !== data.nodeKinds.length + 1) {
    throw failure('campaign_resource_envelope_policy_invalid');
  }
  const nodeKinds = [];
  for (let index = 0; index < data.nodeKinds.length; index += 1) {
    const entry = kindDescriptors[index];
    if (!entry || !Object.hasOwn(entry, 'value') || !entry.enumerable
      || typeof entry.value !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(entry.value)) {
      throw failure('campaign_resource_envelope_policy_invalid');
    }
    nodeKinds.push(entry.value);
  }
  if (new Set(nodeKinds).size !== nodeKinds.length
    || !Number.isSafeInteger(data.childAgentSlots) || data.childAgentSlots < 1
    || data.childAgentSlots > 64) throw failure('campaign_resource_envelope_policy_invalid');
  for (const key of ['maximumChildren', 'maximumWaitingRequests']) {
    if (!Object.hasOwn(data, key)) data[key] = 1024;
    if (!Number.isSafeInteger(data[key]) || data[key] < 1 || data[key] > 4096) {
      throw failure('campaign_resource_envelope_policy_invalid');
    }
  }
  const body = Object.freeze({ version: 1, nodeKinds: Object.freeze(nodeKinds.sort()),
    childAgentSlots: data.childAgentSlots, maximumChildren: data.maximumChildren,
    maximumWaitingRequests: data.maximumWaitingRequests });
  return Object.freeze({ ...body, policyHash: hashRecord('CampaignResourceEnvelopePolicyV1', body) });
}

export function assertCampaignResourceEnvelopeSupport(policy, governor) {
  if (policy !== null && typeof governor?.acquireEnvelope !== 'function') {
    throw failure('campaign_resource_envelope_governor_unsupported');
  }
}

// The caller has not started parent execution while these two pools are acquired.
export async function acquireCampaignResourceEnvelopeScope({
  policy, node, requestedResources, governor, localGovernor, signal,
}) {
  if (policy === null || node.preparedResultHash || !policy.nodeKinds.includes(node.kind)) return null;
  const declaration = { retained: requestedResources,
    childCapacity: { agent: policy.childAgentSlots, cpu: 0, gpu: 0, memoryMiB: 0 } };
  const options = { signal, maximumChildren: policy.maximumChildren,
    maximumWaitingRequests: policy.maximumWaitingRequests };
  const globalOwner = await governor.acquireEnvelope(declaration, options);
  let localOwner;
  try {
    localOwner = await localGovernor.acquireEnvelope(declaration, options);
    if (signal.aborted) throw failure('resource_acquire_aborted');
  } catch (error) {
    try { localOwner?.close(); } finally { globalOwner.close(); }
    throw error;
  }
  let accepting = true;
  let firstFailure = null;
  let joining = null;
  const pending = new Set();
  const observe = (operation) => {
    // Observe rejection immediately; ignored returned Promises cannot hide a
    // failed child, trigger a process-level unhandled rejection, or pass commit.
    pending.add(operation);
    operation.then(() => pending.delete(operation), (error) => {
      if (firstFailure === null) firstFailure = { error };
      pending.delete(operation);
    });
    return operation;
  };
  const reject = (code) => {
    const error = failure(code);
    if (firstFailure === null) firstFailure = { error };
    const denied = Promise.reject(error);
    denied.catch(() => {}); // Denial is also retained by the scope's join barrier.
    return denied;
  };
  return Object.freeze({
    globalGovernor: globalOwner.childGovernor,
    localGovernor: localOwner.childGovernor,
    reservation: Object.freeze({ version: 1, kind: 'CampaignResourceEnvelopeReservationV1',
      policyHash: policy.policyHash, retained: globalOwner.snapshot().retained,
      childCapacity: globalOwner.snapshot().childCapacity, total: globalOwner.snapshot().envelope }),
    bindNestedRunner(runner) {
      return (operation, actionOptions) => {
        if (!accepting) return reject('campaign_nested_admission_closed');
        if (pending.size >= policy.maximumChildren) return reject('campaign_nested_outstanding_limit');
        return observe(Promise.resolve().then(() => runner(operation, actionOptions)));
      };
    },
    finish({ cancel = false } = {}) {
      accepting = false;
      if (cancel) { globalOwner.seal(); localOwner.seal(); }
      if (joining === null) joining = (async () => {
        await Promise.allSettled([...pending]);
        if (firstFailure !== null) throw firstFailure.error;
      })();
      return joining;
    },
    releaseLocal: () => localOwner.close(),
    releaseGlobal: () => globalOwner.close(),
  });
}
