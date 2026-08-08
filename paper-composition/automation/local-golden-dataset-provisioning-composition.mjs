import {
  executeLocalGoldenDatasetProvisioning as executeProvisioning,
  inspectLocalGoldenDatasetProvisioning as inspectProvisioning,
} from '../../paper-adapters/automation/local-golden-dataset-provisioner.mjs';

export function inspectLocalGoldenDatasetProvisioning(options = {}) {
  return inspectProvisioning(options);
}

export function executeLocalGoldenDatasetProvisioning(options = {}) {
  return executeProvisioning(options);
}
