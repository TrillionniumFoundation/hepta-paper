import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

export const AUTONOMOUS_RESEARCH_LAUNCH_MODES = Object.freeze({
  GOLDEN_BOOTSTRAP: 'golden-bootstrap',
  PRODUCTION_RUN: 'production-run',
});
export const AUTONOMOUS_RESEARCH_LAUNCH_VALIDITY_SAFETY_MARGIN_MS = 15 * 60 * 1000;
export const AUTONOMOUS_RESEARCH_UNLIMITED_BUDGET_SENTINEL = Number.MAX_SAFE_INTEGER;
const DIRECT_LOCAL_RUN_BUDGET_WAIVER_KIND =
  'AutonomousResearchDirectLocalRunBudgetWaiver';
const DIRECT_LOCAL_RUN_BUDGET_WAIVER_HASH_FIELD =
  'autonomousResearchDirectLocalRunBudgetWaiverHash';
const DIRECT_LOCAL_RUN_CLI_PROVENANCE_KIND =
  'AutonomousResearchDirectLocalRunCliProvenance';
const DIRECT_LOCAL_RUN_CLI_PROVENANCE_HASH_FIELD =
  'autonomousResearchDirectLocalRunCliProvenanceHash';

function requiredIdentity(value, errorCode) {
  const identity = String(value || '').trim();
  if (!identity) throw new Error(errorCode);
  return identity;
}

function exactUnlimitedBudgetSentinel(value) {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value === AUTONOMOUS_RESEARCH_UNLIMITED_BUDGET_SENTINEL;
}

function assertDirectLocalRunBudgetTypes(budgets = {}) {
  if (budgets?.maxTokenCount !== undefined
    && (typeof budgets.maxTokenCount !== 'number'
      || !Number.isSafeInteger(budgets.maxTokenCount)
      || budgets.maxTokenCount < 0)) {
    throw new Error(
      'autonomous_research_direct_local_run_budget_invalid:maxTokenCount',
    );
  }
  if (budgets?.maxCostUsd !== undefined
    && (typeof budgets.maxCostUsd !== 'number'
      || !Number.isFinite(budgets.maxCostUsd)
      || budgets.maxCostUsd < 0)) {
    throw new Error(
      'autonomous_research_direct_local_run_budget_invalid:maxCostUsd',
    );
  }
}

function assertLaunchBudgetTypes(budgets = {}) {
  if (budgets?.maxTokenCount !== undefined
    && (typeof budgets.maxTokenCount !== 'number'
      || !Number.isSafeInteger(budgets.maxTokenCount)
      || budgets.maxTokenCount < 0)) {
    throw new Error('autonomous_research_launch_budget_invalid:maxTokenCount');
  }
  if (budgets?.maxCostUsd !== undefined
    && (typeof budgets.maxCostUsd !== 'number'
      || !Number.isFinite(budgets.maxCostUsd)
      || budgets.maxCostUsd < 0)) {
    throw new Error('autonomous_research_launch_budget_invalid:maxCostUsd');
  }
}

export function buildAutonomousResearchDirectLocalRunCliProvenance({
  campaignId,
  paperId,
} = {}) {
  const payload = Object.freeze({
    version: 1,
    kind: DIRECT_LOCAL_RUN_CLI_PROVENANCE_KIND,
    scope: 'direct-local-run',
    issuer: 'hepta-paper-autonomous-research-cli',
    operatorIssuance: 'explicit-unlimited-budget-flags-v1',
    requestedLaunchMode: 'local-run',
    effectiveLaunchMode: AUTONOMOUS_RESEARCH_LAUNCH_MODES.GOLDEN_BOOTSTRAP,
    campaignId: requiredIdentity(
      campaignId,
      'autonomous_research_direct_local_run_campaign_id_required',
    ),
    paperId: requiredIdentity(
      paperId,
      'autonomous_research_direct_local_run_paper_id_required',
    ),
  });
  return Object.freeze({
    ...payload,
    [DIRECT_LOCAL_RUN_CLI_PROVENANCE_HASH_FIELD]:
      hashRecord(DIRECT_LOCAL_RUN_CLI_PROVENANCE_KIND, payload),
  });
}

export function verifyAutonomousResearchDirectLocalRunCliProvenance(
  provenance = null,
  { campaignId = null, paperId = null } = {},
) {
  if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance)) {
    return false;
  }
  const expectedKeys = [
    'version',
    'kind',
    'scope',
    'issuer',
    'operatorIssuance',
    'requestedLaunchMode',
    'effectiveLaunchMode',
    'campaignId',
    'paperId',
    DIRECT_LOCAL_RUN_CLI_PROVENANCE_HASH_FIELD,
  ].sort();
  if (JSON.stringify(Object.keys(provenance).sort()) !== JSON.stringify(expectedKeys)) {
    return false;
  }
  if (provenance.version !== 1
    || provenance.kind !== DIRECT_LOCAL_RUN_CLI_PROVENANCE_KIND
    || provenance.scope !== 'direct-local-run'
    || provenance.issuer !== 'hepta-paper-autonomous-research-cli'
    || provenance.operatorIssuance !== 'explicit-unlimited-budget-flags-v1'
    || provenance.requestedLaunchMode !== 'local-run'
    || provenance.effectiveLaunchMode
      !== AUTONOMOUS_RESEARCH_LAUNCH_MODES.GOLDEN_BOOTSTRAP
    || !String(provenance.campaignId || '').trim()
    || !String(provenance.paperId || '').trim()
    || (campaignId !== null && provenance.campaignId !== String(campaignId))
    || (paperId !== null && provenance.paperId !== String(paperId))) return false;
  const {
    [DIRECT_LOCAL_RUN_CLI_PROVENANCE_HASH_FIELD]: claimedHash,
    ...payload
  } = provenance;
  return claimedHash === hashRecord(DIRECT_LOCAL_RUN_CLI_PROVENANCE_KIND, payload);
}

export function buildAutonomousResearchDirectLocalRunBudgetWaiver({
  unlimitedTokenCount = false,
  unlimitedCostUsd = false,
  provenance = null,
} = {}) {
  if (unlimitedTokenCount !== true && unlimitedCostUsd !== true) {
    throw new Error('autonomous_research_direct_local_run_budget_waiver_empty');
  }
  if (!verifyAutonomousResearchDirectLocalRunCliProvenance(provenance)) {
    throw new Error('autonomous_research_direct_local_run_cli_provenance_invalid');
  }
  const payload = Object.freeze({
    version: 2,
    kind: DIRECT_LOCAL_RUN_BUDGET_WAIVER_KIND,
    scope: 'direct-local-run',
    campaignId: provenance.campaignId,
    paperId: provenance.paperId,
    directLocalRunCliProvenanceHash:
      provenance[DIRECT_LOCAL_RUN_CLI_PROVENANCE_HASH_FIELD],
    unlimitedTokenCount: unlimitedTokenCount === true,
    unlimitedCostUsd: unlimitedCostUsd === true,
  });
  return Object.freeze({
    ...payload,
    [DIRECT_LOCAL_RUN_BUDGET_WAIVER_HASH_FIELD]:
      hashRecord(DIRECT_LOCAL_RUN_BUDGET_WAIVER_KIND, payload),
  });
}

export function verifyAutonomousResearchDirectLocalRunBudgetWaiver(
  waiver = null,
  { campaignId = null, paperId = null, provenance = null } = {},
) {
  if (!waiver || typeof waiver !== 'object' || Array.isArray(waiver)) return false;
  const expectedKeys = [
    'version',
    'kind',
    'scope',
    'campaignId',
    'paperId',
    'directLocalRunCliProvenanceHash',
    'unlimitedTokenCount',
    'unlimitedCostUsd',
    DIRECT_LOCAL_RUN_BUDGET_WAIVER_HASH_FIELD,
  ].sort();
  if (JSON.stringify(Object.keys(waiver).sort()) !== JSON.stringify(expectedKeys)) return false;
  if (waiver.version !== 2
    || waiver.kind !== DIRECT_LOCAL_RUN_BUDGET_WAIVER_KIND
    || waiver.scope !== 'direct-local-run'
    || !String(waiver.campaignId || '').trim()
    || !String(waiver.paperId || '').trim()
    || !/^sha256:[0-9a-f]{64}$/.test(String(
      waiver.directLocalRunCliProvenanceHash || '',
    ))
    || (campaignId !== null && waiver.campaignId !== String(campaignId))
    || (paperId !== null && waiver.paperId !== String(paperId))
    || typeof waiver.unlimitedTokenCount !== 'boolean'
    || typeof waiver.unlimitedCostUsd !== 'boolean'
    || (!waiver.unlimitedTokenCount && !waiver.unlimitedCostUsd)) return false;
  if (provenance !== null
    && (!verifyAutonomousResearchDirectLocalRunCliProvenance(provenance, {
      campaignId: waiver.campaignId,
      paperId: waiver.paperId,
    })
      || waiver.directLocalRunCliProvenanceHash
        !== provenance[DIRECT_LOCAL_RUN_CLI_PROVENANCE_HASH_FIELD])) return false;
  const { [DIRECT_LOCAL_RUN_BUDGET_WAIVER_HASH_FIELD]: claimedHash, ...payload } = waiver;
  return claimedHash === hashRecord(DIRECT_LOCAL_RUN_BUDGET_WAIVER_KIND, payload);
}

function verifyDirectLocalRunPreparation(
  preparation,
  { campaignId = null, paperId = null } = {},
) {
  if (!preparation || typeof preparation !== 'object' || Array.isArray(preparation)) {
    return false;
  }
  const {
    autonomousResearchLoopPreparationReportHash: claimedHash,
    ...payload
  } = preparation;
  return preparation.version === 1
    && preparation.kind === 'AutonomousResearchLoopPreparationReport'
    && preparation.launchMode
      === AUTONOMOUS_RESEARCH_LAUNCH_MODES.GOLDEN_BOOTSTRAP
    && preparation.autonomousExecutionLaunchReady === true
    && (paperId === null || preparation.proposal?.paperId === String(paperId))
    && verifyAutonomousResearchDirectLocalRunCliProvenance(
      preparation.directLocalRunCliProvenance,
      { campaignId, paperId },
    )
    && claimedHash === hashRecord('AutonomousResearchLoopPreparationReport', payload);
}

export function assertAutonomousResearchDirectLocalRunBudgetWaiverBinding({
  launchMode = null,
  localOnly = false,
  budgets = {},
  waiver = null,
  campaignId = null,
  paperId = null,
  preparation = null,
} = {}) {
  assertDirectLocalRunBudgetTypes(budgets);
  const tokenSentinel = exactUnlimitedBudgetSentinel(budgets?.maxTokenCount);
  const costSentinel = exactUnlimitedBudgetSentinel(budgets?.maxCostUsd);
  if (!waiver && !tokenSentinel && !costSentinel) return null;
  if (!verifyAutonomousResearchDirectLocalRunBudgetWaiver(waiver, {
    campaignId,
    paperId,
  })) {
    throw new Error('autonomous_research_direct_local_run_budget_waiver_invalid');
  }
  if (localOnly !== true
    || launchMode !== AUTONOMOUS_RESEARCH_LAUNCH_MODES.GOLDEN_BOOTSTRAP) {
    throw new Error('autonomous_research_direct_local_run_budget_waiver_scope_invalid');
  }
  if (!preparation) {
    throw new Error('autonomous_research_direct_local_run_preparation_required');
  }
  if (!verifyDirectLocalRunPreparation(preparation, { campaignId, paperId })) {
    throw new Error('autonomous_research_direct_local_run_preparation_invalid');
  }
  if (!verifyAutonomousResearchDirectLocalRunBudgetWaiver(waiver, {
    campaignId,
    paperId,
    provenance: preparation.directLocalRunCliProvenance,
  })) {
    throw new Error('autonomous_research_direct_local_run_budget_waiver_binding_invalid');
  }
  if (waiver.unlimitedTokenCount !== tokenSentinel
    || waiver.unlimitedCostUsd !== costSentinel) {
    throw new Error('autonomous_research_direct_local_run_budget_waiver_binding_invalid');
  }
  return waiver;
}

export function resolveAutonomousResearchDirectLocalRunBudgetWaiverForCampaign({
  existingCampaign = null,
  requestedWaiver = null,
} = {}) {
  if (!existingCampaign) {
    if (requestedWaiver
      && !verifyAutonomousResearchDirectLocalRunBudgetWaiver(requestedWaiver)) {
      throw new Error('autonomous_research_direct_local_run_budget_waiver_invalid');
    }
    return requestedWaiver;
  }
  const persistedWaiver = existingCampaign.spec?.directLocalRunBudgetWaiver || null;
  if (persistedWaiver) {
    assertAutonomousResearchDirectLocalRunBudgetWaiverBinding({
      campaignId: existingCampaign.campaignId,
      paperId: existingCampaign.paperId,
      launchMode: existingCampaign.spec?.autonomousResearchPreparation?.launchMode || null,
      localOnly: existingCampaign.spec?.localOnly === true,
      budgets: existingCampaign.spec?.budgets,
      waiver: persistedWaiver,
      preparation: existingCampaign.spec?.autonomousResearchPreparation || null,
    });
  }
  if (!requestedWaiver) return persistedWaiver;
  if (!persistedWaiver) {
    throw new Error('autonomous_research_direct_local_run_budget_waiver_retrofit_forbidden');
  }
  if (!verifyAutonomousResearchDirectLocalRunBudgetWaiver(requestedWaiver, {
    campaignId: existingCampaign.campaignId,
    paperId: existingCampaign.paperId,
    provenance: existingCampaign.spec?.autonomousResearchPreparation
      ?.directLocalRunCliProvenance || null,
  })
    || !verifyAutonomousResearchDirectLocalRunBudgetWaiver(persistedWaiver, {
      campaignId: existingCampaign.campaignId,
      paperId: existingCampaign.paperId,
      provenance: existingCampaign.spec?.autonomousResearchPreparation
        ?.directLocalRunCliProvenance || null,
    })) {
    throw new Error('autonomous_research_direct_local_run_budget_waiver_invalid');
  }
  if (requestedWaiver[DIRECT_LOCAL_RUN_BUDGET_WAIVER_HASH_FIELD]
    !== persistedWaiver[DIRECT_LOCAL_RUN_BUDGET_WAIVER_HASH_FIELD]) {
    throw new Error('autonomous_research_direct_local_run_budget_waiver_mismatch');
  }
  return persistedWaiver;
}

export function resolvePersistedAutonomousResearchLaunchMode({
  campaign,
  requestedLaunchMode = null,
  requestedLocalOnly = null,
} = {}) {
  const preparation = campaign?.spec?.autonomousResearchPreparation || null;
  if (!preparation || preparation.version !== 1
    || preparation.kind !== 'AutonomousResearchLoopPreparationReport') {
    throw new Error('autonomous_research_persisted_preparation_required');
  }
  const { autonomousResearchLoopPreparationReportHash: claimedHash, ...payload } = preparation;
  if (hashRecord('AutonomousResearchLoopPreparationReport', payload) !== claimedHash) {
    throw new Error('autonomous_research_persisted_preparation_hash_invalid');
  }
  const persistedMode = preparation.launchMode;
  const launchMode = persistedMode === undefined
    ? AUTONOMOUS_RESEARCH_LAUNCH_MODES.PRODUCTION_RUN : persistedMode;
  if (!Object.values(AUTONOMOUS_RESEARCH_LAUNCH_MODES).includes(launchMode)) {
    throw new Error(`autonomous_research_persisted_launch_mode_invalid:${launchMode}`);
  }
  if (requestedLaunchMode !== null && requestedLaunchMode !== launchMode) {
    throw new Error(
      `autonomous_research_launch_mode_mismatch:${launchMode}:${requestedLaunchMode}`,
    );
  }
  const persistedLocalOnly = campaign?.spec?.localOnly === true;
  if (requestedLocalOnly !== null
    && requestedLocalOnly !== persistedLocalOnly) {
    throw new Error(
      `autonomous_research_local_only_mismatch:${persistedLocalOnly}:${requestedLocalOnly}`,
    );
  }
  return Object.freeze({
    launchMode,
    localOnly: persistedLocalOnly,
    legacyLaunchModeMissing: persistedMode === undefined,
    budgets: Object.freeze({ ...(campaign?.spec?.budgets || {}) }),
  });
}

const MUTATING_OR_PROVIDER_ACTIONS = new Set(['launch', 'resume', 'converge']);
const BUDGET_KEYS = Object.freeze([
  'maxWallTimeMs',
  'maxAgentCalls',
  'maxCpuJobs',
  'maxGpuJobs',
  'maxTokenCount',
  'maxCostUsd',
  'maxMemoryMiB',
]);

const GOLDEN_BOOTSTRAP_DEFAULT_BUDGETS = Object.freeze({
  maxWallTimeMs: 2 * 60 * 60 * 1000,
  maxAgentCalls: 48,
  maxCpuJobs: 128,
  maxGpuJobs: 16,
  maxTokenCount: 300_000,
  maxCostUsd: 100,
  maxMemoryMiB: 8192,
});

const GOLDEN_BOOTSTRAP_HARD_BUDGETS = Object.freeze({
  ...GOLDEN_BOOTSTRAP_DEFAULT_BUDGETS,
  maxAgentCalls: 512,
  maxCpuJobs: 32_768,
  maxGpuJobs: 32_768,
  maxTokenCount: 4_000_000,
});

const PRODUCTION_DEFAULT_HARD_BUDGETS = Object.freeze({
  maxWallTimeMs: 6 * 60 * 60 * 1000,
  maxAgentCalls: 64,
  maxCpuJobs: 256,
  maxGpuJobs: 32,
  maxTokenCount: 500_000,
  maxCostUsd: 100,
  maxMemoryMiB: 8192,
});

function finiteNonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function finitePositive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function normalizedMode(value) {
  const mode = String(value || '').trim();
  if (!Object.values(AUTONOMOUS_RESEARCH_LAUNCH_MODES).includes(mode)) {
    throw new Error(`autonomous_research_launch_mode_invalid:${mode || '<empty>'}`);
  }
  return mode;
}

function normalizedBudgets(mode, budgets) {
  const golden = mode === AUTONOMOUS_RESEARCH_LAUNCH_MODES.GOLDEN_BOOTSTRAP;
  const defaults = golden
    ? GOLDEN_BOOTSTRAP_DEFAULT_BUDGETS : PRODUCTION_DEFAULT_HARD_BUDGETS;
  const source = budgets && typeof budgets === 'object' && !Array.isArray(budgets) ? budgets : {};
  assertLaunchBudgetTypes(source);
  const normalized = Object.fromEntries(BUDGET_KEYS.map((key) => {
    const value = source[key] === undefined ? defaults[key] : finiteNonNegative(source[key]);
    if (value === null) throw new Error(`autonomous_research_launch_budget_invalid:${key}`);
    return [key, golden
      ? Math.min(value, GOLDEN_BOOTSTRAP_HARD_BUDGETS[key]) : value];
  }));
  return normalized;
}

export function resolveAutonomousResearchProviderPricing({
  researchAuthorProvider = null,
  researchAuthorModel = null,
  formalReviewerProvider = null,
  formalReviewerModel = null,
  researchAuthorMaximumCostPerCallUsd = null,
  formalReviewerMaximumCostPerCallUsd = null,
} = {}) {
  const authorMaximum = finitePositive(researchAuthorMaximumCostPerCallUsd);
  const reviewerMaximum = finitePositive(formalReviewerMaximumCostPerCallUsd);
  const blockers = [];
  if (!authorMaximum) blockers.push('autonomous_research_research_author_provider_pricing_unknown');
  if (!reviewerMaximum) blockers.push('autonomous_research_formal_reviewer_provider_pricing_unknown');
  const payload = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchProviderPricingInspection',
    status: blockers.length
      ? 'autonomous_research_provider_pricing_unknown'
      : 'autonomous_research_provider_pricing_bounded',
    pricingAuthority: 'operator-configured-maximum-cost-per-provider-call-v1',
    researchAuthor: Object.freeze({
      provider: researchAuthorProvider || null,
      model: researchAuthorModel || null,
      maximumCostPerCallUsd: authorMaximum,
    }),
    formalReviewer: Object.freeze({
      provider: formalReviewerProvider || null,
      model: formalReviewerModel || null,
      maximumCostPerCallUsd: reviewerMaximum,
    }),
    maximumCostPerCallUsd: authorMaximum && reviewerMaximum
      ? Math.max(authorMaximum, reviewerMaximum) : null,
    providerCanaryPairMaximumCostUsd: authorMaximum && reviewerMaximum
      ? authorMaximum + reviewerMaximum : null,
    pricingKnown: blockers.length === 0,
    blockers: Object.freeze(blockers),
  });
  return Object.freeze({
    ...payload,
    autonomousResearchProviderPricingInspectionHash:
      hashRecord('AutonomousResearchProviderPricingInspection', payload),
  });
}

export function evaluateAutonomousResearchLaunchModeGate({
  launchMode,
  action,
  budgets = {},
  localOnly = false,
  directLocalRunBudgetWaiver = null,
  directLocalRunCliProvenance = null,
  autonomousResearchPreparation = null,
  directLocalRunPreparationPending = false,
  campaignId = null,
  paperId = null,
  providerPricingInspection = null,
  fullResearchReadiness = null,
  admissionOnly = false,
} = {}) {
  const mode = normalizedMode(launchMode);
  const normalizedAction = String(action || '').trim();
  if (!['prepare', 'launch', 'status', 'resume', 'converge'].includes(normalizedAction)) {
    throw new Error(`autonomous_research_campaign_action_invalid:${normalizedAction || '<empty>'}`);
  }
  const effectiveBudgets = normalizedBudgets(mode, budgets);
  const blockers = [];
  const tokenSentinelRequested = exactUnlimitedBudgetSentinel(budgets?.maxTokenCount);
  const costSentinelRequested = exactUnlimitedBudgetSentinel(budgets?.maxCostUsd);
  const effectiveProvenance = autonomousResearchPreparation
    ?.directLocalRunCliProvenance || directLocalRunCliProvenance;
  const provenanceVerified = verifyAutonomousResearchDirectLocalRunCliProvenance(
    effectiveProvenance,
    { campaignId, paperId },
  );
  const preparationVerified = autonomousResearchPreparation !== null
    && verifyDirectLocalRunPreparation(
      autonomousResearchPreparation,
      { campaignId, paperId },
    );
  const waiverStructurallyVerified =
    verifyAutonomousResearchDirectLocalRunBudgetWaiver(
      directLocalRunBudgetWaiver,
      { campaignId, paperId },
    );
  const waiverVerified = waiverStructurallyVerified
    && verifyAutonomousResearchDirectLocalRunBudgetWaiver(
    directLocalRunBudgetWaiver,
    {
      campaignId,
      paperId,
      provenance: effectiveProvenance,
    },
    );
  const commonWaiverScopeValid = waiverVerified && localOnly === true
    && mode === AUTONOMOUS_RESEARCH_LAUNCH_MODES.GOLDEN_BOOTSTRAP
    && provenanceVerified;
  const waiverScopeValid = commonWaiverScopeValid && preparationVerified;
  const preparationPendingScopeValid = commonWaiverScopeValid
    && autonomousResearchPreparation === null
    && directLocalRunPreparationPending === true;
  const waiverAuthorizationValid = waiverScopeValid
    || preparationPendingScopeValid;
  if (directLocalRunBudgetWaiver && !waiverStructurallyVerified) {
    blockers.push('autonomous_research_direct_local_run_budget_waiver_invalid');
  } else if (directLocalRunBudgetWaiver && !provenanceVerified) {
    blockers.push('autonomous_research_direct_local_run_cli_provenance_invalid');
  } else if (waiverVerified && !commonWaiverScopeValid) {
    blockers.push('autonomous_research_direct_local_run_budget_waiver_scope_invalid');
  } else if (waiverVerified && autonomousResearchPreparation === null
    && !preparationPendingScopeValid) {
    blockers.push('autonomous_research_direct_local_run_preparation_required');
  } else if (waiverVerified && !waiverAuthorizationValid) {
    blockers.push('autonomous_research_direct_local_run_preparation_invalid');
  }
  if ((tokenSentinelRequested || costSentinelRequested) && !waiverAuthorizationValid) {
    blockers.push('autonomous_research_direct_local_run_budget_waiver_required');
  }
  if (waiverAuthorizationValid
    && (directLocalRunBudgetWaiver.unlimitedTokenCount !== tokenSentinelRequested
      || directLocalRunBudgetWaiver.unlimitedCostUsd !== costSentinelRequested)) {
    blockers.push('autonomous_research_direct_local_run_budget_waiver_binding_invalid');
  }
  const directLocalRunBudgetWaiverActive = waiverScopeValid
    && directLocalRunBudgetWaiver.unlimitedTokenCount === tokenSentinelRequested
    && directLocalRunBudgetWaiver.unlimitedCostUsd === costSentinelRequested;
  const directLocalRunCliPreflightActive = preparationPendingScopeValid
    && directLocalRunBudgetWaiver.unlimitedTokenCount === tokenSentinelRequested
    && directLocalRunBudgetWaiver.unlimitedCostUsd === costSentinelRequested;
  if (directLocalRunBudgetWaiverActive && tokenSentinelRequested) {
    effectiveBudgets.maxTokenCount = AUTONOMOUS_RESEARCH_UNLIMITED_BUDGET_SENTINEL;
  }
  if (directLocalRunBudgetWaiverActive && costSentinelRequested) {
    effectiveBudgets.maxCostUsd = AUTONOMOUS_RESEARCH_UNLIMITED_BUDGET_SENTINEL;
  }
  const providerOrMutationRequested = MUTATING_OR_PROVIDER_ACTIONS.has(normalizedAction);
  const directLocalRunCostWaiverAuthorized = (directLocalRunBudgetWaiverActive
      || directLocalRunCliPreflightActive)
    && directLocalRunBudgetWaiver.unlimitedCostUsd === true;
  const production = mode === AUTONOMOUS_RESEARCH_LAUNCH_MODES.PRODUCTION_RUN;
  const requiredValidityMs = effectiveBudgets.maxWallTimeMs
    + AUTONOMOUS_RESEARCH_LAUNCH_VALIDITY_SAFETY_MARGIN_MS;
  const runtimeRemainingValidityMs = finitePositive(
    fullResearchReadiness?.runtimeImageReproducibility?.remainingValidityMs,
  );
  const qualificationRemainingValidityMs = finitePositive(
    fullResearchReadiness?.fullResearchQualification?.remainingValidityMs,
  );
  const runtimeValidityWindowReady = !production || !providerOrMutationRequested
    || (runtimeRemainingValidityMs !== null
      && runtimeRemainingValidityMs > requiredValidityMs);
  const qualificationValidityWindowReady = !production || !providerOrMutationRequested
    || (qualificationRemainingValidityMs !== null
      && qualificationRemainingValidityMs > requiredValidityMs);
  const productionGenericCapabilityReady = !production || !providerOrMutationRequested
    || fullResearchReadiness?.productionGenericCapabilityReady === true
    || fullResearchReadiness?.fullyAutonomousResearchSystemReady === true;
  const fullReadinessVerified = !production || !providerOrMutationRequested
    || ((admissionOnly === true
      ? fullResearchReadiness?.productionEnqueueAdmissionReady === true
      : fullResearchReadiness?.fullResearchQualificationReady === true
        && (fullResearchReadiness?.boundedGoldenInfrastructureQualificationReady === true
          || fullResearchReadiness?.productionGenericResearchQualificationReady === true)
        && fullResearchReadiness?.fullAutomaticResearchWritingReady === true
        && fullResearchReadiness?.researchExecutionReleaseAttestorProductionReady === true)
      && fullResearchReadiness?.runtimeImageReproducibilityReady === true
      && runtimeValidityWindowReady && qualificationValidityWindowReady);
  if (!productionGenericCapabilityReady) {
    blockers.push('autonomous_research_production_generic_capability_required');
  }
  if (!fullReadinessVerified) {
    blockers.push('autonomous_research_production_full_readiness_required');
  }
  if (production && providerOrMutationRequested && !runtimeValidityWindowReady) {
    blockers.push('autonomous_research_runtime_receipt_validity_window_insufficient');
  }
  if (production && providerOrMutationRequested && !qualificationValidityWindowReady) {
    blockers.push('autonomous_research_qualification_receipt_validity_window_insufficient');
  }

  let maximumAffordableAgentCalls = null;
  if (providerOrMutationRequested) {
    if (!directLocalRunCostWaiverAuthorized) {
      if (providerPricingInspection?.pricingKnown !== true
        || !finitePositive(providerPricingInspection?.maximumCostPerCallUsd)) {
        blockers.push('autonomous_research_provider_pricing_required');
        blockers.push(...(providerPricingInspection?.blockers || []));
      }
    }
    const costCeiling = finitePositive(production
      ? budgets?.maxCostUsd : effectiveBudgets.maxCostUsd);
    if (production && !costCeiling) {
      blockers.push('autonomous_research_production_cost_ceiling_required');
    }
    if (!directLocalRunCostWaiverAuthorized
      && costCeiling && finitePositive(providerPricingInspection?.maximumCostPerCallUsd)) {
      maximumAffordableAgentCalls = Math.floor(
        costCeiling / providerPricingInspection.maximumCostPerCallUsd,
      );
      if (maximumAffordableAgentCalls < 1) {
        blockers.push('autonomous_research_production_cost_ceiling_cannot_fund_one_call');
      } else {
        effectiveBudgets.maxAgentCalls = Math.min(
          effectiveBudgets.maxAgentCalls,
          maximumAffordableAgentCalls,
        );
      }
    }
  }

  const hardBudgetReady = ['maxWallTimeMs', 'maxAgentCalls', 'maxCostUsd']
    .every((key) => finitePositive(effectiveBudgets[key]));
  if (providerOrMutationRequested && !hardBudgetReady) {
    blockers.push('autonomous_research_independent_hard_budget_required');
  }
  const uniqueBlockers = Object.freeze([...new Set(blockers)]);
  const payload = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchLaunchModeGate',
    status: uniqueBlockers.length
      ? 'autonomous_research_launch_mode_blocked'
      : 'autonomous_research_launch_mode_ready',
    launchMode: mode,
    action: normalizedAction,
    localOnly: localOnly === true,
    admissionOnly: admissionOnly === true,
    providerOrMutationRequested,
    goldenBootstrap: mode === AUTONOMOUS_RESEARCH_LAUNCH_MODES.GOLDEN_BOOTSTRAP,
    productionRun: production,
    fullReadinessVerified,
    releaseSignerProductionReady:
      fullResearchReadiness?.researchExecutionReleaseAttestorProductionReady === true,
    productionEnqueueAdmissionReady:
      fullResearchReadiness?.productionEnqueueAdmissionReady === true,
    productionGenericCapabilityReady,
    runtimeImageReproducibilityReady:
      fullResearchReadiness?.runtimeImageReproducibilityReady === true,
    requiredReceiptValidityMs: requiredValidityMs,
    runtimeRemainingValidityMs,
    qualificationRemainingValidityMs,
    runtimeValidityWindowReady,
    qualificationValidityWindowReady,
    providerPricingKnown: providerPricingInspection?.pricingKnown === true,
    providerPricingInspectionHash:
      providerPricingInspection?.autonomousResearchProviderPricingInspectionHash || null,
    maximumCostPerCallUsd: providerPricingInspection?.maximumCostPerCallUsd || null,
    providerCanaryPairMaximumCostUsd:
      providerPricingInspection?.providerCanaryPairMaximumCostUsd || null,
    directLocalRunBudgetWaiver: directLocalRunBudgetWaiverActive
      ? directLocalRunBudgetWaiver : null,
    directLocalRunBudgetWaiverHash: directLocalRunBudgetWaiverActive
      ? directLocalRunBudgetWaiver[DIRECT_LOCAL_RUN_BUDGET_WAIVER_HASH_FIELD] : null,
    directLocalRunBudgetWaiverActive,
    directLocalRunCliPreflightActive,
    maximumAffordableAgentCalls,
    providerTokenUsageMetered: false,
    tokenBudgetAssurance: 'prompt_only_not_a_hard_provider_limit',
    costBoundViaConfiguredProviderMaximumPerCall:
      providerOrMutationRequested && maximumAffordableAgentCalls !== null,
    effectiveBudgets: Object.freeze({ ...effectiveBudgets }),
    budgetPolicy: directLocalRunBudgetWaiverActive
      ? 'direct-local-run-explicit-token-cost-waiver-v1'
      : production
        ? 'production-priced-cost-ceiling-plus-independent-hard-limits-v1'
        : 'golden-bootstrap-priced-call-cost-and-wall-limits-v2',
    unknownProviderCostTreatedAsUnlimited: directLocalRunCostWaiverAuthorized,
    workspaceMutationPermitted: uniqueBlockers.length === 0 && providerOrMutationRequested,
    storeMutationPermitted: uniqueBlockers.length === 0 && providerOrMutationRequested,
    providerExecutionPermitted: admissionOnly !== true
      && uniqueBlockers.length === 0 && providerOrMutationRequested,
    blockers: uniqueBlockers,
  });
  return Object.freeze({
    ...payload,
    autonomousResearchLaunchModeGateHash:
      hashRecord('AutonomousResearchLaunchModeGate', payload),
  });
}
