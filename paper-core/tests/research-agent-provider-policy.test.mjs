import test from 'node:test';
import assert from 'node:assert/strict';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  campaignRequiresResearchGradeAuthor,
  resolveCampaignAgentProviderPolicy,
  verifyCampaignAgentProviderPolicy,
} from '../../paper-domain/automation/research-agent-provider-policy.mjs';

function plan(overrides = {}) {
  const payload = {
    version: 4,
    kind: 'PaperCampaignPlan',
    paperQualityRequirements: {
      formalVerificationRequired: false,
      empiricalVerificationRequired: false,
      researchVerificationRequired: false,
    },
    researchVerificationRequired: false,
    releaseHandoffRequired: false,
    nodes: [],
    ...overrides,
  };
  return Object.freeze({ ...payload, campaignPlanHash: hashRecord('ProviderPolicyFixturePlan', payload) });
}

test('research-grade campaigns resolve auto to the approved Codex author provider', () => {
  const formal = plan({
    paperQualityRequirements: {
      formalVerificationRequired: true,
      empiricalVerificationRequired: false,
      researchVerificationRequired: true,
    },
    researchVerificationRequired: true,
    nodes: [{ kind: 'writer' }, { kind: 'formal-verify' }],
  });
  assert.equal(campaignRequiresResearchGradeAuthor([formal]), true);
  const policy = resolveCampaignAgentProviderPolicy({ plans: [formal] });
  assert.equal(policy.selectedProvider, 'codex');
  assert.equal(policy.assuranceScope, 'preflighted-codex-research-author-v1');
  assert.equal(verifyCampaignAgentProviderPolicy(policy, { plans: [formal] }), true);
});

test('research-grade campaigns reject silent OpenClaw or Ollama author fallback', () => {
  const empirical = plan({
    paperQualityRequirements: {
      formalVerificationRequired: false,
      empiricalVerificationRequired: true,
      researchVerificationRequired: true,
    },
    nodes: [{ kind: 'coder' }],
  });
  for (const requestedProvider of ['openclaw', 'ollama']) {
    assert.throws(
      () => resolveCampaignAgentProviderPolicy({ requestedProvider, plans: [empirical] }),
      new RegExp(`research_grade_agent_provider_not_approved:${requestedProvider}`),
    );
  }
});

test('draft-only campaigns preserve explicit provider selection', () => {
  const draft = plan();
  assert.equal(campaignRequiresResearchGradeAuthor([draft]), false);
  for (const requestedProvider of ['auto', 'openclaw', 'ollama', 'codex']) {
    const policy = resolveCampaignAgentProviderPolicy({ requestedProvider, plans: [draft] });
    assert.equal(policy.selectedProvider, requestedProvider);
    assert.equal(verifyCampaignAgentProviderPolicy(policy, { plans: [draft] }), true);
  }
});

test('verification-only package plans do not require an unused author provider', () => {
  const packageOnly = plan({
    researchVerificationRequired: true,
    nodes: [{ kind: 'final-compile' }, { kind: 'research-verify' }, { kind: 'package' }],
  });
  const policy = resolveCampaignAgentProviderPolicy({ requestedProvider: 'openclaw', plans: [packageOnly] });
  assert.equal(policy.researchGradeRequired, false);
  assert.equal(policy.selectedProvider, 'openclaw');
});

test('provider policy is bound to the selected campaign plans', () => {
  const first = plan();
  const second = plan({ releaseHandoffRequired: true, nodes: [{ kind: 'writer' }] });
  const policy = resolveCampaignAgentProviderPolicy({ requestedProvider: 'codex', plans: [second] });
  assert.equal(verifyCampaignAgentProviderPolicy(policy, { plans: [first] }), false);
  assert.throws(
    () => resolveCampaignAgentProviderPolicy({ requestedProvider: 'unknown', plans: [first] }),
    /campaign_agent_provider_unknown/,
  );
});
