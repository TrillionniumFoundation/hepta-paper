// Test-only read observations of isolated temporary SQLite fixtures.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { inspectAutonomousResearchStatePendingFinalizations } from '../../paper-adapters/automation/autonomous-research-state-reconciliation-database.mjs';
import { productionOracleProfile } from './production-record-hash-v1.mjs';
import {
  resolveAutonomousResearchStateDatabaseInventory,
  resolveAutonomousSubmissionHandoffStateDatabaseInventory,
  withAutonomousResearchStateDatabasePrivateSnapshot,
} from '../../paper-adapters/automation/autonomous-research-state-database-inventory.mjs';

const requests = JSON.parse(fs.readFileSync(0, 'utf8'));
const results = requests.map(({ runtimeRoot, manifest, handoff = false, operation, instanceId }) => {
  try {
    if (!runtimeRoot.startsWith('/tmp/hepta-rust-live-inventory-test-')) {
      throw new Error('isolated_fixture_required');
    }
    const resolve = handoff
      ? resolveAutonomousSubmissionHandoffStateDatabaseInventory
      : resolveAutonomousResearchStateDatabaseInventory;
    if (operation === 'pending') {
      const instance = resolve({ runtimeRoot, manifest }).instances.find(row => row.instanceId === instanceId);
      if (!instance) throw new Error('fixture_instance_missing');
      const value = withAutonomousResearchStateDatabasePrivateSnapshot({
        sourcePath: path.join(runtimeRoot, instance.sourceRelativePath),
        inspect(copy) {
          const database = new DatabaseSync(copy, { readOnly: true });
          try {
            return inspectAutonomousResearchStatePendingFinalizations({ database, databaseRole: instance.role, databaseInstanceId: instance.instanceId });
          } finally { database.close(); }
        },
      });
      return { ok: true, value };
    }
    return { ok: true, value: resolve({ runtimeRoot, manifest }) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});
process.stdout.write(JSON.stringify({ profile: productionOracleProfile(), results }));
