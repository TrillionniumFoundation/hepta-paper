import path from 'node:path';
import {
  formalClosureClaimBindingsFromProposalBinding,
  verifyNativeFormalResearchClosureBinding,
} from '../../paper-domain/research/formal-certificate-intake.mjs';
import {
  PRODUCTION_LEAN_TOOLCHAIN,
  PRODUCTION_LEAN_TOOLCHAIN_ROOT_MERKLE_HASHES,
} from '../../paper-domain/research/formal-verifier-policy.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  readScopedFileSync,
} from '../../workflow-kernel/runtime/scoped-file-identity.mjs';
import {
  normalizeContainerImageDigest,
} from '../runtime/sandbox-backend-probe.mjs';
import {
  createPinnedFormalSandboxRuntime,
} from './pinned-formal-sandbox-runtime-contract.mjs';
import {
  assertCompletedCampaignFormalNode,
  verifyCampaignFormalReceipt,
} from '../automation/campaign-formal-verification-evidence.mjs';
import {
  blockedTrustedFormalEvidence,
  MAXIMUM_TRUSTED_FORMAL_REQUEST_HINTS,
  trustedFormalAuthorityBlockers,
  uniqueTrustedFormalBlockers,
} from './trusted-formal-producer-contract.mjs';

export {
  MAXIMUM_TRUSTED_FORMAL_REQUEST_HINTS,
  TRUSTED_FORMAL_EXECUTION_TIMEOUT_MS,
  TRUSTED_FORMAL_TOTAL_BUDGET_MS,
} from './trusted-formal-producer-contract.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;

function canonicalBindings(value) {
  if (!Array.isArray(value)) return null;
  const bindings = value.map((item) => ({
    claimId: String(item?.claimId || item?.claim_id || ''),
    obligationId: String(item?.obligationId || item?.obligation_id || ''),
    statementHash: String(item?.statementHash || item?.statement_hash || ''),
  })).sort((left, right) => (
    left.claimId.localeCompare(right.claimId)
      || left.obligationId.localeCompare(right.obligationId)
  ));
  return bindings.some((item) => !item.claimId || !item.obligationId
    || !SHA256.test(item.statementHash)) ? null : bindings;
}

function requestHintBlockers(requestHints, {
  root, sourcePath, sourceHash, claimBindings,
} = {}) {
  const hints = Array.isArray(requestHints) ? requestHints : [];
  const blockers = [];
  if (hints.length > MAXIMUM_TRUSTED_FORMAL_REQUEST_HINTS) {
    blockers.push('trusted_formal_request_hint_count_exceeded');
  }
  const hint = hints[0] || null;
  if (!hint) return uniqueTrustedFormalBlockers(blockers);
  const verifierKind = hint.verifierKind || hint.verifier_kind || null;
  if (verifierKind && String(verifierKind).toLowerCase() !== 'lean') {
    blockers.push('trusted_formal_request_verifier_authority_mismatch');
  }
  for (const forbidden of [
    'command', 'executable', 'executableOverride', 'runnerOverride', 'sandbox',
    'sandboxRuntime', 'timeoutMs', 'timeout_ms',
  ]) if (Object.hasOwn(hint, forbidden)) {
    blockers.push(
      `trusted_formal_request_execution_override_forbidden:${forbidden}`,
    );
  }
  const requestedSources = hint.sourceRecords || hint.source_records;
  if (requestedSources !== undefined) {
    if (!Array.isArray(requestedSources) || requestedSources.length !== 1) {
      blockers.push('trusted_formal_request_source_count_invalid');
    } else {
      const requested = requestedSources[0] || {};
      const rawPath = requested.absolutePath || requested.path || '';
      if (!rawPath || path.resolve(root, String(rawPath)) !== sourcePath) {
        blockers.push('trusted_formal_request_source_authority_mismatch');
      }
      const requestedHash = requested.hash || requested.sha256 || null;
      if (requestedHash && requestedHash !== sourceHash) {
        blockers.push('trusted_formal_request_source_hash_mismatch');
      }
    }
  }
  const requestedBindings = hint.claimBindings || hint.claim_bindings;
  if (requestedBindings !== undefined
    && JSON.stringify(canonicalBindings(requestedBindings))
      !== JSON.stringify(canonicalBindings(claimBindings))) {
    blockers.push('trusted_formal_request_claim_bindings_mismatch');
  }
  return uniqueTrustedFormalBlockers(blockers);
}

function authoritativeSource({
  root,
  nativeResearchWorkerExecution,
  campaignResearchSourceSnapshot,
} = {}) {
  const receipts = (nativeResearchWorkerExecution?.workerReceipts || [])
    .filter((receipt) => receipt?.workerType === 'formal_verifier_lake');
  const receipt = receipts.length === 1 ? receipts[0] : null;
  const inputs = Array.isArray(receipt?.inputs) ? receipt.inputs : [];
  const blockers = [];
  if (!receipt || inputs.length !== 1) {
    return {
      receipt,
      blockers: Object.freeze([
        'trusted_formal_authoritative_source_count_invalid',
      ]),
    };
  }
  const input = inputs[0];
  const relativePath = String(input?.path || '').replace(/\\/g, '/');
  const absolutePath = path.resolve(root, relativePath);
  const read = readScopedFileSync({
    scopeRoot: root,
    candidate: absolutePath,
    maximumBytes: 64 * 1024 * 1024,
  });
  if (read.status !== 'scoped_file_read_verified') blockers.push(...read.blockers);
  if (path.extname(absolutePath).toLowerCase() !== '.lean') {
    blockers.push('trusted_formal_authoritative_source_extension_invalid');
  }
  if (input?.verified !== true || !SHA256.test(String(input?.hash || ''))
    || input.hash !== input.expectedHash || input.hash !== read.hash) {
    blockers.push('trusted_formal_authoritative_source_hash_invalid');
  }
  const projectFiles = (receipt?.result?.projectFiles || []).filter((record) => (
    String(record?.projectPath ?? record?.path ?? '').replace(/\\/g, '/')
      === relativePath
  ));
  const snapshotFiles = (campaignResearchSourceSnapshot?.fileRecords || [])
    .filter((record) => String(record?.path || '').replace(/\\/g, '/')
      === relativePath);
  if (projectFiles.length !== 1 || snapshotFiles.length !== 1
    || projectFiles[0]?.hash !== input?.hash
    || Number(projectFiles[0]?.bytes) !== Number(read.bytes)
    || snapshotFiles[0]?.hash !== input?.hash
    || Number(snapshotFiles[0]?.bytes) !== Number(read.bytes)
    || receipt?.result?.projectManifestHash
      !== receipt?.result?.replayReceipt?.projectManifestHash) {
    blockers.push('trusted_formal_authoritative_project_manifest_mismatch');
  }
  return {
    receipt,
    input,
    read,
    absolutePath,
    projectFile: projectFiles[0] || null,
    blockers: uniqueTrustedFormalBlockers(blockers),
  };
}

function nativeRuntimeBlockers(result, runtime) {
  const identity = result?.executionIdentity || {};
  const replayIdentity = result?.replayReceipt?.executionIdentity || {};
  const toolchain = result?.toolchainRuntimeIdentity || {};
  const replayToolchain = result?.replayReceipt?.toolchainRuntimeIdentity || {};
  const expectedRoot =
    PRODUCTION_LEAN_TOOLCHAIN_ROOT_MERKLE_HASHES[PRODUCTION_LEAN_TOOLCHAIN];
  return uniqueTrustedFormalBlockers([
    ...(identity.backend !== 'docker' || replayIdentity.backend !== 'docker'
      || normalizeContainerImageDigest(identity.containerImageDigest)
        !== runtime.imageDigest
      || normalizeContainerImageDigest(replayIdentity.containerImageDigest)
        !== runtime.imageDigest
      || result?.isolation?.immutableContainerImageVerified !== true
      || result?.isolation?.kernelNetworkIsolationVerified !== true
      || result?.isolation?.sourceReadOnlyVerified !== true
      ? ['trusted_formal_native_docker_runtime_identity_mismatch'] : []),
    ...(result?.toolchain !== PRODUCTION_LEAN_TOOLCHAIN
      || result?.replayReceipt?.toolchain !== PRODUCTION_LEAN_TOOLCHAIN
      || result?.toolchainHash !== result?.replayReceipt?.toolchainHash
      || toolchain?.status !== 'lean_toolchain_identity_verified'
      || toolchain?.toolchain !== PRODUCTION_LEAN_TOOLCHAIN
      || toolchain?.toolchainRootMerkleHash !== expectedRoot
      || toolchain?.trustedToolchainRootMerkleHash !== expectedRoot
      || replayToolchain?.leanToolchainContentIdentityHash
        !== toolchain?.leanToolchainContentIdentityHash
      ? ['trusted_formal_native_toolchain_identity_mismatch'] : []),
  ]);
}

function verifyAuthoritativeFormalNode({
  campaign,
  authoritativeFormalNode,
  authoritativeFormalReceipt,
  paperTask,
  campaignResearchSourceSnapshot,
  authoritativeTheoremSpecification,
} = {}) {
  let completedNode;
  try {
    completedNode =
      assertCompletedCampaignFormalNode(authoritativeFormalNode);
  } catch {
    return Object.freeze({
      node: null,
      receipt: null,
      blockers: Object.freeze([
        'trusted_formal_authoritative_formal_node_invalid',
      ]),
    });
  }
  const receipt = completedNode.result;
  const verification = verifyCampaignFormalReceipt(receipt, {
    campaign,
    formalNode: completedNode,
    sourceSnapshot: campaignResearchSourceSnapshot,
    paperTask,
    theoremSpecification: authoritativeTheoremSpecification,
  });
  const blockers = uniqueTrustedFormalBlockers([
    ...(JSON.stringify(authoritativeFormalReceipt)
      !== JSON.stringify(receipt)
      ? ['trusted_formal_authoritative_formal_receipt_mismatch'] : []),
    ...(!verification.valid
      ? verification.blockers.map((blocker) => (
        `trusted_formal_authoritative_formal_receipt:${blocker}`
      )) : []),
  ]);
  return Object.freeze({
    node: blockers.length ? null : completedNode,
    receipt: blockers.length ? null : receipt,
    blockers,
  });
}

function completedFormalNodeProjection(node) {
  return Object.freeze({
    nodeId: node.nodeId,
    kind: node.kind,
    status: node.status,
    attemptId: node.attemptId,
    leaseGeneration: node.leaseGeneration,
    resultSha256: node.resultSha256,
    result: node.result,
  });
}

function projectedAttempt({ authorityHash, canonicalRequestHash, hints }) {
  return Object.freeze({
    version: 1,
    kind: 'TrustedFormalEvidenceAttempt',
    status: 'trusted_formal_evidence_projection_verified',
    phase: 'completed',
    authorityHash,
    canonicalRequestHash,
    externalActionId: null,
    requestHintCount: hints,
    maximumRequestHintCount: MAXIMUM_TRUSTED_FORMAL_REQUEST_HINTS,
    executionPerformed: false,
    writesPerformed: false,
    partialMutation: false,
    authoritativeNativeExecutionReused: true,
    blockers: Object.freeze([]),
  });
}

export async function produceTrustedFormalEvidence({
  root,
  paperTask,
  campaignEvidenceContext = null,
  campaignResearchSourceSnapshot = null,
  campaign = null,
  authoritativeFormalNode = null,
  authoritativeTheoremSpecification = null,
  authoritativeFormalReceipt = null,
  nativeResearchWorkerExecution = null,
  proposalClaimToTheoremBinding = null,
  requestHints = [],
  campaignExecutionAuthority = null,
  executionSignal = null,
  trustedSandboxRuntime = null,
} = {}) {
  const hintCount = Array.isArray(requestHints) ? requestHints.length : 0;
  const authorityHash = campaignExecutionAuthority
    ?.trustedFormalCampaignExecutionAuthorityHash || null;
  const block = (phase, blockers, extra = {}) => blockedTrustedFormalEvidence({
    phase, blockers, authorityHash, requestHintCount: hintCount, ...extra,
  });
  if (executionSignal?.aborted) {
    return block('preflight', ['campaign_research_verification_cancelled']);
  }
  const formalNodeVerification = verifyAuthoritativeFormalNode({
    campaign,
    authoritativeFormalNode,
    authoritativeFormalReceipt,
    paperTask,
    campaignResearchSourceSnapshot,
    authoritativeTheoremSpecification,
  });
  if (formalNodeVerification.blockers.length) {
    return block('formal_node_authority', formalNodeVerification.blockers);
  }
  const trustedFormalReceipt = formalNodeVerification.receipt;
  const authorityBlockers = trustedFormalAuthorityBlockers({
    authority: campaignExecutionAuthority,
    paperTask,
    campaignEvidenceContext,
    campaignResearchSourceSnapshot,
    authoritativeFormalReceipt: trustedFormalReceipt,
    authoritativeFormalNode: formalNodeVerification.node,
    nativeResearchWorkerExecution,
  });
  if (authorityBlockers.length) return block('authority', authorityBlockers);
  let runtime;
  try {
    runtime = createPinnedFormalSandboxRuntime(trustedSandboxRuntime);
  } catch (error) {
    return block('native_runtime', [
      error?.message || 'formal_sandbox_runtime_invalid',
    ]);
  }
  const claimBindings = formalClosureClaimBindingsFromProposalBinding(
    proposalClaimToTheoremBinding,
  );
  const nativeVerification = verifyNativeFormalResearchClosureBinding(
    nativeResearchWorkerExecution,
    {
      paperId: paperTask.paperId,
      campaignId: campaignEvidenceContext.campaignId,
      researchSourceSnapshotHash:
        campaignResearchSourceSnapshot.campaignResearchSourceSnapshotHash,
      taskKey: paperTask.taskKey,
      proposalBinding: proposalClaimToTheoremBinding,
      expectedClaimBindings: claimBindings,
    },
  );
  const source = authoritativeSource({
    root,
    nativeResearchWorkerExecution,
    campaignResearchSourceSnapshot,
  });
  const blockers = uniqueTrustedFormalBlockers([
    ...nativeVerification.blockers.map((item) => `native_formal:${item}`),
    ...source.blockers,
    ...nativeRuntimeBlockers(source.receipt?.result, runtime),
    ...requestHintBlockers(requestHints, {
      root,
      sourcePath: source.absolutePath,
      sourceHash: source.read?.hash,
      claimBindings,
    }),
  ]);
  if (!nativeVerification.valid || blockers.length) {
    return block('native_projection_preflight', blockers);
  }
  const canonicalRequest = Object.freeze({
    version: 1,
    kind: 'TrustedNativeFormalAggregateProjectionRequest',
    paperId: paperTask.paperId,
    campaignId: campaignEvidenceContext.campaignId,
    researchSourceSnapshotHash:
      campaignResearchSourceSnapshot.campaignResearchSourceSnapshotHash,
    campaignFormalVerificationReceiptHash:
      trustedFormalReceipt.campaignFormalVerificationReceiptHash,
    nativeResearchWorkerExecutionReportHash:
      nativeResearchWorkerExecution.nativeResearchWorkerExecutionReportHash,
    nativeResearchWorkerExecutionReceiptHash:
      source.receipt.nativeResearchWorkerExecutionReceiptHash,
    sourcePath: String(source.input.path).replace(/\\/g, '/'),
    sourceHash: source.read.hash,
    claimBindings,
  });
  const canonicalRequestHash = hashRecord(
    'TrustedNativeFormalAggregateProjectionRequest',
    canonicalRequest,
  );
  return Object.freeze({
    status: 'trusted_formal_evidence_projected',
    attempt: projectedAttempt({
      authorityHash,
      canonicalRequestHash,
      hints: hintCount,
    }),
    nativeProjectionRequest: Object.freeze({
      paperId: paperTask.paperId,
      campaignId: campaignEvidenceContext.campaignId,
      researchSourceSnapshotHash:
        campaignResearchSourceSnapshot.campaignResearchSourceSnapshotHash,
      verifierKind: 'lean',
      claimBindings,
      authoritativeFormalReceipt: trustedFormalReceipt,
      authoritativeFormalNode:
        completedFormalNodeProjection(formalNodeVerification.node),
      campaignResearchSourceSnapshot,
      nativeResearchWorkerExecution,
      authoritativeSource: Object.freeze({
        path: String(source.input.path).replace(/\\/g, '/'),
        hash: source.read.hash,
        bytes: source.read.bytes,
        sourceReadReceiptHash: source.read.scopedFileReadReceiptHash,
      }),
    }),
    blockers: Object.freeze([]),
  });
}
