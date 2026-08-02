import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';

import {
  applyManagedEdits,
  buildOpenClawManagedFailureEvidence,
  buildManagedWorkspaceSnapshot,
  codexOpenClawManagedVersion,
  executeCodexOpenClawManaged,
  loadOpenClawModelRuntime,
  OPENCLAW_MANAGED_EXECUTION_EVIDENCE_FIELD,
  parseManagedStructuredOutput,
  provisionCodexOpenClawManagedHome,
  readCodexOpenClawManagedConfiguration,
  verifyOpenClawManagedFailureEvidence,
  withCodexOpenClawManagedSessionStoreLifecycleLock,
  withCodexOpenClawManagedStdoutIsolation,
} from '../../paper-adapters/automation/codex-openclaw-managed-runtime.mjs';
import {
  OPENCLAW_MODEL_RUNTIME_PACKAGE_EXPORTS,
  openClawModelRuntimeProvenance,
  verifyOpenClawModelRuntimeProvenance,
} from '../../paper-adapters/automation/codex-openclaw-managed-configuration.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  AUTH_PROFILE_ID,
  FIXTURE_OPENCLAW_RUNTIME_PROVENANCE,
  MAIN_TEX_MUTATION_POLICY,
  assistantMessage,
  assertManagedRuntimeClean,
  executionPrompt,
  fixture,
  injectedModelRuntime,
} from './support/codex-openclaw-managed-runtime-fixture.mjs';

function installFixtureOpenClawRuntimePackage(value, {
  mutateDuringImport = null,
} = {}) {
  const targetFor = (descriptor) => (
    `./dist/${descriptor.packageExport.split('/').at(-1)}.mjs`
  );
  const implementations = {
    agentCommandRuntimePath: [
      'export function agentCommand() {}',
      'export function ensureAuthProfileStore() {}',
    ],
    configRuntimePath: ['export function loadConfig() { return {}; }'],
    agentHarnessRuntimePath: [
      "import path from 'node:path';",
      'export function resolveAgentDir(_cfg, agentId) {',
      "  return path.join(process.env.OPENCLAW_STATE_DIR, 'agents', agentId, 'agent');",
      '}',
      'export async function disposeRegisteredAgentHarnesses() {}',
    ],
    sessionStoreRuntimePath: [
      "import path from 'node:path';",
      'export function resolveStorePath(_requested, { agentId }) {',
      "  return path.join(process.env.OPENCLAW_STATE_DIR, 'agents', agentId, 'sessions', 'sessions.json');",
      '}',
      'export function resolveSessionFilePath(sessionId, _entry, { sessionsDir }) {',
      "  return path.join(sessionsDir, `${sessionId}.jsonl`);",
      '}',
      'export async function upsertSessionEntry() {}',
      'export async function updateSessionStore() {}',
      'export function getSessionEntry() { return null; }',
    ],
  };
  const packageExports = {};
  const runtimePaths = {};
  for (const descriptor of OPENCLAW_MODEL_RUNTIME_PACKAGE_EXPORTS) {
    const target = targetFor(descriptor);
    const targetPath = path.join(value.root, target);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    const mutation = mutateDuringImport === descriptor.locationProperty
      ? [
        "import fs from 'node:fs';",
        "import { fileURLToPath } from 'node:url';",
        "fs.appendFileSync(fileURLToPath(import.meta.url), '\\n// import-time mutation\\n');",
      ] : [];
    fs.writeFileSync(
      targetPath,
      `${[...implementations[descriptor.locationProperty], ...mutation].join('\n')}\n`,
    );
    packageExports[descriptor.packageExport] = { default: target };
    runtimePaths[descriptor.locationProperty] = targetPath;
  }
  fs.writeFileSync(path.join(value.root, 'package.json'), `${JSON.stringify({
    name: 'openclaw',
    type: 'module',
    exports: packageExports,
  }, null, 2)}\n`);
  return Object.freeze(runtimePaths);
}

function preserveOpenClawSourceEnvironment(context) {
  const configPath = process.env.OPENCLAW_CONFIG_PATH;
  const stateDir = process.env.OPENCLAW_STATE_DIR;
  context.after(() => {
    if (configPath === undefined) delete process.env.OPENCLAW_CONFIG_PATH;
    else process.env.OPENCLAW_CONFIG_PATH = configPath;
    if (stateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
    else process.env.OPENCLAW_STATE_DIR = stateDir;
  });
}

test('managed Codex home stores only non-secret OpenClaw routing configuration', () => {
  const value = fixture();
  try {
    const configuration = readCodexOpenClawManagedConfiguration({
      environment: value.environment,
    });
    assert.equal(configuration.agentId, 'hepta-paper-worker');
    assert.equal(configuration.model, 'gpt-5.6-sol');
    assert.equal(configuration.principalRole, 'research-author');
    assert.equal(configuration.version, 4);
    assert.equal(configuration.thinking, 'adaptive');
    assert.equal(configuration.openclawStateDir, value.openclawStateDir);
    assert.equal(configuration.openclawConfigPath, value.openclawConfigPath);
    assert.match(configuration.configurationHash, /^sha256:[a-f0-9]{64}$/);
    assert.match(
      configuration.openClawManagedAuthProfileIdentityHash,
      /^sha256:[a-f0-9]{64}$/,
    );
    assert.match(
      configuration.openClawManagedAuthSourceIdentityHash,
      /^sha256:[a-f0-9]{64}$/,
    );
    assert.equal(fs.existsSync(path.join(value.home, 'auth.json')), false);
    assert.equal(fs.statSync(value.home).mode & 0o077, 0);
    assert.equal(fs.statSync(path.join(value.home, 'config.toml')).mode & 0o077, 0);
    assert.match(codexOpenClawManagedVersion({
      environment: value.environment,
    }), /^codex-openclaw-managed 3 bridge=[a-f0-9]{16} runtime=/);
  } finally {
    value.cleanup();
  }
});

test('managed runtime binds the exact four public export files loaded for execution', async (context) => {
  preserveOpenClawSourceEnvironment(context);
  const value = fixture();
  try {
    const runtimePaths = installFixtureOpenClawRuntimePackage(value);
    const configuration = readCodexOpenClawManagedConfiguration({
      environment: value.environment,
    });
    const before = openClawModelRuntimeProvenance(
      configuration.openclawBinary,
    );
    const runtime = await loadOpenClawModelRuntime(configuration);
    assert.equal(verifyOpenClawModelRuntimeProvenance(
      runtime.runtimeProvenance,
      { expectedProvenanceHash: before.openClawManagedRuntimeProvenanceHash },
    ), true);
    assert.deepEqual(
      runtime.runtimeProvenance.moduleBindings.map((binding) => ({
        packageExport: binding.packageExport,
        runtimeRole: binding.runtimeRole,
        requiredExports: binding.requiredExports,
      })),
      OPENCLAW_MODEL_RUNTIME_PACKAGE_EXPORTS.map((descriptor) => ({
        packageExport: descriptor.packageExport,
        runtimeRole: descriptor.locationProperty,
        requiredExports: descriptor.requiredExports,
      })),
    );
    fs.appendFileSync(runtimePaths.configRuntimePath, '\n// content drift\n');
    const after = openClawModelRuntimeProvenance(
      configuration.openclawBinary,
    );
    assert.notEqual(
      after.openClawManagedRuntimeProvenanceHash,
      before.openClawManagedRuntimeProvenanceHash,
    );
    assert.equal(verifyOpenClawModelRuntimeProvenance(after, {
      expectedProvenanceHash: before.openClawManagedRuntimeProvenanceHash,
    }), false);
  } finally {
    value.cleanup();
  }
});

test('managed runtime rejects a public export file changed during dynamic import', async (context) => {
  preserveOpenClawSourceEnvironment(context);
  const value = fixture();
  try {
    installFixtureOpenClawRuntimePackage(value, {
      mutateDuringImport: 'agentCommandRuntimePath',
    });
    const configuration = readCodexOpenClawManagedConfiguration({
      environment: value.environment,
    });
    await assert.rejects(
      loadOpenClawModelRuntime(configuration),
      /codex_openclaw_managed_model_runtime_changed_during_load/,
    );
  } finally {
    value.cleanup();
  }
});

test('managed session-store lifecycle lock preserves concurrent whole-store updates across processes', async () => {
  const value = fixture();
  const eventsPath = path.join(value.root, 'lock-events.jsonl');
  const runtimeModuleUrl = new URL(
    '../../paper-adapters/automation/codex-openclaw-managed-runtime.mjs',
    import.meta.url,
  ).href;
  const childSource = [
    "import fs from 'node:fs';",
    'const { withCodexOpenClawManagedSessionStoreLifecycleLock: withLock } = await import(process.env.HEPTA_LOCK_RUNTIME_URL);',
    'await withLock(async () => {',
    '  const id = process.env.HEPTA_LOCK_CHILD_ID;',
    '  const store = JSON.parse(fs.readFileSync(process.env.HEPTA_LOCK_STORE_PATH, \'utf8\'));',
    '  fs.appendFileSync(process.env.HEPTA_LOCK_EVENTS_PATH, `${JSON.stringify({ id, event: \'start\', at: Date.now() })}\\n`);',
    '  await new Promise((resolve) => setTimeout(resolve, 200));',
    '  store[id] = { sessionId: id, updatedAt: Date.now() };',
    '  fs.writeFileSync(process.env.HEPTA_LOCK_STORE_PATH, `${JSON.stringify(store)}\\n`);',
    '  fs.appendFileSync(process.env.HEPTA_LOCK_EVENTS_PATH, `${JSON.stringify({ id, event: \'end\', at: Date.now() })}\\n`);',
    '}, { sessionsDir: process.env.HEPTA_LOCK_SESSIONS_DIR, timeoutMs: 5000 });',
  ].join('\n');
  const runChild = (id) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      '--input-type=module',
      '--eval',
      childSource,
    ], {
      env: {
        ...process.env,
        HEPTA_LOCK_CHILD_ID: id,
        HEPTA_LOCK_EVENTS_PATH: eventsPath,
        HEPTA_LOCK_RUNTIME_URL: runtimeModuleUrl,
        HEPTA_LOCK_SESSIONS_DIR: value.sessionsDir,
        HEPTA_LOCK_STORE_PATH: value.sessionStorePath,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stderr = [];
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0 && signal === null) resolve();
      else reject(new Error(
        `lock child failed (${code ?? signal}): ${Buffer.concat(stderr).toString('utf8')}`,
      ));
    });
  });
  try {
    await withCodexOpenClawManagedSessionStoreLifecycleLock(
      async () => true,
      { sessionsDir: value.sessionsDir, timeoutMs: 1000 },
    );
    await Promise.all([runChild('worker-a'), runChild('worker-b')]);
    assert.deepEqual(
      Object.keys(JSON.parse(fs.readFileSync(value.sessionStorePath, 'utf8')))
        .sort(),
      ['worker-a', 'worker-b'],
    );
    const events = fs.readFileSync(eventsPath, 'utf8').trim().split('\n')
      .map((line) => JSON.parse(line));
    const intervals = ['worker-a', 'worker-b'].map((id) => ({
      start: events.find((event) => event.id === id && event.event === 'start').at,
      end: events.find((event) => event.id === id && event.event === 'end').at,
    })).sort((left, right) => left.start - right.start);
    assert.ok(intervals[1].start >= intervals[0].end, intervals);
  } finally {
    value.cleanup();
  }
});

test('managed CLI stdout isolation discards runtime noise and always restores the protocol stream', async () => {
  const processWrite = process.stdout.write;
  let processCallbackCount = 0;
  await withCodexOpenClawManagedStdoutIsolation(async () => {
    console.log('subsystem logger noise');
    process.stdout.write(Buffer.from('buffer noise\n'));
    process.stdout.write(new Uint8Array([110, 111, 105, 115, 101, 10]), () => {
      processCallbackCount += 1;
    });
    await new Promise((resolve) => queueMicrotask(resolve));
  });
  assert.equal(processCallbackCount, 1);
  assert.equal(process.stdout.write, processWrite);

  const visibleWrites = [];
  const originalWrite = (chunk) => {
    visibleWrites.push(String(chunk));
    return false;
  };
  const output = { write: originalWrite };
  let callbackCount = 0;

  const value = await withCodexOpenClawManagedStdoutIsolation(async () => {
    assert.notEqual(output.write, originalWrite);
    assert.equal(output.write('subsystem info\n'), true);
    assert.equal(output.write('direct runtime output\n', () => {
      callbackCount += 1;
    }), true);
    await new Promise((resolve) => queueMicrotask(resolve));
    return 'verified-result\n';
  }, { output });

  assert.equal(value, 'verified-result\n');
  assert.equal(callbackCount, 1);
  assert.equal(output.write, originalWrite);
  assert.deepEqual(visibleWrites, []);
  output.write(value);
  assert.deepEqual(visibleWrites, ['verified-result\n']);

  await assert.rejects(
    withCodexOpenClawManagedStdoutIsolation(() => {
      output.write('noise before failure\n');
      throw new Error('fixture failure');
    }, { output }),
    /fixture failure/,
  );
  assert.equal(output.write, originalWrite);
  assert.deepEqual(visibleWrites, ['verified-result\n']);

  await assert.rejects(
    withCodexOpenClawManagedStdoutIsolation(async () => {
      output.write(Buffer.alloc(64 * 1024 + 1));
    }, { output }),
    /codex_openclaw_managed_stdout_guard_limit_exceeded/,
  );
  assert.equal(output.write, originalWrite);

  await assert.rejects(
    withCodexOpenClawManagedStdoutIsolation(async () => {
      output.write = () => false;
    }, { output }),
    /codex_openclaw_managed_stdout_guard_ownership_lost/,
  );
  assert.equal(output.write, originalWrite);

  await withCodexOpenClawManagedStdoutIsolation(async () => {
    await assert.rejects(
      withCodexOpenClawManagedStdoutIsolation(
        async () => {},
        { output },
      ),
      /codex_openclaw_managed_stdout_guard_already_active/,
    );
  }, { output });
  assert.equal(output.write, originalWrite);
});

test('managed configuration fails closed on missing or malformed auth profile identity', () => {
  const cases = [
    {
      name: 'missing',
      mutate: (content) => content.replace(/^auth_profile_id = .*$/m, ''),
    },
    {
      name: 'malformed',
      mutate: (content) => content.replace(
        /^auth_profile_id = .*$/m,
        'auth_profile_id = "profile with spaces"',
      ),
    },
  ];
  for (const candidate of cases) {
    const value = fixture();
    try {
      const configPath = path.join(value.home, 'config.toml');
      const original = fs.readFileSync(configPath, 'utf8');
      fs.writeFileSync(configPath, candidate.mutate(original), { mode: 0o600 });
      assert.throws(
        () => readCodexOpenClawManagedConfiguration({
          environment: value.environment,
        }),
        /codex_openclaw_managed_auth_profile_id_invalid/,
        candidate.name,
      );
    } finally {
      value.cleanup();
    }
  }
});

test('managed configuration fails closed on a missing or mismatched OpenClaw auth source', () => {
  const cases = [
    {
      name: 'missing state directory',
      expected: /codex_openclaw_managed_openclaw_state_dir_invalid/,
      mutate: (content) => content.replace(
        /^openclaw_state_dir = .*$/m,
        '',
      ),
    },
    {
      name: 'mismatched config and state',
      expected: /codex_openclaw_managed_openclaw_source_mismatch/,
      mutate(content, value) {
        const otherState = path.join(value.root, 'other-openclaw-state');
        const otherConfig = path.join(otherState, 'openclaw.json');
        fs.mkdirSync(otherState, { mode: 0o700 });
        fs.writeFileSync(otherConfig, '{}\n', { mode: 0o600 });
        return content.replace(
          /^openclaw_config_path = .*$/m,
          `openclaw_config_path = ${JSON.stringify(otherConfig)}`,
        );
      },
    },
  ];
  for (const candidate of cases) {
    const value = fixture();
    try {
      const configPath = path.join(value.home, 'config.toml');
      const original = fs.readFileSync(configPath, 'utf8');
      fs.writeFileSync(
        configPath,
        candidate.mutate(original, value),
        { mode: 0o600 },
      );
      assert.throws(() => readCodexOpenClawManagedConfiguration({
        environment: value.environment,
      }), candidate.expected, candidate.name);
    } finally {
      value.cleanup();
    }
  }
});

test('managed configuration and public profile identity hashes rotate with the profile', () => {
  const value = fixture();
  try {
    const before = readCodexOpenClawManagedConfiguration({
      environment: value.environment,
    });
    provisionCodexOpenClawManagedHome({
      home: value.home,
      agentId: 'hepta-paper-worker',
      authProfileId: 'openai:rotated@example.test',
      model: 'gpt-5.6-sol',
      openclawBinary: path.join(value.root, 'openclaw'),
      openclawConfigPath: value.openclawConfigPath,
      openclawStateDir: value.openclawStateDir,
      principalRole: 'research-author',
      thinking: 'adaptive',
      force: true,
    });
    const after = readCodexOpenClawManagedConfiguration({
      environment: value.environment,
    });
    assert.notEqual(after.configurationHash, before.configurationHash);
    assert.notEqual(
      after.openClawManagedAuthProfileIdentityHash,
      before.openClawManagedAuthProfileIdentityHash,
    );
    assert.equal(
      after.openClawManagedAuthSourceIdentityHash,
      before.openClawManagedAuthSourceIdentityHash,
    );
  } finally {
    value.cleanup();
  }
});

test('managed workspace snapshot is bounded, prioritized and content bound', () => {
  const value = fixture();
  try {
    fs.mkdirSync(path.join(value.workspace, 'node_modules'));
    fs.writeFileSync(path.join(value.workspace, 'node_modules', 'ignored.js'), 'ignored');
    const snapshot = buildManagedWorkspaceSnapshot({
      workspace: value.workspace,
      maximumContextBytes: 4096,
      maximumFileCount: 2,
    });
    assert.deepEqual(snapshot.files.map((entry) => entry.path), [
      'THEOREM_SPEC.json',
      'main.tex',
    ]);
    assert.match(snapshot.snapshotHash, /^sha256:[a-f0-9]{64}$/);
    assert.equal(snapshot.files.some((entry) => entry.path.includes('node_modules')), false);
  } finally {
    value.cleanup();
  }
});

test('managed snapshot admits a required text file above the optional per-file cap', () => {
  const value = fixture();
  try {
    const requiredContent = `${'x'.repeat(547755)}\n`;
    fs.writeFileSync(
      path.join(value.workspace, 'AUTONOMOUS_MANUSCRIPT_ENTAILMENT.json'),
      requiredContent,
      { mode: 0o600 },
    );
    const snapshot = buildManagedWorkspaceSnapshot({
      workspace: value.workspace,
      maximumContextBytes: 600000,
      maximumFileCount: 4,
    });
    const required = snapshot.files.find(
      (entry) => entry.path === 'AUTONOMOUS_MANUSCRIPT_ENTAILMENT.json',
    );
    assert.equal(required?.content, requiredContent);
    assert.equal(snapshot.byteCount, Buffer.byteLength(requiredContent) + 21);
    fs.writeFileSync(
      path.join(value.workspace, 'AUTONOMOUS_MANUSCRIPT_ENTAILMENT.json'),
      'x'.repeat(600001),
      { mode: 0o600 },
    );
    assert.throws(() => buildManagedWorkspaceSnapshot({
      workspace: value.workspace,
      maximumContextBytes: 600000,
      maximumFileCount: 4,
    }), /codex_openclaw_managed_required_snapshot_omitted/);
  } finally {
    value.cleanup();
  }
});

test('managed snapshot reserves bounded capacity for every required file', () => {
  const value = fixture();
  try {
    fs.mkdirSync(path.join(value.workspace, 'experiments'));
    fs.writeFileSync(
      path.join(value.workspace, 'experiments', 'large.json'),
      `${'x'.repeat(3900)}\n`,
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(value.workspace, 'Proof.lean'),
      `${'x'.repeat(400)}\n`,
      { mode: 0o600 },
    );
    const snapshot = buildManagedWorkspaceSnapshot({
      workspace: value.workspace,
      maximumContextBytes: 4096,
      maximumFileCount: 3,
    });
    assert.deepEqual(snapshot.files.map((entry) => entry.path), [
      'THEOREM_SPEC.json',
      'main.tex',
      'Proof.lean',
    ]);
    assert.equal(snapshot.omittedFileCount, 1);
    fs.writeFileSync(
      path.join(value.workspace, 'experiments', 'large.json'),
      `${'x'.repeat(100)}\n`,
      { mode: 0o600 },
    );
    const completeSnapshot = buildManagedWorkspaceSnapshot({
      workspace: value.workspace,
      maximumContextBytes: 4096,
      maximumFileCount: 4,
    });
    assert.deepEqual(completeSnapshot.files.map((entry) => entry.path), [
      'THEOREM_SPEC.json',
      'main.tex',
      'experiments/large.json',
      'Proof.lean',
    ]);
  } finally {
    value.cleanup();
  }
});

test('managed snapshot rejects limits outside the configured safety bounds', () => {
  const value = fixture();
  try {
    assert.throws(() => buildManagedWorkspaceSnapshot({
      workspace: value.workspace,
      maximumContextBytes: 4095,
      maximumFileCount: 2,
    }), /codex_openclaw_managed_context_limits_invalid/);
    assert.throws(() => buildManagedWorkspaceSnapshot({
      workspace: value.workspace,
      maximumContextBytes: 4096,
      maximumFileCount: 257,
    }), /codex_openclaw_managed_context_limits_invalid/);
  } finally {
    value.cleanup();
  }
});

test('structured parser accepts only an exact JSON object', () => {
  assert.deepEqual(parseManagedStructuredOutput('{"status":"completed","edits":[]}'), {
    status: 'completed',
    edits: [],
  });
  assert.equal(
    parseManagedStructuredOutput('```json\n{"status":"completed","edits":[]}\n```'),
    null,
  );
  assert.equal(
    parseManagedStructuredOutput('diagnostic\n{"status":"completed","edits":[]}'),
    null,
  );
  assert.equal(parseManagedStructuredOutput('[]'), null);
  assert.equal(parseManagedStructuredOutput('not json'), null);
});

test('managed snapshot excludes credential-like paths and fails when required input is omitted', () => {
  const value = fixture();
  try {
    fs.writeFileSync(path.join(value.workspace, '.env'), 'TOKEN=secret\n', { mode: 0o600 });
    const snapshot = buildManagedWorkspaceSnapshot({
      workspace: value.workspace,
      maximumContextBytes: 4096,
      maximumFileCount: 4,
    });
    assert.equal(snapshot.files.some((entry) => entry.path === '.env'), false);
    assert.throws(() => buildManagedWorkspaceSnapshot({
      workspace: value.workspace,
      maximumContextBytes: 4096,
      maximumFileCount: 1,
    }), /codex_openclaw_managed_required_snapshot_omitted/);
  } finally {
    value.cleanup();
  }
});

test('managed edits reject traversal, duplicates and read-only mutations', () => {
  const value = fixture();
  try {
    const snapshot = buildManagedWorkspaceSnapshot({ workspace: value.workspace });
    assert.throws(() => applyManagedEdits({
      workspace: value.workspace,
      sandbox: 'workspace-write',
      snapshot,
      workspaceMutationPolicy: MAIN_TEX_MUTATION_POLICY,
      edits: [{ path: '../escape', content: 'x' }],
    }), /codex_openclaw_managed_edit_invalid/);
    assert.throws(() => applyManagedEdits({
      workspace: value.workspace,
      sandbox: 'workspace-write',
      snapshot,
      workspaceMutationPolicy: MAIN_TEX_MUTATION_POLICY,
      edits: [
        { path: 'main.tex', content: 'one' },
        { path: 'main.tex', content: 'two' },
      ],
    }), /codex_openclaw_managed_duplicate_edit/);
    assert.throws(() => applyManagedEdits({
      workspace: value.workspace,
      sandbox: 'read-only',
      snapshot,
      edits: [{ path: 'main.tex', content: 'changed' }],
    }), /codex_openclaw_managed_read_only_edit_forbidden/);
    assert.equal(fs.readFileSync(path.join(value.workspace, 'main.tex'), 'utf8'), 'before\n');
  } finally {
    value.cleanup();
  }
});

test('managed execution uses a user-locked Codex app-server session and materializes structured edits', async () => {
  const value = fixture();
  const loaderCalls = [];
  const prepareCalls = [];
  const completionCalls = [];
  let disposeCalls = 0;
  try {
    const result = await executeCodexOpenClawManaged({
      args: [
        '--model', 'gpt-5.6-sol',
        '--ephemeral',
        '--color', 'never',
        '--sandbox', 'workspace-write',
        '--skip-git-repo-check',
        '--cd', value.workspace,
        '-',
      ],
      stdin: executionPrompt('Update main.tex and return JSON.'),
      environment: value.environment,
      modelRuntimeLoader: injectedModelRuntime(async () => (
        assistantMessage(JSON.stringify({
          status: 'completed',
          summary: 'updated',
          edits: [{ path: 'main.tex', content: 'after\n' }],
          checksRun: [],
          blockers: [],
        }))
      ), {
        onLoad(configuration) { loaderCalls.push(configuration); },
        onPrepare(options) { prepareCalls.push(options); },
        onCompletion(options) { completionCalls.push(options); },
        onDispose() { disposeCalls += 1; },
      }),
    });
    assert.equal(fs.readFileSync(path.join(value.workspace, 'main.tex'), 'utf8'), 'after\n');
    assert.deepEqual(result.changedPaths, ['main.tex']);
    const output = JSON.parse(result.stdout);
    assert.deepEqual(Object.keys(output).sort(), [
      'blockers', 'checksRun', OPENCLAW_MANAGED_EXECUTION_EVIDENCE_FIELD,
      'status', 'summary',
    ]);
    assert.deepEqual(
      output[OPENCLAW_MANAGED_EXECUTION_EVIDENCE_FIELD],
      result.managedAuth,
    );
    assert.deepEqual(output.checksRun, []);
    assert.equal(result.managedAuth.version, 6);
    assert.deepEqual(
      result.managedAuth.openClawManagedRuntimeProvenance,
      FIXTURE_OPENCLAW_RUNTIME_PROVENANCE,
    );
    assert.equal(result.managedAuth.credentialMaterialCopied, false);
    assert.equal(result.managedAuth.toolsDisabled, true);
    assert.equal(result.managedAuth.profileSelection,
      'openclaw-managed-user-locked-profile');
    assert.equal(result.managedAuth.authProfileBindingMode,
      'codex-app-server-user-locked-session');
    assert.equal(result.managedAuth.authProfileBindingVerified, true);
    assert.equal(result.managedAuth.profileFailoverPermitted, false);
    assert.equal(result.managedAuth.runtimeFallbackObserved, false);
    assert.equal(result.managedAuth.simpleCompletionModelRun, false);
    assert.equal(result.managedAuth.codexAppServerOneShot, true);
    assert.equal(
      result.managedAuth.completionTransport,
      'openclaw-codex-app-server-agent-command',
    );
    assert.equal(
      result.managedAuth.sessionIsolation,
      'fresh_one_shot_codex_app_server_no_resume',
    );
    assert.equal(result.managedAuth.sessionCleanupVerified, true);
    assert.equal(result.managedAuth.messageDeliveryEnabled, false);
    assert.equal(result.managedAuth.externalDeliveryObserved, false);
    assert.equal(
      result.managedAuth.promptPersistence,
      'openclaw-user-turn-transcript-suppressed',
    );
    assert.equal(
      result.managedAuth.sessionStatePersistence,
      'openclaw-entry-and-managed-artifacts-removed',
    );
    assert.equal(
      result.managedAuth.sessionCleanupScope,
      'openclaw-session-store-artifacts-and-temporary-workspace-only',
    );
    assert.equal(
      result.managedAuth.codexAppServerStateCleanupPerformed,
      false,
    );
    assert.equal(result.managedAuth.externalModelInvocationPerformed, true);
    assert.equal(result.managedAuth.externalSideEffectPerformed, false);
    assert.equal(result.managedAuth.externalActionPerformed, false);
    assert.deepEqual(result.managedAuth.usage, {
      input: 10,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 20,
    });
    assert.equal(
      result.managedAuth.usageHash,
      hashRecord('OpenClawManagedCodexAppServerUsage', result.managedAuth.usage),
    );
    assert.match(
      result.managedAuth.openClawManagedAuthSourceIdentityHash,
      /^sha256:[a-f0-9]{64}$/,
    );
    assert.equal(JSON.stringify(result.managedAuth).includes(AUTH_PROFILE_ID), false);
    assert.equal(
      JSON.stringify(result.managedAuth)
        .includes('fixture-secret-never-reported'),
      false,
    );
    assert.deepEqual(result.managedAuth.modelReportedChecks, []);
    assert.equal(loaderCalls.length, 1);
    assert.equal(prepareCalls.length, 1);
    assert.equal(prepareCalls[0].requestedAgentDir, value.agentDir);
    assert.deepEqual(
      prepareCalls[0].externalCliProfileIds,
      [AUTH_PROFILE_ID],
    );
    assert.equal(prepareCalls[0].allowKeychainPrompt, false);
    assert.equal(prepareCalls[0].readOnly, true);
    assert.equal(prepareCalls[0].syncExternalCli, false);
    assert.equal(completionCalls.length, 1);
    assert.equal(completionCalls[0].provider, 'openai');
    assert.equal(completionCalls[0].model, 'gpt-5.6-sol');
    assert.equal(completionCalls[0].thinking, 'high');
    assert.equal(completionCalls[0].sessionId, completionCalls[0].runId);
    assert.match(
      completionCalls[0].sessionKey,
      /^agent:hepta-paper-worker:subagent:hepta-managed-one-shot-/,
    );
    assert.deepEqual(completionCalls[0].toolsAllow, []);
    assert.equal(completionCalls[0].disableMessageTool, true);
    assert.equal(completionCalls[0].deliver, false);
    assert.equal(completionCalls[0].oneShotCliRun, true);
    assert.equal(completionCalls[0].suppressPromptPersistence, true);
    assert.equal(completionCalls[0].skipInitialSessionTouch, true);
    assert.equal(completionCalls[0].messageChannel, 'internal');
    assert.equal(disposeCalls, 1);
    assertManagedRuntimeClean(value);
    assert.equal(result.managedAuth.modelAttemptCount, 1);
    assert.equal(result.managedAuth.attemptTrace.length, 1);
    const [successfulAttempt] = result.managedAuth.attemptTrace;
    assert.deepEqual({
      attemptNumber: successfulAttempt.attemptNumber,
      provider: successfulAttempt.provider,
      model: successfulAttempt.model,
      authProfileIdentityHash: successfulAttempt.authProfileIdentityHash,
      thinking: successfulAttempt.thinking,
      outcome: successfulAttempt.outcome,
      stopReason: successfulAttempt.stopReason,
      errorClass: successfulAttempt.errorClass,
      authProfileOverrideSource:
        successfulAttempt.authProfileOverrideSource,
      runtimeFallbackUsed: successfulAttempt.runtimeFallbackUsed,
      agentHarnessId: successfulAttempt.agentHarnessId,
      requestAuthMode: successfulAttempt.requestAuthMode,
      sessionCleanupVerified: successfulAttempt.sessionCleanupVerified,
    }, {
      attemptNumber: 1,
      provider: 'openai',
      model: 'gpt-5.6-sol',
      authProfileIdentityHash:
        result.managedAuth.openClawManagedAuthProfileIdentityHash,
      thinking: 'high',
      outcome: 'completed',
      stopReason: 'stop',
      errorClass: null,
      authProfileOverrideSource: 'user',
      runtimeFallbackUsed: false,
      agentHarnessId: 'codex',
      requestAuthMode: 'auth-profile',
      sessionCleanupVerified: true,
    });
    assert.match(
      successfulAttempt.attemptId,
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    assert.match(successfulAttempt.responseTextHash, /^sha256:[a-f0-9]{64}$/);
    assert.equal(successfulAttempt.responseErrorHash, null);
    assert.equal(
      successfulAttempt.sessionBindingBeforeHash,
      successfulAttempt.sessionBindingAfterHash,
    );
    assert.match(
      successfulAttempt.sessionBindingAfterHash,
      /^sha256:[a-f0-9]{64}$/,
    );
    assert.deepEqual(successfulAttempt.sessionCleanup, {
      sessionEntryRemoved: true,
      artifactsRemoved: true,
      attemptWorkspaceRemoved: true,
    });
    assert.equal(successfulAttempt.executionTrace.runner, 'embedded');
    assert.equal(successfulAttempt.executionTrace.fallbackUsed, false);
    assert.equal(
      successfulAttempt.executionTrace.attempts.at(-1).result,
      'success',
    );
    assert.equal(
      result.managedAuth.successfulAttemptId,
      successfulAttempt.attemptId,
    );
    assert.equal(
      result.managedAuth.completionInvocationId,
      `openclaw-codex-app-server:${successfulAttempt.attemptId}`,
    );
    assert.equal(
      result.managedAuth.successfulResponseHash,
      successfulAttempt.responseTextHash,
    );
    assert.equal(
      result.managedAuth.successfulSessionBindingHash,
      successfulAttempt.sessionBindingAfterHash,
    );
    assert.equal(
      result.managedAuth.attemptTraceHash,
      hashRecord('OpenClawManagedCodexAppServerAttemptTrace', {
        attempts: result.managedAuth.attemptTrace,
      }),
    );
    for (const forbidden of [
      'childSessionId',
      'gatewaySessionKeyHash',
      'openClawRunId',
      'gatewayModelRun',
      'gatewayAttemptCount',
      'successfulResponseIdHash',
    ]) {
      assert.equal(Object.hasOwn(result.managedAuth, forbidden), false, forbidden);
    }
  } finally {
    value.cleanup();
  }
});

test('managed execution rejects a wrong, missing, or invalid locked profile before agent command', async () => {
  const invalidAvailableProfiles = [
    {
      name: 'wrong profile',
      availableProfileId: 'openai:other@example.test',
      omitAvailableProfile: false,
    },
    {
      name: 'missing profile',
      availableProfileId: AUTH_PROFILE_ID,
      omitAvailableProfile: true,
    },
    {
      name: 'wrong provider',
      availableProfileId: AUTH_PROFILE_ID,
      omitAvailableProfile: false,
      availableProfileProvider: 'anthropic',
    },
  ];
  for (const candidate of invalidAvailableProfiles) {
    const value = fixture();
    const prepareCalls = [];
    let completionCalls = 0;
    try {
      await assert.rejects(() => executeCodexOpenClawManaged({
        args: ['--sandbox', 'read-only', '--cd', value.workspace, '-'],
        stdin: 'HEPTA_CODEX_MODEL_CANARY_CHALLENGE abc. Return HEPTA_CODEX_CANARY_RESPONSE.',
        environment: value.environment,
        modelRuntimeLoader: injectedModelRuntime(async () => {
          completionCalls += 1;
          return assistantMessage('HEPTA_CODEX_CANARY_RESPONSE:42');
        }, {
          availableProfileId: candidate.availableProfileId,
          omitAvailableProfile: candidate.omitAvailableProfile,
          availableProfileProvider: candidate.availableProfileProvider,
          onPrepare(options) { prepareCalls.push(options); },
        }),
      }), /codex_openclaw_managed_auth_profile_binding_(?:failed|invalid)/,
      candidate.name);
      assert.equal(prepareCalls.length, 1, candidate.name);
      assert.deepEqual(
        prepareCalls[0].externalCliProfileIds,
        [AUTH_PROFILE_ID],
        candidate.name,
      );
      assert.equal(completionCalls, 0, candidate.name);
    } finally {
      value.cleanup();
    }
  }
});

test('managed app-server execution fails closed on fallback, tool use, pending tools, or delivery', async () => {
  const cases = [
    {
      name: 'runtime fallback',
      expected: /codex_openclaw_managed_runtime_fallback_observed/,
      externalActionPerformed: false,
      externalSideEffectPerformed: false,
      response: () => assistantMessage('HEPTA_CODEX_CANARY_RESPONSE:42', {
        executionTrace: {
          winnerProvider: 'openai',
          winnerModel: 'gpt-5.6-sol',
          fallbackUsed: true,
          runner: 'embedded',
          attempts: [{
            provider: 'openai',
            model: 'gpt-5.6-sol',
            result: 'success',
            stage: 'assistant',
          }],
        },
      }),
    },
    {
      name: 'tool execution',
      expected: /codex_openclaw_managed_agent_policy_violation/,
      externalActionPerformed: true,
      externalSideEffectPerformed: null,
      response: () => assistantMessage('HEPTA_CODEX_CANARY_RESPONSE:42', {
        toolCalls: 1,
      }),
    },
    {
      name: 'pending tool call',
      expected: /codex_openclaw_managed_agent_policy_violation/,
      externalActionPerformed: null,
      externalSideEffectPerformed: null,
      response: () => assistantMessage('HEPTA_CODEX_CANARY_RESPONSE:42', {
        pendingToolCalls: [{ id: 'fixture-pending-tool-call' }],
      }),
    },
    {
      name: 'external delivery',
      expected: /codex_openclaw_managed_agent_policy_violation/,
      externalActionPerformed: true,
      externalSideEffectPerformed: true,
      response: () => assistantMessage('HEPTA_CODEX_CANARY_RESPONSE:42', {
        externalDelivery: true,
      }),
    },
  ];
  for (const candidate of cases) {
    const value = fixture();
    let agentCommandCalls = 0;
    let disposeCalls = 0;
    try {
      await assert.rejects(() => executeCodexOpenClawManaged({
        args: ['--sandbox', 'read-only', '--cd', value.workspace, '-'],
        stdin: 'HEPTA_CODEX_MODEL_CANARY_CHALLENGE abc. Return HEPTA_CODEX_CANARY_RESPONSE.',
        environment: value.environment,
        modelRuntimeLoader: injectedModelRuntime(async () => {
          agentCommandCalls += 1;
          return candidate.response();
        }, {
          onDispose() { disposeCalls += 1; },
        }),
      }), (error) => {
        assert.match(error.code, candidate.expected, candidate.name);
        const evidence = buildOpenClawManagedFailureEvidence(error);
        const configuration = readCodexOpenClawManagedConfiguration({
          environment: value.environment,
        });
        assert.equal(verifyOpenClawManagedFailureEvidence(evidence, {
          failureCode: error.code,
          model: 'gpt-5.6-sol',
          expectedAuthProfileIdentityHash:
            configuration.openClawManagedAuthProfileIdentityHash,
          expectedRuntimeProvenanceHash:
            FIXTURE_OPENCLAW_RUNTIME_PROVENANCE
              .openClawManagedRuntimeProvenanceHash,
          allowLegacyAudit: true,
        }), true, candidate.name);
        assert.equal(
          evidence.externalActionPerformed,
          candidate.externalActionPerformed,
          candidate.name,
        );
        assert.equal(
          evidence.externalSideEffectPerformed,
          candidate.externalSideEffectPerformed,
          candidate.name,
        );
        return true;
      });
      assert.equal(agentCommandCalls, 1, candidate.name);
      assert.equal(disposeCalls, 1, candidate.name);
      assertManagedRuntimeClean(value);
    } finally {
      value.cleanup();
    }
  }
});

test('managed app-server execution fails closed if the locked session binding changes', async () => {
  const value = fixture();
  let disposeCalls = 0;
  try {
    await assert.rejects(() => executeCodexOpenClawManaged({
      args: ['--sandbox', 'read-only', '--cd', value.workspace, '-'],
      stdin: 'HEPTA_CODEX_MODEL_CANARY_CHALLENGE abc. Return HEPTA_CODEX_CANARY_RESPONSE.',
      environment: value.environment,
      modelRuntimeLoader: injectedModelRuntime(async (options, controls) => {
        controls.replaceSessionEntry({
          ...controls.sessionStore[options.sessionKey],
          authProfileOverride: 'openai:rebound@example.test',
        });
        return assistantMessage('HEPTA_CODEX_CANARY_RESPONSE:42');
      }, {
        onDispose() {
          disposeCalls += 1;
          throw new Error('fixture disposal failure must not mask cleanup');
        },
      }),
    }), (error) => {
      assert.equal(
        error.code,
        'codex_openclaw_managed_session_cleanup_entry_binding_changed',
      );
      assert.equal(error.retryable, false);
      assert.deepEqual(error.usage, {
        input: 10,
        output: 10,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 20,
      });
      const configuration = readCodexOpenClawManagedConfiguration({
        environment: value.environment,
      });
      assert.equal(verifyOpenClawManagedFailureEvidence(
        buildOpenClawManagedFailureEvidence(error),
        {
          failureCode: error.code,
          model: 'gpt-5.6-sol',
          expectedAuthProfileIdentityHash:
            configuration.openClawManagedAuthProfileIdentityHash,
          expectedRuntimeProvenanceHash:
            FIXTURE_OPENCLAW_RUNTIME_PROVENANCE
              .openClawManagedRuntimeProvenanceHash,
          allowLegacyAudit: true,
        },
      ), true);
      return true;
    });
    assert.equal(disposeCalls, 1);
    const residue = JSON.parse(
      fs.readFileSync(value.sessionStorePath, 'utf8'),
    );
    assert.equal(Object.keys(residue).length, 1);
    assert.equal(
      Object.values(residue)[0].authProfileOverride,
      'openai:rebound@example.test',
    );
    assert.deepEqual(
      fs.readdirSync(value.sessionsDir).filter(
        (entry) => entry !== 'sessions.json',
      ),
      [],
    );
    assert.deepEqual(fs.readdirSync(value.internalRunsDir), []);
  } finally {
    value.cleanup();
  }
});

test('managed runtime disposal failure preserves completed response usage as failure evidence', async () => {
  const value = fixture();
  try {
    await assert.rejects(() => executeCodexOpenClawManaged({
      args: ['--sandbox', 'read-only', '--cd', value.workspace, '-'],
      stdin: 'HEPTA_CODEX_MODEL_CANARY_CHALLENGE abc. Return HEPTA_CODEX_CANARY_RESPONSE.',
      environment: value.environment,
      modelRuntimeLoader: injectedModelRuntime(
        async () => assistantMessage('HEPTA_CODEX_CANARY_RESPONSE:42'),
        { onDispose() { throw new Error('fixture disposal failure'); } },
      ),
    }), (error) => {
      assert.equal(
        error.code,
        'codex_openclaw_managed_agent_runtime_disposal_failed',
      );
      assert.deepEqual(error.usage, {
        input: 10,
        output: 10,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 20,
      });
      const configuration = readCodexOpenClawManagedConfiguration({
        environment: value.environment,
      });
      assert.equal(verifyOpenClawManagedFailureEvidence(
        buildOpenClawManagedFailureEvidence(error),
        {
          failureCode: error.code,
          model: 'gpt-5.6-sol',
          expectedAuthProfileIdentityHash:
            configuration.openClawManagedAuthProfileIdentityHash,
          expectedRuntimeProvenanceHash:
            FIXTURE_OPENCLAW_RUNTIME_PROVENANCE
              .openClawManagedRuntimeProvenanceHash,
          allowLegacyAudit: true,
        },
      ), true);
      return true;
    });
    assertManagedRuntimeClean(value);
  } finally {
    value.cleanup();
  }
});

test('managed model-resolution mismatch preserves the rejected response usage', async () => {
  const value = fixture();
  try {
    await assert.rejects(() => executeCodexOpenClawManaged({
      args: ['--sandbox', 'read-only', '--cd', value.workspace, '-'],
      stdin: 'HEPTA_CODEX_MODEL_CANARY_CHALLENGE abc. Return HEPTA_CODEX_CANARY_RESPONSE.',
      environment: value.environment,
      modelRuntimeLoader: injectedModelRuntime(async () => assistantMessage(
        'HEPTA_CODEX_CANARY_RESPONSE:42',
        { provider: 'anthropic' },
      )),
    }), (error) => {
      assert.equal(
        error.code,
        'codex_openclaw_managed_model_resolution_mismatch',
      );
      assert.deepEqual(error.usage, {
        input: 10,
        output: 10,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 20,
      });
      const configuration = readCodexOpenClawManagedConfiguration({
        environment: value.environment,
      });
      assert.equal(verifyOpenClawManagedFailureEvidence(
        buildOpenClawManagedFailureEvidence(error),
        {
          failureCode: error.code,
          model: 'gpt-5.6-sol',
          expectedAuthProfileIdentityHash:
            configuration.openClawManagedAuthProfileIdentityHash,
          expectedRuntimeProvenanceHash:
            FIXTURE_OPENCLAW_RUNTIME_PROVENANCE
              .openClawManagedRuntimeProvenanceHash,
          allowLegacyAudit: true,
        },
      ), true);
      return true;
    });
    assertManagedRuntimeClean(value);
  } finally {
    value.cleanup();
  }
});

test('managed app-server execution fails closed when one-shot artifacts cannot be fully cleaned', async () => {
  const value = fixture();
  try {
    await assert.rejects(() => executeCodexOpenClawManaged({
      args: ['--sandbox', 'read-only', '--cd', value.workspace, '-'],
      stdin: 'HEPTA_CODEX_MODEL_CANARY_CHALLENGE abc. Return HEPTA_CODEX_CANARY_RESPONSE.',
      environment: value.environment,
      modelRuntimeLoader: injectedModelRuntime(async (options, controls) => {
        controls.writeUnexpectedArtifact();
        return assistantMessage('HEPTA_CODEX_CANARY_RESPONSE:42');
      }),
    }), (error) => {
      assert.equal(
        error.code,
        'codex_openclaw_managed_session_cleanup_artifact_residue_detected',
      );
      assert.equal(error.retryable, false);
      return true;
    });
    assert.deepEqual(
      JSON.parse(fs.readFileSync(value.sessionStorePath, 'utf8')),
      {},
    );
    assert.equal(fs.readdirSync(value.internalRunsDir).length, 1);
    assert.match(
      fs.readdirSync(value.internalRunsDir)[0],
      /^[0-9a-f-]+\.unexpected$/,
    );
  } finally {
    value.cleanup();
  }
});
