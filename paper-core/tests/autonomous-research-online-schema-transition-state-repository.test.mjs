import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  autonomousResearchOnlineSchemaTransitionControlPaths,
  readAutonomousResearchOnlineSchemaTransitionJson,
  writeAutonomousResearchOnlineSchemaTransitionJson,
} from '../../paper-adapters/automation/autonomous-research-online-schema-transition-state-repository.mjs';

test('online schema transition state repository durably owns its bounded control files', (context) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-schema-transition-state-'));
  context.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const paths = autonomousResearchOnlineSchemaTransitionControlPaths(runtimeRoot);
  assert.equal(path.relative(runtimeRoot, paths.activeStatePath),
    path.join('autonomous-research', 'online-schema-transition', 'ACTIVE.json'));
  assert.equal(readAutonomousResearchOnlineSchemaTransitionJson(paths.activeStatePath), null);
  const state = Object.freeze({ version: 1, kind: 'FixtureTransitionState', phase: 'reserved' });
  writeAutonomousResearchOnlineSchemaTransitionJson(paths.activeStatePath, state);
  assert.deepEqual(readAutonomousResearchOnlineSchemaTransitionJson(paths.activeStatePath), state);
  assert.equal(fs.statSync(paths.activeStatePath).mode & 0o777, 0o600);
});

test('online schema transition state repository rejects unsafe or invalid control files', (context) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-schema-transition-invalid-'));
  context.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const paths = autonomousResearchOnlineSchemaTransitionControlPaths(runtimeRoot);
  fs.writeFileSync(paths.activeStatePath, '{}', { mode: 0o666 });
  assert.throws(
    () => readAutonomousResearchOnlineSchemaTransitionJson(paths.activeStatePath),
    /autonomous_research_online_schema_transition_control_file_unsafe/,
  );
  fs.chmodSync(paths.activeStatePath, 0o600);
  fs.writeFileSync(paths.activeStatePath, '{', { mode: 0o600 });
  assert.throws(
    () => readAutonomousResearchOnlineSchemaTransitionJson(paths.activeStatePath),
    /autonomous_research_online_schema_transition_control_file_invalid/,
  );
});
