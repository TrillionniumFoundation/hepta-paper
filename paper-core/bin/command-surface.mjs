#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyNpmScriptSurface,
  generatedNpmRouteScripts,
  heptaPaperCiCommandMatrix,
  heptaPaperCommandUsage,
  inspectNpmScriptRegistry,
} from '../src/command-registry.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const packagePath = path.join(root, 'package.json');
const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
const scripts = packageJson.scripts || {};
const argumentsSet = new Set(process.argv.slice(2));

if (argumentsSet.has('--write-package')) {
  const nextPackage = {
    ...packageJson,
    scripts: {
      ...scripts,
      ...generatedNpmRouteScripts(),
    },
  };
  fs.writeFileSync(packagePath, `${JSON.stringify(nextPackage, null, 2)}\n`, { mode: 0o644 });
  const inspection = inspectNpmScriptRegistry(nextPackage.scripts);
  process.stdout.write(`${JSON.stringify(inspection, null, 2)}\n`);
  process.exit(inspection.ready ? 0 : 1);
}

if (argumentsSet.has('--check-package')) {
  const inspection = inspectNpmScriptRegistry(scripts);
  process.stdout.write(`${JSON.stringify(inspection, null, 2)}\n`);
  process.exit(inspection.ready ? 0 : 1);
}

if (argumentsSet.has('--npm-aliases')) {
  process.stdout.write(`${JSON.stringify(generatedNpmRouteScripts(), null, 2)}\n`);
} else if (argumentsSet.has('--help-artifact')) {
  process.stdout.write(`${JSON.stringify(heptaPaperCommandUsage(), null, 2)}\n`);
} else if (argumentsSet.has('--ci-matrix')) {
  process.stdout.write(`${JSON.stringify(heptaPaperCiCommandMatrix(), null, 2)}\n`);
} else {
  process.stdout.write(`${JSON.stringify(classifyNpmScriptSurface(Object.keys(scripts)), null, 2)}\n`);
}
