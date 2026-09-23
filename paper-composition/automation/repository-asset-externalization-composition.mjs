import {
  buildRepositoryAssetExternalizationHandoff as buildHandoff,
  inspectRepositoryAssetExternalization as inspectExternalization,
} from '../../paper-adapters/automation/repository-asset-externalization.mjs';

export function inspectRepositoryAssetExternalization(options) {
  return inspectExternalization(options);
}

export function buildRepositoryAssetExternalizationHandoff(options) {
  return buildHandoff(options);
}
