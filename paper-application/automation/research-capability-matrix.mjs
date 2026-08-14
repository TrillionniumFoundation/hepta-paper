import {
  AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_PRODUCTION_PROFILES,
  AUTONOMOUS_EMPIRICAL_PLUGIN_RUNTIME_LANGUAGES,
} from '../../paper-domain/automation/autonomous-empirical-family-plugin-registry.mjs';
import {
  AUTONOMOUS_FORMAL_SUPPORT_TEMPLATE_REGISTRY,
} from '../../paper-domain/automation/autonomous-formal-support-registry.mjs';
import {
  FORMAL_PROOF_SEARCH_BACKENDS,
  FORMAL_PROOF_SEARCH_STRATEGIES,
} from '../../paper-domain/research/formal-proof-strategy-registry.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const PROOF_SEARCH_STRATEGIES = Object.freeze(FORMAL_PROOF_SEARCH_STRATEGIES
  .map((entry) => entry.strategy));
const PROOF_SEARCH_STRATEGY_CAPABILITIES = Object.freeze(
  FORMAL_PROOF_SEARCH_STRATEGIES.map((entry) => Object.freeze({
    strategy: entry.strategy,
    capabilities: entry.capabilities,
  })),
);
const PROOF_SEARCH_BACKENDS = Object.freeze(FORMAL_PROOF_SEARCH_BACKENDS
  .map((entry) => Object.freeze({
    backend: entry.backend,
    availability: entry.availability,
    executionMode: entry.executionMode,
    productionQualification: entry.productionQualification,
  })));

export const RESEARCH_CAPABILITY_EVIDENCE_LEVELS = Object.freeze([
  Object.freeze({
    id: 'contract_fixture',
    establishes: 'typed contracts and deterministic fixture behavior',
    productionAuthority: false,
  }),
  Object.freeze({
    id: 'real_runtime_fixture',
    establishes: 'the real runtime executes a controlled fixture workload',
    productionAuthority: false,
  }),
  Object.freeze({
    id: 'live_model',
    establishes: 'a current live model executes a hash-bound campaign workload',
    productionAuthority: false,
  }),
  Object.freeze({
    id: 'external_trust',
    establishes: 'an independent external authority accepts current production-bound evidence',
    productionAuthority: true,
  }),
]);

const RESEARCH_CAPABILITY_EVIDENCE_LEVEL_IDS = new Set(
  RESEARCH_CAPABILITY_EVIDENCE_LEVELS.map((entry) => entry.id),
);
const RESEARCH_CAPABILITY_EVIDENCE_LEVEL_RANK = new Map(
  RESEARCH_CAPABILITY_EVIDENCE_LEVELS.map((entry, index) => [entry.id, index]),
);

function strongestEvidenceLevel({
  implemented,
  qualified,
  productionReady,
  liveModelEvidenceReady = false,
  explicitEvidenceLevel = null,
}) {
  if (explicitEvidenceLevel !== null
    && !RESEARCH_CAPABILITY_EVIDENCE_LEVEL_IDS.has(explicitEvidenceLevel)) {
    throw new Error(`research_capability_evidence_level_invalid:${explicitEvidenceLevel}`);
  }
  const inferredEvidenceLevel = productionReady === true
    ? 'external_trust'
    : liveModelEvidenceReady === true
      ? 'live_model'
      : qualified === true
        ? 'real_runtime_fixture'
        : implemented === true
          ? 'contract_fixture'
          : null;
  if (explicitEvidenceLevel === null) return inferredEvidenceLevel;
  if (inferredEvidenceLevel === null
    || RESEARCH_CAPABILITY_EVIDENCE_LEVEL_RANK.get(explicitEvidenceLevel)
      > RESEARCH_CAPABILITY_EVIDENCE_LEVEL_RANK.get(inferredEvidenceLevel)) {
    throw new Error(
      `research_capability_evidence_level_exceeds_readiness:${explicitEvidenceLevel}`,
    );
  }
  return explicitEvidenceLevel;
}

function capability({
  id,
  implemented,
  qualified,
  productionReady,
  scope,
  blockers = [],
  limitations = [],
  liveModelEvidenceReady = false,
  explicitEvidenceLevel = null,
}) {
  const normalizedImplemented = implemented === true;
  const normalizedQualified = qualified === true;
  const normalizedProductionReady = productionReady === true;
  return Object.freeze({
    id,
    implemented: normalizedImplemented,
    qualified: normalizedQualified,
    productionReady: normalizedProductionReady,
    strongestEvidenceLevel: strongestEvidenceLevel({
      implemented: normalizedImplemented,
      qualified: normalizedQualified,
      productionReady: normalizedProductionReady,
      liveModelEvidenceReady,
      explicitEvidenceLevel,
    }),
    scope: Object.freeze(scope),
    blockers: Object.freeze([...new Set(blockers.filter(Boolean))].sort()),
    limitations: Object.freeze([...limitations]),
  });
}

export function buildResearchCapabilityMatrix(readiness = {}) {
  const empiricalProfiles = AUTONOMOUS_EMPIRICAL_FAMILY_PLUGIN_PRODUCTION_PROFILES;
  const formalTemplates = AUTONOMOUS_FORMAL_SUPPORT_TEMPLATE_REGISTRY.entries || [];
  const canonicalReadyLanguages = new Set(
    Array.isArray(readiness.empiricalLanguagesReady)
      ? readiness.empiricalLanguagesReady : [],
  );
  const runtimeLanguages = AUTONOMOUS_EMPIRICAL_PLUGIN_RUNTIME_LANGUAGES
    .filter((language) => (
      canonicalReadyLanguages.has(language)
      || readiness.runtimes?.[language]?.usable === true
      || readiness.runtimes?.images?.[language]?.usable === true
    ));
  const genericBlockers = Array.isArray(readiness.genericDomainCapabilityBlockers)
    ? readiness.genericDomainCapabilityBlockers : [];
  const liveModelEvidenceCapabilityIds = new Set(
    Array.isArray(readiness.liveModelEvidenceCapabilityIds)
      ? readiness.liveModelEvidenceCapabilityIds : [],
  );
  const explicitCapabilityEvidenceLevels =
    readiness.explicitCapabilityEvidenceLevels
      && typeof readiness.explicitCapabilityEvidenceLevels === 'object'
      ? readiness.explicitCapabilityEvidenceLevels : {};
  const submissionReadiness = readiness.autonomousSubmissionDispatcherReadiness || {};
  const submissionHandoffReady = readiness.autonomousSubmissionHandoffReady === true;
  const submissionDispatcherReady = readiness.autonomousSubmissionDispatcherReady === true;
  const submissionProviderDraftReady =
    readiness.autonomousSubmissionProviderDraftReady === true
    || submissionDispatcherReady;
  const gpuScientificRuntimeReady = readiness.gpuScientificRuntimeReady === true;
  const gpuPdeQualified = gpuScientificRuntimeReady
    && readiness.gpuPdeOperationalProofReady === true;
  const gpuPdeProductionReady = gpuPdeQualified
    && readiness.gpuPdeProductionQualificationReady === true
    && readiness.genericDomainCapabilityReady === true;
  const gpuDeepLearningQualified = gpuScientificRuntimeReady
    && readiness.gpuDeepLearningOperationalProofReady === true;
  const gpuDeepLearningProductionReady = gpuDeepLearningQualified
    && readiness.gpuDeepLearningProductionQualificationReady === true
    && readiness.genericDomainCapabilityReady === true;
  const gpuPdeBlockers = [
    ...(!gpuScientificRuntimeReady ? ['gpu_scientific_runtime_not_ready'] : []),
    ...(readiness.gpuPdeOperationalProofReady !== true
      ? ['gpu_pde_operational_proof_not_ready'] : []),
    ...(readiness.gpuPdeProductionQualificationReady !== true
      ? ['gpu_pde_production_qualification_not_ready'] : []),
  ];
  const gpuDeepLearningBlockers = [
    ...(!gpuScientificRuntimeReady ? ['gpu_scientific_runtime_not_ready'] : []),
    ...(readiness.gpuDeepLearningOperationalProofReady !== true
      ? ['gpu_deep_learning_operational_proof_not_ready'] : []),
    ...(readiness.gpuDeepLearningProductionQualificationReady !== true
      ? ['gpu_deep_learning_production_qualification_not_ready'] : []),
  ];
  const capabilityEntry = (definition) => capability({
    ...definition,
    liveModelEvidenceReady:
      liveModelEvidenceCapabilityIds.has(definition.id),
    explicitEvidenceLevel:
      explicitCapabilityEvidenceLevels[definition.id]
      || definition.explicitEvidenceLevel
      || null,
  });
  const capabilities = Object.freeze([
    capabilityEntry({
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
    capabilityEntry({
      id: 'formal-proof-search',
      implemented: true,
      qualified: readiness.dynamicFormalProjectClosureReady === true,
      productionReady: readiness.genericDomainCapabilityReady === true
        && readiness.dynamicFormalProjectClosureReady === true,
      scope: {
        strategies: PROOF_SEARCH_STRATEGIES,
        strategyCapabilities: PROOF_SEARCH_STRATEGY_CAPABILITIES,
        backends: PROOF_SEARCH_BACKENDS,
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
        'Coq and Isabelle remain unavailable until separately qualified adapters exist',
      ],
    }),
    capabilityEntry({
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
    capabilityEntry({
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
    capabilityEntry({
      id: 'gpu-pde-solver',
      implemented: true,
      qualified: gpuPdeQualified,
      productionReady: gpuPdeProductionReady,
      scope: {
        profiles: Object.freeze(['pde_poisson_2d_manufactured_solution_v1']),
        accelerator: 'single-pinned-nvidia-gpu-uuid-v1',
        precision: 'ieee754-binary64',
        independentCpuOracleRequired: true,
        producerDiagnosticsAuthoritative: false,
      },
      blockers: gpuPdeBlockers,
      limitations: [
        'v1 covers a registered structured-grid Poisson problem, not arbitrary PDEs',
        'GPU memory is observed and bounded by problem size but is not a hard VRAM cgroup limit',
        'production promotion requires a fresh independent CPU recomputation for every solve',
      ],
    }),
    capabilityEntry({
      id: 'gpu-deep-learning-training',
      implemented: true,
      qualified: gpuDeepLearningQualified,
      productionReady: gpuDeepLearningProductionReady,
      scope: {
        profiles: Object.freeze(['dl-supervised-classification-gpu-deterministic-v1']),
        accelerator: 'single-pinned-nvidia-gpu-uuid-v1',
        numericMode: 'fp32-tf32-amp-disabled-v1',
        modelAuthority: 'allowlisted-declarative-model-ir-v1',
        hiddenEvaluationAndFreshReplayRequired: true,
      },
      blockers: gpuDeepLearningBlockers,
      limitations: [
        'v1 covers bounded single-GPU MLP training, not arbitrary CNNs or foundation models',
        'same-device replay does not establish cross-device or cross-driver bitwise reproducibility',
        'custom CUDA, arbitrary executable models, pickle checkpoints, AMP, DDP, and NCCL are forbidden',
      ],
    }),
    capabilityEntry({
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
    capabilityEntry({
      id: 'local-submission-handoff',
      implemented: true,
      qualified: submissionHandoffReady,
      productionReady: submissionHandoffReady,
      explicitEvidenceLevel: submissionHandoffReady
        ? 'real_runtime_fixture'
        : null,
      scope: {
        localHandoffReady: submissionHandoffReady,
        externalPortalMutation: false,
      },
      blockers: submissionHandoffReady
        ? [] : submissionReadiness.blockers || [],
      limitations: [
        'a local release handoff grants no external portal authority',
      ],
    }),
    capabilityEntry({
      id: 'submission-provider-draft',
      implemented: true,
      qualified: submissionProviderDraftReady,
      productionReady: submissionProviderDraftReady
        && submissionDispatcherReady,
      scope: {
        portalBindingVerified: submissionReadiness.portalBindingVerified === true,
        providerDraftReady: submissionProviderDraftReady,
        liveCommitAuthorized: false,
      },
      blockers: submissionProviderDraftReady
        ? [] : submissionReadiness.blockers || [],
      limitations: [
        'draft creation is a reversible provider action and is not manuscript submission',
      ],
    }),
    capabilityEntry({
      id: 'live-submission-commit',
      implemented: true,
      qualified: submissionDispatcherReady,
      productionReady: submissionDispatcherReady,
      scope: {
        liveDispatcherReady: submissionDispatcherReady,
        portalBindingVerified: submissionReadiness.portalBindingVerified === true,
        livePortalCanaryVerified: submissionReadiness.livePortalCanaryVerified === true,
        humanReviewedSingleUseAuthorizationRequired: true,
      },
      blockers: submissionReadiness.blockers || [],
      limitations: [
        'the final live commit requires a human-reviewed hash-bound single-use authorization',
        'portal qualification applies only to the exact provider, account, route, and venue scope',
      ],
    }),
  ]);
  const capabilityEntriesReady = capabilities.every((entry) => entry.productionReady);
  const fullyAutonomousProductionReady =
    readiness.productionReady === true
    && readiness.fullyAutonomousResearchSystemReady === true
    && readiness.fullAutomaticResearchWritingReady === true
    && capabilityEntriesReady;
  const payload = {
    version: 2,
    kind: 'ResearchCapabilityMatrix',
    status: fullyAutonomousProductionReady
      ? 'research_capabilities_production_ready'
      : 'research_capabilities_bounded_or_blocked',
    capabilityEntriesStatus: capabilityEntriesReady
      ? 'research_capability_entries_production_ready'
      : 'research_capability_entries_bounded_or_blocked',
    universalResearchClaimed: false,
    evidenceLevelDefinitions: RESEARCH_CAPABILITY_EVIDENCE_LEVELS,
    fullyAutonomousProductionReady,
    deploymentEnvironmentInspection:
      readiness.deploymentEnvironmentInspection || null,
    capabilities,
  };
  return Object.freeze({
    ...payload,
    researchCapabilityMatrixHash: hashRecord('ResearchCapabilityMatrix', payload),
  });
}
