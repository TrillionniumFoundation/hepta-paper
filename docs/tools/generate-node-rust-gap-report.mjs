#!/usr/bin/env node
// Generate the reviewed Node/Rust command-gap ledger, including partial source.
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
    return 'Rust verifier/retirement implementation plus exact-head, historical, recovery, maintainer evaluation, and authority-removal evidence.';
  }
  if (category === 'external authority / target host') {
    return 'Complete Rust call chain first, then target-host/external authority qualification, recovery evidence, and writer/credential ownership.';
  }
  return 'Complete Rust call chain covering every argument mode, state transition, lease, retry, crash, cancellation, and external-effect boundary.';
}

export function renderNodeRustGapReport(report) {
  // The source inventory has no acceptance-receipt consumer. Never turn a
  // partial mapping, omitted mapping, or unsupported status into a closed gap.
  if (report.acceptedParityRows !== 0 || report.commandMappings.acceptedParity !== false
      || report.commandMappings.productionActivation !== false
      || report.commandMappings.nodeRetirement !== false) {
    throw new Error('source gap ledger cannot establish independent acceptance');
  }
  const rows = [...report.commandMappings.commands];
  const routes = new Map(report.commands.map((route) => [route.id, route]));
  const mappedIds = new Set(rows.map((row) => row.id));
  if (routes.size !== report.commands.length || mappedIds.size !== rows.length) {
    throw new Error('duplicate command in gap ledger inventory');
  }
  for (const route of report.commands) {
    if (!mappedIds.has(route.id)) throw new Error(`missing gap mapping for ${route.id}`);
  }
  for (const row of rows) {
    if (!routes.has(row.id)) throw new Error(`missing route inventory for ${row.id}`);
    if (!['unmapped', 'partial_local_source'].includes(row.scope)
        || typeof row.remaining !== 'string' || !row.remaining.trim()) {
      throw new Error(`unsupported or empty gap mapping for ${row.id}`);
    }
  }
  rows.sort((left, right) => left.id.localeCompare(right.id));
  const unmapped = rows.filter((row) => row.scope === 'unmapped').length;
  const partial = rows.filter((row) => row.scope === 'partial_local_source').length;
  const cell = (value) => String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
  const lines = [
    '# Node/Rust command gap closure ledger',
    '',
    '> Generated from `docs/migration/node-rust-command-map.v1.json` and the live command registry. Unmapped and partially implemented commands remain open. This ledger does not grant parity, production activation, or Node retirement.',
    '',
    '- Source of truth: `docs/migration/node-rust-command-map.v1.json` + live command registry',
    `- Total command routes: **${report.commands.length}**`,
    `- Unmapped commands: **${unmapped}**`,
    `- Partial source candidates: **${partial}**`,
    `- Independently accepted parity rows: **${report.acceptedParityRows}**`,
    `- Open command gaps: **${rows.length}**`,
    `- Accepted parity: \`${report.commandMappings.acceptedParity}\``,
    `- Production activation: \`${report.commandMappings.productionActivation}\``,
    `- Node retirement: \`${report.commandMappings.nodeRetirement}\``,
    '',
    '| Route | Source mapping | Node entrypoint | Rust candidate | Category | Current gap | Required closure evidence |',
    '|---|---|---|---|---|---|---|',
  ];
  for (const row of rows) {
    const route = routes.get(row.id);
    const category = classify(row, route);
    const argv = route.nodeArgv.map((value) => `\`${cell(value)}\``).join(' ');
    const rust = row.rustEntrypoint ? `\`${cell(row.rustEntrypoint)}\`` : '—';
    lines.push(`| \`${row.id}\` | \`${row.scope}\` | ${argv} | ${rust} | ${category} | ${cell(row.remaining)} | ${criterion(category)} |`);
  }
  lines.push('', 'Partial source candidates remain in this ledger with their remaining implementation and qualification gaps. A smaller unmapped count is source-mapping progress, not closure. This source-only generator cannot remove a route as accepted: independent command/mode acceptance and the required qualification evidence need a separate verified acceptance process.');
  return `${lines.join('\n')}\n`;
}

function main() {
  const args = process.argv.slice(2);
  if (args.length && !(args.length === 1 && args[0] === '--check')) {
    throw new Error('usage: generate-node-rust-gap-report.mjs [--check]');
  }
  const report = auditCurrentCoverage();
  const content = renderNodeRustGapReport(report);
  const rows = report.commandMappings.commands;
  if (args.includes('--check')) {
    const current = fs.readFileSync(OUTPUT, 'utf8');
    if (current !== content) {
      process.stderr.write(`stale ${path.relative(ROOT, OUTPUT)}\n`);
      process.exitCode = 1;
    } else process.stdout.write(`checked ${path.relative(ROOT, OUTPUT)} rows=${rows.length}\n`);
  } else {
    fs.writeFileSync(OUTPUT, content, { mode: 0o644 });
    process.stdout.write(`generated ${path.relative(ROOT, OUTPUT)} rows=${rows.length}\n`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
