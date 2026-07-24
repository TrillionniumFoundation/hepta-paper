import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildPinnedFormalSandboxRuntimeConfiguration,
  configuredPinnedFormalSandboxRuntime,
  inspectConfiguredPinnedFormalSandboxRuntime,
  readPinnedFormalSandboxRuntimeConfiguration,
} from '../../paper-adapters/research-verify/pinned-formal-sandbox-runtime-configuration.mjs';

const DIGEST = `sha256:${'a'.repeat(64)}`;

test('formal sandbox runtime configuration is digest-pinned and hash-authorized', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-formal-runtime-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configuration = buildPinnedFormalSandboxRuntimeConfiguration({
    image: `registry.example/hepta-lean@${DIGEST}`,
    imageDigest: DIGEST,
  });
  const configPath = path.join(root, 'formal-runtime.json');
  fs.writeFileSync(configPath, `${JSON.stringify(configuration)}\n`, { mode: 0o600 });
  assert.deepEqual(readPinnedFormalSandboxRuntimeConfiguration({
    configPath,
    expectedConfigurationHash: configuration.configurationHash,
  }), configuration);
  const environment = {
    HEPTA_FORMAL_SANDBOX_RUNTIME_CONFIG: configPath,
    HEPTA_FORMAL_SANDBOX_RUNTIME_CONFIG_HASH: configuration.configurationHash,
  };
  assert.equal(configuredPinnedFormalSandboxRuntime({ environment }).imageDigest, DIGEST);
  const inspection = inspectConfiguredPinnedFormalSandboxRuntime({
    environment,
    probeRuntime: false,
  });
  assert.equal(inspection.ready, true);
  assert.equal(inspection.runtime.kind, 'PinnedFormalSandboxRuntime');
});

test('formal sandbox runtime configuration fails closed on missing pin and tamper', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-formal-runtime-invalid-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configuration = buildPinnedFormalSandboxRuntimeConfiguration({
    image: `registry.example/hepta-lean@${DIGEST}`,
    imageDigest: DIGEST,
  });
  const configPath = path.join(root, 'formal-runtime.json');
  fs.writeFileSync(configPath, JSON.stringify(configuration));
  assert.throws(() => readPinnedFormalSandboxRuntimeConfiguration({ configPath }), {
    message: 'formal_sandbox_runtime_configuration_hash_required',
  });
  fs.writeFileSync(configPath, JSON.stringify({ ...configuration, imageDigest: `sha256:${'b'.repeat(64)}` }));
  const inspection = inspectConfiguredPinnedFormalSandboxRuntime({
    environment: {
      HEPTA_FORMAL_SANDBOX_RUNTIME_CONFIG: configPath,
      HEPTA_FORMAL_SANDBOX_RUNTIME_CONFIG_HASH: configuration.configurationHash,
    },
    probeRuntime: false,
  });
  assert.equal(inspection.ready, false);
  assert.match(inspection.blockers.join(','), /configuration_invalid|verification_failed/);
});

test('dynamic formal readiness can distinguish an absent trusted runtime', () => {
  const inspection = inspectConfiguredPinnedFormalSandboxRuntime({
    environment: {},
    allowSystemDefault: false,
    probeRuntime: false,
  });
  assert.equal(inspection.ready, false);
  assert.deepEqual(inspection.blockers, ['formal_sandbox_runtime_configuration_missing']);
});

test('system formal sandbox runtime is digest-pinned and operationally probed', () => {
  const inspection = inspectConfiguredPinnedFormalSandboxRuntime({ environment: {} });
  assert.equal(inspection.systemDefault, true);
  assert.match(inspection.image, /@sha256:[0-9a-f]{64}$/);
  assert.equal(inspection.imageDigest, inspection.runtime.imageDigest);
  assert.equal(inspection.ready, inspection.sandbox?.available === true
    && inspection.blockers.length === 0);
});
