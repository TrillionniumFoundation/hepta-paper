// Test-only oracle. Every environment and file below is explicitly synthetic.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  AUTOMATION_READINESS_DEPLOYMENT_ENVIRONMENT_KEYS as keys,
  loadAutomationReadinessDeploymentEnvironment as load,
} from '../../paper-adapters/automation/deployment-environment-file.mjs';
assert.equal(process.version, 'v22.23.1');
assert.deepEqual(JSON.parse(fs.readFileSync(new URL('../crates/hepta-paper-service/src/deployment_environment/allowed-keys.v1.json', import.meta.url))), keys);
const requests = JSON.parse(fs.readFileSync(0, 'utf8'));
const results = requests.map(request => {
  try {
    return { ok: load({ baseEnvironment: request.base, filePath: request.path }) };
  } catch (error) {
    return { error: error.message };
  }
});
process.stdout.write(JSON.stringify(results));
