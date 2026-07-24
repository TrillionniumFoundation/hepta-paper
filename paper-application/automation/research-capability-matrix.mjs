import {
  AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_PRODUCTION_PROFILES,
} from '../../paper-domain/automation/autonomous-empirical-family-plugin-registry.mjs';
import {
  AUTONOMOUS_FORMAL_SUPPORT_TEMPLATE_REGISTRY,
} from '../../paper-domain/automation/autonomous-formal-support-registry.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const PROOF_SEARCH_STRATEGIES = Object.freeze([
  'direct_elaboration',
  'mathlib_retrieval',
  'bounded_refutation_or_synthesis',
]);

function capability({
  id,
  implemented,
  qualified,
  productionReady,
  scope,
  blockers = [],
  limitations = [],
}) {
  return Object.freeze({
    id,
    implemented: implemented === true,
    qualified: qualified === true,
    productionReady: productionReady === true,
    scope: Object.freeze(scope),
    blockers: Object.freeze([...new Set(blockers.filter(Boolean))].sort()),
    limitations: Object.freeze([...limitations]),
  });
}

export function buildResearchCapabilityMatrix(readiness = {}) {
  const empiricalProfiles = AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_PRODUCTION_PROFILES;
  const formalTemplates = AUTONOMOUS_FORMAL_SUPPORT_TEMPLATE_REGISTRY.entries || [];
  const runtimeLanguages = Object.entries(readiness.runtimes || {})
    .filter(([, inspection]) => inspection?.usable === true)
    .map(([language]) => language)
    .filter((language) => ['python', 'node', 'r', 'julia', 'lean', 'latex'].includes(language))
    .sort();
  const genericBlockers = Array.isArray(readiness.genericDomainCapabilityBlockers)
    ? readiness.genericDomainCapabilityBlockers : [];
  const capabilities = Object.freeze([
    capability({
      id: 'theorem-specification',
      implemented: true,
      qualified: readiness.genericDomainCapabilityReady === true,
      productionReady: readiness.genericResearchReady === true,
      scope: {
        claimAuthorityModes: Object.freeze(['operator-signed', 'machine-policy-authorized']),
        formalizationTarget: 'lean4',
        registeredFormalTemplateCount: formalTemplates.length,
      },
      blockers: genericBlockers,
      limitations: [
        'natural-language-to-Lean semantic equivalence requires independent review',
        'theorem generation is bounded by authorized claim lineage and registered formal scope',
      ],
    }),
    capability({
      id: 'formal-proof-search',
      implemented: true,
      qualified: readiness.dynamicFormalProjectClosureReady === true,
      productionReady: readiness.genericDomainCapabilityReady === true
        && readiness.dynamicFormalProjectClosureReady === true,
      scope: {
        strategies: PROOF_SEARCH_STRATEGIES,
        kernel: 'lean4',
        freshReplayRequired: true,
      },
      blockers: [
        ...(readiness.dynamicFormalProjectClosure?.blockers || []),
        ...genericBlockers.filter((blocker) => blocker.includes('formal')),
      ],
      limitations: [
        'machine search applies only when the exact Lean type compiles to the typed theorem DSL',
        'search exhaustion emits a failure certificate and never establishes truth',
      ],
    }),
    capability({
      id: 'empirical-code-execution',
      implemented: true,
      qualified: readiness.academicEmpiricalReady === true,
      productionReady: readiness.academicEmpiricalReady === true
        && readiness.genericDomainCapabilityReady === true,
      scope: {
        benchmarkFamilies: Object.freeze(empiricalProfiles
          .map((profile) => profile.benchmarkFamily).sort()),
        runtimeLanguages: Object.freeze(runtimeLanguages),
      },
      blockers: genericBlockers.filter((blocker) => (
        blocker.includes('experiment') || blocker.includes('replay')
      )),
      limitations: [
        'production evidence is limited to registered and authority-backed experiment families',
        'generated code is evidence only after isolated execution and accepted replay',
      ],
    }),
    capability({
      id: 'typed-numerical-analysis',
      implemented: true,
      qualified: readiness.academicEmpiricalReady === true,
      productionReady: readiness.academicEmpiricalReady === true
        && readiness.genericDomainCapabilityReady === true,
      scope: {
        benchmarkFamilies: Object.freeze(empiricalProfiles
          .map((profile) => profile.benchmarkFamily).sort()),
        typedOracleKinds: Object.freeze([...new Set(empiricalProfiles
          .flatMap((profile) => profile.typedOracleKinds))].sort()),
        independentProcessRecomputationRequired: true,
      },
      blockers: genericBlockers.filter((blocker) => (
        blocker.includes('experiment') || blocker.includes('replay')
      )),
      limitations: [
        'arbitrary statistical or numerical procedures outside a registered oracle ABI are unsupported',
        'numeric agreement does not establish scientific validity or external validity',
      ],
    }),
    capability({
      id: 'autonomous-manuscript-release',
      implemented: true,
      qualified: readiness.fullResearchQualificationReady === true,
      productionReady: readiness.fullAutomaticResearchWritingReady === true,
      scope: {
        evidenceBoundManuscript: true,
        independentPdfRebuildRequired: true,
        refereeConvergenceRequired: true,
      },
      blockers: readiness.fullResearchQualificationBlockers || [],
      limitations: [
        'release readiness requires current independent qualification and reproducibility evidence',
      ],
    }),
    capability({
      id: 'live-submission',
      implemented: readiness.autonomousSubmissionHandoffReady === true,
      qualified: readiness.autonomousSubmissionDispatcherReady === true,
      productionReady: readiness.autonomousSubmissionDispatcherReady === true,
      scope: {
        localHandoffReady: readiness.autonomousSubmissionHandoffReady === true,
        liveDispatcherReady: readiness.autonomousSubmissionDispatcherReady === true,
      },
      blockers: readiness.autonomousSubmissionDispatcherReadiness?.blockers || [],
      limitations: [
        'local release handoff is not external portal submission authority',
      ],
    }),
  ]);
  const payload = {
    version: 1,
    kind: 'ResearchCapabilityMatrix',
    status: capabilities.every((entry) => entry.productionReady)
      ? 'research_capabilities_production_ready'
      : 'research_capabilities_bounded_or_blocked',
    universalResearchClaimed: false,
    fullyAutonomousProductionReady: readiness.productionReady === true
      && readiness.fullAutomaticResearchWritingReady === true,
    capabilities,
  };
  return Object.freeze({
    ...payload,
    researchCapabilityMatrixHash: hashRecord('ResearchCapabilityMatrix', payload),
  });
}
