#!/usr/bin/env node
import { writeSignedReleaseEvidence } from './release-evidence-lib.mjs';
import { defaultLegacyPaperFactoryRoot, defaultPaperRuntimeRoot } from '../src/workspace-layout.mjs';

const result = writeSignedReleaseEvidence({
  runtimeRoot: defaultPaperRuntimeRoot(),
  legacyRoot: defaultLegacyPaperFactoryRoot(),
});
process.stdout.write(`${JSON.stringify({
  status: result.bundle.status,
  releaseEvidenceBundleHash: result.bundle.releaseEvidenceBundleHash,
  publicKeyFingerprint: result.signature.publicKeyFingerprint,
  outputRoot: result.root,
}, null, 2)}\n`);
if (result.bundle.status !== 'release_evidence_bundle_ready') process.exitCode = 1;
