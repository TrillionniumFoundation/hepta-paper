#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { CAPABILITY_CATALOG } from '../legacy-capability-matrix-v3.mjs';
import { executeCapabilityVerification } from '../capability-operational-evidence.mjs';
import { createDefaultPaperStore } from '../../paper-adapters/persistence/store-provider.mjs';
import { createSqliteReceiptLedger } from '../../paper-adapters/persistence/sqlite-receipt-ledger.mjs';
import { createFilesystemArtifactRepository } from '../../paper-adapters/artifacts/filesystem-artifact-repository.mjs';
import { createSystemClock } from '../../paper-adapters/runtime/system-clock.mjs';
import { currentCodeProvenance } from '../../paper-core/src/code-provenance.mjs';
import { defaultPaperAssetRoot, defaultPaperRuntimeRoot } from '../../paper-core/src/workspace-layout.mjs';

if (!process.argv.includes('--execute')) {
  throw new Error('production capability verification refresh requires --execute');
}

const root = defaultPaperAssetRoot();
const runtimeRoot = defaultPaperRuntimeRoot();
const releaseCommit = currentCodeProvenance().commit;
if (!releaseCommit) throw new Error('release commit missing');

process.env.HEPTA_EVIDENCE_ENVIRONMENT = 'production';
process.env.HEPTA_EVIDENCE_CLASS = 'release_conformance_with_operational_binding';
process.env.HEPTA_RELEASE_COMMIT = releaseCommit;

const clock = createSystemClock();
const store = createDefaultPaperStore({ root, runtimeRoot });
const capabilityLedger = createSqliteReceiptLedger({
  store,
  clock,
  writerIdentity: {
    writerId: 'production-capability-verifier',
    writerKind: 'capability-verifier',
    trusted: true,
    allowedKinds: ['CapabilityVerificationReceipt'],
    allowedStreams: ['capability-verification'],
  },
});
const artifactLedger = createSqliteReceiptLedger({
  store,
  clock,
  writerIdentity: {
    writerId: 'production-capability-artifact-repository',
    writerKind: 'content-addressed-repository',
    trusted: true,
    allowedKinds: ['ArtifactWriteReceipt'],
    allowedStreams: ['artifact-writes'],
  },
});
const repositoryFactory = (scopeRoot) => createFilesystemArtifactRepository({
  scopeRoot,
  casRoot: path.join(runtimeRoot, 'artifact-cas'),
  repositoryId: 'production-capability-verification-cas',
  receiptLedger: artifactLedger,
  clock,
});

const result = await executeCapabilityVerification({
  runtimeRoot,
  receiptLedger: capabilityLedger,
  artifactRepositoryFactory: repositoryFactory,
  clock,
  capabilityCatalog: CAPABILITY_CATALOG,
});
if (result.manifest.status !== 'capability_verification_complete') {
  throw new Error(`capability verification refresh blocked:${result.manifest.status}`);
}
if (!(result.manifest.receipts || []).every((receipt) => receipt.operationalProof === true && receipt.operationalReceiptHashes?.length > 0)) {
  throw new Error('capability verification refresh lacks operational proof bindings');
}

const releaseCurrent = path.join(runtimeRoot, 'release-evidence', 'current');
fs.mkdirSync(releaseCurrent, { recursive: true });
const mirrorRepository = repositoryFactory(releaseCurrent);
const mirrorReceipt = await mirrorRepository.writeJson(
  path.join(releaseCurrent, 'CAPABILITY_VERIFICATION_MANIFEST.json'),
  result.manifest,
  { role: 'release_current_capability_verification_manifest', atomic: true },
);

store.close?.();
process.stdout.write(`${JSON.stringify({
  status: result.manifest.status,
  capabilityCount: result.manifest.capabilityCount,
  operationallyBoundCount: result.manifest.receipts.filter((receipt) => receipt.operationalProof).length,
  manifestHash: result.manifest.capabilityVerificationManifestHash,
  auditWriteReceiptHash: result.writeReceipt.writeReceiptHash,
  releaseCurrentWriteReceiptHash: mirrorReceipt.writeReceiptHash,
  releaseCommit,
}, null, 2)}\n`);
