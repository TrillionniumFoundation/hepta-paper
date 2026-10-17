// Test-only differential. Existing production owner reads fixture keys; only
// public signature values leave this bounded process.
import fs from 'node:fs';
import { releaseIntegrityEvidence } from '../../paper-core/bin/release-integrity-evidence.mjs';
import { productionOracleProfile } from './production-record-hash-v1.mjs';
const chunks = [];
let readBytes = 0;
while (true) {
  const block = Buffer.alloc(4096);
  const size = fs.readSync(0, block, 0, block.length, null);
  if (!size) break;
  readBytes += size;
  if (readBytes > 65536) throw new Error('native_release_signature_oracle_input_budget');
  chunks.push(block.subarray(0, size));
}
const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
if (request.version !== 1 || request.kind !== 'NativeReleaseSignatureDifferentialRequest'
  || !request.runtimeRoot.startsWith('/tmp/hepta-release-evidence-rust-')) {
  throw new Error('native_release_signature_oracle_requires_private_fixture');
}
const environment = {
  ...process.env,
  HEPTA_PAPER_RUNTIME_ISOLATED: '0',
  HEPTA_PAPER_ASSET_ROOT: request.assetRoot,
  PAPER_FACTORY_LEGACY_ROOT: request.legacyRoot,
};
const signature = releaseIntegrityEvidence.signReleasePayload(request.payload, request.runtimeRoot, {
  allowKeyCreation: false, environment, assetRoot: request.assetRoot,
});
const nativeVerified = releaseIntegrityEvidence.verifyReleaseIntegritySignature(request.payload, request.signature, {
  pinnedPublicKeyPem: signature.publicKeyPem,
  pinnedPublicKeyFingerprint: signature.publicKeyFingerprint,
});
process.stdout.write(JSON.stringify({ profile: productionOracleProfile(), signature, nativeVerified }));
