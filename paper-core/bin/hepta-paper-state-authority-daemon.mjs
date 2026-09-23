#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  composeLocalAutonomousResearchStateAuthorityRuntime,
} from '../../paper-composition/automation/local-autonomous-research-state-authority-composition.mjs';
import { parseStrictCliArguments } from '../src/strict-cli-arguments.mjs';

const DEFAULT_CONFIGURATION_PATH =
  '/etc/hepta-paper/state-authority/daemon-config.json';
const stateAuthorityRuntime =
  composeLocalAutonomousResearchStateAuthorityRuntime();

export async function runHeptaPaperStateAuthorityDaemon({
  argv = process.argv.slice(2),
} = {}) {
  const args = parseStrictCliArguments(argv, {
    booleanFlags: ['help'],
    valueFlags: ['configuration'],
    positional: false,
  });
  if (args.help) {
    return Object.freeze({
      help: 'Usage: hepta-paper-state-authority-daemon [--configuration PATH]',
    });
  }
  const configurationPath = path.resolve(
    args.configuration || DEFAULT_CONFIGURATION_PATH,
  );
  const authority = stateAuthorityRuntime.createAuthority({
    configurationPath,
  });
  const listener = await stateAuthorityRuntime.startServer({
    authority,
    socketPath: authority.configuration.socketPath,
  });
  return Object.freeze({ authority, listener });
}

const invokedAsEntrypoint = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsEntrypoint) {
  try {
    const runtime = await runHeptaPaperStateAuthorityDaemon();
    if (runtime.help) {
      process.stdout.write(`${runtime.help}\n`);
    } else {
      const shutdown = async () => {
        try { await runtime.listener.close(); } finally { runtime.authority.close(); }
        process.exit(0);
      };
      process.once('SIGINT', shutdown);
      process.once('SIGTERM', shutdown);
    }
  } catch (error) {
    process.stderr.write(`${String(error?.stack || error)}\n`);
    process.exitCode = 1;
  }
}
