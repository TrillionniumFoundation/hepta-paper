#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveImmutableLegacyMatrixArchive } from '../../migration/legacy-matrix-reference.mjs';
import { createOffhostWormSnapshot, drillOffhostWormRestore, verifyOffhostWormTarget } from '../src/offhost-worm-repository.mjs';
import { defaultPaperRuntimeRoot } from '../src/workspace-layout.mjs';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const runtimeRoot = defaultPaperRuntimeRoot();
const contractPath = path.join(workspaceRoot, 'paper-core', 'config', 'offhost-worm-contract.v1.json');
const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
const command = process.argv[2] || 'status';
const execute = process.argv.includes('--execute');
const pointerPath = (() => {
  const root = path.join(runtimeRoot, 'release-evidence');
  const rows = fs.existsSync(root) ? fs.readdirSync(root).filter((name) => /^\d/.test(name)).sort() : [];
  const versionRoot = rows.length ? path.join(root, rows.at(-1)) : null;
  if (!versionRoot) return null;
  const commits = fs.readdirSync(versionRoot).sort();
  return commits.length ? path.join(versionRoot, commits.at(-1), 'CURRENT_RELEASE_EVIDENCE.json') : null;
})();
let result;
if (command === 'status') result = verifyOffhostWormTarget({ workspaceRoot, contract });
else if (command === 'snapshot') {
  const pointer = pointerPath && fs.existsSync(pointerPath) ? JSON.parse(fs.readFileSync(pointerPath, 'utf8')) : null;
  const sources = [
    { role: 'release_evidence_pointer', path: pointerPath || '' },
    { role: 'release_evidence_bundle', path: pointer?.bundlePath || '' },
    { role: 'release_evidence_signature', path: pointer?.signaturePath || '' },
    { role: 'legacy_reference_archive', path: resolveImmutableLegacyMatrixArchive() },
    { role: 'legacy_differential_fixture', path: path.join(workspaceRoot, 'migration', 'fixtures', 'legacy-differential-reference-v1.tar.gz') },
    { role: 'native_store_snapshot_source', path: path.join(runtimeRoot, 'hepta-paper.sqlite') },
  ];
  result = createOffhostWormSnapshot({ workspaceRoot, contract, sources, execute });
} else if (command === 'restore-drill') {
  const manifestIndex = process.argv.indexOf('--manifest');
  result = drillOffhostWormRestore({ manifestPath: manifestIndex >= 0 ? path.resolve(process.argv[manifestIndex + 1]) : null });
} else throw new Error(`Unknown offhost WORM command: ${command}`);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (result.status.endsWith('_blocked')) process.exitCode = 1;
