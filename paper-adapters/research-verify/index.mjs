import path from 'node:path';
import {
  fileRecord,
  pathWithin,
  readJsonIfExists,
  relativePath,
  walkFiles,
} from '../../workflow-kernel/runtime/file-utils.mjs';
import { normalizeText, uniqueStrings } from '../../workflow-kernel/runtime/text-utils.mjs';
import {
  buildPaperResearchVerifyReceipt,
  createClaimScopeContract,
  createEvidenceMatrixContract,
  createProofObligationContract,
  createReproducibilityContract,
  hashPaperRecord,
} from '../../paper-domain/contracts/index.mjs';
import { verifyAcademicEvidenceAttestation } from './academic-evidence.mjs';
import { runNativeResearchWorkers } from './worker-runtime.mjs';
import { buildClaimRegistry } from '../../paper-domain/research/claim-registry.mjs';
import { buildEvidenceIntake } from '../../paper-domain/research/evidence-ingestor.mjs';
import { buildEvidenceQualityGate } from '../../paper-domain/research/evidence-quality-gate.mjs';
import { buildExperimentRegistry } from '../../paper-domain/research/experiment-registry.mjs';
import { buildFormalVerifierRegistry } from '../../paper-domain/research/formal-verifier-registry.mjs';
import { buildGenericFormalCertificateIntake } from '../../paper-domain/research/formal-certificate-intake.mjs';
import { buildResearchChangeProposal } from '../../paper-domain/research/change-proposal.mjs';
import { bindResearchGapPlan, buildResearchGapPlan } from '../../paper-domain/research/gap-planner.mjs';
import { verifyEvidenceBatch } from './evidence-verifier.mjs';
import { defaultPaperRuntimeRoot } from '../../paper-adapters/runtime/workspace-layout.mjs';
import { buildPromotionInputSnapshot, buildResearchGapClosureReceipt } from '../../paper-domain/quality/promotion-input-snapshot.mjs';
import { verifyArtifactWriteReceiptSource } from '../artifacts/artifact-write-receipt-verifier.mjs';

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
    const absolute = repoPath(root, record.path);
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

export async function runResearchVerifyAdapter({
  root,
  row,
  runtimeRoot = null,
  executeResearchWorkers = false,
  requireNativeWorkers = false,
  trustStoreOverride = null,
  now = new Date(),
  authorityVerifier = null,
  jobReceiptStore = null,
  artifactRepositoryFactory = null,
  receiptLedger = null,
  clock = null,
  store = null,
} = {}) {
  const sourceRoot = repoPath(root, row.task.sourceWorkspace);
  const resolvedRuntimeRoot = runtimeRoot
    ? path.resolve(runtimeRoot)
    : defaultPaperRuntimeRoot();
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
    jobReceiptStore,
    artifactRepositoryFactory,
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
  const researchWorkers = [];
  const legacyCatalogReferences = [];
  const claimRegistry = buildClaimRegistry({
    paperTask: row.task,
    claims: structured.claims,
  });
  const evidenceVerificationReceipts = await verifyEvidenceBatch({
    sourceRoot,
    evidenceItems: structured.evidenceItems.map((item) => ({
      id: item.id,
      path: repoPath(root, item.sourceLocator || item.evidenceRefs?.[0]?.ref || null),
      hash: item.evidenceRefs?.find((ref) => ref.hash)?.hash || null,
      provenance: item.kind || 'observed_evidence',
    })).filter((item) => item.path && item.hash && sourceRoot && pathWithin(sourceRoot, item.path)),
    authorityVerifier,
  });
  const verificationById = new Map(evidenceVerificationReceipts.map((receipt) => [receipt.evidenceId, receipt]));
  const attestedEvidenceItems = academicEvidenceAttestation.academicEvidenceEligible
    ? (academicEvidenceAttestation.verifiedArtifacts || []).filter((item) => item.verified === true).map((item, index) => ({
      id: `attested:${index + 1}:${item.path}`,
      kind: item.kind || 'attested_academic_evidence',
      claimIds: item.claimIds || [],
      path: `${item.scope || 'source'}:${item.path}`,
      hash: item.currentHash,
      verificationStatus: 'evidence_artifact_verified',
      verifiedHash: item.currentHash,
      provenanceReceiptHash: academicEvidenceAttestation.academicEvidenceAttestationVerificationHash,
      createdAt: now.toISOString(),
      verificationReceipt: {
        kind: 'EvidenceArtifactVerificationReceipt',
        status: 'evidence_artifact_verified',
        hash: academicEvidenceAttestation.academicEvidenceAttestationVerificationHash,
        createdAt: now.toISOString(),
        claimIds: item.claimIds || [],
        path: `${item.scope || 'source'}:${item.path}`,
      },
    })) : [];
  const candidateEvidenceItems = structured.evidenceItems.map((item) => ({
    ...item,
    claimIds: item.claimIds || item.claim_ids || [],
    path: item.sourceLocator || item.evidenceRefs?.[0]?.ref || null,
    hash: item.evidenceRefs?.find((ref) => ref.hash)?.hash || null,
    verificationStatus: verificationById.get(item.id)?.status || 'unverified',
    verifiedHash: verificationById.get(item.id)?.verifiedHash || null,
    provenanceReceiptHash: verificationById.get(item.id)?.provenanceReceiptHash || null,
    createdAt: verificationById.get(item.id)?.createdAt || null,
    verificationReceipt: verificationById.get(item.id) || null,
  }));
  const evidenceIntake = buildEvidenceIntake({
    paperTask: row.task,
    evidenceItems: attestedEvidenceItems.length ? attestedEvidenceItems : candidateEvidenceItems,
  });
  const experimentRegistry = buildExperimentRegistry({ paperTask: row.task, artifacts: structured.experiments, receiptLedger, artifactVerifier: verifyArtifactWriteReceiptSource });
  const formalVerifierRegistry = buildFormalVerifierRegistry({ adapterReceipts: structured.formalAdapterReceipts, receiptLedger });
  const formalCertificateIntakes = structured.formalCertificateRequests.map((request) => buildGenericFormalCertificateIntake({
    verifierKind: request.verifierKind || request.verifier_kind,
    certificate: request.certificate,
    sourceRecords: request.sourceRecords || request.source_records || [],
    claimBindings: request.claimBindings || request.claim_bindings || [],
    executionReceipt: request.executionReceipt || request.execution_receipt,
    verifierRegistry: formalVerifierRegistry,
    receiptLedger,
    artifactVerifier: verifyArtifactWriteReceiptSource,
  }));
  const evidenceQualityGate = buildEvidenceQualityGate({
    paperTask: row.task,
    claimRegistry,
    evidenceIntake,
    nativeWorkerReceipts: nativeResearchWorkerExecution.workerReceipts,
    receiptLedger,
    experimentEvidenceBindings: experimentRegistry.experiments.map((experiment) => experiment.evidenceBinding),
    formalCertificateIntakes,
  });
  const escapedPaperId = String(row.task.paperId || '').replace(/'/g, "''");
  const revisionRequests = store?.query
    ? (store.query(`SELECT * FROM referee_revision_requests WHERE slug='${escapedPaperId}' ORDER BY matrix_rank,request_id;`).rows || [])
    : [];
  const researchGapPlan = buildResearchGapPlan({ paperTask: row.task, claimRegistry, evidenceQualityGate, revisionRequests });
  const promotionInputSnapshot = buildPromotionInputSnapshot({
    paperTask: row.task,
    claimRegistry,
    evidenceQualityGate,
    researchGapPlan,
    revisionRequests,
    createdAt: now.toISOString(),
  });
  const researchGapClosureReceipt = buildResearchGapClosureReceipt({ promotionInputSnapshot, researchGapPlan });
  const researchGapPlanBinding = jobReceiptStore && receiptLedger && clock
    ? bindResearchGapPlan({
      plan: researchGapPlan,
      jobReceiptStore,
      receiptLedger,
      clock,
      workerId: executeResearchWorkers ? 'research-gap-planner' : null,
    })
    : null;
  const formalWorkerReceipts = (nativeResearchWorkerExecution.workerReceipts || [])
    .filter((receipt) => ['formal_verifier_lake', 'formal_verifier_lean'].includes(receipt.workerType));
  const promotionBlockers = [
    ...(evidenceQualityGate.status === 'evidence_quality_ready' ? [] : ['evidence_quality_gate_not_ready', ...(evidenceQualityGate.blockers || []).map((item) => `evidence_quality:${item}`)]),
    ...(experimentRegistry.experiments.length === 0 || experimentRegistry.status === 'experiment_registry_ready'
      ? [] : ['experiment_registry_not_ready', ...(experimentRegistry.incompleteExperimentIds || []).map((item) => `experiment_not_accepted:${item}`)]),
    ...formalWorkerReceipts.filter((receipt) => receipt.result?.status !== 'formal_claim_verified')
      .map((receipt) => `formal_claim_verification_required:${receipt.workerId || receipt.workerType}`),
  ];
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
  const reportStatus = proposalSeedEvidence.length > 0
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
      promotionInputSnapshot,
      researchGapClosureReceipt,
      researchGapPlanBinding,
      experimentRegistry,
      formalVerifierRegistry,
      formalCertificateIntakes,
      researchChangeProposal,
      evidenceVerificationReceipts,
    },
    promotionEligibility: {
      status: promotionBlockers.length ? 'research_promotion_blocked' : 'research_promotion_ready',
      blockers: promotionBlockers,
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
      legacyWorkerCatalogScanned: false,
    },
  };
  return { ...report, researchReportHash: hashPaperRecord('PaperResearchVerifyReport', report) };
}
