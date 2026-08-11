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
  const empiricalLanguages = languages.filter(
    (language) => language !== 'latex' && (!excludeLean || language !== 'lean'),
  );
  return empiricalLanguages.map((label) => Object.freeze({
    label,
    language: label === 'gpu' ? 'python' : label,
    requiresGpu: label === 'gpu' || (Boolean(requiresGpu) && label === 'python'),
  }));
}
