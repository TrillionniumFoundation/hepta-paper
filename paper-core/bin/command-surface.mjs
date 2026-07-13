#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const scripts = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts || {};
const groups = { operator: [], verification: [], retirement: [], internal: [] };
for (const name of Object.keys(scripts).sort()) {
  if (name.endsWith('-inner') || name.endsWith(':inner')) groups.internal.push(name);
  else if (/^(?:migration|legacy):/.test(name)) groups.retirement.push(name);
  else if (/^(?:test|coverage|ci|release|core:|paper:.*selftest|provider:.*selftest)/.test(name)) groups.verification.push(name);
  else groups.operator.push(name);
}
process.stdout.write(`${JSON.stringify({ version: 1, kind: 'NpmCommandSurface', groups }, null, 2)}\n`);
