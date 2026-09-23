import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  loadAutomationReadinessDeploymentEnvironment,
} from '../../paper-adapters/automation/deployment-environment-file.mjs';

function environmentFile(t, content) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-deployment-env-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'supervisor.env');
  fs.writeFileSync(filePath, content, { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
  return filePath;
}

test('deployment readiness environment loads only owner-private non-secret policy keys', (t) => {
  const filePath = environmentFile(t, [
    '# production formal policy',
    'HEPTA_DYNAMIC_FORMAL_CLAIMS_ENABLED=1',
    'HEPTA_DYNAMIC_FORMAL_PROJECT_ROOT=/srv/hepta/formal',
    'HEPTA_DYNAMIC_FORMAL_PROJECT_CLOSURE_HASH=sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'HEPTA_PRIOR_ART_SERVICE_CONFIG_HASH=sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    'HEPTA_EXTERNAL_REPLAY_CONFIG_HASH=sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    'HEPTA_RUNTIME_IMAGE_REPRODUCIBILITY_CONFIG_HASH=sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
    'HEPTA_ADVANCED_NUMERICAL_PLUGIN_QUALIFICATION_REGISTRY_HASH=sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    'HEPTA_AUTONOMOUS_SUBMISSION_PORTAL_DESCRIPTOR_HASH=sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
    'HEPTA_RESEARCH_AUTHOR_MODEL=\"pinned-model\"',
    '',
  ].join('\n'));
  const result = loadAutomationReadinessDeploymentEnvironment({
    baseEnvironment: { PATH: '/usr/bin', HEPTA_RESEARCH_AUTHOR_MODEL: 'ambient-model' },
    filePath,
  });
  assert.equal(result.environment.PATH, '/usr/bin');
  assert.equal(result.environment.HEPTA_RESEARCH_AUTHOR_MODEL, 'pinned-model');
  assert.equal(result.environment.HEPTA_DYNAMIC_FORMAL_CLAIMS_ENABLED, '1');
  assert.equal(
    result.inspection.status,
    'automation_readiness_deployment_environment_loaded',
  );
  assert.match(result.inspection.fileHash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(result.inspection.credentialMaterialLoaded, false);
  assert.deepEqual(result.inspection.loadedKeys, [
    'HEPTA_ADVANCED_NUMERICAL_PLUGIN_QUALIFICATION_REGISTRY_HASH',
    'HEPTA_AUTONOMOUS_SUBMISSION_PORTAL_DESCRIPTOR_HASH',
    'HEPTA_DYNAMIC_FORMAL_CLAIMS_ENABLED',
    'HEPTA_DYNAMIC_FORMAL_PROJECT_CLOSURE_HASH',
    'HEPTA_DYNAMIC_FORMAL_PROJECT_ROOT',
    'HEPTA_EXTERNAL_REPLAY_CONFIG_HASH',
    'HEPTA_PRIOR_ART_SERVICE_CONFIG_HASH',
    'HEPTA_RESEARCH_AUTHOR_MODEL',
    'HEPTA_RUNTIME_IMAGE_REPRODUCIBILITY_CONFIG_HASH',
  ]);
  assert.equal(JSON.stringify(result.inspection).includes('pinned-model'), false);
});

test('deployment readiness environment rejects secrets, duplicates, and broad modes', (t) => {
  const secret = environmentFile(t, 'HEPTA_PROVIDER_SECRET_TOKEN=must-not-load\n');
  assert.throws(
    () => loadAutomationReadinessDeploymentEnvironment({ filePath: secret }),
    /deployment_environment_key_not_allowlisted/,
  );

  const duplicate = environmentFile(t, [
    'HEPTA_DYNAMIC_FORMAL_CLAIMS_ENABLED=1',
    'HEPTA_DYNAMIC_FORMAL_CLAIMS_ENABLED=1',
  ].join('\n'));
  assert.throws(
    () => loadAutomationReadinessDeploymentEnvironment({ filePath: duplicate }),
    /deployment_environment_key_duplicate/,
  );

  const broad = environmentFile(t, 'HEPTA_DYNAMIC_FORMAL_CLAIMS_ENABLED=1\n');
  fs.chmodSync(broad, 0o640);
  assert.throws(
    () => loadAutomationReadinessDeploymentEnvironment({ filePath: broad }),
    /deployment_environment_file_permissions_too_broad/,
  );
});
