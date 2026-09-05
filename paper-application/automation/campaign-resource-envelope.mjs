import { AsyncLocalStorage } from 'node:async_hooks';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { campaignNodeOperation } from './campaign-node-kind-policy.mjs';
import { resourcesForCampaignNode } from './resource-governor.mjs';

const DIMENSIONS = ['agent', 'cpu', 'gpu', 'memoryMiB'];
function fail(code) { throw Object.assign(new Error(code), { code, retryable: false }); }
function dataRecord(value, allowed, code) {
  if (!value || typeof value !== 'object'
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(code);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length > 64 || keys.some((key) => typeof key !== 'string'
    || (allowed && !allowed.includes(key)) || !descriptors[key].enumerable
    || !Object.hasOwn(descriptors[key], 'value'))) fail(code);
  return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
}
function bounded(value, maximum, code) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) fail(code);
  return value;
}

// Trusted composition configuration only. Never infer extra capacity from a
// candidate's node.spec; never adapt a distributed governor into a local one.
export function captureCampaignResourceEnvelopePolicy(policy) {
  const input = dataRecord(policy, ['version', 'kind', 'nestedAgentSlotsByKind',
    'maximumChildren', 'maximumWaitingRequests'], 'campaign_envelope_policy_invalid');
  if (input.version !== 1 || input.kind !== 'CampaignResourceEnvelopePolicyV1') {
    fail('campaign_envelope_policy_invalid');
  }
  const mapping = dataRecord(input.nestedAgentSlotsByKind, null, 'campaign_envelope_kinds_invalid');
  const kinds = Object.keys(mapping).sort();
  if (!kinds.length) fail('campaign_envelope_kinds_invalid');
  const slotsByKind = Object.freeze(Object.fromEntries(kinds.map((kind) => {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(kind) || campaignNodeOperation(kind) === 'noop') {
      fail('campaign_envelope_kind_unknown');
    }
    return [kind, bounded(mapping[kind], 64, 'campaign_envelope_agent_slots_invalid')];
  })));
  const maximumChildren = Object.hasOwn(input, 'maximumChildren')
    ? bounded(input.maximumChildren, 4096, 'campaign_envelope_child_limit_invalid') : 1024;
  const maximumWaitingRequests = Object.hasOwn(input, 'maximumWaitingRequests')
    ? bounded(input.maximumWaitingRequests, 4096, 'campaign_envelope_queue_limit_invalid') : 1024;
  const body = Object.freeze({ version: 1, kind: input.kind, nestedAgentSlotsByKind: slotsByKind,
    maximumChildren, maximumWaitingRequests });
  return Object.freeze({ policy: body, policyHash: hashRecord('CampaignResourceEnvelopePolicyV1', body) });
}

export function prepareCampaignResourceEnvelopes({ policy, governor, localGovernor, campaign, nodes }) {
  if (policy === null) {
    if (campaign?.spec?.resourceEnvelopePolicyHash !== undefined) fail('campaign_envelope_policy_required');
    return null;
  }
  const captured = captureCampaignResourceEnvelopePolicy(policy);
  const { policyHash, policy: { nestedAgentSlotsByKind: slotsByKind,
    maximumChildren, maximumWaitingRequests } } = captured;
  if (campaign?.spec?.resourceEnvelopePolicyHash !== policyHash) fail('campaign_envelope_policy_binding_mismatch');
  for (const port of [governor, localGovernor]) {
    if (port?.kind !== 'GlobalResourceGovernor' || typeof port.acquireEnvelope !== 'function') {
      fail('campaign_envelope_governor_unsupported');
    }
  }
  const checkCapacity = (resources, slots) => {
    for (const key of DIMENSIONS) {
      const extra = key === 'agent' ? slots : 0;
      for (const port of [governor, localGovernor]) {
        const limit = port.limits?.[key];
        if (!Number.isSafeInteger(limit) || limit < 0 || resources[key] > limit
          || extra > limit - resources[key]) fail(`campaign_envelope_capacity_exceeded:${key}`);
      }
    }
  };
  // Reject impossible configured nodes before claimReady/startNode or provider work.
  for (const node of nodes) {
    if (Object.hasOwn(slotsByKind, node.kind)) {
      checkCapacity(resourcesForCampaignNode(campaign, node), slotsByKind[node.kind]);
    }
  }
  return Object.freeze({
    policyHash, maximumChildren,
    async acquire(node, resources, signal) {
      if (!Object.hasOwn(slotsByKind, node.kind)) return null;
      const slots = slotsByKind[node.kind];
      checkCapacity(resources, slots); // Recheck each actual admission, not just initial DAG.
      const definition = { retained: resources, childCapacity: { agent: slots } };
      const options = { signal, maximumChildren, maximumWaitingRequests };
      const globalOwner = await governor.acquireEnvelope(definition, options);
      let localOwner;
      try { localOwner = await localGovernor.acquireEnvelope(definition, options); }
      catch (error) { globalOwner.close(); throw error; } // Nothing dispatched yet.
      return Object.freeze({
        globalChildren: globalOwner.childGovernor,
        localChildren: localOwner.childGovernor,
        releaseGlobal: () => { globalOwner.close(); },
        releaseLocal: () => { localOwner.close(); },
        executionBinding: Object.freeze({ kind: 'CampaignResourceEnvelopeBindingV1', version: 1,
          policyHash, retained: globalOwner.snapshot().retained,
          childCapacity: globalOwner.snapshot().childCapacity,
          totalReservation: globalOwner.snapshot().envelope }),
      });
    },
  });
}

// A successful parent may not commit while one of its nested operations is
// still running. Drain before releasing resources on every failure path too.
// Deliberately no timeout refunds: a non-cooperating child keeps its reservation.
export function createCampaignNestedExecutionScope(runNestedAgent, controller, {
  allowed = true, maximumOutstanding = 1024, forbidRecursion = false,
} = {}) {
  bounded(maximumOutstanding, 4096, 'campaign_nested_limit_invalid');
  const active = new Set();
  const childExecution = new AsyncLocalStorage();
  let accepting = true;
  const stop = () => {
    accepting = false;
    if (active.size && !controller.signal.aborted) controller.abort('campaign_nested_work_unsettled');
  };
  // Every engine-exposed child runner joins the same bounded parent lifetime.
  // The bound function is passed to the executor, never the scope owner itself.
  const bind = (runOperation, { allowed = true, forbidRecursion = false } = {}) => {
    if (typeof runOperation !== 'function') fail('campaign_child_runner_required');
    return (operation, options) => {
      if (forbidRecursion && childExecution.getStore() === true) return Promise.reject(Object.assign(new Error('campaign_nested_recursion_forbidden'),
        { code: 'campaign_nested_recursion_forbidden', retryable: false }));
      if (!allowed) return Promise.reject(Object.assign(new Error('campaign_nested_kind_undeclared'),
        { code: 'campaign_nested_kind_undeclared', retryable: false }));
      if (active.size >= maximumOutstanding) return Promise.reject(Object.assign(new Error('campaign_nested_outstanding_limit'),
        { code: 'campaign_nested_outstanding_limit', retryable: false }));
      if (!accepting) return Promise.reject(Object.assign(new Error('campaign_nested_scope_closed'),
        { code: 'campaign_nested_scope_closed', retryable: false }));
      const promise = Promise.resolve().then(() => childExecution.run(true, () => runOperation(operation, options)));
      active.add(promise);
      // Observe both paths immediately: an escaped rejection is still drained,
      // without producing an unhandled rejection or a second authority claim.
      promise.then(() => active.delete(promise), () => active.delete(promise));
      return promise;
    };
  };
  return Object.freeze({
    run: bind(runNestedAgent, { allowed, forbidRecursion }), bind,
    async finish() {
      const unfinished = active.size !== 0;
      stop();
      await Promise.allSettled([...active]);
      childExecution.disable();
      if (unfinished) fail('campaign_nested_work_unsettled');
    },
    async drain() {
      stop();
      await Promise.allSettled([...active]);
      childExecution.disable();
    },
  });
}
