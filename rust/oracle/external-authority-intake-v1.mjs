// Test-only passive oracle. No provider or signing process is selected.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { composeProductionExternalAuthorityIntake } from '../../paper-composition/automation/production-external-authority-intake-composition.mjs';
import { productionOracleProfile } from './production-record-hash-v1.mjs';
const root = path.resolve(import.meta.dirname, '../..');
const requests = JSON.parse(fs.readFileSync(0, 'utf8'));
if (!Array.isArray(requests) || requests.length > 64) throw new Error('bounded_oracle_requests_required');
const keys = ['HEPTA_RESEARCH_AUTHOR_IDENTITY_CONFIG', 'HEPTA_RESEARCH_AUTHOR_IDENTITY_CONFIG_HASH', 'HEPTA_RESEARCH_EXECUTION_RELEASE_ATTESTOR_CONFIG', 'HEPTA_RESEARCH_EXECUTION_RELEASE_ATTESTOR_CONFIG_HASH'];
function environment(selected) {
  const result = {};
  for (const key of keys) if (Object.hasOwn(selected || {}, key)) result[key] = selected[key];
  return result;
}
const results = requests.map(request => {
  if (request.operation === 'ordinary') {
    if (request.argv?.[0] !== 'operator' || request.argv?.[1] !== 'external-authority-intake') throw new Error('fixed_ordinary_route_required');
    const env = { ...process.env };
    for (const key of keys) delete env[key];
    Object.assign(env, environment(request.environment));
    const child = spawnSync(process.execPath, [path.join(root, 'paper-core/bin/hepta-paper.mjs'), ...request.argv], { cwd: root, env, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024, timeout: 30_000 });
    if (child.error || child.signal) throw child.error || new Error('ordinary_oracle_interrupted');
    return { exitCode: child.status, stdout: child.stdout ? JSON.parse(child.stdout) : null, stderr: child.stderr ? JSON.parse(child.stderr) : null };
  }
  if (request.operation !== 'compose') throw new Error('passive_oracle_operation_required');
  const workspace = path.resolve(request.workspace);
  if (!workspace.startsWith('/tmp/hepta-external-normal-')) throw new Error('private_fixture_workspace_required');
  process.chdir(workspace);
  return composeProductionExternalAuthorityIntake({
    authorConfigPath: request.authorPath ?? null,
    authorExpectedConfigurationHash: request.authorHash ?? null,
    releaseAttestorConfigPath: request.releasePath ?? null,
    releaseAttestorExpectedConfigurationHash: request.releaseHash ?? null,
    environment: environment(request.environment), now: new Date(request.observedAt),
  });
});
process.stdout.write(JSON.stringify({ profile: productionOracleProfile(), results }));
