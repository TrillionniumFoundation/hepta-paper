import {
  buildLimitedPriorArtEvidenceReceipt,
  verifyPriorArtEvidenceReceipt,
} from '../../paper-domain/research/prior-art-evidence-contract.mjs';
import { STRONG_PRIOR_ART_CAPABILITY_MODE } from '../../paper-domain/automation/autonomous-research-capability-scope-manifest.mjs';
import { assertPriorArtRetrievalPort } from '../../paper-ports/prior-art-retrieval-port.mjs';
import { buildConservativePriorArtClaimAlignment } from './prior-art-claim-alignment-production.mjs';

async function authorizeSideEffect(assertExternalSideEffectReady, action, paperId) {
  if (assertExternalSideEffectReady) {
    await assertExternalSideEffectReady({ action, paperId });
    assertExternalSideEffectReady.assertCurrent?.({ action, paperId });
  }
  await assertExternalSideEffectReady?.markStarted?.({ action });
}

function retrievalInput({ paperId, selectedObjective, selectedProtocolFamily, researchAgendaIr, agendaSelectionReceipt, generated, createdAt, productionRun }) {
  return {
    paperId,
    objective: selectedObjective,
    protocolFamily: selectedProtocolFamily,
    researchAgendaIrHash: researchAgendaIr?.researchAgendaIrHash,
    priorArtQueryPlan: researchAgendaIr?.priorArtQueryPlan,
    agendaSelectionReceiptHash: agendaSelectionReceipt.autonomousResearchAgendaSelectionReceiptHash,
    generatorPrincipalId: generated.principalId,
    ...(productionRun ? {
      generatorIdentityAttestation: generated.generatorIdentityAttestation,
      generatorIdentityAuthorityEnvelope: generated.generatorIdentityAuthorityEnvelope,
    } : {}),
    createdAt: createdAt || agendaSelectionReceipt.selectedAt || '1970-01-01T00:00:00.000Z',
  };
}

export async function prepareAutonomousResearchPriorArt({
  paperId,
  productionRun,
  generated,
  priorArtRetriever,
  externalCapabilityTrustInspection,
  assertExternalSideEffectReady,
  selectedObjective,
  selectedProtocolFamily,
  researchAgendaIr,
  agendaSelectionReceipt,
  authorIdentityAttestation,
  authorIdentityAuthorityEnvelope,
  createdAt,
}) {
  const input = retrievalInput({
    paperId,
    selectedObjective,
    selectedProtocolFamily,
    researchAgendaIr,
    agendaSelectionReceipt,
    generated: {
      ...generated,
      generatorIdentityAttestation: authorIdentityAttestation || generated.principalIdentityAttestation,
      generatorIdentityAuthorityEnvelope: authorIdentityAuthorityEnvelope || generated.principalIdentityAuthorityEnvelope,
    },
    createdAt,
    productionRun,
  });
  let priorArtAuthorityVerificationBundle = null;
  let priorArtAuthorityTrustConfiguration = null;
  let priorArtReceipt = null;
  if (productionRun) {
    if (generated.priorArtReceipt !== null) throw new Error('autonomous_research_production_generated_prior_art_forbidden');
    if (!priorArtRetriever) throw new Error('autonomous_research_production_prior_art_retriever_required');
    const retriever = assertPriorArtRetrievalPort(priorArtRetriever);
    const priorArtTrust = externalCapabilityTrustInspection?.components?.priorArt || null;
    if (retriever.cryptographicAuthorityReady !== true
      || retriever.identityIndependenceReady !== true
      || retriever.evidenceProfile !== STRONG_PRIOR_ART_CAPABILITY_MODE
      || retriever.trustSetHash !== priorArtTrust?.trustSetHash
      || retriever.signatureVerificationPolicyHash !== priorArtTrust?.signatureVerificationPolicyHash) {
      throw new Error('autonomous_research_production_prior_art_trust_not_ready');
    }
    await authorizeSideEffect(assertExternalSideEffectReady, 'production_prior_art_retrieval', paperId);
    priorArtReceipt = await retriever.retrieve(input);
    priorArtAuthorityVerificationBundle = retriever.verifyAuthority(priorArtReceipt);
    if (retriever.authorityFor(priorArtReceipt) !== priorArtAuthorityVerificationBundle) {
      throw new Error('autonomous_research_production_prior_art_authority_invalid');
    }
    retriever.verifyAuthorityBundle(priorArtReceipt, priorArtAuthorityVerificationBundle);
    priorArtAuthorityTrustConfiguration = retriever.authorityTrustConfiguration();
  } else if (generated.priorArtReceipt) {
    priorArtReceipt = generated.priorArtReceipt;
  } else if (priorArtRetriever) {
    await authorizeSideEffect(assertExternalSideEffectReady, 'bounded_prior_art_retrieval', paperId);
    priorArtReceipt = await assertPriorArtRetrievalPort(priorArtRetriever).retrieve(input);
  } else {
    priorArtReceipt = buildLimitedPriorArtEvidenceReceipt({
      paperId,
      agendaSelectionReceiptHash: agendaSelectionReceipt.autonomousResearchAgendaSelectionReceiptHash,
      generatorPrincipalId: generated.principalId,
      createdAt: input.createdAt,
    });
  }
  const priorArtVerification = verifyPriorArtEvidenceReceipt(priorArtReceipt, {
    paperId,
    agendaSelectionReceiptHash: agendaSelectionReceipt.autonomousResearchAgendaSelectionReceiptHash,
    ...(researchAgendaIr ? {
      researchAgendaIrHash: researchAgendaIr.researchAgendaIrHash,
      priorArtQueryPlan: researchAgendaIr.priorArtQueryPlan,
    } : {}),
    requireVerified: productionRun,
  });
  if (!priorArtVerification.valid) {
    throw new Error(`autonomous_research_prior_art_evidence_invalid:${priorArtVerification.blockers.join(',')}`);
  }
  const priorArtClaimAlignmentReceipt = researchAgendaIr && priorArtReceipt?.version === 2
    ? buildConservativePriorArtClaimAlignment({ researchAgendaIr, agendaSelectionReceipt, priorArtEvidenceReceipt: priorArtReceipt })
    : null;
  if (productionRun && !priorArtClaimAlignmentReceipt) {
    throw new Error('autonomous_research_production_prior_art_claim_alignment_required');
  }
  return Object.freeze({
    priorArtAuthorityVerificationBundle,
    priorArtAuthorityTrustConfiguration,
    priorArtReceipt,
    priorArtClaimAlignmentReceipt,
    priorArtVerification,
  });
}
