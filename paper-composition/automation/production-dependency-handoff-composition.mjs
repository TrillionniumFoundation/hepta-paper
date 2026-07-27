import fs from 'node:fs';
import path from 'node:path';

import {
  buildProductionDependencyHandoff,
} from '../../paper-application/automation/production-dependency-handoff.mjs';
import {
  inspectWorkspaceExecutionSnapshot,
} from '../../paper-adapters/runtime/execution-snapshot.mjs';
import {
  inspectRepositoryAssetExternalization,
} from '../../paper-adapters/automation/repository-asset-externalization.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';

export function composeProductionDependencyHandoff({
  readiness,
  repositoryRoot,
} = {}) {
  const selectedRoot = path.resolve(repositoryRoot);
  const assetManifest = JSON.parse(fs.readFileSync(path.join(
    selectedRoot,
    'paper-core/config/repository-asset-externalization.v1.json',
  ), 'utf8'));
  const assetInspection = inspectRepositoryAssetExternalization({
    repositoryRoot: selectedRoot,
    manifest: assetManifest,
  });
  const candidateRoot = path.join(
    selectedRoot,
    'numerical-plugins/reference-candidates',
  );
  const candidateManifest = JSON.parse(fs.readFileSync(
    path.join(candidateRoot, 'manifest.json'),
    'utf8',
  ));
  const candidateSnapshot = inspectWorkspaceExecutionSnapshot(candidateRoot, {
    excludeNames: ['__pycache__'],
  });
  if (candidateSnapshot.blockers.length) {
    throw new Error(
      `advanced_numerical_reference_candidate_snapshot_blocked:${
        candidateSnapshot.blockers.join(',')
      }`,
    );
  }
  const entrypointHash = hashBytes(fs.readFileSync(
    path.join(candidateRoot, candidateManifest.entrypoint),
  ));
  const candidateManifestHash = hashRecord(
    'AdvancedNumericalReferenceCandidateManifest',
    candidateManifest,
  );
  const numericalCandidates = candidateManifest.analysisFamilies.map((analysisFamily) => (
    Object.freeze({
      pluginId: `hepta.reference.${analysisFamily}`,
      pluginVersion: '1.0.0',
      analysisFamily,
      status: 'reference_candidate_unqualified',
      productionQualified: false,
      entrypoint: candidateManifest.entrypoint,
      entrypointHash,
      sourceMerkleHash: candidateSnapshot.merkleHash,
      sourceWorkspaceManifestHash: candidateSnapshot.manifestHash,
      candidateManifestHash,
      runtimeExecutableHash: null,
      runtimePackageClosureHash: null,
      signedBundleHash: null,
      qualificationStatementHash: null,
    })
  ));
  return buildProductionDependencyHandoff({
    readiness,
    repositoryAssetInspection: assetInspection,
    repositoryAssetManifest: assetManifest,
    numericalCandidates,
  });
}
