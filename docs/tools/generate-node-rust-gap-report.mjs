#!/usr/bin/env node
// Generate the reviewed Node/Rust command-gap ledger, including partial source.
// Source gaps and independently replayed local behavior acceptance stay scoped.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditCurrentCoverage } from './audit-node-rust-coverage.mjs';
import { assertVerifiedRouteAcceptanceV1, consumeRouteAcceptanceRecordV1,
  readRouteAcceptanceRecord } from './node-rust-route-acceptance.mjs';

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
  const acceptance = report.commandAcceptance == null ? null
    : assertVerifiedRouteAcceptanceV1(report.commandAcceptance);
  const acceptedIds = new Set(acceptance?.acceptedRouteIds || []);
  // Serialized claims, source mapping and status words cannot close a gap.
  if (report.acceptedParityRows !== acceptedIds.size || report.commandMappings.acceptedParity !== false
      || report.commandMappings.productionActivation !== false
      || report.commandMappings.nodeRetirement !== false) {
    throw new Error('source gap ledger cannot establish independent acceptance without actual replay');
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
  if ([...acceptedIds].some(id => !mappedIds.has(id))) throw new Error('accepted route missing from source ledger');
  rows.sort((left, right) => left.id.localeCompare(right.id));
  const unmapped = rows.filter((row) => row.scope === 'unmapped').length;
  const partial = rows.filter((row) => row.scope === 'partial_local_source').length;
  const cell = (value) => String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
  const lines = [
    '# Node/Rust command gap closure ledger',
    '',
    '> Generated from the digest-bound shard manifest `docs/migration/node-rust-command-map.v2.json` and the live command registry. Local command acceptance is included only after independent current-subject CLI replay. It does not grant host qualification, production activation, release/submission authority, writer cutover or Node retirement.',
    '',
    '- Source of truth: digest-bound `docs/migration/node-rust-command-map.v2.json` manifest + shards + live command registry',
    `- Total command routes: **${report.commands.length}**`,
    `- Unmapped commands: **${unmapped}**`,
    `- Partial source candidates: **${partial}**`,
    `- Independently accepted parity rows: **${report.acceptedParityRows}**`,
    `- Open command gaps: **${rows.length - acceptedIds.size}**`,
    `- Acceptance replay: \`${acceptance ? 'current-subject-ordinary-CLI-verified' : 'not-requested'}\``,
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
    const accepted = acceptedIds.has(row.id);
    const scope = accepted ? 'accepted_local_behavior' : row.scope;
    const remaining = accepted
      ? 'Declared local UTF-8 read-only argument/data/refusal/process-recovery contract accepted for the current subject. Installation and authority qualification remain separate.' : row.remaining;
    const required = accepted ? 'Current commit/tree rebuilt and both ordinary CLIs independently replayed; the acceptance record grants no external authority.' : criterion(category);
    lines.push(`| \`${row.id}\` | \`${scope}\` | ${argv} | ${rust} | ${category} | ${cell(remaining)} | ${required} |`);
  }
  lines.push('', 'Every route remains visible. Source mappings do not establish acceptance. A local behavior gap closes only when the current-subject consumer actually rebuilds and replays the complete declared command matrix; installation, external authority and Node retirement remain separate requirements.');
  return `${lines.join('\n')}\n`;
}

async function main() {
  const args = process.argv.slice(2);
  let acceptancePath = null;
  let outputPath = OUTPUT;
  let check = false;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--check' && !check) check = true;
    else if (args[index] === '--acceptance-record' && !acceptancePath && args[index + 1]) acceptancePath = args[++index];
    else if (args[index] === '--output' && outputPath === OUTPUT && args[index + 1]) outputPath = args[++index];
    else throw new Error('usage: generate-node-rust-gap-report.mjs [--check] [--acceptance-record ABSOLUTE_JSON --output ABSOLUTE_PATH]');
  }
  if (!path.isAbsolute(outputPath) || path.resolve(outputPath) !== outputPath
    || (acceptancePath !== null && (outputPath === ROOT || outputPath.startsWith(`${ROOT}${path.sep}`)))) {
    throw new Error('current-subject acceptance report output must be outside the source checkout');
  }
  const routeAcceptance = acceptancePath === null ? null
    : await consumeRouteAcceptanceRecordV1(readRouteAcceptanceRecord(acceptancePath));
  const report = auditCurrentCoverage({ routeAcceptance });
  const content = renderNodeRustGapReport(report);
  const rows = report.commandMappings.commands;
  if (check) {
    const current = fs.readFileSync(outputPath, 'utf8');
    if (current !== content) {
      process.stderr.write(`stale ${path.relative(ROOT, outputPath)}\n`);
      process.exitCode = 1;
    } else process.stdout.write(`checked ${path.relative(ROOT, outputPath)} rows=${rows.length}\n`);
  } else {
    fs.writeFileSync(outputPath, content, { mode: 0o644 });
    process.stdout.write(`generated ${path.relative(ROOT, outputPath)} rows=${rows.length} accepted=${report.acceptedParityRows}\n`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
