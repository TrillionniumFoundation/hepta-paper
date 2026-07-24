import fs from 'node:fs';
import path from 'node:path';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import { isPathWithin } from '../../workflow-kernel/runtime/path-utils.mjs';
import { readScopedFileSync } from '../../workflow-kernel/runtime/scoped-file-identity.mjs';
import {
  inspectWorkspaceExecutionSnapshot,
  sourceTreeExcludedNames,
} from '../runtime/execution-snapshot.mjs';
import {
  abortStagedScopedFileSync,
  commitStagedScopedFileSync,
  ensureScopedDirectorySync,
  stageScopedRegularFileCopySync,
} from '../runtime/scoped-file-materialization-repository.mjs';
import { assertWorkerRunnerPort } from '../../paper-ports/worker-runner-port.mjs';
import { createIndependentPdfRebuildVerifierCapability } from '../../paper-ports/independent-pdf-rebuild-verifier-port.mjs';
import {
  buildIndependentPdfRebuildCommand,
  buildIndependentPdfRebuildToolIdentity,
  buildIndependentPdfRebuildVerificationReceipt,
} from '../../paper-domain/automation/independent-pdf-rebuild-contract.mjs';
import {
  BOUNDED_PDF_PAGE_TREE_LIMITS,
  inspectDeterministicPdfPageTree,
} from '../../paper-domain/automation/deterministic-pdf-page-tree-parser.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/i;

function blocked(blockers) {
  return Object.freeze({
    version: 1,
    kind: 'IndependentPdfRebuildVerificationResult',
    status: 'independent_pdf_rebuild_blocked',
    receipt: null,
    rebuiltPdfPath: null,
    blockers: Object.freeze([...new Set(blockers.filter(Boolean).map(String))]),
  });
}

function workerReceiptValid(receipt, {
  sourceSnapshot,
  outputName,
  executionIdentity,
  limits,
} = {}) {
  if (!receipt || receipt.ok !== true || receipt.status !== 'os_sandbox_worker_passed'
    || receipt.exitCode !== 0 || receipt.sourceMutationDetected !== false
    || receipt.sourceMerkleHashBefore !== sourceSnapshot.merkleHash
    || receipt.sourceMerkleHashAfter !== sourceSnapshot.merkleHash
    || receipt.workSourceMerkleHash !== sourceSnapshot.merkleHash
    || receipt.sourceWorkspaceManifestHashBefore !== sourceSnapshot.manifestHash
    || receipt.sourceWorkspaceManifestHashAfter !== sourceSnapshot.manifestHash
    || receipt.workWorkspaceManifestHash !== sourceSnapshot.manifestHash
    || receipt.expectedSourceMerkleHash !== sourceSnapshot.merkleHash
    || receipt.expectedSourceWorkspaceManifestHash !== sourceSnapshot.manifestHash
    || receipt.runtimeIdentityHash !== executionIdentity.runtimeIdentityHash
    || receipt.executionProcessIdentity?.kind !== 'OsSandboxWorkerProcessIdentity'
    || receipt.executionProcessIdentityHash !== hashRecord('OsSandboxWorkerProcessIdentity', receipt.executionProcessIdentity)
    || receipt.isolation?.kernelNetworkIsolationVerified !== true
    || receipt.isolation?.filesystemNamespaceVerified !== true
    || receipt.isolation?.sourceReadOnlyVerified !== true
    || receipt.isolation?.ephemeralWorkRootVerified !== true
    || receipt.isolation?.separateOutputRootVerified !== true
    || receipt.isolation?.runtimeExecutableSnapshotVerified !== true
    || receipt.isolation?.resourceLimitsVerified !== true
    || receipt.externalActionPerformed !== false
    || JSON.stringify(receipt.declaredOutputPaths) !== JSON.stringify([outputName])
    || receipt.declaredOutputsRestrictedToSeparateRoot !== true
    || Number(receipt.limits?.timeoutMs) !== limits.timeoutMs
    || Number(receipt.limits?.memoryBytes) !== limits.memoryBytes
    || Number(receipt.limits?.cpuSeconds) !== limits.cpuSeconds
    || Number(receipt.limits?.maximumPids) !== limits.maximumPids
    || Number(receipt.limits?.maximumOutputBytes) !== limits.maximumOutputBytes) return false;
  const artifacts = receipt.artifacts || [];
  if (artifacts.length !== 1 || artifacts[0]?.path !== outputName
    || !SHA256.test(String(artifacts[0]?.sha256 || '')) || !Number.isSafeInteger(artifacts[0]?.bytes)) return false;
  const { receiptHash, blockers: _blockers, ok: _ok, ...payload } = receipt;
  return SHA256.test(String(receiptHash || ''))
    && hashRecord('OsSandboxWorkerReceipt', payload) === receiptHash;
}

function materializeBoundSource({ sourceWorkspace, rebuildRoot, sourceArchiveDefinition }) {
  const rows = sourceArchiveDefinition?.sourceTreeManifest?.rows || [];
  if (!rows.length) throw new Error('independent_pdf_rebuild_source_manifest_required');
  const sourceRoot = ensureScopedDirectorySync({ scopeRoot: rebuildRoot, relative: 'source' });
  const directories = [...new Set(rows.map((row) => path.posix.dirname(String(row.path || '')))
    .filter((relative) => relative && relative !== '.'))]
    .sort((left, right) => left.split('/').length - right.split('/').length || left.localeCompare(right));
  for (const relative of directories) ensureScopedDirectorySync({ scopeRoot: sourceRoot, relative });
  for (const row of rows) {
    let staged = null;
    try {
      staged = stageScopedRegularFileCopySync({
        sourceRoot: sourceWorkspace,
        destinationRoot: sourceRoot,
        relative: row.path,
        destinationRelative: row.path,
        stageId: `independent-pdf-rebuild-source:${hashRecord('IndependentPdfRebuildSourceFile', {
          sourceTreeManifestHash: sourceArchiveDefinition.sourceTreeManifestHash,
          path: row.path,
          hash: row.hash,
          bytes: row.bytes,
        })}`,
        expectedHash: null,
        destinationMode: 0o444,
      });
      if (staged.hash !== row.hash || Number(staged.bytes) !== Number(row.bytes)) {
        throw new Error(`independent_pdf_rebuild_source_changed:${row.path}`);
      }
      commitStagedScopedFileSync(staged, { destinationRoot: sourceRoot, expectedHash: null });
    } finally {
      abortStagedScopedFileSync(staged);
    }
  }
  const snapshot = inspectWorkspaceExecutionSnapshot(sourceRoot, {
    // Scoped materialization keeps its crash-recovery journal under the scope
    // root. It is verifier infrastructure, not an archived manuscript input.
    excludeNames: sourceTreeExcludedNames(sourceRoot),
  });
  if (snapshot.blockers.length || snapshot.merkleHash !== sourceArchiveDefinition.archivedSourceMerkleHash) {
    throw new Error(`independent_pdf_rebuild_source_snapshot_invalid:${snapshot.blockers.join(',')}`);
  }
  return Object.freeze({ sourceRoot, snapshot });
}

export function createIndependentPdfRebuildVerifier({
  workerRunner,
  runtimeRoot,
  clock = Object.freeze({ now: () => new Date() }),
  timeoutMs = 180_000,
  memoryBytes = 2 * 1024 * 1024 * 1024,
  cpuSeconds = 180,
  maximumPids = 128,
  maximumOutputBytes = 256 * 1024 * 1024,
} = {}) {
  const runner = assertWorkerRunnerPort(workerRunner);
  const configuredRuntimeRoot = path.resolve(runtimeRoot || '.');
  const limits = Object.freeze({ timeoutMs, memoryBytes, cpuSeconds, maximumPids, maximumOutputBytes });
  if (!Object.values(limits).every((value) => Number.isSafeInteger(value) && value > 0)) {
    throw new Error('independent_pdf_rebuild_limits_invalid');
  }
  return createIndependentPdfRebuildVerifierCapability(async ({
    sourceWorkspace,
    sourceArchiveDefinition,
    rebuildRoot,
    paperId,
    mainTex,
    authoritativePdf,
    createdAt = null,
    signal = null,
  } = {}) => {
    try {
      const resolvedSourceWorkspace = path.resolve(sourceWorkspace || '.');
      const resolvedRebuildRoot = path.resolve(rebuildRoot || '.');
      if (!isPathWithin(configuredRuntimeRoot, resolvedRebuildRoot)
        || resolvedRebuildRoot === configuredRuntimeRoot) throw new Error('independent_pdf_rebuild_root_outside_runtime');
      if (fs.existsSync(resolvedRebuildRoot)) throw new Error('independent_pdf_rebuild_root_already_exists');
      ensureScopedDirectorySync({
        scopeRoot: configuredRuntimeRoot,
        relative: path.relative(configuredRuntimeRoot, resolvedRebuildRoot).replace(/\\/g, '/'),
      });
      const { sourceRoot, snapshot } = materializeBoundSource({
        sourceWorkspace: resolvedSourceWorkspace,
        rebuildRoot: resolvedRebuildRoot,
        sourceArchiveDefinition,
      });
      const command = buildIndependentPdfRebuildCommand(mainTex);
      const mainSource = readScopedFileSync({ scopeRoot: sourceRoot, candidate: path.join(sourceRoot, command.arguments.at(-1)) });
      if (mainSource.status !== 'scoped_file_read_verified') throw new Error('independent_pdf_rebuild_main_tex_not_bound');
      const outputRoot = ensureScopedDirectorySync({ scopeRoot: resolvedRebuildRoot, relative: 'output' });
      const outputName = `${path.posix.basename(command.arguments.at(-1), '.tex')}.pdf`;
      const executionIdentity = runner.resolveExecutionRuntimeIdentity({ executable: 'latexmk' });
      const latexmkExecutableHash = executionIdentity.executableHash || executionIdentity.hostExecutableHash
        || executionIdentity.runtimeExecutableSnapshotHash || null;
      if (executionIdentity.available !== true || executionIdentity.allowlisted !== true
        || !SHA256.test(String(executionIdentity.runtimeIdentityHash || ''))
        || !SHA256.test(String(latexmkExecutableHash || ''))) {
        throw new Error('independent_pdf_rebuild_latexmk_identity_unavailable');
      }
      const workerReceipt = await runner.run({
        executable: 'latexmk',
        args: command.arguments,
        cwd: sourceRoot,
        sourceRoot,
        outputDirectory: outputRoot,
        outputPaths: [outputName],
        requireSeparateOutputRoot: true,
        timeoutMs: limits.timeoutMs,
        memoryBytes: limits.memoryBytes,
        cpuSeconds: limits.cpuSeconds,
        maximumProcesses: limits.maximumPids,
        requestedMaximumOutputBytes: limits.maximumOutputBytes,
        language: 'latex',
        determinismPolicy: 'pdf-output-may-contain-toolchain-timestamps',
        executionIdentity,
        expectedSourceMerkleHash: snapshot.merkleHash,
        expectedSourceWorkspaceManifestHash: snapshot.manifestHash,
        signal,
      });
      if (!workerReceiptValid(workerReceipt, { sourceSnapshot: snapshot, outputName, executionIdentity, limits })) {
        return blocked(['independent_pdf_rebuild_worker_receipt_invalid', ...(workerReceipt?.blockers || [])]);
      }
      const outputRead = readScopedFileSync({
        scopeRoot: outputRoot,
        candidate: path.join(outputRoot, outputName),
        maximumBytes: Math.min(
          limits.maximumOutputBytes,
          BOUNDED_PDF_PAGE_TREE_LIMITS.maximumPdfBytes,
        ),
      });
      const artifact = workerReceipt.artifacts[0];
      if (outputRead.status !== 'scoped_file_read_verified' || outputRead.hash !== artifact.sha256
        || Number(outputRead.bytes) !== Number(artifact.bytes)) {
        return blocked(['independent_pdf_rebuild_output_invalid']);
      }
      const authoritativePath = path.resolve(
        resolvedSourceWorkspace,
        String(authoritativePdf?.path || ''),
      );
      if (!isPathWithin(resolvedSourceWorkspace, authoritativePath)
        || authoritativePath === resolvedSourceWorkspace) {
        return blocked(['independent_pdf_rebuild_authoritative_pdf_invalid']);
      }
      const authoritativeRead = readScopedFileSync({
        scopeRoot: resolvedSourceWorkspace,
        candidate: authoritativePath,
        maximumBytes: BOUNDED_PDF_PAGE_TREE_LIMITS.maximumPdfBytes,
      });
      const authoritativeBytes = Number(
        authoritativePdf?.sizeBytes ?? authoritativePdf?.bytes,
      );
      if (authoritativeRead.status !== 'scoped_file_read_verified'
        || authoritativeRead.hash !== authoritativePdf?.hash
        || !Number.isSafeInteger(authoritativeBytes) || authoritativeBytes < 32
        || authoritativeBytes !== Number(authoritativeRead.bytes)) {
        return blocked(['independent_pdf_rebuild_authoritative_pdf_invalid']);
      }
      let rebuiltPdfInspection;
      let authoritativePdfInspection;
      try {
        rebuiltPdfInspection = inspectDeterministicPdfPageTree(outputRead.content);
      } catch (error) {
        return blocked([
          'independent_pdf_rebuild_rebuilt_pdf_semantic_invalid',
          error?.message,
        ]);
      }
      try {
        authoritativePdfInspection = inspectDeterministicPdfPageTree(
          authoritativeRead.content,
        );
      } catch (error) {
        return blocked([
          'independent_pdf_rebuild_authoritative_pdf_semantic_invalid',
          error?.message,
        ]);
      }
      if (rebuiltPdfInspection.pageCount !== authoritativePdfInspection.pageCount) {
        return blocked(['independent_pdf_rebuild_page_count_mismatch']);
      }
      const toolIdentity = buildIndependentPdfRebuildToolIdentity({
        runnerId: workerReceipt.runnerId,
        runtimeIdentityHash: workerReceipt.runtimeIdentityHash,
        runtimeType: executionIdentity.runtimeType,
        executionClass: executionIdentity.executionClass,
        latexmkExecutableHash,
        runtimeExecutableSnapshotHash: workerReceipt.runtimeExecutableSnapshotHash,
        containerImageDigest: workerReceipt.containerImageDigest,
      });
      const observedAt = createdAt || clock.now();
      const receipt = buildIndependentPdfRebuildVerificationReceipt({
        paperId,
        sourcePackageContractHash: sourceArchiveDefinition.sourcePackageContractHash,
        sourceTreeManifestHash: sourceArchiveDefinition.sourceTreeManifestHash,
        sourceMerkleHash: snapshot.merkleHash,
        sourceWorkspaceManifestHash: sourceArchiveDefinition.sourceWorkspaceManifestHash,
        materializedSourceWorkspaceManifestHash: snapshot.manifestHash,
        mainTex: command.arguments.at(-1),
        command,
        toolIdentity,
        workerReceiptHash: workerReceipt.receiptHash,
        executionProcessIdentityHash: workerReceipt.executionProcessIdentityHash,
        limits: workerReceipt.limits,
        rebuiltPdf: {
          path: outputName,
          hash: outputRead.hash,
          bytes: outputRead.bytes,
          pageCount: rebuiltPdfInspection.pageCount,
        },
        authoritativePdfHash: authoritativePdf?.hash,
        authoritativePdfPageCount: authoritativePdfInspection.pageCount,
        createdAt: observedAt,
      });
      return Object.freeze({
        version: 1,
        kind: 'IndependentPdfRebuildVerificationResult',
        status: 'independent_pdf_rebuild_verified',
        receipt,
        rebuiltPdfPath: path.join(outputRoot, outputName),
        blockers: Object.freeze([]),
      });
    } catch (error) {
      return blocked([error?.message || 'independent_pdf_rebuild_failed']);
    }
  });
}
