// Calls the incumbent reader and inspection producer. All mutable inputs belong
// to an explicitly marked private test directory; no command is executed.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {readExternalResearchQualificationProcessConfiguration as read}
  from '../../paper-adapters/automation/external-research-qualification-process-identity.mjs';
import {inspectExternalResearchQualificationProcessConfiguration as inspect}
  from '../../paper-adapters/automation/external-research-qualification-process-adapter.mjs';
import {externalQualificationProcessConfigurationInspectionReady as ready}
  from '../../paper-composition/automation/autonomous-research-readiness-inspections.mjs';
import {productionOracleProfile} from './production-record-hash-v1.mjs';

const MARKER = '.owned-qualification-configuration-fixture';
function rootFor(input) {
  const root = path.resolve(input.root);
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()
    || (stat.mode & 0o077) !== 0 || fs.realpathSync(root) !== root
    || !root.startsWith(fs.realpathSync(os.tmpdir()) + path.sep)
    || fs.readFileSync(path.join(root, MARKER), 'utf8') !== 'owned nonsecret fixture\n') {
    throw Error('owned_qualification_fixture_required');
  }
  return root;
}
function setup(root) {
  const write = (name, text, mode = 0o600) => {
    const file = path.join(root, name);
    fs.writeFileSync(file, text, {flag: 'wx', mode});
    fs.chmodSync(file, mode);
    return file;
  };
  const publicKey = name => {
    // The private part is ephemeral memory only and is never exported.
    const pair = crypto.generateKeyPairSync('ed25519');
    return write(name, pair.publicKey.export({type: 'spki', format: 'pem'}));
  };
  const releasePublic = publicKey('release-public.pem');
  const verifierPublic = publicKey('verifier-public.pem');
  const retiringPublic = publicKey('retiring-public.pem');
  write('resource.txt', 'owned argument resource\n');
  const command = name => {
    const credentialRoot = path.join(root, `${name}-credentials`);
    fs.mkdirSync(credentialRoot, {mode: 0o700});
    fs.chmodSync(credentialRoot, 0o700);
    fs.mkdirSync(path.join(credentialRoot, 'nested'), {mode: 0o700});
    write(`${name}-credentials/z.txt`, `nonsecret fixture ${name} z`);
    write(`${name}-credentials/nested/a.txt`, `nonsecret fixture ${name} a`);
    return {
      serviceId: `${name}-service`, principalId: `${name}-principal`,
      protocol: 'external-qualification-json-stdio-v1',
      executable: write(`${name}.sh`, `#!/bin/sh\n# owned ${name}\ntouch '${root}/executed-marker'\nexit 91\n`, 0o700),
      credentialRoot, args: ['resource.txt', '--mode', 'qualification'],
      environmentAllowlist: ['FIXTURE_ALLOWED', 'FIXTURE_ALLOWED'], timeoutMs: 1000,
    };
  };
  const signer = {
    algorithm: 'ed25519', keyId: 'fixture-key-a', keyVersion: '1',
    subjectId: 'fixture-release-subject', organization: 'Fixture Release Office',
    role: 'research_execution_release_attestor', status: 'active',
    effectiveFrom: '2026-01-01T00:00:00.000Z', expiresAt: '2027-01-01T00:00:00.000Z',
    revokedAt: null, publicKeyPath: releasePublic,
  };
  const config = {
    version: 3, kind: 'ExternalResearchQualificationProcessConfiguration', status: 'active',
    maximumQualificationCostUsd: 1, qualificationCostAuthority: 'operator_declared_worst_case_usd',
    qualifier: command('qualifier'), verifier: command('verifier'),
    trustedSignerTrustSet: {version: 1, kind: 'ResearchExecutionReleaseAttestorTrustSet', keys: [
      {...signer, keyId: 'fixture-key-Z', keyVersion: '2', status: 'retiring',
        publicKeyPath: retiringPublic}, signer,
    ]},
    verifierAttestor: {...signer, keyId: 'fixture-verifier-key', subjectId: 'fixture-verifier-subject',
      role: 'external_qualification_independent_verifier', organization: 'Independent Fixture Office',
      publicKeyPath: verifierPublic},
  };
  const configPath = write('configuration.json', JSON.stringify(config));
  const environment = {PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8',
    FIXTURE_ALLOWED: 'observed-value', FIXTURE_IGNORED: 'excluded-value'};
  return {configPath, config, environment};
}
function observe(configPath, environment) {
  let identity = null, error = null;
  try {
    const configuration = read({configPath, environment});
    const {publicKey, verifierPublicKey, ...serializable} = configuration;
    identity = {...serializable, trustedSignerKeys: configuration.trustedSignerKeys.map(
      ({publicKey: ignored, ...key}) => key)};
  } catch (failure) { error = failure.message; }
  const inspection = inspect({configPath, environment});
  return {identity, error, inspection, inspectionShapeReady: ready(inspection)};
}
function run(input) {
  const root = rootFor(input);
  if (input.action === 'setup') {
    const fixture = setup(root);
    return {...fixture, ...observe(fixture.configPath, fixture.environment)};
  }
  if (input.action !== 'inspect') throw Error('qualification_fixture_action_invalid');
  const configPath = input.configPath === null ? null : path.resolve(root, input.configPath);
  if (configPath && !configPath.startsWith(root + path.sep)) throw Error('fixture_path_escape');
  const environment = {...input.environment};
  const supplied = configPath || environment.HEPTA_AUTONOMOUS_EXTERNAL_QUALIFICATION_CONFIG;
  if (supplied && !path.resolve(root, supplied).startsWith(root + path.sep)) {
    throw Error('fixture_environment_path_escape');
  }
  return observe(configPath, environment);
}
const input = JSON.parse(process.argv[2]);
process.stdout.write(JSON.stringify({profile: productionOracleProfile(), value: run(input)}));
