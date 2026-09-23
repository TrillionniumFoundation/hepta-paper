// Differential oracle for the pure automation-readiness policy boundary.
// The query layer is intentionally not called here: requests contain only
// already-observed JSON values and therefore cannot trigger runtime, provider,
// store, release-attestor, or external-authority effects.
import fs from 'node:fs';
import {
  automationReadinessExitCode,
  evaluateAutomationReadiness,
  evaluateAutomationReadinessLevels,
} from '../../paper-application/automation/automation-readiness-policy.mjs';

const requests = JSON.parse(fs.readFileSync(0, 'utf8'));
if (!Array.isArray(requests)) throw new Error('requests_array_required');
const results = requests.map((request) => {
  try {
    let value;
    if (request?.operation === 'evaluate') {
      value = evaluateAutomationReadiness(request.input);
    } else if (request?.operation === 'levels') {
      value = evaluateAutomationReadinessLevels(request.input);
    } else if (request?.operation === 'exit') {
      value = automationReadinessExitCode(request.evaluation, request.options);
    } else {
      throw new Error('unknown_automation_policy_operation');
    }
    return { ok: true, value };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
});
process.stdout.write(JSON.stringify({
  profile: { node: process.version },
  results,
}));
