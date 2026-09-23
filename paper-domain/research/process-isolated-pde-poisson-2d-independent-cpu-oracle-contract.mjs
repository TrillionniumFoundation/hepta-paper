import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  SYSTEM_DATASET_ACCESS_RUNTIME_IMAGES,
} from '../automation/dataset-access-supervisor-policy.mjs';
import {
  verifyPdePoisson2dGpuArtifactManifest,
  verifyPdePoisson2dGpuProducerSpecification,
} from './pde-poisson-2d-gpu-capability-contract.mjs';
import {
  verifyPdePoisson2dIndependentCpuOracleReceipt,
} from './pde-poisson-2d-independent-cpu-oracle-contract.mjs';
import {
  buildPdePoisson2dCpuOracleRuntimeAttestation,
  verifyPdePoisson2dCpuOracleRuntimeAttestation,
} from './pde-poisson-2d-cpu-oracle-runtime-attestation.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const REQUIRED_SOURCE_ROLES = Object.freeze([
  'oracle-algorithm',
  'process-assurance-contract',
  'producer-artifact-contract',
  'scientific-receipt-contract',
  'worker-entry',
]);
const TRANSITIVE_SOURCE_ROLE = /^transitive:[A-Za-z0-9._/-]+\.mjs$/;
const SOURCE_RECORD_KEYS = Object.freeze(['role', 'sha256']);
const IMPLEMENTATION_KEYS = Object.freeze([
  'assuranceScope', 'independentAlgorithmImplementationHash', 'kind',
  'sourceManifestHash', 'sourceRecords', 'version', 'workerImplementationHash',
]);
const ARTIFACT_PAYLOAD_KEYS = Object.freeze([
  'bytes', 'contentBase64', 'gridSize', 'sha256',
]);
const RESOURCE_BUDGET_KEYS = Object.freeze([
  'cpuSeconds', 'maximumProcesses', 'memoryBytes', 'timeoutMs',
]);
const REQUEST_KEYS = Object.freeze([
  'artifactManifest', 'artifactPayloads', 'artifactReadReceiptHashes', 'kind',
  'oracleRuntimeIdentityHash', 'producerSpecification', 'requestHash',
  'resourceBudget', 'version', 'workerImplementationHash',
]);
const WORKER_RECEIPT_KEYS = Object.freeze([
  'artifactManifestHash', 'assuranceScope', 'blockers',
  'externalActionPerformed', 'independentAlgorithmImplementationHash', 'kind',
  'networkActionPerformed', 'oracleReceipt', 'oracleReceiptHash', 'parentPid',
  'processIndependent', 'producerSpecificationHash', 'requestHash', 'status',
  'version', 'workerImplementationHash', 'workerPid', 'workerReceiptHash',
  'workerSourceManifestHash',
]);
const ASSURANCE_KEYS = Object.freeze([
  'absoluteDeadlineEpochMs', 'artifactManifestHash', 'assuranceScope', 'blockers',
  'externalActionPerformed',
  'independentAlgorithmImplementationHash', 'kind', 'networkActionPerformed',
  'oracleReceipt', 'oracleReceiptHash', 'oracleRuntimeIdentityHash',
  'osSandboxBackend', 'osSandboxEnvironmentBomHash', 'osSandboxWorkerReceipt',
  'osSandboxWorkerReceiptHash', 'pdePoisson2dProcessIsolatedCpuOracleAssuranceHash',
  'processIndependent', 'producerDiagnosticsUsed', 'producerSpecificationHash',
  'productionBlockers', 'productionQualified', 'promotionEligible', 'request',
  'requestHash', 'resourceBudget', 'runtimeAttestation', 'runtimeAttestationHash',
  'runtimeImageDigest', 'runtimePackageClosureHash',
  'scientificAuthority', 'status', 'version', 'workerImplementation',
  'workerImplementationHash', 'workerReceipt', 'workerReceiptHash',
  'workerSourceManifestHash',
]);

export const PDE_POISSON_2D_PROCESS_ISOLATED_CPU_ORACLE_ASSURANCE_SCOPE =
  'os-sandboxed-process-isolated-independent-cpu-oracle-v2';
export const PDE_POISSON_2D_CPU_ORACLE_RUNTIME_IMAGE = Object.freeze({
  image: SYSTEM_DATASET_ACCESS_RUNTIME_IMAGES.python.image,
  imageDigest: SYSTEM_DATASET_ACCESS_RUNTIME_IMAGES.python.imageDigest,
});
export const PDE_POISSON_2D_CPU_ORACLE_RESOURCE_LIMITS = Object.freeze({
  timeoutMs: 300_000,
  memoryBytes: 512 * 1024 * 1024,
  cpuSeconds: 60,
  maximumProcesses: 8,
});

function sha(value) {
  const selected = String(value || '').toLowerCase();
  return SHA256.test(selected) ? selected : null;
}

function uniqueSorted(values) {
  return Object.freeze([...new Set((values || []).map(String))].sort());
}

export function verifyPdePoisson2dCpuOracleResourceBudget(value) {
  return hasExactObjectKeys(value, RESOURCE_BUDGET_KEYS)
    && Object.entries(PDE_POISSON_2D_CPU_ORACLE_RESOURCE_LIMITS).every(
      ([key, maximum]) => Number.isSafeInteger(value[key])
        && value[key] >= 1 && value[key] <= maximum,
    );
}

function canonicalSourceRecords(records) {
  if (!Array.isArray(records)
    || records.length <= REQUIRED_SOURCE_ROLES.length) {
    throw new Error('pde_poisson_2d_cpu_oracle_source_manifest_invalid');
  }
  const required = REQUIRED_SOURCE_ROLES.map((role, index) => {
    const record = records[index];
    if (!hasExactObjectKeys(record, SOURCE_RECORD_KEYS)
      || record.role !== role || !sha(record.sha256)) {
      throw new Error('pde_poisson_2d_cpu_oracle_source_manifest_invalid');
    }
    return Object.freeze({ role, sha256: sha(record.sha256) });
  });
  const transitive = records.slice(REQUIRED_SOURCE_ROLES.length).map((record) => {
    if (!hasExactObjectKeys(record, SOURCE_RECORD_KEYS)
      || !TRANSITIVE_SOURCE_ROLE.test(String(record.role || ''))
      || String(record.role).includes('/../')
      || String(record.role).includes('\\')
      || !sha(record.sha256)) {
      throw new Error('pde_poisson_2d_cpu_oracle_source_manifest_invalid');
    }
    return Object.freeze({ role: record.role, sha256: sha(record.sha256) });
  });
  const roles = transitive.map(({ role }) => role);
  if (new Set(roles).size !== roles.length
    || JSON.stringify(roles) !== JSON.stringify([...roles].sort())) {
    throw new Error('pde_poisson_2d_cpu_oracle_source_manifest_invalid');
  }
  return Object.freeze([...required, ...transitive]);
}

export function buildPdePoisson2dCpuOracleWorkerImplementation({
  sourceRecords,
} = {}) {
  const records = canonicalSourceRecords(sourceRecords);
  const algorithmSourceHash = records.find(
    (record) => record.role === 'oracle-algorithm',
  ).sha256;
  const independentAlgorithmImplementationHash = hashRecord(
    'PdePoisson2dIndependentCpuAlgorithmImplementation',
    {
      version: 1,
      kind: 'PdePoisson2dIndependentCpuAlgorithmImplementation',
      algorithm: 'analytic-discrete-cpu-recomputation-v1',
      sourceHash: algorithmSourceHash,
    },
  );
  const sourceManifestHash = hashRecord(
    'PdePoisson2dCpuOracleWorkerSourceManifest',
    records,
  );
  const payload = {
    version: 2,
    kind: 'PdePoisson2dCpuOracleWorkerImplementation',
    assuranceScope: PDE_POISSON_2D_PROCESS_ISOLATED_CPU_ORACLE_ASSURANCE_SCOPE,
    sourceRecords: records,
    sourceManifestHash,
    independentAlgorithmImplementationHash,
  };
  return Object.freeze({
    ...payload,
    workerImplementationHash: hashRecord(
      'PdePoisson2dCpuOracleWorkerImplementation',
      payload,
    ),
  });
}

export function verifyPdePoisson2dCpuOracleWorkerImplementation(value) {
  if (!hasExactObjectKeys(value, IMPLEMENTATION_KEYS)) return false;
  try {
    return JSON.stringify(buildPdePoisson2dCpuOracleWorkerImplementation(value))
      === JSON.stringify(value);
  } catch { return false; }
}

function canonicalArtifactPayloads(value, artifactManifest) {
  if (!Array.isArray(value)
    || value.length !== artifactManifest.artifacts.length) {
    throw new Error('pde_poisson_2d_cpu_oracle_artifact_payloads_invalid');
  }
  return Object.freeze(artifactManifest.artifacts.map((artifact, index) => {
    const supplied = value[index];
    const encoded = String(supplied?.contentBase64 || '');
    let bytes = null;
    try { bytes = Buffer.from(encoded, 'base64'); } catch { bytes = null; }
    if (!hasExactObjectKeys(supplied, ARTIFACT_PAYLOAD_KEYS)
      || supplied.gridSize !== artifact.gridSize
      || supplied.bytes !== artifact.bytes
      || supplied.sha256 !== artifact.sha256
      || !bytes || bytes.length !== artifact.bytes
      || bytes.toString('base64') !== encoded
      || hashBytes(bytes) !== artifact.sha256) {
      throw new Error('pde_poisson_2d_cpu_oracle_artifact_payloads_invalid');
    }
    return Object.freeze({
      gridSize: artifact.gridSize,
      bytes: artifact.bytes,
      sha256: artifact.sha256,
      contentBase64: encoded,
    });
  }));
}

export function buildProcessIsolatedPdePoisson2dCpuOracleRequest({
  producerSpecification,
  artifactManifest,
  artifactPayloads,
  artifactReadReceiptHashes,
  workerImplementation,
  oracleRuntimeIdentityHash,
  resourceBudget,
} = {}) {
  if (!verifyPdePoisson2dGpuProducerSpecification(producerSpecification)
    || !verifyPdePoisson2dGpuArtifactManifest(artifactManifest, {
      producerSpecification,
    })
    || !verifyPdePoisson2dCpuOracleWorkerImplementation(workerImplementation)
    || !sha(oracleRuntimeIdentityHash)
    || !verifyPdePoisson2dCpuOracleResourceBudget(resourceBudget)
    || !Array.isArray(artifactReadReceiptHashes)
    || artifactReadReceiptHashes.length !== artifactManifest.artifacts.length
    || !artifactReadReceiptHashes.every(sha)) {
    throw new Error('pde_poisson_2d_cpu_oracle_request_invalid');
  }
  const payload = {
    version: 1,
    kind: 'ProcessIsolatedPdePoisson2dCpuOracleRequest',
    producerSpecification,
    artifactManifest,
    artifactPayloads: canonicalArtifactPayloads(
      artifactPayloads,
      artifactManifest,
    ),
    artifactReadReceiptHashes: Object.freeze(
      artifactReadReceiptHashes.map(sha),
    ),
    workerImplementationHash: workerImplementation.workerImplementationHash,
    oracleRuntimeIdentityHash: sha(oracleRuntimeIdentityHash),
    resourceBudget: Object.freeze({ ...resourceBudget }),
  };
  return Object.freeze({
    ...payload,
    requestHash: hashRecord('ProcessIsolatedPdePoisson2dCpuOracleRequest', payload),
  });
}

export function verifyProcessIsolatedPdePoisson2dCpuOracleRequest(value, {
  workerImplementation,
} = {}) {
  if (!hasExactObjectKeys(value, REQUEST_KEYS)) return false;
  try {
    return JSON.stringify(buildProcessIsolatedPdePoisson2dCpuOracleRequest({
      ...value,
      workerImplementation,
    })) === JSON.stringify(value);
  } catch { return false; }
}

export function buildPdePoisson2dCpuOracleWorkerReceipt({
  request,
  workerImplementation,
  oracleReceipt = null,
  workerPid,
  parentPid,
  networkActionPerformed = false,
  externalActionPerformed = false,
  blockers = [],
} = {}) {
  const verifiedRequest = verifyProcessIsolatedPdePoisson2dCpuOracleRequest(
    request,
    { workerImplementation },
  );
  const verifiedOracle = verifiedRequest
    && oracleReceipt
    && verifyPdePoisson2dIndependentCpuOracleReceipt(oracleReceipt, {
      producerSpecification: request.producerSpecification,
      artifactManifest: request.artifactManifest,
    })
    && oracleReceipt.oracleImplementationHash
      === workerImplementation.independentAlgorithmImplementationHash
    && oracleReceipt.oracleRuntimeIdentityHash
      === request.oracleRuntimeIdentityHash
    && oracleReceipt.status === 'pde_poisson_2d_independent_cpu_oracle_verified'
    && oracleReceipt.scientificChecksPassed === true
    && Array.isArray(oracleReceipt.blockers)
    && oracleReceipt.blockers.length === 0;
  const processValid = Number.isSafeInteger(workerPid) && workerPid > 0
    && Number.isSafeInteger(parentPid) && parentPid >= 0 && workerPid !== parentPid;
  const selectedBlockers = uniqueSorted([
    ...blockers,
    ...(verifiedRequest ? [] : ['pde_cpu_oracle_worker_request_invalid']),
    ...(verifiedOracle ? [] : ['pde_cpu_oracle_worker_scientific_receipt_invalid']),
    ...(processValid ? [] : ['pde_cpu_oracle_worker_process_identity_invalid']),
    ...(networkActionPerformed ? ['pde_cpu_oracle_worker_network_action_forbidden'] : []),
    ...(externalActionPerformed ? ['pde_cpu_oracle_worker_external_action_forbidden'] : []),
  ]);
  const verified = selectedBlockers.length === 0;
  const payload = {
    version: 1,
    kind: 'PdePoisson2dCpuOracleWorkerReceipt',
    status: verified
      ? 'pde_poisson_2d_cpu_oracle_worker_verified'
      : 'pde_poisson_2d_cpu_oracle_worker_blocked',
    assuranceScope: PDE_POISSON_2D_PROCESS_ISOLATED_CPU_ORACLE_ASSURANCE_SCOPE,
    requestHash: request?.requestHash || null,
    producerSpecificationHash:
      request?.producerSpecification?.pdePoisson2dGpuProducerSpecificationHash || null,
    artifactManifestHash:
      request?.artifactManifest?.pdePoisson2dGpuArtifactManifestHash || null,
    oracleReceipt: verified ? oracleReceipt : null,
    oracleReceiptHash: verified
      ? oracleReceipt.pdePoisson2dIndependentCpuOracleReceiptHash : null,
    workerImplementationHash: workerImplementation?.workerImplementationHash || null,
    workerSourceManifestHash: workerImplementation?.sourceManifestHash || null,
    independentAlgorithmImplementationHash:
      workerImplementation?.independentAlgorithmImplementationHash || null,
    workerPid: processValid ? workerPid : null,
    parentPid: processValid ? parentPid : null,
    processIndependent: verified,
    networkActionPerformed: networkActionPerformed === true,
    externalActionPerformed: externalActionPerformed === true,
    blockers: selectedBlockers,
  };
  return Object.freeze({
    ...payload,
    workerReceiptHash: hashRecord('PdePoisson2dCpuOracleWorkerReceipt', payload),
  });
}

export function verifyPdePoisson2dCpuOracleWorkerReceipt(value, {
  request,
  workerImplementation,
} = {}) {
  if (!hasExactObjectKeys(value, WORKER_RECEIPT_KEYS)
    || value.status !== 'pde_poisson_2d_cpu_oracle_worker_verified') return false;
  try {
    return JSON.stringify(buildPdePoisson2dCpuOracleWorkerReceipt({
      request,
      workerImplementation,
      oracleReceipt: value.oracleReceipt,
      workerPid: value.workerPid,
      parentPid: value.parentPid,
    })) === JSON.stringify(value);
  } catch { return false; }
}

function processAndRuntimeBlockers({
  request,
  workerImplementation,
  workerReceipt,
} = {}) {
  return verifyPdePoisson2dCpuOracleWorkerReceipt(workerReceipt, {
    request,
    workerImplementation,
  }) ? [] : ['pde_cpu_oracle_worker_receipt_invalid'];
}

export function buildProcessIsolatedPdePoisson2dCpuOracleAssurance({
  request,
  workerImplementation,
  workerReceipt,
  osSandboxWorkerReceipt,
  absoluteDeadlineEpochMs,
  blockers = [],
} = {}) {
  const requestVerified = verifyProcessIsolatedPdePoisson2dCpuOracleRequest(
    request,
    { workerImplementation },
  );
  let runtimeAttestation = null;
  if (requestVerified) {
    try {
      runtimeAttestation = buildPdePoisson2dCpuOracleRuntimeAttestation({
        assuranceScope: PDE_POISSON_2D_PROCESS_ISOLATED_CPU_ORACLE_ASSURANCE_SCOPE,
        request,
        workerImplementation,
        workerReceipt,
        osSandboxWorkerReceipt,
      });
    } catch { /* represented by the blocker below */ }
  }
  const selectedBlockers = uniqueSorted([
    ...blockers,
    ...(!Number.isSafeInteger(absoluteDeadlineEpochMs)
      || absoluteDeadlineEpochMs < 1
      ? ['pde_cpu_oracle_absolute_deadline_invalid'] : []),
    ...(!requestVerified ? ['pde_cpu_oracle_request_invalid'] : []),
    ...(!runtimeAttestation ? ['pde_cpu_oracle_runtime_attestation_invalid'] : []),
    ...processAndRuntimeBlockers({
      request,
      workerImplementation,
      workerReceipt,
    }),
  ]);
  const verified = selectedBlockers.length === 0;
  const oracleReceipt = verified ? workerReceipt.oracleReceipt : null;
  const payload = {
    version: 2,
    kind: 'ProcessIsolatedPdePoisson2dCpuOracleAssurance',
    status: verified
      ? 'process_isolated_pde_poisson_2d_cpu_oracle_verified'
      : 'process_isolated_pde_poisson_2d_cpu_oracle_blocked',
    assuranceScope: PDE_POISSON_2D_PROCESS_ISOLATED_CPU_ORACLE_ASSURANCE_SCOPE,
    absoluteDeadlineEpochMs: Number.isSafeInteger(absoluteDeadlineEpochMs)
      ? absoluteDeadlineEpochMs : null,
    request: verified ? request : null,
    requestHash: request?.requestHash || null,
    producerSpecificationHash:
      request?.producerSpecification?.pdePoisson2dGpuProducerSpecificationHash || null,
    artifactManifestHash:
      request?.artifactManifest?.pdePoisson2dGpuArtifactManifestHash || null,
    oracleReceipt,
    oracleReceiptHash: oracleReceipt
      ?.pdePoisson2dIndependentCpuOracleReceiptHash || null,
    oracleRuntimeIdentityHash: request?.oracleRuntimeIdentityHash || null,
    workerImplementation,
    workerImplementationHash: workerImplementation?.workerImplementationHash || null,
    workerSourceManifestHash: workerImplementation?.sourceManifestHash || null,
    independentAlgorithmImplementationHash:
      workerImplementation?.independentAlgorithmImplementationHash || null,
    workerReceipt: verified ? workerReceipt : null,
    workerReceiptHash: verified ? workerReceipt.workerReceiptHash : null,
    processIndependent: verified,
    osSandboxBackend: osSandboxWorkerReceipt?.backend || null,
    osSandboxWorkerReceiptHash: osSandboxWorkerReceipt?.receiptHash || null,
    osSandboxEnvironmentBomHash:
      osSandboxWorkerReceipt?.environmentBomHash || null,
    osSandboxWorkerReceipt,
    runtimeImageDigest:
      osSandboxWorkerReceipt?.containerImageDigest || null,
    runtimePackageClosureHash:
      osSandboxWorkerReceipt?.environmentBom?.runtime?.packageClosure?.identityHash || null,
    runtimeAttestation: verified ? runtimeAttestation : null,
    runtimeAttestationHash: verified
      ? runtimeAttestation.pdePoisson2dCpuOracleRuntimeAttestationHash : null,
    resourceBudget: request?.resourceBudget || null,
    producerDiagnosticsUsed: false,
    networkActionPerformed: false,
    externalActionPerformed: false,
    scientificAuthority: verified
      ? 'process-isolated-independent-cpu-recomputation-v1' : 'none-blocked-v1',
    productionQualified: verified,
    promotionEligible: false,
    productionBlockers: Object.freeze([
      'pde_poisson_2d_gpu_producer_qualification_required',
    ]),
    blockers: selectedBlockers,
  };
  return Object.freeze({
    ...payload,
    pdePoisson2dProcessIsolatedCpuOracleAssuranceHash: hashRecord(
      'ProcessIsolatedPdePoisson2dCpuOracleAssurance',
      payload,
    ),
  });
}

export function verifyProcessIsolatedPdePoisson2dCpuOracleAssurance(value, {
  request = value?.request,
  workerImplementation = value?.workerImplementation,
} = {}) {
  if (!hasExactObjectKeys(value, ASSURANCE_KEYS)
    || value.version !== 2
    || value.status !== 'process_isolated_pde_poisson_2d_cpu_oracle_verified') {
    return false;
  }
  try {
    return verifyPdePoisson2dCpuOracleRuntimeAttestation(
      value.runtimeAttestation,
      {
        assuranceScope: value.assuranceScope,
        request,
        workerImplementation,
        workerReceipt: value.workerReceipt,
        osSandboxWorkerReceipt: value.osSandboxWorkerReceipt,
      },
    )
      && value.runtimeAttestationHash
        === value.runtimeAttestation.pdePoisson2dCpuOracleRuntimeAttestationHash
      && JSON.stringify(buildProcessIsolatedPdePoisson2dCpuOracleAssurance({
      request,
      workerImplementation,
      workerReceipt: value.workerReceipt,
      osSandboxWorkerReceipt: value.osSandboxWorkerReceipt,
      absoluteDeadlineEpochMs: value.absoluteDeadlineEpochMs,
      })) === JSON.stringify(value);
  } catch { return false; }
}
