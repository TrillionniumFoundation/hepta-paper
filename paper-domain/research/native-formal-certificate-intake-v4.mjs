import { verifyCampaignResearchSourceSnapshot } from '../automation/campaign-research-contract.mjs';
import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { buildFormalClaimBindingsManifest } from './formal-certificate-evidence-contracts.mjs';

const HASH = /^sha256:[a-f0-9]{64}$/;
const INTAKE_KEYS = Object.freeze([
  'authoritativeFormalNode', 'authoritativeFormalNodeResultHash',
  'authoritativeFormalReceipt', 'authoritativeFormalReceiptVerified',
  'authoritativeSource', 'blockers', 'campaignFormalVerificationReceiptHash',
  'campaignId', 'claimBindings', 'claimBindingsHash', 'claimBindingsManifest',
  'externalActionPerformed', 'genericFormalCertificateIntakeHash', 'kind',
  'nativeFormalCertificateBundleHash', 'nativeFormalCertificateReplayReceiptHash',
  'nativeFormalClosureBinding', 'nativeFormalClosureBindingHash',
  'nativeFormalProjectClosureHash', 'nativeFormalProjectManifestHash',
  'nativeFormalToolchainHash', 'nativeResearchWorkerExecutionReceiptHash',
  'nativeResearchWorkerExecutionReportHash', 'paperId',
  'researchSourceSnapshotHash', 'sourceSnapshotVerified', 'status',
  'trustedNativeFormalReceiptVerified', 'verifierKind', 'version',
]);
const SOURCE_KEYS = Object.freeze([
  'bytes', 'hash', 'path', 'sourceReadReceiptHash',
]);
const FORMAL_NODE_KEYS = Object.freeze([
  'attemptId', 'kind', 'leaseGeneration', 'nodeId', 'result',
  'resultSha256', 'status',
]);

function canonicalBindings(value) {
  if (!Array.isArray(value) || !value.length) return null;
  const records = value.map((item) => ({
    claimId: String(item?.claimId || ''),
    obligationId: String(item?.obligationId || ''),
    statementHash: String(item?.statementHash || '').toLowerCase(),
  })).sort((left, right) => (
    left.claimId.localeCompare(right.claimId)
      || left.obligationId.localeCompare(right.obligationId)
  ));
  if (records.some((item) => !item.claimId || !item.obligationId
    || !HASH.test(item.statementHash))) return null;
  if (new Set(records.map((item) => (
    `${item.claimId}\u0000${item.obligationId}`
  ))).size !== records.length) return null;
  return records;
}

function formalReceiptHashValid(receipt) {
  const {
    campaignFormalVerificationReceiptHash: claimedHash,
    workspaceAttemptIntegration: _integration,
    ...payload
  } = receipt || {};
  return receipt?.version === 1
    && receipt?.kind === 'CampaignFormalVerificationReceipt'
    && receipt?.status === 'campaign_formal_verification_completed'
    && HASH.test(String(claimedHash || ''))
    && hashRecord('CampaignFormalVerificationReceipt', payload) === claimedHash
    && Array.isArray(receipt?.blockers) && receipt.blockers.length === 0;
}

function authoritativeFormalNodeValid(node, receipt) {
  return hasExactObjectKeys(node, FORMAL_NODE_KEYS)
    && typeof node?.nodeId === 'string' && node.nodeId.length > 0
    && node?.kind === 'formal-verify'
    && node?.status === 'completed'
    && typeof node?.attemptId === 'string' && node.attemptId.length > 0
    && Number.isInteger(node?.leaseGeneration) && node.leaseGeneration >= 1
    && HASH.test(String(node?.resultSha256 || ''))
    && hashRecord('PaperCampaignNodeResult', node?.result) === node.resultSha256
    && JSON.stringify(node?.result) === JSON.stringify(receipt)
    && receipt?.formalNodeId === node.nodeId
    && receipt?.formalAttemptId === node.attemptId
    && receipt?.formalLeaseGeneration === node.leaseGeneration;
}

function replayValid(result) {
  const replay = result?.replayReceipt || null;
  const {
    formalCertificateReplayReceiptHash: claimedHash,
    ...payload
  } = replay || {};
  return result?.status === 'formal_claim_verified'
    && HASH.test(String(result?.certificateBundleHash || ''))
    && replay?.version === 1
    && replay?.kind === 'FormalCertificateReplayReceipt'
    && replay?.status === 'formal_claim_replay_verified'
    && claimedHash === result?.formalCertificateReplayReceiptHash
    && hashRecord('FormalCertificateReplayReceipt', payload) === claimedHash
    && replay?.originalCertificateBundleHash === result?.certificateBundleHash
    && replay?.projectManifestHash === result?.projectManifestHash
    && replay?.formalProjectClosureHash === result?.formalProjectClosureHash
    && replay?.toolchainHash === result?.toolchainHash
    && replay?.systemAuditHash === result?.systemAuditHash
    && replay?.leanReadableProofPrintAuditSetHash
      === result?.leanReadableProofPrintAuditSetHash
    && Array.isArray(replay?.blockers) && replay.blockers.length === 0
    && replay?.externalActionPerformed === false;
}

function projectionBlockers({
  paperId,
  campaignId,
  researchSourceSnapshotHash,
  claimBindings,
  expectedClaimBindings,
  proposalBinding,
  nativeResearchWorkerExecution,
  nativeVerification,
  authoritativeFormalReceipt,
  authoritativeFormalNode,
  expectedAuthoritativeFormalNode,
  campaignResearchSourceSnapshot,
  authoritativeSource,
  nativeLedgerTrusted,
} = {}) {
  const blockers = [];
  const receipt = nativeVerification?.receipt || null;
  const result = receipt?.result || null;
  const observed = canonicalBindings(claimBindings);
  const expected = canonicalBindings(expectedClaimBindings);
  const aggregateSnapshot = verifyCampaignResearchSourceSnapshot(
    campaignResearchSourceSnapshot,
    { paperId, campaignId },
  );
  if (!aggregateSnapshot.valid
    || campaignResearchSourceSnapshot?.campaignResearchSourceSnapshotHash
      !== researchSourceSnapshotHash) {
    blockers.push('native_formal_intake_current_source_snapshot_invalid');
  }
  if (!observed || !expected
    || JSON.stringify(observed) !== JSON.stringify(expected)) {
    blockers.push('native_formal_intake_claim_bindings_invalid');
  }
  if (!nativeVerification?.valid) {
    blockers.push('native_formal_intake_native_closure_invalid');
  }
  if (nativeLedgerTrusted !== true) {
    blockers.push('native_formal_intake_native_ledger_trust_required');
  }
  if (!formalReceiptHashValid(authoritativeFormalReceipt)
    || authoritativeFormalReceipt?.paperId !== paperId
    || authoritativeFormalReceipt?.campaignId !== campaignId
    || authoritativeFormalReceipt?.verifiedSourceMerkleHash
      !== campaignResearchSourceSnapshot?.verifiedSourceMerkleHash
    || authoritativeFormalReceipt?.verifiedSourceWorkspaceManifestHash
      !== campaignResearchSourceSnapshot?.verifiedSourceWorkspaceManifestHash
    || authoritativeFormalReceipt?.nativeResearchWorkerExecutionReportHash
      !== nativeResearchWorkerExecution?.nativeResearchWorkerExecutionReportHash
    || JSON.stringify(authoritativeFormalReceipt?.nativeResearchWorkerExecution)
      !== JSON.stringify(nativeResearchWorkerExecution)
    || JSON.stringify(
      authoritativeFormalReceipt?.proposalClaimToTheoremBinding,
    ) !== JSON.stringify(proposalBinding)) {
    blockers.push('native_formal_intake_authoritative_formal_receipt_invalid');
  }
  if (!authoritativeFormalNodeValid(
    authoritativeFormalNode,
    authoritativeFormalReceipt,
  ) || JSON.stringify(authoritativeFormalNode)
    !== JSON.stringify(expectedAuthoritativeFormalNode)) {
    blockers.push('native_formal_intake_authoritative_formal_node_invalid');
  }
  const formalSnapshot = authoritativeFormalReceipt?.campaignFormalSourceSnapshot;
  const formalSnapshotVerification = verifyCampaignResearchSourceSnapshot(
    formalSnapshot,
    {
      campaignId,
      paperId,
      researchNodeId: authoritativeFormalReceipt?.formalNodeId,
      researchAttemptId: authoritativeFormalReceipt?.formalAttemptId,
      researchLeaseGeneration:
        authoritativeFormalReceipt?.formalLeaseGeneration,
      verifiedSourceMerkleHash:
        campaignResearchSourceSnapshot?.verifiedSourceMerkleHash,
      verifiedSourceWorkspaceManifestHash:
        campaignResearchSourceSnapshot?.verifiedSourceWorkspaceManifestHash,
    },
  );
  if (!formalSnapshotVerification.valid
    || authoritativeFormalReceipt?.campaignFormalSourceSnapshotHash
      !== formalSnapshot?.campaignResearchSourceSnapshotHash) {
    blockers.push('native_formal_intake_formal_source_snapshot_invalid');
  }
  if (!replayValid(result)) {
    blockers.push('native_formal_intake_certificate_replay_invalid');
  }
  const inputs = Array.isArray(receipt?.inputs) ? receipt.inputs : [];
  const source = inputs.length === 1 ? inputs[0] : null;
  const sourcePath = String(source?.path || '').replace(/\\/g, '/');
  const projectMatches = (result?.projectFiles || []).filter((item) => (
    String(item?.projectPath ?? item?.path ?? '').replace(/\\/g, '/')
      === sourcePath
  ));
  const snapshotMatches =
    (campaignResearchSourceSnapshot?.fileRecords || []).filter((item) => (
      String(item?.path || '').replace(/\\/g, '/') === sourcePath
    ));
  if (!hasExactObjectKeys(authoritativeSource, SOURCE_KEYS)
    || !source || inputs.length !== 1 || !sourcePath.endsWith('.lean')
    || source?.verified !== true || source?.hash !== source?.expectedHash
    || authoritativeSource?.path !== sourcePath
    || authoritativeSource?.hash !== source?.hash
    || !HASH.test(String(authoritativeSource?.sourceReadReceiptHash || ''))
    || projectMatches.length !== 1 || snapshotMatches.length !== 1
    || projectMatches[0]?.hash !== source?.hash
    || snapshotMatches[0]?.hash !== source?.hash
    || Number(authoritativeSource?.bytes) !== Number(projectMatches[0]?.bytes)
    || Number(authoritativeSource?.bytes) !== Number(snapshotMatches[0]?.bytes)) {
    blockers.push('native_formal_intake_authoritative_source_invalid');
  }
  return Object.freeze([...new Set([
    ...blockers,
    ...(nativeVerification?.blockers || []).map((item) => `native:${item}`),
  ])]);
}

export function buildNativeFormalCertificateIntakeV4({
  paperId,
  campaignId,
  researchSourceSnapshotHash,
  claimBindings,
  expectedClaimBindings,
  proposalBinding,
  nativeResearchWorkerExecution,
  nativeVerification,
  authoritativeFormalReceipt,
  authoritativeFormalNode,
  expectedAuthoritativeFormalNode,
  campaignResearchSourceSnapshot,
  authoritativeSource,
  nativeLedgerTrusted,
} = {}) {
  const blockers = projectionBlockers({
    paperId,
    campaignId,
    researchSourceSnapshotHash,
    claimBindings,
    expectedClaimBindings,
    proposalBinding,
    nativeResearchWorkerExecution,
    nativeVerification,
    authoritativeFormalReceipt,
    authoritativeFormalNode,
    expectedAuthoritativeFormalNode,
    campaignResearchSourceSnapshot,
    authoritativeSource,
    nativeLedgerTrusted,
  });
  const receipt = nativeVerification?.receipt || null;
  const result = receipt?.result || null;
  const bindingManifest = buildFormalClaimBindingsManifest({ claimBindings });
  const payload = {
    version: 4,
    kind: 'GenericFormalCertificateIntake',
    status: blockers.length
      ? 'formal_certificate_intake_blocked'
      : 'formal_certificate_intake_verified',
    paperId: paperId || null,
    campaignId: campaignId || null,
    researchSourceSnapshotHash: researchSourceSnapshotHash || null,
    verifierKind: 'lean',
    campaignFormalVerificationReceiptHash:
      authoritativeFormalReceipt?.campaignFormalVerificationReceiptHash || null,
    authoritativeFormalNode: authoritativeFormalNode || null,
    authoritativeFormalNodeResultHash:
      authoritativeFormalNode?.resultSha256 || null,
    authoritativeFormalReceipt: authoritativeFormalReceipt || null,
    authoritativeFormalReceiptVerified: blockers.every((item) => (
      !item.includes('authoritative_formal_receipt')
      && !item.includes('authoritative_formal_node')
      && !item.includes('formal_source_snapshot')
    )),
    nativeResearchWorkerExecutionReportHash:
      nativeResearchWorkerExecution?.nativeResearchWorkerExecutionReportHash
        || null,
    nativeResearchWorkerExecutionReceiptHash:
      receipt?.nativeResearchWorkerExecutionReceiptHash || null,
    nativeFormalCertificateBundleHash: result?.certificateBundleHash || null,
    nativeFormalCertificateReplayReceiptHash:
      result?.formalCertificateReplayReceiptHash || null,
    nativeFormalProjectManifestHash: result?.projectManifestHash || null,
    nativeFormalProjectClosureHash: result?.formalProjectClosureHash || null,
    nativeFormalToolchainHash: result?.toolchainHash || null,
    authoritativeSource: authoritativeSource || null,
    claimBindingsManifest: bindingManifest,
    claimBindingsHash: bindingManifest.formalClaimBindingsHash,
    claimBindings: (claimBindings || []).map((item) => Object.freeze({
      claimId: item.claimId,
      obligationId: item.obligationId,
      statementHash: item.statementHash,
    })),
    nativeFormalClosureBinding: nativeVerification?.binding || null,
    nativeFormalClosureBindingHash:
      nativeVerification?.binding?.nativeFormalClosureBindingHash || null,
    trustedNativeFormalReceiptVerified: nativeLedgerTrusted === true,
    sourceSnapshotVerified: blockers.every((item) => (
      !item.includes('source_snapshot') && !item.includes('authoritative_source')
    )),
    blockers,
    externalActionPerformed: false,
  };
  return Object.freeze({
    ...payload,
    genericFormalCertificateIntakeHash:
      hashRecord('GenericFormalCertificateIntake', payload),
  });
}

export function nativeFormalCertificateIntakeV4RecordValid(intake) {
  const {
    genericFormalCertificateIntakeHash: claimedHash,
    ...payload
  } = intake || {};
  const expectedBindingManifest = buildFormalClaimBindingsManifest({
    claimBindings: intake?.claimBindings,
  });
  return hasExactObjectKeys(intake, INTAKE_KEYS)
    && intake?.version === 4
    && intake?.kind === 'GenericFormalCertificateIntake'
    && intake?.status === 'formal_certificate_intake_verified'
    && HASH.test(String(claimedHash || ''))
    && hashRecord('GenericFormalCertificateIntake', payload) === claimedHash
    && JSON.stringify(intake?.claimBindingsManifest)
      === JSON.stringify(expectedBindingManifest)
    && intake?.claimBindingsHash
      === expectedBindingManifest.formalClaimBindingsHash
    && intake?.authoritativeFormalReceiptVerified === true
    && intake?.trustedNativeFormalReceiptVerified === true
    && intake?.sourceSnapshotVerified === true
    && Array.isArray(intake?.blockers)
    && intake.blockers.length === 0
    && intake?.externalActionPerformed === false;
}

export function verifyNativeFormalCertificateIntakeV4(intake, context = {}) {
  const claimedHash = intake?.genericFormalCertificateIntakeHash;
  const nativeLedgerTrusted =
    context.trustedNativeFormalReceiptHashes?.includes(
      context.nativeVerification?.receipt
        ?.nativeResearchWorkerExecutionReceiptHash,
    ) === true;
  const expectedBindingManifest = buildFormalClaimBindingsManifest({
    claimBindings: intake?.claimBindings,
  });
  const blockers = [
    ...(!nativeFormalCertificateIntakeV4RecordValid(intake)
      ? ['native_formal_intake_record_invalid'] : []),
    ...projectionBlockers({
      paperId: context.paperId,
      campaignId: context.campaignId,
      researchSourceSnapshotHash: context.researchSourceSnapshotHash,
      claimBindings: intake?.claimBindings,
      expectedClaimBindings: context.expectedClaimBindings,
      proposalBinding: context.proposalBinding,
      nativeResearchWorkerExecution: context.nativeResearchWorkerExecution,
      nativeVerification: context.nativeVerification,
      authoritativeFormalReceipt: intake?.authoritativeFormalReceipt,
      authoritativeFormalNode: intake?.authoritativeFormalNode,
      expectedAuthoritativeFormalNode: context.authoritativeFormalNode,
      campaignResearchSourceSnapshot: context.campaignResearchSourceSnapshot,
      authoritativeSource: intake?.authoritativeSource,
      nativeLedgerTrusted,
    }),
    ...(JSON.stringify(intake?.claimBindingsManifest)
      !== JSON.stringify(expectedBindingManifest)
      || intake?.claimBindingsHash
        !== expectedBindingManifest.formalClaimBindingsHash
      ? ['native_formal_intake_claim_manifest_invalid'] : []),
  ];
  const receipt = context.nativeVerification?.receipt || null;
  const result = receipt?.result || null;
  if (intake?.paperId !== context.paperId
    || intake?.campaignId !== context.campaignId
    || intake?.researchSourceSnapshotHash !== context.researchSourceSnapshotHash
    || intake?.campaignFormalVerificationReceiptHash
      !== intake?.authoritativeFormalReceipt
        ?.campaignFormalVerificationReceiptHash
    || intake?.authoritativeFormalNodeResultHash
      !== intake?.authoritativeFormalNode?.resultSha256
    || intake?.authoritativeFormalNodeResultHash
      !== context.authoritativeFormalNode?.resultSha256
    || JSON.stringify(intake?.authoritativeFormalNode)
      !== JSON.stringify(context.authoritativeFormalNode)
    || intake?.nativeResearchWorkerExecutionReportHash
      !== context.nativeResearchWorkerExecution
        ?.nativeResearchWorkerExecutionReportHash
    || intake?.nativeResearchWorkerExecutionReceiptHash
      !== receipt?.nativeResearchWorkerExecutionReceiptHash
    || intake?.nativeFormalCertificateBundleHash
      !== result?.certificateBundleHash
    || intake?.nativeFormalCertificateReplayReceiptHash
      !== result?.formalCertificateReplayReceiptHash
    || intake?.nativeFormalProjectManifestHash !== result?.projectManifestHash
    || intake?.nativeFormalProjectClosureHash
      !== result?.formalProjectClosureHash
    || intake?.nativeFormalToolchainHash !== result?.toolchainHash
    || intake?.nativeFormalClosureBindingHash
      !== context.nativeVerification?.binding?.nativeFormalClosureBindingHash
    || JSON.stringify(intake?.nativeFormalClosureBinding)
      !== JSON.stringify(context.nativeVerification?.binding)
    || intake?.authoritativeFormalReceiptVerified !== true
    || intake?.trustedNativeFormalReceiptVerified !== true
    || intake?.sourceSnapshotVerified !== true
    || (intake?.blockers || []).length
    || intake?.externalActionPerformed !== false) {
    blockers.push('native_formal_intake_projection_binding_invalid');
  }
  const unique = Object.freeze([...new Set(blockers)]);
  return Object.freeze({
    valid: unique.length === 0,
    status: unique.length
      ? 'formal_certificate_intake_closure_binding_blocked'
      : 'formal_certificate_intake_closure_binding_verified',
    genericFormalCertificateIntakeHash: claimedHash || null,
    paperId: unique.length ? null : intake.paperId,
    campaignId: unique.length ? null : intake.campaignId,
    researchSourceSnapshotHash:
      unique.length ? null : intake.researchSourceSnapshotHash,
    claimBindings: unique.length
      ? Object.freeze([]) : Object.freeze(canonicalBindings(intake.claimBindings)),
    nativeFormalClosureBinding:
      unique.length ? null : context.nativeVerification.binding,
    blockers: unique,
  });
}
