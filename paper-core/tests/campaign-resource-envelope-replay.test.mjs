import assert from 'node:assert/strict';
import test from 'node:test';
import { createResourceGovernor } from '../../paper-application/automation/resource-governor.mjs';
import { captureCampaignResourceEnvelopePolicy, prepareCampaignResourceEnvelopes }
  from '../../paper-application/automation/campaign-resource-envelope.mjs';

const policy = { version: 1, kind: 'CampaignResourceEnvelopePolicyV1',
  nestedAgentSlotsByKind: { compile: 1 } };
const resources = { agent: 0, cpu: 1, gpu: 0, memoryMiB: 1 };

function prepared(governor, localGovernor, nodes) {
  const captured = captureCampaignResourceEnvelopePolicy(policy);
  return prepareCampaignResourceEnvelopes({ policy, governor, localGovernor,
    campaign: { spec: { resourceEnvelopePolicyHash: captured.policyHash } }, nodes });
}

test('prepared-result replay does not require unused child capacity during preflight or admission', async () => {
  // Agent capacity is intentionally zero: a fresh compile needing a one-slot child pool
  // would be impossible, but replay cannot execute nested work and must not reserve it.
  const governor = createResourceGovernor({ agent: 0, cpu: 1, gpu: 0, memoryMiB: 1 });
  const localGovernor = createResourceGovernor({ agent: 0, cpu: 1, gpu: 0, memoryMiB: 1 });
  const node = { kind: 'compile', preparedResultHash: `sha256:${'a'.repeat(64)}` };
  const envelope = prepared(governor, localGovernor, [node]);
  assert.equal(await envelope.acquire(node, resources, null), null);
  assert.deepEqual(governor.snapshot().used, { agent: 0, cpu: 0, gpu: 0, memoryMiB: 0 });
  assert.deepEqual(localGovernor.snapshot().used, { agent: 0, cpu: 0, gpu: 0, memoryMiB: 0 });
});

test('fresh configured work still requires its declared child capacity', () => {
  const governor = createResourceGovernor({ agent: 0, cpu: 1, gpu: 0, memoryMiB: 1 });
  const localGovernor = createResourceGovernor({ agent: 0, cpu: 1, gpu: 0, memoryMiB: 1 });
  assert.throws(() => prepared(governor, localGovernor, [{ kind: 'compile', preparedResultHash: null }]),
    { code: 'campaign_envelope_capacity_exceeded:agent' });
});

test('replay bypass does not weaken policy identity binding', () => {
  const governor = createResourceGovernor({ agent: 0, cpu: 1, gpu: 0, memoryMiB: 1 });
  const localGovernor = createResourceGovernor({ agent: 0, cpu: 1, gpu: 0, memoryMiB: 1 });
  assert.throws(() => prepareCampaignResourceEnvelopes({ policy, governor, localGovernor,
    campaign: { spec: { resourceEnvelopePolicyHash: `sha256:${'b'.repeat(64)}` } },
    nodes: [{ kind: 'compile', preparedResultHash: `sha256:${'a'.repeat(64)}` }] }),
  { code: 'campaign_envelope_policy_binding_mismatch' });
});
