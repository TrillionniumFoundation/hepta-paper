import { hasExactObjectKeys as exactKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  empiricalClaimDeclarationsFromAnalysisProtocol,
  verifyAnalysisProtocol,
} from './analysis-protocol-contract.mjs';
import { verifyMachineProposedScientificClaimSet } from './autonomous-research-proposal-contract.mjs';
import { verifyEmpiricalClaimUniverse } from '../research/empirical-claim-contract.mjs';

const HASH = /^sha256:[0-9a-f]{64}$/;
const RAW_CLAIM_KEYS = Object.freeze([
  'id', 'kind', 'status', 'text', 'scientificClaimKey', 'verificationMode',
  'assumptions', 'quantifiers', 'negativeBoundaries', 'proofObligations',
  'empiricalObligations', 'machineProposedScientificClaimSetHash',
]);

function sameRecord(kind, left, right) {
  return hashRecord(kind, left) === hashRecord(kind, right);
}

function analysisProtocolContext(protocol) {
  return Object.freeze({
    benchmarkId: protocol?.benchmarkId,
    benchmarkFamily: protocol?.benchmarkFamily,
    requiredMetrics: protocol?.requiredMetrics,
    metricSpecs: protocol?.metricSpecs,
  });
}

function expectedEmpiricalSeedClaim(proposal) {
  const proposalVerification = verifyMachineProposedScientificClaimSet(proposal);
  if (!proposalVerification.valid) {
    throw new Error('autonomous_empirical_lineage_proposal_invalid');
  }
  const empiricalIndex = proposal.claims.findIndex(
    (claim) => claim.verificationMode === 'empirical_protocol',
  );
  if (empiricalIndex < 0) throw new Error('autonomous_empirical_lineage_proposal_claim_missing');
  const claim = proposal.claims[empiricalIndex];
  return Object.freeze({
    id: `${proposal.paperId}:autonomous_claim:${empiricalIndex + 1}`,
    kind: 'machine_proposed_claim_seed',
    status: 'machine_proposed_policy_authorized_for_bounded_execution',
    text: claim.statement,
    scientificClaimKey: claim.claimKey,
    verificationMode: claim.verificationMode,
    assumptions: claim.assumptions,
    quantifiers: claim.quantifiers,
    negativeBoundaries: claim.negativeBoundaries,
    proofObligations: claim.proofObligations,
    empiricalObligations: claim.empiricalObligations,
    machineProposedScientificClaimSetHash: proposal.machineProposedScientificClaimSetHash,
  });
}

function boundEmpiricalSeedClaim({ proposal, seedBundle }) {
  const expected = expectedEmpiricalSeedClaim(proposal);
  const { autonomousResearchSeedContractBundleHash: claimedBundleHash, ...bundlePayload } = seedBundle || {};
  if (seedBundle?.kind !== 'AutonomousResearchSeedContractBundle'
    || seedBundle?.status !== 'autonomous_research_seed_contracts_ready'
    || seedBundle?.proposalHash !== proposal.machineProposedScientificClaimSetHash
    || !HASH.test(String(claimedBundleHash || ''))
    || hashRecord('AutonomousResearchSeedContractBundle', bundlePayload) !== claimedBundleHash
    || !Array.isArray(seedBundle?.claims)) {
    throw new Error('autonomous_empirical_lineage_seed_bundle_invalid');
  }
  const candidates = seedBundle.claims.filter(
    (claim) => claim?.verificationMode === 'empirical_protocol',
  );
  if (candidates.length !== 1 || !exactKeys(candidates[0], RAW_CLAIM_KEYS)
    || !sameRecord('AutonomousEmpiricalSeedClaimExpected', candidates[0], expected)) {
    throw new Error('autonomous_empirical_lineage_seed_claim_scope_mismatch');
  }
  return Object.freeze({
    raw: candidates[0],
    proposalClaimRecordHash: hashRecord('AutonomousResearchClaimRecord', candidates[0]),
  });
}

export function renderAutonomousEmpiricalClaimStatement(value) {
  return String(value || '')
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/([#$%&_{}])/g, '\\$1');
}

export function deriveAutonomousEmpiricalClaimMaterialization({
  proposal,
  seedBundle,
  analysisProtocolTemplate,
} = {}) {
  if (analysisProtocolTemplate?.version !== 1
    || !verifyAnalysisProtocol(
      analysisProtocolTemplate,
      analysisProtocolContext(analysisProtocolTemplate),
    )) {
    throw new Error('autonomous_empirical_lineage_protocol_template_invalid');
  }
  const authority = boundEmpiricalSeedClaim({ proposal, seedBundle });
  const declarations = empiricalClaimDeclarationsFromAnalysisProtocol(analysisProtocolTemplate)
    .map((declaration) => Object.freeze({
      ...declaration,
      proposalClaimRecordHash: authority.proposalClaimRecordHash,
    }));
  if (!declarations.length) {
    throw new Error('autonomous_empirical_lineage_protocol_hypotheses_missing');
  }
  return Object.freeze({
    proposalClaim: authority.raw,
    proposalClaimRecordHash: authority.proposalClaimRecordHash,
    manuscriptClaimText: renderAutonomousEmpiricalClaimStatement(authority.raw.text),
    declarations: Object.freeze(declarations),
  });
}

function exactUniverseBindings({ materialization, empiricalClaimUniverse }) {
  if (!verifyEmpiricalClaimUniverse(empiricalClaimUniverse)
    || empiricalClaimUniverse.claims.length !== materialization.declarations.length) {
    throw new Error('autonomous_empirical_lineage_claim_universe_invalid');
  }
  return Object.freeze(empiricalClaimUniverse.claims.map((claim, index) => {
    const declaration = materialization.declarations[index];
    const expected = {
      claimId: declaration.claimId,
      metric: declaration.metric,
      comparator: declaration.comparator,
      alternative: declaration.alternative,
      minimumEffect: declaration.minimumEffect,
      acceptanceRequired: declaration.acceptanceRequired,
      proposalClaimRecordHash: materialization.proposalClaimRecordHash,
    };
    const observed = Object.fromEntries(Object.keys(expected).map((key) => [key, claim[key]]));
    if (!sameRecord('AutonomousEmpiricalProtocolClaimExpected', observed, expected)
      || claim.text !== materialization.manuscriptClaimText) {
      throw new Error('autonomous_empirical_lineage_claim_universe_scope_mismatch');
    }
    return Object.freeze({
      claimId: claim.claimId,
      manuscriptClaimHash: claim.manuscriptClaimHash,
      proposalClaimRecordHash: claim.proposalClaimRecordHash,
      metric: claim.metric,
      comparator: claim.comparator,
      alternative: claim.alternative,
      minimumEffect: claim.minimumEffect,
      acceptanceRequired: claim.acceptanceRequired,
    });
  }));
}

export function createAutonomousEmpiricalClaimLineage({
  proposal,
  seedBundle,
  analysisProtocolTemplate,
  empiricalClaimUniverse,
} = {}) {
  const materialization = deriveAutonomousEmpiricalClaimMaterialization({
    proposal,
    seedBundle,
    analysisProtocolTemplate,
  });
  const bindings = exactUniverseBindings({ materialization, empiricalClaimUniverse });
  const scope = Object.freeze({
    statement: materialization.proposalClaim.text,
    assumptions: materialization.proposalClaim.assumptions,
    quantifiers: materialization.proposalClaim.quantifiers,
    negativeBoundaries: materialization.proposalClaim.negativeBoundaries,
    evidenceObligations: materialization.proposalClaim.empiricalObligations,
  });
  const payload = {
    version: 1,
    kind: 'AutonomousEmpiricalClaimLineage',
    status: 'autonomous_empirical_claim_lineage_bound',
    paperId: proposal.paperId,
    proposalHash: proposal.machineProposedScientificClaimSetHash,
    seedBundleHash: seedBundle.autonomousResearchSeedContractBundleHash,
    proposalClaimId: materialization.proposalClaim.id,
    scientificClaimKey: materialization.proposalClaim.scientificClaimKey,
    proposalClaimRecordHash: materialization.proposalClaimRecordHash,
    proposalClaimScope: scope,
    proposalClaimScopeHash: hashRecord('AutonomousEmpiricalProposalClaimScope', scope),
    statementRenderingPolicy: 'deterministic-latex-source-escaping-v1',
    manuscriptClaimText: materialization.manuscriptClaimText,
    analysisProtocolTemplateHash: analysisProtocolTemplate.analysisProtocolHash,
    empiricalClaimUniverseHash: empiricalClaimUniverse.empiricalClaimUniverseHash,
    manuscriptCorpusHash: empiricalClaimUniverse.manuscriptCorpusHash,
    protocolHypotheses: bindings,
  };
  return Object.freeze({
    ...payload,
    autonomousEmpiricalClaimLineageHash:
      hashRecord('AutonomousEmpiricalClaimLineage', payload),
  });
}

export function verifyAutonomousEmpiricalClaimLineage({
  lineage,
  proposal,
  seedBundle,
  analysisProtocolTemplate,
  empiricalClaimUniverse,
} = {}) {
  try {
    const expected = createAutonomousEmpiricalClaimLineage({
      proposal,
      seedBundle,
      analysisProtocolTemplate,
      empiricalClaimUniverse,
    });
    const { autonomousEmpiricalClaimLineageHash: claimedHash, ...payload } = lineage || {};
    return Boolean(HASH.test(String(claimedHash || ''))
      && hashRecord('AutonomousEmpiricalClaimLineage', payload) === claimedHash
      && sameRecord('AutonomousEmpiricalClaimLineageExpected', lineage, expected));
  } catch {
    return false;
  }
}
