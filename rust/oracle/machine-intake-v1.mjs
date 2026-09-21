// Executes incumbent functions directly; no copied provider normalizer/hash.
import crypto from 'node:crypto';
import {
  resolveAutonomousResearchProviderConfiguration,
  verifyAutonomousResearchProviderConfiguration,
  requireAutonomousResearchProviderConfiguration,
} from '../../paper-composition/automation/autonomous-research-provider-configuration.mjs';
import {runMachineIntakeFixture} from './machine-intake-fixture-v1.mjs';
import {productionOracleProfile} from './production-record-hash-v1.mjs';

function captured(operation) {
  try { return {ok: true, value: operation()}; }
  catch (error) { return {ok: false, error: error.message}; }
}
function run(input) {
  if (input.action === 'intake') return runMachineIntakeFixture(input);
  if (input.action === 'providers') return input.cases.map(candidate => {
    const resolved = captured(() => resolveAutonomousResearchProviderConfiguration(candidate));
    if (!resolved.ok) return resolved;
    return {...resolved, verified: verifyAutonomousResearchProviderConfiguration(resolved.value)};
  });
  if (input.action === 'verify-providers') return input.cases.map(candidate => ({
    verified: verifyAutonomousResearchProviderConfiguration(candidate.configuration),
    required: captured(() => requireAutonomousResearchProviderConfiguration(candidate.configuration, {expectedHash: candidate.expectedHash ?? null})),
  }));
  if (input.action === 'normalization') {
    const hash = crypto.createHash('sha256');
    let count = 0;
    for (let scalar = 0; scalar <= 0x10ffff; scalar++) {
      if (scalar >= 0xd800 && scalar <= 0xdfff) continue;
      const normalized = Buffer.from(String.fromCodePoint(scalar).normalize('NFKC'));
      const frame = Buffer.alloc(8);
      frame.writeUInt32LE(scalar, 0); frame.writeUInt32LE(normalized.length, 4);
      hash.update(frame); hash.update(normalized); count++;
    }
    return {unicode: process.versions.unicode, count, digest: hash.digest('hex'), sequences: input.sequences.map(text => text.normalize('NFKC'))};
  }
  throw Error('machine_intake_oracle_action_unknown');
}
const input = JSON.parse(process.argv[2]);
process.stdout.write(JSON.stringify({profile:productionOracleProfile(), value:run(input)}));
