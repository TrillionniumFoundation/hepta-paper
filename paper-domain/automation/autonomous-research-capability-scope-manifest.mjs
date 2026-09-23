import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_PACKAGE,
  AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_REGISTRY,
  AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_STARTUP_INSPECTION,
  AUTONOMOUS_EMPIRICAL_PLUGIN_PROTOCOL_FAMILIES,
} from './autonomous-empirical-family-plugin-registry.mjs';
import {
  AUTONOMOUS_ANALYSIS_KERNEL_ABI,
  AUTONOMOUS_LANGUAGE_RUNTIME_KERNEL_REGISTRY,
} from './autonomous-language-runtime-kernel-registry.mjs';
import {
  AUTONOMOUS_ADVANCED_TYPED_NUMERIC_ORACLE_TYPES,
  AUTONOMOUS_FORMAL_CLAIM_CLASSES,
  AUTONOMOUS_TYPED_NUMERIC_ORACLE_TYPES,
  buildAutonomousResearchFormalNumericCapability,
  verifyAutonomousResearchFormalNumericCapability,
} from './autonomous-research-formal-numeric-capability.mjs';

export const AUTONOMOUS_EMPIRICAL_RUNTIME_REGISTRY_SCOPE =
  'empirical-analysis-python-r-only-v1';

const AGENDA_MODES = new Set(['machine-generated', 'registered-profile']);
const MANUSCRIPT_MODES = new Set([
  'agent-authored-evidence-bound-ir-v1',
  'minimal-report-evidence-bound-ir-v1',
  // Compatibility only. This legacy mode never qualifies as generic capability.
  'evidence-bound-ir-v1',
  'fixed-neutral-v2',
]);
export const STRONG_PRIOR_ART_CAPABILITY_MODE =
  'structured-ranked-deduplicated-v2';
const PRIOR_ART_MODES = new Set([
  'opaque-hash-v1',
  // Compatibility-only: structurally verified but unranked and not sufficient
  // for strong production research.
  'structured-receipt-v1',
  STRONG_PRIOR_ART_CAPABILITY_MODE,
]);
const REPLAY_MODES = new Set(['external-trust-domain-v1', 'same-process-recomputation-v1']);
const VENUE_MODES = new Set(['disabled', 'profile-selected-v1', 'submission-enabled-v1']);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$/;

function uniqueIds(values, { minimum = 0, maximum = 256 } = {}) {
  if (!Array.isArray(values) || values.length < minimum || values.length > maximum) return null;
  const ids = values.map((value) => String(value || '').trim());
  if (ids.some((value) => !SAFE_ID.test(value)) || new Set(ids).size !== ids.length) return null;
  return Object.freeze([...ids].sort());
}

export function buildAutonomousResearchCapabilityScopeManifest({
  scopeId = 'hepta.autonomous-research.declared-capability.v1',
  agendaMode = 'registered-profile',
  manuscriptMode = 'minimal-report-evidence-bound-ir-v1',
  formalClaimClasses = ['registered-template-v1'],
  empiricalFamilies = [],
  empiricalFamilyPluginRegistryHash =
    AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_REGISTRY
      .autonomousEmpiricalFamilyPluginRegistryHash,
  empiricalFamilyPluginPackageHash =
    AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_PACKAGE
      .autonomousEmpiricalFamilyPluginPackageHash,
  empiricalFamilyPluginStartupInspectionHash =
    AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_STARTUP_INSPECTION
      .autonomousEmpiricalFamilyPluginStartupInspectionHash,
  empiricalPluginStartupAuthorityVerified =
    AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_STARTUP_INSPECTION.signatureVerified,
  empiricalRuntimeRegistryScope = AUTONOMOUS_EMPIRICAL_RUNTIME_REGISTRY_SCOPE,
  empiricalLanguageRuntimeKernelRegistryHash =
    AUTONOMOUS_LANGUAGE_RUNTIME_KERNEL_REGISTRY
      .autonomousLanguageRuntimeKernelRegistryHash,
  empiricalAnalysisKernelAbiHash = AUTONOMOUS_ANALYSIS_KERNEL_ABI.analysisKernelAbiHash,
  priorArtMode = 'opaque-hash-v1',
  reviewerPrincipalCount = 1,
  reviewerTrustDomainCount = 1,
  replayMode = 'same-process-recomputation-v1',
  venueMode = 'disabled',
  zeroRuntimeHumanIntervention = true,
  externalPrerequisites = [],
} = {}) {
  const selectedScopeId = String(scopeId || '').trim();
  const claims = uniqueIds(formalClaimClasses, { minimum: 1 });
  const families = uniqueIds(empiricalFamilies, { minimum: 1 });
  const registeredFamilies = new Set(AUTONOMOUS_EMPIRICAL_PLUGIN_PROTOCOL_FAMILIES);
  const prerequisites = uniqueIds(externalPrerequisites);
  if (!SAFE_ID.test(selectedScopeId) || !AGENDA_MODES.has(agendaMode)
    || !MANUSCRIPT_MODES.has(manuscriptMode) || !claims || !families
    || claims.some((claim) => !AUTONOMOUS_FORMAL_CLAIM_CLASSES.includes(claim))
    || families.some((family) => !registeredFamilies.has(family))
    || empiricalFamilyPluginRegistryHash
      !== AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_REGISTRY
        .autonomousEmpiricalFamilyPluginRegistryHash
    || empiricalFamilyPluginPackageHash
      !== AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_PACKAGE
        .autonomousEmpiricalFamilyPluginPackageHash
    || empiricalFamilyPluginStartupInspectionHash
      !== AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_STARTUP_INSPECTION
        .autonomousEmpiricalFamilyPluginStartupInspectionHash
    || empiricalPluginStartupAuthorityVerified !== true
    || empiricalRuntimeRegistryScope !== AUTONOMOUS_EMPIRICAL_RUNTIME_REGISTRY_SCOPE
    || empiricalLanguageRuntimeKernelRegistryHash
      !== AUTONOMOUS_LANGUAGE_RUNTIME_KERNEL_REGISTRY
        .autonomousLanguageRuntimeKernelRegistryHash
    || empiricalAnalysisKernelAbiHash !== AUTONOMOUS_ANALYSIS_KERNEL_ABI.analysisKernelAbiHash
    || !PRIOR_ART_MODES.has(priorArtMode)
    || !Number.isSafeInteger(reviewerPrincipalCount) || reviewerPrincipalCount < 1
    || reviewerPrincipalCount > 16
    || !Number.isSafeInteger(reviewerTrustDomainCount) || reviewerTrustDomainCount < 1
    || reviewerTrustDomainCount > reviewerPrincipalCount
    || !REPLAY_MODES.has(replayMode) || !VENUE_MODES.has(venueMode)
    || zeroRuntimeHumanIntervention !== true || !prerequisites) {
    throw new Error('autonomous_research_capability_scope_manifest_invalid');
  }
  const formalNumericCapability = buildAutonomousResearchFormalNumericCapability({
    formalClaimClasses: claims,
    empiricalFamilies: families,
  });
  const genericDeclaredCapability = agendaMode === 'machine-generated'
    && manuscriptMode === 'agent-authored-evidence-bound-ir-v1'
    && claims.includes('dynamic-lean-type-v1')
    && priorArtMode === STRONG_PRIOR_ART_CAPABILITY_MODE
    && reviewerPrincipalCount >= 1
    && reviewerTrustDomainCount >= 1
    && replayMode === 'external-trust-domain-v1'
    && venueMode === 'submission-enabled-v1'
    && empiricalPluginStartupAuthorityVerified === true
    && prerequisites.length === 0;
  // This proves that a configured scope selects all required operating modes.
  // It is not evidence of open-domain scientific capability. Keep the legacy
  // field as a compatibility alias while readiness consumers migrate to the
  // explicit configured-scope name.
  const configuredScopeReady = genericDeclaredCapability;
  const advancedNumericalAnalysisDeclaredCapability =
    formalNumericCapability
      .allSelectedEmpiricalFamiliesAdvancedNumericalAnalysisCovered;
  const generalPurposeFormalNumericalCapability = genericDeclaredCapability
    && advancedNumericalAnalysisDeclaredCapability;
  const payload = {
    version: 2,
    kind: 'AutonomousResearchCapabilityScopeManifest',
    status: configuredScopeReady
      ? 'configured_scope_autonomous_research_ready'
      : 'bounded_profile_autonomous_research_scope_ready',
    scopeId: selectedScopeId,
    agendaMode,
    manuscriptMode,
    formalClaimClasses: claims,
    empiricalFamilies: families,
    empiricalFamilyPluginRegistryHash,
    empiricalFamilyPluginPackageHash,
    empiricalFamilyPluginStartupInspectionHash,
    empiricalPluginStartupAuthorityVerified: true,
    empiricalRuntimeRegistryScope,
    empiricalLanguageRuntimeKernelRegistryHash,
    empiricalAnalysisKernelAbiHash,
    formalAndManuscriptRuntimeQualificationCoveredByEmpiricalRegistry: false,
    formalNumericCapability,
    formalNumericCapabilityHash:
      formalNumericCapability.autonomousResearchFormalNumericCapabilityHash,
    kernelCheckedFormalProofDeclaredCapability:
      formalNumericCapability.formalProofVerificationModes
        .includes('lean-kernel-check-v1'),
    advancedNumericalAnalysisDeclaredCapability,
    generalPurposeFormalNumericalCapability,
    priorArtMode,
    reviewerPrincipalCount,
    reviewerTrustDomainCount,
    replayMode,
    venueMode,
    zeroRuntimeHumanIntervention: true,
    configuredScopeReady,
    genericDeclaredCapability,
    genericDomainCapabilityReady: false,
    genericDomainCapabilityEvidenceRequired: true,
    universalDomainCoverageClaimed: false,
    objectiveNoveltyGuaranteed: false,
    scientificTruthGuaranteed: false,
    theoremDiscoveryGuaranteed: false,
    venueAcceptanceGuaranteed: false,
    externalPrerequisites: prerequisites,
  };
  return Object.freeze({
    ...payload,
    autonomousResearchCapabilityScopeManifestHash:
      hashRecord('AutonomousResearchCapabilityScopeManifest', payload),
  });
}

export function verifyAutonomousResearchCapabilityScopeManifest(manifest) {
  let rebuilt = null;
  try { rebuilt = buildAutonomousResearchCapabilityScopeManifest(manifest); }
  catch { return false; }
  return verifyAutonomousResearchFormalNumericCapability(
    manifest?.formalNumericCapability,
  ) && JSON.stringify(rebuilt) === JSON.stringify(manifest);
}

export function evaluateAutonomousResearchCapabilityRequestCoverage({
  manifest,
  requestedProtocolFamily,
  requireMachineGeneratedAgenda = false,
  requireDynamicFormalClaims = false,
  requireStructuredPriorArt = false,
  requiredReviewerTrustDomains = 1,
  requireExternalReplay = false,
  requireVenueProfile = false,
  requireKernelCheckedFormalProof = false,
  requireIndependentFormalReview = false,
  requireFreshFormalReplay = false,
  requireAdvancedNumericalAnalysis = false,
  requiredTypedNumericOracleKinds = [],
} = {}) {
  const blockers = [];
  if (!verifyAutonomousResearchCapabilityScopeManifest(manifest)) {
    blockers.push('autonomous_research_capability_scope_manifest_invalid');
  }
  if (requestedProtocolFamily
    && !manifest?.empiricalFamilies?.includes(requestedProtocolFamily)) {
    blockers.push('autonomous_research_capability_protocol_family_not_covered');
  }
  if (requireMachineGeneratedAgenda && manifest?.agendaMode !== 'machine-generated') {
    blockers.push('autonomous_research_capability_machine_agenda_not_covered');
  }
  if (requireDynamicFormalClaims
    && !manifest?.formalClaimClasses?.includes('dynamic-lean-type-v1')) {
    blockers.push('autonomous_research_capability_dynamic_formal_claim_not_covered');
  }
  if (requireStructuredPriorArt
    && manifest?.priorArtMode !== STRONG_PRIOR_ART_CAPABILITY_MODE) {
    blockers.push('autonomous_research_capability_structured_prior_art_not_covered');
  }
  if (!Number.isSafeInteger(requiredReviewerTrustDomains)
    || requiredReviewerTrustDomains < 1
    || Number(manifest?.reviewerTrustDomainCount || 0) < requiredReviewerTrustDomains) {
    blockers.push('autonomous_research_capability_reviewer_trust_domains_not_covered');
  }
  if (requireExternalReplay && manifest?.replayMode !== 'external-trust-domain-v1') {
    blockers.push('autonomous_research_capability_external_replay_not_covered');
  }
  if (requireVenueProfile && manifest?.venueMode === 'disabled') {
    blockers.push('autonomous_research_capability_venue_profile_not_covered');
  }
  const formalModes = manifest?.formalNumericCapability?.formalProofVerificationModes || [];
  if (requireKernelCheckedFormalProof && !formalModes.includes('lean-kernel-check-v1')) {
    blockers.push('autonomous_research_capability_lean_kernel_proof_not_covered');
  }
  if (requireIndependentFormalReview
    && !formalModes.includes('independent-formal-semantic-review-v1')) {
    blockers.push('autonomous_research_capability_independent_formal_review_not_covered');
  }
  if (requireFreshFormalReplay && !formalModes.includes('fresh-lean-replay-v1')) {
    blockers.push('autonomous_research_capability_fresh_formal_replay_not_covered');
  }
  const requestedOracleKinds = Array.isArray(requiredTypedNumericOracleKinds)
    ? [...new Set(requiredTypedNumericOracleKinds.map((value) => String(value || '').trim()))]
      .sort()
    : null;
  if (!requestedOracleKinds
    || requestedOracleKinds.length !== requiredTypedNumericOracleKinds.length
    || requestedOracleKinds.some((kind) => (
      !AUTONOMOUS_TYPED_NUMERIC_ORACLE_TYPES.includes(kind)
    ))) {
    blockers.push('autonomous_research_capability_numeric_oracle_request_invalid');
  }
  const requiredOracleKinds = requestedOracleKinds
    ? Object.freeze([...new Set([
      ...requestedOracleKinds,
      ...(requireAdvancedNumericalAnalysis
        ? AUTONOMOUS_ADVANCED_TYPED_NUMERIC_ORACLE_TYPES : []),
    ])].sort())
    : Object.freeze([]);
  const requestedFamilyCapability = manifest?.formalNumericCapability
    ?.empiricalFamilyCapabilities?.find((capability) => (
      capability.benchmarkFamily === requestedProtocolFamily
    )) || null;
  if (requiredOracleKinds.length > 0 && !requestedProtocolFamily) {
    blockers.push('autonomous_research_capability_numeric_protocol_family_required');
  }
  if (requiredOracleKinds.length > 0 && requestedProtocolFamily
    && !requestedFamilyCapability) {
    blockers.push('autonomous_research_capability_numeric_protocol_family_not_covered');
  }
  for (const oracleKind of requiredOracleKinds) {
    if (requestedFamilyCapability
      && !requestedFamilyCapability.typedNumericOracleKinds.includes(oracleKind)) {
      blockers.push(`autonomous_research_capability_numeric_oracle_not_covered:${oracleKind}`);
    }
  }
  const uniqueBlockers = Object.freeze([...new Set(blockers)]);
  return Object.freeze({
    ready: uniqueBlockers.length === 0,
    status: uniqueBlockers.length
      ? 'autonomous_research_capability_request_not_covered'
      : 'autonomous_research_capability_request_covered',
    scopeManifestHash: manifest?.autonomousResearchCapabilityScopeManifestHash || null,
    requestedProtocolFamily: requestedProtocolFamily || null,
    requiredTypedNumericOracleKinds: requiredOracleKinds,
    coveredTypedNumericOracleKinds: Object.freeze([
      ...(requestedFamilyCapability?.typedNumericOracleKinds || []),
    ]),
    blockers: uniqueBlockers,
  });
}
