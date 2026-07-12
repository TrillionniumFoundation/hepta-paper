import { createSqliteResourceGovernor } from '../../../paper-adapters/automation/sqlite-resource-governor.mjs';
import { createSqliteStore } from '../../../paper-adapters/persistence/sqlite-store.mjs';

const [dbPath, ownerId, holdMs = '120', mode = 'release'] = process.argv.slice(2);
const store = createSqliteStore({ dbPath });
const governor = createSqliteResourceGovernor({
  store,
  limits: { agent: 1, cpu: 1, gpu: 1, memoryMiB: 1024 },
  ownerId,
  leaseSeconds: 1,
  pollMs: 5,
});
const release = await governor.acquire({ agent: 1, memoryMiB: 128 }, { campaignId: ownerId, nodeId: `${ownerId}:writer` });
process.stdout.write(`${JSON.stringify({ ownerId, event: 'acquired', at: Date.now() })}\n`);
if (mode === 'crash') process.exit(0);
await new Promise((resolve) => setTimeout(resolve, Number(holdMs)));
release();
process.stdout.write(`${JSON.stringify({ ownerId, event: 'released', at: Date.now() })}\n`);
store.close();
