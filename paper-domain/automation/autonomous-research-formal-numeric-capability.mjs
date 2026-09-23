import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_REGISTRY,
  verifyAutonomousEmpiricalFamilyPluginRegistry,
} from './autonomous-empirical-family-plugin-registry.mjs';
import {
  TYPED_NUMERIC_ORACLE_TYPES,
} from '../research/typed-numeric-oracle-certificate.mjs';
import {
  TYPED_THEOREM_DSL_DOMAIN_CAPABILITIES,
} from '../research/typed-theorem-dsl.mjs';

export const AUTONOMOUS_TYPED_NUMERIC_ORACLE_TYPES = TYPED_NUMERIC_ORACLE_TYPES;

export const AUTONOMOUS_FORMAL_CLAIM_CLASSES = Object.freeze([
  'dynamic-lean-type-v1',
  'registered-template-v1',
]);

export const AUTONOMOUS_ADVANCED_TYPED_NUMERIC_ORACLE_TYPES = Object.freeze([
  'condition-number-bound-v1',
  'convergence-rate-bound-v1',
  'error-bound-v1',
  'optimality-gap-bound-v1',
]);

export const AUTONOMOUS_FORMAL_PROOF_VERIFICATION_MODES = Object.freeze([
  'fresh-lean-replay-v1',
  'independent-formal-semantic-review-v1',
  'kernel-bound-readable-proof-explanation-v1',
  'lean-kernel-check-v1',
]);

const KNOWN_ORACLE_TYPES = new Set(TYPED_NUMERIC_ORACLE_TYPES);
const KNOWN_FORMAL_CLAIM_CLASSES = new Set(AUTONOMOUS_FORMAL_CLAIM_CLASSES);

function uniqueKnownIds(values, known, errorCode) {
  if (!Array.isArray(values) || values.length < 1 || values.length > 256) {
    throw new Error(errorCode);
  }
  const selected = values.map((value) => String(value || '').trim());
  if (selected.some((value) => !known.has(value))
    || new Set(selected).size !== selected.length) {
    throw new Error(errorCode);
  }
  return Object.freeze([...selected].sort());
}

function familyCapability(profile) {
  const typedNumericOracleKinds = uniqueKnownIds(
    profile.typedOracleKinds,
    KNOWN_ORACLE_TYPES,
    'autonomous_research_numeric_oracle_profile_invalid',
  );
  const advancedTypedNumericOracleKinds = Object.freeze(
    AUTONOMOUS_ADVANCED_TYPED_NUMERIC_ORACLE_TYPES.filter((kind) => (
      typedNumericOracleKinds.includes(kind)
    )),
  );
  const payload = {
    benchmarkFamily: profile.benchmarkFamily,
    profileId: profile.profileId,
    profileHash: profile.autonomousEmpiricalFamilyPluginProfileHash,
    typedNumericOracleKinds,
    advancedTypedNumericOracleKinds,
    advancedNumericalAnalysisCovered:
      advancedTypedNumericOracleKinds.length
        === AUTONOMOUS_ADVANCED_TYPED_NUMERIC_ORACLE_TYPES.length,
  };
  return Object.freeze({
    ...payload,
    autonomousResearchEmpiricalFamilyNumericCapabilityHash: hashRecord(
      'AutonomousResearchEmpiricalFamilyNumericCapability',
      payload,
    ),
  });
}

export function buildAutonomousResearchFormalNumericCapability({
  formalClaimClasses,
  empiricalFamilies,
  empiricalRegistry = AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_REGISTRY,
} = {}) {
  const claims = uniqueKnownIds(
    formalClaimClasses,
    KNOWN_FORMAL_CLAIM_CLASSES,
    'autonomous_research_formal_claim_class_invalid',
  );
  if (!verifyAutonomousEmpiricalFamilyPluginRegistry(empiricalRegistry)) {
    throw new Error('autonomous_research_numeric_empirical_registry_invalid');
  }
  const registeredFamilies = new Map(empiricalRegistry.profiles.map((profile) => (
    [profile.benchmarkFamily, profile]
  )));
  const families = Array.isArray(empiricalFamilies)
    ? Object.freeze([...new Set(empiricalFamilies.map((value) => String(value || '').trim()))]
      .sort())
    : null;
  if (!families || families.length < 1 || families.length !== empiricalFamilies.length
    || families.some((family) => !registeredFamilies.has(family))) {
    throw new Error('autonomous_research_numeric_empirical_family_invalid');
  }
  const empiricalFamilyCapabilities = Object.freeze(families.map((family) => (
    familyCapability(registeredFamilies.get(family))
  )));
  const dynamicFormalClaimAuthoringSupported = claims.includes('dynamic-lean-type-v1');
  const formalProofVerificationModes = Object.freeze([
    ...AUTONOMOUS_FORMAL_PROOF_VERIFICATION_MODES,
    ...(dynamicFormalClaimAuthoringSupported
      ? ['agent-authored-lean-proof-repair-v1'] : []),
  ].sort());
  const advancedNumericalAnalysisFamilies = Object.freeze(
    empiricalFamilyCapabilities
      .filter((capability) => capability.advancedNumericalAnalysisCovered)
      .map((capability) => capability.benchmarkFamily),
  );
  const payload = {
    version: 1,
    kind: 'AutonomousResearchFormalNumericCapability',
    formalClaimClasses: claims,
    formalProofVerificationModes,
    dynamicFormalClaimAuthoringSupported,
    dynamicFormalTypedDslDomainCapabilities: dynamicFormalClaimAuthoringSupported
      ? TYPED_THEOREM_DSL_DOMAIN_CAPABILITIES : Object.freeze([]),
    dynamicFormalReadableProofExplanationSupported: dynamicFormalClaimAuthoringSupported,
    theoremDiscoveryGuaranteed: false,
    openWorldTheoremDiscoveryClaimed: false,
    empiricalPluginRegistryHash:
      empiricalRegistry.autonomousEmpiricalFamilyPluginRegistryHash,
    empiricalFamilyCapabilities,
    advancedTypedNumericOracleKinds:
      AUTONOMOUS_ADVANCED_TYPED_NUMERIC_ORACLE_TYPES,
    advancedNumericalAnalysisFamilies,
    allSelectedEmpiricalFamiliesAdvancedNumericalAnalysisCovered:
      advancedNumericalAnalysisFamilies.length === empiricalFamilyCapabilities.length,
  };
  return Object.freeze({
    ...payload,
    autonomousResearchFormalNumericCapabilityHash: hashRecord(
      'AutonomousResearchFormalNumericCapability',
      payload,
    ),
  });
}

export function verifyAutonomousResearchFormalNumericCapability(value, {
  empiricalRegistry = AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_REGISTRY,
} = {}) {
  try {
    return JSON.stringify(buildAutonomousResearchFormalNumericCapability({
      formalClaimClasses: value?.formalClaimClasses,
      empiricalFamilies: value?.empiricalFamilyCapabilities
        ?.map((capability) => capability.benchmarkFamily),
      empiricalRegistry,
    })) === JSON.stringify(value);
  } catch {
    return false;
  }
}
