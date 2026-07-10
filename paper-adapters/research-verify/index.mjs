import path from 'node:path';
import {
  fileRecord,
  normalizeText,
  readJsonIfExists,
  relativePath,
  uniqueStrings,
  walkFiles,
} from '../../paper-core/src/utils.mjs';
import {
  buildPaperResearchVerifyReceipt,
  buildPaperResearchWorkerBridgeReceipt,
  createClaimScopeContract,
  createEvidenceMatrixContract,
  createProofObligationContract,
  createReproducibilityContract,
  hashPaperRecord,
} from '../../paper-core/src/paper-contracts.mjs';
import { verifyAcademicEvidenceAttestation } from './academic-evidence.mjs';
import { runNativeResearchWorkers } from './worker-runtime.mjs';
import { buildClaimRegistry } from '../../paper-domain/research/claim-registry.mjs';
import { buildEvidenceIntake } from '../../paper-domain/research/evidence-ingestor.mjs';
import { buildEvidenceQualityGate } from '../../paper-domain/research/evidence-quality-gate.mjs';
import { buildExperimentRegistry } from '../../paper-domain/research/experiment-registry.mjs';
import { buildResearchChangeProposal } from '../../paper-domain/research/change-proposal.mjs';
import { buildResearchGapPlan } from '../../paper-application/research/gap-planner.mjs';

function repoPath(root, value) {
  const text = normalizeText(value);
  if (!text) return null;
  return path.isAbsolute(text) ? text : path.join(root, text);
}

async function scanEvidenceRoot(root, sourceRoot, rolePrefix) {
  if (!sourceRoot) return [];
  const files = await walkFiles(sourceRoot, {
    maxDepth: 5,
    maxFiles: 2000,
    match: (_full, name) => /\.(md|json|jsonl|csv|txt)$/i.test(name)
      && /claim|evidence|proof|referee|review|verdict|audit|manifest|readiness|status|formal|lean|empirical|experiment|result|dataset|benchmark|table/i.test(name),
  });
  const records = [];
  for (const file of files.slice(0, 128)) {
    const record = await fileRecord(root, file, `${rolePrefix}_evidence`);
    if (record) records.push(record);
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

function excludedWorkerName(name) {
  return /(capstone|matrix|roadmap|external_submission|portal|executor|submission|patch_queue|candidate_patch|apply|merge|mutation|accepted_decision|manual_review_decision|source_landing|lifecycle_orchestrator|record_only_fixture|fixture_harness|idle_loop)/i
    .test(name);
}

function workerRoleForName(name) {
  const lower = normalizeText(name).toLowerCase();
  if (excludedWorkerName(lower)) return null;
  if (/formal_verifier|proof|lean|coq|isabelle|theorem|semantic_definition|statement_extraction/.test(lower)) return 'proof';
  if (/claim/.test(lower)) return 'claim';
  if (/reproduc|experiment|registry|execution_harness/.test(lower)) return 'reproducibility';
  if (/evidence/.test(lower)) return 'evidence';
  return null;
}

const researchWorkerBridgeCache = new Map();

async function discoverResearchWorkerBridges(root) {
  const cacheKey = path.resolve(root);
  if (researchWorkerBridgeCache.has(cacheKey)) return researchWorkerBridgeCache.get(cacheKey);
  const workerRoot = path.join(root, 'paperctl_modules');
  const files = await walkFiles(workerRoot, {
    maxDepth: 1,
    maxFiles: 1000,
    match: (_full, name) => /^research_compute_.*\.py$/i.test(name),
  });
  const workers = [];
  for (const file of files) {
    const filename = path.basename(file);
    const role = workerRoleForName(filename);
    if (!role) continue;
    const record = await fileRecord(root, file, `research_worker_${role}`);
    if (!record) continue;
    workers.push({
      id: filename.replace(/\.py$/i, ''),
      role,
      path: record.path,
      filename: record.filename,
      hash: record.hash,
      sizeBytes: record.sizeBytes,
    });
  }
  const sorted = workers.sort((left, right) => (
    left.role.localeCompare(right.role)
    || left.filename.length - right.filename.length
    || left.filename.localeCompare(right.filename)
  ));
  researchWorkerBridgeCache.set(cacheKey, sorted);
  return sorted;
}

function refsForRole(evidenceRefs, role) {
  const roleRe = {
    claim: /claim|statement/i,
    proof: /proof|formal|lean|coq|isabelle|theorem/i,
    evidence: /evidence|matrix|audit|manifest|verdict|status/i,
    reproducibility: /reproduc|result|seed|checksum|sha256|command|run/i,
  }[role] || /evidence/i;
  const matched = (evidenceRefs || []).filter((ref) => roleRe.test(ref));
  return matched.length ? matched : (evidenceRefs || []).slice(0, 8);
}

function buildLegacyCatalogReferences({ paperTask, workers, contracts, evidenceRefs }) {
  const contractHashes = {
    claimScopeContractHash: contracts.claimScopeContract?.claimScopeContractHash || null,
    proofObligationContractHash: contracts.proofObligationContract?.proofObligationContractHash || null,
    evidenceMatrixContractHash: contracts.evidenceMatrixContract?.evidenceMatrixContractHash || null,
    reproducibilityContractHash: contracts.reproducibilityContract?.reproducibilityContractHash || null,
  };
  const receipts = [];
  const roles = ['claim', 'proof', 'evidence', 'reproducibility'];
  for (const role of roles) {
    const roleWorkers = workers.filter((worker) => worker.role === role).slice(0, 3);
    for (const worker of roleWorkers) {
      const receipt = buildPaperResearchWorkerBridgeReceipt({
        paperTask,
        worker,
        role,
        contractHashes,
        evidenceRefs: refsForRole(evidenceRefs, role),
      });
      receipts.push({
        ...receipt,
        capabilityEvidenceClass: 'legacy_worker_catalog_reference_only',
        legacyWorkerExecutionPerformed: false,
        semanticMigrationVerified: false,
      });
    }
  }
  return receipts;
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
  for (const record of records.slice(0, 96)) {
    const absolute = repoPath(root, record.path);
    const json = /\.json$/i.test(record.filename || '') ? await readJsonIfExists(absolute) : null;
    const roles = classifyEvidenceRecord(record);
    if (roles.includes('claim')) claims.push(asContractItem(record, 'claim', claims.length));
    if (roles.includes('proof')) obligations.push(asContractItem(record, 'proof', obligations.length));
    if (roles.includes('evidence')) evidenceItems.push(asContractItem(record, 'evidence', evidenceItems.length));
    if (roles.includes('reproducibility')) reproducibilityItems.push(asContractItem(record, 'reproducibility', reproducibilityItems.length));
    if (!json || typeof json !== 'object') continue;
    const jsonClaims = [
      ...(Array.isArray(json.claims) ? json.claims : []),
      ...(Array.isArray(json.claim_packets) ? json.claim_packets : []),
      ...(Array.isArray(json.claims_matrix) ? json.claims_matrix : []),
    ];
    for (const claim of jsonClaims.slice(0, 24)) {
      claims.push({
        id: claim.claim_id || claim.id || claim.key || `json_claim:${claims.length + 1}`,
        text: claim.claim_text || claim.text || claim.claim || claim.statement || `claim from ${record.path}`,
        status: claim.status || claim.verdict || 'observed',
        kind: claim.kind || 'claim',
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
  }
  return { claims, obligations, evidenceItems, reproducibilityItems };
}

export async function runResearchVerifyAdapter({
  root,
  row,
  runtimeRoot = null,
  executeResearchWorkers = false,
  requireNativeWorkers = false,
  trustStoreOverride = null,
  now = new Date(),
} = {}) {
  const sourceRoot = repoPath(root, row.task.sourceWorkspace);
  const resolvedRuntimeRoot = runtimeRoot
    ? path.resolve(runtimeRoot)
    : path.join(root, 'hepta-paper-workspace', 'runtime');
  const logRoot = path.join(root, 'logs', 'paperctl', row.task.paperId);
  const empiricalRoot = path.join(resolvedRuntimeRoot, 'empirical-analysis', row.task.paperId);
  const sourceEvidence = await scanEvidenceRoot(root, sourceRoot, 'source');
  const logEvidence = await scanEvidenceRoot(root, logRoot, 'log');
  const empiricalEvidence = await scanEvidenceRoot(root, empiricalRoot, 'empirical');
  const evidenceRecords = [...sourceEvidence, ...logEvidence, ...empiricalEvidence];
  const proposalSeedEvidence = evidenceRecords.filter((record) => (
    /proposal.*seed.*contract|claim.*proof.*evidence.*repro.*seed/i.test(`${record.filename} ${record.path}`)
  ));
  const structured = await extractStructuredItems(root, evidenceRecords);
  const nativeResearchWorkerExecution = await runNativeResearchWorkers({
    root,
    sourceRoot,
    runtimeRoot: resolvedRuntimeRoot,
    paperTask: row.task,
    execute: Boolean(executeResearchWorkers),
  });
  const academicEvidenceAttestation = await verifyAcademicEvidenceAttestation({
    root,
    sourceRoot,
    runtimeRoot: resolvedRuntimeRoot,
    paperTask: row.task,
    workerExecutionReport: nativeResearchWorkerExecution,
    trustStoreOverride,
    now,
  });
  const evidenceRefs = uniqueStrings([
    ...(row.state.evidenceRefs || []).map((ref) => ref.ref),
    ...evidenceRecords.map((ref) => ref.path),
  ], 128);
  const blockers = [];
  const warnings = [];
  if (!sourceRoot) blockers.push('source_workspace_missing');
  if (requireNativeWorkers && nativeResearchWorkerExecution.status !== 'native_research_workers_verified') {
    blockers.push('native_research_workers_required');
  }
  if (!evidenceRefs.length) warnings.push('claim_evidence_not_found');
  if (proposalSeedEvidence.length) warnings.push('proposal_seed_contracts_require_real_evidence_followup');
  const claimScopeContract = createClaimScopeContract({
    paperTask: row.task,
    claims: structured.claims,
    evidenceRefs,
    blockers,
  });
  const proofObligationContract = createProofObligationContract({
    paperTask: row.task,
    obligations: structured.obligations,
    evidenceRefs,
  });
  const evidenceMatrixContract = createEvidenceMatrixContract({
    paperTask: row.task,
    evidenceItems: structured.evidenceItems,
    evidenceRefs,
  });
  const reproducibilityContract = createReproducibilityContract({
    paperTask: row.task,
    artifacts: structured.reproducibilityItems,
    evidenceRefs: evidenceRefs.filter((ref) => /reproduc|result|seed|checksum|sha256|command|run/i.test(ref)),
  });
  const researchWorkers = await discoverResearchWorkerBridges(root);
  const legacyCatalogReferences = buildLegacyCatalogReferences({
    paperTask: row.task,
    workers: researchWorkers,
    contracts: {
      claimScopeContract,
      proofObligationContract,
      evidenceMatrixContract,
      reproducibilityContract,
    },
    evidenceRefs,
  });
  const claimRegistry = buildClaimRegistry({ paperTask: row.task, claims: structured.claims });
  const evidenceIntake = buildEvidenceIntake({
    paperTask: row.task,
    evidenceItems: structured.evidenceItems.map((item) => ({
      ...item,
      claimIds: item.claimIds || item.claim_ids || [],
      path: item.sourceLocator || item.evidenceRefs?.[0]?.ref || null,
      hash: item.evidenceRefs?.find((ref) => ref.hash)?.hash || null,
    })),
  });
  const evidenceQualityGate = buildEvidenceQualityGate({
    paperTask: row.task,
    claimRegistry,
    evidenceIntake,
    nativeWorkerReceipts: nativeResearchWorkerExecution.workerReceipts,
  });
  const researchGapPlan = buildResearchGapPlan({ paperTask: row.task, claimRegistry, evidenceQualityGate });
  const experimentRegistry = buildExperimentRegistry({ paperTask: row.task, artifacts: evidenceRecords });
  const researchChangeProposal = buildResearchChangeProposal({
    paperTask: row.task,
    patches: [],
    evidenceQualityGate,
  });
  const verifyReceipt = buildPaperResearchVerifyReceipt({
    paperTask: row.task,
    claimScopeContract,
    proofObligationContract,
    evidenceMatrixContract,
    reproducibilityContract,
    legacyCatalogReferences,
    evidenceRefs,
    blockers,
    warnings,
  });
  const reportStatus = verifyReceipt.status === 'evidence_present'
    && proposalSeedEvidence.length > 0
    && proposalSeedEvidence.length === evidenceRecords.length
    ? 'proposal_seed_present'
    : verifyReceipt.status;
  const report = {
    version: 1,
    kind: 'PaperResearchVerifyReport',
    paperId: row.task.paperId,
    taskKey: row.task.taskKey,
    status: reportStatus,
    academicEvidenceStatus: academicEvidenceAttestation.status,
    academicEvidenceEligible: academicEvidenceAttestation.academicEvidenceEligible,
    sourceEvidenceCount: sourceEvidence.length,
    logEvidenceCount: logEvidence.length,
    empiricalEvidenceCount: empiricalEvidence.length,
    proposalSeedEvidenceCount: proposalSeedEvidence.length,
    claimCount: claimScopeContract.claimCount,
    proofObligationCount: proofObligationContract.proofObligationCount,
    evidenceItemCount: evidenceMatrixContract.evidenceItemCount,
    reproducibilityItemCount: reproducibilityContract.reproducibilityItemCount,
    legacyCatalogReferenceCount: researchWorkers.length,
    legacyCatalogReferenceReceiptCount: legacyCatalogReferences.length,
    nativeResearchWorkerPlanStatus: nativeResearchWorkerExecution.status,
    nativeResearchWorkerCount: nativeResearchWorkerExecution.plannedResearchWorkerCount,
    executedResearchWorkerCount: nativeResearchWorkerExecution.executedResearchWorkerCount,
    verifiedNativeResearchWorkerCount: nativeResearchWorkerExecution.verifiedAcademicEvidenceWorkerCount,
    semanticMigrationVerifiedWorkerCount: 0,
    evidenceProvenance: {
      sourceCandidateRecordCount: sourceEvidence.length,
      operationalLogRecordCount: logEvidence.length,
      pipelineSmokeRecordCount: empiricalEvidence.length,
      pipelineSmokeExcludedFromAcademicEvidence: true,
    },
    academicEvidenceAttestation,
    nativeResearchWorkerExecution,
    capabilities: {
      claimRegistry,
      evidenceIntake,
      evidenceQualityGate,
      researchGapPlan,
      experimentRegistry,
      researchChangeProposal,
    },
    evidenceRefs,
    typedContracts: {
      claimScopeContract,
      proofObligationContract,
      evidenceMatrixContract,
      reproducibilityContract,
      legacyCatalogReferences,
      verifyReceipt,
    },
    blockers,
    warnings: uniqueStrings([
      ...warnings,
      ...(verifyReceipt.warnings || []),
    ], 64),
    sourceRoots: {
      sourceWorkspace: sourceRoot ? relativePath(root, sourceRoot) : null,
      paperctlLog: relativePath(root, logRoot),
      empiricalAnalysis: relativePath(root, empiricalRoot),
    },
    safety: {
      readsOnly: !executeResearchWorkers,
      writesRuntimeOnly: Boolean(executeResearchWorkers),
      sourceMutation: false,
      externalActionPerformed: false,
    },
  };
  return { ...report, researchReportHash: hashPaperRecord('PaperResearchVerifyReport', report) };
}
