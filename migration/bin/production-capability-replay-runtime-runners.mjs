import fsp from 'node:fs/promises';
import path from 'node:path';
import { createOsSandboxedWorkerRunner } from '../../paper-adapters/runtime/os-sandboxed-worker-runner.mjs';
import { probeOsSandbox } from '../../paper-adapters/runtime/sandbox-backend-probe.mjs';
import { createFilesystemArtifactRepository } from '../../paper-adapters/artifacts/filesystem-artifact-repository.mjs';
import { verifyArtifactWriteReceiptSource } from '../../paper-adapters/artifacts/artifact-write-receipt-verifier.mjs';
import { createSqliteJobReceiptStore } from '../../paper-adapters/persistence/sqlite-job-receipt-store.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

export function createRuntimeCapabilityReplayRunners({
  clock,
  createLedger,
  createStore,
  mainTexHash,
  paperId,
  seal,
}) {
  async function replaySandbox(root) {
    await fsp.writeFile(path.join(root, 'source.txt'), `${paperId}\n${mainTexHash}\n`);
    const probe = probeOsSandbox({ refresh: true });
    const runner = createOsSandboxedWorkerRunner({ allowedExecutables: ['/usr/bin/true'], allowedRoots: [root], probe });
    const receipt = runner.run({ executable: '/usr/bin/true', cwd: root, sourceRoot: root, outputPaths: [], timeoutMs: 120000 });
    if (receipt.status !== 'os_sandbox_worker_passed') throw new Error(`operational OS sandbox unavailable:${(receipt.blockers || []).join(',')}`);
    return { status: receipt.status, backend: receipt.backend, exitCode: receipt.exitCode, sourceMerkleHashBefore: receipt.sourceMerkleHashBefore, sourceMerkleHashAfter: receipt.sourceMerkleHashAfter, isolation: receipt.isolation, externalActionPerformed: receipt.externalActionPerformed };
  }

  async function replayArtifactRepository(root) {
    const store = createStore(root);
    const ledger = createLedger(store, { writerId: 'operational-artifact-repository', writerKind: 'content-addressed-repository', allowedKinds: ['ArtifactWriteReceipt'], allowedStreams: ['artifact-writes'] });
    const repository = createFilesystemArtifactRepository({ scopeRoot: root, casRoot: path.join(root, 'cas'), repositoryId: 'operational-artifact-cas', receiptLedger: ledger, clock });
    const receipt = await repository.writeJson(path.join(root, 'production-subject.json'), { paperId, mainTexHash }, { role: 'operational-capability-replay' });
    const verification = verifyArtifactWriteReceiptSource({ receipt });
    const manifest = await repository.readManifest(receipt.manifestHash);
    const result = { atomic: receipt.atomic, immutableObject: receipt.immutableObject, contentHash: receipt.hash, manifestHash: receipt.manifestHash, manifestContentHash: manifest.contentHash, sourceVerificationStatus: verification.status, externalActionPerformed: receipt.externalActionPerformed };
    store.close?.();
    return result;
  }

  async function replayJobReceiptStore(root) {
    const store = createStore(root);
    const ledger = createLedger(store, { writerId: 'operational-job-store', writerKind: 'job-receipt-store', allowedKinds: ['OperationalJobResultReceipt'], allowedStreams: ['jobs'] });
    const jobs = createSqliteJobReceiptStore({ store, receiptLedger: ledger, clock });
    const jobId = `operational-job:${paperId}`;
    jobs.createJob({ jobId, deduplicationKey: hashRecord('OperationalJobDeduplication', { paperId, mainTexHash }), kind: 'operational-capability-replay', paperId, environment: 'production', evidenceClass: 'operational' });
    const lease = jobs.acquireLease({ jobId, workerId: 'operational-worker' });
    const attempt = jobs.recordAttempt({ jobId, workerId: 'operational-worker', leaseGeneration: lease.leaseGeneration });
    const completed = jobs.completeJob({ jobId, attemptId: attempt.attemptId, workerId: 'operational-worker', leaseGeneration: attempt.leaseGeneration, receipt: seal('OperationalJobResultReceipt', { status: 'operational_job_completed', paperId, mainTexHash }, 'jobReceiptHash') });
    const result = { leaseStatus: lease.status, attemptId: attempt.attemptId, attemptNumber: attempt.attemptNumber, completedStatus: completed.status, attemptCount: completed.attemptCount, environment: completed.environment, evidenceClass: completed.evidence_class };
    store.close?.();
    return result;
  }

  return Object.freeze({
    'runtime.sandboxed-worker-runner': replaySandbox,
    'runtime.artifact-repository': replayArtifactRepository,
    'runtime.job-receipt-store': replayJobReceiptStore,
  });
}
