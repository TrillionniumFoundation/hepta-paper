#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  inspectProviderSandboxCompanion, runProviderSandboxProcess, assertProviderSandboxResponseClaims,
} from '../../paper-composition/bootstrap/provider-sandbox-process-composition.mjs';
import { bootstrapSubmissionContext } from '../../paper-composition/bootstrap/capability-scoped-bootstrap.mjs';
import { createDefaultPaperStore } from '../../paper-composition/bootstrap/operator-persistence-composition.mjs';
import { defaultPaperRuntimeRoot } from '../src/workspace-layout.mjs';
import { currentCodeProvenance } from '../src/code-provenance.mjs';
import { signReleasePayload } from './release-integrity-signing.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

process.env.HEPTA_EVIDENCE_ENVIRONMENT = 'provider_sandbox';
process.env.HEPTA_EVIDENCE_CLASS = 'technical_sandbox';
const runtimeRoot = defaultPaperRuntimeRoot();
const paperId = process.argv[2] || 'A_Theory_of__Expectations';
const priorPath = path.join(runtimeRoot, 'pilots', paperId, 'REAL_PAPER_END_TO_END_PILOT_RECEIPT.json');
if (!fs.existsSync(priorPath)) throw new Error(`Real paper pilot receipt missing: ${priorPath}`);
const prior = JSON.parse(fs.readFileSync(priorPath, 'utf8'));
const sandboxEntry = fileURLToPath(new URL(
  '../../../hepta-paper-provider-sandbox/provider-sandbox.mjs', import.meta.url,
));
inspectProviderSandboxCompanion(sandboxEntry);
const verificationRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'real-paper-provider-sandbox-'));
let context;
let receipt;
try {
  const verificationAssetRoot = path.join(verificationRoot, 'assets');
  const verificationRuntimeRoot = path.join(verificationRoot, 'runtime');
  fs.mkdirSync(verificationAssetRoot, { recursive: true });
  createDefaultPaperStore({ root: verificationAssetRoot, runtimeRoot: verificationRuntimeRoot }).close();
  context = bootstrapSubmissionContext({
    root: verificationAssetRoot,
    runtimeRoot: verificationRuntimeRoot,
    mode: 'provider-sandbox-submission',
    execute: true,
  });
  const delivery = context.services.submissionDeliveryStore;
  const dispatchPayload = { version: 1, kind: 'SubmissionDispatchAuthorization', status: 'submission_dispatch_authorization_ready', paperId, provider: 'sandbox-provider', accountId: 'sandbox-account', nonce: `sandbox-${prior.realPaperEndToEndPilotReceiptHash}` };
  const dispatchAuthorization = { ...dispatchPayload, submissionDispatchAuthorizationHash: hashRecord('SubmissionDispatchAuthorization', dispatchPayload) };
  const outbox = delivery.enqueue({ paperId, dispatchAuthorization, payload: { packageHash: prior.mainTexHash, realPilotReceiptHash: prior.realPaperEndToEndPilotReceiptHash } });
  const response = runProviderSandboxProcess({
    companionEntry: sandboxEntry,
    runtimeRoot: verificationRuntimeRoot,
    request: { environment: 'provider_sandbox', liveActionAllowed: false,
      provider: dispatchAuthorization.provider, accountId: dispatchAuthorization.accountId,
      paperId, dispatchAuthorizationHash: dispatchAuthorization.submissionDispatchAuthorizationHash,
      packageHash: prior.mainTexHash },
  });
  assertProviderSandboxResponseClaims(response, dispatchAuthorization.submissionDispatchAuthorizationHash);
  delivery.recordResponse({ messageId: outbox.message_id, response });
  const lock = delivery.acquireReleaseLock({ paperId, messageId: outbox.message_id, lockToken: `sandbox-lock-${process.pid}` });
  const reconciliationHash = hashRecord('SandboxSubmissionReconciliation', { paperId, providerReceiptHash: response.providerReceiptHash, productionEligible: false });
  const released = delivery.release({ paperId, lockToken: lock.lock_token, releaseLock: { status: 'submission_release_unlocked', reconciliationHash } });
  const payload = {
    version: 1,
    kind: 'RealPaperProviderSandboxReceipt',
    status: 'real_paper_provider_sandbox_passed_production_lane_blocked',
    codeProvenance: currentCodeProvenance(),
    paperId,
    priorPilotReceiptHash: prior.realPaperEndToEndPilotReceiptHash,
    productionBlockers: prior.blockers,
    dispatchAuthorizationHash: dispatchAuthorization.submissionDispatchAuthorizationHash,
    providerReceiptHash: response.providerReceiptHash,
    reconciliationHash,
    releaseStatus: released.status,
    environment: 'provider_sandbox',
    evidenceClass: 'technical_sandbox',
    productionEligible: false,
    ownerAcceptanceInferred: false,
    authorityInferred: false,
    externalActionPerformed: false,
    createdAt: new Date().toISOString(),
  };
  receipt = { ...payload, realPaperProviderSandboxReceiptHash: hashRecord('RealPaperProviderSandboxReceipt', payload) };
  const signature = signReleasePayload(receipt, runtimeRoot);
  const target = path.join(runtimeRoot, 'pilots', paperId, 'REAL_PAPER_PROVIDER_SANDBOX_RECEIPT.json');
  fs.writeFileSync(target, `${JSON.stringify({ ...receipt, signature }, null, 2)}\n`);
} finally {
  try { context?.services.persistenceSession.close(); }
  finally { fs.rmSync(verificationRoot, { recursive: true, force: true }); }
}
process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
