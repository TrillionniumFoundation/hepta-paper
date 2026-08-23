import fs from 'node:fs';
import path from 'node:path';

import {
  strictFullAutoAcceptanceHash,
} from '../../paper-domain/automation/strict-full-auto-acceptance-contract.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;

export function planControlScopePath(plan) {
  if (!SHA256.test(String(plan?.planHash || ''))) {
    throw new Error('strict_full_auto_acceptance_plan_control_scope_invalid');
  }
  return path.join(plan.controlRoot, 'plans', plan.planHash.slice('sha256:'.length));
}

export function legacyIntentPath(plan, step) {
  const ordinal = step.stepId === 'final-aggregate-live-verification'
    ? '99' : String(plan.steps.findIndex((item) => item.stepId === step.stepId)).padStart(2, '0');
  return path.join(plan.controlRoot, 'intents', `${ordinal}-${step.stepId}.json`);
}

export function intentPath(plan, step) {
  const ordinal = step.stepId === 'final-aggregate-live-verification'
    ? '99' : String(plan.steps.findIndex((item) => item.stepId === step.stepId)).padStart(2, '0');
  return path.join(planControlScopePath(plan), 'intents', `${ordinal}-${step.stepId}.json`);
}

export function legacyDispatchPath(plan, step) {
  const ordinal = String(plan.steps.findIndex((item) => item.stepId === step.stepId))
    .padStart(2, '0');
  return path.join(plan.controlRoot, 'dispatches', `${ordinal}-${step.stepId}.json`);
}

export function dispatchPath(plan, step) {
  const ordinal = String(plan.steps.findIndex((item) => item.stepId === step.stepId))
    .padStart(2, '0');
  return path.join(planControlScopePath(plan), 'dispatches', `${ordinal}-${step.stepId}.json`);
}

export function runtimeRootIdentity(plan) {
  const selected = path.resolve(plan.runtimeRoot);
  let stat;
  try { stat = fs.lstatSync(selected, { bigint: true }); }
  catch (error) {
    throw new Error('strict_full_auto_acceptance_runtime_root_not_activated', { cause: error });
  }
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(selected) !== selected
    || (Number(stat.mode) & 0o022) !== 0
    || String(stat.uid) !== String(process.getuid?.())) {
    throw new Error('strict_full_auto_acceptance_runtime_root_activation_invalid');
  }
  const body = Object.freeze({
    version: 1,
    kind: 'StrictFullAutoAcceptanceRuntimeRootIdentity',
    resolvedPath: selected,
    device: String(stat.dev),
    inode: String(stat.ino),
    mode: Number(stat.mode) & 0o7777,
    uid: String(stat.uid),
    gid: String(stat.gid),
  });
  return Object.freeze({ ...body, runtimeRootIdentityHash: strictFullAutoAcceptanceHash(body) });
}

export function runtimeRootActivation(plan, { adoptionReceiptHash = null } = {}) {
  const identity = runtimeRootIdentity(plan);
  if (adoptionReceiptHash !== null && !SHA256.test(String(adoptionReceiptHash || ''))) {
    throw new Error('strict_full_auto_acceptance_runtime_root_adoption_hash_invalid');
  }
  const body = Object.freeze({
    version: adoptionReceiptHash === null ? 1 : 2,
    kind: 'StrictFullAutoAcceptanceRuntimeRootActivation',
    planHash: plan.planHash,
    resolvedPath: identity.resolvedPath,
    device: identity.device,
    inode: identity.inode,
    mode: identity.mode,
    uid: identity.uid,
    gid: identity.gid,
    ...(adoptionReceiptHash === null ? {} : { adoptionReceiptHash }),
  });
  return Object.freeze({ ...body, runtimeRootActivationHash: strictFullAutoAcceptanceHash(body) });
}
