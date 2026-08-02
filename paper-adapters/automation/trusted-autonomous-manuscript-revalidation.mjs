import fs from 'node:fs';
import path from 'node:path';

import {
  verifyTrustedAutonomousManuscriptRenderReceipt,
} from '../../paper-domain/automation/trusted-autonomous-manuscript-render-contract.mjs';
import {
  EVIDENCE_BOUND_MANUSCRIPT_IR_DRAFT_PATH,
  evidenceBoundManuscriptIrDraftHash,
  verifyEvidenceBoundManuscriptIr,
} from '../../paper-domain/research/evidence-bound-manuscript-ir.mjs';
import {
  EVIDENCE_ENTAILMENT_CONTRACT_PATH,
  verifyEvidenceEntailmentContract,
} from '../../paper-domain/research/evidence-entailment-contract.mjs';
import {
  bindEmpiricalAssertionUniverse,
  buildEmpiricalPresentationAuthority,
} from '../../paper-domain/research/empirical-assertion-contract.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  readScopedFileSync,
} from '../../workflow-kernel/runtime/scoped-file-identity.mjs';
import { readEmpiricalAssertionUniverse } from '../research-verify/empirical-assertion-universe-reader.mjs';
import { readEmpiricalClaimUniverse } from '../research-verify/empirical-claim-universe-reader.mjs';
import {
  buildEmpiricalAssertionAuthorityFromCampaignNodes,
  empiricalAssertionAuthorityEntriesMatch,
  readMaterializedEmpiricalAssertionAuthority,
} from './empirical-assertion-authority.mjs';
import {
  readVerifiedAutonomousManuscriptAuthorityRecords,
} from './trusted-autonomous-manuscript-authority-reader.mjs';
import {
  autonomousManuscriptAuthorityBindings,
  autonomousManuscriptEvidenceSourceDocuments,
  buildDefaultAutonomousManuscriptIrDraft,
} from './autonomous-manuscript-ir-materialization.mjs';
import {
  analysisProtocolTemplateHashFromAuthorityArtifacts,
  empiricalClaimsFromAuthority,
} from './trusted-autonomous-manuscript-renderer.mjs';

const PRIOR_ART_PATH = 'AUTONOMOUS_PRIOR_ART_EVIDENCE.json';
const MAXIMUM_JSON_BYTES = 16 * 1024 * 1024;
const SHA256 = /^sha256:[0-9a-f]{64}$/;

function readJson(root, relative, blockers, blocker) {
  if (typeof relative !== 'string' || !relative.trim()) {
    blockers.push(blocker);
    return Object.freeze({ value: null, hash: null });
  }
  let read = null;
  try {
    read = readScopedFileSync({
      scopeRoot: root,
      candidate: path.resolve(root, relative),
    });
  } catch {
    blockers.push(blocker);
    return Object.freeze({ value: null, hash: null });
  }
  if (read.status !== 'scoped_file_read_verified' || read.bytes > MAXIMUM_JSON_BYTES) {
    blockers.push(blocker);
    return Object.freeze({ value: null, hash: null });
  }
  try {
    return Object.freeze({ value: JSON.parse(read.content.toString('utf8')), hash: read.hash });
  } catch {
    blockers.push(blocker);
    return Object.freeze({ value: null, hash: read.hash });
  }
}

function canonicalArtifacts(value, blockers, { reportMalformed = false } = {}) {
  if (!Array.isArray(value)) {
    if (reportMalformed || (value !== null && value !== undefined)) {
      blockers.push(
        'trusted_autonomous_manuscript_revalidation_presentation_artifact_invalid',
      );
    }
    return Object.freeze([]);
  }
  const artifacts = [];
  for (const artifact of value) {
    if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)
      || typeof artifact.path !== 'string' || !artifact.path.trim()
      || !SHA256.test(String(artifact.hash || ''))
      || !Number.isSafeInteger(artifact.bytes) || artifact.bytes < 0) {
      blockers.push(
        'trusted_autonomous_manuscript_revalidation_presentation_artifact_invalid',
      );
      continue;
    }
    artifacts.push(Object.freeze({
      path: artifact.path,
      hash: artifact.hash,
      bytes: artifact.bytes,
    }));
  }
  return Object.freeze(artifacts.sort((left, right) => left.path.localeCompare(right.path)));
}

function equal(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function revalidateTrustedAutonomousManuscriptWorkspace({
  workspacePath,
  manuscriptPath = 'main.tex',
  paperId,
  campaignId,
  campaignNodes = [],
  trustedAutonomousManuscriptRenderReceipt = null,
  agentExecutionReceipt = null,
} = {}) {
  const blockers = [];
  const normalizedCampaignNodes = Array.isArray(campaignNodes) ? campaignNodes : [];
  if (!Array.isArray(campaignNodes)) {
    blockers.push('trusted_autonomous_manuscript_revalidation_campaign_node_invalid');
  }
  let root = null;
  try { root = fs.realpathSync(path.resolve(workspacePath || '')); }
  catch { blockers.push('trusted_autonomous_manuscript_revalidation_workspace_invalid'); }
  const manuscriptRead = root ? readScopedFileSync({
    scopeRoot: root,
    candidate: path.resolve(root, manuscriptPath),
  }) : null;
  if (manuscriptRead?.status !== 'scoped_file_read_verified') {
    blockers.push('trusted_autonomous_manuscript_revalidation_manuscript_invalid');
  }

  const empiricalCampaignNodes = normalizedCampaignNodes.filter((node) => (
    node?.status === 'completed'
      && (node?.result?.experimentRunReceipt || node?.result?.experimentReplayReceipt)
  ));
  const campaignEvidenceBound = empiricalCampaignNodes.length >= 2
    && empiricalCampaignNodes.every((node) => (
      node?.campaignId === campaignId
        && node?.resultSha256
        && hashRecord('PaperCampaignNodeResult', node.result) === node.resultSha256
    ));
  if (!campaignEvidenceBound) {
    blockers.push('trusted_autonomous_manuscript_revalidation_campaign_evidence_invalid');
  }
  let derivedAuthority = null;
  try {
    derivedAuthority = campaignEvidenceBound
      ? buildEmpiricalAssertionAuthorityFromCampaignNodes({
        paperId,
        campaignId,
        nodes: normalizedCampaignNodes,
      })
      : null;
  } catch {
    blockers.push('trusted_autonomous_manuscript_revalidation_campaign_authority_invalid');
  }
  const materialized = root ? readMaterializedEmpiricalAssertionAuthority({
    workspace: root,
    expectedPaperId: paperId,
    expectedCampaignId: campaignId,
  }) : null;
  if (materialized?.valid !== true
    || !derivedAuthority
    || materialized.authority?.empiricalAssertionAuthorityHash
      !== derivedAuthority.empiricalAssertionAuthorityHash
    || !empiricalAssertionAuthorityEntriesMatch(materialized.authority, derivedAuthority)) {
    blockers.push('trusted_autonomous_manuscript_revalidation_materialized_authority_mismatch');
  }

  const manuscriptIrRead = root ? readJson(
    root,
    trustedAutonomousManuscriptRenderReceipt?.manuscriptIrPath
      || 'AUTONOMOUS_MANUSCRIPT_IR.json',
    blockers,
    'trusted_autonomous_manuscript_revalidation_ir_file_invalid',
  ) : Object.freeze({ value: null, hash: null });
  const entailmentRead = root ? readJson(
    root,
    trustedAutonomousManuscriptRenderReceipt?.evidenceEntailmentContractPath
      || EVIDENCE_ENTAILMENT_CONTRACT_PATH,
    blockers,
    'trusted_autonomous_manuscript_revalidation_entailment_file_invalid',
  ) : Object.freeze({ value: null, hash: null });
  const draftRead = root && trustedAutonomousManuscriptRenderReceipt?.agentAuthoredSourceDraft
    ? readJson(
      root,
      EVIDENCE_BOUND_MANUSCRIPT_IR_DRAFT_PATH,
      blockers,
      'trusted_autonomous_manuscript_revalidation_agent_draft_file_invalid',
    ) : Object.freeze({ value: null, hash: null });
  const manuscriptIrAuthorityBindings = manuscriptIrRead.value?.authorityBindings;
  if (manuscriptIrRead.value && !Array.isArray(manuscriptIrAuthorityBindings)) {
    blockers.push(
      'trusted_autonomous_manuscript_revalidation_ir_authority_binding_invalid',
    );
  }
  const formalVerificationBindingHashes = new Set(
    (Array.isArray(manuscriptIrAuthorityBindings) ? manuscriptIrAuthorityBindings : [])
      .filter((binding) => binding?.kind === 'formal_verification')
      .map((binding) => binding.hash),
  );
  const boundFormalVerificationNodes = normalizedCampaignNodes.filter((node) => (
    node?.campaignId === campaignId
      && node?.status === 'completed'
      && formalVerificationBindingHashes.has(
        node?.result?.campaignFormalVerificationReceiptHash,
      )
      && node?.resultSha256
      && hashRecord('PaperCampaignNodeResult', node.result) === node.resultSha256
  ));
  const boundFormalVerificationReceipt = boundFormalVerificationNodes.length === 1
    ? boundFormalVerificationNodes[0].result : null;
  if (formalVerificationBindingHashes.size !== 1 || !boundFormalVerificationReceipt) {
    blockers.push('trusted_autonomous_manuscript_revalidation_formal_lineage_invalid');
  }

  let authorityRecords = null;
  if (root && !fs.existsSync(path.join(root, PRIOR_ART_PATH))) {
    blockers.push('trusted_autonomous_manuscript_revalidation_prior_art_authority_missing');
  } else if (root) {
    try {
      authorityRecords = readVerifiedAutonomousManuscriptAuthorityRecords(
        root,
        boundFormalVerificationReceipt,
      );
    } catch {
      blockers.push('trusted_autonomous_manuscript_revalidation_workspace_authority_invalid');
    }
  }

  let expectedAuthorityBindings = null;
  let expectedSourceDocuments = null;
  let expectedSystemSeedDraft = null;
  if (authorityRecords && derivedAuthority && root) {
    const authorityInput = {
      proposal: authorityRecords.proposal,
      policyAuthorization: authorityRecords.policyAuthorization,
      seedBundle: authorityRecords.seedBundle,
      empiricalClaimLineage: authorityRecords.empiricalClaimLineage,
      empiricalAssertionAuthority: derivedAuthority,
      formalSupportAuthority: authorityRecords.formalSupportAuthority,
      formalVerificationReceipt: boundFormalVerificationReceipt,
      priorArtReceipt: authorityRecords.priorArtReceipt,
    };
    try {
      const analysisProtocolTemplateHash =
        analysisProtocolTemplateHashFromAuthorityArtifacts(root, derivedAuthority);
      empiricalClaimsFromAuthority(derivedAuthority, authorityRecords.empiricalClaim, {
        root,
        proposal: authorityRecords.proposal,
        seedBundle: authorityRecords.seedBundle,
        empiricalClaimLineage: authorityRecords.empiricalClaimLineage,
        manuscriptPath,
        analysisProtocolTemplateHash,
      });
      expectedAuthorityBindings = autonomousManuscriptAuthorityBindings(authorityInput);
      expectedSourceDocuments = autonomousManuscriptEvidenceSourceDocuments(authorityInput);
      expectedSystemSeedDraft = buildDefaultAutonomousManuscriptIrDraft({
        proposal: authorityRecords.proposal,
        policyAuthorization: authorityRecords.policyAuthorization,
        seedBundle: authorityRecords.seedBundle,
        priorArtReceipt: authorityRecords.priorArtReceipt,
      });
    } catch {
      blockers.push('trusted_autonomous_manuscript_revalidation_lineage_authority_invalid');
    }
  } else {
    blockers.push('trusted_autonomous_manuscript_revalidation_authority_projection_invalid');
  }

  const manuscriptIrVerification = manuscriptIrRead.value && authorityRecords
    && expectedAuthorityBindings
    ? verifyEvidenceBoundManuscriptIr(manuscriptIrRead.value, {
      paperId,
      authorityBindings: expectedAuthorityBindings,
      priorArtReceipt: authorityRecords.priorArtReceipt,
      agentExecutionReceipt,
      sourceDraftFileHash: draftRead.hash,
      requireAgentAuthoredProse:
        trustedAutonomousManuscriptRenderReceipt?.requireAgentAuthoredProse === true,
    }) : null;
  if (manuscriptIrVerification?.valid !== true) {
    blockers.push('trusted_autonomous_manuscript_revalidation_ir_invalid');
  }
  const entailmentVerification = entailmentRead.value && manuscriptIrRead.value
    ? verifyEvidenceEntailmentContract(entailmentRead.value, {
      paperId,
      evidenceBoundManuscriptIrHash: manuscriptIrRead.value.evidenceBoundManuscriptIrHash,
    }) : null;
  if (entailmentVerification?.valid !== true) {
    blockers.push('trusted_autonomous_manuscript_revalidation_entailment_invalid');
  }
  const normalizedExpectedSourceDocuments = Array.isArray(expectedSourceDocuments)
    ? expectedSourceDocuments : [];
  if (expectedSourceDocuments && !Array.isArray(expectedSourceDocuments)) {
    blockers.push('trusted_autonomous_manuscript_revalidation_authority_projection_invalid');
  }
  const expectedSourceDocumentsByKey = new Map(normalizedExpectedSourceDocuments.map((document) => [
    `${document?.evidenceKind}:${document?.evidenceHash}`,
    document,
  ]));
  const sourceEvidenceDocuments = entailmentRead.value?.sourceEvidenceDocuments;
  if (entailmentRead.value && !Array.isArray(sourceEvidenceDocuments)) {
    blockers.push(
      'trusted_autonomous_manuscript_revalidation_source_evidence_document_invalid',
    );
  }
  const sourceEvidenceDocumentKeys = Array.isArray(sourceEvidenceDocuments)
    ? sourceEvidenceDocuments.map((document) => (
      `${document?.evidenceKind}:${document?.evidenceHash}`
    )) : [];
  const sourceEvidenceDocumentsShapeValid = Array.isArray(sourceEvidenceDocuments)
    && sourceEvidenceDocuments.every((document) => (
      document && typeof document === 'object' && !Array.isArray(document)
        && typeof document.evidenceKind === 'string' && document.evidenceKind.trim()
        && SHA256.test(String(document.evidenceHash || ''))
    ));
  const sourceEvidenceDocumentKeysUnique = new Set(sourceEvidenceDocumentKeys).size
    === sourceEvidenceDocumentKeys.length;
  if (Array.isArray(sourceEvidenceDocuments)
    && (!sourceEvidenceDocumentsShapeValid || !sourceEvidenceDocumentKeysUnique)) {
    blockers.push(
      'trusted_autonomous_manuscript_revalidation_source_evidence_document_invalid',
    );
  }
  if (!expectedSourceDocuments
    || !Array.isArray(sourceEvidenceDocuments)
    || !sourceEvidenceDocumentsShapeValid
    || !sourceEvidenceDocumentKeysUnique
    || !sourceEvidenceDocuments.every((document) => equal(
      expectedSourceDocumentsByKey.get(`${document?.evidenceKind}:${document?.evidenceHash}`),
      document,
    ))) {
    blockers.push('trusted_autonomous_manuscript_revalidation_entailment_authority_mismatch');
  }

  const actualAgentDraftHash = draftRead.value
    ? evidenceBoundManuscriptIrDraftHash(draftRead.value) : null;
  const expectedSystemSeedDraftHash = expectedSystemSeedDraft
    ? evidenceBoundManuscriptIrDraftHash(expectedSystemSeedDraft) : null;
  const receiptSystemSeedDraftHash =
    trustedAutonomousManuscriptRenderReceipt?.systemSeedManuscriptIrDraft
      ? evidenceBoundManuscriptIrDraftHash(
        trustedAutonomousManuscriptRenderReceipt.systemSeedManuscriptIrDraft,
      ) : null;
  if (trustedAutonomousManuscriptRenderReceipt?.agentAuthoredSourceDraft
    && (!expectedSystemSeedDraftHash
      || receiptSystemSeedDraftHash !== expectedSystemSeedDraftHash
      || (trustedAutonomousManuscriptRenderReceipt.requireAgentAuthoredProse === true
        && trustedAutonomousManuscriptRenderReceipt.systemSeedManuscriptIrDraftHash
          !== hashRecord('AutonomousManuscriptSystemSeedDraft', expectedSystemSeedDraft)))) {
    blockers.push('trusted_autonomous_manuscript_revalidation_system_seed_mismatch');
  }

  const expectedAuthorityBindingSetHash = manuscriptIrVerification?.valid === true
    ? manuscriptIrRead.value?.authorityBindingSetHash || null : null;
  if (!authorityRecords || !expectedAuthorityBindingSetHash
    || trustedAutonomousManuscriptRenderReceipt?.seedBundleHash
      !== authorityRecords.seedBundle?.autonomousResearchSeedContractBundleHash
    || trustedAutonomousManuscriptRenderReceipt?.priorArtEvidenceReceiptHash
      !== authorityRecords.priorArtReceipt?.priorArtEvidenceReceiptHash
    || trustedAutonomousManuscriptRenderReceipt?.authorityBindingSetHash
      !== expectedAuthorityBindingSetHash
    || manuscriptIrRead.value?.authorityBindingSetHash !== expectedAuthorityBindingSetHash) {
    blockers.push('trusted_autonomous_manuscript_revalidation_authority_binding_mismatch');
  }

  const renderVerification = verifyTrustedAutonomousManuscriptRenderReceipt(
    trustedAutonomousManuscriptRenderReceipt,
    {
      paperId,
      campaignId,
      manuscriptPath,
      manuscriptHash: manuscriptRead?.hash || null,
      evidenceBoundManuscriptIrHash:
        manuscriptIrRead.value?.evidenceBoundManuscriptIrHash || null,
      manuscriptIrFileHash: manuscriptIrRead.hash,
      agentAuthoredSourceDraftHash: actualAgentDraftHash,
      agentAuthoredSourceDraftFileHash: draftRead.hash,
      evidenceEntailmentContractHash:
        entailmentRead.value?.evidenceEntailmentContractHash || null,
      evidenceEntailmentContractFileHash: entailmentRead.hash,
      agentExecutionReceipt,
      requireAgentAuthored:
        trustedAutonomousManuscriptRenderReceipt?.requireAgentAuthoredProse === true,
      requireEvidenceEntailment: true,
      requireReadableProof:
        trustedAutonomousManuscriptRenderReceipt?.formalSupportTemplateId === null
          && trustedAutonomousManuscriptRenderReceipt?.formalSupportRegistryHash === null,
    },
  );
  if (!renderVerification.valid) {
    blockers.push(...renderVerification.blockers);
  }

  const claimUniverse = root
    ? readEmpiricalClaimUniverse({ sourceRoot: root, manuscriptPath }) : null;
  if (claimUniverse?.status !== 'empirical_claim_universe_verified'
    || claimUniverse?.empiricalClaimUniverseHash
      !== trustedAutonomousManuscriptRenderReceipt?.empiricalClaimUniverseHash) {
    blockers.push('trusted_autonomous_manuscript_revalidation_claim_universe_mismatch');
  }
  const derivedAuthorityEntries = Array.isArray(derivedAuthority?.entries)
    ? derivedAuthority.entries : [];
  if (derivedAuthority && !Array.isArray(derivedAuthority?.entries)) {
    blockers.push('trusted_autonomous_manuscript_revalidation_campaign_authority_invalid');
  }
  const expectedClaimHashes = new Map(derivedAuthorityEntries
    .map((entry) => [entry?.claimId, entry?.manuscriptClaimHash]));
  const claimUniverseClaims = Array.isArray(claimUniverse?.claims) ? claimUniverse.claims : [];
  if (claimUniverse && !Array.isArray(claimUniverse?.claims)) {
    blockers.push('trusted_autonomous_manuscript_revalidation_claim_universe_mismatch');
  }
  if (claimUniverseClaims.length !== expectedClaimHashes.size
    || claimUniverseClaims.some((claim) => (
      expectedClaimHashes.get(claim?.claimId) !== claim?.manuscriptClaimHash
    ))) {
    blockers.push('trusted_autonomous_manuscript_revalidation_claim_authority_mismatch');
  }

  const assertionUniverse = root
    && claimUniverse?.status === 'empirical_claim_universe_verified'
    && authorityRecords && manuscriptIrVerification?.valid === true
    ? readEmpiricalAssertionUniverse({
      sourceRoot: root,
      manuscriptPath,
      trustedEmpiricalClaimUniverse: claimUniverse,
      trustedFormalSupportAuthority: authorityRecords.formalSupportAuthority,
      trustedManuscriptIr: manuscriptIrRead.value,
      trustedManuscriptIrAgentExecutionReceipt: agentExecutionReceipt,
      trustedPriorArtReceipt: authorityRecords.priorArtReceipt,
    }) : null;
  const assertionBinding = derivedAuthority && assertionUniverse
    ? bindEmpiricalAssertionUniverse({
      authority: derivedAuthority,
      universe: assertionUniverse,
      expectedPaperId: paperId,
      expectedCampaignId: campaignId,
      expectedExperimentRegistryHash: derivedAuthority.experimentRegistryHash,
    }) : null;
  let presentationAuthority = null;
  try {
    presentationAuthority = derivedAuthority
      ? buildEmpiricalPresentationAuthority(derivedAuthority) : null;
  } catch {
    blockers.push('trusted_autonomous_manuscript_revalidation_presentation_authority_invalid');
  }
  if (assertionUniverse?.status !== 'empirical_assertion_universe_verified'
    || assertionUniverse?.empiricalAssertionUniverseHash
      !== trustedAutonomousManuscriptRenderReceipt?.empiricalAssertionUniverseHash) {
    blockers.push('trusted_autonomous_manuscript_revalidation_assertion_universe_mismatch');
  }
  if (assertionBinding?.status !== 'empirical_assertion_universe_binding_verified'
    || assertionBinding?.empiricalAssertionUniverseBindingHash
      !== trustedAutonomousManuscriptRenderReceipt?.empiricalAssertionUniverseBindingHash) {
    blockers.push('trusted_autonomous_manuscript_revalidation_assertion_binding_mismatch');
  }
  if (derivedAuthority?.empiricalAssertionAuthorityHash
      !== trustedAutonomousManuscriptRenderReceipt?.empiricalAssertionAuthorityHash
    || presentationAuthority?.empiricalPresentationAuthorityHash
      !== trustedAutonomousManuscriptRenderReceipt?.empiricalPresentationAuthorityHash) {
    blockers.push('trusted_autonomous_manuscript_revalidation_render_authority_mismatch');
  }
  const actualArtifacts = canonicalArtifacts(
    assertionUniverse?.presentationArtifacts,
    blockers,
  );
  const expectedArtifacts = canonicalArtifacts(presentationAuthority?.artifacts, blockers);
  const receiptArtifacts = canonicalArtifacts(
    trustedAutonomousManuscriptRenderReceipt?.presentationArtifacts,
    blockers,
    { reportMalformed: Boolean(trustedAutonomousManuscriptRenderReceipt) },
  );
  if (!equal(actualArtifacts, expectedArtifacts) || !equal(actualArtifacts, receiptArtifacts)) {
    blockers.push('trusted_autonomous_manuscript_revalidation_presentation_artifact_mismatch');
  }
  if (authorityRecords && (
    authorityRecords.formalSupportAuthority?.autonomousFormalSupportSurfaceAuthorityHash
      !== trustedAutonomousManuscriptRenderReceipt?.formalSupportSurfaceAuthorityHash
    || authorityRecords.formalSupportAuthority?.formalSupportRegistryHash
      !== trustedAutonomousManuscriptRenderReceipt?.formalSupportRegistryHash
    || authorityRecords.formalSupportAuthority?.formalSupportTemplateHash
      !== trustedAutonomousManuscriptRenderReceipt?.formalSupportTemplateHash
  )) {
    blockers.push('trusted_autonomous_manuscript_revalidation_formal_authority_mismatch');
  }
  if (trustedAutonomousManuscriptRenderReceipt?.evidenceEntailmentContractHash
      !== entailmentRead.value?.evidenceEntailmentContractHash
    || !equal(
      trustedAutonomousManuscriptRenderReceipt?.evidenceEntailmentContract,
      entailmentRead.value,
    )) {
    blockers.push('trusted_autonomous_manuscript_revalidation_entailment_receipt_mismatch');
  }

  const uniqueBlockers = Object.freeze([...new Set(blockers)]);
  const payload = {
    version: 1,
    kind: 'TrustedAutonomousManuscriptWorkspaceRevalidationReceipt',
    status: uniqueBlockers.length
      ? 'trusted_autonomous_manuscript_workspace_revalidation_blocked'
      : 'trusted_autonomous_manuscript_workspace_revalidation_verified',
    passed: uniqueBlockers.length === 0,
    paperId: paperId || null,
    campaignId: campaignId || null,
    manuscriptPath,
    manuscriptHash: manuscriptRead?.hash || null,
    trustedAutonomousManuscriptRenderReceiptHash:
      trustedAutonomousManuscriptRenderReceipt
        ?.trustedAutonomousManuscriptRenderReceiptHash || null,
    empiricalAssertionAuthorityHash:
      derivedAuthority?.empiricalAssertionAuthorityHash || null,
    empiricalClaimUniverseHash: claimUniverse?.empiricalClaimUniverseHash || null,
    empiricalAssertionUniverseHash:
      assertionUniverse?.empiricalAssertionUniverseHash || null,
    empiricalAssertionUniverseBindingHash:
      assertionBinding?.empiricalAssertionUniverseBindingHash || null,
    empiricalPresentationAuthorityHash:
      presentationAuthority?.empiricalPresentationAuthorityHash || null,
    presentationArtifacts: actualArtifacts,
    blockers: uniqueBlockers,
    externalActionPerformed: false,
  };
  return Object.freeze({
    ...payload,
    trustedAutonomousManuscriptWorkspaceRevalidationReceiptHash: hashRecord(
      'TrustedAutonomousManuscriptWorkspaceRevalidationReceipt',
      payload,
    ),
  });
}
