import {
  fileRecord,
  readJsonIfExists,
  relativePath,
  walkFiles,
} from '../../workflow-kernel/runtime/file-utils.mjs';
import path from 'node:path';
import { normalizeText } from '../../workflow-kernel/runtime/text-utils.mjs';
import { resolveRepoPath } from '../../workflow-kernel/runtime/path-utils.mjs';
import { assertStoreQueryResult } from '../../paper-ports/store-port.mjs';
import { canonicalClaimsFromWorkerPlan } from './canonical-claim-registry-reader.mjs';
import {
  canonicalEmpiricalClaimsFromUniverse,
  readEmpiricalClaimUniverse,
} from './empirical-claim-universe-reader.mjs';
import { readEmpiricalAssertionUniverse } from './empirical-assertion-universe-reader.mjs';

async function scanEvidenceRoot(root, sourceRoot, rolePrefix) {
  if (!sourceRoot) return [];
  const files = await walkFiles(sourceRoot, {
    maxDepth: 5,
    maxFiles: 2000,
    match: (_full, name) => name !== 'FORMAL_CLAIM_REVIEW.json'
      && name !== 'RESEARCH_WORKER_PLAN.json'
      && /\.(md|json|jsonl|csv|txt)$/i.test(name)
      && /claim|evidence|proof|referee|review|verdict|audit|manifest|readiness|status|formal|lean|empirical|experiment|result|dataset|benchmark|table/i.test(name),
  });
  const records = [];
  for (const file of files.slice(0, 128)) {
    const record = await fileRecord(sourceRoot, file, `${rolePrefix}_evidence`);
    if (record) records.push({ ...record, path: relativePath(root, file) });
  }
  return records;
}

function classifyEvidenceRecord(record) {
  const text = normalizeText(`${record.path} ${record.filename}`).toLowerCase();
  const roles = [];
  if (/claim/.test(text)) roles.push('claim');
  if (/proof|formal|lean|coq|isabelle|theorem/.test(text)) roles.push('proof');
  if (/evidence|matrix|audit|manifest|verdict|status|empirical|experiment|result|dataset|benchmark|table/.test(text)) roles.push('evidence');
  if (/reproduc|result|seed|checksum|sha256|command|run|experiment|dataset|benchmark/.test(text)) roles.push('reproducibility');
  if (/referee|review|revision/.test(text)) roles.push('referee');
  return roles.length ? roles : ['evidence'];
}

function asContractItem(record, role, index) {
  return {
    id: `${role}:${index + 1}`,
    kind: role,
    text: `${role} evidence: ${record.path}`,
    status: 'observed',
    sourceLocator: record.path,
    evidenceRefs: [{ kind: 'path', ref: record.path, hash: record.hash }],
  };
}

async function extractStructuredItems(root, records) {
  const claims = [];
  const obligations = [];
  const evidenceItems = [];
  const reproducibilityItems = [];
  const experiments = [];
  const formalAdapterReceipts = [];
  const formalCertificateRequests = [];
  for (const record of records.slice(0, 96)) {
    const absolute = resolveRepoPath(root, record.path);
    const json = /\.json$/i.test(record.filename || '') ? await readJsonIfExists(absolute) : null;
    const roles = classifyEvidenceRecord(record);
    const jsonClaims = json && typeof json === 'object' ? [
      ...(Array.isArray(json.claims) ? json.claims : []),
      ...(Array.isArray(json.claim_packets) ? json.claim_packets : []),
      ...(Array.isArray(json.claims_matrix) ? json.claims_matrix : []),
    ] : [];
    if (roles.includes('claim') && !jsonClaims.length) claims.push(asContractItem(record, 'claim', claims.length));
    if (roles.includes('proof')) obligations.push(asContractItem(record, 'proof', obligations.length));
    if (roles.includes('evidence')) evidenceItems.push(asContractItem(record, 'evidence', evidenceItems.length));
    if (roles.includes('reproducibility')) reproducibilityItems.push(asContractItem(record, 'reproducibility', reproducibilityItems.length));
    if (!json || typeof json !== 'object') continue;
    for (const claim of jsonClaims.slice(0, 24)) {
      claims.push({
        id: claim.claim_id || claim.id || claim.key || `json_claim:${claims.length + 1}`,
        text: claim.claim_text || claim.text || claim.claim || claim.statement || `claim from ${record.path}`,
        status: claim.status || claim.verdict || 'observed',
        kind: claim.claim_kind || claim.claimKind || claim.kind || 'claim',
        riskClass: claim.risk_class || claim.riskClass || '',
        proofObligations: claim.proof_obligations || claim.proofObligations || [],
        verificationPlan: claim.verification_plan || claim.verificationPlan || null,
        negativeResultPolicy: claim.negative_result_policy || claim.negativeResultPolicy || null,
        sourceLocator: claim.source_locator || claim.locator || record.path,
        evidenceRefs: [{ kind: 'path', ref: record.path, hash: record.hash }],
      });
    }
    const jsonObligations = [
      ...(Array.isArray(json.proof_obligations) ? json.proof_obligations : []),
      ...(Array.isArray(json.obligations) ? json.obligations : []),
    ];
    for (const obligation of jsonObligations.slice(0, 24)) {
      obligations.push({
        id: obligation.obligation_id || obligation.id || obligation.key || `json_proof:${obligations.length + 1}`,
        text: obligation.obligation || obligation.text || obligation.statement || `proof obligation from ${record.path}`,
        status: obligation.status || 'observed',
        kind: obligation.kind || 'proof_obligation',
        sourceLocator: obligation.source_locator || obligation.locator || record.path,
        evidenceRefs: [{ kind: 'path', ref: record.path, hash: record.hash }],
      });
    }
    const jsonEvidence = [
      ...(Array.isArray(json.evidence) ? json.evidence : []),
      ...(Array.isArray(json.evidence_items) ? json.evidence_items : []),
      ...(Array.isArray(json.candidate_evidence) ? json.candidate_evidence : []),
    ];
    for (const evidence of jsonEvidence.slice(0, 48)) {
      evidenceItems.push({
        id: evidence.evidence_id || evidence.id || evidence.path || `json_evidence:${evidenceItems.length + 1}`,
        text: evidence.text || evidence.summary || evidence.path || `evidence from ${record.path}`,
        status: evidence.status || evidence.verdict || 'observed',
        kind: evidence.kind || 'evidence',
        claimIds: evidence.claim_ids || evidence.claimIds || (evidence.claim_id ? [evidence.claim_id] : []),
        requiredOutputs: evidence.required_outputs || evidence.requiredOutputs || [],
        availableOutputs: evidence.available_outputs || evidence.availableOutputs || evidence.outputs || [],
        resultClass: evidence.result_class || evidence.resultClass || null,
        acceptedResultClasses: evidence.accepted_result_classes || evidence.acceptedResultClasses || undefined,
        forbiddenSideEffects: evidence.forbidden_side_effects || evidence.forbiddenSideEffects || [],
        observedSideEffects: evidence.observed_side_effects || evidence.observedSideEffects || [],
        sourceLocator: evidence.source_locator || evidence.path || record.path,
        evidenceRefs: [{ kind: 'path', ref: evidence.path || record.path, hash: evidence.sha256 || record.hash }],
      });
    }
    const reproRefs = [];
    if (json.command || json.command_line) reproRefs.push(json.command || json.command_line);
    if (json.seed || json.seeds) reproRefs.push(`seed:${JSON.stringify(json.seed || json.seeds)}`);
    if (json.sha256 || json.checksum) reproRefs.push(`checksum:${json.sha256 || json.checksum}`);
    for (const ref of reproRefs.slice(0, 12)) {
      reproducibilityItems.push({
        id: `json_repro:${reproducibilityItems.length + 1}`,
        text: normalizeText(ref),
        status: 'observed',
        kind: 'reproducibility',
        sourceLocator: record.path,
        evidenceRefs: [{ kind: 'path', ref: record.path, hash: record.hash }],
      });
    }
    const jsonReproducibility = [
      ...(Array.isArray(json.reproducibility) ? json.reproducibility : []),
      ...(Array.isArray(json.reproducibility_items) ? json.reproducibility_items : []),
      ...(Array.isArray(json.reproducibility_plan) ? json.reproducibility_plan : []),
    ];
    for (const item of jsonReproducibility.slice(0, 24)) {
      reproducibilityItems.push({
        id: item.id || item.key || `json_repro:${reproducibilityItems.length + 1}`,
        text: item.text || item.summary || item.description || String(item),
        status: item.status || 'observed',
        kind: item.kind || 'reproducibility',
        sourceLocator: item.source_locator || item.sourceLocator || record.path,
        evidenceRefs: [{ kind: 'path', ref: record.path, hash: record.hash }],
      });
    }
    const jsonExperiments = [
      ...(Array.isArray(json.experiments) ? json.experiments : []),
      ...(json.experiment && typeof json.experiment === 'object' ? [json.experiment] : []),
      ...(json.experiment_manifest && typeof json.experiment_manifest === 'object' ? [json.experiment_manifest] : []),
    ];
    for (const experiment of jsonExperiments.slice(0, 24)) {
      experiments.push({
        ...experiment,
        experimentId: experiment.experimentId || experiment.experiment_id || experiment.id || `json_experiment:${experiments.length + 1}`,
        resultPath: experiment.resultPath || experiment.result_path || record.path,
        resultHash: experiment.resultHash || experiment.result_hash || record.hash,
      });
    }
    const jsonFormalAdapters = [
      ...(Array.isArray(json.formalVerifierAdapters) ? json.formalVerifierAdapters : []),
      ...(Array.isArray(json.formal_verifier_adapters) ? json.formal_verifier_adapters : []),
    ];
    formalAdapterReceipts.push(...jsonFormalAdapters.slice(0, 24));
    const jsonFormalCertificates = [
      ...(Array.isArray(json.formalCertificates) ? json.formalCertificates : []),
      ...(Array.isArray(json.formal_certificates) ? json.formal_certificates : []),
      ...(json.formalCertificateRequest && typeof json.formalCertificateRequest === 'object' ? [json.formalCertificateRequest] : []),
      ...(json.formal_certificate_request && typeof json.formal_certificate_request === 'object' ? [json.formal_certificate_request] : []),
    ];
    formalCertificateRequests.push(...jsonFormalCertificates.slice(0, 24));
  }
  return { claims, obligations, evidenceItems, reproducibilityItems, experiments, formalAdapterReceipts, formalCertificateRequests };
}

export async function readResearchEvidenceSources({ root, sourceRoot, logRoot, empiricalRoot, paperTask = null } = {}) {
  const sourceEvidence = await scanEvidenceRoot(root, sourceRoot, 'source');
  const logEvidence = await scanEvidenceRoot(root, logRoot, 'log');
  const empiricalEvidence = await scanEvidenceRoot(root, empiricalRoot, 'empirical');
  const evidenceRecords = [...sourceEvidence, ...logEvidence, ...empiricalEvidence];
  const proposalSeedEvidence = evidenceRecords.filter((record) => (
    /proposal.*seed.*contract|claim.*proof.*evidence.*repro.*seed/i.test(`${record.filename} ${record.path}`)
  ));
  const structured = await extractStructuredItems(root, evidenceRecords);
  const workerPlan = sourceRoot ? await readJsonIfExists(resolveRepoPath(sourceRoot, 'RESEARCH_WORKER_PLAN.json')) : null;
  const canonicalClaimRegistry = workerPlan
    ? canonicalClaimsFromWorkerPlan({ sourceRoot, paperTask, plan: workerPlan })
    : null;
  const empiricalProfile = [
    paperTask?.paperQualityProfile,
    ...(paperTask?.paperQualityProfiles || []),
  ].includes('empirical_or_experiment');
  let canonicalEmpiricalClaimRegistry = null;
  let canonicalEmpiricalAssertionUniverse = null;
  if (empiricalProfile && sourceRoot) {
    const mainTex = String(paperTask?.mainTex || 'main.tex').replace(/\\/g, '/');
    const sourceWorkspace = String(paperTask?.sourceWorkspace || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
    const relativeMainTex = sourceWorkspace && mainTex.startsWith(`${sourceWorkspace}/`)
      ? mainTex.slice(sourceWorkspace.length + 1) : mainTex;
    const absoluteMainTex = path.isAbsolute(mainTex) ? path.resolve(mainTex) : path.resolve(sourceRoot, relativeMainTex);
    const manuscriptPath = path.relative(sourceRoot, absoluteMainTex).replace(/\\/g, '/');
    const universe = readEmpiricalClaimUniverse({ sourceRoot, manuscriptPath });
    const claims = canonicalEmpiricalClaimsFromUniverse(universe);
    canonicalEmpiricalClaimRegistry = Object.freeze({
      status: universe.status === 'empirical_claim_universe_verified'
        ? 'canonical_empirical_claim_registry_verified' : 'canonical_empirical_claim_registry_blocked',
      empiricalClaimUniverse: universe,
      empiricalClaimUniverseHash: universe.empiricalClaimUniverseHash,
      manuscriptCorpusHash: universe.manuscriptCorpusHash,
      claims,
      blockers: universe.blockers,
    });
    const assertionUniverse = readEmpiricalAssertionUniverse({
      sourceRoot,
      manuscriptPath,
      trustedEmpiricalClaimUniverse: universe,
    });
    canonicalEmpiricalAssertionUniverse = Object.freeze({
      status: assertionUniverse.status === 'empirical_assertion_universe_verified'
        ? 'canonical_empirical_assertion_universe_verified'
        : 'canonical_empirical_assertion_universe_blocked',
      empiricalAssertionUniverse: assertionUniverse,
      empiricalAssertionUniverseHash: assertionUniverse.empiricalAssertionUniverseHash,
      manuscriptCorpusHash: assertionUniverse.manuscriptCorpusHash,
      blockers: assertionUniverse.blockers,
    });
  }
  const formalClaims = canonicalClaimRegistry && (workerPlan.workers || []).some((worker) => worker?.type === 'formal_verifier_lake')
    ? canonicalClaimRegistry.claims : [];
  if (empiricalProfile) structured.claims = [...formalClaims, ...(canonicalEmpiricalClaimRegistry?.claims || [])];
  else if (formalClaims.length) structured.claims = [...formalClaims];
  structured.canonicalClaimRegistry = canonicalClaimRegistry;
  structured.canonicalEmpiricalClaimRegistry = canonicalEmpiricalClaimRegistry;
  structured.canonicalEmpiricalAssertionUniverse = canonicalEmpiricalAssertionUniverse;
  return { sourceEvidence, logEvidence, empiricalEvidence, evidenceRecords, proposalSeedEvidence, structured };
}

export function readRefereeRevisionRequests(store, paperId) {
  const escapedPaperId = String(paperId || '').replace(/'/g, "''");
  return store?.query
    ? assertStoreQueryResult(store.query(`SELECT * FROM referee_revision_requests WHERE slug='${escapedPaperId}' ORDER BY matrix_rank,request_id;`)).rows
    : [];
}
