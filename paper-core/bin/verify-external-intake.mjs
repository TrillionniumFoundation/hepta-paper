#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyExternalIntake } from '../../paper-composition/bootstrap/operator-governance-composition.mjs';
import { currentCodeProvenance } from '../src/code-provenance.mjs';
import { defaultPaperRuntimeRoot } from '../src/workspace-layout.mjs';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const stagingIndex = process.argv.indexOf('--staging');
const stagingRoot = stagingIndex >= 0
  ? path.resolve(process.argv[stagingIndex + 1])
  : path.join(defaultPaperRuntimeRoot(), 'external-intake', 'staging');
const result = verifyExternalIntake({
  stagingRoot,
  workspaceRoot,
  runtimeRoot: defaultPaperRuntimeRoot(),
  releaseCommit: currentCodeProvenance().commit,
});
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (result.status !== 'external_evidence_intake_verified') process.exitCode = 1;
