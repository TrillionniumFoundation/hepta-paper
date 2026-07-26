import fs from 'node:fs';
import path from 'node:path';

import {
  strictFullAutoAcceptanceHash,
} from '../../paper-domain/automation/strict-full-auto-acceptance-contract.mjs';
import {
  planControlScopePath,
  runtimeRootActivation,
} from './strict-full-auto-acceptance-control-paths.mjs';
import {
  assertPlanControlRoot,
  atomicJsonWrite,
  ensureScopedDirectory,
  exclusiveJsonPublish,
  hashDocument,
  parseJsonFile,
  secureDirectory,
  verifyHashedDocument,
} from './strict-full-auto-acceptance-control-file-repository.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;

export class StrictFullAutoAcceptancePlanControlStore {
  legacyStatePath(plan) { return path.join(plan.controlRoot, 'state.json'); }

  legacyReceiptPath(plan) { return path.join(plan.controlRoot, 'acceptance-receipt.json'); }

  legacyRuntimeRootActivationPath(plan) {
    return path.join(plan.controlRoot, 'runtime-root-activation.json');
  }

  isLegacyPlan(plan) {
    const candidate = this.legacyStatePath(plan);
    if (!fs.existsSync(candidate)) return false;
    const scope = planControlScopePath(plan);
    if (fs.existsSync(scope)) secureDirectory(scope);
    return parseJsonFile(candidate, 'legacy_state').planHash === plan.planHash
      && !fs.existsSync(path.join(scope, 'state.json'));
  }

  planScopePath(plan) { return planControlScopePath(plan); }

  ensurePlanScope(plan, { lease } = {}) {
    if (!lease) throw new Error('strict_full_auto_acceptance_plan_scope_lease_required');
    this.assertLease(plan, lease);
    const plans = ensureScopedDirectory(assertPlanControlRoot(plan), 'plans');
    const scope = ensureScopedDirectory(plans, plan.planHash.slice('sha256:'.length));
    this.assertLease(plan, lease);
    return scope;
  }

  statePath(plan) {
    return this.isLegacyPlan(plan)
      ? this.legacyStatePath(plan) : path.join(this.planScopePath(plan), 'state.json');
  }

  receiptPath(plan) {
    return this.isLegacyPlan(plan)
      ? this.legacyReceiptPath(plan)
      : path.join(this.planScopePath(plan), 'acceptance-receipt.json');
  }

  runtimeRootActivationPath(plan) {
    return this.isLegacyPlan(plan)
      ? this.legacyRuntimeRootActivationPath(plan)
      : path.join(this.planScopePath(plan), 'runtime-root-activation.json');
  }

  candidatePath(plan) { return path.join(this.planScopePath(plan), 'candidate.json'); }

  activePlanPath(plan) { return path.join(plan.controlRoot, 'active-plan.json'); }

  dispositionPath(plan, planHash = plan.planHash) {
    if (!SHA256.test(String(planHash || ''))) {
      throw new Error('strict_full_auto_acceptance_plan_disposition_hash_invalid');
    }
    return path.join(
      plan.controlRoot,
      'plan-dispositions',
      `${planHash.slice('sha256:'.length)}.json`,
    );
  }

  readActivePlan(plan) {
    assertPlanControlRoot(plan);
    const selectedPath = this.activePlanPath(plan);
    if (!fs.existsSync(selectedPath)) return null;
    const pointer = verifyHashedDocument(parseJsonFile(selectedPath, 'active_plan'), {
      keys: [
        'version', 'kind', 'generation', 'activePlanHash', 'previousActivePlanHash',
        'liveVerificationReceiptHash', 'promotedAt',
      ],
      hashField: 'activePlanPointerHash',
      label: 'active_plan',
    });
    if (pointer.version !== 1
      || pointer.kind !== 'StrictFullAutoAcceptanceActivePlan'
      || !Number.isSafeInteger(pointer.generation) || pointer.generation < 1
      || !SHA256.test(String(pointer.activePlanHash || ''))
      || (pointer.previousActivePlanHash !== null
        && !SHA256.test(String(pointer.previousActivePlanHash || '')))
      || !SHA256.test(String(pointer.liveVerificationReceiptHash || ''))
      || !Number.isFinite(Date.parse(pointer.promotedAt))) {
      throw new Error('strict_full_auto_acceptance_active_plan_invalid');
    }
    return pointer;
  }

  effectiveActivePlanHash(plan) {
    const pointer = this.readActivePlan(plan);
    if (pointer) return pointer.activePlanHash;
    const legacy = this.legacyStatePath(plan);
    if (!fs.existsSync(legacy)) return null;
    const state = parseJsonFile(legacy, 'legacy_state');
    return SHA256.test(String(state.planHash || '')) ? state.planHash : null;
  }

  readPlanDisposition(plan, planHash = plan.planHash) {
    assertPlanControlRoot(plan);
    const selectedPath = this.dispositionPath(plan, planHash);
    if (!fs.existsSync(selectedPath)) return null;
    const disposition = verifyHashedDocument(
      parseJsonFile(selectedPath, 'plan_disposition'),
      {
        keys: [
          'version', 'kind', 'fromPlanHash', 'toPlanHash', 'candidateHash',
          'liveVerificationReceiptHash', 'leaseGeneration', 'fenceToken', 'supersededAt',
        ],
        hashField: 'dispositionHash',
        label: 'plan_disposition',
      },
    );
    if (disposition.version !== 1
      || disposition.kind !== 'StrictFullAutoAcceptancePlanSupersession'
      || disposition.fromPlanHash !== planHash
      || !SHA256.test(String(disposition.toPlanHash || ''))
      || !SHA256.test(String(disposition.candidateHash || ''))
      || !SHA256.test(String(disposition.liveVerificationReceiptHash || ''))
      || !Number.isSafeInteger(disposition.leaseGeneration)
      || disposition.leaseGeneration < 1
      || !SHA256.test(String(disposition.fenceToken || ''))
      || !Number.isFinite(Date.parse(disposition.supersededAt))) {
      throw new Error('strict_full_auto_acceptance_plan_disposition_invalid');
    }
    return disposition;
  }

  readCandidate(plan) {
    assertPlanControlRoot(plan);
    const selectedPath = this.candidatePath(plan);
    if (!fs.existsSync(selectedPath)) return null;
    const candidate = verifyHashedDocument(parseJsonFile(selectedPath, 'candidate'), {
      keys: [
        'version', 'kind', 'planHash', 'baseActivePlanHash', 'createdAt',
        'createdLeaseGeneration', 'createdFenceToken',
      ],
      hashField: 'candidateHash',
      label: 'candidate',
    });
    if (candidate.version !== 1
      || candidate.kind !== 'StrictFullAutoAcceptanceCandidatePlan'
      || candidate.planHash !== plan.planHash
      || (candidate.baseActivePlanHash !== null
        && !SHA256.test(String(candidate.baseActivePlanHash || '')))
      || !Number.isFinite(Date.parse(candidate.createdAt))
      || !Number.isSafeInteger(candidate.createdLeaseGeneration)
      || candidate.createdLeaseGeneration < 1
      || !SHA256.test(String(candidate.createdFenceToken || ''))) {
      throw new Error('strict_full_auto_acceptance_candidate_invalid');
    }
    return candidate;
  }

  ensureCandidate(plan, { lease, now = new Date() } = {}) {
    this.assertLease(plan, lease);
    if (this.readPlanDisposition(plan)) {
      throw new Error('strict_full_auto_acceptance_superseded_plan_reactivation_forbidden');
    }
    this.ensurePlanScope(plan, { lease });
    const activePlanHash = this.effectiveActivePlanHash(plan);
    const activeDisposition = activePlanHash
      ? this.readPlanDisposition(plan, activePlanHash) : null;
    if (activeDisposition && activeDisposition.toPlanHash !== plan.planHash) {
      throw new Error('strict_full_auto_acceptance_active_plan_supersession_in_progress');
    }
    const existing = this.readCandidate(plan);
    if (existing) {
      if (activePlanHash !== plan.planHash
        && existing.baseActivePlanHash !== activePlanHash) {
        throw new Error('strict_full_auto_acceptance_candidate_base_changed');
      }
      return existing;
    }
    const body = Object.freeze({
      version: 1,
      kind: 'StrictFullAutoAcceptanceCandidatePlan',
      planHash: plan.planHash,
      baseActivePlanHash: activePlanHash,
      createdAt: new Date(now).toISOString(),
      createdLeaseGeneration: lease.generation,
      createdFenceToken: lease.fenceToken,
    });
    const candidate = hashDocument(body, 'candidateHash');
    try { exclusiveJsonPublish(this.candidatePath(plan), candidate); }
    catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    const recorded = this.readCandidate(plan);
    if (recorded.candidateHash !== candidate.candidateHash) {
      throw new Error('strict_full_auto_acceptance_candidate_no_clobber_conflict');
    }
    this.assertLease(plan, lease);
    return recorded;
  }

  planDisposition(plan) {
    const supersession = this.readPlanDisposition(plan);
    if (supersession) {
      return Object.freeze({
        status: 'superseded',
        activePlanHash: supersession.toPlanHash,
        supersededByPlanHash: supersession.toPlanHash,
      });
    }
    const activePlanHash = this.effectiveActivePlanHash(plan);
    return Object.freeze({
      status: activePlanHash === plan.planHash ? 'active' : 'candidate',
      activePlanHash,
      supersededByPlanHash: null,
    });
  }

  writeLiveReceipt(plan, receipt, { lease }) {
    this.assertLease(plan, lease);
    if (receipt?.planHash !== plan.planHash
      || receipt.strictFullAutoAccepted !== true
      || !SHA256.test(String(receipt.receiptHash || ''))) {
      throw new Error('strict_full_auto_acceptance_live_receipt_invalid');
    }
    const { receiptHash, ...body } = receipt;
    if (strictFullAutoAcceptanceHash(body) !== receiptHash) {
      throw new Error('strict_full_auto_acceptance_live_receipt_invalid');
    }
    this.ensurePlanScope(plan, { lease });
    const directory = ensureScopedDirectory(this.planScopePath(plan), 'live-receipts');
    const selectedPath = path.join(directory, `${receiptHash.slice('sha256:'.length)}.json`);
    try { exclusiveJsonPublish(selectedPath, receipt); }
    catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const existing = parseJsonFile(selectedPath, 'live_receipt');
      if (existing.receiptHash !== receiptHash) {
        throw new Error('strict_full_auto_acceptance_live_receipt_no_clobber_conflict');
      }
    }
    this.assertLease(plan, lease);
    return receipt;
  }

  ensureRenewalIntent(plan, step, {
    lease,
    checkpointReceiptHash,
  } = {}) {
    this.assertLease(plan, lease);
    if (!SHA256.test(String(checkpointReceiptHash || ''))) {
      throw new Error('strict_full_auto_acceptance_renewal_checkpoint_invalid');
    }
    this.ensurePlanScope(plan, { lease });
    const directory = ensureScopedDirectory(this.planScopePath(plan), 'renewals');
    const selectedPath = path.join(
      directory,
      `${String(lease.generation).padStart(12, '0')}-${step.stepId}.json`,
    );
    const body = Object.freeze({
      version: 1,
      kind: 'StrictFullAutoAcceptanceRenewalIntent',
      planHash: plan.planHash,
      checkpointReceiptHash,
      stepId: step.stepId,
      stepDefinitionHash: strictFullAutoAcceptanceHash(step),
      idempotencyKey: step.idempotencyKey,
      leaseGeneration: lease.generation,
      fenceToken: lease.fenceToken,
    });
    const intent = hashDocument(body, 'renewalIntentHash');
    try { exclusiveJsonPublish(selectedPath, intent); }
    catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const existing = parseJsonFile(selectedPath, 'renewal_intent');
      if (existing.renewalIntentHash !== intent.renewalIntentHash) {
        throw new Error('strict_full_auto_acceptance_renewal_intent_no_clobber_conflict');
      }
    }
    this.assertLease(plan, lease);
    return intent;
  }

  promoteCandidate(plan, liveReceipt, { lease, now = new Date() } = {}) {
    this.assertLease(plan, lease);
    const { receiptHash: claimedLiveReceiptHash, ...liveReceiptBody } = liveReceipt || {};
    if (liveReceipt?.planHash !== plan.planHash
      || liveReceipt.strictFullAutoAccepted !== true
      || !SHA256.test(String(claimedLiveReceiptHash || ''))
      || claimedLiveReceiptHash !== strictFullAutoAcceptanceHash(liveReceiptBody)) {
      throw new Error('strict_full_auto_acceptance_candidate_promotion_receipt_invalid');
    }
    const candidate = this.readCandidate(plan);
    if (!candidate) throw new Error('strict_full_auto_acceptance_candidate_missing');
    const existingPointer = this.readActivePlan(plan);
    const activePlanHash = this.effectiveActivePlanHash(plan);
    if (activePlanHash !== plan.planHash
      && candidate.baseActivePlanHash !== activePlanHash) {
      throw new Error('strict_full_auto_acceptance_candidate_base_changed');
    }
    const promotedAt = new Date(now).toISOString();
    if (activePlanHash && activePlanHash !== plan.planHash) {
      ensureScopedDirectory(assertPlanControlRoot(plan), 'plan-dispositions');
      const body = Object.freeze({
        version: 1,
        kind: 'StrictFullAutoAcceptancePlanSupersession',
        fromPlanHash: activePlanHash,
        toPlanHash: plan.planHash,
        candidateHash: candidate.candidateHash,
        liveVerificationReceiptHash: liveReceipt.receiptHash,
        leaseGeneration: lease.generation,
        fenceToken: lease.fenceToken,
        supersededAt: promotedAt,
      });
      const disposition = hashDocument(body, 'dispositionHash');
      const selectedPath = this.dispositionPath(plan, activePlanHash);
      try { exclusiveJsonPublish(selectedPath, disposition); }
      catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        const existing = this.readPlanDisposition(plan, activePlanHash);
        if (existing.toPlanHash !== plan.planHash
          || existing.candidateHash !== candidate.candidateHash) {
          throw new Error('strict_full_auto_acceptance_plan_supersession_conflict');
        }
      }
    }
    const generation = (existingPointer?.generation || 0) + 1;
    const pointerBody = Object.freeze({
      version: 1,
      kind: 'StrictFullAutoAcceptanceActivePlan',
      generation,
      activePlanHash: plan.planHash,
      previousActivePlanHash: activePlanHash === plan.planHash
        ? (existingPointer?.previousActivePlanHash || null) : activePlanHash,
      liveVerificationReceiptHash: liveReceipt.receiptHash,
      promotedAt,
    });
    const pointer = hashDocument(pointerBody, 'activePlanPointerHash');
    atomicJsonWrite(this.activePlanPath(plan), pointer);
    this.assertLease(plan, lease);
    return this.readActivePlan(plan);
  }

  prepareCandidateRuntimeRootActivation(plan, { lease }) {
    this.assertLease(plan, lease);
    const candidate = this.readCandidate(plan);
    const predecessor = candidate?.baseActivePlanHash;
    if (!predecessor || predecessor === plan.planHash) return null;
    const scopedPath = path.join(
      plan.controlRoot,
      'plans',
      predecessor.slice('sha256:'.length),
      'runtime-root-activation.json',
    );
    let predecessorPath = fs.existsSync(scopedPath) ? scopedPath : null;
    if (!predecessorPath && fs.existsSync(this.legacyRuntimeRootActivationPath(plan))) {
      const legacy = parseJsonFile(
        this.legacyRuntimeRootActivationPath(plan),
        'legacy_runtime_root_activation',
      );
      if (legacy.planHash === predecessor) predecessorPath = this.legacyRuntimeRootActivationPath(plan);
    }
    if (!predecessorPath) return null;
    const recorded = parseJsonFile(predecessorPath, 'predecessor_runtime_root_activation');
    const { runtimeRootActivationHash, ...recordedBody } = recorded;
    if (recorded.planHash !== predecessor
      || runtimeRootActivationHash !== strictFullAutoAcceptanceHash(recordedBody)) {
      throw new Error('strict_full_auto_acceptance_predecessor_runtime_root_activation_invalid');
    }
    if (recorded.resolvedPath !== path.resolve(plan.runtimeRoot)) return null;
    const observed = runtimeRootActivation(plan);
    for (const field of [
      'resolvedPath', 'device', 'inode', 'mode', 'uid', 'gid',
    ]) {
      if (recorded[field] !== observed[field]) {
        throw new Error('strict_full_auto_acceptance_supersession_runtime_root_identity_changed');
      }
    }
    this.ensurePlanScope(plan, { lease });
    try { exclusiveJsonPublish(this.runtimeRootActivationPath(plan), observed); }
    catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    const adopted = this.readRuntimeRootActivation(plan);
    this.assertLease(plan, lease);
    return adopted;
  }
}
