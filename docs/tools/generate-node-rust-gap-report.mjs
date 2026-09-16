#!/usr/bin/env node
// Generate the reviewed Node/Rust unmapped-command closure ledger.
// This is a source/documentation aid; it never grants parity or authority.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditCurrentCoverage } from './audit-node-rust-coverage.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUTPUT = path.join(ROOT, 'docs/migration/NODE_RUST_GAP_CLOSURE.md');

function classify(row, route) {
  const id = row.id;
  if (id === 'verify/full') return 'local parity acceptance';
  if (id === 'maintenance/command-surface-sync') return 'local tooling';
  if (id.startsWith('retirement/') || id.startsWith('verify/')) return 'verification / retirement authority';
  if (route.effects?.credentialUse !== 'none' || route.effects?.externalAction !== 'none'
      || route.effects?.networkUse !== 'none' || route.effects?.providerCost !== 'none') {
    return 'external authority / target host';
  }
  return 'full Rust business call chain';
}

function criterion(category) {
  if (category === 'local parity acceptance') {
    return 'Rust implementation of the complete Node test surface, argument modes, failure matrix, and independent acceptance evidence.';
  }
  if (category === 'local tooling') {
    return 'Rust-owned deterministic generator with byte-compatible outputs, negative tests, and no Node execution dependency.';
  }
  if (category === 'verification / retirement authority') {
    return 'Rust verifier/retirement implementation plus exact-head, historical, recovery, independent review, and authority-removal evidence.';
  }
  if (category === 'external authority / target host') {
    return 'Complete Rust call chain first, then target-host/external authority qualification, recovery evidence, and writer/credential ownership.';
  }
  return 'Complete Rust call chain covering every argument mode, state transition, lease, retry, crash, cancellation, and external-effect boundary.';
}

const report = auditCurrentCoverage();
const rows = report.commandMappings.commands.filter((row) => row.scope === 'unmapped');
const routes = new Map(report.commands.map((route) => [route.id, route]));
rows.sort((left, right) => left.id.localeCompare(right.id));
const lines = [
  '# Node/Rust unmapped command closure ledger',
  '',
  '> Generated from `docs/migration/node-rust-command-map.v1.json` and the live command registry. This ledger records closure work; it does not grant parity, production activation, or Node retirement.',
  '',
  `- Inventory binding: \`${report.inventorySha256}\``,
  `- Unmapped commands: **${rows.length}**`,
  `- Accepted parity: \`${report.commandMappings.acceptedParity}\``,
  `- Production activation: \`${report.commandMappings.productionActivation}\``,
  `- Node retirement: \`${report.commandMappings.nodeRetirement}\``,
  '',
  '| Route | Node entrypoint | Category | Current gap | Required closure evidence |',
  '|---|---|---|---|---|',
];
for (const row of rows) {
  const route = routes.get(row.id);
  if (!route) throw new Error(`missing route inventory for ${row.id}`);
  const category = classify(row, route);
  const argv = route.nodeArgv.map((value) => `\`${value}\``).join(' ');
  const remaining = row.remaining.replaceAll('|', '\\|');
  lines.push(`| \`${row.id}\` | ${argv} | ${category} | ${remaining} | ${criterion(category)} |`);
}
lines.push('', 'The ledger is intentionally closed by evidence, not by changing a status token. A route moves out of this file only when its command-map row binds a real Rust entrypoint, complete call chain, executable tests, and the required qualification package.');
fs.writeFileSync(OUTPUT, `${lines.join('\n')}\n`, { mode: 0o644 });
process.stdout.write(`generated ${path.relative(ROOT, OUTPUT)} rows=${rows.length}\n`);
