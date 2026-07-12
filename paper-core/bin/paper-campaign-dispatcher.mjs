#!/usr/bin/env node
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'paper-campaign.mjs');
const sourceArgs = process.argv.slice(2);
let pollMs = 1000;
const forwarded = [];
for (let index = 0; index < sourceArgs.length; index += 1) {
  if (sourceArgs[index] === '--poll-ms') pollMs = Math.max(100, Number(sourceArgs[++index] || 1000));
  else if (sourceArgs[index] !== '--action' && sourceArgs[index - 1] !== '--action') forwarded.push(sourceArgs[index]);
}
let stopping = false;
process.once('SIGINT', () => { stopping = true; });
process.once('SIGTERM', () => { stopping = true; });

function runWorker() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, '--action', 'work', ...forwarded], { stdio: 'inherit', env: process.env });
    child.once('error', reject);
    child.once('close', (code) => resolve(Number(code || 0)));
  });
}

while (!stopping) {
  const exitCode = await runWorker();
  if (exitCode !== 0) process.stderr.write(`campaign worker batch failed with exit code ${exitCode}; retrying\n`);
  if (!stopping) await new Promise((resolve) => setTimeout(resolve, pollMs));
}
