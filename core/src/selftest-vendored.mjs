import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CORE_COMPATIBILITY_MODULES,
  CORE_PUBLIC_MODULES,
  publicApiSummary,
} from './index.mjs';
import { buildChannelImportAllowlist } from './channel-import-allowlist.mjs';
import { buildChannelRunnerCoverageMatrixReport } from './channel-runner-coverage-matrix.mjs';
import { EXTERNAL_ACTIONS } from './contracts.mjs';
import { buildRuntimeDryRunHarnessReport } from './runtime-dry-run-harness.mjs';

const coreRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const generatedAt = '2026-01-01T00:00:00.000Z';

function listModules(root) {
  const out = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(path.join(current, entry.name));
      else if (entry.isFile() && entry.name.endsWith('.mjs')) out.push(path.join(current, entry.name));
    }
  };
  walk(root);
  return out.sort((left, right) => left.localeCompare(right));
}

const syntaxFailures = listModules(path.join(coreRoot, 'src'))
  .map((file) => ({
    file: path.relative(coreRoot, file).replace(/\\/g, '/'),
    result: spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' }),
  }))
  .filter(({ result }) => result.status !== 0)
  .map(({ file, result }) => ({ file, stderr: result.stderr || null }));
assert.deepEqual(syntaxFailures, [], `vendored core syntax failures: ${JSON.stringify(syntaxFailures)}`);

const api = publicApiSummary();
assert.equal(api.version, 2);
assert.equal(api.moduleCount, CORE_PUBLIC_MODULES.length);
assert.equal(api.compatibilityModuleCount, CORE_COMPATIBILITY_MODULES.length);
assert.equal(api.safety.executesExternalAction, false);

const allowlistPass = buildChannelImportAllowlist({
  publicModules: CORE_PUBLIC_MODULES,
  compatibilityModules: CORE_COMPATIBILITY_MODULES,
  fileRecordsByChannel: {
    zbj: [{ file: 'zbj-auto-intake/src/bridge.mjs', text: "import { digest } from 'design-production-core';\n" }],
    epwk: [{ file: 'epwk-auto-intake/src/bridge.mjs', text: "import { createChannelTask } from 'design-production-core';\n" }],
    hepta: [{ file: 'skills/hepta_design/scripts/bridge.mjs', text: "import { buildHeptaPlanOnlyMigration } from 'design-production-core';\n" }],
  },
  generatedAt,
});
assert.equal(allowlistPass.ok, true, JSON.stringify(allowlistPass.blockers));

const allowlistBlocked = buildChannelImportAllowlist({
  publicModules: CORE_PUBLIC_MODULES,
  compatibilityModules: CORE_COMPATIBILITY_MODULES,
  fileRecordsByChannel: {
    zbj: [{ file: 'zbj-auto-intake/src/bad.mjs', text: "import { digest } from 'design-production-core/src/hash-utils.mjs';\n" }],
    epwk: [{ file: 'epwk-auto-intake/src/bad.mjs', text: "import { buildIntegrationDependencyAudit } from '../../design-production-core/src/integration-dependency-audit.mjs';\n" }],
    hepta: [{ file: 'skills/hepta_design/scripts/bad.mjs', text: "import { buildContractJsonSchema } from '../../../design-production-core/src/contract-schema.mjs';\n" }],
  },
  generatedAt,
});
assert.equal(allowlistBlocked.ok, false);
assert.ok(allowlistBlocked.blockers.some((item) => item.code.endsWith('relative_core_src_import_forbidden_after_package_root_migration')));

const runtime = buildRuntimeDryRunHarnessReport({ generatedAt });
assert.equal(runtime.ok, true, JSON.stringify(runtime.blockers));
assert.ok(runtime.summary.readyScenarioCount > 0);
assert.equal(runtime.safety.executesExternalAction, false);

const liveEntrypoints = Object.fromEntries(['zbj', 'epwk', 'hepta'].map((channelId) => [
  channelId,
  runtime.scenarios
    .filter((scenario) => scenario.readyForExternalRunner === true
      && scenario.expectedReady === true
      && scenario.handoff.channelId === channelId
      && [
        EXTERNAL_ACTIONS.LIVE_SUBMIT,
        EXTERNAL_ACTIONS.ACCEPTANCE_APPLY,
        EXTERNAL_ACTIONS.DEPLOYMENT,
        EXTERNAL_ACTIONS.CUSTOMER_MESSAGE,
      ].includes(scenario.handoff.action)
      && !String(scenario.handoff.actionId || '').endsWith('Preview'))
    .filter((scenario, index, rows) => rows.findIndex(
      (candidate) => candidate.handoff.actionId === scenario.handoff.actionId,
    ) === index)
    .map((scenario) => ({
      actionId: scenario.handoff.actionId,
      ok: true,
      status: 'pass_external_live_entrypoint',
      packageScript: { exists: true },
      files: [
        { role: 'live_entrypoint', exists: true },
        { role: 'core_bridge', exists: true },
      ],
      lifecycleValidationStatus: 'pass_external_action_lifecycle_chain',
      lifecycleProfileId: `${channelId}_vendored_selftest_fixture`,
    })),
]));
const coverage = buildChannelRunnerCoverageMatrixReport({ generatedAt, liveEntrypoints });
assert.equal(coverage.ok, true, JSON.stringify(coverage.blockers));
assert.equal(coverage.summary.unclassifiedRouteCount, 0);
assert.equal(coverage.safety.executesExternalAction, false);

process.stdout.write(`${JSON.stringify({
  ok: true,
  status: 'pass_vendored_core_selftest',
  syntaxCheckedModuleCount: listModules(path.join(coreRoot, 'src')).length,
  publicModuleCount: api.moduleCount,
  runtimeReadyScenarioCount: runtime.summary.readyScenarioCount,
  runnerCoverageRouteCount: coverage.summary.routeCount,
  safety: { executesExternalAction: false },
})}\n`);
