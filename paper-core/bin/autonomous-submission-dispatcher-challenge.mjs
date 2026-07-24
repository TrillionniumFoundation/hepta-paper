#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  publishAutonomousSubmissionDispatcherChallenge,
  inspectPublishedAutonomousSubmissionDispatcherChallenge,
  resolveAutonomousSubmissionPortalDescriptorBinding,
} from '../../paper-composition/automation/autonomous-submission-dispatcher-challenge-composition.mjs';
import { parseStrictCliArguments } from '../src/strict-cli-arguments.mjs';
import { defaultPaperRuntimeRoot } from '../src/workspace-layout.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const STATUS_WAIT_MS = 10 * 60 * 1000;
const STATUS_POLL_MS = 1000;

export function parseAutonomousSubmissionDispatcherChallengeArguments(argv = []) {
  const args = parseStrictCliArguments(argv, {
    booleanFlags: ['help'],
    valueFlags: [
      'action', 'plan-hash', 'idempotency-key', 'portal-id',
      'portal-configuration-hash', 'portal-descriptor-hash',
    ],
    positional: false,
  });
  if (args.help) return Object.freeze({ help: true });
  const action = String(args.action || 'status');
  if (!['publish', 'status'].includes(action)
    || !SHA256.test(String(args['plan-hash'] || ''))
    || !SHA256.test(String(args['idempotency-key'] || ''))
    || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$/.test(String(args['portal-id'] || ''))
    || !SHA256.test(String(args['portal-configuration-hash'] || ''))
    || !SHA256.test(String(args['portal-descriptor-hash'] || ''))) {
    throw new Error('autonomous_submission_dispatcher_challenge_arguments_invalid');
  }
  return Object.freeze({
    help: false,
    action,
    planHash: args['plan-hash'],
    idempotencyKey: args['idempotency-key'],
    portalId: args['portal-id'],
    portalConfigurationHash: args['portal-configuration-hash'],
    portalDescriptorHash: args['portal-descriptor-hash'],
  });
}

function usage() {
  return Object.freeze({
    version: 1,
    kind: 'AutonomousSubmissionDispatcherChallengeUsage',
    usage: 'autonomous-submission-dispatcher-challenge --action publish|status --plan-hash sha256:... --idempotency-key sha256:... --portal-id ID --portal-configuration-hash sha256:... --portal-descriptor-hash sha256:...',
    publisherHasPortalCredentials: false,
    statusIsReadOnly: true,
    residentDispatcherPrincipalRequired: true,
  });
}

function wait(milliseconds) {
  return new Promise((resolve) => { setTimeout(resolve, milliseconds); });
}

export async function runAutonomousSubmissionDispatcherChallenge({
  argv = process.argv.slice(2),
  runtimeRoot = defaultPaperRuntimeRoot(),
  environment = process.env,
  now = () => new Date(),
  statusWaitMs = STATUS_WAIT_MS,
  statusPollMs = STATUS_POLL_MS,
} = {}) {
  const options = parseAutonomousSubmissionDispatcherChallengeArguments(argv);
  if (options.help) return usage();
  const {
    descriptor: portalDescriptor,
    descriptorHash: observedPortalDescriptorHash,
  } = resolveAutonomousSubmissionPortalDescriptorBinding({ environment });
  if (!portalDescriptor
    || portalDescriptor.portalId !== options.portalId
    || portalDescriptor.configurationHash !== options.portalConfigurationHash
    || observedPortalDescriptorHash !== options.portalDescriptorHash) {
    throw new Error('autonomous_submission_dispatcher_challenge_portal_binding_invalid');
  }
  const selectedRuntimeRoot = path.resolve(runtimeRoot);
  if (options.action === 'publish') {
    return publishAutonomousSubmissionDispatcherChallenge({
      runtimeRoot: selectedRuntimeRoot,
      planHash: options.planHash,
      idempotencyKey: options.idempotencyKey,
      portalId: options.portalId,
      portalConfigurationHash: options.portalConfigurationHash,
      portalDescriptorHash: options.portalDescriptorHash,
      now: now(),
    });
  }
  if (!Number.isSafeInteger(statusWaitMs) || statusWaitMs < 0
    || !Number.isSafeInteger(statusPollMs) || statusPollMs < 1) {
    throw new Error('autonomous_submission_dispatcher_challenge_poll_policy_invalid');
  }
  const deadline = Date.now() + statusWaitMs;
  let inspection;
  do {
    inspection = inspectPublishedAutonomousSubmissionDispatcherChallenge({
      runtimeRoot: selectedRuntimeRoot,
      environment,
      now: now(),
      planHash: options.planHash,
      idempotencyKey: options.idempotencyKey,
      portalId: options.portalId,
      portalConfigurationHash: options.portalConfigurationHash,
      portalDescriptorHash: options.portalDescriptorHash,
    });
    if (inspection.ready === true || Date.now() >= deadline) return inspection;
    await wait(Math.min(statusPollMs, Math.max(1, deadline - Date.now())));
  } while (true);
}

const invokedAsEntrypoint = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsEntrypoint) {
  runAutonomousSubmissionDispatcherChallenge().then((report) => {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report?.ready !== true) process.exitCode = 2;
  }).catch((error) => {
    process.stderr.write(`${String(error?.stack || error)}\n`);
    process.exitCode = 1;
  });
}
