import fs from 'node:fs';
import path from 'node:path';
import {
  verifyMachineProposedScientificClaimSet,
} from '../../paper-domain/automation/autonomous-research-proposal-contract.mjs';
import {
  autonomousFormalSupportMarkerDeclaration,
  autonomousFormalSupportSurfaceBody,
  buildAutonomousFormalSupportSurfaceAuthority,
} from '../../paper-domain/automation/autonomous-formal-support-registry.mjs';
import {
  buildAutonomousResearchSeedContractBundle,
  verifyAutonomousResearchPolicyAuthorization,
} from '../../paper-domain/automation/autonomous-research-policy-contract.mjs';
import {
  TRUSTED_AUTONOMOUS_MANUSCRIPT_PROSE,
  TRUSTED_AUTONOMOUS_MANUSCRIPT_SECTIONS,
  TRUSTED_AUTONOMOUS_MANUSCRIPT_TITLE,
} from '../../paper-domain/automation/trusted-autonomous-manuscript-prose.mjs';
import { renderAutonomousEmpiricalClaimStatement } from '../../paper-domain/automation/autonomous-empirical-claim-lineage-contract.mjs';
import {
  bindEmpiricalAssertionUniverse,
  buildEmpiricalPresentationAuthority,
  empiricalPresentationArtifactContents,
  empiricalPresentationMarkerDeclaration,
  verifyEmpiricalAssertionAuthority,
} from '../../paper-domain/research/empirical-assertion-contract.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { isPathWithin } from '../../workflow-kernel/runtime/path-utils.mjs';
import {
  inspectScopedWriteTargetSync,
  readScopedFileSync,
} from '../../workflow-kernel/runtime/scoped-file-identity.mjs';
import { writeDurableTextSync } from '../runtime/durable-text-repository.mjs';
import { readEmpiricalAssertionUniverse } from '../research-verify/empirical-assertion-universe-reader.mjs';
import { readEmpiricalClaimUniverse } from '../research-verify/empirical-claim-universe-reader.mjs';

const PROPOSAL_PATH = 'AUTONOMOUS_RESEARCH_PROPOSAL.json';
const POLICY_PATH = 'AUTONOMOUS_RESEARCH_POLICY_AUTHORIZATION.json';
const SEED_PATH = 'AUTONOMOUS_RESEARCH_SEED_CONTRACTS.json';

function readJson(root, relative) {
  const read = readScopedFileSync({ scopeRoot: root, candidate: path.join(root, relative) });
  if (read.status !== 'scoped_file_read_verified' || read.bytes > 4 * 1024 * 1024) {
    throw new Error(`trusted_autonomous_manuscript_source_invalid:${relative}`);
  }
  try { return JSON.parse(read.content.toString('utf8')); }
  catch { throw new Error(`trusted_autonomous_manuscript_json_invalid:${relative}`); }
}

function verifiedAuthorityRecords(root) {
  const proposal = readJson(root, PROPOSAL_PATH);
  const policyAuthorization = readJson(root, POLICY_PATH);
  const seedBundle = readJson(root, SEED_PATH);
  const proposalVerification = verifyMachineProposedScientificClaimSet(proposal);
  const policyVerification = verifyAutonomousResearchPolicyAuthorization(policyAuthorization, { proposal });
  const rebuiltSeed = buildAutonomousResearchSeedContractBundle({
    proposal,
    policyAuthorization,
    evidencePlan: seedBundle.evidence,
    reproducibilityPlan: seedBundle.reproducibility,
    createdAt: seedBundle.createdAt,
  });
  if (!proposalVerification.valid || !policyVerification.valid
    || rebuiltSeed.autonomousResearchSeedContractBundleHash
      !== seedBundle.autonomousResearchSeedContractBundleHash
    || JSON.stringify(rebuiltSeed) !== JSON.stringify(seedBundle)) {
    throw new Error('trusted_autonomous_manuscript_seed_authority_invalid');
  }
  const empiricalClaims = seedBundle.claims.filter((claim) => claim.verificationMode === 'empirical_protocol');
  const formalClaims = seedBundle.claims.filter((claim) => claim.verificationMode === 'formal_kernel');
  if (empiricalClaims.length !== 1 || formalClaims.length !== 1) {
    throw new Error('trusted_autonomous_manuscript_claim_authority_invalid');
  }
  const formalSupportAuthority = buildAutonomousFormalSupportSurfaceAuthority({ proposal, seedBundle });
  return {
    seedBundle,
    empiricalClaim: empiricalClaims[0],
    formalSupportAuthority,
  };
}

function empiricalClaimsFromAuthority(authority, empiricalClaim) {
  const proposalClaimRecordHash = hashRecord('AutonomousResearchClaimRecord', empiricalClaim);
  const byId = new Map();
  for (const entry of authority.entries) {
    if (entry.proposalClaimRecordHash !== proposalClaimRecordHash) {
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
    if (existing && JSON.stringify(existing) !== JSON.stringify(declaration)) {
      throw new Error('trusted_autonomous_manuscript_claim_declaration_conflict');
    }
    if (!existing) byId.set(entry.claimId, declaration);
  }
  if (!byId.size) throw new Error('trusted_autonomous_manuscript_claims_missing');
  const text = renderAutonomousEmpiricalClaimStatement(empiricalClaim.text);
  return [...byId.values()].map((declaration) => Object.freeze({ declaration, text }));
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
  claims,
  formalSupportAuthority,
  authority,
  presentationAuthority,
}) {
  const claimLines = claims.flatMap(({ declaration, text }) => [
    `% HEPTA_EMPIRICAL_CLAIM_BEGIN ${JSON.stringify(declaration)}`,
    text,
    `% HEPTA_EMPIRICAL_CLAIM_END ${declaration.claimId}`,
  ]);
  return [
    '\\documentclass[11pt]{article}',
    '\\usepackage{amsmath,amssymb,amsthm,graphicx}',
    '\\newtheorem{theorem}{Theorem}',
    `\\title{${TRUSTED_AUTONOMOUS_MANUSCRIPT_TITLE}}`,
    '\\author{}',
    '\\date{}',
    '\\begin{document}',
    '\\maketitle',
    '\\section{Abstract}',
    TRUSTED_AUTONOMOUS_MANUSCRIPT_PROSE.abstract,
    '\\section{Research scope}',
    TRUSTED_AUTONOMOUS_MANUSCRIPT_PROSE.scope,
    '\\section{Related-work boundary}',
    TRUSTED_AUTONOMOUS_MANUSCRIPT_PROSE.relatedWork,
    '\\section{Methods}',
    TRUSTED_AUTONOMOUS_MANUSCRIPT_PROSE.methods,
    '\\section{Preregistered claims}',
    ...claimLines,
    '\\section{Formal assurance}',
    TRUSTED_AUTONOMOUS_MANUSCRIPT_PROSE.formal,
    ...formalSupportBlock(formalSupportAuthority),
    '\\section{Results}',
    ...authority.entries.flatMap(assertionBlock),
    ...presentationAuthority.entries.flatMap(presentationBlock),
    '\\section{Discussion}',
    TRUSTED_AUTONOMOUS_MANUSCRIPT_PROSE.discussion,
    '\\section{Reproducibility and audit trail}',
    TRUSTED_AUTONOMOUS_MANUSCRIPT_PROSE.reproducibility,
    '\\section{Limitations}',
    TRUSTED_AUTONOMOUS_MANUSCRIPT_PROSE.limitations,
    '\\section{Conclusion}',
    TRUSTED_AUTONOMOUS_MANUSCRIPT_PROSE.conclusion,
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
} = {}) {
  const root = fs.realpathSync(path.resolve(workspace || ''));
  const manuscript = path.resolve(root, manuscriptPath);
  const existing = readScopedFileSync({ scopeRoot: root, candidate: manuscript });
  const authorityVerification = verifyEmpiricalAssertionAuthority(authority, { paperId, campaignId });
  if (existing.status !== 'scoped_file_read_verified' || !isPathWithin(root, manuscript)
    || !authorityVerification.valid) {
    throw new Error('trusted_autonomous_manuscript_render_input_invalid');
  }
  const {
    seedBundle,
    empiricalClaim,
    formalSupportAuthority,
  } = verifiedAuthorityRecords(root);
  const claims = empiricalClaimsFromAuthority(authority, empiricalClaim);
  const presentationAuthority = buildEmpiricalPresentationAuthority(authority);
  const presentationArtifacts = empiricalPresentationArtifactContents(authority);
  const source = renderSource({
    claims,
    formalSupportAuthority,
    authority,
    presentationAuthority,
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
  });
  const assertionBinding = bindEmpiricalAssertionUniverse({
    authority,
    universe: assertionUniverse,
    expectedPaperId: paperId,
    expectedCampaignId: campaignId,
    expectedExperimentRegistryHash: authority.experimentRegistryHash,
  });
  const expectedClaimHashes = new Map(authority.entries.map((entry) => [entry.claimId, entry.manuscriptClaimHash]));
  if (claimUniverse.status !== 'empirical_claim_universe_verified'
    || claimUniverse.claims.length !== expectedClaimHashes.size
    || claimUniverse.claims.some((claim) => expectedClaimHashes.get(claim.claimId) !== claim.manuscriptClaimHash)
    || assertionUniverse.status !== 'empirical_assertion_universe_verified'
    || assertionUniverse.trustedFormalSupportAuthorityHash
      !== formalSupportAuthority.autonomousFormalSupportSurfaceAuthorityHash
    || assertionUniverse.formalSupports.length !== 1
    || assertionBinding.status !== 'empirical_assertion_universe_binding_verified'
    || assertionBinding.empiricalPresentationAuthorityHash
      !== presentationAuthority.empiricalPresentationAuthorityHash
    || assertionBinding.presentationBindings.length !== presentationAuthority.entryCount) {
    throw new Error(`trusted_autonomous_manuscript_render_verification_failed:${[
      ...claimUniverse.blockers, ...assertionUniverse.blockers, ...assertionBinding.blockers,
    ].join(',')}`);
  }
  const payload = {
    version: 2,
    kind: 'TrustedAutonomousManuscriptRenderReceipt',
    status: 'trusted_autonomous_manuscript_rendered',
    paperId,
    campaignId,
    manuscriptPath,
    priorManuscriptHash: existing.hash,
    manuscriptHash: hashBytes(Buffer.from(source, 'utf8')),
    seedBundleHash: seedBundle.autonomousResearchSeedContractBundleHash,
    formalSupportRegistryHash: formalSupportAuthority.formalSupportRegistryHash,
    formalSupportTemplateId: formalSupportAuthority.formalSupportTemplateId,
    formalSupportTemplateHash: formalSupportAuthority.formalSupportTemplateHash,
    formalSupportSurfaceAuthorityHash:
      formalSupportAuthority.autonomousFormalSupportSurfaceAuthorityHash,
    formalSupportSurfaceHash: assertionUniverse.formalSupports[0].formalSupportSurfaceHash,
    empiricalAssertionAuthorityHash: authority.empiricalAssertionAuthorityHash,
    empiricalClaimUniverseHash: claimUniverse.empiricalClaimUniverseHash,
    empiricalAssertionUniverseHash: assertionUniverse.empiricalAssertionUniverseHash,
    empiricalAssertionUniverseBindingHash: assertionBinding.empiricalAssertionUniverseBindingHash,
    empiricalPresentationAuthorityHash: presentationAuthority.empiricalPresentationAuthorityHash,
    presentationArtifacts: presentationAuthority.artifacts,
    sectionModel: 'trusted-evidence-bound-autonomous-manuscript-v2',
    renderedSections: TRUSTED_AUTONOMOUS_MANUSCRIPT_SECTIONS,
    agentAuthoredRenderedProseAccepted: false,
    unboundScientificProseAccepted: false,
    externalActionPerformed: false,
  };
  return Object.freeze({
    ...payload,
    trustedAutonomousManuscriptRenderReceiptHash:
      hashRecord('TrustedAutonomousManuscriptRenderReceipt', payload),
  });
}
