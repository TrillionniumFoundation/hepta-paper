import test from 'node:test';
import assert from 'node:assert/strict';
import { auditCurrentCoverage } from '../../docs/tools/audit-node-rust-coverage.mjs';
import { renderNodeRustGapReport } from '../../docs/tools/generate-node-rust-gap-report.mjs';

const report = auditCurrentCoverage();
const tableRows = (content) => content.split('\n').filter((line) => line.startsWith('| `'));

test('gap ledger retains every real route and remaining partial-source gap', () => {
  const content = renderNodeRustGapReport(report);
  const rows = tableRows(content);
  assert.equal(rows.length, report.commands.length);
  for (const mapping of report.commandMappings.commands) {
    const row = rows.find((line) => line.startsWith(`| \`${mapping.id}\` |`));
    assert.ok(row, `${mapping.id} must remain visible`);
    assert.ok(row.includes(`\`${mapping.scope}\``));
    assert.ok(row.includes(mapping.remaining.replaceAll('|', '\\|').replaceAll('\n', ' ')));
  }
  assert.ok(content.includes(`- Partial source candidates: **${report.commandMappings.mappedCommands}**`));
  assert.ok(content.includes('- Source of truth: `docs/migration/node-rust-command-map.v1.json` + live command registry'));
  assert.ok(!content.includes('- Inventory binding:'));
  assert.ok(content.includes('- Independently accepted parity rows: **0**'));
  assert.ok(content.includes(`- Open command gaps: **${report.commands.length}**`));
});

test('mapping every route to partial source never removes a gap or grants acceptance', () => {
  const partial = structuredClone(report);
  for (const row of partial.commandMappings.commands) {
    row.scope = 'partial_local_source';
    row.rustEntrypoint ||= 'hepta-paper-rust candidate';
  }
  const content = renderNodeRustGapReport(partial);
  assert.ok(content.includes('- Unmapped commands: **0**'));
  assert.ok(content.includes(`- Partial source candidates: **${report.commands.length}**`));
  assert.equal(tableRows(content).length, report.commands.length);
  assert.ok(content.includes('- Independently accepted parity rows: **0**'));
  assert.ok(content.includes('- Accepted parity: `false`'));
  assert.ok(content.includes('- Production activation: `false`'));
  assert.ok(content.includes('- Node retirement: `false`'));
});

test('omitted mappings and newly registered unmapped routes fail instead of disappearing', () => {
  const missing = structuredClone(report);
  missing.commandMappings.commands.pop();
  assert.throws(() => renderNodeRustGapReport(missing), /missing gap mapping/);

  const future = structuredClone(report);
  future.commands.push({ ...future.commands[0], id: 'operator/new-unmapped-route' });
  assert.throws(() => renderNodeRustGapReport(future), /missing gap mapping.*new-unmapped-route/);

  const orphan = structuredClone(report);
  orphan.commands.pop();
  assert.throws(() => renderNodeRustGapReport(orphan), /missing route inventory/);
});

test('duplicate identities and unsupported closed statuses cannot hide gaps', () => {
  const duplicate = structuredClone(report);
  duplicate.commandMappings.commands.push(duplicate.commandMappings.commands[0]);
  assert.throws(() => renderNodeRustGapReport(duplicate), /duplicate command/);

  const closed = structuredClone(report);
  closed.commandMappings.commands[0].scope = 'accepted';
  assert.throws(() => renderNodeRustGapReport(closed), /unsupported or empty gap mapping/);

  const unsupportedAcceptance = structuredClone(report);
  unsupportedAcceptance.acceptedParityRows = 1;
  assert.throws(() => renderNodeRustGapReport(unsupportedAcceptance), /cannot establish independent acceptance/);
});

test('Rust argument alternatives stay inside one Markdown table cell', () => {
  const variant = structuredClone(report);
  const row = variant.commandMappings.commands[0];
  row.scope = 'partial_local_source';
  row.rustEntrypoint = 'hepta-rust {status|verify}';
  row.remaining = 'argument A|B still needs acceptance';
  const content = renderNodeRustGapReport(variant);
  assert.ok(content.includes('`hepta-rust {status\\|verify}`'));
  assert.ok(content.includes('argument A\\|B still needs acceptance'));
});
