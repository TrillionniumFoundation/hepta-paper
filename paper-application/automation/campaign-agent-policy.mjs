import path from 'node:path';
import { empiricalClaimDeclarationsFromAnalysisProtocol } from '../../paper-domain/automation/analysis-protocol-contract.mjs';
import { isCampaignRefereeNode } from './campaign-node-kind-policy.mjs';
import { outcomeBoundManuscriptMutationPolicy } from './campaign-confirmatory-lineage-policy.mjs';
import { verifyEmpiricalOutcomeBlindRepairDiagnostic } from './campaign-empirical-repair-policy.mjs';

export { isCampaignAgentNode, isCampaignRefereeNode } from './campaign-node-kind-policy.mjs';

const EMPIRICAL_ENTRYPOINTS = Object.freeze({
  python: 'experiments/run.py',
  r: 'experiments/run.R',
  node: 'experiments/run.mjs',
  julia: 'experiments/run.jl',
  lean: 'Main.lean',
});
const OUTCOME_BEARING_WORKSPACE_PATHS = Object.freeze([
  'automation-results', 'results.json', 'results.csv', 'observation.json',
]);
const CAMPAIGN_AGENT_MAXIMUM_TIMEOUT_MS = 20 * 60 * 1000;

function normalizedWorkspacePath(value, code) {
  const relative = String(value || '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!relative || relative.startsWith('/')
    || relative.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error(code);
  }
  return relative;
}

function empiricalEntrypoint({ entrypoint = null, language = 'python' } = {}) {
  return normalizedWorkspacePath(
    entrypoint || EMPIRICAL_ENTRYPOINTS[language] || `experiments/run.${language}`,
    'campaign_empirical_agent_entrypoint_invalid',
  );
}

function siblingArmEntrypoints(entrypoint) {
  const extensionIndex = entrypoint.lastIndexOf('.');
  const base = extensionIndex > entrypoint.lastIndexOf('/') ? entrypoint.slice(0, extensionIndex) : entrypoint;
  const extension = extensionIndex > entrypoint.lastIndexOf('/') ? entrypoint.slice(extensionIndex) : '';
  return ['treatment', 'baseline', 'ablation'].map((arm) => `${base}.${arm}${extension}`);
}

export function empiricalCodeWorkspaceMutationPolicy({
  entrypoint = null,
  language = 'python',
  benchmarkSelector = null,
  manuscript = 'main.tex',
} = {}) {
  const resolvedEntrypoint = empiricalEntrypoint({ entrypoint, language });
  const allowedPaths = [
    resolvedEntrypoint,
    ...(benchmarkSelector ? siblingArmEntrypoints(resolvedEntrypoint) : []),
  ];
  return Object.freeze({
    allowedPaths: Object.freeze([...new Set(allowedPaths)]),
    allowedPrefixes: Object.freeze([]),
    allowedExtensions: Object.freeze([]),
    forbiddenPaths: Object.freeze([
      normalizedWorkspacePath(manuscript, 'campaign_manuscript_path_invalid'),
      'RESEARCH_PLAN.md', 'THEOREM_SPEC.json', 'THEOREM_SPEC_DRAFT.json',
    ]),
    forbiddenExtensions: Object.freeze(['.tex']),
  });
}

export function researchPlanWorkspaceMutationPolicy() {
  return Object.freeze({
    allowedPaths: Object.freeze(['RESEARCH_PLAN.md']),
    allowedPrefixes: Object.freeze([]),
    allowedExtensions: Object.freeze([]),
    forbiddenPaths: Object.freeze([]),
    forbiddenExtensions: Object.freeze(['.tex']),
  });
}

function containedMutationRetryInstruction(node = {}) {
  if (Number(node.attemptCount || 0) < 2) return '';
  const blockers = String(node.failureClass || '').split(',').filter(Boolean);
  const paths = blockers.map((blocker) => blocker.match(
    /^workspace_mutation_not_allowlisted:([A-Za-z0-9._/-]+)$/,
  )?.[1] || null);
  if (!paths.length || paths.some((candidate) => !candidate)) return '';
  return ` A previous isolated attempt was discarded without merging because it edited non-allowlisted path(s): ${paths.join(', ')}. On this retry, do not edit those paths and obey the exact workspace mutation policy.`;
}

function outcomeBlindIsolation({ workspace, datasetMounts }) {
  return Object.freeze({
    isolationExcludes: Object.freeze([
      ...datasetMounts.map((mount) => mount.source),
      ...OUTCOME_BEARING_WORKSPACE_PATHS.map((relative) => path.join(workspace, relative)),
    ]),
    isolationPolicy: Object.freeze({ skipSourceSymlinks: true, outcomeBlind: true }),
  });
}

function outcomeBlindDiagnosticText(diagnostic, source) {
  if (!verifyEmpiricalOutcomeBlindRepairDiagnostic(diagnostic, { source })) {
    const error = new Error('campaign_empirical_outcome_blind_repair_diagnostic_invalid');
    error.retryable = false;
    throw error;
  }
  return `Outcome-blind technical failure classes: ${diagnostic.failureClasses.join(', ')}. Raw stdout, stderr, output artifacts, metric values, and observed scientific outcomes are intentionally withheld; diagnose independently from the frozen source and rerun only the declared technical check.`;
}

// Pure campaign prompting and repair-request policy belongs to the application layer.
export function extractCampaignAgentJson(text) {
  const source = String(text || '');
  const candidates = [...source.matchAll(/\{[\s\S]*?\}/g)].map((match) => match[0]).reverse();
  for (const candidate of candidates) {
    try { return JSON.parse(candidate); } catch { /* try the previous candidate */ }
  }
  return null;
}

export function campaignAgentOutputTokenBudget(kind) {
  if (isCampaignRefereeNode(kind)) return 4096;
  if (kind === 'research-plan') return 2048;
  if (kind === 'theorem-spec') return 4096;
  if (/^coder(?:-|$)/.test(kind)) return 4096;
  if (['formal-author', 'formal-review'].includes(kind)) return 8192;
  if (['writer', 'manuscript-integrate', 'revise'].includes(kind)) return 8192;
  return 2048;
}

function empiricalClaimMarkerInstructions(benchmarkSelector) {
  if (!benchmarkSelector) return '';
  const analysisProtocol = Object.freeze({
    ...benchmarkSelector.experimentDesign.analysisProtocol,
    analysisProtocolHash: benchmarkSelector.experimentDesign.analysisProtocolHash,
  });
  const declarations = empiricalClaimDeclarationsFromAnalysisProtocol(analysisProtocol);
  const requiredMarkers = declarations.map((declaration, index) => {
    const declarationJson = JSON.stringify(declaration);
    const manuscriptClaimHash = analysisProtocol.version === 2
      ? `\nDeclaration ${index + 1} existing manuscriptClaimHash (must remain exact): ${analysisProtocol.hypotheses[index].manuscriptClaimHash}`
      : '';
    return `Declaration ${index + 1} begin marker (copy this whole line byte-for-byte): % HEPTA_EMPIRICAL_CLAIM_BEGIN ${declarationJson}\nDeclaration ${index + 1} end marker (copy this whole line byte-for-byte): % HEPTA_EMPIRICAL_CLAIM_END ${declaration.claimId}${manuscriptClaimHash}`;
  }).join('\n');
  if (analysisProtocol.version === 2) {
    return ` This operator-bound v2 protocol does not authorize writing or rewriting empirical claims. Before any empirical run, locate exactly ${declarations.length} already-existing confirmatory manuscript claim range(s) in the declaration order below and preserve every marker and every body byte-for-byte. Do not create missing ranges, regenerate prose, move ranges, or alter a claimId, metric, comparator, alternative, minimumEffect, acceptanceRequired, proposalClaimRecordHash, or manuscript claim body. If any range is absent or its system-computed manuscriptClaimHash differs, fail closed. Use only literal \\input/\\include paths; TeX-generated markers are forbidden.\n${requiredMarkers}`;
  }
  return ` Before any empirical run, write exactly ${declarations.length} confirmatory manuscript claim range(s), in the declaration order below. Copy each required begin and end marker line byte-for-byte, with the exact natural-language hypothesis text between its matching marker lines. Do not alter a claimId, metric, comparator, alternative, minimumEffect, acceptanceRequired, or proposalClaimRecordHash. Do not add, omit, duplicate, or reorder declarations. Use literal \\input/\\include paths and never generate markers through TeX macros.\n${requiredMarkers}`;
}

function typedEmpiricalAssertionInstructions(authority) {
  if (!authority) return '';
  return ` The system-derived empirical assertion authority is immutable at automation-results/EMPIRICAL_ASSERTION_AUTHORITY.json and has hash ${authority.empiricalAssertionAuthorityHash}. Read it directly; never create, rewrite, or self-sign it. Author all noncanonical manuscript prose through AUTONOMOUS_MANUSCRIPT_IR_DRAFT.json; never edit AUTONOMOUS_MANUSCRIPT_IR.json. Preserve the draft's exact top-level and block schemas. You may change the plain-text title, section headings, prose/citation text, and section arrangement, but must keep exactly one slot for empirical_claims, formal_support, and empirical_results and at least one limitation prose block. Every prose or citation block must list only real sha256 evidenceRefs copied from AUTONOMOUS_RESEARCH_PROPOSAL.json, AUTONOMOUS_RESEARCH_POLICY_AUTHORIZATION.json, AUTONOMOUS_RESEARCH_SEED_CONTRACTS.json, AUTONOMOUS_PRIOR_ART_EVIDENCE.json, AUTONOMOUS_EMPIRICAL_CLAIM_LINEAGE.json, THEOREM_SPEC.json, or automation-results/EMPIRICAL_ASSERTION_AUTHORITY.json. Never invent a hash or cite a work absent from a verified prior-art receipt. The trusted renderer escapes plain text, injects canonical claims, formal support, results, tables, and figures into the three slots, binds your draft to this execution receipt, and rejects unbound scientific prose. A negative or inconclusive result is a result and must not be reframed as support. Do not alter empirical code, protocol, thresholds, claims, authority files, or canonical result bodies.`;
}

export function buildCampaignAgentInstructions({
  kind,
  manuscript,
  roundIndex,
  reviews = [],
  language = 'python',
  requiresGpu = false,
  datasetMounts = [],
  benchmarkSelector = null,
  formalProposalSeedRequired = false,
  proposalSeedContractPath = 'PROPOSAL_CLAIM_PROOF_EVIDENCE_REPRO_SEED_CONTRACTS.json',
  approvedProposalSeedBindingHash = null,
  claimAuthorityType = null,
  claimAuthorityBindingHash = null,
  priorConvergence = null,
  qualityGateBlockers = [],
  revisionMaterialization = null,
  empiricalAssertionAuthority = null,
  empiricalOutcomeObserved = false,
} = {}) {
  const empiricalClaimMarkers = empiricalClaimMarkerInstructions(benchmarkSelector);
  const empiricalAssertions = typedEmpiricalAssertionInstructions(empiricalAssertionAuthority);
  const evidenceEntailmentReview = ' If AUTONOMOUS_MANUSCRIPT_ENTAILMENT.json exists, read it independently and reject unless every rendered prose/citation block is covered exactly once, its renderedSentence matches the current manuscript, and every evidenceRef has canonical source-document predicates permitted for that claimClass. Inspect each predicate sourceDocumentHash, JSON fieldPath, typed actualValue, operator, unit, denominator, and original/replay role; do not infer support merely because an authority hash is present. Treat provenance and source-field predicates as necessary but not sufficient for semantic entailment; reject unsupported generalization, causal language, novelty, or universal-truth claims. In the returned JSON also include evidenceEntailmentReview exactly as {version:1,kind:"EvidenceEntailmentPerClaimReview",evidenceEntailmentContractHash:"sha256:...",claims:[{claimId:"exact contract claimId",renderedSentenceHash:"exact contract hash",verdict:"entailed"|"not_entailed",rationale:"specific source-field-to-sentence justification"}]} in contract claim order. Use verdict entailed only when the cited source fields logically support the whole rendered sentence.';
  if (kind === 'research-plan') return `Inspect ${manuscript} and the project. Write a concise RESEARCH_PLAN.md of at most 450 words with falsifiable claims, code tasks, datasets, metrics, baselines, ablations, seeds, and stopping criteria. Prefer compact tables or bullets over prose.`;
  if (kind === 'writer' && formalProposalSeedRequired && claimAuthorityType === 'machine-policy-authorized') return `This is a machine-proposed research source authorized only for bounded execution by system policy and bound by ${claimAuthorityBindingHash || 'a missing binding hash'}; it is not operator approval, scientific validation, or release authority. Read ${proposalSeedContractPath}; require kind AutonomousResearchSeedContractBundle, status autonomous_research_seed_contracts_ready, claimAuthorityType machine-policy-authorized, valid safety declarations, and non-empty claims. Use exactly the claims whose verificationMode is formal_kernel as theorem authority; never turn an empirical_protocol outcome claim, observed metric, treatment effect, replay result, or empirical obligation into a theorem premise or axiom. Preserve every selected formal claim's exact statement, assumptions, quantifiers, negativeBoundaries, and proofObligations, and use each selected formal claim exactly once. Reject circular P-implies-P, assumption-echo, True, or otherwise vacuous theorem formulations. Add its natural-language proof in an immediately adjacent \\begin{proof} environment and state every formal negative boundary in a Limitations section. Also improve AUTONOMOUS_MANUSCRIPT_IR_DRAFT.json using only its existing exact schema; every prose block must retain real evidenceRefs copied from immutable authority files, and the three canonical slots must each remain exactly once. Never edit AUTONOMOUS_MANUSCRIPT_IR.json. Do not invent evidence, write Lean, or create THEOREM_SPEC files. The later system-finalized theorem-spec and independent formal review may reject the claim; external release attestation remains required. If the authority or lineage is missing or blocked, fail closed.${empiricalClaimMarkers}`;
  if (kind === 'writer' && formalProposalSeedRequired) return `This is an approved formal proposal source bound by ${approvedProposalSeedBindingHash || 'a missing binding hash'}. Read ${proposalSeedContractPath}; require kind PaperProposalSeedContractBundle, status proposal_seed_contracts_ready, non-empty proposal-derived claims, proof obligations, proposalEnvelopeHash, productionPlanEnvelopeHash, reviewGateHash, and a scientificClaimInputHash. Each claim carries the operator-supplied exact scientific statement plus non-empty assumptions, quantifiers, negativeBoundaries, and proofObligations. Use every approved claim exactly once as the only theorem authority. Preserve its complete semantic scope; TeX syntax conversion is allowed, but paraphrasing, narrowing, strengthening, adding conditions, deleting quantifiers, or substituting a different claim is forbidden. Add its natural-language proof in an immediately adjacent \\begin{proof} environment and state every approved negative boundary in a Limitations section. Do not invent evidence, write Lean, or create THEOREM_SPEC files. The later system-finalized theorem-spec and Lean candidate stages bind and independently review the result; if the approved seed contract or scientific claim lineage is missing or blocked, fail closed.${empiricalClaimMarkers}`;
  if (kind === 'writer') return `Improve only ${manuscript} according to RESEARCH_PLAN.md; do not modify RESEARCH_PLAN.md or any other file. Strengthen only claims supported by files already present. Do not invent results, datasets, benchmark names, citations, bibliographic identities, external systems, authority, or evidence. If verified evidence is absent, describe the work explicitly as a plan or protocol, omit empirical findings and citations, and state the evidence limitations. Keep the complete manuscript concise enough for the configured output budget.${empiricalClaimMarkers}`;
  if (kind === 'theorem-spec') return `Read ${manuscript} and every recursively included TeX file.${formalProposalSeedRequired ? ` Also read the bound scientific claim authority in ${proposalSeedContractPath}.` : ''} Enumerate every theorem-like environment in source order. Write exactly one file, THEOREM_SPEC_DRAFT.json, and modify nothing else. Its exact JSON schema is {"version":1,"kind":"TheoremSpecificationDraft","claims":[{"claimKey":"stable-key","title":"short title","statement":"exact theorem body text","assumptions":["..."],"quantifiers":["..."],"negativeBoundaries":["at least one explicit non-claim"],"proofObligations":["at least one concrete obligation"],"proofDependencyClaimKeys":["stable-key-of-an-earlier-or-shared-lemma"],"evidenceObligations":[],"manuscriptIntent":"existing"${formalProposalSeedRequired ? ',"proposalClaimId":"exact bound formal claim id"' : ''}}]}. Every object must contain exactly those keys, with no claimId, hashes, source paths, byte offsets, receipts, TODOs, or extra fields. proofDependencyClaimKeys must list every canonical theorem/lemma whose proved declaration is used by this theorem, or [] when independent; do not invent dependencies, self-reference, or create cycles. statement must reproduce the exact theorem body text, not a stronger paraphrase.${formalProposalSeedRequired ? ` Map every theorem one-to-one to the authorized ${claimAuthorityType === 'machine-policy-authorized' ? 'formal_kernel claim only; exclude every empirical_protocol claim' : 'operator-approved proposal claim'} by exact proposalClaimId; do not omit, duplicate, strengthen, or substitute an unrelated claim. This mapping is only a locator and will not be trusted until independently reviewed.` : ''} The system, never the agent, binds source bytes and creates canonical THEOREM_SPEC.json.`;
  if (kind === 'formal-author') return `Treat THEOREM_SPEC.json and every .tex file as immutable authority. For every canonical specification claim, use its exact claimId, statement, proof obligations, proofObligationContracts, and manuscriptSource binding. If proposalClaimSource contains dynamicFormalClaimSeedHash, the Lean declaration name must equal leanDeclarationName, its elaborated normalized type hash must equal leanNormalizedTypeHash, its source type must be leanTypeSource, and imports must be a subset of allowedImports. Create or update only Lean/Lake files and RESEARCH_WORKER_PLAN.json. Prove the exact statements without sorry/admit/unreviewed axioms. Every formal_verifier_lake claim binding must use the canonical claimId, theoremSpecificationHash, theoremSpecificationClaimHash, and exact manuscriptSource path, byteStart, byteEnd, and contentHash from THEOREM_SPEC.json, and include theoremName,sourceFile,expectedTypeHash,sourceStatementHash,proofObligations. Also copy every canonical proofObligationContract exactly and provide proofObligationMappings as [{obligationId,displayText,leanDeclarations:["LeanDeclaration"]}], covering each obligation exactly once with one or more declarations in sourceFile. Do not modify any .tex, THEOREM_SPEC.json, THEOREM_SPEC_DRAFT.json, Markdown, empirical artifact, or source package contract. Do not weaken a claim to make the proof pass. The verifier generates its own fresh #check/#print axioms audit outside the source workspace.`;
  if (kind === 'formal-review') return `Read-only independent review: bind your review to canonical THEOREM_SPEC.json, compare every specification claim and exact manuscript byte range with its Lean theorem type and proof obligations, and reject any mismatch. For dynamic proposalClaimSource entries, also independently reject unless theoremName equals leanDeclarationName and the elaborated normalized Lean type hash equals leanNormalizedTypeHash.${formalProposalSeedRequired ? ` Independently compare each exact proposalClaimSource text from THEOREM_SPEC.json (ultimately bound to ${proposalSeedContractPath}) with the natural-language theorem. Accept only semantic equivalence to the bound ${claimAuthorityType === 'machine-policy-authorized' ? 'machine-policy-authorized formal_kernel claim; this is not operator approval and does not establish novelty or scientific correctness' : 'operator-approved proposal claim'}; narrowing, strengthening, unrelated substitution, or scope change must fail${claimAuthorityType === 'machine-policy-authorized' ? ' and external release attestation remains required' : ' and requires a new operator-signed proposal approval outside this review'}.` : ''} There must be exactly one review for every canonical claim and no extra review. Do not modify any file. Return only JSON as {version:${formalProposalSeedRequired ? 2 : 1},kind:"FormalClaimSemanticReview",theoremSpecificationHash:"sha256:...",reviews:[...]}; every review must contain claimId,theoremName,manuscriptClaimHash,theoremTypeHash,sourceStatementHash,status:"formal_semantic_review_verified" only when the manuscript theorem and Lean type are equivalent,semanticEquivalenceVerified,and verdict:"equivalent"${formalProposalSeedRequired ? ', plus proposalClaimId,proposalClaimRecordHash,proposalClaimTextHash copied exactly from proposalClaimSource, proposalToTheoremSemanticVerified, proposalToTheoremVerdict:"equivalent", and approvedNarrowingRationale:null' : ''}. Identity and execution authority are injected by the runtime. Block omissions, narrowing, strengthening, unrelated or conditional or vacuous proofs, sorry/admit, assumption echo, or a specification hash mismatch.`;
  if (/^coder(?:-|$)/.test(kind)) {
    const entrypoint = empiricalEntrypoint({ language });
    const armEntrypoints = siblingArmEntrypoints(entrypoint);
    const datasets = datasetMounts.length
      ? ` Declared datasets are mounted read-only inside the worker at ${datasetMounts.map((mount) => `/datasets/${mount.name} (${mount.licenseId})`).join(', ')}; use only those declared paths for external data.`
      : '';
    const benchmark = benchmarkSelector
      ? ` Implement three distinct candidate arm adapters at ${armEntrypoints.join(', ')}; never branch one shared entrypoint on HEPTA_EXPERIMENT_ARM. Each arm is invoked exactly once per run. Reconstruct the repository-owned SystemBenchmarkArmBatchChallenge by concatenating HEPTA_BENCHMARK_CHALLENGE_JSON_PART_1 through the integer HEPTA_BENCHMARK_CHALLENGE_PART_COUNT in numeric order. Write only observation.json as {version:1,kind:"CampaignBenchmarkArmBatchResponses",systemBenchmarkArmBatchChallengeHash:batch.systemBenchmarkArmBatchChallengeHash,cells:[{cellId,systemBenchmarkCellChallengeHash,responses:[...]}]}. Preserve batch cell order and return exactly one response for every caseId under each cell.challenge.responseField; do not invent labels, outcomes, raw events, final metrics, aggregates, results.json, or results.csv. The baseline adapter must return each case's repository-provided referenceResponse exactly. The treatment adapter uses full public inputs; the ablation adapter only receives the system-redacted input. The host-held oracle evaluates every seed/repetition cell and derives bounded raw events, metrics, aggregation, CI, power, and acceptance. Keep the three adapter implementations byte-distinct; their source and runner provenance are independently bound.`
      : '';
    return `Implement the smallest valid ${entrypoint} for RESEARCH_PLAN.md${requiresGpu ? ' using the declared GPU runtime' : ''}. Use deterministic seeds and no network.${benchmarkSelector ? '' : ' Read HEPTA_OUTPUT_DIR from the environment and write HEPTA_OUTPUT_DIR/results.json plus HEPTA_OUTPUT_DIR/results.csv; do not fall back to the working directory. results.csv must begin with the exact header metric,value and contain at least one non-empty metric with a finite numeric value.'} Include a fast self-check. Do not fabricate outputs or add unnecessary framework code.${benchmark}${datasets}`;
  }
  if (kind === 'manuscript-integrate' && empiricalOutcomeObserved) return `Integrate only actually generated original and replay empirical evidence from automation-results/ into ${manuscript}; clearly distinguish observed results from planned work. The empirical outcome is already observed: modify manuscript and interpretation only. Never modify an empirical entrypoint, treatment/baseline/ablation adapter, imported experiment module, analysis protocol, hypothesis, threshold, metric, seed schedule, or experiment configuration.${empiricalAssertions}`;
  if (kind === 'manuscript-integrate') return `No completed empirical outcome authority is present. Modify only ${manuscript}; do not modify RESEARCH_PLAN.md or any other file. Keep ${manuscript} explicitly limited to a plan or protocol. Do not create observed results, measurements, datasets, benchmark names, citations, external systems, authority, or evidence. Remove any unsupported empirical finding already present and state that empirical validation remains pending.${empiricalAssertions}`;
  if (/^referee-\d+$/.test(kind)) return `Independently review ${manuscript} before revision at round ${roundIndex}. Do not modify files.${empiricalAssertionAuthority ? ` Read the immutable typed authority and reject any assertion body that is not byte-for-byte equal to canonicalManuscriptBody, any TeX hiding/rendering construct, omitted negative result or limitation, untyped rendered prose, or conclusion beyond the bounded canonical statement. Deterministic binding remains mandatory regardless of your verdict. Authority hash: ${empiricalAssertionAuthority.empiricalAssertionAuthorityHash}.` : ''}${evidenceEntailmentReview} Return JSON with verdict (accept|revise), score (0..1), criticalFindingCount, findings, and summary. Use accept only when no actionable revision is required and then assign a score consistent with acceptance; use revise only when findings lists at least one concrete actionable deficiency and assign a score consistent with revision. Findings must contain deficiencies, not praise. Never mechanically return revise or score 0 merely because this is a review round.`;
  if (/^revision-referee-\d+$/.test(kind)) return `Independently review the revised ${manuscript} at round ${roundIndex}. Judge the current file, not a prior draft. Do not modify files.${empiricalAssertionAuthority ? ` Re-read automation-results/EMPIRICAL_ASSERTION_AUTHORITY.json and reject any body not byte-for-byte equal to canonicalManuscriptBody, any TeX hiding/rendering construct, omission, untyped rendered prose, or unsupported generalization. Deterministic binding remains mandatory regardless of your verdict. Authority hash: ${empiricalAssertionAuthority.empiricalAssertionAuthorityHash}.` : ''}${evidenceEntailmentReview} Return JSON with verdict (accept|revise), score (0..1), criticalFindingCount, findings, and summary. Use accept only when no actionable revision is required and then assign a score consistent with acceptance; use revise only when findings lists at least one concrete actionable deficiency and assign a score consistent with revision. Findings must contain deficiencies, not praise. Never mechanically return revise or score 0 merely because this is a revision round.`;
  if (kind === 'revise' && empiricalOutcomeObserved) return `Revise ${manuscript} and its interpretation to address the following independent reviews and every carried-forward deterministic quality-gate blocker. The empirical outcome is already observed: never modify an empirical entrypoint, treatment/baseline/ablation adapter, imported experiment module, analysis protocol, hypothesis, threshold, metric, seed schedule, experiment configuration, or any code/configuration that can affect empirical behavior. A negative, non-significant, or inconclusive result must remain reportable and must not trigger method tuning. Preserve correct content and run manuscript checks.${empiricalAssertions} Preserve every HEPTA_EMPIRICAL_CLAIM marker pair and its exact hypothesis text byte-for-byte. For theorem readiness, create proof_status.md when theorem_proof_status_missing is present, create evidence_manifest.md when theorem_evidence_manifest_missing is present, and add a real appendix/supplement or an explicit justified waiver when theorem_appendix_or_supplement_missing is present. Do not claim a proof is closed unless the current formal verification evidence supports it. Prior convergence: ${JSON.stringify(priorConvergence)}. Revision materialization: ${JSON.stringify(revisionMaterialization)}. Quality-gate blockers: ${JSON.stringify(qualityGateBlockers)}. Reviews: ${JSON.stringify(reviews)}`;
  if (kind === 'revise') return `Revise ${manuscript} to address the independent reviews and deterministic quality-gate blockers. Modify only ${manuscript} plus proof_status.md, evidence_manifest.md, or manuscript appendix/supplement TeX files when an exact carried-forward theorem-readiness blocker requires them; never modify RESEARCH_PLAN.md or unrelated files. No completed empirical outcome authority is present. Keep the paper explicitly limited to a plan or protocol; remove unsupported observed results and do not invent measurements, datasets, benchmark names, citations, external systems, authority, or evidence. Preserve every HEPTA_EMPIRICAL_CLAIM marker pair and its exact hypothesis text byte-for-byte. For theorem readiness, create proof_status.md when theorem_proof_status_missing is present, create evidence_manifest.md when theorem_evidence_manifest_missing is present, and add a real appendix/supplement or an explicit justified waiver when theorem_appendix_or_supplement_missing is present. Do not claim a proof is closed without current formal verification evidence. Prior convergence: ${JSON.stringify(priorConvergence)}. Revision materialization: ${JSON.stringify(revisionMaterialization)}. Quality-gate blockers: ${JSON.stringify(qualityGateBlockers)}. Reviews: ${JSON.stringify(reviews)}`;
  throw new Error(`No agent instructions for ${kind}`);
}

export function formalWorkspaceMutationPolicy() {
  return Object.freeze({
    allowedPaths: Object.freeze(['RESEARCH_WORKER_PLAN.json', 'lake-manifest.json', 'lean-toolchain']),
    allowedPrefixes: Object.freeze([]),
    allowedExtensions: Object.freeze(['.lean']),
    forbiddenPaths: Object.freeze(['THEOREM_SPEC.json', 'THEOREM_SPEC_DRAFT.json']),
    forbiddenExtensions: Object.freeze(['.tex']),
  });
}

function commonRepairRequest({ campaign, workspace, role, instructions, context, requiredChecks, remainingTokenCount, signal, workspaceMutationPolicy = null }) {
  const datasetMounts = campaign.spec.datasetMounts || [];
  if (!workspaceMutationPolicy) {
    const error = new Error(`campaign_writable_repair_mutation_policy_required:${role}`);
    error.retryable = false;
    throw error;
  }
  const isolation = outcomeBlindIsolation({ workspace, datasetMounts });
  return {
    role,
    workspacePath: workspace,
    instructions,
    context: {
      campaignId: campaign.campaignId,
      paperId: campaign.paperId,
      ...context,
      outcomeBlindRepair: true,
    },
    requiredChecks,
    sandbox: 'workspace-write',
    requiredCapabilities: { workspaceIsolation: true },
    outputTokenBudget: Math.min(4096, remainingTokenCount),
    signal,
    isolationExcludes: isolation.isolationExcludes,
    isolationPolicy: isolation.isolationPolicy,
    workspaceMutationPolicy,
  };
}

export function buildCampaignAgentExecutionRequest({ campaign, node, workspace, manuscript, reviews, priorConvergence = null, qualityGateBlockers = [], revisionMaterialization = null, empiricalAssertionAuthority = null, reviewerExecutionAuthorityContext = null, empiricalOutcomeObserved = false, executionBudget, executionSignal }) {
  const kind = node.kind;
  const coderNode = /^coder(?:-|$)/.test(kind);
  const datasetMounts = campaign.spec.datasetMounts || [];
  const benchmarkSelector = campaign.spec.benchmarkSelector || null;
  const budget = campaignAgentOutputTokenBudget(kind);
  const formalRequested = [
    campaign.spec.paperQualityProfile,
    ...(campaign.spec.paperQualityProfiles || []),
  ].includes('formal_theorem_or_proof');
  const approvedProposalSeed = campaign.spec.approvedProposalSeed || null;
  const machineClaimAuthority = campaign.spec.scientificClaimAuthority || null;
  const claimAuthority = machineClaimAuthority || approvedProposalSeed;
  const proposalSeedSource = claimAuthority?.contractPath || null;
  const formalProposalSeedRequired = formalRequested
    && (claimAuthority?.status === 'approved_proposal_seed_bound'
      || claimAuthority?.status === 'autonomous_research_seed_bound');
  const proposalSeedContractPath = String(proposalSeedSource || 'PROPOSAL_CLAIM_PROOF_EVIDENCE_REPRO_SEED_CONTRACTS.json')
    .replace(/\\/g, '/').split('/').at(-1);
  const agentIsolation = coderNode
    ? outcomeBlindIsolation({ workspace, datasetMounts })
    : {
      isolationExcludes: datasetMounts.map((mount) => mount.source),
      isolationPolicy: { skipSourceSymlinks: true },
    };
  const instructions = buildCampaignAgentInstructions({
    kind,
    manuscript,
    roundIndex: node.roundIndex,
    reviews,
    language: node.spec?.language || node.language || 'python',
    requiresGpu: Boolean(node.spec?.requiresGpu || node.requiresGpu),
    datasetMounts,
    benchmarkSelector,
    formalProposalSeedRequired,
    proposalSeedContractPath,
    approvedProposalSeedBindingHash: approvedProposalSeed?.approvedProposalSeedBindingHash || null,
    claimAuthorityType: machineClaimAuthority
      ? 'machine-policy-authorized' : approvedProposalSeed ? 'operator-signed' : null,
    claimAuthorityBindingHash: machineClaimAuthority?.autonomousResearchSeedBindingHash
      || approvedProposalSeed?.approvedProposalSeedBindingHash || null,
    priorConvergence,
    qualityGateBlockers,
    revisionMaterialization,
    empiricalAssertionAuthority,
    empiricalOutcomeObserved,
  });
  return {
    role: node.role || kind,
    workspacePath: workspace,
    instructions: `${instructions}${containedMutationRetryInstruction(node)}`,
    context: {
      campaignId: campaign.campaignId,
      nodeId: node.nodeId,
      paperId: campaign.paperId,
      roundIndex: node.roundIndex,
      datasetMounts: datasetMounts.map((mount) => ({
        name: mount.name,
        workerPath: `/datasets/${mount.name}`,
        licenseId: mount.licenseId,
        manifestHash: mount.manifestHash,
      })),
      benchmarkSelector,
      formalProposalSeedRequired,
      proposalSeedContractPath,
      approvedProposalSeedBindingHash: approvedProposalSeed?.approvedProposalSeedBindingHash || null,
      claimAuthorityType: machineClaimAuthority
        ? 'machine-policy-authorized' : approvedProposalSeed ? 'operator-signed' : null,
      claimAuthorityBindingHash: machineClaimAuthority?.autonomousResearchSeedBindingHash
        || approvedProposalSeed?.approvedProposalSeedBindingHash || null,
      priorConvergence,
      qualityGateBlockers: Object.freeze([...qualityGateBlockers].map(String)),
      revisionMaterialization,
      empiricalAssertionAuthorityHash: empiricalAssertionAuthority?.empiricalAssertionAuthorityHash || null,
      empiricalAssertionAuthorityEntryCount: empiricalAssertionAuthority?.entryCount || 0,
      ...(reviewerExecutionAuthorityContext ? {
        campaignPlanHash: reviewerExecutionAuthorityContext.campaignPlanHash,
        manuscriptHash: reviewerExecutionAuthorityContext.manuscriptHash,
        attemptId: reviewerExecutionAuthorityContext.reviewAttemptId,
        reviewerExecutionAuthorityContext,
      } : {}),
      empiricalOutcomeObserved: empiricalOutcomeObserved === true,
    },
    requiredChecks: coderNode
      ? ['run the new smoke test']
      : kind === 'revise' ? [
        empiricalOutcomeObserved === true
          ? 'rerun manuscript-only checks affected by changed files'
          : 'rerun checks affected by changed files',
        ...(qualityGateBlockers.length ? ['rerun theorem manuscript readiness and clear every carried-forward blocker'] : []),
      ] : [],
    sandbox: isCampaignRefereeNode(kind) || kind === 'formal-review' ? 'read-only' : 'workspace-write',
    ...(coderNode ? { requiredCapabilities: { workspaceIsolation: true } } : {}),
    outputTokenBudget: Math.min(budget, Number(executionBudget.remainingTokenCount || budget)),
    timeoutMs: Math.min(
      CAMPAIGN_AGENT_MAXIMUM_TIMEOUT_MS,
      Number(executionBudget.remainingWallTimeMs || CAMPAIGN_AGENT_MAXIMUM_TIMEOUT_MS),
    ),
    signal: executionSignal,
    isolationExcludes: agentIsolation.isolationExcludes,
    isolationPolicy: agentIsolation.isolationPolicy,
    ...((empiricalOutcomeObserved === true && ['manuscript-integrate', 'revise'].includes(kind)) ? {
      workspaceMutationPolicy: outcomeBoundManuscriptMutationPolicy({ manuscript }),
    } : kind === 'research-plan' ? {
      workspaceMutationPolicy: researchPlanWorkspaceMutationPolicy(),
    } : kind === 'theorem-spec' ? {
      workspaceMutationPolicy: {
        allowedPaths: ['THEOREM_SPEC_DRAFT.json'],
        allowedPrefixes: [],
        allowedExtensions: [],
        forbiddenPaths: ['THEOREM_SPEC.json'],
        forbiddenExtensions: ['.tex'],
      },
    } : kind === 'formal-author' ? { workspaceMutationPolicy: formalWorkspaceMutationPolicy() }
      : coderNode ? {
        workspaceMutationPolicy: empiricalCodeWorkspaceMutationPolicy({
          language: node.spec?.language || node.language || 'python',
          benchmarkSelector,
          manuscript,
        }),
      } : ['writer', 'manuscript-integrate', 'revise'].includes(kind) ? {
        workspaceMutationPolicy: outcomeBoundManuscriptMutationPolicy({ manuscript }),
      } : {}),
  };
}

export function buildFormalProofRepairRequest({ campaign, workspace, manuscript, diagnostics, iteration, remainingTokenCount, signal }) {
  return commonRepairRequest({
    campaign,
    workspace,
    role: 'formal-proof-repair',
    instructions: `Repair only the Lean/Lake formalization for canonical THEOREM_SPEC.json. Preserve every claimId, theorem statement, assumption boundary, proof obligation, proofObligationContract, proofObligationMapping, and manuscriptSource binding. Never modify ${manuscript}, any .tex file, THEOREM_SPEC.json, or THEOREM_SPEC_DRAFT.json. Make the smallest change needed to address these verifier diagnostics, then update RESEARCH_WORKER_PLAN.json hashes and bindings exactly. Repair iteration ${iteration}. Diagnostics:\n${String(diagnostics || '').slice(-6000)}`,
    context: { failedNode: 'formal-verify', iteration },
    requiredChecks: ['Lean/Lake project must be ready for independent semantic review and fresh replay'],
    remainingTokenCount,
    signal,
    workspaceMutationPolicy: formalWorkspaceMutationPolicy(),
  });
}

function formalProofSearchStrategyInstructions(candidate) {
  if (candidate?.strategy === 'direct_elaboration') {
    return 'Compile the exact authorized theorem type incrementally, inspect every remaining Lean proof state, and construct the smallest direct proof term or tactic proof. Do not guess that a tactic closed a goal: rerun Lean and retain only an elaborating candidate.';
  }
  if (candidate?.strategy === 'mathlib_retrieval') {
    return 'Reinspect the current Lean proof states, then search only the pinned local Mathlib environment for matching declarations and tactics (for example #check, exact?, apply?, library_search, source/symbol search). Use fully qualified declarations where ambiguity exists and rerun Lean after every material change. Network retrieval and new dependencies are forbidden.';
  }
  if (candidate?.strategy === 'bounded_refutation_or_synthesis') {
    return 'Before another proof attempt, use bounded examples or decidable finite instances where available to look for a counterexample to the exact authorized proposition. A found example is diagnostic and must never be repaired by weakening or changing the claim. Failure to find an example is not evidence of truth. If no counterexample is found, make one final proof-state-driven synthesis attempt using only the pinned imports; only kernel success establishes a proof.';
  }
  throw new Error('formal_proof_search_candidate_strategy_invalid');
}

export function bindFormalProofSearchCandidateRequest({
  request,
  typedTheoremObligationBundle,
  formalProofSearchPlan,
  candidate,
} = {}) {
  const ordinal = Number(candidate?.ordinal);
  if (!request || !typedTheoremObligationBundle?.typedTheoremObligationBundleHash
    || !formalProofSearchPlan?.formalProofSearchPlanHash
    || candidate !== formalProofSearchPlan.candidates?.[ordinal]) {
    throw new Error('formal_proof_search_candidate_request_invalid');
  }
  const strategyInstructions = formalProofSearchStrategyInstructions(candidate);
  return Object.freeze({
    ...request,
    instructions: `${request.instructions}\n\nSystem-bound formal proof-search candidate ${ordinal + 1}/${formalProofSearchPlan.candidateCount} (${candidate.strategy}). ${strategyInstructions} The typed obligation bundle, candidate order, exact claim/type authority, and import policy are immutable. Successful completion still requires independent semantic review, kernel verification, axiom audit, and fresh replay. This bounded search does not establish novelty, scientific truth, unrestricted theorem discovery, or natural-language/Lean equivalence.`,
    context: Object.freeze({
      ...request.context,
      typedTheoremObligationBundleHash:
        typedTheoremObligationBundle.typedTheoremObligationBundleHash,
      formalProofSearchPlanHash: formalProofSearchPlan.formalProofSearchPlanHash,
      formalProofSearchCandidate: candidate,
    }),
    requiredChecks: Object.freeze([
      ...(request.requiredChecks || []),
      ...candidate.requiredOperations,
      'independent semantic review and kernel replay remain mandatory',
    ]),
  });
}

export function buildDatasetConsumptionRepairRequest({ campaign, workspace, entrypoint, language, nodeKind, contract, remainingTokenCount, signal }) {
  return commonRepairRequest({
    campaign,
    workspace,
    role: 'dataset-consumption-contract-repair',
    instructions: `Repair ${entrypoint} so it consumes every declared read-only dataset from its worker path or environment variable: ${contract.evidence.map((item) => `${item.workerPath} via ${item.environmentName}`).join(', ')}. Remove any source-tree or host-specific input-data fallback. Preserve deterministic outputs and HEPTA_OUTPUT_DIR. Make the smallest valid change.`,
    context: { failedNode: nodeKind, language, entrypoint, datasets: contract.evidence },
    requiredChecks: ['all declared datasets must be consumed through their read-only worker mount'],
    remainingTokenCount,
    signal,
    workspaceMutationPolicy: empiricalCodeWorkspaceMutationPolicy({
      entrypoint, language, manuscript: campaign.spec.manuscript || 'main.tex',
    }),
  });
}

export function buildLatexRepairRequest({ campaign, workspace, manuscript, nodeKind, diagnostic, remainingTokenCount, signal }) {
  const safeDiagnostic = outcomeBlindDiagnosticText(diagnostic, 'execution');
  return commonRepairRequest({
    campaign,
    workspace,
    role: 'latex-repair',
    instructions: `Repair ${manuscript} so latexmk succeeds. Make the smallest valid change and preserve correct content. ${safeDiagnostic}`,
    context: {
      failedNode: nodeKind,
      empiricalOutcomeBlindRepairDiagnosticHash:
        diagnostic.empiricalOutcomeBlindRepairDiagnosticHash,
    },
    requiredChecks: ['latexmk must succeed after the repair'],
    remainingTokenCount,
    signal,
    workspaceMutationPolicy: outcomeBoundManuscriptMutationPolicy({ manuscript }),
  });
}

export function buildEmpiricalCodeRepairRequest({ campaign, workspace, entrypoint, language, nodeKind, diagnostic, remainingTokenCount, signal }) {
  const benchmarkSelector = campaign.spec.benchmarkSelector || null;
  const safeDiagnostic = outcomeBlindDiagnosticText(diagnostic, 'execution');
  return commonRepairRequest({
    campaign,
    workspace,
    role: 'empirical-code-repair',
    instructions: benchmarkSelector
      ? `Repair the three sibling treatment/baseline/ablation adapters for ${entrypoint}. This is a technical repair only: the frozen protocol, hypotheses, thresholds, seed schedule, arm semantics, estimator, and scientific verdict are immutable; never tune code to obtain a positive or significant result. Each adapter must remain byte-distinct, concatenate the numbered HEPTA_BENCHMARK_CHALLENGE_JSON_PART_* values, parse the SystemBenchmarkArmBatchChallenge, and write only a CampaignBenchmarkArmBatchResponses observation.json with every ordered cell and every caseId-keyed scalar under cell.challenge.responseField. Baseline must echo referenceResponse exactly. Never self-report labels, raw events, final metrics, or aggregates. ${safeDiagnostic}`
      : `Repair ${entrypoint} only to correct the reported technical execution failure. Do not change the research question, method, hypotheses, thresholds, seeds, metric definitions, or code behavior to target a positive or significant result. The empirical command must succeed, its self-check must pass, and it must write HEPTA_OUTPUT_DIR/results.json plus HEPTA_OUTPUT_DIR/results.csv without falling back to the working directory. results.csv must begin with the exact header metric,value and contain at least one non-empty metric with a finite numeric value. Do not hard-code an automation-results path or a prior node id. Make the smallest valid change. ${safeDiagnostic}`,
    context: {
      failedNode: nodeKind,
      language,
      entrypoint,
      empiricalOutcomeBlindRepairDiagnosticHash:
        diagnostic.empiricalOutcomeBlindRepairDiagnosticHash,
    },
    requiredChecks: ['empirical command and self-check must pass after the repair'],
    remainingTokenCount,
    signal,
    workspaceMutationPolicy: empiricalCodeWorkspaceMutationPolicy({
      entrypoint, language, benchmarkSelector, manuscript: campaign.spec.manuscript || 'main.tex',
    }),
  });
}

export function buildEmpiricalArtifactRepairRequest({ campaign, workspace, entrypoint, language, nodeKind, diagnostic, remainingTokenCount, signal }) {
  const benchmarkSelector = campaign.spec.benchmarkSelector || null;
  const safeDiagnostic = outcomeBlindDiagnosticText(diagnostic, 'result-contract');
  return commonRepairRequest({
    campaign,
    workspace,
    role: 'empirical-artifact-contract-repair',
    instructions: benchmarkSelector
      ? `Repair only the serialization/shape defect in the three sibling arm adapters for ${entrypoint}; the frozen protocol, hypotheses, thresholds, seeds, arm semantics, and scientific verdict are immutable, and result-targeted tuning is forbidden. Each adapter must concatenate the numbered HEPTA_BENCHMARK_CHALLENGE_JSON_PART_* values and write a valid ordered CampaignBenchmarkArmBatchResponses observation.json for every cell and case. Baseline must echo referenceResponse; do not emit raw events or final metrics. ${safeDiagnostic}`
      : `Repair only the artifact serialization defect in ${entrypoint}; do not change methods, hypotheses, thresholds, seeds, metric values, or behavior to target a positive/significant result. A successful run must write HEPTA_OUTPUT_DIR/results.json plus HEPTA_OUTPUT_DIR/results.csv without falling back to the working directory. results.csv must begin with the exact header metric,value and contain at least one non-empty metric with a finite numeric value. Do not hard-code an automation-results path or a prior node id. ${safeDiagnostic}`,
    context: {
      failedNode: nodeKind,
      language,
      entrypoint,
      empiricalOutcomeBlindRepairDiagnosticHash:
        diagnostic.empiricalOutcomeBlindRepairDiagnosticHash,
    },
    requiredChecks: ['the empirical command must create results.json and canonical metric,value results.csv in HEPTA_OUTPUT_DIR'],
    remainingTokenCount,
    signal,
    workspaceMutationPolicy: empiricalCodeWorkspaceMutationPolicy({
      entrypoint, language, benchmarkSelector, manuscript: campaign.spec.manuscript || 'main.tex',
    }),
  });
}
