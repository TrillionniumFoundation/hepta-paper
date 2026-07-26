import {
  hashRecord,
} from '../../workflow-kernel/record-hash.mjs';
import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { verifyTrustedLedgerReceipt } from '../evidence/trusted-ledger-receipt.mjs';
import {
  embeddedFormalEvidenceBlockers,
} from './formal-certificate-embedded-evidence-verifier.mjs';
import {
  canonicalFormalClosureClaimBindings as canonicalClosureClaimBindings,
  validFormalCertificateHash as validHash,
  validFormalCertificateId as validId,
} from './formal-certificate-intake-primitives.mjs';
import {
  verifyNativeFormalResearchClosureBinding,
} from './formal-certificate-native-closure.mjs';
import {
  buildNativeFormalCertificateIntakeV4,
  verifyNativeFormalCertificateIntakeV4,
} from './native-formal-certificate-intake-v4.mjs';

export {
  buildFormalClaimBindingsManifest,
  buildFormalExecutionContract,
  buildFormalSourceManifest,
} from './formal-certificate-evidence-contracts.mjs';
export {
  formalClosureClaimBindingsFromProposalBinding,
} from './formal-certificate-intake-primitives.mjs';
export {
  nativeFormalClosureBindingFromExecution,
  verifyNativeFormalResearchClosureBinding,
} from './formal-certificate-native-closure.mjs';
export {
  buildGenericFormalCertificateIntake,
} from './formal-certificate-intake-builder.mjs';

const INTAKE_V3_KEYS = Object.freeze([
  'adapterReceiptHash', 'artifactSourcesVerified', 'blockers', 'campaignId',
  'certificate', 'certificateHash', 'certificateLedgerReceiptId',
  'certificateWriteReceiptHash',
  'claimBindings', 'claimBindingsHash', 'claimBindingsManifest', 'command',
  'executionContract', 'executionContractHash', 'executionLedgerReceiptId',
  'executionReceipt', 'executionReceiptHash', 'extension',
  'externalActionPerformed', 'formalVerifierRegistryHash',
  'genericFormalCertificateIntakeHash', 'isolationPolicyHash',
  'isolationReceiptHash', 'kind', 'nativeFormalClosureBinding',
  'nativeFormalClosureBindingHash', 'paperId', 'researchSourceSnapshotHash',
  'sourceManifest', 'sourceManifestHash', 'sourceRecords', 'status',
  'toolchainHash', 'trustedLedgerReceiptsVerified',
  'trustedNativeFormalReceiptVerified', 'verifierKind', 'version',
]);

export function verifyGenericFormalCertificateIntakeClosureBinding(intake, {
  paperId = null,
  campaignId = null,
  researchSourceSnapshotHash = null,
  campaignResearchSourceSnapshot = null,
  taskKey = null,
  expectedClaimBindings = [],
  proposalBinding = null,
  nativeResearchWorkerExecution = null,
  authoritativeFormalNode = null,
  requireNativeFormalLedgerTrust = false,
  trustedNativeFormalReceiptHashes = [],
} = {}) {
  if (intake?.version === 4) {
    const nativeVerification = verifyNativeFormalResearchClosureBinding(
      nativeResearchWorkerExecution,
      {
        paperId,
        campaignId,
        researchSourceSnapshotHash,
        taskKey,
        proposalBinding,
        expectedClaimBindings,
      },
    );
    return verifyNativeFormalCertificateIntakeV4(intake, {
      paperId,
      campaignId,
      researchSourceSnapshotHash,
      campaignResearchSourceSnapshot,
      expectedClaimBindings,
      proposalBinding,
      nativeResearchWorkerExecution,
      nativeVerification,
      authoritativeFormalNode,
      requireNativeFormalLedgerTrust,
      trustedNativeFormalReceiptHashes,
    });
  }
  const blockers = [];
  const {
    genericFormalCertificateIntakeHash: claimedHash,
    ...payload
  } = intake || {};
  if (!hasExactObjectKeys(intake, INTAKE_V3_KEYS)
    || intake?.version !== 3
    || intake?.kind !== 'GenericFormalCertificateIntake'
    || intake?.status !== 'formal_certificate_intake_verified'
    || !validHash(claimedHash)
    || hashRecord('GenericFormalCertificateIntake', payload) !== claimedHash) {
    blockers.push('formal_certificate_intake_record_invalid');
  }
  if (!validId(paperId) || intake?.paperId !== paperId) {
    blockers.push('formal_certificate_intake_paper_mismatch');
  }
  if (!validId(campaignId) || intake?.campaignId !== campaignId) {
    blockers.push('formal_certificate_intake_campaign_mismatch');
  }
  if (!validHash(researchSourceSnapshotHash)
    || intake?.researchSourceSnapshotHash !== researchSourceSnapshotHash) {
    blockers.push('formal_certificate_intake_research_source_snapshot_mismatch');
  }
  const observedBindings = canonicalClosureClaimBindings(
    intake?.claimBindings,
  );
  const expectedBindings = canonicalClosureClaimBindings(
    expectedClaimBindings,
  );
  if (!observedBindings
    || !expectedBindings
    || JSON.stringify(observedBindings) !== JSON.stringify(expectedBindings)) {
    blockers.push('formal_certificate_intake_claim_binding_mismatch');
  }
  blockers.push(...embeddedFormalEvidenceBlockers(intake));
  const nativeVerification = verifyNativeFormalResearchClosureBinding(
    nativeResearchWorkerExecution,
    {
      paperId,
      campaignId,
      researchSourceSnapshotHash,
      taskKey,
      proposalBinding,
      expectedClaimBindings,
    },
  );
  if (!nativeVerification.valid
    || JSON.stringify(intake?.nativeFormalClosureBinding)
      !== JSON.stringify(nativeVerification.binding)
    || intake?.nativeFormalClosureBindingHash
      !== nativeVerification.binding?.nativeFormalClosureBindingHash) {
    blockers.push('formal_certificate_intake_native_formal_anchor_invalid');
  }
  if (requireNativeFormalLedgerTrust === true
    && (!nativeVerification.receipt
      || !trustedNativeFormalReceiptHashes.includes(
        nativeVerification.receipt.nativeResearchWorkerExecutionReceiptHash,
      ))) {
    blockers.push('formal_certificate_intake_native_formal_ledger_trust_required');
  }
  if (intake?.trustedLedgerReceiptsVerified !== true
    || intake?.artifactSourcesVerified !== true
    || intake?.trustedNativeFormalReceiptVerified !== true
    || !Array.isArray(intake?.blockers)
    || intake.blockers.length
    || intake?.externalActionPerformed !== false) {
    blockers.push('formal_certificate_intake_build_time_evidence_invalid');
  }
  const uniqueBlockers = Object.freeze([...new Set([
    ...blockers,
    ...nativeVerification.blockers.map((blocker) => `native:${blocker}`),
  ])]);
  return Object.freeze({
    valid: uniqueBlockers.length === 0,
    status: uniqueBlockers.length
      ? 'formal_certificate_intake_closure_binding_blocked'
      : 'formal_certificate_intake_closure_binding_verified',
    genericFormalCertificateIntakeHash: claimedHash || null,
    paperId: uniqueBlockers.length ? null : intake.paperId,
    campaignId: uniqueBlockers.length ? null : intake.campaignId,
    researchSourceSnapshotHash: uniqueBlockers.length
      ? null
      : intake.researchSourceSnapshotHash,
    claimBindings: uniqueBlockers.length
      ? Object.freeze([])
      : Object.freeze(observedBindings),
    nativeFormalClosureBinding: uniqueBlockers.length
      ? null
      : nativeVerification.binding,
    blockers: uniqueBlockers,
  });
}

export function buildNativeFormalCertificateIntake({
  paperId = null,
  campaignId = null,
  researchSourceSnapshotHash = null,
  campaignResearchSourceSnapshot = null,
  claimBindings = [],
  authoritativeFormalReceipt = null,
  authoritativeFormalNode = null,
  authoritativeSource = null,
  nativeResearchWorkerExecution = null,
  receiptLedger = null,
} = {}, {
  expectedPaperId = null,
  expectedCampaignId = null,
  expectedResearchSourceSnapshotHash = null,
  expectedClaimBindings = [],
  expectedTaskKey = null,
  expectedProposalBinding = null,
  expectedAuthoritativeFormalNode = null,
} = {}) {
  const nativeVerification = verifyNativeFormalResearchClosureBinding(
    nativeResearchWorkerExecution,
    {
      paperId: expectedPaperId,
      campaignId: expectedCampaignId,
      researchSourceSnapshotHash: expectedResearchSourceSnapshotHash,
      taskKey: expectedTaskKey,
      proposalBinding: expectedProposalBinding,
      expectedClaimBindings,
    },
  );
  const receipt = nativeVerification.receipt;
  const nativeLedger = verifyTrustedLedgerReceipt({
    receipt,
    ledgerReceiptId: receipt?.ledgerReceiptId,
    receiptLedger,
    expectedKinds: ['NativeResearchWorkerExecutionReceipt'],
    expectedStatuses: ['native_research_worker_execution_verified'],
    expectedStreams: ['jobs'],
    expectedWriterKinds: ['native-research-worker'],
  });
  return buildNativeFormalCertificateIntakeV4({
    paperId,
    campaignId,
    researchSourceSnapshotHash,
    claimBindings,
    expectedClaimBindings,
    proposalBinding: expectedProposalBinding,
    nativeResearchWorkerExecution,
    nativeVerification,
    authoritativeFormalReceipt,
    authoritativeFormalNode,
    expectedAuthoritativeFormalNode,
    campaignResearchSourceSnapshot,
    authoritativeSource,
    nativeLedgerTrusted:
      nativeLedger.status === 'trusted_ledger_receipt_verified',
  });
}
