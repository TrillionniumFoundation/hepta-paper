// Submission and durable release-evidence infrastructure.
export { consumeCampaignReleaseBundleForSubmission } from '../../paper-adapters/submission/campaign-release-bundle-consumer.mjs';
export { verifyColdVolumeContract } from '../../paper-adapters/archives/cold-volume-contract.mjs';
export { coldVolumeCasStatus, drillColdVolumeCasRestore, importColdVolumeToCas } from '../../paper-adapters/archives/cold-volume-cas-repository.mjs';
export {
  createOffhostWormSnapshot,
  drillOffhostWormRestore,
  resolveLatestReleaseEvidencePointer,
  selectLatestVerifiedReleaseEvidence,
  verifyOffhostWormTarget,
} from '../../paper-adapters/archives/offhost-worm-repository.mjs';
