#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  heptaPaperCommandUsage,
  resolveHeptaPaperCommand,
} from '../src/command-registry.mjs';
import { parseStrictCliArguments } from '../src/strict-cli-arguments.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const [group, name, ...extra] = process.argv.slice(2);
if (!group || group === '--help' || group === 'help') {
  process.stdout.write(`${JSON.stringify(heptaPaperCommandUsage(), null, 2)}\n`);
  process.exit(0);
}
const selected = resolveHeptaPaperCommand(group, name);
if (!selected) {
  process.stderr.write(`${JSON.stringify({ ...heptaPaperCommandUsage(), error: 'unknown_command', requested: { group, name: name || null } }, null, 2)}\n`);
  process.exit(2);
}
if (extra.length && extra[0] !== '--') {
  process.stderr.write(`${JSON.stringify({ ...heptaPaperCommandUsage(), error: 'command_arguments_require_separator', requested: { group, name } }, null, 2)}\n`);
  process.exit(2);
}
const [executable, ...args] = selected.argv;
const forwarded = extra.slice(1);
if (selected.forwardingPolicy === 'none' && forwarded.length) {
  process.stderr.write(`${JSON.stringify({ ...heptaPaperCommandUsage(), error: 'command_does_not_accept_arguments', requested: { group, name } }, null, 2)}\n`);
  process.exit(2);
}
if (selected.forwardingPolicy === 'registry') {
  try {
    parseStrictCliArguments(forwarded, selected.forwardedArgumentSchema || {});
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ...heptaPaperCommandUsage(), error: error?.message || String(error), requested: { group, name } }, null, 2)}\n`);
    process.exit(2);
  }
}
const child = spawn(executable, [...args, ...forwarded], {
  cwd: root,
  stdio: 'inherit',
  env: process.env,
});
const forwardSigint = () => child.kill('SIGINT');
const forwardSigterm = () => child.kill('SIGTERM');
process.once('SIGINT', forwardSigint);
process.once('SIGTERM', forwardSigterm);
let result;
try {
  result = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (status, signal) => resolve({ status, signal }));
  });
} finally {
  process.removeListener('SIGINT', forwardSigint);
  process.removeListener('SIGTERM', forwardSigterm);
}
if (result.signal) process.kill(process.pid, result.signal);
else process.exit(result.status ?? 1);
