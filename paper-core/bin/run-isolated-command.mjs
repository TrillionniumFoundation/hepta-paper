#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { copySqliteDatabase } from '../../paper-composition/bootstrap/operator-persistence-composition.mjs';
import { defaultPaperAssetRoot, defaultPaperRuntimeRoot } from '../src/workspace-layout.mjs';
import { currentCodeProvenance } from '../src/code-provenance.mjs';
import { prepareImmutableLegacyMatrixReference } from '../../migration/legacy-matrix-reference.mjs';
import { sha256FileSync } from '../../workflow-kernel/runtime/file-utils.mjs';
import { prepareIsolatedRuntimeStore } from './isolated-runtime-store.mjs';

const args = process.argv.slice(2);
if (!args.length) throw new Error('Usage: run-isolated-command.mjs <command> [args...]');

function sha(file) {
  return fs.existsSync(file) ? sha256FileSync(file) : null;
}

function run(env) {
  return spawnSync(args[0], args.slice(1), {
    cwd: process.cwd(),
    env,
    encoding: 'utf8',
    stdio: ['inherit', 'inherit', 'inherit'],
  });
}

if (process.env.HEPTA_PAPER_RUNTIME_ISOLATED === '1' && process.env.HEPTA_PAPER_RUNTIME_ROOT) {
  const result = run(process.env);
  process.exitCode = result.status ?? 1;
} else {
  const productionRuntimeRoot = defaultPaperRuntimeRoot();
  const productionDb = path.join(productionRuntimeRoot, 'hepta-paper.sqlite');
  const isolatedRuntimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-paper-command-'));
  const isolatedDb = path.join(isolatedRuntimeRoot, 'hepta-paper.sqlite');
  const productionHashBefore = sha(productionDb);
  const legacyReference = prepareImmutableLegacyMatrixReference();
  if (fs.existsSync(productionDb)) await copySqliteDatabase({ sourcePath: productionDb, destinationPath: isolatedDb });
  for (const relative of ['owner-acceptance', 'operational-proof', 'trust', 'authority-inbox', 'legacy-retirement', path.join('release-evidence', 'current'), path.join('audits', 'capability-verification')]) {
    const source = path.join(productionRuntimeRoot, relative);
    const target = path.join(isolatedRuntimeRoot, relative);
    if (fs.existsSync(source)) fs.cpSync(source, target, { recursive: true, dereference: false });
  }
  prepareIsolatedRuntimeStore({
    root: defaultPaperAssetRoot(),
    runtimeRoot: isolatedRuntimeRoot,
    dbPath: isolatedDb,
  });
  const provenance = currentCodeProvenance();
  const env = {
    ...process.env,
    HEPTA_PAPER_RUNTIME_ROOT: isolatedRuntimeRoot,
    HEPTA_PAPER_RUNTIME_ISOLATED: '1',
    HEPTA_PRODUCTION_RUNTIME_ROOT: productionRuntimeRoot,
    HEPTA_EVIDENCE_ENVIRONMENT: 'verification',
    HEPTA_EVIDENCE_CLASS: 'technical_conformance',
    HEPTA_RELEASE_COMMIT: provenance.commit || '',
    HEPTA_LEGACY_REFERENCE_PREPARED: '1',
    HEPTA_LEGACY_REFERENCE_ARCHIVE: legacyReference.archivePath,
    PAPER_FACTORY_LEGACY_ROOT: legacyReference.root,
  };
  const result = run(env);
  const productionHashAfter = sha(productionDb);
  const mutated = productionHashBefore !== productionHashAfter;
  legacyReference.cleanup();
  if (result.status === 0 && !mutated) fs.rmSync(isolatedRuntimeRoot, { recursive: true, force: true });
  else process.stderr.write(`Isolated command runtime retained: ${isolatedRuntimeRoot}\n`);
  if (mutated) process.stderr.write('Production store changed during isolated command.\n');
  process.exitCode = result.status || (mutated ? 1 : 0);
}
