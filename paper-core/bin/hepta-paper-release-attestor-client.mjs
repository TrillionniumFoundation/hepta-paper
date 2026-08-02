#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  composeLocalReleaseAttestorRuntime,
} from '../../paper-composition/automation/local-release-attestor-composition.mjs';
import { parseStrictCliArguments } from '../src/strict-cli-arguments.mjs';

const releaseAttestorRuntime = composeLocalReleaseAttestorRuntime();

export async function runHeptaPaperReleaseAttestorClient({
  argv = [],
  input,
} = {}) {
  const args = parseStrictCliArguments(argv, {
    booleanFlags: ['help'],
    valueFlags: ['socket'],
    positional: false,
  });
  if (args.help) {
    return Object.freeze({
      help: 'Usage: hepta-paper-release-attestor-client --socket PATH',
    });
  }
  if (!args.socket) throw new Error('local_release_attestor_socket_required');
  if (!path.isAbsolute(args.socket)) {
    throw new Error('local_release_attestor_socket_invalid');
  }
  let request;
  try {
    request = JSON.parse(String(
      input === undefined ? fs.readFileSync(0, 'utf8') : input,
    ).trim());
  }
  catch { throw new Error('local_release_attestor_client_request_invalid'); }
  return releaseAttestorRuntime.requestAttestation({
    socketPath: path.resolve(args.socket),
    request,
  });
}

const invokedAsEntrypoint = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsEntrypoint) {
  try {
    const result = await runHeptaPaperReleaseAttestorClient({
      argv: process.argv.slice(2),
    });
    process.stdout.write(`${result.help || JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${String(error?.message || error)}\n`);
    process.exitCode = 1;
  }
}
