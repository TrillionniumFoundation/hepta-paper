import { empiricalClaimDeclarationsFromAnalysisProtocol } from '../../paper-domain/automation/analysis-protocol-contract.mjs';
import { isCampaignRefereeNode } from './campaign-node-kind-policy.mjs';
import { outcomeBoundManuscriptMutationPolicy } from './campaign-confirmatory-lineage-policy.mjs';

export { isCampaignAgentNode, isCampaignRefereeNode } from './campaign-node-kind-policy.mjs';

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
  if (isCampaignRefereeNode(kind)) return 1024;
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
  return ` The system-derived empirical assertion authority is immutable at automation-results/EMPIRICAL_ASSERTION_AUTHORITY.json and has hash ${authority.empiricalAssertionAuthorityHash}. Read it directly; never create, rewrite, or self-sign it. Report every authority entry exactly once using this exact three-part form: a whole-line % HEPTA_EMPIRICAL_ASSERTION_BEGIN {"version":1,"assertionId":"exact-authority-id","authorityEntryHash":"exact-authority-entry-hash"}; then copy that entry's canonicalManuscriptBody byte-for-byte as one line; then a whole-line % HEPTA_EMPIRICAL_ASSERTION_END exact-authority-id. Never paraphrase, wrap, escape, hide, prefix, suffix, or place a TeX command, macro, conditional, comment, or extra byte inside the canonical body. Preserve every already-bound HEPTA_EMPIRICAL_CLAIM range byte-for-byte. The final trusted manuscript title must be exactly \\title{Autonomous bounded research report}; author and date must be empty. Keep exactly this rendered Limitations sentence: "This report is limited to the registered typed assertions and kernel-verified formal theorem." Remove every other rendered prose line outside canonical typed claim/assertion blocks and separately verified formal environments; use only supported neutral section/document structure. Do not add prose in an abstract, conclusion, caption, table, figure, title, paragraph command, or renamed result section. A negative or inconclusive result is a result and must not be reframed as support. HEPTA_RESULT legacy markers are forbidden.`;
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
} = {}) {
  const empiricalClaimMarkers = empiricalClaimMarkerInstructions(benchmarkSelector);
  const empiricalAssertions = typedEmpiricalAssertionInstructions(empiricalAssertionAuthority);
  if (kind === 'research-plan') return `Inspect ${manuscript} and the project. Write a concise RESEARCH_PLAN.md of at most 450 words with falsifiable claims, code tasks, datasets, metrics, baselines, ablations, seeds, and stopping criteria. Prefer compact tables or bullets over prose.`;
  if (kind === 'writer' && formalProposalSeedRequired && claimAuthorityType === 'machine-policy-authorized') return `This is a machine-proposed research source authorized only for bounded execution by system policy and bound by ${claimAuthorityBindingHash || 'a missing binding hash'}; it is not operator approval, scientific validation, or release authority. Read ${proposalSeedContractPath}; require kind AutonomousResearchSeedContractBundle, status autonomous_research_seed_contracts_ready, claimAuthorityType machine-policy-authorized, valid safety declarations, and non-empty claims. Use exactly the claims whose verificationMode is formal_kernel as theorem authority; never turn an empirical_protocol outcome claim, observed metric, treatment effect, replay result, or empirical obligation into a theorem premise or axiom. Preserve every selected formal claim's exact statement, assumptions, quantifiers, negativeBoundaries, and proofObligations, and use each selected formal claim exactly once. Reject circular P-implies-P, assumption-echo, True, or otherwise vacuous theorem formulations. Add its natural-language proof in an immediately adjacent \\begin{proof} environment and state every formal negative boundary in a Limitations section. Do not invent evidence, write Lean, or create THEOREM_SPEC files. The later system-finalized theorem-spec and independent formal review may reject the claim; external release attestation remains required. If the authority or lineage is missing or blocked, fail closed.${empiricalClaimMarkers}`;
  if (kind === 'writer' && formalProposalSeedRequired) return `This is an approved formal proposal source bound by ${approvedProposalSeedBindingHash || 'a missing binding hash'}. Read ${proposalSeedContractPath}; require kind PaperProposalSeedContractBundle, status proposal_seed_contracts_ready, non-empty proposal-derived claims, proof obligations, proposalEnvelopeHash, productionPlanEnvelopeHash, reviewGateHash, and a scientificClaimInputHash. Each claim carries the operator-supplied exact scientific statement plus non-empty assumptions, quantifiers, negativeBoundaries, and proofObligations. Use every approved claim exactly once as the only theorem authority. Preserve its complete semantic scope; TeX syntax conversion is allowed, but paraphrasing, narrowing, strengthening, adding conditions, deleting quantifiers, or substituting a different claim is forbidden. Add its natural-language proof in an immediately adjacent \\begin{proof} environment and state every approved negative boundary in a Limitations section. Do not invent evidence, write Lean, or create THEOREM_SPEC files. The later system-finalized theorem-spec and Lean candidate stages bind and independently review the result; if the approved seed contract or scientific claim lineage is missing or blocked, fail closed.${empiricalClaimMarkers}`;
  if (kind === 'writer') return `Improve ${manuscript} according to RESEARCH_PLAN.md. Strengthen claims, related work, methods, limitations, and reproducibility without inventing results. Keep the complete manuscript concise enough for the configured output budget.${empiricalClaimMarkers}`;
  if (kind === 'theorem-spec') return `Read ${manuscript} and every recursively included TeX file.${formalProposalSeedRequired ? ` Also read the bound scientific claim authority in ${proposalSeedContractPath}.` : ''} Enumerate every theorem-like environment in source order. Write exactly one file, THEOREM_SPEC_DRAFT.json, and modify nothing else. Its exact JSON schema is {"version":1,"kind":"TheoremSpecificationDraft","claims":[{"claimKey":"stable-key","title":"short title","statement":"exact theorem body text","assumptions":["..."],"quantifiers":["..."],"negativeBoundaries":["at least one explicit non-claim"],"proofObligations":["at least one concrete obligation"],"evidenceObligations":[],"manuscriptIntent":"existing"${formalProposalSeedRequired ? ',"proposalClaimId":"exact bound formal claim id"' : ''}}]}. Every object must contain exactly those keys, with no claimId, hashes, source paths, byte offsets, receipts, TODOs, or extra fields. statement must reproduce the exact theorem body text, not a stronger paraphrase.${formalProposalSeedRequired ? ` Map every theorem one-to-one to the authorized ${claimAuthorityType === 'machine-policy-authorized' ? 'formal_kernel claim only; exclude every empirical_protocol claim' : 'operator-approved proposal claim'} by exact proposalClaimId; do not omit, duplicate, strengthen, or substitute an unrelated claim. This mapping is only a locator and will not be trusted until independently reviewed.` : ''} The system, never the agent, binds source bytes and creates canonical THEOREM_SPEC.json.`;
  if (kind === 'formal-author') return `Treat THEOREM_SPEC.json and every .tex file as immutable authority. For every canonical specification claim, use its exact claimId, statement, proof obligations, proofObligationContracts, and manuscriptSource binding. Create or update only Lean/Lake files and RESEARCH_WORKER_PLAN.json. Prove the exact statements without sorry/admit/unreviewed axioms. Every formal_verifier_lake claim binding must use the canonical claimId, theoremSpecificationHash, theoremSpecificationClaimHash, and exact manuscriptSource path, byteStart, byteEnd, and contentHash from THEOREM_SPEC.json, and include theoremName,sourceFile,expectedTypeHash,sourceStatementHash,proofObligations. Also copy every canonical proofObligationContract exactly and provide proofObligationMappings as [{obligationId,displayText,leanDeclarations:["LeanDeclaration"]}], covering each obligation exactly once with one or more declarations in sourceFile. Do not modify any .tex, THEOREM_SPEC.json, THEOREM_SPEC_DRAFT.json, Markdown, empirical artifact, or source package contract. Do not weaken a claim to make the proof pass. The verifier generates its own fresh #check/#print axioms audit outside the source workspace.`;
  if (kind === 'formal-review') return `Read-only independent review: bind your review to canonical THEOREM_SPEC.json, compare every specification claim and exact manuscript byte range with its Lean theorem type and proof obligations, and reject any mismatch.${formalProposalSeedRequired ? ` Independently compare each exact proposalClaimSource text from THEOREM_SPEC.json (ultimately bound to ${proposalSeedContractPath}) with the natural-language theorem. Accept only semantic equivalence to the bound ${claimAuthorityType === 'machine-policy-authorized' ? 'machine-policy-authorized formal_kernel claim; this is not operator approval and does not establish novelty or scientific correctness' : 'operator-approved proposal claim'}; narrowing, strengthening, unrelated substitution, or scope change must fail${claimAuthorityType === 'machine-policy-authorized' ? ' and external release attestation remains required' : ' and requires a new operator-signed proposal approval outside this review'}.` : ''} There must be exactly one review for every canonical claim and no extra review. Do not modify any file. Return only JSON as {version:${formalProposalSeedRequired ? 2 : 1},kind:"FormalClaimSemanticReview",theoremSpecificationHash:"sha256:...",reviews:[...]}; every review must contain claimId,theoremName,manuscriptClaimHash,theoremTypeHash,sourceStatementHash,status:"formal_semantic_review_verified" only when the manuscript theorem and Lean type are equivalent,semanticEquivalenceVerified,and verdict:"equivalent"${formalProposalSeedRequired ? ', plus proposalClaimId,proposalClaimRecordHash,proposalClaimTextHash copied exactly from proposalClaimSource, proposalToTheoremSemanticVerified, proposalToTheoremVerdict:"equivalent", and approvedNarrowingRationale:null' : ''}. Identity and execution authority are injected by the runtime. Block omissions, narrowing, strengthening, unrelated or conditional or vacuous proofs, sorry/admit, assumption echo, or a specification hash mismatch.`;
  if (/^coder(?:-|$)/.test(kind)) {
    const entrypoint = { python: 'experiments/run.py', r: 'experiments/run.R', node: 'experiments/run.mjs', julia: 'experiments/run.jl', lean: 'Main.lean' }[language] || `experiments/run.${language}`;
    const extensionIndex = entrypoint.lastIndexOf('.');
    const armEntrypoints = ['treatment', 'baseline', 'ablation'].map((arm) => `${entrypoint.slice(0, extensionIndex)}.${arm}${entrypoint.slice(extensionIndex)}`);
    const datasets = datasetMounts.length
      ? ` Declared datasets are mounted read-only inside the worker at ${datasetMounts.map((mount) => `/datasets/${mount.name} (${mount.licenseId})`).join(', ')}; use only those declared paths for external data.`
      : '';
    const benchmark = benchmarkSelector
      ? ` Implement three distinct candidate arm adapters at ${armEntrypoints.join(', ')}; never branch one shared entrypoint on HEPTA_EXPERIMENT_ARM. Each arm is invoked exactly once per run. Reconstruct the repository-owned SystemBenchmarkArmBatchChallenge by concatenating HEPTA_BENCHMARK_CHALLENGE_JSON_PART_1 through the integer HEPTA_BENCHMARK_CHALLENGE_PART_COUNT in numeric order. Write only observation.json as {version:1,kind:"CampaignBenchmarkArmBatchResponses",systemBenchmarkArmBatchChallengeHash:batch.systemBenchmarkArmBatchChallengeHash,cells:[{cellId,systemBenchmarkCellChallengeHash,responses:[...]}]}. Preserve batch cell order and return exactly one response for every caseId under each cell.challenge.responseField; do not invent labels, outcomes, raw events, final metrics, aggregates, results.json, or results.csv. The baseline adapter must return each case's repository-provided referenceResponse exactly. The treatment adapter uses full public inputs; the ablation adapter only receives the system-redacted input. The host-held oracle evaluates every seed/repetition cell and derives bounded raw events, metrics, aggregation, CI, power, and acceptance. Keep the three adapter implementations byte-distinct; their source and runner provenance are independently bound.`
      : '';
    return `Implement the smallest valid ${entrypoint} for RESEARCH_PLAN.md${requiresGpu ? ' using the declared GPU runtime' : ''}. Use deterministic seeds and no network.${benchmarkSelector ? '' : ' Read HEPTA_OUTPUT_DIR from the environment and write HEPTA_OUTPUT_DIR/results.json plus HEPTA_OUTPUT_DIR/results.csv; do not fall back to the working directory. results.csv must begin with the exact header metric,value and contain at least one non-empty metric with a finite numeric value.'} Include a fast self-check. Do not fabricate outputs or add unnecessary framework code.${benchmark}${datasets}`;
  }
  if (kind === 'manuscript-integrate') return `Integrate only actually generated original and replay empirical evidence from automation-results/ into ${manuscript}; clearly distinguish observed results from planned work. The empirical outcome is already observed: modify manuscript and interpretation only. Never modify an empirical entrypoint, treatment/baseline/ablation adapter, imported experiment module, analysis protocol, hypothesis, threshold, metric, seed schedule, or experiment configuration.${empiricalAssertions}`;
  if (/^referee-\d+$/.test(kind)) return `Independently review ${manuscript} before revision at round ${roundIndex}. Do not modify files.${empiricalAssertionAuthority ? ` Read the immutable typed authority and reject any assertion body that is not byte-for-byte equal to canonicalManuscriptBody, any TeX hiding/rendering construct, omitted negative result or limitation, untyped rendered prose, or conclusion beyond the bounded canonical statement. Deterministic binding remains mandatory regardless of your verdict. Authority hash: ${empiricalAssertionAuthority.empiricalAssertionAuthorityHash}.` : ''} Return JSON with verdict (accept|revise), score (0..1), criticalFindingCount, findings, and summary.`;
  if (/^revision-referee-\d+$/.test(kind)) return `Independently review the revised ${manuscript} at round ${roundIndex}. Judge the current file, not a prior draft. Do not modify files.${empiricalAssertionAuthority ? ` Re-read automation-results/EMPIRICAL_ASSERTION_AUTHORITY.json and reject any body not byte-for-byte equal to canonicalManuscriptBody, any TeX hiding/rendering construct, omission, untyped rendered prose, or unsupported generalization. Deterministic binding remains mandatory regardless of your verdict. Authority hash: ${empiricalAssertionAuthority.empiricalAssertionAuthorityHash}.` : ''} Return JSON with verdict (accept|revise), score (0..1), criticalFindingCount, findings, and summary.`;
  if (kind === 'revise') return `Revise ${manuscript} and its interpretation to address the following independent reviews and every carried-forward deterministic quality-gate blocker. The empirical outcome is already observed: never modify an empirical entrypoint, treatment/baseline/ablation adapter, imported experiment module, analysis protocol, hypothesis, threshold, metric, seed schedule, experiment configuration, or any code/configuration that can affect empirical behavior. A negative, non-significant, or inconclusive result must remain reportable and must not trigger method tuning. Preserve correct content and run manuscript checks.${empiricalAssertions} Preserve every HEPTA_EMPIRICAL_CLAIM marker pair and its exact hypothesis text byte-for-byte. For theorem readiness, create proof_status.md when theorem_proof_status_missing is present, create evidence_manifest.md when theorem_evidence_manifest_missing is present, and add a real appendix/supplement or an explicit justified waiver when theorem_appendix_or_supplement_missing is present. Do not claim a proof is closed unless the current formal verification evidence supports it. Prior convergence: ${JSON.stringify(priorConvergence)}. Revision materialization: ${JSON.stringify(revisionMaterialization)}. Quality-gate blockers: ${JSON.stringify(qualityGateBlockers)}. Reviews: ${JSON.stringify(reviews)}`;
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
  return {
    role,
    workspacePath: workspace,
    instructions,
    context: { campaignId: campaign.campaignId, paperId: campaign.paperId, ...context },
    requiredChecks,
    sandbox: 'workspace-write',
    outputTokenBudget: Math.min(4096, remainingTokenCount),
    signal,
    isolationExcludes: datasetMounts.map((mount) => mount.source),
    isolationPolicy: { skipSourceSymlinks: true },
    ...(workspaceMutationPolicy ? { workspaceMutationPolicy } : {}),
  };
}

export function buildCampaignAgentExecutionRequest({ campaign, node, workspace, manuscript, reviews, priorConvergence = null, qualityGateBlockers = [], revisionMaterialization = null, empiricalAssertionAuthority = null, empiricalOutcomeObserved = false, executionBudget, executionSignal }) {
  const kind = node.kind;
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
  return {
    role: node.role || kind,
    workspacePath: workspace,
    instructions: buildCampaignAgentInstructions({
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
    }),
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
      empiricalOutcomeObserved: empiricalOutcomeObserved === true,
    },
    requiredChecks: /^coder(?:-|$)/.test(kind)
      ? ['run the new smoke test']
      : kind === 'revise' ? [
        empiricalOutcomeObserved === true
          ? 'rerun manuscript-only checks affected by changed files'
          : 'rerun checks affected by changed files',
        ...(qualityGateBlockers.length ? ['rerun theorem manuscript readiness and clear every carried-forward blocker'] : []),
      ] : [],
    sandbox: isCampaignRefereeNode(kind) || kind === 'formal-review' ? 'read-only' : 'workspace-write',
    outputTokenBudget: Math.min(budget, Number(executionBudget.remainingTokenCount || budget)),
    timeoutMs: executionBudget.remainingWallTimeMs,
    signal: executionSignal,
    isolationExcludes: datasetMounts.map((mount) => mount.source),
    isolationPolicy: { skipSourceSymlinks: true },
    ...((empiricalOutcomeObserved === true && ['manuscript-integrate', 'revise'].includes(kind)) ? {
      workspaceMutationPolicy: outcomeBoundManuscriptMutationPolicy({ manuscript }),
    } : kind === 'theorem-spec' ? {
      workspaceMutationPolicy: {
        allowedPaths: ['THEOREM_SPEC_DRAFT.json'],
        allowedPrefixes: [],
        allowedExtensions: [],
        forbiddenPaths: ['THEOREM_SPEC.json'],
        forbiddenExtensions: ['.tex'],
      },
    } : kind === 'formal-author' ? { workspaceMutationPolicy: formalWorkspaceMutationPolicy() } : {}),
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
  });
}

export function buildLatexRepairRequest({ campaign, workspace, manuscript, nodeKind, diagnostics, remainingTokenCount, signal }) {
  return commonRepairRequest({
    campaign,
    workspace,
    role: 'latex-repair',
    instructions: `Repair ${manuscript} so latexmk succeeds. Make the smallest valid change and preserve correct content. Compiler diagnostics:\n${String(diagnostics || '').slice(-3000)}`,
    context: { failedNode: nodeKind },
    requiredChecks: ['latexmk must succeed after the repair'],
    remainingTokenCount,
    signal,
  });
}

export function buildEmpiricalCodeRepairRequest({ campaign, workspace, entrypoint, language, nodeKind, diagnostics, remainingTokenCount, signal }) {
  const benchmarkSelector = campaign.spec.benchmarkSelector || null;
  return commonRepairRequest({
    campaign,
    workspace,
    role: 'empirical-code-repair',
    instructions: benchmarkSelector
      ? `Repair the three sibling treatment/baseline/ablation adapters for ${entrypoint}. This is a technical repair only: the frozen protocol, hypotheses, thresholds, seed schedule, arm semantics, estimator, and scientific verdict are immutable; never tune code to obtain a positive or significant result. Each adapter must remain byte-distinct, concatenate the numbered HEPTA_BENCHMARK_CHALLENGE_JSON_PART_* values, parse the SystemBenchmarkArmBatchChallenge, and write only a CampaignBenchmarkArmBatchResponses observation.json with every ordered cell and every caseId-keyed scalar under cell.challenge.responseField. Baseline must echo referenceResponse exactly. Never self-report labels, raw events, final metrics, or aggregates. Runtime diagnostics:\n${String(diagnostics || '').slice(-3000)}`
      : `Repair ${entrypoint} only to correct the reported technical execution failure. Do not change the research question, method, hypotheses, thresholds, seeds, metric definitions, or code behavior to target a positive or significant result. The empirical command must succeed, its self-check must pass, and it must write HEPTA_OUTPUT_DIR/results.json plus HEPTA_OUTPUT_DIR/results.csv without falling back to the working directory. results.csv must begin with the exact header metric,value and contain at least one non-empty metric with a finite numeric value. Do not hard-code an automation-results path or a prior node id. Make the smallest valid change. Runtime diagnostics:\n${String(diagnostics || '').slice(-3000)}`,
    context: { failedNode: nodeKind, language, entrypoint },
    requiredChecks: ['empirical command and self-check must pass after the repair'],
    remainingTokenCount,
    signal,
  });
}

export function buildEmpiricalArtifactRepairRequest({ campaign, workspace, entrypoint, language, nodeKind, blockers, remainingTokenCount, signal }) {
  const benchmarkSelector = campaign.spec.benchmarkSelector || null;
  return commonRepairRequest({
    campaign,
    workspace,
    role: 'empirical-artifact-contract-repair',
    instructions: benchmarkSelector
      ? `Repair only the serialization/shape defect in the three sibling arm adapters for ${entrypoint}; the frozen protocol, hypotheses, thresholds, seeds, arm semantics, and scientific verdict are immutable, and result-targeted tuning is forbidden. Each adapter must concatenate the numbered HEPTA_BENCHMARK_CHALLENGE_JSON_PART_* values and write a valid ordered CampaignBenchmarkArmBatchResponses observation.json for every cell and case. Baseline must echo referenceResponse; do not emit raw events or final metrics. Contract blockers: ${blockers.join(', ')}`
      : `Repair only the artifact serialization defect in ${entrypoint}; do not change methods, hypotheses, thresholds, seeds, metric values, or behavior to target a positive/significant result. A successful run must write HEPTA_OUTPUT_DIR/results.json plus HEPTA_OUTPUT_DIR/results.csv without falling back to the working directory. results.csv must begin with the exact header metric,value and contain at least one non-empty metric with a finite numeric value. Do not hard-code an automation-results path or a prior node id. Contract blockers: ${blockers.join(', ')}`,
    context: { failedNode: nodeKind, language, entrypoint },
    requiredChecks: ['the empirical command must create results.json and canonical metric,value results.csv in HEPTA_OUTPUT_DIR'],
    remainingTokenCount,
    signal,
  });
}
