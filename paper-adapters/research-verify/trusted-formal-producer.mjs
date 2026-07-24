import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildFormalClaimBindingsManifest, buildFormalExecutionContract, buildFormalSourceManifest } from '../../paper-domain/research/formal-certificate-intake.mjs';
import { formalVerifierDescriptor } from '../../paper-domain/research/formal-verifier-registry.mjs';
import { computeReceiptHash } from '../../paper-domain/evidence/receipt-hash-policy.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { readScopedFileSync } from '../../workflow-kernel/runtime/scoped-file-identity.mjs';
import { createOsSandboxedWorkerRunner, fileSha256Hash } from '../runtime/os-sandboxed-worker-runner.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;

function executablePath(command) {
  const result = spawnSync('which', [command], { encoding: 'utf8', timeout: 3000 });
  return result.status === 0 ? String(result.stdout || '').trim() : null;
}

export async function produceTrustedFormalEvidence({
  root,
  runtimeRoot,
  paperTask,
  campaignId = null,
  researchSourceSnapshotHash = null,
  request,
  artifactRepositoryFactory,
  receiptWriters,
  clock,
  executableOverride = null,
  runnerOverride = null,
} = {}) {
  const descriptor = formalVerifierDescriptor(request?.verifierKind || request?.verifier_kind);
  if (!descriptor) return Object.freeze({ status: 'trusted_formal_evidence_blocked', blockers: ['formal_verifier_kind_unknown'] });
  if (!artifactRepositoryFactory || !receiptWriters?.formalAdapter || !receiptWriters?.formalExecution || !clock) return Object.freeze({ status: 'trusted_formal_evidence_blocked', blockers: ['trusted_formal_services_missing'] });
  if (!paperTask?.paperId || !campaignId || !SHA256.test(String(researchSourceSnapshotHash || ''))) {
    return Object.freeze({
      status: 'trusted_formal_evidence_blocked',
      blockers: ['formal_current_research_lineage_required'],
    });
  }
  const executable = executableOverride || executablePath(descriptor.command);
  if (!executable) return Object.freeze({ status: 'trusted_formal_evidence_blocked', blockers: [`formal_runtime_unavailable:${descriptor.command}`] });
  const requestedSources = request.sourceRecords || request.source_records || [];
  if (!requestedSources.length) return Object.freeze({ status: 'trusted_formal_evidence_blocked', blockers: ['formal_source_records_missing'] });
  const formalDir = path.join(runtimeRoot, 'formal-verification', paperTask.paperId, descriptor.kind);
  fs.mkdirSync(formalDir, { recursive: true });
  const repository = artifactRepositoryFactory(formalDir);
  const sourceRecords = [];
  for (const [index, source] of requestedSources.entries()) {
    const input = path.resolve(root, String(source.absolutePath || source.path || ''));
    const sourceRead = readScopedFileSync({ scopeRoot: root, candidate: input, maximumBytes: 64 * 1024 * 1024 });
    if (sourceRead.status !== 'scoped_file_read_verified' || path.extname(input).toLowerCase() !== descriptor.extension) {
      return Object.freeze({ status: 'trusted_formal_evidence_blocked', blockers: [`formal_source_invalid:${index}`, ...sourceRead.blockers] });
    }
    const target = path.join(formalDir, 'sources', `${index + 1}-${path.basename(input)}`);
    const receipt = await repository.writeBytes(target, sourceRead.content, { role: `formal-source:${paperTask.paperId}:${descriptor.kind}:${index + 1}`, atomic: true });
    sourceRecords.push(Object.freeze({ path: receipt.path, hash: receipt.hash, sourceReadReceiptHash: sourceRead.scopedFileReadReceiptHash, artifactWriteReceipt: receipt, ledgerReceiptId: receipt.ledgerReceiptId, absolutePath: target }));
  }
  const adapterPayload = { version: 1, kind: 'FormalVerifierAdapterReceipt', status: 'formal_verifier_adapter_verified', verifierKind: descriptor.kind, command: descriptor.command, extension: descriptor.extension, executableHash: fileSha256Hash(executable), createdAt: clock.nowIso() };
  const adapterReceiptHash = hashRecord('FormalVerifierAdapterReceipt', adapterPayload);
  const adapterLedger = receiptWriters.formalAdapter.record({ ...adapterPayload, receiptHash: adapterReceiptHash }, { stream: 'formal-verifier-adapters', strictInsert: true });
  const adapterReceipt = Object.freeze({ ...adapterPayload, receiptHash: adapterReceiptHash, ledgerReceiptId: adapterLedger.receiptId });
  const runner = runnerOverride || createOsSandboxedWorkerRunner({ allowedExecutables: [executable], allowedRoots: [formalDir], allowedOutputRoots: [formalDir] });
  const args = descriptor.kind === 'lean' ? ['--error=warning', sourceRecords[0].absolutePath] : [sourceRecords[0].absolutePath];
  const execution = runner.run({ executable, args, cwd: formalDir, sourceRoot: formalDir, timeoutMs: Number(request.timeoutMs || 120000) });
  if (!execution.ok) return Object.freeze({ status: 'trusted_formal_evidence_blocked', adapterReceipt, sandboxReceipt: execution, blockers: execution.blockers || ['formal_execution_failed'] });
  const certificatePayload = { version: 1, kind: descriptor.certificateKind, verifierKind: descriptor.kind, sourceHashes: sourceRecords.map((item) => item.hash).sort(), toolchainHash: fileSha256Hash(executable), sandboxReceiptHash: execution.receiptHash, exitCode: execution.exitCode, stdoutHash: hashRecord('FormalStdout', String(execution.stdout || '')), stderrHash: hashRecord('FormalStderr', String(execution.stderr || '')) };
  const certificateReceipt = await repository.writeJson(path.join(formalDir, 'certificates', `${descriptor.kind}-certificate.json`), certificatePayload, { role: `formal-certificate:${paperTask.paperId}:${descriptor.kind}`, atomic: true });
  const claimBindings = request.claimBindings || request.claim_bindings || [];
  const sourceManifest = buildFormalSourceManifest({ verifierKind: descriptor.kind, sourceRecords });
  const claimBindingsManifest = buildFormalClaimBindingsManifest({ claimBindings });
  const executionContract = buildFormalExecutionContract({ verifierKind: descriptor.kind, command: descriptor.command, certificateHash: certificateReceipt.hash, toolchainHash: certificatePayload.toolchainHash, sourceManifestHash: sourceManifest.formalSourceManifestHash, claimBindingsHash: claimBindingsManifest.formalClaimBindingsHash, certificateWriteReceiptHash: certificateReceipt.writeReceiptHash, adapterReceiptHash });
  const executionPayload = {
    version: 1, kind: 'FormalVerifierExecutionReceipt', status: 'formal_verifier_execution_verified', verifierKind: descriptor.kind,
    paperId: paperTask.paperId, campaignId, researchSourceSnapshotHash,
    certificateHash: certificateReceipt.hash, sourceHashes: sourceRecords.map((item) => item.hash).sort(), sourceManifestHash: sourceManifest.formalSourceManifestHash,
    claimBindingsHash: claimBindingsManifest.formalClaimBindingsHash, certificateWriteReceiptHash: certificateReceipt.writeReceiptHash,
    toolchainHash: certificatePayload.toolchainHash, command: descriptor.command, adapterReceiptHash,
    executionContractHash: executionContract.formalExecutionContractHash, isolationPolicyHash: executionContract.isolationPolicyHash,
    isolationReceiptHash: execution.receiptHash, networkPolicy: 'none', secretAccessPerformed: false, sourceMutationDetected: false,
    externalActionPerformed: false, providerCallPerformed: false, commitPerformed: false,
    sourceMerkleHashBefore: execution.sourceMerkleHashBefore, sourceMerkleHashAfter: execution.sourceMerkleHashAfter,
    isolation: execution.isolation, exitCode: execution.exitCode,
    stdoutHash: certificatePayload.stdoutHash, stderrHash: certificatePayload.stderrHash,
    runnerId: execution.runnerId, runnerDescriptorHash: hashRecord('FormalRunnerDescriptor', { runnerId: execution.runnerId, backend: execution.backend, isolation: execution.isolation }),
    createdAt: clock.nowIso(),
  };
  const executionReceiptHash = computeReceiptHash(executionPayload, {
    hashField: 'receiptHash',
  });
  const executionLedger = receiptWriters.formalExecution.record(
    { ...executionPayload, receiptHash: executionReceiptHash },
    {
      stream: 'formal-verifier-executions',
      paperId: paperTask.paperId,
      strictInsert: true,
    },
  );
  const executionReceipt = Object.freeze({ ...executionPayload, receiptHash: executionReceiptHash, ledgerReceiptId: executionLedger.receiptId });
  return Object.freeze({
    status: 'trusted_formal_evidence_recorded', adapterReceipt,
    certificateRequest: Object.freeze({ paperId: paperTask.paperId, campaignId, researchSourceSnapshotHash, verifierKind: descriptor.kind, certificate: { kind: descriptor.certificateKind, certificateHash: certificateReceipt.hash, toolchainHash: certificatePayload.toolchainHash, artifactWriteReceipt: certificateReceipt, ledgerReceiptId: certificateReceipt.ledgerReceiptId }, sourceRecords, claimBindings, executionReceipt }),
    sandboxReceipt: execution, blockers: [],
  });
}
