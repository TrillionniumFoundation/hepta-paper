const SHA256 = /^sha256:[0-9a-f]{64}$/;

export const SYSTEM_DATASET_ACCESS_SUPERVISOR = Object.freeze({
  version: 1,
  protocol: 'hepta-container-dataset-supervisor-v1',
  path: '/usr/local/libexec/hepta-dataset-access-supervisor',
  sha256: 'sha256:a62b96c00d1989398f2f94df878b0983e98f8db472f29a3c6db9a4c3ccfe0de0',
  workloadUid: 65532,
});

export const SYSTEM_DATASET_ACCESS_RUNTIME_IMAGES = Object.freeze({
  python: Object.freeze({
    image: 'hepta/python-scientific:0.14.0',
    imageDigest: 'sha256:fcf1705c74de423957db8431b88814bbf2810fed04dbd8685329008ac43446cf',
    containerExecutable: 'python3',
    tracerSha256: 'sha256:aebaf212ce84a12208c5fa25f08c892029e6f6949b778da55e071ac145404a1e',
    setprivSha256: 'sha256:548074b1fad78aa213a5da4516accb9f886016e9401f8bfc04e3c569045d853b',
  }),
  pythonGpu: Object.freeze({
    image: 'hepta/python-gpu:0.14.0',
    imageDigest: 'sha256:a19945393646e79504b71e32833aa767216f4b1d013aa97930c00fd19cdcef57',
    containerExecutable: 'python',
    tracerSha256: 'sha256:aebaf212ce84a12208c5fa25f08c892029e6f6949b778da55e071ac145404a1e',
    setprivSha256: 'sha256:548074b1fad78aa213a5da4516accb9f886016e9401f8bfc04e3c569045d853b',
  }),
  r: Object.freeze({
    image: 'hepta/r-scientific:0.14.0',
    imageDigest: 'sha256:5216785588a8b78476b62ec26488232c248ecd58b2ac3bdff58ffa4cdac2f6cd',
    containerExecutable: 'Rscript',
    tracerSha256: 'sha256:28f957c227012de0b18d1bd7fff2d396cb693ea60ed8013be68de071e84b5001',
    setprivSha256: 'sha256:96b083b79c32fd2f0c29657e88e20c7495839349fc64ad5d0503f32d26bf8733',
  }),
});

export function trustedSystemDatasetAccessRuntimeImageByDigest(imageDigest) {
  if (!SHA256.test(String(imageDigest || ''))) return null;
  return Object.values(SYSTEM_DATASET_ACCESS_RUNTIME_IMAGES)
    .find((candidate) => candidate.imageDigest === imageDigest) || null;
}

export function verifySystemDatasetAccessSupervisorEvidence({ containerImageDigest, supervisor } = {}) {
  const image = trustedSystemDatasetAccessRuntimeImageByDigest(containerImageDigest);
  return Boolean(image
    && supervisor?.protocol === SYSTEM_DATASET_ACCESS_SUPERVISOR.protocol
    && supervisor?.path === SYSTEM_DATASET_ACCESS_SUPERVISOR.path
    && supervisor?.supervisorSha256 === SYSTEM_DATASET_ACCESS_SUPERVISOR.sha256
    && supervisor?.tracerSha256 === image.tracerSha256
    && supervisor?.setprivSha256 === image.setprivSha256
    && supervisor?.workloadUid === SYSTEM_DATASET_ACCESS_SUPERVISOR.workloadUid);
}
