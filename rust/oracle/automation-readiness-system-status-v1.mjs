// Differential oracle for the pure automation system-status projection.
import fs from 'node:fs';
import {
  deriveFullyAutonomousResearchSystemStatus,
} from '../../paper-composition/automation/automation-readiness-query.mjs';

const requests = JSON.parse(fs.readFileSync(0, 'utf8'));
if (!Array.isArray(requests)) throw new Error('requests_array_required');
const results = requests.map((request) => {
  try {
    return {
      ok: true,
      value: deriveFullyAutonomousResearchSystemStatus({
        readinessLevels: request?.readinessLevels,
        coreStatus: request?.coreStatus,
      }),
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
});
process.stdout.write(JSON.stringify({ results }));
