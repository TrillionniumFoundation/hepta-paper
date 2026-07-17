#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyNpmScriptSurface } from '../src/command-registry.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const scripts = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts || {};
process.stdout.write(`${JSON.stringify(classifyNpmScriptSurface(Object.keys(scripts)), null, 2)}\n`);
