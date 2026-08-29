#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { encodeLegacyStableJsonV1, hashLegacyStableJsonV1 } from './node-oracle.mjs';

const root = path.resolve(import.meta.dirname, '..');
const fixtures = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'legacy-stable-json-v1-fixtures.json'), 'utf8'));
const binary = process.env.HEPTA_LEGACY_ORACLE || path.join(root, 'target/debug/hepta-legacy-json-v1');
for (const fixture of fixtures) {
  const input = JSON.stringify(fixture.input);
  const nodeCanonical = encodeLegacyStableJsonV1(fixture.input).toString('utf8');
  const nodeHash = hashLegacyStableJsonV1(fixture.input);
  assert.equal(nodeCanonical, fixture.canonical, `${fixture.name}: frozen canonical bytes`);
  const result = spawnSync(binary, [], { input, encoding: 'utf8', env: {} });
  assert.equal(result.status, 0, `${fixture.name}: Rust oracle failed: ${result.stderr}`);
  const [rustCanonical, rustHash, trailing] = result.stdout.split('\n');
  assert.equal(trailing, '', `${fixture.name}: unexpected Rust output`);
  assert.equal(rustCanonical, nodeCanonical, `${fixture.name}: canonical byte drift`);
  assert.equal(rustHash, nodeHash, `${fixture.name}: hash drift`);
}
process.stdout.write(JSON.stringify({ status: 'legacy_v1_parity_verified', fixtures: fixtures.length }) + '\n');
