import {
  verifyFormalReadableProofExplanationBundle,
} from '../../paper-domain/research/formal-readable-proof-contract.mjs';

export function buildCampaignReleaseFormalReadableProofEvidence({
  researchReport,
  campaignId,
  paperId,
} = {}) {
  const bundles = Object.freeze((researchReport?.nativeResearchWorkerExecution
    ?.workerReceipts || [])
    .filter((receipt) => receipt?.workerType === 'formal_verifier_lake')
    .map((receipt) => receipt?.result?.readableProofExplanationBundle)
    .filter((bundle) => (
      bundle?.status === 'formal_readable_proof_explanation_bundle_verified'
    )));
  if (bundles.some((bundle) => !verifyFormalReadableProofExplanationBundle(bundle).valid)) {
    throw new Error('research_evidence_capsule_formal_readable_proof_invalid');
  }
  if (!bundles.length) return null;
  return Object.freeze({
    version: 1,
    kind: 'CampaignReleaseFormalReadableProofEvidence',
    campaignId,
    paperId,
    researchReportHash: researchReport.researchReportHash,
    theoremCount: bundles.reduce((sum, bundle) => sum + bundle.theoremCount, 0),
    bundleHashes: Object.freeze(bundles.map((bundle) => (
      bundle.formalReadableProofExplanationBundleHash
    ))),
    bundles,
    naturalLanguageDerivationMachineProven: false,
  });
}
