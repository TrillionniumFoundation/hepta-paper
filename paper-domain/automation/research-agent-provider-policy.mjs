import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const PROVIDERS = new Set(['auto', 'openclaw', 'ollama', 'codex']);
const APPROVED_RESEARCH_AUTHOR_PROVIDERS = Object.freeze(['codex']);

function planRequiresResearchGradeAuthor(plan) {
  const requirements = plan?.paperQualityRequirements || plan?.executionIntent?.paperQualityRequirements || {};
  const agentWorkScheduled = (plan?.nodes || []).some((node) => (
    ['research-plan', 'writer', 'theorem-spec', 'formal-verify', 'manuscript-integrate', 'revise'].includes(node?.kind)
    || /^coder(?:-|$)/.test(String(node?.kind || ''))
    || /^(?:revision-)?referee-\d+$/.test(String(node?.kind || ''))
  ));
  return Boolean(agentWorkScheduled && (
    requirements.formalVerificationRequired
    || requirements.empiricalVerificationRequired
    || plan?.researchVerificationRequired
    || plan?.releaseHandoffRequired
  ));
}

export function campaignRequiresResearchGradeAuthor(plans = []) {
  return (Array.isArray(plans) ? plans : []).some(planRequiresResearchGradeAuthor);
}

export function resolveCampaignAgentProviderPolicy({ requestedProvider = 'auto', plans = [] } = {}) {
  const requested = String(requestedProvider || 'auto').trim().toLowerCase();
  if (!PROVIDERS.has(requested)) throw new Error(`campaign_agent_provider_unknown:${requested || '<empty>'}`);
  const researchGradeRequired = campaignRequiresResearchGradeAuthor(plans);
  const allPlansLocalOnly = Array.isArray(plans) && plans.length > 0
    && plans.every((plan) => plan?.localOnly === true);
  const selectedProvider = researchGradeRequired && requested === 'auto' ? 'codex' : requested;
  const localProviderExceptionApplied = researchGradeRequired
    && allPlansLocalOnly && selectedProvider === 'ollama';
  if (researchGradeRequired
    && !APPROVED_RESEARCH_AUTHOR_PROVIDERS.includes(selectedProvider)
    && !localProviderExceptionApplied) {
    throw new Error(`research_grade_agent_provider_not_approved:${selectedProvider}`);
  }
  const payload = {
    version: 1,
    kind: 'CampaignResearchAuthorProviderPolicy',
    status: 'campaign_research_author_provider_policy_resolved',
    requestedProvider: requested,
    selectedProvider,
    researchGradeRequired,
    allPlansLocalOnly,
    localProviderExceptionApplied,
    assuranceScope: localProviderExceptionApplied
      ? 'explicit-local-only-ollama-research-author-v1'
      : researchGradeRequired ? 'preflighted-codex-research-author-v1'
      : 'draft-agent-provider-selection-v1',
    approvedResearchAuthorProviders: APPROVED_RESEARCH_AUTHOR_PROVIDERS,
    campaignPlanHashes: Object.freeze((Array.isArray(plans) ? plans : [])
      .map((plan) => String(plan?.campaignPlanHash || ''))
      .filter(Boolean)
      .sort()),
    externalActionPerformed: false,
  };
  return Object.freeze({
    ...payload,
    campaignResearchAuthorProviderPolicyHash: hashRecord('CampaignResearchAuthorProviderPolicy', payload),
  });
}

export function verifyCampaignAgentProviderPolicy(receipt, { plans = [] } = {}) {
  let expected = null;
  try {
    expected = resolveCampaignAgentProviderPolicy({
      requestedProvider: receipt?.requestedProvider,
      plans,
    });
  } catch { return false; }
  return receipt?.campaignResearchAuthorProviderPolicyHash === expected.campaignResearchAuthorProviderPolicyHash
    && hashRecord('CampaignResearchAuthorProviderPolicyExpected', receipt)
      === hashRecord('CampaignResearchAuthorProviderPolicyExpected', expected);
}
