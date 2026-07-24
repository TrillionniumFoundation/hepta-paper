import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  SYSTEM_DATASET_ACCESS_RUNTIME_IMAGES,
  SYSTEM_DATASET_ACCESS_SUPERVISOR,
} from '../../paper-domain/automation/dataset-access-supervisor-policy.mjs';
import { buildRuntimeImageReproducibilityAssessment } from '../../paper-domain/automation/runtime-build-reproducibility-contract.mjs';
import { verifyRRuntimeSourceCas } from './r-runtime-source-cas.mjs';
import {
  AUTONOMOUS_EMPIRICAL_PLUGIN_RUNTIME_LANGUAGES,
} from '../../paper-domain/automation/autonomous-empirical-family-plugin-registry.mjs';

function assertGpuScientificInputMirror(fileName) {
  const canonical = fs.readFileSync(fileURLToPath(new URL(
    `../../runtime-images/python-scientific/${fileName}`,
    import.meta.url,
  )));
  const mirrored = fs.readFileSync(fileURLToPath(new URL(
    `../../runtime-images/python-gpu/${fileName === 'requirements.lock'
      ? 'scientific-requirements.lock' : fileName}`,
    import.meta.url,
  )));
  if (!canonical.equals(mirrored)) {
    throw new Error(`python_gpu_scientific_input_mirror_drift:${fileName}`);
  }
}

assertGpuScientificInputMirror('requirements.lock');
assertGpuScientificInputMirror('hepta-dataset-access-supervisor');

export const R_RUNTIME_SOURCE_CAS = verifyRRuntimeSourceCas({
  contextPath: fileURLToPath(new URL('../../runtime-images/r-scientific', import.meta.url)),
});

export const DATASET_ACCESS_SUPERVISOR_PROTOCOL = SYSTEM_DATASET_ACCESS_SUPERVISOR.protocol;
export const DATASET_ACCESS_SUPERVISOR_PATH = SYSTEM_DATASET_ACCESS_SUPERVISOR.path;
export const DATASET_ACCESS_SUPERVISOR_SHA256 = SYSTEM_DATASET_ACCESS_SUPERVISOR.sha256;

const DATASET_ACCESS_SUPERVISOR = Object.freeze({
  version: 1,
  protocol: DATASET_ACCESS_SUPERVISOR_PROTOCOL,
  path: DATASET_ACCESS_SUPERVISOR_PATH,
  sha256: DATASET_ACCESS_SUPERVISOR_SHA256,
  workloadUid: SYSTEM_DATASET_ACCESS_SUPERVISOR.workloadUid,
});

export const RUNTIME_IMAGE_BUILD_REPRODUCIBILITY = Object.freeze({
  python: buildRuntimeImageReproducibilityAssessment({
    image: SYSTEM_DATASET_ACCESS_RUNTIME_IMAGES.python.image,
    imageDigest: SYSTEM_DATASET_ACCESS_RUNTIME_IMAGES.python.imageDigest,
    definitionManifestHash: 'sha256:4e50953602c7feb132da5bd45f94beefe62395669b25b78d98aa18d8ed770b03',
    baseImageDigestPinned: true,
    osPackageSnapshotPinned: true,
    dependencyVersionsPinned: true,
    dependencyArtifactsContentHashed: true,
    sourceArchivesContentHashed: true,
  }),
  pythonGpu: buildRuntimeImageReproducibilityAssessment({
    image: SYSTEM_DATASET_ACCESS_RUNTIME_IMAGES.pythonGpu.image,
    imageDigest: SYSTEM_DATASET_ACCESS_RUNTIME_IMAGES.pythonGpu.imageDigest,
    definitionManifestHash: 'sha256:98e1fa0742aa5e0efdfc9dc616235c7518a1bdfa652e388b874db5447fba6bd2',
    baseImageDigestPinned: true,
    osPackageSnapshotPinned: true,
    dependencyVersionsPinned: true,
    dependencyArtifactsContentHashed: true,
    sourceArchivesContentHashed: true,
  }),
  r: buildRuntimeImageReproducibilityAssessment({
    image: SYSTEM_DATASET_ACCESS_RUNTIME_IMAGES.r.image,
    imageDigest: SYSTEM_DATASET_ACCESS_RUNTIME_IMAGES.r.imageDigest,
    definitionManifestHash: 'sha256:5e172fce22a0f643357a455007104330aa3834c339a7aaf9b5ef6f2cfd4ed790',
    baseImageDigestPinned: true,
    osPackageSnapshotPinned: true,
    dependencyVersionsPinned: true,
    dependencyArtifactsContentHashed: R_RUNTIME_SOURCE_CAS.ready,
    sourceArchivesContentHashed: R_RUNTIME_SOURCE_CAS.ready,
    additionalBlockers: R_RUNTIME_SOURCE_CAS.ready
      ? [] : ['r_package_source_content_hashes_incomplete', ...R_RUNTIME_SOURCE_CAS.blockers],
  }),
});

export const AUTOMATION_RUNTIME_IMAGES = Object.freeze({
  python: Object.freeze({
    image: SYSTEM_DATASET_ACCESS_RUNTIME_IMAGES.python.image,
    imageDigest: SYSTEM_DATASET_ACCESS_RUNTIME_IMAGES.python.imageDigest,
    executable: SYSTEM_DATASET_ACCESS_RUNTIME_IMAGES.python.containerExecutable,
    datasetAccessSupervisor: DATASET_ACCESS_SUPERVISOR,
    buildReproducibility: RUNTIME_IMAGE_BUILD_REPRODUCIBILITY.python,
  }),
  pythonGpu: Object.freeze({
    image: SYSTEM_DATASET_ACCESS_RUNTIME_IMAGES.pythonGpu.image,
    imageDigest: SYSTEM_DATASET_ACCESS_RUNTIME_IMAGES.pythonGpu.imageDigest,
    executable: SYSTEM_DATASET_ACCESS_RUNTIME_IMAGES.pythonGpu.containerExecutable,
    datasetAccessSupervisor: DATASET_ACCESS_SUPERVISOR,
    buildReproducibility: RUNTIME_IMAGE_BUILD_REPRODUCIBILITY.pythonGpu,
  }),
  r: Object.freeze({
    image: SYSTEM_DATASET_ACCESS_RUNTIME_IMAGES.r.image,
    imageDigest: SYSTEM_DATASET_ACCESS_RUNTIME_IMAGES.r.imageDigest,
    executable: SYSTEM_DATASET_ACCESS_RUNTIME_IMAGES.r.containerExecutable,
    datasetAccessSupervisor: DATASET_ACCESS_SUPERVISOR,
    buildReproducibility: RUNTIME_IMAGE_BUILD_REPRODUCIBILITY.r,
  }),
});

export const AUTOMATION_RUNTIME_IMAGE_BUILD_DEFINITIONS = Object.freeze({
  python: Object.freeze({
    profile: 'python',
    contextPath: 'runtime-images/python-scientific',
    definitionPaths: Object.freeze([
      'Dockerfile', 'requirements.lock', 'hepta-dataset-access-supervisor',
    ]),
    image: AUTOMATION_RUNTIME_IMAGES.python.image,
    imageDigest: AUTOMATION_RUNTIME_IMAGES.python.imageDigest,
    definitionManifestHash: RUNTIME_IMAGE_BUILD_REPRODUCIBILITY.python.definitionManifestHash,
  }),
  pythonGpu: Object.freeze({
    profile: 'pythonGpu',
    contextPath: 'runtime-images/python-gpu',
    definitionPaths: Object.freeze([
      'Dockerfile', 'requirements.lock', 'scientific-requirements.lock',
      'hepta-dataset-access-supervisor',
    ]),
    image: AUTOMATION_RUNTIME_IMAGES.pythonGpu.image,
    imageDigest: AUTOMATION_RUNTIME_IMAGES.pythonGpu.imageDigest,
    definitionManifestHash: RUNTIME_IMAGE_BUILD_REPRODUCIBILITY.pythonGpu.definitionManifestHash,
  }),
  r: Object.freeze({
    profile: 'r',
    contextPath: 'runtime-images/r-scientific',
    definitionPaths: Object.freeze([
      'Dockerfile', 'renv.lock', 'packages.lock', 'restore-locked.R', 'verify-locked.R',
      'normalize-installed.sh',
      'hepta-dataset-access-supervisor',
      ...R_RUNTIME_SOURCE_CAS.definitionPaths,
    ]),
    image: AUTOMATION_RUNTIME_IMAGES.r.image,
    imageDigest: AUTOMATION_RUNTIME_IMAGES.r.imageDigest,
    definitionManifestHash: RUNTIME_IMAGE_BUILD_REPRODUCIBILITY.r.definitionManifestHash,
  }),
});

export function runtimeCapabilityForCampaign({ gpu = false, requireTrustedDatasetAccess = false } = {}) {
  const matrix = Object.freeze({
    cpu: true,
    gpu: Boolean(AUTOMATION_RUNTIME_IMAGES.pythonGpu),
    trustedDataset: Boolean(AUTOMATION_RUNTIME_IMAGES.python.datasetAccessSupervisor),
    gpuTrustedDataset: Boolean(AUTOMATION_RUNTIME_IMAGES.pythonGpu.datasetAccessSupervisor),
  });
  const requestedCapability = gpu && requireTrustedDatasetAccess ? 'gpuTrustedDataset'
    : gpu ? 'gpu' : requireTrustedDatasetAccess ? 'trustedDataset' : 'cpu';
  const ready = matrix[requestedCapability] === true;
  return Object.freeze({
    version: 1,
    kind: 'CampaignEmpiricalRuntimeCapability',
    matrix,
    requestedCapability,
    ready,
    blockers: ready ? [] : [`empirical_runtime_capability_unavailable:${requestedCapability}`],
  });
}

export function runtimeImagesForCampaign({ gpu = false, requireTrustedDatasetAccess = false } = {}) {
  const capability = runtimeCapabilityForCampaign({ gpu, requireTrustedDatasetAccess });
  if (!capability.ready) return Object.freeze({});
  return Object.freeze(Object.fromEntries(
    AUTONOMOUS_EMPIRICAL_PLUGIN_RUNTIME_LANGUAGES.map((language) => [
      language,
      language === 'python' && gpu
        ? AUTOMATION_RUNTIME_IMAGES.pythonGpu
        : AUTOMATION_RUNTIME_IMAGES[language],
    ]),
  ));
}
