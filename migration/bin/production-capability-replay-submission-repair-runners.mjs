import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { assertSubmissionExecutorPort, submissionExecutorDescriptor } from '../../paper-ports/submission-executor-port.mjs';
import { buildExecutorCapabilities } from '../../paper-ports/executor-capabilities.mjs';
import { createSqliteSubmissionDeliveryStore } from '../../paper-adapters/submission/sqlite-delivery-store.mjs';
import { buildSubmissionReleaseLock } from '../../paper-domain/submission/release-lock.mjs';
import { buildRepairApplyProof, rollbackAppliedPatches, validateAndMaybeApplyPatches } from '../../paper-adapters/referee-revise/repair-executor.mjs';
import { sha256File } from '../../workflow-kernel/runtime/file-utils.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

export function createSubmissionRepairCapabilityReplayRunners({
  clock,
  createLedger,
  createStore,
  fixedIso,
  mainTexHash,
  paperId,
  paperTask,
}) {
  async function replaySubmissionExecutorPort(root) {
    const executorId = 'operational-submission-executor';
    const capabilities = () => buildExecutorCapabilities({ executorId, sandboxModes: ['provider-workspace'], networkPolicy: 'provider-scoped', externalActions: true, workspaceIsolation: true, receiptKinds: ['SubmissionProviderReceipt'], provider: 'operational-dry-run-provider' });
    const executor = assertSubmissionExecutorPort({ executorId, provider: 'operational-dry-run-provider', accountId: 'operational-owner-account', workspaceRoot: path.join(root, 'external-provider-workspace'), externalWorkspace: true, capabilities, dispatch: ({ execute = false } = {}) => ({ status: execute ? 'external_execution_forbidden_in_replay' : 'provider_dispatch_dry_run_verified', externalActionPerformed: false }) });
    const descriptor = submissionExecutorDescriptor(executor);
    const dispatch = executor.dispatch({ execute: false });
    return { descriptorHash: descriptor.submissionExecutorDescriptorHash, capabilitiesHash: descriptor.capabilitiesHash, networkPolicy: descriptor.capabilities.networkPolicy, workspaceIsolation: descriptor.capabilities.workspaceIsolation, dispatchStatus: dispatch.status, externalActionPerformed: dispatch.externalActionPerformed };
  }

  async function replaySubmissionDelivery(root) {
    const store = createStore(root);
    const ledger = createLedger(store, { writerId: 'operational-submission-delivery', writerKind: 'submission-delivery-store', allowedKinds: ['SubmissionResponsePersistedReceipt'], allowedStreams: ['submission-delivery'] });
    const delivery = createSqliteSubmissionDeliveryStore({ store, receiptLedger: ledger, clock });
    const dispatchAuthorization = { status: 'submission_dispatch_authorization_ready', submissionDispatchAuthorizationHash: hashRecord('OperationalSubmissionDispatch', { paperId, mainTexHash }), provider: 'operational-dry-run-provider', accountId: 'operational-owner-account', nonce: 'operational-nonce-1', attempt: 1 };
    const message = delivery.enqueue({ paperId, dispatchAuthorization, payload: { operationalReplay: true } });
    const response = { responseId: 'operational-response-1', outcome: 'failed', dispatchAuthorizationHash: dispatchAuthorization.submissionDispatchAuthorizationHash, provider: dispatchAuthorization.provider, accountId: dispatchAuthorization.accountId, performedAt: fixedIso, attempt: 1 };
    const persisted = delivery.recordResponse({ messageId: message.message_id, response });
    const outbox = delivery.getOutbox(message.message_id);
    const consumption = delivery.getResponseConsumption(response.responseId);
    const duplicate = delivery.recordResponse({ messageId: message.message_id, response });
    const result = { persistedReceiptHash: persisted.receiptHash, duplicateReceiptHash: duplicate.receiptHash, sameReceipt: persisted.receiptHash === duplicate.receiptHash, outboxStatus: outbox.status, responseConsumptionState: consumption.state, recoverPendingCount: delivery.recoverPending().length };
    store.close?.();
    return result;
  }

  async function replaySubmissionReleaseLock() {
    const dispatchAuthorization = { status: 'submission_dispatch_authorization_ready', submissionDispatchAuthorizationHash: hashRecord('OperationalSubmissionDispatch', { paperId, mainTexHash }) };
    const responseIntake = { status: 'executor_response_accepted', outcome: 'failed', executorResponseIntakeHash: hashRecord('OperationalResponseIntake', { paperId, mainTexHash }), responseEnvelopeHash: hashRecord('OperationalResponseEnvelope', { paperId }), providerReceiptHash: null, submissionId: null };
    const reconciliation = { status: 'dry_run_reconciled', submissionReconciliationHash: hashRecord('OperationalDryRunReconciliation', { paperId, mainTexHash }) };
    const unlocked = buildSubmissionReleaseLock({ paperTask, dispatchAuthorization, responseIntake, reconciliation });
    const blocked = buildSubmissionReleaseLock({ paperTask });
    return { unlockedStatus: unlocked.status, unlockedHash: unlocked.submissionReleaseLockHash, missingEvidenceStatus: blocked.status, missingEvidenceBlockers: [...blocked.blockers].sort() };
  }

  async function replayRepairSafeApply(root) {
    const paperRoot = path.join(root, 'paper');
    await fsp.mkdir(paperRoot, { recursive: true });
    const target = path.join(paperRoot, 'main.tex');
    const patchPath = path.join(root, 'change.patch');
    await fsp.writeFile(target, `production-source:${mainTexHash}\n`);
    await fsp.writeFile(patchPath, ['diff --git a/paper/main.tex b/paper/main.tex', '--- a/paper/main.tex', '+++ b/paper/main.tex', '@@ -1 +1 @@', `-production-source:${mainTexHash}`, `+production-source:${mainTexHash} operational-replay`, ''].join('\n'));
    spawnSync('git', ['init', '-q'], { cwd: root });
    spawnSync('git', ['config', 'user.email', 'operational-replay@example.invalid'], { cwd: root });
    spawnSync('git', ['config', 'user.name', 'Hepta Operational Replay'], { cwd: root });
    spawnSync('git', ['add', 'paper/main.tex'], { cwd: root });
    const commit = spawnSync('git', ['commit', '-qm', 'operational baseline'], { cwd: root, encoding: 'utf8' });
    if (commit.status !== 0) throw new Error(commit.stderr || 'operational repair baseline commit failed');
    const preimageHash = await sha256File(target);
    const patchHash = await sha256File(patchPath);
    const row = { task: { paperId, sourceWorkspace: 'paper' } };
    const preimageSnapshotLedger = { preimageSnapshotLedgerHash: hashRecord('OperationalPreimageLedger', { paperId, preimageHash }), entries: [{ targetPath: 'paper/main.tex', exists: true, preimageHash }] };
    const execution = { plannedPatchInputs: [{ patchId: 'operational-change', patchPath: 'change.patch', patchSha256: patchHash, targetPaths: ['paper/main.tex'] }] };
    const dryRun = await validateAndMaybeApplyPatches({ root, row, patchApplyExecution: execution, preimageSnapshotLedger, execute: false });
    const applied = await validateAndMaybeApplyPatches({ root, row, patchApplyExecution: execution, preimageSnapshotLedger, execute: true });
    const proof = buildRepairApplyProof({ row, preimageSnapshotLedger, patchApplyResult: applied });
    const rollback = await rollbackAppliedPatches({ root, row, patchApplyResult: applied });
    const restoredHash = await sha256File(target);
    return { dryRunBlockerCount: dryRun.blockers.length, cleanApplyCheck: dryRun.validationRecords[0]?.cleanApplyCheck, applied: applied.applied, proofStatus: proof.status, rollbackStatus: rollback.status, restoredHash, preimageHash, sourceRestored: restoredHash === preimageHash };
  }

  return Object.freeze({
    'submission.executor-port': replaySubmissionExecutorPort,
    'submission.delivery-runtime': replaySubmissionDelivery,
    'submission.release-lock': (_root) => replaySubmissionReleaseLock(),
    'repair.safe-apply': replayRepairSafeApply,
  });
}
