#!/usr/bin/env node
import path from 'node:path';
import { CAPABILITY_CATALOG } from '../legacy-capability-matrix-v3.mjs';
import { executeCapabilityVerification } from '../capability-operational-evidence.mjs';
import { createDefaultPaperStore } from '../../paper-adapters/persistence/store-provider.mjs';
import { createSqliteReceiptLedger } from '../../paper-adapters/persistence/sqlite-receipt-ledger.mjs';
import { createFilesystemArtifactRepository } from '../../paper-adapters/artifacts/filesystem-artifact-repository.mjs';
import { createSystemClock } from '../../paper-adapters/runtime/system-clock.mjs';
import { defaultPaperAssetRoot, defaultPaperRuntimeRoot } from '../../paper-core/src/workspace-layout.mjs';

const root = defaultPaperAssetRoot();
const runtimeRoot = defaultPaperRuntimeRoot();
const clock = createSystemClock();
const store = createDefaultPaperStore({ root, runtimeRoot });
const receiptLedger = createSqliteReceiptLedger({ store, clock });
const result = await executeCapabilityVerification({
  runtimeRoot,
  receiptLedger,
  clock,
  capabilityCatalog: CAPABILITY_CATALOG,
  artifactRepositoryFactory: (scopeRoot) => createFilesystemArtifactRepository({
    scopeRoot,
    casRoot: path.join(runtimeRoot, 'artifact-cas'),
    receiptLedger,
    clock,
  }),
});
process.stdout.write(`${JSON.stringify({
  ok: result.manifest.status === 'capability_verification_complete',
  kind: result.manifest.kind,
  status: result.manifest.status,
  capabilityCount: result.manifest.capabilityCount,
  passedCount: result.manifest.passedCount,
  manifestHash: result.manifest.capabilityVerificationManifestHash,
  writeReceiptHash: result.writeReceipt.writeReceiptHash,
})}\n`);
if (result.manifest.status !== 'capability_verification_complete') process.exitCode = 1;
