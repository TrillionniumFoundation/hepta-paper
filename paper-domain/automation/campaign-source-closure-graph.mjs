export function campaignGraphNode(campaignId, kind, dependencies = [], options = {}) {
  const roundIndex = Number(options.roundIndex || 0);
  return Object.freeze({
    nodeId: `${campaignId}:${roundIndex}:${options.nodeIdKind || kind}`,
    kind,
    roundIndex,
    dependencies,
    priority: Number(options.priority || 100),
    maxAttempts: Number(options.maxAttempts || 3),
    role: options.role || null,
    language: options.language || null,
    requiresGpu: Boolean(options.requiresGpu),
    ...(options.sourceClosureTerminal ? { sourceClosureTerminal: true } : {}),
    ...(options.sourceMutationPolicy ? { sourceMutationPolicy: options.sourceMutationPolicy } : {}),
    ...(options.executionIntent ? { executionIntent: options.executionIntent } : {}),
    ...(options.advancedNumericalExecutionPlanHash ? {
      advancedNumericalExecutionPlanHash:
        options.advancedNumericalExecutionPlanHash,
    } : {}),
  });
}

export function formalVerificationChain({
  campaignId,
  dependencies = [],
  executionIntent,
  roundIndex = 0,
  priority = 40,
  nodeIdPrefix = '',
  sourceClosureTerminal = false,
}) {
  const theoremSpecification = campaignGraphNode(campaignId, 'theorem-spec', dependencies, {
    roundIndex,
    priority,
    role: 'theorem-spec-author',
    language: 'lean',
    executionIntent,
    nodeIdKind: `${nodeIdPrefix}theorem-spec`,
    sourceClosureTerminal,
  });
  const formalVerify = campaignGraphNode(campaignId, 'formal-verify', [theoremSpecification.nodeId], {
    roundIndex,
    priority: priority + 2,
    role: 'formal-candidate',
    language: 'lean',
    executionIntent,
    nodeIdKind: `${nodeIdPrefix}formal-verify`,
    sourceClosureTerminal,
  });
  return Object.freeze({ theoremSpecification, formalVerify });
}

export function sealedEmpiricalChains({ campaignId, dependencies, executionProfiles, executionIntent }) {
  const singleEmpirical = executionProfiles.length === 1;
  return executionProfiles.map((profile) => {
    const suffix = singleEmpirical ? '' : `-${profile.label}`;
    const empirical = campaignGraphNode(campaignId, `revalidate-empirical-source-seal${suffix}`, dependencies, {
      priority: 96,
      language: profile.language,
      requiresGpu: profile.requiresGpu,
      executionIntent,
      sourceClosureTerminal: true,
      sourceMutationPolicy: 'forbid',
    });
    const reproduce = campaignGraphNode(campaignId, `revalidate-empirical-reproduce-source-seal${suffix}`, [empirical.nodeId], {
      priority: 97,
      language: profile.language,
      requiresGpu: profile.requiresGpu,
      executionIntent,
      sourceClosureTerminal: true,
      sourceMutationPolicy: 'forbid',
    });
    return Object.freeze({ empirical, reproduce });
  });
}
