import fs from 'node:fs';
import path from 'node:path';

import {
  strictFullAutoAcceptanceHash,
} from '../../paper-domain/automation/strict-full-auto-acceptance-contract.mjs';

export function intentPath(plan, step) {
  const ordinal = step.stepId === 'final-aggregate-live-verification'
    ? '99' : String(plan.steps.findIndex((item) => item.stepId === step.stepId)).padStart(2, '0');
  return path.join(plan.controlRoot, 'intents', `${ordinal}-${step.stepId}.json`);
}

export function dispatchPath(plan, step) {
  const ordinal = String(plan.steps.findIndex((item) => item.stepId === step.stepId))
    .padStart(2, '0');
  return path.join(plan.controlRoot, 'dispatches', `${ordinal}-${step.stepId}.json`);
}

export function runtimeRootActivation(plan) {
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
    kind: 'StrictFullAutoAcceptanceRuntimeRootActivation',
    planHash: plan.planHash,
    resolvedPath: selected,
    device: String(stat.dev),
    inode: String(stat.ino),
    mode: Number(stat.mode) & 0o7777,
    uid: String(stat.uid),
  });
  return Object.freeze({
    ...body,
    runtimeRootActivationHash: strictFullAutoAcceptanceHash(body),
  });
}
