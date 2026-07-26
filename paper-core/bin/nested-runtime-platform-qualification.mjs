#!/usr/bin/env node
import {
  composeNestedRuntimePlatformQualificationVerification,
} from '../../paper-composition/automation/nested-runtime-platform-qualification-composition.mjs';
import { parseStrictCliArguments } from '../src/strict-cli-arguments.mjs';

function usage() {
  return [
    'Usage: hepta-paper operator nested-runtime-platform-qualification -- [options]',
    '',
    'Read-only, fail-closed verifier for an independently signed nested-runtime',
    'platform qualification bundle and a separately signed startup conformance',
    'bundle bound to the current Kubernetes Pod UID.',
    '',
    'Options:',
    '  --config PATH',
    '  --config-content-hash sha256:...',
    '  --qualification-content-hash sha256:...',
    '  --conformance-content-hash sha256:...',
    '  --authority-independence-content-hash sha256:...',
    '  --pod-uid UUID',
    '  --plan-hash sha256:...',
    '  --profile-id ID',
    '  --runtime-class-name NAME',
    '  --parent-pod-cpu-millis INTEGER',
    '  --parent-pod-memory-bytes INTEGER',
    '  --parent-pod-pids INTEGER',
    '  --qualification-key-id ID',
    '  --qualification-subject-id ID',
    '  --qualification-public-key-spki-hash sha256:...',
    '  --conformance-key-id ID',
    '  --conformance-subject-id ID',
    '  --conformance-public-key-spki-hash sha256:...',
    '',
    'Every option may instead be supplied through the corresponding',
    'HEPTA_NESTED_RUNTIME_* environment variable. This command never creates,',
    'updates, signs, or repairs either receipt.',
  ].join('\n');
}

function selected(args, environment, argument, environmentName) {
  return args[argument] || environment[environmentName] || null;
}

function main() {
  const args = parseStrictCliArguments(process.argv.slice(2), {
    booleanFlags: ['help'],
    valueFlags: [
      'config', 'config-content-hash', 'qualification-content-hash',
      'conformance-content-hash', 'authority-independence-content-hash',
      'pod-uid', 'plan-hash', 'profile-id',
      'runtime-class-name', 'parent-pod-cpu-millis', 'parent-pod-memory-bytes',
      'parent-pod-pids', 'qualification-key-id', 'qualification-subject-id',
      'qualification-public-key-spki-hash', 'conformance-key-id',
      'conformance-subject-id', 'conformance-public-key-spki-hash',
    ],
    positional: false,
  });
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const environment = process.env;
  const report = composeNestedRuntimePlatformQualificationVerification({
    configPath: selected(
      args,
      environment,
      'config',
      'HEPTA_NESTED_RUNTIME_QUALIFICATION_CONFIG',
    ),
    expectedConfigContentHash: selected(
      args,
      environment,
      'config-content-hash',
      'HEPTA_NESTED_RUNTIME_QUALIFICATION_CONFIG_SHA256',
    ),
    expectedQualificationBundleContentHash: selected(
      args,
      environment,
      'qualification-content-hash',
      'HEPTA_NESTED_RUNTIME_QUALIFICATION_RECEIPT_SHA256',
    ),
    expectedConformanceBundleContentHash: selected(
      args,
      environment,
      'conformance-content-hash',
      'HEPTA_NESTED_RUNTIME_CONFORMANCE_RECEIPT_SHA256',
    ),
    expectedAuthorityIndependenceBundleContentHash: selected(
      args,
      environment,
      'authority-independence-content-hash',
      'HEPTA_NESTED_RUNTIME_AUTHORITY_INDEPENDENCE_RECEIPT_SHA256',
    ),
    podUid: selected(args, environment, 'pod-uid', 'HEPTA_NESTED_RUNTIME_POD_UID'),
    planHash: selected(args, environment, 'plan-hash', 'HEPTA_NESTED_RUNTIME_PLAN_HASH'),
    profileId: selected(
      args,
      environment,
      'profile-id',
      'HEPTA_NESTED_RUNTIME_PROFILE_ID',
    ),
    runtimeClassName: selected(
      args,
      environment,
      'runtime-class-name',
      'HEPTA_NESTED_RUNTIME_CLASS_NAME',
    ),
    parentPodCpuMillis: selected(
      args,
      environment,
      'parent-pod-cpu-millis',
      'HEPTA_NESTED_RUNTIME_PARENT_POD_CPU_MILLIS',
    ),
    parentPodMemoryBytes: selected(
      args,
      environment,
      'parent-pod-memory-bytes',
      'HEPTA_NESTED_RUNTIME_PARENT_POD_MEMORY_BYTES',
    ),
    parentPodPids: selected(
      args,
      environment,
      'parent-pod-pids',
      'HEPTA_NESTED_RUNTIME_PARENT_POD_PIDS',
    ),
    qualificationKeyId: selected(
      args,
      environment,
      'qualification-key-id',
      'HEPTA_NESTED_RUNTIME_QUALIFICATION_KEY_ID',
    ),
    qualificationSubjectId: selected(
      args,
      environment,
      'qualification-subject-id',
      'HEPTA_NESTED_RUNTIME_QUALIFICATION_SUBJECT_ID',
    ),
    qualificationPublicKeySpkiHash: selected(
      args,
      environment,
      'qualification-public-key-spki-hash',
      'HEPTA_NESTED_RUNTIME_QUALIFICATION_PUBLIC_KEY_SPKI_SHA256',
    ),
    conformanceKeyId: selected(
      args,
      environment,
      'conformance-key-id',
      'HEPTA_NESTED_RUNTIME_CONFORMANCE_KEY_ID',
    ),
    conformanceSubjectId: selected(
      args,
      environment,
      'conformance-subject-id',
      'HEPTA_NESTED_RUNTIME_CONFORMANCE_SUBJECT_ID',
    ),
    conformancePublicKeySpkiHash: selected(
      args,
      environment,
      'conformance-public-key-spki-hash',
      'HEPTA_NESTED_RUNTIME_CONFORMANCE_PUBLIC_KEY_SPKI_SHA256',
    ),
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ready) process.exitCode = 1;
}

try { main(); }
catch (error) {
  process.stderr.write(`${String(error?.stack || error)}\n`);
  process.exitCode = 1;
}
