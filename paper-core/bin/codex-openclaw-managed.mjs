#!/usr/bin/env node

import {
  composeCodexOpenClawManagedCommandRuntime,
} from '../../paper-composition/automation/codex-openclaw-managed-composition.mjs';
import { parseStrictCliArguments } from '../src/strict-cli-arguments.mjs';

const managedRuntime = composeCodexOpenClawManagedCommandRuntime();

const USAGE = Object.freeze([
  'Usage: codex-openclaw-managed <command> [options]',
  '  --version',
  '  exec [Codex-compatible options] -',
  '  login status',
  '  configure --home PATH --agent ID --model MODEL [--auth-profile-id ID]',
]);

const CONFIGURE_USAGE = Object.freeze([
  'Usage: codex-openclaw-managed configure [options]',
  '  --home <path>',
  '  --agent <agent-id>',
  '  --auth-profile-id <profile-id> (required unless --gateway-transport)',
  '  --model <model>',
  '  --principal-role <research-author|formal-reviewer>',
  '  [--openclaw-binary <path>] [--openclaw-config-path <path>]',
  '  [--openclaw-state-dir <path>] [--thinking <level>]',
  '  [--maximum-context-bytes <bytes>] [--maximum-file-count <count>]',
  '  [--gateway-transport] [--force]',
]);

const CONFIGURE_BOOLEAN_FLAGS = Object.freeze([
  'force', 'gateway-transport', 'help',
]);
const CONFIGURE_VALUE_FLAGS = Object.freeze([
  'agent', 'auth-profile-id', 'home', 'maximum-context-bytes',
  'maximum-file-count', 'model', 'openclaw-binary',
  'openclaw-config-path', 'openclaw-state-dir', 'principal-role',
  'thinking',
]);
const CONFIGURE_OPTION_TOKENS = new Set([
  ...CONFIGURE_BOOLEAN_FLAGS,
  ...CONFIGURE_VALUE_FLAGS,
].map((name) => `--${name}`));
const SAFE_CONFIGURE_ERROR_PREFIXES = new Set([
  'boolean_cli_option_does_not_take_value',
  'duplicate_cli_option',
  'empty_cli_option_value',
  'missing_cli_option_value',
]);

function projectManagedCliFailureCode(error) {
  const candidate = String(error?.code || error?.message || '').trim();
  const separator = candidate.indexOf(':');
  if (separator > 0 && candidate.indexOf(':', separator + 1) < 0) {
    const prefix = candidate.slice(0, separator);
    const option = candidate.slice(separator + 1);
    if (SAFE_CONFIGURE_ERROR_PREFIXES.has(prefix)
      && CONFIGURE_OPTION_TOKENS.has(option)) return candidate;
  }
  if (/^(?:empty_cli_option|unexpected_cli_argument_separator|unknown_cli_option:|unexpected_cli_positional:|too_many_cli_positionals:)/.test(candidate)) {
    return 'codex_openclaw_managed_command_invalid';
  }
  return managedRuntime.projectFailureCode(candidate);
}

function writeUsage(lines) {
  process.stdout.write(`${lines.join('\n')}\n`);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function managedModelTimeoutFromEnvironment(environment = process.env) {
  const raw = String(
    environment.HEPTA_CODEX_OPENCLAW_MANAGED_TIMEOUT_MS || '',
  ).trim();
  if (!raw) return undefined;
  const timeoutMs = Number(raw);
  if (!Number.isInteger(timeoutMs)
    || timeoutMs < 250
    || timeoutMs > 24 * 60 * 60 * 1000) {
    throw new Error('codex_openclaw_managed_timeout_invalid');
  }
  return timeoutMs;
}

async function main(args = process.argv.slice(2)) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    writeUsage(USAGE);
    return;
  }
  if (args.length === 1 && ['--version', '-V'].includes(args[0])) {
    process.stdout.write(`${managedRuntime.version()}\n`);
    return;
  }
  if (args[0] === 'exec' && args[1] === '--help') {
    process.stdout.write([
      'Usage: codex-openclaw-managed exec [options] -',
      '  --model <model>',
      '  --sandbox <read-only|workspace-write>',
      '  --cd <workspace>',
      '',
    ].join('\n'));
    return;
  }
  if (args[0] === 'login' && args[1] === 'status' && args.length === 2) {
    await managedRuntime.verifyLogin();
    process.stdout.write('Logged in using OpenClaw-managed ChatGPT authentication\n');
    return;
  }
  if (args[0] === 'configure') {
    const options = parseStrictCliArguments(args.slice(1), {
      booleanFlags: CONFIGURE_BOOLEAN_FLAGS,
      valueFlags: CONFIGURE_VALUE_FLAGS,
      positional: false,
    });
    if (options.help) {
      writeUsage(CONFIGURE_USAGE);
      return;
    }
    managedRuntime.provisionHome({
      home: options.home || null,
      agentId: options.agent || null,
      authProfileId: options['auth-profile-id'] || null,
      model: options.model || null,
      openclawBinary: options['openclaw-binary'] || 'openclaw',
      ...(options['openclaw-config-path'] ? {
        openclawConfigPath: options['openclaw-config-path'],
      } : {}),
      ...(options['openclaw-state-dir'] ? {
        openclawStateDir: options['openclaw-state-dir'],
      } : {}),
      principalRole: options['principal-role'] || null,
      thinking: options.thinking || 'adaptive',
      maximumContextBytes: Number(options['maximum-context-bytes'] || '900000'),
      maximumFileCount: Number(options['maximum-file-count'] || '96'),
      gatewayTransport: options['gateway-transport'] === true,
      force: options.force === true,
    });
    process.stdout.write('OpenClaw-managed Codex home configured\n');
    return;
  }
  if (args[0] === 'exec') {
    const controller = new AbortController();
    const abort = () => controller.abort();
    const writeProtocolStdout = process.stdout.write.bind(process.stdout);
    process.once('SIGTERM', abort);
    process.once('SIGINT', abort);
    try {
      const stdin = await readStdin();
      const result = await managedRuntime.withStdoutIsolation(
        () => managedRuntime.execute({
          args: args.slice(1),
          stdin,
          signal: controller.signal,
          timeoutMs: managedModelTimeoutFromEnvironment(),
        }),
      );
      writeProtocolStdout(result.stdout);
    } finally {
      process.removeListener('SIGTERM', abort);
      process.removeListener('SIGINT', abort);
    }
    return;
  }
  throw new Error('codex_openclaw_managed_command_invalid');
}

main().catch((error) => {
  const code = projectManagedCliFailureCode(error);
  process.stderr.write(`${code}\n`);
  const failureEvidence = managedRuntime.buildFailureEvidence(error);
  if (failureEvidence) process.stderr.write(`${JSON.stringify(failureEvidence)}\n`);
  process.exitCode = 1;
});
