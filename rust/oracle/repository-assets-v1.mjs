#!/usr/bin/env node
// Offline differential oracle for the incumbent repository-asset command.
import fs from 'node:fs';
import {
  inspectRepositoryAssetExternalization,
  buildRepositoryAssetExternalizationHandoff,
} from '../../paper-adapters/automation/repository-asset-externalization.mjs';

const input = fs.readFileSync(0);
if (input.length > 4 * 1024 * 1024) throw new Error('oracle_input_limit');
const requests = JSON.parse(input.toString('utf8'));
if (!Array.isArray(requests) || requests.length > 64) throw new Error('oracle_request_limit');
const results = requests.map(({ repositoryRoot, manifest, handoff = false }) => {
  try {
    return { ok: true, value: (handoff
      ? buildRepositoryAssetExternalizationHandoff
      : inspectRepositoryAssetExternalization)({ repositoryRoot, manifest }) };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
});
process.stdout.write(`${JSON.stringify({ profile: { node: process.version }, results })}\n`);
