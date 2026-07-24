import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  canonicalAcceptanceJson,
  strictFullAutoAcceptanceHash,
} from '../../paper-domain/automation/strict-full-auto-acceptance-contract.mjs';

import {
  dispatchPath,
  intentPath,
  runtimeRootActivation,
} from './strict-full-auto-acceptance-control-paths.mjs';

const LEASE_TTL_MS = 60_000;
const SHA256 = /^sha256:[0-9a-f]{64}$/;

function fsyncDirectory(candidate) {
  const descriptor = fs.openSync(candidate, fs.constants.O_RDONLY);
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

function secureControlRoot(candidate) {
  const selected = path.resolve(candidate);
  const stat = fs.lstatSync(selected);
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : stat.uid;
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(selected) !== selected
    || stat.uid !== currentUid || (stat.mode & 0o077) !== 0) {
    throw new Error('strict_full_auto_acceptance_control_root_invalid');
  }
  return selected;
}

function assertPlanControlRoot(plan) {
  const selected = secureControlRoot(plan.controlRoot);
  const stat = fs.lstatSync(selected, { bigint: true });
  const binding = plan.rootBindings.find((item) => item.rootId === 'control-root');
  if (!binding || binding.anchorKind !== 'target' || binding.anchorPath !== selected
    || binding.anchorRealPath !== selected
    || binding.anchorDevice !== String(stat.dev)
    || binding.anchorInode !== String(stat.ino)
    || binding.anchorMode !== (Number(stat.mode) & 0o7777)
    || binding.anchorUid !== String(stat.uid)) {
    throw new Error('strict_full_auto_acceptance_control_root_identity_changed');
  }
  return selected;
}

function secureDirectory(candidate) {
  const selected = path.resolve(candidate);
  const stat = fs.lstatSync(selected);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(selected) !== selected
    || (stat.mode & 0o022) !== 0) {
    throw new Error('strict_full_auto_acceptance_control_directory_invalid');
  }
  return selected;
}

function ensureScopedDirectory(parent, name) {
  const selectedParent = secureDirectory(parent);
  const selected = path.join(selectedParent, name);
  if (!fs.existsSync(selected)) fs.mkdirSync(selected, { mode: 0o700 });
  return secureDirectory(selected);
}

function secureRegularFile(candidate, label) {
  const selected = path.resolve(candidate);
  let stat = fs.lstatSync(selected);
  if (stat.isFile() && !stat.isSymbolicLink() && stat.nlink > 1) {
    const parent = secureDirectory(path.dirname(selected));
    for (const entry of fs.readdirSync(parent)) {
      const possibleTemporary = path.join(parent, entry);
      if (possibleTemporary === selected || !entry.startsWith('.') || !entry.endsWith('.tmp')) {
        continue;
      }
      let candidateStat;
      try { candidateStat = fs.lstatSync(possibleTemporary); } catch { continue; }
      if (candidateStat.isFile() && !candidateStat.isSymbolicLink()
        && candidateStat.dev === stat.dev && candidateStat.ino === stat.ino) {
        fs.unlinkSync(possibleTemporary);
      }
    }
    fsyncDirectory(parent);
    stat = fs.lstatSync(selected);
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
    || fs.realpathSync(selected) !== selected || (stat.mode & 0o022) !== 0) {
    throw new Error(`strict_full_auto_acceptance_${label}_file_invalid`);
  }
  return selected;
}

function jsonBytes(value) {
  return `${canonicalAcceptanceJson(value)}\n`;
}

function atomicJsonWrite(destination, value) {
  const parent = secureDirectory(path.dirname(destination));
  if (fs.existsSync(destination)) secureRegularFile(destination, 'atomic_target');
  const temporary = path.join(
    parent,
    `.${path.basename(destination)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`,
  );
  const descriptor = fs.openSync(
    temporary,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
      | (fs.constants.O_NOFOLLOW || 0),
    0o600,
  );
  try {
    fs.writeFileSync(descriptor, jsonBytes(value), 'utf8');
    fs.fsyncSync(descriptor);
  } finally { fs.closeSync(descriptor); }
  fs.renameSync(temporary, destination);
  secureRegularFile(destination, 'atomic_target');
  fsyncDirectory(parent);
}

function exclusiveJsonCreate(destination, value) {
  const parent = secureDirectory(path.dirname(destination));
  const descriptor = fs.openSync(
    destination,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
      | (fs.constants.O_NOFOLLOW || 0),
    0o600,
  );
  try {
    fs.writeFileSync(descriptor, jsonBytes(value), 'utf8');
    fs.fsyncSync(descriptor);
  } finally { fs.closeSync(descriptor); }
  fsyncDirectory(parent);
}

function exclusiveJsonPublish(destination, value) {
  const parent = secureDirectory(path.dirname(destination));
  const temporary = path.join(
    parent,
    `.${path.basename(destination)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`,
  );
  try {
    exclusiveJsonCreate(temporary, value);
    fs.linkSync(temporary, destination);
    fsyncDirectory(parent);
  } finally {
    try {
      fs.unlinkSync(temporary);
      fsyncDirectory(parent);
    } catch { /* published or absent */ }
  }
}

function parseJsonFile(candidate, label) {
  try { return JSON.parse(fs.readFileSync(secureRegularFile(candidate, label), 'utf8')); }
  catch (error) {
    throw new Error(`strict_full_auto_acceptance_${label}_invalid`, { cause: error });
  }
}

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

export class StrictFullAutoAcceptanceControlStore {
  statePath(plan) { return path.join(plan.controlRoot, 'state.json'); }

  receiptPath(plan) { return path.join(plan.controlRoot, 'acceptance-receipt.json'); }

  leasePath(plan) { return path.join(plan.controlRoot, 'exclusive-lease.json'); }

  generationPath(plan) { return path.join(plan.controlRoot, 'lease-generation.json'); }

  runtimeRootActivationPath(plan) {
    return path.join(plan.controlRoot, 'runtime-root-activation.json');
  }

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
    if (record.planHash !== plan.planHash
      || !Number.isSafeInteger(record.generation) || record.generation < 1
      || record.generationHash !== strictFullAutoAcceptanceHash({
        planHash: plan.planHash,
        generation: record.generation,
      })) {
      throw new Error('strict_full_auto_acceptance_lease_generation_invalid');
    }
    return record.generation;
  }

  recordLeaseGeneration(plan, generation) {
    const current = this.readLeaseGeneration(plan);
    if (!Number.isSafeInteger(generation) || generation < current) {
      throw new Error('strict_full_auto_acceptance_lease_generation_regression');
    }
    if (generation === current) return;
    atomicJsonWrite(this.generationPath(plan), {
      planHash: plan.planHash,
      generation,
      generationHash: strictFullAutoAcceptanceHash({ planHash: plan.planHash, generation }),
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
    ensureScopedDirectory(plan.controlRoot, 'intents');
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
    const selectedPath = intentPath(plan, step);
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
    ensureScopedDirectory(plan.controlRoot, 'dispatches');
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
    const selectedPath = dispatchPath(plan, step);
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
