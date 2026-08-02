import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { hashBytes } from '../../../workflow-kernel/record-hash.mjs';

export const DEPLOYMENT_SOCKET_POLICY = Object.freeze({
  idleTimeoutMs: 5_000,
  requestDeadlineMs: 10_000,
  maximumConcurrentConnections: 32,
});

function write(candidate, value, mode) {
  fs.mkdirSync(path.dirname(candidate), { recursive: true, mode: 0o700 });
  fs.writeFileSync(candidate, value, { mode });
  fs.chmodSync(candidate, mode);
}

function key(root, name) {
  const pair = crypto.generateKeyPairSync('ed25519');
  const privateKeyPath = path.join(root, 'var', 'lib', name, 'private.pem');
  const publicKeyPath = path.join(root, 'etc', 'hepta-paper',
    'release-attestor', `${name}-public.pem`);
  write(
    privateKeyPath,
    pair.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    0o600,
  );
  write(
    publicKeyPath,
    pair.publicKey.export({ type: 'spki', format: 'pem' }),
    0o644,
  );
  return Object.freeze({
    privateKeyPath,
    publicKeyPath,
    publicKeySpkiHash: hashBytes(
      pair.publicKey.export({ type: 'spki', format: 'der' }),
    ),
  });
}

export function provisionLocalReleaseAttestorDeploymentFixture(root) {
  const signerKey = key(root, 'hepta-paper-release-attestor');
  const probeKey = key(root, 'hepta-paper-release-probe');
  const configurationRoot = path.join(
    root,
    'etc',
    'hepta-paper',
    'release-attestor',
  );
  const signerConfigurationPath = path.join(
    configurationRoot,
    'signer-daemon.json',
  );
  const probeConfigurationPath = path.join(
    configurationRoot,
    'probe-daemon.json',
  );
  const signer = {
    version: 2,
    kind: 'LocalResearchExecutionReleaseAttestorDaemonConfiguration',
    mode: 'signer',
    backendId: 'host-release-attestor',
    backendVersion: 'dedicated-uid-v2',
    socketPath: '/run/hepta-paper-release-attestor/signer.sock',
    socketPolicy: DEPLOYMENT_SOCKET_POLICY,
    authority: {
      keyId: 'release-key-production',
      keyVersion: 'v2',
      subjectId: 'release-attestor-production',
      organization: 'Hepta Paper Host Authority',
      privateKeyPath: signerKey.privateKeyPath,
      publicKeySpkiHash: signerKey.publicKeySpkiHash,
    },
  };
  const probe = {
    version: 2,
    kind: 'LocalResearchExecutionReleaseAttestorDaemonConfiguration',
    mode: 'probe',
    backendId: signer.backendId,
    backendVersion: signer.backendVersion,
    socketPath: '/run/hepta-paper-release-probe/probe.sock',
    socketPolicy: DEPLOYMENT_SOCKET_POLICY,
    signerSocketPath: signer.socketPath,
    signerKeyId: signer.authority.keyId,
    signerKeyVersion: signer.authority.keyVersion,
    signerPublicKey: {
      publicKeyPath: signerKey.publicKeyPath,
      publicKeySpkiHash: signerKey.publicKeySpkiHash,
    },
    authority: {
      keyId: 'release-probe-key-production',
      keyVersion: 'v2',
      subjectId: 'release-attestor-probe-production',
      organization: 'Hepta Paper Host Probe Authority',
      privateKeyPath: probeKey.privateKeyPath,
      publicKeySpkiHash: probeKey.publicKeySpkiHash,
    },
  };
  const writeConfigurations = ({
    selectedSigner = signer,
    selectedProbe = probe,
  } = {}) => {
    write(signerConfigurationPath, `${JSON.stringify(selectedSigner, null, 2)}\n`, 0o640);
    write(probeConfigurationPath, `${JSON.stringify(selectedProbe, null, 2)}\n`, 0o640);
  };
  writeConfigurations();
  return Object.freeze({
    signer,
    probe,
    signerConfigurationPath,
    probeConfigurationPath,
    writeConfigurations,
  });
}
