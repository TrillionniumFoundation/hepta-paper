const SHA256 = /^sha256:[0-9a-f]{64}$/i;

export function outcomeBoundManuscriptMutationPolicy({ manuscript = 'main.tex' } = {}) {
  return Object.freeze({
    allowedPaths: Object.freeze([manuscript, 'proof_status.md', 'evidence_manifest.md']),
    allowedPrefixes: Object.freeze([]),
    allowedExtensions: Object.freeze(['.tex', '.bib']),
    forbiddenPaths: Object.freeze([]),
    forbiddenExtensions: Object.freeze([
      '.py', '.r', '.jl', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.ipynb', '.sh',
      '.json', '.jsonl', '.yaml', '.yml', '.toml', '.csv', '.tsv', '.lean',
    ]),
  });
}

export function assertOutcomeBoundManuscriptMutationAllowed({ changedPaths = [], manuscript = 'main.tex' } = {}) {
  const policy = outcomeBoundManuscriptMutationPolicy({ manuscript });
  const allowedPaths = new Set(policy.allowedPaths);
  const allowedExtensions = new Set(policy.allowedExtensions);
  const forbiddenExtensions = new Set(policy.forbiddenExtensions);
  const invalid = (Array.isArray(changedPaths) ? changedPaths : []).map((value) => String(value || '')
    .replace(/\\/g, '/').replace(/^\.\//, '')).find((relative) => {
    const extension = relative.includes('.') ? `.${relative.split('.').at(-1).toLowerCase()}` : '';
    return !relative || relative.startsWith('/') || relative.split('/').some((part) => !part || part === '..')
      || forbiddenExtensions.has(extension)
      || (!allowedPaths.has(relative) && !allowedExtensions.has(extension));
  });
  if (invalid) {
    const error = new Error(`campaign_outcome_informed_empirical_mutation_forbidden:${invalid}`);
    error.retryable = false;
    error.receipt = Object.freeze({ changedPaths: Object.freeze([...changedPaths].map(String)), invalidPath: invalid });
    throw error;
  }
  return true;
}

export function empiricalPreDataFreezeFromResult(result) {
  return result?.preDataAccessFreeze || result?.harnessExecutionReceipt?.preDataAccessFreeze
    || result?.experimentRunReceipt?.preDataAccessFreeze || null;
}

export function assertOutcomeBoundBenchmarkSourceUnchanged({
  anchorFreeze,
  analysisProtocolHash,
  systemBenchmarkArmProtocolSetHash,
  systemBenchmarkArmAdapterSetHash,
} = {}) {
  const current = { analysisProtocolHash, systemBenchmarkArmProtocolSetHash, systemBenchmarkArmAdapterSetHash };
  if (!anchorFreeze || Object.values(current).some((value) => !SHA256.test(String(value || '')))
    || anchorFreeze.analysisProtocolHash !== current.analysisProtocolHash
    || anchorFreeze.systemBenchmarkArmProtocolSetHash !== current.systemBenchmarkArmProtocolSetHash
    || anchorFreeze.systemBenchmarkArmAdapterSetHash !== current.systemBenchmarkArmAdapterSetHash) {
    const error = new Error('campaign_outcome_informed_empirical_source_mutation_forbidden');
    error.retryable = false;
    error.receipt = Object.freeze({
      anchorAnalysisProtocolHash: anchorFreeze?.analysisProtocolHash || null,
      anchorSystemBenchmarkArmProtocolSetHash: anchorFreeze?.systemBenchmarkArmProtocolSetHash || null,
      anchorSystemBenchmarkArmAdapterSetHash: anchorFreeze?.systemBenchmarkArmAdapterSetHash || null,
      ...current,
    });
    throw error;
  }
  return true;
}
