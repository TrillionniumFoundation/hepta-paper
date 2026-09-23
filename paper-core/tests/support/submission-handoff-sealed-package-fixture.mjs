import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { hashRecord } from '../../../workflow-kernel/record-hash.mjs';

function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

export function buildSealedSubmissionHandoffPackageFixture(root) {
  const packageDir = path.join(root, 'sealed-source');
  const specifications = [
    {
      role: 'package_record',
      packageRelativePath: 'PACKAGE_RECORD.json',
      content: Buffer.from('{"kind":"PackageRecord"}\n', 'utf8'),
    },
    {
      role: 'research_evidence_capsule_manifest',
      capsuleRole: 'research_evidence_capsule_manifest',
      packageRelativePath: 'evidence/CAPSULE_MANIFEST.json',
      content: Buffer.from('{"kind":"ResearchEvidenceCapsuleManifest"}\n', 'utf8'),
    },
    {
      role: 'research_evidence_capsule_file',
      capsuleRole: 'gpu_scientific_pde_output',
      executionRole: 'pde_poisson_2d',
      experimentId: 'experiment-pde',
      packageRelativePath: 'evidence/gpu-scientific/pde-output.bin',
      content: Buffer.from([0, 1, 2, 3, 4, 255]),
    },
  ];
  const files = specifications.map(({ content, ...specification }) => {
    const candidate = path.join(
      packageDir,
      ...specification.packageRelativePath.split('/'),
    );
    fs.mkdirSync(path.dirname(candidate), { recursive: true, mode: 0o700 });
    fs.writeFileSync(candidate, content, { mode: 0o600 });
    return Object.freeze({
      ...specification,
      path: candidate,
      hash: sha256(content),
      bytes: content.length,
    });
  });
  for (const file of files) fs.chmodSync(file.path, 0o444);
  fs.chmodSync(path.join(packageDir, 'evidence', 'gpu-scientific'), 0o555);
  fs.chmodSync(path.join(packageDir, 'evidence'), 0o555);
  fs.chmodSync(packageDir, 0o555);
  const payload = {
    version: 1,
    kind: 'ImmutableCampaignPackageOutput',
    immutable: true,
    releaseRoot: packageDir,
    packageDir,
    artifactBaseRoot: packageDir,
    files: Object.freeze(files),
    fileCount: files.length,
    externalActionPerformed: false,
  };
  return Object.freeze({
    ...payload,
    immutableCampaignPackageOutputHash:
      hashRecord('ImmutableCampaignPackageOutput', payload),
  });
}

export function rehashSealedSubmissionHandoffPackageOutput(
  packageOutput,
  overrides = {},
) {
  const payload = { ...packageOutput, ...overrides };
  delete payload.immutableCampaignPackageOutputHash;
  return Object.freeze({
    ...payload,
    immutableCampaignPackageOutputHash:
      hashRecord('ImmutableCampaignPackageOutput', payload),
  });
}
