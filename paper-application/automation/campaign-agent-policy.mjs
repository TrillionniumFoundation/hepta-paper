import path from 'node:path';
import { empiricalClaimDeclarationsFromAnalysisProtocol } from '../../paper-domain/automation/analysis-protocol-contract.mjs';
import {
  formalObligationSpecificInstructions,
  formalProofSearchStrategyInstructions,
} from './campaign-formal-proof-instruction-policy.mjs';
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
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SAFE_EVIDENCE_KIND = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$/;
const MANUSCRIPT_EVIDENCE_CLAIM_CLASSES = new Set([
  'interpretation', 'limitation', 'method', 'related_work', 'reproducibility', 'scope',
]);

function venueRewriteInstructions({ targetVenue = null, sourceVenue = null } = {}) {
  const target = String(targetVenue || '').trim();
  if (!target) return '';
  const source = String(sourceVenue || '').trim() || 'the source venue';
  const token = target.toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (token !== 'iclr') {
    return ` This is a local venue-rewrite campaign from ${source} to ${target}. Preserve the source venue as immutable provenance, adapt only the manuscript in the private COW workspace, and do not upload, submit, contact a portal, or use an external venue credential. Do not claim compliance with an official ${target} template unless a pinned local template and a successful local compile check are present.`;
  }
  return ` This is a local ${source}-to-ICLR rewrite in a private copy-on-write workspace. Treat ${source} as immutable provenance and ICLR as the target framing only; never edit SOURCE_WORKSPACE.json, paper.json, source receipts, or the canonical source tree. Reframe the abstract, introduction, related work, method positioning, and limitations for an ICLR learning-systems audience without strengthening claims or inventing results. Remove NeurIPS-specific style/checklist/deadline language from the draft and use an ICLR template only when a pinned local template is actually available; otherwise keep a compile-safe local draft and explicitly report template compliance as pending. Preserve double-blind anonymity (no author identities, acknowledgments, or metadata leaks), retain every theorem/evidence boundary and negative result, and keep all experiments reproducible. This campaign is local-only: do not upload, submit, contact an ICLR portal, or use network credentials.`;
}
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

export function autonomousMachineWriterWorkspaceMutationPolicy({
  manuscript = 'main.tex',
} = {}) {
  return Object.freeze({
    allowedPaths: Object.freeze([
      normalizedWorkspacePath(manuscript, 'campaign_manuscript_path_invalid'),
      'AUTONOMOUS_MANUSCRIPT_IR_DRAFT.json',
    ]),
    allowedPrefixes: Object.freeze([]),
    allowedExtensions: Object.freeze([]),
    forbiddenPaths: Object.freeze([
      'proof_status.md',
      'evidence_manifest.md',
      'AUTONOMOUS_MANUSCRIPT_IR.json',
      'RESEARCH_PLAN.md',
      'THEOREM_SPEC.json',
      'THEOREM_SPEC_DRAFT.json',
    ]),
    forbiddenExtensions: Object.freeze(['.lean']),
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

function canonicalManuscriptEvidenceRefBindings(values, {
  required = false,
} = {}) {
  if (values === null || values === undefined) {
    if (required) throw new Error('campaign_manuscript_evidence_ref_bindings_required');
    return null;
  }
  if (!Array.isArray(values) || !values.length || values.length > 512) {
    throw new Error('campaign_manuscript_evidence_ref_bindings_invalid');
  }
  const bindings = values.map((value) => {
    const keys = value && typeof value === 'object' && !Array.isArray(value)
      ? Object.keys(value).sort() : [];
    const claimClasses = Array.isArray(value?.claimClasses)
      ? value.claimClasses.map(String) : [];
    if (JSON.stringify(keys) !== JSON.stringify(['claimClasses', 'hash', 'kind'])
      || !SAFE_EVIDENCE_KIND.test(String(value.kind || ''))
      || !SHA256.test(String(value.hash || ''))
      || !claimClasses.length
      || new Set(claimClasses).size !== claimClasses.length
      || claimClasses.some((claimClass) => (
        !MANUSCRIPT_EVIDENCE_CLAIM_CLASSES.has(claimClass)
      ))) {
      throw new Error('campaign_manuscript_evidence_ref_bindings_invalid');
    }
    return Object.freeze({
      kind: String(value.kind),
      hash: String(value.hash),
      claimClasses: Object.freeze([...claimClasses].sort()),
    });
  });
  const keys = bindings.map((binding) => `${binding.kind}:${binding.hash}`);
  if (new Set(keys).size !== keys.length) {
    throw new Error('campaign_manuscript_evidence_ref_bindings_invalid');
  }
  return Object.freeze(bindings);
}

function typedEmpiricalAssertionInstructions(
  authority,
  evidenceRefBindings = null,
  { requireExactBindings = false } = {},
) {
  if (!authority) return '';
  const bindings = canonicalManuscriptEvidenceRefBindings(evidenceRefBindings, {
    required: requireExactBindings,
  });
  const bindingInstruction = bindings
    ? ` The exact system-verified evidenceRef bindings eligible for this attempt are ${JSON.stringify(bindings)}. For each prose or citation block, use only a hash in this list and only when that block's claimClass appears in the same binding's claimClasses. File presence and sha256 syntax do not confer evidence authority. Before returning, inspect every existing prose/citation block and replace or remove any evidenceRef absent from this list or incompatible with its claimClass.`
    : ' Every prose or citation block must use only renderer-admitted evidence identities from the verified proposal, policy authorization, seed bundle, prior-art receipt, empirical claim lineage, or empirical assertion authority. Use proposal, policy, or seed identities for scope and method prose; use typed empirical authority-entry identities for observed-result interpretation. Do not treat arbitrary hashes found in those files as evidence authority.';
  return ` The system-derived empirical assertion authority is immutable at automation-results/EMPIRICAL_ASSERTION_AUTHORITY.json and has hash ${authority.empiricalAssertionAuthorityHash}. Read it directly; never create, rewrite, or self-sign it. Author all noncanonical manuscript prose through AUTONOMOUS_MANUSCRIPT_IR_DRAFT.json; never edit AUTONOMOUS_MANUSCRIPT_IR.json. Preserve the draft's exact top-level and block schemas. You may change the plain-text title, section headings, prose/citation text, and section arrangement, but must keep exactly one slot for empirical_claims, formal_support, and empirical_results and at least one limitation prose block.${bindingInstruction} THEOREM_SPEC.json, theoremSpecificationHash, and theorem-specification claim hashes are formal-pipeline identities, never manuscript evidenceRefs. Keep formal_support as the sole formal theorem/proof/verification surface; do not add prose that restates formal results outside that slot. The trusted renderer injects its canonical content from independently verified formal authority. Never invent a hash or cite a work absent from a verified prior-art receipt. The trusted renderer escapes plain text, injects canonical claims, formal support, results, tables, and figures into the three slots, binds your draft to this execution receipt, and rejects unbound scientific prose. A negative or inconclusive result is a result and must not be reframed as support. Do not alter empirical code, protocol, thresholds, claims, authority files, or canonical result bodies.`;
}

function buildCampaignAgentInstructionsInternal({
  kind,
  manuscript,
  roundIndex,
  reviews = [],
  language = 'python',
  requiresGpu = false,
  datasetMounts = [],
  benchmarkSelector = null,
  formalVerificationScheduled = false,
  formalProposalSeedRequired = false,
  proposalSeedContractPath = 'PROPOSAL_CLAIM_PROOF_EVIDENCE_REPRO_SEED_CONTRACTS.json',
  approvedProposalSeedBindingHash = null,
  claimAuthorityType = null,
  claimAuthorityBindingHash = null,
  priorConvergence = null,
  qualityGateBlockers = [],
  revisionMaterialization = null,
  empiricalAssertionAuthority = null,
  autonomousManuscriptEvidenceRefBindings = null,
  empiricalOutcomeObserved = false,
} = {}) {
  const evidenceEntailmentMode = claimAuthorityType === 'machine-policy-authorized'
    ? 'required'
    : 'not_applicable';
  const empiricalClaimMarkers = empiricalClaimMarkerInstructions(benchmarkSelector);
  const empiricalAssertions = ['manuscript-integrate', 'revise'].includes(kind)
    ? typedEmpiricalAssertionInstructions(
      empiricalAssertionAuthority,
      autonomousManuscriptEvidenceRefBindings,
      {
        requireExactBindings:
          claimAuthorityType === 'machine-policy-authorized',
      },
    ) : '';
  const evidenceEntailmentReview = evidenceEntailmentMode === 'required'
    ? ' This host-validated campaign requires the trusted autonomous manuscript entailment contract. Read AUTONOMOUS_MANUSCRIPT_ENTAILMENT.json independently and reject unless every rendered prose/citation block is covered exactly once, its renderedSentence matches the current manuscript, and every evidenceRef has canonical source-document predicates permitted for that claimClass. Inspect each predicate sourceDocumentHash, JSON fieldPath, typed actualValue, operator, unit, denominator, and original/replay role; do not infer support merely because an authority hash is present. Treat provenance and source-field predicates as necessary but not sufficient for semantic entailment; reject unsupported generalization, causal language, novelty, or universal-truth claims. Include evidenceEntailmentReview exactly as {version:1,kind:"EvidenceEntailmentPerClaimReview",evidenceEntailmentContractHash:"sha256:...",claims:[{claimId:"exact contract claimId",renderedSentenceHash:"exact contract hash",verdict:"entailed"|"not_entailed",rationale:"specific source-field-to-sentence justification"}]} in contract claim order. Use verdict entailed only when the cited source fields logically support the whole rendered sentence. If the contract is absent, return a completed revise review with a concrete missing-contract finding and omit evidenceEntailmentReview; absence prevents acceptance but does not prevent producing the requested review and is not a transport blocker.'
    : ' This host-validated campaign is not in the trusted autonomous manuscript entailment mode. AUTONOMOUS_MANUSCRIPT_ENTAILMENT.json is not applicable: do not require, create, infer, or rely on that contract, and do not report its presence or absence as a manuscript finding. Omit evidenceEntailmentReview and independently judge the manuscript against the immutable typed empirical assertion authority and the other evidence actually admitted for this campaign.';
  const preRevisionFormalStageBoundary = formalVerificationScheduled
    ? ' The current-round canonical THEOREM_SPEC.json and kernel-verification receipt are deliberately created after this pre-revision review: the graph runs revise, then theorem-spec, then formal-verify. A missing, prior-campaign, or otherwise stale theorem specification or the absence of a current-round kernel receipt is expected pre-stage state, not a manuscript deficiency. Do not ask the reviser to create, rebind, or verify those system-owned downstream artifacts; judge the theorem statement, adjacent readable proof, and stated boundaries in the current manuscript instead. Downstream strict formal binding and kernel checks remain mandatory.'
    : '';
  const reviseFormalStageBoundary = formalVerificationScheduled
    ? ' The current-round canonical THEOREM_SPEC.json and kernel-verification receipt are system-owned downstream artifacts created after this revise node by theorem-spec and formal-verify. Do not edit, create, rebind, or validate them here. Any review request to do so, or any finding based only on their expected pre-stage absence, prior-campaign binding, or staleness, is not actionable in this node and must not make the task status blocked. Complete every actionable manuscript-local change within the writable surface and return completed; downstream strict formal checks remain mandatory.'
    : '';
  const reviseStageBoundary = `${reviseFormalStageBoundary} AUTONOMOUS_MANUSCRIPT_ENTAILMENT.json is system-owned: never create or edit it and do not return blocked solely because it is absent before this revision.${evidenceEntailmentMode === 'required' ? ' The trusted host renderer regenerates the required contract after a successful revision; make any actionable manuscript-IR changes needed for that renderer, then return completed so the host can run.' : ' This campaign is not in trusted autonomous manuscript entailment mode, so any review request to create that contract is not applicable and must not make this task blocked.'}`;
  const formalWorkerPlanInstruction = " RESEARCH_WORKER_PLAN.json is rebuilt by the system immediately before each review. Lean may pretty-print a type written as ': ∀ (...)' with the same binders after the theorem name and before the declaration colon; that binder relocation alone is not a semantic or type mismatch. Copy the system-finalized identity fields rather than hashing either spelling, and for a dynamic claim judge the exact bound leanTypeSource through its host-verified expected authority audit.";
  if (kind === 'research-plan') return `Inspect ${manuscript} and the project. Write a concise RESEARCH_PLAN.md of at most 450 words with falsifiable claims, code tasks, datasets, metrics, baselines, ablations, seeds, and stopping criteria. Prefer compact tables or bullets over prose.`;
  if (kind === 'writer' && formalProposalSeedRequired && claimAuthorityType === 'machine-policy-authorized') return `This is a machine-proposed research source authorized only for bounded execution by system policy and bound by ${claimAuthorityBindingHash || 'a missing binding hash'}; it is not operator approval, scientific validation, or release authority. Read ${proposalSeedContractPath}; require kind AutonomousResearchSeedContractBundle, status autonomous_research_seed_contracts_ready, claimAuthorityType machine-policy-authorized, valid safety declarations, and non-empty claims. Use exactly the claims whose verificationMode is formal_kernel as theorem authority; never turn an empirical_protocol outcome claim, observed metric, treatment effect, replay result, or empirical obligation into a theorem premise or axiom. Preserve every selected formal claim's exact statement, assumptions, quantifiers, negativeBoundaries, and proofObligations, and use each selected formal claim exactly once. Reject circular P-implies-P, assumption-echo, True, or otherwise vacuous theorem formulations. Add its natural-language proof in an immediately adjacent \\begin{proof} environment and state every formal negative boundary in a Limitations section. Also improve AUTONOMOUS_MANUSCRIPT_IR_DRAFT.json using only its existing exact schema; every prose block must retain real evidenceRefs copied from immutable authority files, and the three canonical slots must each remain exactly once. In the IR, scope and method prose may cite only compatible proposal, proposal-claim, policy, or seed identities; never cite empirical claim-lineage or result identities as scope/method evidence. Do not create observed-result interpretation before typed empirical authority exists. Keep formal_support as the sole formal theorem/proof/verification slot and never use theorem-specification identities as manuscript evidenceRefs. This initial writer may modify exactly ${manuscript} and AUTONOMOUS_MANUSCRIPT_IR_DRAFT.json. Do not create or edit proof_status.md, evidence_manifest.md, an appendix, a bibliography, or any other file; formal verification and a later revise carrying exact readiness blockers own those artifacts. Return replacement bodies only for these two files when their bytes actually change. Never edit AUTONOMOUS_MANUSCRIPT_IR.json. Do not invent evidence, write Lean, or create THEOREM_SPEC files. The later system-finalized theorem-spec and independent formal review may reject the claim; external release attestation remains required. If the authority or lineage is missing or blocked, fail closed.${empiricalClaimMarkers}`;
  if (kind === 'writer' && formalProposalSeedRequired) return `This is an approved formal proposal source bound by ${approvedProposalSeedBindingHash || 'a missing binding hash'}. Read ${proposalSeedContractPath}; require kind PaperProposalSeedContractBundle, status proposal_seed_contracts_ready, non-empty proposal-derived claims, proof obligations, proposalEnvelopeHash, productionPlanEnvelopeHash, reviewGateHash, and a scientificClaimInputHash. Each claim carries the operator-supplied exact scientific statement plus non-empty assumptions, quantifiers, negativeBoundaries, and proofObligations. Use every approved claim exactly once as the only theorem authority. Preserve its complete semantic scope; TeX syntax conversion is allowed, but paraphrasing, narrowing, strengthening, adding conditions, deleting quantifiers, or substituting a different claim is forbidden. Add its natural-language proof in an immediately adjacent \\begin{proof} environment and state every approved negative boundary in a Limitations section. Do not invent evidence, write Lean, or create THEOREM_SPEC files. The later system-finalized theorem-spec and Lean candidate stages bind and independently review the result; if the approved seed contract or scientific claim lineage is missing or blocked, fail closed.${empiricalClaimMarkers}`;
  if (kind === 'writer') return `Improve only ${manuscript} according to RESEARCH_PLAN.md; do not modify RESEARCH_PLAN.md or any other file. Strengthen only claims supported by files already present. Do not invent results, datasets, benchmark names, citations, bibliographic identities, external systems, authority, or evidence. If verified evidence is absent, describe the work explicitly as a plan or protocol, omit empirical findings and citations, and state the evidence limitations. Keep the complete manuscript concise enough for the configured output budget.${empiricalClaimMarkers}`;
  if (kind === 'theorem-spec') return `Read ${manuscript} and every recursively included TeX file.${formalProposalSeedRequired ? ` Also read the bound scientific claim authority in ${proposalSeedContractPath}.` : ''} Enumerate every theorem-like environment in source order. Write exactly one file, THEOREM_SPEC_DRAFT.json, and modify nothing else. Its exact JSON schema is {"version":1,"kind":"TheoremSpecificationDraft","claims":[{"claimKey":"stable-key","title":"short title","statement":"exact theorem body text","assumptions":["..."],"quantifiers":["..."],"negativeBoundaries":["at least one explicit non-claim"],"proofObligations":["at least one concrete obligation"],"proofDependencyClaimKeys":["stable-key-of-an-earlier-or-shared-lemma"],"evidenceObligations":[],"manuscriptIntent":"existing"${formalProposalSeedRequired ? ',"proposalClaimId":"exact bound formal claim id"' : ''}}]}. Every object must contain exactly those keys, with no claimId, hashes, source paths, byte offsets, receipts, TODOs, or extra fields. proofDependencyClaimKeys must list every canonical theorem/lemma whose proved declaration is used by this theorem, or [] when independent; do not invent dependencies, self-reference, or create cycles. statement must reproduce the exact theorem body text, not a stronger paraphrase.${formalProposalSeedRequired ? ` Map every theorem one-to-one to the authorized ${claimAuthorityType === 'machine-policy-authorized' ? 'formal_kernel claim only; exclude every empirical_protocol claim' : 'operator-approved proposal claim'} by exact proposalClaimId; do not omit, duplicate, strengthen, or substitute an unrelated claim. This mapping is only a locator and will not be trusted until independently reviewed.` : ''} The system, never the agent, binds source bytes and creates canonical THEOREM_SPEC.json.`;
  if (kind === 'formal-author') return `Treat THEOREM_SPEC.json and every .tex file as immutable authority. For every canonical specification claim, use its exact claimId, statement, proof obligations, proofObligationContracts, and manuscriptSource binding. If proposalClaimSource contains dynamicFormalClaimSeedHash, the Lean declaration name must equal leanDeclarationName, its elaborated normalized type hash must equal leanNormalizedTypeHash, its source type must be leanTypeSource, and imports must be a subset of allowedImports. Create exactly one top-level theorem or lemma declaration for each canonical claim, in THEOREM_SPEC.json claim order; prove all of that claim's proof obligations inside that declaration and do not create helper theorem or lemma declarations. A non-empty canonical claim set requires at least one non-lakefile .lean source before the turn completes; returning without materializing those Lean declarations is a failed task. Existing Markdown, prior proof-status prose, stale verification commentary, or the absence of a current kernel receipt is never a reason to skip Lean authoring. Create or update only the necessary non-lakefile .lean source files, then run the pinned local Lean executable directly against each source and repair it until it checks. After your turn the host unconditionally rebuilds RESEARCH_WORKER_PLAN.json, lean-toolchain, lakefile.lean, and lake-manifest.json from the accepted declarations: never create or edit those system-owned files, never calculate or self-author their SHA-256 values, and do not block because a raw tool-free turn cannot compute them. A dynamic claim with proposalClaimSource.dynamicFormalClaimSeedHash is an exception to generic pretty-printing: declare exactly 'theorem leanDeclarationName : leanTypeSource := ...', preserving leanTypeSource after the colon even when it begins with '∀', because its authority supplies leanNormalizedTypeHash. An exact non-dynamic registry-bound claim is also an exception: use its canonical theorem name and preserve the registry expectedType byte-for-byte after the declaration colon, including an initial '∀'; the verifier deliberately binds the source type hash to that exact contract spelling. For every remaining generic parameterized theorem, write its declaration signature in the exact normalized shape printed by '#check theoremName': place explicit binders before the declaration colon, and spell the result type exactly as '#check' prints it, including qualified names and dot notation. Do not put the complete type after the colon as an explicit '∀ (...)' for such a generic claim unless '#check' itself prints that form. The verifier binds SYSTEM_ALLOWED_FORMAL_AXIOMS=[]: every target and mapped obligation declaration must have a fresh '#print axioms' result that says it does not depend on any axioms. Do not assume a convenience library lemma is axiom-free. If '#print axioms' reports propext, Quot.sound, or any other axiom, the proof is not ready: remove the simp/rw step that introduced it where applicable, unfold the defining function before splitting its cases so reduction is definitional, and close branches with axiom-free constructors or exact proof terms. Prove the exact statements without sorry/admit/unreviewed axioms. The host, not the model, generates canonical formal_verifier_lake bindings with claimId, theorem/spec/source/manuscript identities, source hashes, proofObligationContracts, and proofObligationMappings after the Lean sources are materialized. Do not modify any .tex, THEOREM_SPEC.json, THEOREM_SPEC_DRAFT.json, Markdown, empirical artifact, or source package contract. Do not weaken a claim to make the proof pass. The verifier generates its own fresh #check/#print axioms audit outside the source workspace.`;
  if (kind === 'formal-review') return `Read-only independent review: bind your review to canonical THEOREM_SPEC.json, compare every specification claim and exact manuscript byte range with its Lean theorem type and proof obligations, and reject any mismatch.${formalWorkerPlanInstruction} Copy claimId, theoremName, manuscriptClaimHash, theoremTypeHash from expectedTypeHash, and sourceStatementHash exactly from its system-finalized claim binding; never calculate or substitute these identity hashes. manuscriptClaimHash is the domain-separated ManuscriptClaimIdentity and is intentionally not manuscriptSource.contentHash. THEOREM_SPEC.json sourceManuscriptHash is a domain-separated FormalManuscriptCorpus record hash, not the raw-byte hash printed for a snapshot .tex file, so comparing those two different hash domains is invalid and must not block a review. The host independently recomputes and verifies every copied identity. For dynamic proposalClaimSource entries, also independently reject unless theoremName equals leanDeclarationName and the elaborated normalized Lean type hash equals leanNormalizedTypeHash.${formalProposalSeedRequired ? ` Independently compare each exact proposalClaimSource text from THEOREM_SPEC.json (ultimately bound to ${proposalSeedContractPath}) with the natural-language theorem. Accept only semantic equivalence to the bound ${claimAuthorityType === 'machine-policy-authorized' ? 'machine-policy-authorized formal_kernel claim; this is not operator approval and does not establish novelty or scientific correctness' : 'operator-approved proposal claim'}; narrowing, strengthening, unrelated substitution, or scope change must fail${claimAuthorityType === 'machine-policy-authorized' ? ' and external release attestation remains required' : ' and requires a new operator-signed proposal approval outside this review'}.` : ''} There must be exactly one review for every canonical claim and no extra review. Do not modify any file. Return only JSON as {version:${formalProposalSeedRequired ? 2 : 1},kind:"FormalClaimSemanticReview",theoremSpecificationHash:"sha256:...",reviews:[...]}; every review must contain claimId,theoremName,manuscriptClaimHash,theoremTypeHash from expectedTypeHash,sourceStatementHash,status:"formal_semantic_review_verified" only when the manuscript theorem and Lean type are equivalent,semanticEquivalenceVerified,and verdict:"equivalent"${formalProposalSeedRequired ? ', plus proposalClaimId,proposalClaimRecordHash,proposalClaimTextHash copied exactly from proposalClaimSource, proposalToTheoremSemanticVerified, proposalToTheoremVerdict:"equivalent", and approvedNarrowingRationale:null' : ''}. Identity and execution authority are injected by the runtime. Block omissions, narrowing, strengthening, unrelated or conditional or vacuous proofs, sorry/admit, assumption echo, or a specification hash mismatch.`;
  if (/^coder(?:-|$)/.test(kind)) {
    const entrypoint = empiricalEntrypoint({ language });
    const armEntrypoints = siblingArmEntrypoints(entrypoint);
    const writableFiles = benchmarkSelector ? [entrypoint, ...armEntrypoints] : [entrypoint];
    const datasets = datasetMounts.length
      ? ` Declared datasets are mounted read-only inside the worker at ${datasetMounts.map((mount) => `/datasets/${mount.name} (${mount.licenseId})`).join(', ')}; use only those declared paths for external data. The main entrypoint must open and parse file content through each dataset environment variable or worker path before producing responses. Checking dir.exists, file.exists, or list.files alone is not dataset consumption. For a directory mount, recursively choose an actual data file below the bound root, including compressed files such as .csv.gz, and pass a path derived from that root directly to the language's content reader (for example, R read.csv(file.path(datasetRoot, relativeFile), nrows=1) or Python pandas.read_csv(os.path.join(dataset_root, relative_file), nrows=1)). Do not use an extension filter that excludes compressed CSV files.`
      : '';
    const benchmark = benchmarkSelector
      ? ` Implement three distinct executable candidate arm adapters at ${armEntrypoints.join(', ')}; the harness directly launches each sibling file as its complete process, so every sibling must immediately reconstruct its own batch, consume the dataset, compute only its own arm responses, and write its own observation. Shared helpers may be sourced from ${entrypoint}, but ${entrypoint} must not invoke all three arms and a sibling must not merely define a function and exit. For R, the harness launches Rscript with the source workspace as its current directory: source helpers by the stable workspace-relative path ${entrypoint} and never inspect sys.frame(...).ofile to discover the top-level script path, because no caller frame exists under Rscript. Never branch one shared entrypoint on HEPTA_EXPERIMENT_ARM. Each arm is invoked exactly once per run. Reconstruct the repository-owned SystemBenchmarkArmBatchChallenge by concatenating HEPTA_BENCHMARK_CHALLENGE_JSON_PART_1 through the integer HEPTA_BENCHMARK_CHALLENGE_PART_COUNT in numeric order. Read HEPTA_OUTPUT_DIR and write only HEPTA_OUTPUT_DIR/observation.json; the source workspace is read-only, so never write observation.json to the current working directory. Its document must be {version:1,kind:"CampaignBenchmarkArmBatchResponses",systemBenchmarkArmBatchChallengeHash:batch.systemBenchmarkArmBatchChallengeHash,cells:[{cellId:cell.cellId,systemBenchmarkCellChallengeHash:cell.challenge.systemBenchmarkCellChallengeHash,responses:[...]}]}; both cases and the cell challenge hash are nested under cell.challenge: iterate cell.challenge.cases, never cell.cases, because cell.cases does not exist. Preserve batch cell order and return exactly one response object for every case as {caseId:case.caseId,[cell.challenge.responseField]:scalar}; responses must be an array of these objects, never an array of bare scalars. Do not invent labels, outcomes, raw events, final metrics, aggregates, results.json, or results.csv. Read every treatment and ablation candidate input from case.input; the host has already redacted case.input for the ablation challenge. Each scalar stored under cell.challenge.responseField must be finite numeric; deterministically reduce numeric case.input fields when needed and never store an object, list, array, or data frame as that field value. Only baseline cases contain case.referenceResponse, which the baseline adapter must return exactly. The host-held oracle evaluates every seed/repetition cell and derives bounded raw events, metrics, aggregation, CI, power, and acceptance. Keep the three adapter implementations byte-distinct; their source and runner provenance are independently bound.`
      : '';
    return `Implement the smallest valid ${entrypoint} for RESEARCH_PLAN.md${requiresGpu ? ' using the declared GPU runtime' : ''}. Your writable surface is exactly ${writableFiles.join(', ')}. Inspect only RESEARCH_PLAN.md and those writable files for this task; do not inspect, restate, or rewrite another language's entrypoints, the manuscript, Markdown status files, theorem specifications, evidence files, or prior automation results. If the writable files already satisfy this contract, make no edits and report only concise checks; otherwise return replacement bodies only for writable files whose bytes must change. Keep the response compact. Use deterministic seeds and no network.${benchmarkSelector ? '' : ' Read HEPTA_OUTPUT_DIR from the environment and write HEPTA_OUTPUT_DIR/results.json plus HEPTA_OUTPUT_DIR/results.csv; do not fall back to the working directory. results.csv must begin with the exact header metric,value and contain at least one non-empty metric with a finite numeric value.'} Include a fast self-check. Do not fabricate outputs or add unnecessary framework code.${benchmark}${datasets}`;
  }
  if (kind === 'manuscript-integrate' && empiricalOutcomeObserved) return `Integrate only actually generated original and replay empirical evidence from automation-results/ into ${manuscript}; clearly distinguish observed results from planned work. The empirical outcome is already observed: modify manuscript and interpretation only. Never modify an empirical entrypoint, treatment/baseline/ablation adapter, imported experiment module, analysis protocol, hypothesis, threshold, metric, seed schedule, or experiment configuration.${empiricalAssertions}`;
  if (kind === 'manuscript-integrate') return `No completed empirical outcome authority is present. Modify only ${manuscript}; do not modify RESEARCH_PLAN.md or any other file. Keep ${manuscript} explicitly limited to a plan or protocol. Do not create observed results, measurements, datasets, benchmark names, citations, external systems, authority, or evidence. Remove any unsupported empirical finding already present and state that empirical validation remains pending.${empiricalAssertions}`;
  if (/^referee-\d+$/.test(kind)) return `Independently review ${manuscript} before revision at round ${roundIndex}. Do not modify files.${preRevisionFormalStageBoundary}${empiricalAssertionAuthority ? ` Read the immutable typed authority and reject any assertion body that is not byte-for-byte equal to canonicalManuscriptBody, any TeX hiding/rendering construct, omitted negative result or limitation, untyped rendered prose, or conclusion beyond the bounded canonical statement. Deterministic binding remains mandatory regardless of your verdict. Authority hash: ${empiricalAssertionAuthority.empiricalAssertionAuthorityHash}.` : ''}${evidenceEntailmentReview} Return JSON with verdict (accept|revise), score (0..1), criticalFindingCount, findings, and summary. Use accept only when no actionable revision is required and then assign a score consistent with acceptance; use revise only when findings lists at least one concrete actionable deficiency and assign a score consistent with revision. Findings must contain deficiencies, not praise. Never mechanically return revise or score 0 merely because this is a review round.`;
  if (/^revision-referee-\d+$/.test(kind)) return `Independently review the revised ${manuscript} at round ${roundIndex}. Judge the current file, not a prior draft. Do not modify files.${empiricalAssertionAuthority ? ` Re-read automation-results/EMPIRICAL_ASSERTION_AUTHORITY.json and reject any body not byte-for-byte equal to canonicalManuscriptBody, any TeX hiding/rendering construct, omission, untyped rendered prose, or unsupported generalization. Deterministic binding remains mandatory regardless of your verdict. Authority hash: ${empiricalAssertionAuthority.empiricalAssertionAuthorityHash}.` : ''}${evidenceEntailmentReview} Return JSON with verdict (accept|revise), score (0..1), criticalFindingCount, findings, and summary. Use accept only when no actionable revision is required and then assign a score consistent with acceptance; use revise only when findings lists at least one concrete actionable deficiency and assign a score consistent with revision. Findings must contain deficiencies, not praise. Never mechanically return revise or score 0 merely because this is a revision round.`;
  if (kind === 'revise' && empiricalOutcomeObserved) return `Revise ${manuscript} and its interpretation to address the following independent reviews and every carried-forward deterministic quality-gate blocker. The empirical outcome is already observed: never modify an empirical entrypoint, treatment/baseline/ablation adapter, imported experiment module, analysis protocol, hypothesis, threshold, metric, seed schedule, experiment configuration, or any code/configuration that can affect empirical behavior. A negative, non-significant, or inconclusive result must remain reportable and must not trigger method tuning. Preserve correct content and run manuscript checks.${empiricalAssertions} Preserve every HEPTA_EMPIRICAL_CLAIM marker pair and its exact hypothesis text byte-for-byte. Keep each proof environment immediately adjacent to its matching theorem, lemma, or proposition environment; place explanatory limitations after the proof, never between the formal statement and its proof. For theorem readiness, create proof_status.md when theorem_proof_status_missing is present, create evidence_manifest.md when theorem_evidence_manifest_missing is present, and add a real appendix/supplement or an explicit justified waiver when theorem_appendix_or_supplement_missing is present. Do not claim a proof is closed unless the current formal verification evidence supports it.${reviseStageBoundary} Prior convergence: ${JSON.stringify(priorConvergence)}. Revision materialization: ${JSON.stringify(revisionMaterialization)}. Quality-gate blockers: ${JSON.stringify(qualityGateBlockers)}. Reviews: ${JSON.stringify(reviews)}`;
  if (kind === 'revise') return `Revise ${manuscript} to address the independent reviews and deterministic quality-gate blockers. Modify only ${manuscript} plus proof_status.md, evidence_manifest.md, or manuscript appendix/supplement TeX files when an exact carried-forward theorem-readiness blocker requires them; never modify RESEARCH_PLAN.md or unrelated files. No completed empirical outcome authority is present. Keep the paper explicitly limited to a plan or protocol; remove unsupported observed results and do not invent measurements, datasets, benchmark names, citations, external systems, authority, or evidence. Preserve every HEPTA_EMPIRICAL_CLAIM marker pair and its exact hypothesis text byte-for-byte. Keep each proof environment immediately adjacent to its matching theorem, lemma, or proposition environment; place explanatory limitations after the proof, never between the formal statement and its proof. For theorem readiness, create proof_status.md when theorem_proof_status_missing is present, create evidence_manifest.md when theorem_evidence_manifest_missing is present, and add a real appendix/supplement or an explicit justified waiver when theorem_appendix_or_supplement_missing is present. Do not claim a proof is closed without current formal verification evidence.${reviseStageBoundary} Prior convergence: ${JSON.stringify(priorConvergence)}. Revision materialization: ${JSON.stringify(revisionMaterialization)}. Quality-gate blockers: ${JSON.stringify(qualityGateBlockers)}. Reviews: ${JSON.stringify(reviews)}`;
  throw new Error(`No agent instructions for ${kind}`);
}

export function buildCampaignAgentInstructions(args = {}) {
  const instructions = buildCampaignAgentInstructionsInternal(args);
  const kind = String(args.kind || '');
  const venueAware = kind === 'writer'
    || kind === 'revise'
    || kind === 'manuscript-integrate'
    || /^referee-\d+$/.test(kind)
    || /^revision-referee-\d+$/.test(kind);
  return venueAware
    ? `${instructions}${venueRewriteInstructions(args)}`
    : instructions;
}

export function formalWorkspaceMutationPolicy() {
  return Object.freeze({
    allowedPaths: Object.freeze([]),
    allowedPrefixes: Object.freeze([]),
    allowedExtensions: Object.freeze(['.lean']),
    forbiddenPaths: Object.freeze([
      'THEOREM_SPEC.json',
      'THEOREM_SPEC_DRAFT.json',
      'RESEARCH_WORKER_PLAN.json',
      'lakefile.lean',
      'lake-manifest.json',
      'lean-toolchain',
    ]),
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

export function buildCampaignAgentExecutionRequest({ campaign, node, campaignNodes = null, workspace, manuscript, reviews, priorConvergence = null, qualityGateBlockers = [], revisionMaterialization = null, empiricalAssertionAuthority = null, autonomousManuscriptEvidenceRefBindings = null, reviewerExecutionAuthorityContext = null, empiricalOutcomeObserved = false, executionBudget, executionSignal }) {
  const kind = node.kind;
  const coderNode = /^coder(?:-|$)/.test(kind);
  const datasetMounts = campaign.spec.datasetMounts || [];
  const benchmarkSelector = campaign.spec.benchmarkSelector || null;
  const budget = campaignAgentOutputTokenBudget(kind);
  const formalRequested = [
    campaign.spec.paperQualityProfile,
    ...(campaign.spec.paperQualityProfiles || []),
  ].includes('formal_theorem_or_proof');
  const formalVerificationScheduled = Array.isArray(campaignNodes)
    ? campaignNodes.some((candidate) => (
      candidate?.roundIndex === node.roundIndex
      && ['theorem-spec', 'formal-verify'].includes(candidate?.kind)
    ))
    : formalRequested;
  const approvedProposalSeed = campaign.spec.approvedProposalSeed || null;
  const machineClaimAuthority = campaign.spec.scientificClaimAuthority || null;
  const claimAuthority = machineClaimAuthority || approvedProposalSeed;
  const proposalSeedSource = claimAuthority?.contractPath || null;
  const formalProposalSeedRequired = formalRequested
    && (claimAuthority?.status === 'approved_proposal_seed_bound'
      || claimAuthority?.status === 'autonomous_research_seed_bound');
  const proposalSeedContractPath = String(proposalSeedSource || 'PROPOSAL_CLAIM_PROOF_EVIDENCE_REPRO_SEED_CONTRACTS.json')
    .replace(/\\/g, '/').split('/').at(-1);
  const evidenceEntailmentMode = machineClaimAuthority
    ?.claimAuthorityType === 'machine-policy-authorized'
    ? 'required'
    : 'not_applicable';
  const claimAuthorityType = evidenceEntailmentMode === 'required'
    ? 'machine-policy-authorized'
    : approvedProposalSeed ? 'operator-signed' : null;
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
    formalVerificationScheduled,
    formalProposalSeedRequired,
    proposalSeedContractPath,
    approvedProposalSeedBindingHash: approvedProposalSeed?.approvedProposalSeedBindingHash || null,
    claimAuthorityType,
    claimAuthorityBindingHash: machineClaimAuthority?.autonomousResearchSeedBindingHash
      || approvedProposalSeed?.approvedProposalSeedBindingHash || null,
    priorConvergence,
    qualityGateBlockers,
    revisionMaterialization,
    empiricalAssertionAuthority,
    autonomousManuscriptEvidenceRefBindings,
    empiricalOutcomeObserved,
    targetVenue: campaign.spec.venueTarget || null,
    sourceVenue: campaign.spec.sourceVenue
      || campaign.spec.researchVerificationInput?.paperTask?.venueTarget || null,
  });
  return {
    role: node.role || kind,
    workspacePath: workspace,
    instructions: `${instructions}${containedMutationRetryInstruction(node)}`,
    context: {
      campaignId: campaign.campaignId,
      nodeId: node.persistedNodeId || node.nodeId,
      operationNodeId: node.nodeId,
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
      claimAuthorityType,
      claimAuthorityBindingHash: machineClaimAuthority?.autonomousResearchSeedBindingHash
        || approvedProposalSeed?.approvedProposalSeedBindingHash || null,
      evidenceEntailmentMode,
      priorConvergence,
      qualityGateBlockers: Object.freeze([...qualityGateBlockers].map(String)),
      revisionMaterialization,
      empiricalAssertionAuthorityHash: empiricalAssertionAuthority?.empiricalAssertionAuthorityHash || null,
      empiricalAssertionAuthorityEntryCount: empiricalAssertionAuthority?.entryCount || 0,
      autonomousManuscriptEvidenceRefBindings:
        autonomousManuscriptEvidenceRefBindings || null,
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
      } : kind === 'writer' && formalProposalSeedRequired && machineClaimAuthority ? {
        workspaceMutationPolicy:
          autonomousMachineWriterWorkspaceMutationPolicy({ manuscript }),
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
    instructions: `Repair only the non-lakefile Lean source formalization for canonical THEOREM_SPEC.json. Preserve every claimId, theorem statement, assumption boundary, proof obligation, proofObligationContract, proofObligationMapping, and manuscriptSource binding. Never modify ${manuscript}, any .tex file, THEOREM_SPEC.json, or THEOREM_SPEC_DRAFT.json. Make the smallest non-lakefile .lean source change needed to address these verifier diagnostics. Keep exactly one top-level theorem or lemma declaration for each canonical claim and do not add helper theorem or lemma declarations; put auxiliary reasoning inside the target proof with have or let. After your turn the host unconditionally rebuilds RESEARCH_WORKER_PLAN.json, lean-toolchain, lakefile.lean, lake-manifest.json, and all source/binding SHA-256 values: never create or edit those system-owned files and do not block merely because this raw tool-free turn cannot hash files. The verifier binds SYSTEM_ALLOWED_FORMAL_AXIOMS=[]: eliminate every named axiom in the diagnostics rather than asserting that a library theorem is axiom-free. A dynamic claim with proposalClaimSource.dynamicFormalClaimSeedHash must remain exactly 'theorem leanDeclarationName : leanTypeSource := ...', preserving leanTypeSource after the colon even when it begins with '∀'. An exact non-dynamic registry-bound claim must likewise retain its canonical theorem name and registry expectedType byte-for-byte after the colon, including an initial '∀'. For every remaining generic parameterized theorem, write the declaration signature in the exact normalized shape printed by '#check theoremName': place explicit binders before the declaration colon and spell the result type exactly as '#check' prints it, including qualified names and dot notation; use an explicit '∀ (...)' after the colon only if '#check' itself does. If diagnostics name propext, Quot.sound, or another axiom, remove the simp/rw step that introduced it where applicable, unfold the defining function before splitting its cases so reduction is definitional, and close branches with axiom-free constructors or exact proof terms. Run the pinned local Lean executable directly against every changed source before returning. Repair iteration ${iteration}. Diagnostics:\n${String(diagnostics || '').slice(-6000)}`,
    context: { failedNode: 'formal-verify', iteration },
    requiredChecks: ['Lean/Lake project must be ready for independent semantic review and fresh replay'],
    remainingTokenCount,
    signal,
    workspaceMutationPolicy: formalWorkspaceMutationPolicy(),
  });
}

export function bindFormalProofSearchCandidateRequest({
  request,
  typedTheoremObligationBundle,
  theoremSpecification = null,
  formalProofSearchPlan,
  candidate,
} = {}) {
  const ordinal = Number(candidate?.ordinal);
  const theoremSpecificationHash = theoremSpecification?.theoremSpecificationHash;
  if (!request || !typedTheoremObligationBundle?.typedTheoremObligationBundleHash
    || !formalProofSearchPlan?.formalProofSearchPlanHash
    || !SHA256.test(String(theoremSpecificationHash || ''))
    || typedTheoremObligationBundle.theoremSpecificationHash
      !== theoremSpecificationHash
    || formalProofSearchPlan.theoremSpecificationHash
      !== theoremSpecificationHash
    || formalProofSearchPlan.typedTheoremObligationBundleHash
      !== typedTheoremObligationBundle.typedTheoremObligationBundleHash
    || candidate?.theoremSpecificationHash !== theoremSpecificationHash
    || candidate?.typedTheoremObligationBundleHash
      !== typedTheoremObligationBundle.typedTheoremObligationBundleHash
    || candidate !== formalProofSearchPlan.candidates?.[ordinal]) {
    throw new Error('formal_proof_search_candidate_request_invalid');
  }
  const strategyInstructions = formalProofSearchStrategyInstructions(candidate);
  const obligationSpecificInstructions = formalObligationSpecificInstructions(
    theoremSpecification,
  );
  return Object.freeze({
    ...request,
    instructions: `${request.instructions}${obligationSpecificInstructions}\n\nSystem-bound formal proof-search candidate ${ordinal + 1}/${formalProofSearchPlan.candidateCount} (${candidate.strategy}). ${strategyInstructions} The typed obligation bundle, candidate order, exact claim/type authority, and import policy are immutable. Successful completion still requires independent semantic review, kernel verification, axiom audit, and fresh replay. This bounded search does not establish novelty, scientific truth, unrestricted theorem discovery, or natural-language/Lean equivalence.`,
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
    instructions: `Repair ${entrypoint} so it opens and parses file content from every declared read-only dataset through its worker path or environment variable: ${contract.evidence.map((item) => `${item.workerPath} via ${item.environmentName}`).join(', ')}. Directory existence checks and file listings alone do not count. For a directory mount, choose a data file below the bound root and pass a path derived directly from that root to the language's content reader (for example, R read.csv(file.path(datasetRoot, relativeFile), nrows=1) or Python pandas.read_csv(os.path.join(dataset_root, relative_file), nrows=1)). Remove any source-tree or host-specific input-data fallback. Preserve deterministic outputs and HEPTA_OUTPUT_DIR. Make the smallest valid change.`,
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
      ? `Repair the three sibling treatment/baseline/ablation adapters for ${entrypoint}. This is a technical repair only: the frozen protocol, hypotheses, thresholds, seed schedule, arm semantics, estimator, and scientific verdict are immutable; never tune code to obtain a positive or significant result. Each adapter must remain byte-distinct, concatenate the numbered HEPTA_BENCHMARK_CHALLENGE_JSON_PART_* values, parse the SystemBenchmarkArmBatchChallenge, and write only a CampaignBenchmarkArmBatchResponses document to HEPTA_OUTPUT_DIR/observation.json, never to the read-only current working directory. For R, source helpers by the stable workspace-relative path ${entrypoint}; never use sys.frame(...).ofile to infer the top-level Rscript path. Iterate every ordered cell.challenge.cases entry, never cell.cases, because cases are nested under the challenge; emit every caseId-keyed finite numeric scalar under cell.challenge.responseField. Treatment and ablation must read candidate inputs from case.input, deterministically reduce numeric fields when necessary, and never return an object or collection; ablation redaction is already applied by the host. Only baseline cases contain case.referenceResponse, which baseline must echo exactly. The dataset reader must support the mounted file formats, including compressed .csv.gz files. Never self-report labels, raw events, final metrics, or aggregates. ${safeDiagnostic}`
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
      ? `Repair only the serialization/shape defect in the three sibling arm adapters for ${entrypoint}; the frozen protocol, hypotheses, thresholds, seeds, arm semantics, and scientific verdict are immutable, and result-targeted tuning is forbidden. Each adapter must concatenate the numbered HEPTA_BENCHMARK_CHALLENGE_JSON_PART_* values and write a valid ordered CampaignBenchmarkArmBatchResponses observation.json for every cell and every case in cell.challenge.cases; never read nonexistent cell.cases. Baseline must echo referenceResponse; do not emit raw events or final metrics. ${safeDiagnostic}`
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
