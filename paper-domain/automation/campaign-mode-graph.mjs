import { PAPER_BATCH_MODES } from '../workflow/mode-registry.mjs';
import {
  campaignGraphNode as node,
  formalVerificationChain,
  sealedEmpiricalChains,
} from './campaign-source-closure-graph.mjs';

const FULL_CAMPAIGN_MODE = 'full-campaign';
const FORMAL_CANDIDATE_MAX_AGENT_CALLS = 6;

function plannedAgentNode(kind) {
  return ['research-plan', 'writer', 'theorem-spec', 'manuscript-integrate', 'revise'].includes(kind)
    || /^coder(?:-|$)/.test(kind)
    || /^(?:revision-)?referee-\d+$/.test(kind);
}

export function plannedAgentCallUpperBound(nodes = []) {
  return (Array.isArray(nodes) ? nodes : []).reduce((total, candidate) => (
    total
    + (plannedAgentNode(candidate?.kind) ? Math.max(1, Number(candidate?.maxAttempts || 1)) : 0)
    + (candidate?.kind === 'formal-verify'
      ? FORMAL_CANDIDATE_MAX_AGENT_CALLS * Math.max(1, Number(candidate?.maxAttempts || 1))
      : 0)
  ), 0);
}

function benchmarkExecutionNode(candidate) {
  return /^(?:revalidate-)?empirical(?:-reproduce)?(?:-|$)/.test(String(candidate?.kind || ''));
}

export function plannedBenchmarkCellJobUpperBounds(nodes = [], benchmarkSelector = null) {
  if (!benchmarkSelector) return Object.freeze({ cpu: 0, gpu: 0 });
  const design = benchmarkSelector.experimentDesign || {};
  const processCount = benchmarkSelector.selectorType === 'authorized_dataset_mount'
    ? (design.seedSchedule || []).length * Number(design.minimumRepetitions || 0) * 3
    : 3;
  return Object.freeze((Array.isArray(nodes) ? nodes : []).reduce((total, candidate) => {
    if (!benchmarkExecutionNode(candidate)) return total;
    const executionsPerAttempt = String(candidate.kind).includes('reproduce') ? 2 : 3;
    const jobs = processCount * Math.max(1, Number(candidate.maxAttempts || 1)) * executionsPerAttempt;
    total.cpu += jobs;
    if (candidate.requiresGpu) total.gpu += jobs;
    return total;
  }, { cpu: 0, gpu: 0 }));
}

export function empiricalExecutionProfiles(languages, requiresGpu, { excludeLean = false } = {}) {
  const empiricalLanguages = languages.filter((language) => language !== 'latex' && (!excludeLean || language !== 'lean'));
  return empiricalLanguages.map((label) => Object.freeze({
    label,
    language: label === 'gpu' ? 'python' : label,
    requiresGpu: label === 'gpu' || (Boolean(requiresGpu) && label === 'python'),
  }));
}

function empiricalChains({ campaignId, dependencies, executionProfiles, executionIntent }) {
  const singleEmpirical = executionProfiles.length === 1;
  return executionProfiles.map((profile) => {
    const suffix = singleEmpirical ? '' : `-${profile.label}`;
    const coder = node(campaignId, `coder${suffix}`, dependencies, {
      priority: 20,
      role: `coder-${profile.label}`,
      language: profile.language,
      requiresGpu: profile.requiresGpu,
      executionIntent,
    });
    const empirical = node(campaignId, `empirical${suffix}`, [coder.nodeId], {
      priority: 30,
      language: profile.language,
      requiresGpu: profile.requiresGpu,
      executionIntent,
    });
    const reproduce = node(campaignId, `empirical-reproduce${suffix}`, [empirical.nodeId], {
      priority: 35,
      language: profile.language,
      requiresGpu: profile.requiresGpu,
      executionIntent,
      sourceMutationPolicy: 'forbid',
    });
    return { coder, empirical, reproduce };
  });
}

function appendReviewRounds({
  nodes,
  campaignId,
  previous,
  rounds,
  reviewers,
  executionProfiles,
  executionIntent,
  formalRequested = false,
  initialEmpiricalReplayNodeIds = [],
  initialFormalVerifyNodeId = null,
}) {
  const singleEmpirical = executionProfiles.length === 1;
  let previousNodeId = previous;
  let latestEmpiricalReplayNodeIds = [...initialEmpiricalReplayNodeIds];
  const empiricalReplayNodeIds = [...initialEmpiricalReplayNodeIds];
  const formalVerifyNodeIds = initialFormalVerifyNodeId ? [initialFormalVerifyNodeId] : [];
  const convergenceNodeIds = [];
  let latestFormalVerifyNodeId = initialFormalVerifyNodeId;
  for (let roundIndex = 1; roundIndex <= rounds; roundIndex += 1) {
    const refereeNodes = Array.from({ length: reviewers }, (_, index) => node(
      campaignId,
      `referee-${index + 1}`,
      [previousNodeId],
      { roundIndex, priority: 60, role: `referee-${index + 1}`, executionIntent },
    ));
    // A trusted dynamic-formal render needs a completed kernel/replay receipt,
    // while the revision itself must subsequently be verified against its new
    // source identity.  Carry the last post-mutation formal result as a direct
    // render authority dependency, then mint a new result below.
    const reviseDependencies = [
      ...refereeNodes.map((item) => item.nodeId),
      ...(formalRequested && latestFormalVerifyNodeId ? [latestFormalVerifyNodeId] : []),
    ];
    const revise = node(campaignId, 'revise', reviseDependencies, {
      roundIndex,
      priority: 70,
      role: 'reviser',
      executionIntent,
    });
    const formal = formalRequested ? formalVerificationChain({
      campaignId, dependencies: [revise.nodeId], executionIntent, roundIndex, priority: 74,
    }) : null;
    const formalVerify = formal?.formalVerify || null;
    const revisionDependency = formalVerify?.nodeId || revise.nodeId;
    const revalidationChains = executionProfiles.map((profile) => {
      const suffix = singleEmpirical ? '' : `-${profile.label}`;
      const code = node(campaignId, `revalidate-code${suffix}`, [revisionDependency], {
        roundIndex,
        priority: 80,
        language: profile.language,
        requiresGpu: profile.requiresGpu,
        executionIntent,
        sourceMutationPolicy: 'forbid',
      });
      const empirical = node(campaignId, `revalidate-empirical${suffix}`, [code.nodeId], {
        roundIndex,
        priority: 81,
        language: profile.language,
        requiresGpu: profile.requiresGpu,
        executionIntent,
        sourceMutationPolicy: 'forbid',
      });
      const reproduce = node(campaignId, `revalidate-empirical-reproduce${suffix}`, [empirical.nodeId], {
        roundIndex,
        priority: 82,
        language: profile.language,
        requiresGpu: profile.requiresGpu,
        executionIntent,
        sourceMutationPolicy: 'forbid',
      });
      return { code, empirical, reproduce };
    });
    const languageRevalidation = revalidationChains.flatMap((chain) => [chain.code, chain.empirical, chain.reproduce]);
    const verifyCompile = node(campaignId, 'revalidate-compile', [revisionDependency], {
      roundIndex, priority: 80, language: 'latex', executionIntent,
    });
    const verifyCitations = node(campaignId, 'revalidate-citations', [revisionDependency], {
      roundIndex, priority: 80, language: 'latex', executionIntent,
    });
    const verifyArtifacts = node(campaignId, 'revalidate-artifacts', [revisionDependency], {
      roundIndex, priority: 80, executionIntent,
    });
    const revisionRefereeNodes = Array.from({ length: reviewers }, (_, index) => node(
      campaignId,
      `revision-referee-${index + 1}`,
      [...languageRevalidation.map((item) => item.nodeId), verifyCompile.nodeId, verifyCitations.nodeId, verifyArtifacts.nodeId],
      { roundIndex, priority: 85, role: `revision-referee-${index + 1}`, executionIntent },
    ));
    const convergence = node(campaignId, 'convergence', revisionRefereeNodes.map((item) => item.nodeId), {
      roundIndex, priority: 90, executionIntent,
    });
    nodes.push(
      ...refereeNodes,
      revise,
      ...(formal ? [formal.theoremSpecification, formal.formalVerify] : []),
      ...languageRevalidation,
      verifyCompile,
      verifyCitations,
      verifyArtifacts,
      ...revisionRefereeNodes,
      convergence,
    );
    previousNodeId = convergence.nodeId;
    latestEmpiricalReplayNodeIds = revalidationChains.map((chain) => chain.reproduce.nodeId);
    if (formalVerify) {
      formalVerifyNodeIds.push(formalVerify.nodeId);
      latestFormalVerifyNodeId = formalVerify.nodeId;
    }
    empiricalReplayNodeIds.push(...latestEmpiricalReplayNodeIds);
    convergenceNodeIds.push(convergence.nodeId);
  }
  return Object.freeze({
    previousNodeId,
    latestEmpiricalReplayNodeIds: Object.freeze(latestEmpiricalReplayNodeIds),
    formalVerifyNodeIds: Object.freeze(formalVerifyNodeIds),
    empiricalReplayNodeIds: Object.freeze(empiricalReplayNodeIds),
    convergenceNodeIds: Object.freeze(convergenceNodeIds),
  });
}

function appendFullCampaign({ nodes, campaignId, rounds, reviewers, executionProfiles, executionIntent, integrateManuscript = true, formalRequested = false, researchVerificationRequired = false }) {
  const research = node(campaignId, 'research-plan', [], { priority: 10, executionIntent });
  const writer = node(campaignId, 'writer', [research.nodeId], { priority: 20, role: 'writer', executionIntent });
  // The writer declares literal empirical claim ranges. Every empirical attempt
  // reads and hashes that post-writer corpus before constructing its protocol.
  const chains = empiricalChains({ campaignId, dependencies: [writer.nodeId], executionProfiles, executionIntent });
  const manuscriptDependencies = [writer.nodeId, ...chains.map((chain) => chain.reproduce.nodeId)];
  // Dynamic formal support cannot be rendered before a successful kernel and
  // fresh-replay receipt exists.  This pre-render chain verifies the writer's
  // current theorem surface.  The ordinary chain below runs after integration
  // and therefore binds the mutated manuscript consumed by compile/review.
  const renderAuthorityFormal = formalRequested && integrateManuscript
    ? formalVerificationChain({
      campaignId,
      dependencies: manuscriptDependencies,
      executionIntent,
      priority: 38,
      nodeIdPrefix: 'render-authority-',
    }) : null;
  const integrate = integrateManuscript
    ? node(campaignId, 'manuscript-integrate', [
      ...manuscriptDependencies,
      ...(renderAuthorityFormal ? [renderAuthorityFormal.formalVerify.nodeId] : []),
    ], { priority: 40, role: 'writer', executionIntent })
    : null;
  const formal = formalRequested ? formalVerificationChain({
    campaignId,
    dependencies: integrate ? [integrate.nodeId] : manuscriptDependencies,
    executionIntent,
    priority: 42,
  }) : null;
  const formalVerify = formal?.formalVerify || null;
  const initialCompile = node(campaignId, 'compile', formalVerify ? [formalVerify.nodeId] : integrate ? [integrate.nodeId] : manuscriptDependencies, {
    priority: 50, language: 'latex', executionIntent,
  });
  nodes.push(
    research,
    writer,
    ...chains.flatMap((chain) => [chain.coder, chain.empirical, chain.reproduce]),
    ...(renderAuthorityFormal
      ? [renderAuthorityFormal.theoremSpecification, renderAuthorityFormal.formalVerify]
      : []),
    ...(integrate ? [integrate] : []),
    ...(formal ? [formal.theoremSpecification, formal.formalVerify] : []),
    initialCompile,
  );
  const review = appendReviewRounds({
    nodes, campaignId, previous: initialCompile.nodeId, rounds, reviewers, executionProfiles, executionIntent, formalRequested,
    initialEmpiricalReplayNodeIds: chains.map((chain) => chain.reproduce.nodeId),
    initialFormalVerifyNodeId: formalVerify?.nodeId || null,
  });
  // Repair-capable empirical/LaTeX nodes may legitimately change source after
  // an intermediate formal receipt was minted. Release evidence therefore
  // closes over one terminal source identity: a fresh writable formal pass,
  // followed only by source-sealed empirical replay and compilation.
  const sourceClosureFormal = formalRequested ? formalVerificationChain({
    campaignId,
    dependencies: [review.previousNodeId],
    executionIntent,
    roundIndex: 0,
    priority: 94,
    nodeIdPrefix: 'source-closure-',
    sourceClosureTerminal: true,
  }) : null;
  const sourceClosureRoot = sourceClosureFormal?.formalVerify.nodeId || review.previousNodeId;
  const sourceClosureEmpirical = sealedEmpiricalChains({
    campaignId,
    dependencies: [sourceClosureRoot],
    executionProfiles,
    executionIntent,
  });
  const sourceClosureReplayNodeIds = sourceClosureEmpirical.map((chain) => chain.reproduce.nodeId);
  const finalCompile = node(campaignId, 'final-compile', [
    ...review.convergenceNodeIds,
    ...(sourceClosureFormal ? [sourceClosureFormal.formalVerify.nodeId] : []),
    ...sourceClosureReplayNodeIds,
  ], {
    roundIndex: rounds,
    priority: 100,
    language: 'latex',
    executionIntent,
    ...((sourceClosureFormal || sourceClosureEmpirical.length) ? {
      sourceClosureTerminal: true,
      sourceMutationPolicy: 'forbid',
    } : {}),
  });
  const releaseFormalVerifyNodeIds = [
    ...(renderAuthorityFormal ? [renderAuthorityFormal.formalVerify.nodeId] : []),
    ...review.formalVerifyNodeIds,
    ...(sourceClosureFormal ? [sourceClosureFormal.formalVerify.nodeId] : []),
  ];
  const releaseEmpiricalReplayNodeIds = [
    ...review.empiricalReplayNodeIds,
    ...sourceClosureReplayNodeIds,
  ];
  const researchVerify = researchVerificationRequired
    ? node(campaignId, 'research-verify', [
      finalCompile.nodeId,
      ...releaseFormalVerifyNodeIds,
      ...releaseEmpiricalReplayNodeIds,
    ], { roundIndex: rounds + 1, priority: 105, executionIntent })
    : null;
  const packageNode = node(campaignId, 'package', [finalCompile.nodeId, ...(researchVerify ? [researchVerify.nodeId] : [])], {
    roundIndex: rounds + 1, priority: 110, executionIntent,
  });
  nodes.push(
    ...(sourceClosureFormal
      ? [sourceClosureFormal.theoremSpecification, sourceClosureFormal.formalVerify]
      : []),
    ...sourceClosureEmpirical.flatMap((chain) => [chain.empirical, chain.reproduce]),
    finalCompile,
    ...(researchVerify ? [researchVerify] : []),
    packageNode,
  );
}

export function buildCampaignModeNodes({
  campaignId,
  mode,
  rounds,
  reviewers,
  executionProfiles,
  executionIntent,
  empiricalRequested,
  applyManuscript,
  formalRequested = false,
  researchVerificationRequired = false,
}) {
  const nodes = [];
  if (mode === FULL_CAMPAIGN_MODE) {
    appendFullCampaign({ nodes, campaignId, rounds, reviewers, executionProfiles, executionIntent, integrateManuscript: true, formalRequested, researchVerificationRequired });
  } else if (mode === PAPER_BATCH_MODES.LOCAL_BUILD) {
    nodes.push(node(campaignId, 'compile', [], { priority: 10, language: 'latex', executionIntent }));
  } else if (mode === PAPER_BATCH_MODES.LOCAL_PACKAGE) {
    const formalPreflight = formalRequested
      ? node(campaignId, 'compile', [], { priority: 10, language: 'latex', executionIntent })
      : null;
    const formal = formalRequested ? formalVerificationChain({
      campaignId,
      dependencies: [formalPreflight.nodeId],
      executionIntent,
      priority: 20,
      sourceClosureTerminal: true,
    }) : null;
    const finalCompile = node(campaignId, 'final-compile', formal ? [formal.formalVerify.nodeId] : [], {
      priority: formal ? 30 : 10,
      language: 'latex',
      executionIntent,
      ...(formal ? { sourceClosureTerminal: true, sourceMutationPolicy: 'forbid' } : {}),
    });
    const researchVerify = node(campaignId, 'research-verify', [
      finalCompile.nodeId,
      ...(formal ? [formal.formalVerify.nodeId] : []),
    ], { priority: formal ? 30 : 20, executionIntent });
    nodes.push(
      ...(formalPreflight ? [formalPreflight] : []),
      ...(formal ? [formal.theoremSpecification, formal.formalVerify] : []),
      finalCompile,
      researchVerify,
      node(campaignId, 'package', [finalCompile.nodeId, researchVerify.nodeId], { roundIndex: 1, priority: formal ? 40 : 30, executionIntent }),
    );
  } else if (mode === PAPER_BATCH_MODES.RESEARCH_VERIFY) {
    const formal = formalRequested ? formalVerificationChain({ campaignId, executionIntent, priority: 10 }) : null;
    nodes.push(
      ...(formal ? [formal.theoremSpecification, formal.formalVerify] : []),
      node(campaignId, 'research-verify', formal ? [formal.formalVerify.nodeId] : [], { priority: formal ? 20 : 10, executionIntent }),
    );
  } else if (mode === PAPER_BATCH_MODES.REFEREE_REVIEW) {
    nodes.push(...Array.from({ length: reviewers }, (_, index) => node(campaignId, `referee-${index + 1}`, [], {
      roundIndex: 1, priority: 10, role: `referee-${index + 1}`, executionIntent,
    })));
  } else if (mode === PAPER_BATCH_MODES.REFEREE_REVISE) {
    const referees = Array.from({ length: reviewers }, (_, index) => node(campaignId, `referee-${index + 1}`, [], {
      roundIndex: 1, priority: 10, role: `referee-${index + 1}`, executionIntent,
    }));
    const revise = node(campaignId, 'revise', referees.map((item) => item.nodeId), { roundIndex: 1, priority: 20, role: 'reviser', executionIntent });
    const formal = formalRequested ? formalVerificationChain({
      campaignId, dependencies: [revise.nodeId], executionIntent, roundIndex: 1, priority: 24,
    }) : null;
    const revisionDependency = formal?.formalVerify.nodeId || revise.nodeId;
    const revalidateCompile = node(campaignId, 'revalidate-compile', [revisionDependency], { roundIndex: 1, priority: 30, language: 'latex', executionIntent });
    const revalidateCitations = node(campaignId, 'revalidate-citations', [revisionDependency], { roundIndex: 1, priority: 30, language: 'latex', executionIntent });
    const revalidateArtifacts = node(campaignId, 'revalidate-artifacts', [revisionDependency], { roundIndex: 1, priority: 30, executionIntent });
    const finalCompile = node(campaignId, 'final-compile', [revalidateCompile.nodeId, revalidateCitations.nodeId, revalidateArtifacts.nodeId], {
      roundIndex: 1, priority: 40, language: 'latex', executionIntent,
    });
    nodes.push(
      ...referees,
      revise,
      ...(formal ? [formal.theoremSpecification, formal.formalVerify] : []),
      revalidateCompile,
      revalidateCitations,
      revalidateArtifacts,
      finalCompile,
    );
  } else if (mode === PAPER_BATCH_MODES.EMPIRICAL_ANALYSIS) {
    if (!executionProfiles.length) throw new Error('campaign_empirical_mode_requires_non_latex_language');
    const research = node(campaignId, 'research-plan', [], { priority: 10, executionIntent });
    const chains = empiricalChains({ campaignId, dependencies: [research.nodeId], executionProfiles, executionIntent });
    nodes.push(research, ...chains.flatMap((chain) => [chain.coder, chain.empirical, chain.reproduce]));
    if (applyManuscript) {
      const integrate = node(campaignId, 'manuscript-integrate', chains.map((chain) => chain.reproduce.nodeId), { priority: 40, role: 'writer', executionIntent });
      nodes.push(integrate, node(campaignId, 'final-compile', [integrate.nodeId], { priority: 50, language: 'latex', executionIntent }));
    }
  } else if (mode === PAPER_BATCH_MODES.LOCAL_REVIEW_LOOP) {
    let compileDependencies = [];
    if (empiricalRequested) {
      if (!executionProfiles.length) throw new Error('campaign_empirical_mode_requires_non_latex_language');
      const research = node(campaignId, 'research-plan', [], { priority: 10, executionIntent });
      const chains = empiricalChains({ campaignId, dependencies: [research.nodeId], executionProfiles, executionIntent });
      nodes.push(research, ...chains.flatMap((chain) => [chain.coder, chain.empirical, chain.reproduce]));
      compileDependencies = chains.map((chain) => chain.reproduce.nodeId);
      if (applyManuscript) {
        const integrate = node(campaignId, 'manuscript-integrate', compileDependencies, { priority: 40, role: 'writer', executionIntent });
        nodes.push(integrate);
        compileDependencies = [integrate.nodeId];
      }
    }
    const initialCompile = node(campaignId, 'compile', compileDependencies, { priority: 50, language: 'latex', executionIntent });
    nodes.push(initialCompile);
    const review = appendReviewRounds({
      nodes, campaignId, previous: initialCompile.nodeId, rounds, reviewers,
      executionProfiles: empiricalRequested ? executionProfiles : [], executionIntent, formalRequested,
    });
    nodes.push(node(campaignId, 'final-compile', [review.previousNodeId], { roundIndex: rounds, priority: 100, language: 'latex', executionIntent }));
  } else if (mode === PAPER_BATCH_MODES.LOCAL_DRY_RUN) {
    const formalPreflight = formalRequested
      ? node(campaignId, 'compile', [], { priority: 10, language: 'latex', executionIntent })
      : null;
    const formal = formalRequested ? formalVerificationChain({
      campaignId,
      dependencies: [formalPreflight.nodeId],
      executionIntent,
      priority: 20,
      sourceClosureTerminal: true,
    }) : null;
    const finalCompile = node(campaignId, 'final-compile', formal ? [formal.formalVerify.nodeId] : [], {
      priority: formal ? 30 : 10,
      language: 'latex',
      executionIntent,
      ...(formal ? { sourceClosureTerminal: true, sourceMutationPolicy: 'forbid' } : {}),
    });
    const researchVerify = node(campaignId, 'research-verify', [
      finalCompile.nodeId,
      ...(formal ? [formal.formalVerify.nodeId] : []),
    ], { priority: formal ? 30 : 20, executionIntent });
    const referees = Array.from({ length: reviewers }, (_, index) => node(campaignId, `referee-${index + 1}`, [finalCompile.nodeId], {
      roundIndex: 1, priority: formal ? 40 : 30, role: `referee-${index + 1}`, executionIntent,
    }));
    nodes.push(
      ...(formalPreflight ? [formalPreflight] : []),
      ...(formal ? [formal.theoremSpecification, formal.formalVerify] : []),
      finalCompile,
      researchVerify,
      ...referees,
      node(campaignId, 'package', [finalCompile.nodeId, researchVerify.nodeId, ...referees.map((item) => item.nodeId)], {
      roundIndex: 2, priority: formal ? 50 : 40, executionIntent,
    }));
  } else if (mode === PAPER_BATCH_MODES.REVIEWED_SUBMIT) {
    const formalPreflight = formalRequested
      ? node(campaignId, 'compile', [], { priority: 10, language: 'latex', executionIntent })
      : null;
    const formal = formalRequested ? formalVerificationChain({
      campaignId,
      dependencies: [formalPreflight.nodeId],
      executionIntent,
      priority: 20,
      sourceClosureTerminal: true,
    }) : null;
    const finalCompile = node(campaignId, 'final-compile', formal ? [formal.formalVerify.nodeId] : [], {
      priority: formal ? 30 : 10,
      language: 'latex',
      executionIntent,
      ...(formal ? { sourceClosureTerminal: true, sourceMutationPolicy: 'forbid' } : {}),
    });
    const researchVerify = node(campaignId, 'research-verify', [
      finalCompile.nodeId,
      ...(formal ? [formal.formalVerify.nodeId] : []),
    ], { priority: formal ? 30 : 20, executionIntent });
    nodes.push(
      ...(formalPreflight ? [formalPreflight] : []),
      ...(formal ? [formal.theoremSpecification, formal.formalVerify] : []),
      finalCompile,
      researchVerify,
      node(campaignId, 'package', [finalCompile.nodeId, researchVerify.nodeId], {
        roundIndex: 1, priority: formal ? 40 : 30, executionIntent,
      }),
    );
  }
  return Object.freeze(nodes);
}
