import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_BUILTIN_RAW_PROFILES,
  AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_REGISTRY,
  autonomousEmpiricalFamilyPluginProfileFor,
  compileAutonomousEmpiricalFamilyPluginRegistry,
  verifyAutonomousEmpiricalFamilyPluginRegistry,
} from '../../paper-domain/automation/autonomous-empirical-family-plugin-registry.mjs';
import {
  buildAutonomousResearchCapabilityScopeManifest,
  evaluateAutonomousResearchCapabilityRequestCoverage,
  verifyAutonomousResearchCapabilityScopeManifest,
} from '../../paper-domain/automation/autonomous-research-capability-scope-manifest.mjs';
import {
  AUTONOMOUS_ADVANCED_TYPED_NUMERIC_ORACLE_TYPES,
  AUTONOMOUS_TYPED_NUMERIC_ORACLE_TYPES,
  buildAutonomousResearchFormalNumericCapability,
  verifyAutonomousResearchFormalNumericCapability,
} from '../../paper-domain/automation/autonomous-research-formal-numeric-capability.mjs';
import {
  buildTypedNumericOracleCertificate,
  buildTypedNumericOracleCertificateSet,
  verifyTypedNumericOracleCertificateSet,
} from '../../paper-domain/research/typed-numeric-oracle-certificate.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

function digest(label) {
  return hashRecord('AutonomousResearchGeneralizationFixture', { label });
}

test('versioned empirical plugins, typed numeric oracles, and capability coverage are hash bound', () => {
  assert.equal(verifyAutonomousEmpiricalFamilyPluginRegistry(
    AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_REGISTRY,
  ), true);
  const family = autonomousEmpiricalFamilyPluginProfileFor(
    'rl_stochastic_control_benchmark',
  );
  assert.equal(family.productionExecutable, true);
  assert.deepEqual(family.typedOracleKinds, [
    'property-oracle-v1',
    'residual-bound-v1',
  ]);

  const certificate = buildTypedNumericOracleCertificate({
    certificateId: 'residual-certificate-1',
    oracleType: 'residual-bound-v1',
    subjectHash: digest('numeric-subject'),
    quantity: 'maximum_residual',
    observedValue: 0.01,
    relation: 'less-than-or-equal',
    upperBound: 0.05,
    unit: 'absolute',
    verifierId: 'independent-numeric-verifier-v1',
    producerImplementationHash: digest('numeric-producer-implementation'),
    verifierImplementationHash: digest('numeric-implementation'),
    verificationReceiptHash: digest('numeric-verification'),
    evidenceHashes: [digest('numeric-evidence')],
    assuranceScope: 'repository-separate-implementation-same-process-v1',
  });
  assert.equal(certificate.version, 2);
  assert.equal(certificate.independentlyRecomputed, true);
  assert.equal(certificate.processIndependent, false);
  assert.equal(certificate.externalTrustDomainVerified, false);
  assert.notEqual(
    certificate.producerImplementationHash,
    certificate.verifierImplementationHash,
  );
  assert.throws(() => buildTypedNumericOracleCertificate({
    ...certificate,
    producerImplementationHash: certificate.verifierImplementationHash,
  }), /typed_numeric_oracle_certificate_invalid/);
  const certificateSet = buildTypedNumericOracleCertificateSet({
    analysisProtocolHash: digest('analysis-protocol'),
    experimentAttemptId: 'experiment-attempt-1',
    sourceLineageHash: digest('numeric-source-lineage'),
    requiredOracleTypes: ['residual-bound-v1'],
    certificates: [certificate],
  });
  assert.equal(verifyTypedNumericOracleCertificateSet(certificateSet), true);

  const manifest = buildAutonomousResearchCapabilityScopeManifest({
    agendaMode: 'machine-generated',
    manuscriptMode: 'agent-authored-evidence-bound-ir-v1',
    formalClaimClasses: ['dynamic-lean-type-v1', 'registered-template-v1'],
    empiricalFamilies: ['rl_stochastic_control_benchmark'],
    priorArtMode: 'structured-ranked-deduplicated-v2',
    reviewerPrincipalCount: 3,
    reviewerTrustDomainCount: 3,
    replayMode: 'external-trust-domain-v1',
    venueMode: 'submission-enabled-v1',
  });
  assert.equal(verifyAutonomousResearchCapabilityScopeManifest(manifest), true);
  assert.equal(manifest.version, 2);
  assert.equal(manifest.configuredScopeReady, true);
  assert.equal(manifest.genericDeclaredCapability, true);
  assert.equal(manifest.genericDomainCapabilityReady, false);
  assert.equal(manifest.genericDomainCapabilityEvidenceRequired, true);
  assert.equal(manifest.kernelCheckedFormalProofDeclaredCapability, true);
  assert.equal(manifest.advancedNumericalAnalysisDeclaredCapability, false);
  assert.equal(manifest.generalPurposeFormalNumericalCapability, false);
  assert.equal(manifest.theoremDiscoveryGuaranteed, false);
  assert.equal(verifyAutonomousResearchFormalNumericCapability(
    manifest.formalNumericCapability,
  ), true);
  assert.equal(manifest.universalDomainCoverageClaimed, false);
  assert.equal(evaluateAutonomousResearchCapabilityRequestCoverage({
    manifest,
    requestedProtocolFamily: 'rl_stochastic_control_benchmark',
    requireMachineGeneratedAgenda: true,
    requireDynamicFormalClaims: true,
    requireStructuredPriorArt: true,
    requiredReviewerTrustDomains: 3,
    requireExternalReplay: true,
    requireVenueProfile: true,
    requireKernelCheckedFormalProof: true,
    requireIndependentFormalReview: true,
    requireFreshFormalReplay: true,
    requiredTypedNumericOracleKinds: ['property-oracle-v1', 'residual-bound-v1'],
  }).ready, true);
  const advancedCoverage = evaluateAutonomousResearchCapabilityRequestCoverage({
    manifest,
    requestedProtocolFamily: 'rl_stochastic_control_benchmark',
    requireAdvancedNumericalAnalysis: true,
  });
  assert.equal(advancedCoverage.ready, false);
  assert.deepEqual(advancedCoverage.requiredTypedNumericOracleKinds,
    AUTONOMOUS_ADVANCED_TYPED_NUMERIC_ORACLE_TYPES);
  assert.equal(advancedCoverage.blockers.length,
    AUTONOMOUS_ADVANCED_TYPED_NUMERIC_ORACLE_TYPES.length);

  const pluginTamper = structuredClone(AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_REGISTRY);
  pluginTamper.profiles[0].minimumRepetitions += 1;
  assert.equal(verifyAutonomousEmpiricalFamilyPluginRegistry(pluginTamper), false);
  const certificateTamper = structuredClone(certificateSet);
  certificateTamper.certificates[0].observedValue = 100;
  assert.equal(verifyTypedNumericOracleCertificateSet(certificateTamper), false);
  assert.throws(() => buildAutonomousResearchCapabilityScopeManifest({
    empiricalFamilies: ['unregistered-open-world-family'],
  }), /autonomous_research_capability_scope_manifest_invalid/);
  assert.throws(() => buildAutonomousResearchCapabilityScopeManifest({
    formalClaimClasses: ['unregistered-open-world-formal-claim'],
    empiricalFamilies: ['rl_stochastic_control_benchmark'],
  }), /autonomous_research_capability_scope_manifest_invalid/);
});

test('advanced numerical capability is derived from registered oracle coverage', () => {
  const source = AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_BUILTIN_RAW_PROFILES[1];
  const registry = compileAutonomousEmpiricalFamilyPluginRegistry([{
    ...source,
    typedOracleKinds: AUTONOMOUS_TYPED_NUMERIC_ORACLE_TYPES,
  }]);
  const capability = buildAutonomousResearchFormalNumericCapability({
    formalClaimClasses: ['dynamic-lean-type-v1'],
    empiricalFamilies: ['ml_algorithm_benchmark'],
    empiricalRegistry: registry,
  });
  assert.equal(verifyAutonomousResearchFormalNumericCapability(capability, {
    empiricalRegistry: registry,
  }), true);
  assert.equal(capability.dynamicFormalClaimAuthoringSupported, true);
  assert.deepEqual(capability.dynamicFormalTypedDslDomainCapabilities
    .find((entry) => entry.domain === 'Real'), {
    domain: 'Real',
    fragment: 'ordered-ring-polynomial-v1',
    counterexampleSearch: 'bounded-integer-embedding-incomplete-v1',
    requiredImports: ['Mathlib'],
  });
  assert.equal(capability.theoremDiscoveryGuaranteed, false);
  assert.equal(capability
    .allSelectedEmpiricalFamiliesAdvancedNumericalAnalysisCovered, true);
  assert.deepEqual(capability.advancedNumericalAnalysisFamilies,
    ['ml_algorithm_benchmark']);
});
