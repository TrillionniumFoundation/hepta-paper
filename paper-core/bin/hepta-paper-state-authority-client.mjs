#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  composeLocalAutonomousResearchStateAuthorityRuntime,
} from '../../paper-composition/automation/local-autonomous-research-state-authority-composition.mjs';
import { parseStrictCliArguments } from '../src/strict-cli-arguments.mjs';

export const HEPTA_LOCAL_STATE_AUTHORITY_SOCKET =
  '/run/hepta-paper-state-authority/authority.sock';
const stateAuthorityRuntime =
  composeLocalAutonomousResearchStateAuthorityRuntime();

export async function runHeptaPaperStateAuthorityClient({
  argv = [],
  input,
  socketPath = HEPTA_LOCAL_STATE_AUTHORITY_SOCKET,
} = {}) {
  const args = parseStrictCliArguments(argv, {
    booleanFlags: ['help'],
    positional: false,
  });
  if (args.help) {
    return Object.freeze({
      help: 'Usage: hepta-paper-state-authority-client < request.json',
    });
  }
  let request;
  try {
    request = JSON.parse(String(
      input === undefined ? fs.readFileSync(0, 'utf8') : input,
    ).trim());
  }
  catch { throw new Error('local_state_authority_client_request_invalid'); }
  return stateAuthorityRuntime.requestAuthority({ request, socketPath });
}

const invokedAsEntrypoint = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsEntrypoint) {
  try {
    const receipt = await runHeptaPaperStateAuthorityClient({
      argv: process.argv.slice(2),
    });
    process.stdout.write(`${receipt.help || JSON.stringify(receipt)}\n`);
  } catch (error) {
    process.stderr.write(`${String(error?.message || error)}\n`);
    process.exitCode = 1;
  }
}
