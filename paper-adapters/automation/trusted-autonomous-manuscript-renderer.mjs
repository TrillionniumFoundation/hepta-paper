import fs from 'node:fs';
import path from 'node:path';
import {
  autonomousFormalSupportMarkerDeclaration,
  autonomousFormalSupportSurfaceBody,
} from '../../paper-domain/automation/autonomous-formal-support-registry.mjs';
import {
  EVIDENCE_BOUND_MANUSCRIPT_IR_DRAFT_PATH,
  evidenceBoundManuscriptBlockBody,
  evidenceBoundManuscriptMarkerDeclaration,
  latexEscapeEvidenceBoundText,
  verifyEvidenceBoundManuscriptIr,
} from '../../paper-domain/research/evidence-bound-manuscript-ir.mjs';
import {
  buildEvidenceEntailmentContract,
  EVIDENCE_ENTAILMENT_CONTRACT_PATH,
  verifyEvidenceEntailmentContract,
} from '../../paper-domain/research/evidence-entailment-contract.mjs';
import { renderAutonomousEmpiricalClaimStatement } from '../../paper-domain/automation/autonomous-empirical-claim-lineage-contract.mjs';
import {
  bindEmpiricalAssertionUniverse,
  buildEmpiricalPresentationAuthority,
  empiricalPresentationArtifactContents,
  empiricalPresentationMarkerDeclaration,
  verifyEmpiricalAssertionAuthority,
} from '../../paper-domain/research/empirical-assertion-contract.mjs';
import {
  deriveEmpiricalClaimUniverseIdentity,
} from '../../paper-domain/research/empirical-claim-contract.mjs';
import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { isPathWithin } from '../../workflow-kernel/runtime/path-utils.mjs';
import {
  inspectScopedWriteTargetSync,
  readScopedFileSync,
} from '../../workflow-kernel/runtime/scoped-file-identity.mjs';
import { writeDurableTextSync } from '../runtime/durable-text-repository.mjs';
import { writeDurableJsonSync } from '../runtime/durable-json-repository.mjs';
import { readEmpiricalAssertionUniverse } from '../research-verify/empirical-assertion-universe-reader.mjs';
import { readEmpiricalClaimUniverse } from '../research-verify/empirical-claim-universe-reader.mjs';
import {
  autonomousManuscriptEvidenceSourceDocuments,
  finalizeAutonomousManuscriptIrInWorkspace,
} from './autonomous-manuscript-ir-materialization.mjs';
import {
  readVerifiedAutonomousManuscriptAuthorityRecords,
  VENUE_REQUIREMENT_IR_PATH,
} from './trusted-autonomous-manuscript-authority-reader.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const EMPIRICAL_LINEAGE_KEYS = Object.freeze([
  'version',
  'kind',
  'status',
  'paperId',
  'proposalHash',
  'seedBundleHash',
  'proposalClaimId',
  'scientificClaimKey',
  'proposalClaimRecordHash',
  'proposalClaimScope',
  'proposalClaimScopeHash',
  'statementRenderingPolicy',
  'manuscriptClaimText',
  'analysisProtocolTemplateHash',
  'empiricalClaimUniverseHash',
  'manuscriptCorpusHash',
  'protocolHypotheses',
  'autonomousEmpiricalClaimLineageHash',
]);
const EMPIRICAL_LINEAGE_HYPOTHESIS_KEYS = Object.freeze([
  'claimId',
  'manuscriptClaimHash',
  'proposalClaimRecordHash',
  'metric',
  'comparator',
  'alternative',
  'minimumEffect',
  'acceptanceRequired',
]);

export function analysisProtocolTemplateHashFromAuthorityArtifacts(root, authority) {
  const hashes = new Set();
  const inspected = new Set();
  for (const entry of authority.entries) {
    for (const evidence of [entry.original]) {
      const identity = `${evidence?.artifactPath || ''}:${evidence?.artifactHash || ''}`;
      if (inspected.has(identity)) continue;
      inspected.add(identity);
      const read = readScopedFileSync({
        scopeRoot: root,
        candidate: path.resolve(root, evidence?.artifactPath || ''),
      });
      if (read.status !== 'scoped_file_read_verified'
        || read.hash !== evidence?.artifactHash
        || read.bytes > 16 * 1024 * 1024) {
        throw new Error('trusted_autonomous_manuscript_analysis_protocol_template_authority_invalid');
      }
      let result;
      try { result = JSON.parse(read.content.toString('utf8')); }
      catch {
        throw new Error('trusted_autonomous_manuscript_analysis_protocol_template_authority_invalid');
      }
      const artifactTemplateHashes = [
        result?.operatorDatasetHarnessAuthority?.analysisProtocolHash,
        result?.operatorDatasetHarnessAuthority?.authority?.analysisProtocolHash,
        result?.datasetEvaluationDependencyReceipt?.analysisProtocolHash,
      ].filter((value) => value !== undefined && value !== null);
      if (!artifactTemplateHashes.length
        || artifactTemplateHashes.some((value) => !SHA256.test(String(value || '')))
        || new Set(artifactTemplateHashes).size !== 1) {
        throw new Error('trusted_autonomous_manuscript_analysis_protocol_template_authority_invalid');
      }
      hashes.add(artifactTemplateHashes[0]);
    }
  }
  if (hashes.size !== 1) {
    throw new Error('trusted_autonomous_manuscript_analysis_protocol_template_authority_invalid');
  }
  return [...hashes][0];
}

export function empiricalClaimsFromAuthority(
  authority,
  empiricalClaim,
  {
    empiricalClaimLineage = null,
    proposal = null,
    seedBundle = null,
    manuscriptPath = 'main.tex',
    analysisProtocolTemplateHash = null,
  } = {},
) {
  const proposalClaimRecordHash = hashRecord('AutonomousResearchClaimRecord', empiricalClaim);
  const byId = new Map();
  for (const entry of authority.entries) {
    if (entry.proposalClaimRecordHash !== proposalClaimRecordHash
      || !SHA256.test(String(entry.manuscriptClaimHash || ''))
      || !SHA256.test(String(entry.empiricalClaimUniverseHash || ''))
      || !SHA256.test(String(entry.analysisProtocolHash || ''))) {
      throw new Error('trusted_autonomous_manuscript_proposal_claim_binding_invalid');
    }
    const declaration = Object.freeze({
      claimId: entry.claimId,
      metric: entry.predicate.metric,
      comparator: entry.predicate.comparator,
      alternative: entry.predicate.alternative,
      minimumEffect: entry.predicate.minimumEffect,
      acceptanceRequired: entry.predicate.acceptanceRequired,
      proposalClaimRecordHash,
    });
    const existing = byId.get(entry.claimId);
    if (existing) throw new Error('trusted_autonomous_manuscript_claim_id_duplicate');
    byId.set(entry.claimId, Object.freeze({
      declaration,
      manuscriptClaimHash: entry.manuscriptClaimHash,
      empiricalClaimUniverseHash: entry.empiricalClaimUniverseHash,
    }));
  }
  if (!byId.size) throw new Error('trusted_autonomous_manuscript_claims_missing');
  const text = renderAutonomousEmpiricalClaimStatement(empiricalClaim.text);
  if (!empiricalClaimLineage) {
    if (byId.size !== 1) {
      throw new Error('trusted_autonomous_manuscript_empirical_claim_lineage_required');
    }
    return [...byId.values()].map(({ declaration }) => Object.freeze({ declaration, text }));
  }
  const {
    autonomousEmpiricalClaimLineageHash,
    ...lineagePayload
  } = empiricalClaimLineage;
  const proposalClaimScope = Object.freeze({
    statement: empiricalClaim.text,
    assumptions: empiricalClaim.assumptions,
    quantifiers: empiricalClaim.quantifiers,
    negativeBoundaries: empiricalClaim.negativeBoundaries,
    evidenceObligations: empiricalClaim.empiricalObligations,
  });
  if (!hasExactObjectKeys(empiricalClaimLineage, EMPIRICAL_LINEAGE_KEYS)
    || empiricalClaimLineage.version !== 1
    || empiricalClaimLineage.kind !== 'AutonomousEmpiricalClaimLineage'
    || empiricalClaimLineage.status !== 'autonomous_empirical_claim_lineage_bound'
    || !SHA256.test(String(autonomousEmpiricalClaimLineageHash || ''))
    || hashRecord('AutonomousEmpiricalClaimLineage', lineagePayload)
      !== autonomousEmpiricalClaimLineageHash
    || empiricalClaimLineage.paperId !== authority.paperId
    || (proposal && empiricalClaimLineage.proposalHash
      !== proposal.machineProposedScientificClaimSetHash)
    || (seedBundle && empiricalClaimLineage.seedBundleHash
      !== seedBundle.autonomousResearchSeedContractBundleHash)
    || empiricalClaimLineage.proposalClaimId !== empiricalClaim.id
    || empiricalClaimLineage.scientificClaimKey !== empiricalClaim.scientificClaimKey
    || empiricalClaimLineage.proposalClaimRecordHash !== proposalClaimRecordHash
    || hashRecord('AutonomousEmpiricalProposalClaimScope',
      empiricalClaimLineage.proposalClaimScope)
      !== empiricalClaimLineage.proposalClaimScopeHash
    || hashRecord('AutonomousEmpiricalProposalClaimScope',
      empiricalClaimLineage.proposalClaimScope)
      !== hashRecord('AutonomousEmpiricalProposalClaimScope', proposalClaimScope)
    || empiricalClaimLineage.statementRenderingPolicy
      !== 'deterministic-latex-source-escaping-v1'
    || empiricalClaimLineage.manuscriptClaimText !== text
    || !SHA256.test(String(empiricalClaimLineage.analysisProtocolTemplateHash || ''))
    || empiricalClaimLineage.analysisProtocolTemplateHash !== analysisProtocolTemplateHash
    || !SHA256.test(String(empiricalClaimLineage.empiricalClaimUniverseHash || ''))
    || !SHA256.test(String(empiricalClaimLineage.manuscriptCorpusHash || ''))
    || !Array.isArray(empiricalClaimLineage.protocolHypotheses)
    || !empiricalClaimLineage.protocolHypotheses.length) {
    throw new Error('trusted_autonomous_manuscript_empirical_claim_lineage_invalid');
  }
  const manuscriptContentHash = hashBytes(Buffer.from(text, 'utf8'));
  const orderedClaimCorpus = empiricalClaimLineage.protocolHypotheses.map((binding) => {
    if (!hasExactObjectKeys(binding, EMPIRICAL_LINEAGE_HYPOTHESIS_KEYS)
      || !SHA256.test(String(binding.manuscriptClaimHash || ''))
      || !SHA256.test(String(binding.proposalClaimRecordHash || ''))
      || !Number.isFinite(binding.minimumEffect)
      || typeof binding.acceptanceRequired !== 'boolean') {
      throw new Error('trusted_autonomous_manuscript_empirical_claim_lineage_binding_invalid');
    }
    return Object.freeze({
      claimId: binding.claimId,
      metric: binding.metric,
      comparator: binding.comparator,
      alternative: binding.alternative,
      minimumEffect: binding.minimumEffect,
      acceptanceRequired: binding.acceptanceRequired,
      proposalClaimRecordHash: binding.proposalClaimRecordHash,
      manuscriptPath,
      manuscriptContentHash,
    });
  });
  const empiricalClaimIdentity = deriveEmpiricalClaimUniverseIdentity({
    manuscriptPath,
    claims: orderedClaimCorpus,
  });
  const {
    manuscriptCorpusHash,
    claimIdentities: derivedClaims,
    empiricalClaimUniverseHash,
  } = empiricalClaimIdentity;
  if (manuscriptCorpusHash !== empiricalClaimLineage.manuscriptCorpusHash
    || empiricalClaimUniverseHash !== empiricalClaimLineage.empiricalClaimUniverseHash) {
    throw new Error('trusted_autonomous_manuscript_empirical_claim_lineage_identity_invalid');
  }
  const seen = new Set();
  const ordered = empiricalClaimLineage.protocolHypotheses.map((binding, index) => {
    const record = byId.get(binding?.claimId);
    const derived = derivedClaims[index];
    if (!record || seen.has(binding.claimId)
      || binding.manuscriptClaimHash !== derived.manuscriptClaimHash
      || binding.manuscriptClaimHash !== record.manuscriptClaimHash
      || record.empiricalClaimUniverseHash !== empiricalClaimUniverseHash
      || binding.proposalClaimRecordHash !== record.declaration.proposalClaimRecordHash
      || binding.metric !== record.declaration.metric
      || binding.comparator !== record.declaration.comparator
      || binding.alternative !== record.declaration.alternative
      || Number(binding.minimumEffect) !== Number(record.declaration.minimumEffect)
      || binding.acceptanceRequired !== record.declaration.acceptanceRequired) {
      throw new Error('trusted_autonomous_manuscript_empirical_claim_lineage_binding_invalid');
    }
    seen.add(binding.claimId);
    return Object.freeze({
      declaration: record.declaration,
      text: empiricalClaimLineage.manuscriptClaimText,
    });
  });
  if (seen.size !== byId.size) {
    throw new Error('trusted_autonomous_manuscript_empirical_claim_lineage_bijection_invalid');
  }
  return Object.freeze(ordered);
}

function assertionBlock(entry) {
  const declaration = {
    version: 1,
    assertionId: entry.assertionId,
    authorityEntryHash: entry.empiricalAssertionAuthorityEntryHash,
  };
  return [
    `% HEPTA_EMPIRICAL_ASSERTION_BEGIN ${JSON.stringify(declaration)}`,
    entry.canonicalManuscriptBody,
    `% HEPTA_EMPIRICAL_ASSERTION_END ${entry.assertionId}`,
  ];
}

function presentationBlock(entry) {
  const declaration = empiricalPresentationMarkerDeclaration(entry);
  return [
    `% HEPTA_EMPIRICAL_PRESENTATION_BEGIN ${JSON.stringify(declaration)}`,
    entry.canonicalManuscriptBody,
    `% HEPTA_EMPIRICAL_PRESENTATION_END ${entry.surfaceId}`,
  ];
}

function formalSupportBlock(authority) {
  const declaration = autonomousFormalSupportMarkerDeclaration(authority);
  return [
    `% HEPTA_FORMAL_SUPPORT_BEGIN ${JSON.stringify(declaration)}`,
    autonomousFormalSupportSurfaceBody(authority),
    `% HEPTA_FORMAL_SUPPORT_END ${declaration.surfaceId}`,
  ];
}

function evidenceBoundProseBlock(block, priorArtReceipt) {
  const declaration = evidenceBoundManuscriptMarkerDeclaration(block);
  return [
    `% HEPTA_EVIDENCE_BOUND_PROSE_BEGIN ${JSON.stringify(declaration)}`,
    evidenceBoundManuscriptBlockBody(block, { priorArtReceipt }),
    `% HEPTA_EVIDENCE_BOUND_PROSE_END ${declaration.blockId}`,
  ];
}

function preparePresentationArtifactTarget(root, artifactPath) {
  const destination = path.resolve(root, artifactPath);
  const before = inspectScopedWriteTargetSync({ scopeRoot: root, candidate: destination });
  if (!isPathWithin(root, destination) || before.status !== 'scoped_write_target_verified') {
    throw new Error('trusted_autonomous_manuscript_presentation_artifact_path_invalid');
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  const after = inspectScopedWriteTargetSync({ scopeRoot: root, candidate: destination });
  if (after.status !== 'scoped_write_target_verified') {
    throw new Error('trusted_autonomous_manuscript_presentation_artifact_path_invalid');
  }
  return destination;
}

function renderSource({
  manuscriptIr,
  claims,
  formalSupportAuthority,
  authority,
  presentationAuthority,
  priorArtReceipt,
  venueProfileSelection,
  venueRequirementIr,
  venueTemplateAsset,
  submissionMetadataReceipt,
}) {
  const claimLines = claims.flatMap(({ declaration, text }) => [
    `% HEPTA_EMPIRICAL_CLAIM_BEGIN ${JSON.stringify(declaration)}`,
    text,
    `% HEPTA_EMPIRICAL_CLAIM_END ${declaration.claimId}`,
  ]);
  let appendixStarted = false;
  const sectionLines = manuscriptIr.sections.flatMap((section) => {
    const formalProofSupplement = /(?:formal[\s_-]+proof[\s_-]+supplement|appendix)/iu.test(
      `${section.sectionId || ''} ${section.heading || ''}`,
    );
    const appendixPrefix = formalProofSupplement && !appendixStarted ? ['\\appendix'] : [];
    if (formalProofSupplement) appendixStarted = true;
    return [
    ...appendixPrefix,
    `\\section{${latexEscapeEvidenceBoundText(section.heading)}}`,
    ...section.blocks.flatMap((block) => {
      if (block.type !== 'slot') return evidenceBoundProseBlock(block, priorArtReceipt);
      if (block.slot === 'empirical_claims') return claimLines;
      if (block.slot === 'formal_support') return formalSupportBlock(formalSupportAuthority);
      if (block.slot === 'empirical_results') return [
        ...authority.entries.flatMap(assertionBlock),
        ...presentationAuthority.entries.flatMap(presentationBlock),
      ];
      throw new Error(`trusted_autonomous_manuscript_slot_unsupported:${block.slot}`);
    }),
    ];
  });
  const bibliographyStyle = venueProfileSelection?.profile?.bibliographyStyle
    || 'inline-evidence-v1';
  const citationStyle = venueProfileSelection?.profile?.citationStyle
    || 'evidence-inline-v1';
  const metadataProfile = submissionMetadataReceipt?.profile || null;
  const authors = metadataProfile?.authors || [];
  const anonymousReview = venueRequirementIr?.anonymousReview === true;
  const automatedAuthorshipDisclosureRequired = (
    venueRequirementIr?.disclosureRequirements || []
  ).some((requirement) => (
    /(?:automated|autonomous|machine|\bai\b|model).*(?:author|authorship|use)/iu
      .test(String(requirement || ''))
    || /(?:author|authorship).*(?:automated|autonomous|machine|\bai\b|model)/iu
      .test(String(requirement || ''))
  ));
  const authorLine = anonymousReview
    ? '\\author{Anonymous submission}'
    : authors.length
    ? `\\author{${authors.map((author) => (
      latexEscapeEvidenceBoundText(author.displayName)
    )).join(' \\and ')}}`
    : '\\author{}';
  const submissionMetadataLines = metadataProfile ? [
    '\\section*{Keywords}',
    submissionMetadataReceipt.keywords
      .map((keyword) => latexEscapeEvidenceBoundText(keyword)).join('; '),
    ...(!anonymousReview ? [
      '\\section*{Author affiliations}',
      ...authors.map((author) => `${latexEscapeEvidenceBoundText(author.displayName)}: ${
        author.affiliations.map((value) => latexEscapeEvidenceBoundText(value)).join('; ')
      }`),
    ] : []),
    ...(automatedAuthorshipDisclosureRequired ? [
      '\\section*{Automated authorship and model use}',
      'This manuscript was produced by the registered autonomous research system and its bound model executions.',
    ] : []),
    '\\section*{Conflict of interest}',
    latexEscapeEvidenceBoundText(metadataProfile.conflictOfInterestStatement),
    '\\section*{Funding}',
    latexEscapeEvidenceBoundText(metadataProfile.fundingStatement),
    '\\section*{Data availability}',
    latexEscapeEvidenceBoundText(metadataProfile.dataAvailabilityStatement),
    '\\section*{Code availability}',
    latexEscapeEvidenceBoundText(metadataProfile.codeAvailabilityStatement),
  ] : [];
  return [
    `\\documentclass[11pt]{${venueProfileSelection?.profile?.documentClass || 'article'}}`,
    ...(venueTemplateAsset ? [`\\input{${venueTemplateAsset.relativePath}}`] : []),
    `% HEPTA_BIBLIOGRAPHY_STYLE ${bibliographyStyle}`,
    `% HEPTA_CITATION_STYLE ${citationStyle}`,
    '\\usepackage{amsmath,amssymb,amsthm,graphicx}',
    '\\newtheorem{theorem}{Theorem}',
    `\\title{${latexEscapeEvidenceBoundText(manuscriptIr.title)}}`,
    authorLine,
    '\\date{}',
    '\\begin{document}',
    '\\maketitle',
    ...sectionLines,
    ...submissionMetadataLines,
    '\\end{document}',
    '',
  ].join('\n');
}

export function renderTrustedAutonomousManuscript({
  workspace,
  manuscriptPath = 'main.tex',
  paperId,
  campaignId,
  authority,
  formalVerificationReceipt = null,
  agentExecutionReceipt = null,
  agentExecutionReceipts = [],
  requireAgentAuthoredProse = false,
  manuscriptProductionMode = requireAgentAuthoredProse
    ? 'agent-authored-evidence-bound-ir-v1'
    : 'minimal-report-evidence-bound-ir-v1',
} = {}) {
  if (!['agent-authored-evidence-bound-ir-v1', 'minimal-report-evidence-bound-ir-v1']
    .includes(manuscriptProductionMode)
    || requireAgentAuthoredProse
      !== (manuscriptProductionMode === 'agent-authored-evidence-bound-ir-v1')) {
    throw new Error('trusted_autonomous_manuscript_production_mode_invalid');
  }
  const root = fs.realpathSync(path.resolve(workspace || ''));
  const manuscript = path.resolve(root, manuscriptPath);
  const existing = readScopedFileSync({ scopeRoot: root, candidate: manuscript });
  const authorityVerification = verifyEmpiricalAssertionAuthority(authority, { paperId, campaignId });
  if (existing.status !== 'scoped_file_read_verified' || !isPathWithin(root, manuscript)
    || !authorityVerification.valid) {
    throw new Error('trusted_autonomous_manuscript_render_input_invalid');
  }
  const {
    proposal,
    policyAuthorization,
    seedBundle,
    empiricalClaim,
    formalSupportAuthority,
    priorArtReceipt,
    empiricalClaimLineage,
    venueProfileSelection,
    venueRequirementIr,
    venueRequirementIrFileHash,
    venueTemplateAsset,
    venueTemplateAssetFileHash,
    submissionMetadataReceipt,
  } = readVerifiedAutonomousManuscriptAuthorityRecords(
    root,
    formalVerificationReceipt,
  );
  const claims = empiricalClaimsFromAuthority(authority, empiricalClaim, {
    empiricalClaimLineage,
    proposal,
    seedBundle,
    manuscriptPath,
    analysisProtocolTemplateHash: empiricalClaimLineage
      ? analysisProtocolTemplateHashFromAuthorityArtifacts(root, authority) : null,
  });
  const presentationAuthority = buildEmpiricalPresentationAuthority(authority);
  const presentationArtifacts = empiricalPresentationArtifactContents(authority);
  const manuscriptIrFinalization = finalizeAutonomousManuscriptIrInWorkspace({
    workspace: root,
    proposal,
    policyAuthorization,
    seedBundle,
    priorArtReceipt,
    empiricalClaimLineage,
    empiricalAssertionAuthority: authority,
    formalSupportAuthority,
    formalVerificationReceipt,
    agentExecutionReceipt,
    agentExecutionReceipts,
    requireAgentAuthoredProse,
  });
  const manuscriptIr = manuscriptIrFinalization.ir;
  const selectedAgentExecutionReceipt = manuscriptIrFinalization.agentExecutionReceipt;
  const substantiveProseInspection = manuscriptIrFinalization.substantiveProseInspection;
  const manuscriptIrVerification = verifyEvidenceBoundManuscriptIr(manuscriptIr, {
    paperId,
    authorityBindings: manuscriptIrFinalization.authorityBindings,
    priorArtReceipt,
    agentExecutionReceipt: selectedAgentExecutionReceipt,
    sourceDraftFileHash: manuscriptIrFinalization.sourceDraftFileHash,
    requireAgentAuthoredProse,
  });
  if (!manuscriptIrVerification.valid) {
    throw new Error(`trusted_autonomous_manuscript_ir_invalid:${manuscriptIrVerification.blockers.join(',')}`);
  }
  const sourceEvidenceDocuments = autonomousManuscriptEvidenceSourceDocuments({
    proposal,
    policyAuthorization,
    seedBundle,
    empiricalClaimLineage,
    empiricalAssertionAuthority: authority,
    formalSupportAuthority,
    formalVerificationReceipt,
    priorArtReceipt,
  });
  const evidenceEntailmentContract = buildEvidenceEntailmentContract({
    manuscriptIr,
    sourceEvidenceDocuments,
  });
  const evidenceEntailmentVerification = verifyEvidenceEntailmentContract(
    evidenceEntailmentContract,
    {
      paperId,
      evidenceBoundManuscriptIrHash: manuscriptIr.evidenceBoundManuscriptIrHash,
    },
  );
  if (!evidenceEntailmentVerification.valid) {
    throw new Error(`trusted_autonomous_manuscript_entailment_invalid:${
      evidenceEntailmentVerification.blockers.join(',')}`);
  }
  const evidenceEntailmentPath = path.resolve(root, EVIDENCE_ENTAILMENT_CONTRACT_PATH);
  if (!isPathWithin(root, evidenceEntailmentPath)) {
    throw new Error('trusted_autonomous_manuscript_entailment_path_invalid');
  }
  writeDurableJsonSync(evidenceEntailmentPath, evidenceEntailmentContract);
  const source = renderSource({
    manuscriptIr,
    claims,
    formalSupportAuthority,
    authority,
    presentationAuthority,
    priorArtReceipt,
    venueProfileSelection,
    venueRequirementIr,
    venueTemplateAsset,
    submissionMetadataReceipt,
  });
  for (const artifact of presentationArtifacts) {
    const destination = preparePresentationArtifactTarget(root, artifact.path);
    writeDurableTextSync(destination, artifact.content);
  }
  writeDurableTextSync(manuscript, source);
  const claimUniverse = readEmpiricalClaimUniverse({ sourceRoot: root, manuscriptPath });
  const assertionUniverse = readEmpiricalAssertionUniverse({
    sourceRoot: root,
    manuscriptPath,
    trustedEmpiricalClaimUniverse: claimUniverse,
    trustedFormalSupportAuthority: formalSupportAuthority,
    trustedManuscriptIr: manuscriptIr,
    trustedManuscriptIrAgentExecutionReceipt: selectedAgentExecutionReceipt,
    trustedPriorArtReceipt: priorArtReceipt,
  });
  const assertionBinding = bindEmpiricalAssertionUniverse({
    authority,
    universe: assertionUniverse,
    expectedPaperId: paperId,
    expectedCampaignId: campaignId,
    expectedExperimentRegistryHash: authority.experimentRegistryHash,
  });
  const expectedClaimHashes = new Map(authority.entries.map((entry) => [entry.claimId, entry.manuscriptClaimHash]));
  const renderVerificationBlockers = [
    ...claimUniverse.blockers,
    ...assertionUniverse.blockers,
    ...assertionBinding.blockers,
  ];
  if (claimUniverse.status !== 'empirical_claim_universe_verified') {
    renderVerificationBlockers.push('empirical_claim_universe_status_invalid');
  }
  if (claimUniverse.claims.length !== expectedClaimHashes.size) {
    renderVerificationBlockers.push('empirical_claim_universe_authority_count_mismatch');
  }
  for (const claim of claimUniverse.claims) {
    if (!expectedClaimHashes.has(claim.claimId)) {
      renderVerificationBlockers.push(`empirical_claim_universe_authority_claim_missing:${claim.claimId}`);
    } else if (expectedClaimHashes.get(claim.claimId) !== claim.manuscriptClaimHash) {
      renderVerificationBlockers.push(`empirical_claim_universe_authority_hash_mismatch:${claim.claimId}`);
    }
  }
  if (assertionUniverse.status !== 'empirical_assertion_universe_verified') {
    renderVerificationBlockers.push('empirical_assertion_universe_status_invalid');
  }
  if (assertionUniverse.trustedFormalSupportAuthorityHash
    !== formalSupportAuthority.autonomousFormalSupportSurfaceAuthorityHash) {
    renderVerificationBlockers.push('autonomous_formal_support_authority_hash_mismatch');
  }
  if (assertionUniverse.formalSupports.length !== 1) {
    renderVerificationBlockers.push('autonomous_formal_support_surface_count_mismatch');
  }
  if (assertionBinding.status !== 'empirical_assertion_universe_binding_verified') {
    renderVerificationBlockers.push('empirical_assertion_universe_binding_status_invalid');
  }
  if (assertionBinding.empiricalPresentationAuthorityHash
    !== presentationAuthority.empiricalPresentationAuthorityHash) {
    renderVerificationBlockers.push('empirical_presentation_authority_hash_mismatch');
  }
  if (assertionBinding.presentationBindings.length !== presentationAuthority.entryCount) {
    renderVerificationBlockers.push('empirical_presentation_authority_count_mismatch');
  }
  const uniqueRenderVerificationBlockers = [...new Set(renderVerificationBlockers)];
  if (uniqueRenderVerificationBlockers.length) {
    throw new Error(`trusted_autonomous_manuscript_render_verification_failed:${
      uniqueRenderVerificationBlockers.join(',')}`);
  }
  const manuscriptIrFileHash = hashBytes(fs.readFileSync(
    path.resolve(root, manuscriptIrFinalization.irPath || 'AUTONOMOUS_MANUSCRIPT_IR.json'),
  ));
  const manuscriptIrDraftFileHash = hashBytes(fs.readFileSync(
    path.resolve(root, EVIDENCE_BOUND_MANUSCRIPT_IR_DRAFT_PATH),
  ));
  const evidenceEntailmentContractFileHash = hashBytes(
    fs.readFileSync(evidenceEntailmentPath),
  );
  const payload = {
    version: 6,
    kind: 'TrustedAutonomousManuscriptRenderReceipt',
    status: 'trusted_autonomous_manuscript_rendered',
    paperId,
    campaignId,
    manuscriptPath,
    priorManuscriptHash: existing.hash,
    manuscriptHash: hashBytes(Buffer.from(source, 'utf8')),
    seedBundleHash: seedBundle.autonomousResearchSeedContractBundleHash,
    priorArtEvidenceReceiptHash: priorArtReceipt.priorArtEvidenceReceiptHash,
    evidenceBoundManuscriptIrHash: manuscriptIr.evidenceBoundManuscriptIrHash,
    manuscriptIrFileHash,
    manuscriptIrPath: 'AUTONOMOUS_MANUSCRIPT_IR.json',
    authorityBindingSetHash: manuscriptIr.authorityBindingSetHash,
    evidenceEntailmentContractHash:
      evidenceEntailmentContract.evidenceEntailmentContractHash,
    evidenceEntailmentContract,
    evidenceEntailmentContractPath: EVIDENCE_ENTAILMENT_CONTRACT_PATH,
    evidenceEntailmentContractFileHash,
    typedEvidenceEntailmentBlockCount: evidenceEntailmentContract.blockCount,
    typedEvidenceSourceDocumentCount:
      evidenceEntailmentContract.sourceEvidenceDocumentCount,
    machineEvidenceVerificationScope:
      evidenceEntailmentContract.machineVerificationScope,
    untypedRenderedBlockCount: evidenceEntailmentContract.untypedRenderedBlockCount,
    formalSupportRegistryHash: formalSupportAuthority.formalSupportRegistryHash,
    formalSupportTemplateId: formalSupportAuthority.formalSupportTemplateId,
    formalSupportTemplateHash: formalSupportAuthority.formalSupportTemplateHash,
    formalSupportSurfaceAuthorityHash:
      formalSupportAuthority.autonomousFormalSupportSurfaceAuthorityHash,
    formalSupportSurfaceHash: assertionUniverse.formalSupports[0].formalSupportSurfaceHash,
    productionReadableProofExplanationReady:
      formalSupportAuthority.productionReadableProofReady === true,
    formalReadableProofExplanationBundleHash:
      formalSupportAuthority.readableProofExplanationBundleHash || null,
    formalReadableProofExplanationHash:
      formalSupportAuthority.readableProofExplanationHash || null,
    formalReadableProofExplanationDagHash:
      formalSupportAuthority.readableProofExplanationDagHash || null,
    empiricalAssertionAuthorityHash: authority.empiricalAssertionAuthorityHash,
    empiricalClaimUniverseHash: claimUniverse.empiricalClaimUniverseHash,
    empiricalAssertionUniverseHash: assertionUniverse.empiricalAssertionUniverseHash,
    empiricalAssertionUniverseBindingHash: assertionBinding.empiricalAssertionUniverseBindingHash,
    empiricalPresentationAuthorityHash: presentationAuthority.empiricalPresentationAuthorityHash,
    presentationArtifacts: presentationAuthority.artifacts,
    sectionModel: 'evidence-bound-manuscript-ir-v1',
    manuscriptProductionMode,
    requireAgentAuthoredProse,
    renderedSections: Object.freeze(manuscriptIr.sections.map((section) => section.heading)),
    agentAuthoredRenderedProseAccepted: manuscriptIr.authorship.agentModifiedDraft === true
      && (!requireAgentAuthoredProse || substantiveProseInspection?.valid === true),
    agentAuthoredRenderedProseReceiptHash:
      manuscriptIr.authorship.agentExecutionReceiptHash,
    agentAuthoredSourceDraft: manuscriptIr.authorship.agentModifiedDraft === true
      ? manuscriptIrFinalization.agentDraft : null,
    agentAuthoredSourceDraftHash: manuscriptIr.authorship.agentModifiedDraft === true
      ? manuscriptIr.authorship.sourceDraftHash : null,
    agentAuthoredSourceDraftFileHash: manuscriptIr.authorship.agentModifiedDraft === true
      ? manuscriptIrDraftFileHash : null,
    agentWorkspacePostimageBindingHash: manuscriptIr.authorship.agentModifiedDraft === true
      ? manuscriptIr.authorship.agentWorkspacePostimageBindingHash : null,
    systemSeedManuscriptIrDraft: manuscriptIr.authorship.agentModifiedDraft === true
      ? manuscriptIrFinalization.systemSeedDraft : null,
    systemSeedManuscriptIrDraftHash: manuscriptIr.authorship.agentModifiedDraft === true
      ? substantiveProseInspection?.systemSeedDraftHash || null : null,
    substantiveAgentProseInspection: manuscriptIr.authorship.agentModifiedDraft === true
      ? substantiveProseInspection : null,
    substantiveAgentProseVerified: substantiveProseInspection?.valid === true,
    substantiveAgentProseInspectionHash:
      substantiveProseInspection
        ?.autonomousManuscriptSubstantiveAgentProseInspectionHash || null,
    substantivelyRewrittenSectionCount:
      substantiveProseInspection?.substantivelyRewrittenSectionCount || 0,
    substantivelyRewrittenBlockCount:
      substantiveProseInspection?.substantivelyRewrittenBlockCount || 0,
    venueProfileSelectionHash:
      venueProfileSelection?.autonomousVenueProfileSelectionReceiptHash || null,
    venueRequirementIrHash: venueRequirementIr?.venueRequirementIrHash || null,
    venueRequirementIrFileHash,
    venueRequirementIrPath: venueRequirementIr ? VENUE_REQUIREMENT_IR_PATH : null,
    anonymousReviewApplied: venueRequirementIr?.anonymousReview === true,
    venueTemplateAssetApplicationMode: venueTemplateAsset?.applicationMode || null,
    venueTemplateAssetPath: venueTemplateAsset?.relativePath || null,
    venueTemplateAssetHash: venueTemplateAsset?.templateAssetHash || null,
    venueTemplateAssetFileHash,
    submissionMetadataReceiptHash:
      submissionMetadataReceipt?.autonomousSubmissionMetadataReceiptHash || null,
    bibliographyStyle: venueProfileSelection?.profile?.bibliographyStyle
      || 'inline-evidence-v1',
    citationStyle: venueProfileSelection?.profile?.citationStyle
      || 'evidence-inline-v1',
    unboundScientificProseAccepted: false,
    externalActionPerformed: false,
  };
  return Object.freeze({
    ...payload,
    trustedAutonomousManuscriptRenderReceiptHash:
      hashRecord('TrustedAutonomousManuscriptRenderReceipt', payload),
  });
}
