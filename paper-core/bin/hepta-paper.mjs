#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const commands = Object.freeze({
  operator: Object.freeze({
    workspace: ['node', 'paper-core/bin/workspace-status.mjs'],
    store: ['node', 'paper-core/bin/hepta-store.mjs', 'status'],
    'store-migrate': ['node', 'paper-core/bin/hepta-store.mjs', 'migrate'],
    'store-backup': ['node', 'paper-core/bin/hepta-store.mjs', 'backup'],
    automation: ['node', 'paper-core/bin/automation-status.mjs'],
    reconcile: ['node', 'paper-core/bin/automation-reconcile.mjs'],
    'reconcile-apply': ['node', 'paper-core/bin/automation-reconcile.mjs', '--execute'],
    campaign: ['node', 'paper-core/bin/paper-campaign.mjs'],
    batch: ['node', 'paper-core/bin/paper-production-core.mjs', 'batch-run'],
    gc: ['node', 'paper-core/bin/paper-campaign.mjs', '--action', 'gc'],
    'gc-apply': ['node', 'paper-core/bin/paper-campaign.mjs', '--action', 'gc', '--apply'],
  }),
  verify: Object.freeze({
    architecture: ['node', '--test', 'paper-core/tests/architecture-conformance.test.mjs'],
    critical: ['npm', 'run', 'coverage:critical-modules'],
    store: ['node', 'paper-core/bin/hepta-store-logical-integrity.mjs'],
    release: ['npm', 'run', 'release:verify'],
    trust: ['node', 'paper-core/bin/release-trust-gate.mjs'],
    operational: ['node', 'paper-core/bin/operational-proof-status.mjs'],
    owner: ['node', 'paper-core/bin/owner-acceptance-status.mjs'],
    full: ['npm', 'test'],
  }),
  retirement: Object.freeze({
    status: ['npm', 'run', 'migration:retirement-status'],
    reference: ['node', 'migration/bin/verify-retirement-source-snapshot.mjs'],
    matrix: ['node', 'migration/tests/capability-matrix-v3.mjs', '--release-profile'],
    drill: ['node', 'paper-core/bin/legacy-deletion-drill.mjs'],
  }),
});

function usage() {
  return {
    version: 1,
    kind: 'HeptaPaperCommandSurface',
    usage: 'hepta-paper <operator|verify|retirement> <command> [-- command-args]',
    groups: Object.fromEntries(Object.entries(commands).map(([group, entries]) => [group, Object.keys(entries)])),
    compatibility: 'this CLI is the supported operator surface; npm scripts are internal build and release plumbing',
  };
}

const [group, name, ...extra] = process.argv.slice(2);
if (!group || group === '--help' || group === 'help') {
  process.stdout.write(`${JSON.stringify(usage(), null, 2)}\n`);
  process.exit(0);
}
const selected = commands[group]?.[name];
if (!selected) {
  process.stderr.write(`${JSON.stringify({ ...usage(), error: 'unknown_command', requested: { group, name: name || null } }, null, 2)}\n`);
  process.exit(2);
}
const [executable, ...args] = selected;
const forwarded = extra[0] === '--' ? extra.slice(1) : extra;
const result = spawnSync(executable, [...args, ...forwarded], { cwd: root, stdio: 'inherit', env: process.env });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
