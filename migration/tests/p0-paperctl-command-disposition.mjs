import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultLegacyPaperFactoryRoot } from '../../paper-core/src/workspace-layout.mjs';
import { PAPER_BATCH_MODES } from '../../paper-core/src/paper-batch-runner.mjs';
import {
  buildLegacyCommandDispositionManifest,
  extractLegacyParserCommands,
} from '../legacy-command-disposition.mjs';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const root = defaultLegacyPaperFactoryRoot();
const sourcePath = path.join(root, 'bin', 'paperctl');
const manifestPath = path.join(workspaceRoot, 'migration', 'P0_PAPERCTL_COMMAND_DISPOSITION.json');
const sourceText = fs.readFileSync(sourcePath, 'utf8');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const regenerated = buildLegacyCommandDispositionManifest({ sourceText });

assert.deepEqual(manifest, regenerated);
assert.equal(manifest.source.commandCount, 760);
assert.equal(manifest.entries.length, 760);
assert.equal(new Set(manifest.entries.map((entry) => entry.command)).size, 760);
assert.equal(manifest.policy.canonicalEntrypoint, 'paper-production-core');
assert.equal(manifest.policy.legacyEntrypointAllowed, false);
assert.equal(manifest.policy.unlistedLegacyCommandAllowed, false);
assert.equal(manifest.policy.pendingP1CommandAllowed, false);
assert.equal(manifest.policy.reportOnlyCommandAuthoritative, false);
assert.equal(manifest.policy.liveExternalActionAllowed, false);

const allowedDispositions = new Set([
  'native_hepta_replacement_route',
  'quarantined_report_or_control_evidence',
  'blocked_pending_p1_semantic_migration',
  'legacy_data_export_only',
  'retired_outside_hepta_paper_control_plane',
]);
for (const entry of manifest.entries) {
  assert.ok(allowedDispositions.has(entry.disposition), entry.command);
  assert.equal(entry.legacyExecutionAllowed, false, entry.command);
  assert.equal(entry.externalActionAllowed, false, entry.command);
  assert.ok(entry.rationale, entry.command);
  if (entry.disposition === 'native_hepta_replacement_route') {
    assert.match(entry.target, /^paper-production-core /);
    const mode = entry.target.match(/--mode ([a-z-]+)/)?.[1];
    if (mode) assert.ok(Object.values(PAPER_BATCH_MODES).includes(mode), entry.target);
  }
}

const parserCommands = extractLegacyParserCommands(sourceText).map((entry) => entry.command);
const dispatchCommands = [...sourceText.matchAll(/args\.cmd\s*==\s*['"]([^'"]+)['"]/g)]
  .map((match) => match[1]);
assert.deepEqual([...new Set(dispatchCommands)].sort(), [...new Set(parserCommands)].sort());

assert.equal(manifest.counts.native_hepta_replacement_route, 10);
assert.equal(manifest.counts.blocked_pending_p1_semantic_migration, 87);
assert.equal(manifest.counts.quarantined_report_or_control_evidence, 566);
assert.equal(manifest.counts.legacy_data_export_only, 4);
assert.equal(manifest.counts.retired_outside_hepta_paper_control_plane, 93);

process.stdout.write(JSON.stringify({
  ok: true,
  kind: 'P0PaperctlCommandDispositionTest',
  parserCommandCount: parserCommands.length,
  dispatchCommandCount: dispatchCommands.length,
  explicitDispositionCount: manifest.entries.length,
  nativeRouteCount: manifest.counts.native_hepta_replacement_route,
  pendingP1Count: manifest.counts.blocked_pending_p1_semantic_migration,
  legacyEntrypointAllowed: false,
  externalActionPerformed: false,
}) + '\n');
