import fs from 'node:fs';
import path from 'node:path';

import {
  buildProductionDependencyHandoff,
} from '../../paper-application/automation/production-dependency-handoff.mjs';
import {
  inspectAdvancedNumericalReferenceCandidateQualifications,
} from './advanced-numerical-reference-qualification-composition.mjs';
import {
  inspectWorkspaceExecutionSnapshot,
} from '../../paper-adapters/runtime/execution-snapshot.mjs';
import {
  inspectRepositoryAssetExternalization,
} from '../../paper-adapters/automation/repository-asset-externalization.mjs';
import { hashBytes } from '../../workflow-kernel/record-hash.mjs';

export function composeProductionDependencyHandoff({
  readiness,
  repositoryRoot,
  environment = process.env,
  numericalQualificationInspector =
    inspectAdvancedNumericalReferenceCandidateQualifications,
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
  const numericalCandidates = numericalQualificationInspector({
    candidateRoot,
    candidateManifest,
    candidateSnapshot,
    entrypointHash,
    registryPath:
      environment.HEPTA_ADVANCED_NUMERICAL_PLUGIN_QUALIFICATION_REGISTRY || null,
    registryHash:
      environment.HEPTA_ADVANCED_NUMERICAL_PLUGIN_QUALIFICATION_REGISTRY_HASH
      || null,
  });
  return buildProductionDependencyHandoff({
    readiness,
    repositoryAssetInspection: assetInspection,
    repositoryAssetManifest: assetManifest,
    numericalCandidates,
  });
}
