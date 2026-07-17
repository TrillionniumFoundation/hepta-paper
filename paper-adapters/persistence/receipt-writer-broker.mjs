// The only production module allowed to mint in-process receipt writer capabilities.
// Callers receive named, least-privilege handles; policy ids are not caller supplied.
import { issueReceiptWriterCapability } from './receipt-issuer-policy.mjs';

export const issueArtifactRepositoryWriter = () => issueReceiptWriterCapability('artifact-repository');
export const issueNativeResearchWorkerWriter = () => issueReceiptWriterCapability('native-research-worker');
export const issueExperimentWorkerWriter = () => issueReceiptWriterCapability('experiment-worker');
export const issueExperimentReproducibilityWriter = () => issueReceiptWriterCapability('experiment-reproducibility');
export const issueFormalAdapterWriter = () => issueReceiptWriterCapability('formal-adapter-bootstrap');
export const issueFormalVerifierWriter = () => issueReceiptWriterCapability('formal-verifier-runner');
export const issueProductionCapabilityVerifierWriter = () => issueReceiptWriterCapability('production-capability-verifier');
export const issueProductionCapabilityArtifactWriter = () => issueReceiptWriterCapability('production-capability-artifact-repository');
export const issueConformanceReplayWriter = () => issueReceiptWriterCapability('conformance-replay');
export const issueLedgerAdministratorWriter = () => issueReceiptWriterCapability('ledger-administrator');
export const issueAutomationReconcilerWriter = () => issueReceiptWriterCapability('automation-reconciler');
export const issueStoreAdministratorWriter = () => issueReceiptWriterCapability('store-administrator');
export const issueRuntimeRetentionWriter = () => issueReceiptWriterCapability('runtime-retention');
export const issueWorkspaceSnapshotVerifierWriter = () => issueReceiptWriterCapability('workspace-snapshot-verifier');
export const issueWorkflowStateProjectorWriter = () => issueReceiptWriterCapability('workflow-state-projector');
