import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  strictFullAutoAcceptanceHash,
} from '../../paper-domain/automation/strict-full-auto-acceptance-contract.mjs';

import {
  dispatchPath,
  intentPath,
  legacyDispatchPath,
  legacyIntentPath,
  runtimeRootActivation,
} from './strict-full-auto-acceptance-control-paths.mjs';
import {
  assertPlanControlRoot,
  atomicJsonWrite,
  ensureScopedDirectory,
  exclusiveJsonCreate,
  exclusiveJsonPublish,
  fsyncDirectory,
  parseJsonFile,
} from './strict-full-auto-acceptance-control-file-repository.mjs';
import {
  StrictFullAutoAcceptancePlanControlStore,
} from './strict-full-auto-acceptance-plan-control-store.mjs';

const LEASE_TTL_MS = 60_000;
const SHA256 = /^sha256:[0-9a-f]{64}$/;

function processStartTime(pid) {
  try {
    const fields = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').trim().split(' ');
    return fields[21] || null;
  } catch { return null; }
}

function leaseOwnerAlive(lease) {
  try { process.kill(lease.pid, 0); } catch { return false; }
  return processStartTime(lease.pid) === lease.pidStartTime;
}

function leaseBody(value) {
  return {
    version: value.version,
    kind: value.kind,
    planHash: value.planHash,
    purpose: value.purpose,
    ownerId: value.ownerId,
    pid: value.pid,
    pidStartTime: value.pidStartTime,
    generation: value.generation,
    fenceToken: value.fenceToken,
    acquiredAt: value.acquiredAt,
    renewedAt: value.renewedAt,
    expiresAt: value.expiresAt,
  };
}

function verifyLeaseDocument(value) {
  const body = leaseBody(value || {});
  if (value?.version !== 1 || value.kind !== 'StrictFullAutoAcceptanceExclusiveLease'
    || !SHA256.test(String(value.planHash || ''))
    || !['execute', 'live-status'].includes(value.purpose)
    || typeof value.ownerId !== 'string' || value.ownerId.length < 16
    || !Number.isSafeInteger(value.pid) || value.pid < 1
    || typeof value.pidStartTime !== 'string' || value.pidStartTime.length === 0
    || !Number.isSafeInteger(value.generation) || value.generation < 1
    || !SHA256.test(String(value.fenceToken || ''))
    || !Number.isFinite(Date.parse(value.acquiredAt))
    || !Number.isFinite(Date.parse(value.renewedAt))
    || !Number.isFinite(Date.parse(value.expiresAt))
    || Date.parse(value.expiresAt) <= Date.parse(value.renewedAt)
    || value.leaseHash !== strictFullAutoAcceptanceHash(body)) {
    throw new Error('strict_full_auto_acceptance_lease_document_invalid');
  }
  return value;
}

function leaseDocument({ plan, purpose, generation, ownerId, acquiredAt, now }) {
  const renewedAt = now.toISOString();
  const body = Object.freeze({
    version: 1,
    kind: 'StrictFullAutoAcceptanceExclusiveLease',
    planHash: plan.planHash,
    purpose,
    ownerId,
    pid: process.pid,
    pidStartTime: processStartTime(process.pid) || `pid-${process.pid}`,
    generation,
    fenceToken: strictFullAutoAcceptanceHash({
      planHash: plan.planHash,
      generation,
      ownerId,
    }),
    acquiredAt,
    renewedAt,
    expiresAt: new Date(now.getTime() + LEASE_TTL_MS).toISOString(),
  });
  return Object.freeze({ ...body, leaseHash: strictFullAutoAcceptanceHash(body) });
}

export class StrictFullAutoAcceptanceControlStore
  extends StrictFullAutoAcceptancePlanControlStore {
  leasePath(plan) { return path.join(plan.controlRoot, 'exclusive-lease.json'); }

  generationPath(plan) { return path.join(plan.controlRoot, 'lease-generation.json'); }

  acquireLease(plan, { purpose }) {
    const controlRoot = assertPlanControlRoot(plan);
    const selectedLeasePath = this.leasePath(plan);
    for (;;) {
      if (fs.existsSync(selectedLeasePath)) {
        let existing;
        try { existing = verifyLeaseDocument(parseJsonFile(selectedLeasePath, 'lease')); }
        catch (error) {
          const stat = fs.lstatSync(selectedLeasePath);
          if (!stat.isFile() || stat.isSymbolicLink()
            || Date.now() - stat.mtimeMs <= LEASE_TTL_MS) {
            throw new Error('strict_full_auto_acceptance_lease_publication_incomplete', {
              cause: error,
            });
          }
          existing = null;
        }
        if (existing
          && (leaseOwnerAlive(existing) || Date.parse(existing.expiresAt) > Date.now())) {
          throw new Error(`strict_full_auto_acceptance_lease_held:${existing.purpose}`);
        }
        if (existing) this.recordLeaseGeneration(plan, existing.generation);
        const stale = path.join(
          controlRoot,
          `.stale-lease-${existing?.generation || 'unknown'}-${crypto.randomBytes(8).toString('hex')}.json`,
        );
        try { fs.renameSync(selectedLeasePath, stale); } catch (renameError) {
          if (renameError?.code === 'ENOENT') continue;
          throw renameError;
        }
        fsyncDirectory(controlRoot);
        continue;
      }
      const previousGeneration = this.readLeaseGeneration(plan);
      const generation = previousGeneration + 1;
      const acquired = new Date();
      const lease = leaseDocument({
        plan,
        purpose,
        generation,
        ownerId: crypto.randomBytes(24).toString('hex'),
        acquiredAt: acquired.toISOString(),
        now: acquired,
      });
      const temporary = path.join(
        controlRoot,
        `.lease-publication-${process.pid}-${crypto.randomBytes(8).toString('hex')}.tmp`,
      );
      try {
        exclusiveJsonCreate(temporary, lease);
        try { fs.linkSync(temporary, selectedLeasePath); }
        catch (error) {
          if (error?.code === 'EEXIST') continue;
          throw error;
        }
        fsyncDirectory(controlRoot);
        this.recordLeaseGeneration(plan, generation);
        return lease;
      } finally {
        try {
          fs.unlinkSync(temporary);
          fsyncDirectory(controlRoot);
        } catch { /* published or absent */ }
      }
    }
  }

  readLeaseGeneration(plan) {
    assertPlanControlRoot(plan);
    if (!fs.existsSync(this.generationPath(plan))) return 0;
    const record = parseJsonFile(this.generationPath(plan), 'lease_generation');
    const legacyValid = SHA256.test(String(record.planHash || ''))
      && Number.isSafeInteger(record.generation) && record.generation >= 1
      && record.generationHash === strictFullAutoAcceptanceHash({
        planHash: record.planHash,
        generation: record.generation,
      });
    const body = {
      version: record.version,
      kind: record.kind,
      generation: record.generation,
    };
    const globalValid = record.version === 2
      && record.kind === 'StrictFullAutoAcceptanceLeaseGeneration'
      && Number.isSafeInteger(record.generation) && record.generation >= 1
      && record.generationHash === strictFullAutoAcceptanceHash(body);
    if (!legacyValid && !globalValid) {
      throw new Error('strict_full_auto_acceptance_lease_generation_invalid');
    }
    return record.generation;
  }

  recordLeaseGeneration(plan, generation) {
    const current = this.readLeaseGeneration(plan);
    if (!Number.isSafeInteger(generation) || generation < current) {
      throw new Error('strict_full_auto_acceptance_lease_generation_regression');
    }
    const existing = fs.existsSync(this.generationPath(plan))
      ? parseJsonFile(this.generationPath(plan), 'lease_generation') : null;
    if (generation === current && existing?.version === 2) return;
    const body = {
      version: 2,
      kind: 'StrictFullAutoAcceptanceLeaseGeneration',
      generation,
    };
    atomicJsonWrite(this.generationPath(plan), {
      ...body,
      generationHash: strictFullAutoAcceptanceHash(body),
    });
  }

  assertLease(plan, lease) {
    assertPlanControlRoot(plan);
    const current = verifyLeaseDocument(parseJsonFile(this.leasePath(plan), 'lease'));
    if (current.planHash !== plan.planHash || current.ownerId !== lease.ownerId
      || current.generation !== lease.generation || current.fenceToken !== lease.fenceToken) {
      throw new Error('strict_full_auto_acceptance_lease_fence_lost');
    }
    return current;
  }

  renewLease(plan, lease) {
    const current = this.assertLease(plan, lease);
    const now = new Date();
    const renewed = leaseDocument({
      plan,
      purpose: current.purpose,
      generation: current.generation,
      ownerId: current.ownerId,
      acquiredAt: current.acquiredAt,
      now,
    });
    atomicJsonWrite(this.leasePath(plan), renewed);
    return renewed;
  }

  releaseLease(plan, lease) {
    this.assertLease(plan, lease);
    fs.unlinkSync(this.leasePath(plan));
    fsyncDirectory(assertPlanControlRoot(plan));
  }

  readState(plan) {
    assertPlanControlRoot(plan);
    const candidate = this.statePath(plan);
    return fs.existsSync(candidate) ? parseJsonFile(candidate, 'state') : null;
  }

  writeState(plan, state, { lease, expectedRevision }) {
    this.assertLease(plan, lease);
    if (!this.isLegacyPlan(plan)) this.ensurePlanScope(plan, { lease });
    const current = this.readState(plan);
    const currentRevision = current?.revision ?? null;
    if (currentRevision !== expectedRevision
      || state.revision !== (expectedRevision === null ? 1 : expectedRevision + 1)
      || state.fenceToken !== lease.fenceToken) {
      throw new Error('strict_full_auto_acceptance_state_cas_conflict');
    }
    atomicJsonWrite(this.statePath(plan), state);
    this.assertLease(plan, lease);
    return state;
  }

  readReceipt(plan) {
    assertPlanControlRoot(plan);
    const candidate = this.receiptPath(plan);
    return fs.existsSync(candidate) ? parseJsonFile(candidate, 'receipt') : null;
  }

  writeReceipt(plan, receipt, { lease }) {
    this.assertLease(plan, lease);
    if (!this.isLegacyPlan(plan)) this.ensurePlanScope(plan, { lease });
    try { exclusiveJsonPublish(this.receiptPath(plan), receipt); }
    catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const existing = this.readReceipt(plan);
      if (existing?.receiptHash !== receipt.receiptHash) {
        throw new Error('strict_full_auto_acceptance_receipt_no_clobber_conflict');
      }
    }
    this.assertLease(plan, lease);
    return receipt;
  }

  ensureIntent(plan, step, { lease }) {
    this.assertLease(plan, lease);
    if (!this.isLegacyPlan(plan)) this.ensurePlanScope(plan, { lease });
    const legacy = this.isLegacyPlan(plan);
    ensureScopedDirectory(legacy ? plan.controlRoot : this.planScopePath(plan), 'intents');
    const body = Object.freeze({
      version: 1,
      kind: 'StrictFullAutoAcceptanceDurableStepIntent',
      planHash: plan.planHash,
      stepId: step.stepId,
      stepDefinitionHash: strictFullAutoAcceptanceHash(step),
      idempotencyKey: step.idempotencyKey,
      intentHash: strictFullAutoAcceptanceHash({
        planHash: plan.planHash,
        stepId: step.stepId,
        idempotencyKey: step.idempotencyKey,
      }),
      createdLeaseGeneration: lease.generation,
      createdFenceToken: lease.fenceToken,
    });
    const intent = Object.freeze({ ...body, durableIntentHash: strictFullAutoAcceptanceHash(body) });
    const selectedPath = legacy ? legacyIntentPath(plan, step) : intentPath(plan, step);
    try {
      exclusiveJsonPublish(selectedPath, intent);
      return Object.freeze({ created: true, intent });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const existing = parseJsonFile(selectedPath, 'durable_intent');
      if (existing.planHash !== plan.planHash || existing.stepId !== step.stepId
        || existing.stepDefinitionHash !== strictFullAutoAcceptanceHash(step)
        || existing.idempotencyKey !== step.idempotencyKey
        || existing.intentHash !== body.intentHash
        || existing.durableIntentHash !== strictFullAutoAcceptanceHash((({
          durableIntentHash: _discarded,
          ...payload
        }) => payload)(existing))) {
        throw new Error('strict_full_auto_acceptance_durable_intent_no_clobber_conflict');
      }
      return Object.freeze({ created: false, intent: existing });
    }
  }

  ensureDispatchStarted(plan, step, { lease }) {
    this.assertLease(plan, lease);
    if (!this.isLegacyPlan(plan)) this.ensurePlanScope(plan, { lease });
    const legacy = this.isLegacyPlan(plan);
    ensureScopedDirectory(legacy ? plan.controlRoot : this.planScopePath(plan), 'dispatches');
    const body = Object.freeze({
      version: 1,
      kind: 'StrictFullAutoAcceptanceDurableDispatchStart',
      planHash: plan.planHash,
      stepId: step.stepId,
      stepDefinitionHash: strictFullAutoAcceptanceHash(step),
      idempotencyKey: step.idempotencyKey,
      dispatchHash: strictFullAutoAcceptanceHash({
        planHash: plan.planHash,
        stepId: step.stepId,
        idempotencyKey: step.idempotencyKey,
      }),
      createdLeaseGeneration: lease.generation,
      createdFenceToken: lease.fenceToken,
    });
    const marker = Object.freeze({
      ...body,
      durableDispatchStartHash: strictFullAutoAcceptanceHash(body),
    });
    const selectedPath = legacy ? legacyDispatchPath(plan, step) : dispatchPath(plan, step);
    try {
      exclusiveJsonPublish(selectedPath, marker);
      return Object.freeze({ created: true, marker });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const existing = parseJsonFile(selectedPath, 'durable_dispatch_start');
      const { durableDispatchStartHash, ...existingBody } = existing;
      if (existing.planHash !== plan.planHash || existing.stepId !== step.stepId
        || existing.stepDefinitionHash !== body.stepDefinitionHash
        || existing.idempotencyKey !== step.idempotencyKey
        || existing.dispatchHash !== body.dispatchHash
        || durableDispatchStartHash !== strictFullAutoAcceptanceHash(existingBody)) {
        throw new Error('strict_full_auto_acceptance_dispatch_start_no_clobber_conflict');
      }
      return Object.freeze({ created: false, marker: existing });
    }
  }

  assertRuntimeRootAbsent(plan) {
    assertPlanControlRoot(plan);
    let target = null;
    try { target = fs.lstatSync(plan.runtimeRoot); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
    if (target) {
      throw new Error('strict_full_auto_acceptance_fresh_runtime_root_required');
    }
    return true;
  }

  readRuntimeRootActivation(plan) {
    assertPlanControlRoot(plan);
    const selectedPath = this.runtimeRootActivationPath(plan);
    if (!fs.existsSync(selectedPath)) return null;
    const recorded = parseJsonFile(selectedPath, 'runtime_root_activation');
    const observed = runtimeRootActivation(plan);
    if (strictFullAutoAcceptanceHash(recorded) !== strictFullAutoAcceptanceHash(observed)) {
      throw new Error('strict_full_auto_acceptance_runtime_root_activation_drift');
    }
    return recorded;
  }

  ensureRuntimeRootActivation(plan, { lease }) {
    this.assertLease(plan, lease);
    if (!this.isLegacyPlan(plan)) this.ensurePlanScope(plan, { lease });
    const observed = runtimeRootActivation(plan);
    const selectedPath = this.runtimeRootActivationPath(plan);
    try { exclusiveJsonPublish(selectedPath, observed); }
    catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    const recorded = this.readRuntimeRootActivation(plan);
    if (strictFullAutoAcceptanceHash(recorded) !== strictFullAutoAcceptanceHash(observed)) {
      throw new Error('strict_full_auto_acceptance_runtime_root_activation_no_clobber_conflict');
    }
    this.assertLease(plan, lease);
    return recorded;
  }
}
