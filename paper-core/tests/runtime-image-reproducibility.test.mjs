import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  AUTOMATION_RUNTIME_IMAGE_BUILD_DEFINITIONS,
  AUTOMATION_RUNTIME_IMAGES,
  R_RUNTIME_SOURCE_CAS,
  RUNTIME_IMAGE_BUILD_REPRODUCIBILITY,
  runtimeCapabilityForCampaign,
  runtimeImagesForCampaign,
} from '../../paper-adapters/automation/runtime-image-registry.mjs';
import {
  verifyDockerRuntimeImageBitwiseRebuild,
} from '../../paper-adapters/automation/docker-runtime-image-bitwise-rebuild-verifier.mjs';
import {
  buildRuntimeImageBitwiseRebuildEvidence,
  buildRuntimeImageReproducibilityAssessment,
  verifyRuntimeImageBitwiseRebuildEvidence,
  verifyRuntimeImageReproducibilityAssessment,
} from '../../paper-domain/automation/runtime-build-reproducibility-contract.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const definitions = Object.freeze({
  python: [
    'runtime-images/python-scientific/Dockerfile',
    'runtime-images/python-scientific/requirements.lock',
    'runtime-images/python-scientific/hepta-dataset-access-supervisor',
  ],
  pythonGpu: [
    'runtime-images/python-gpu/Dockerfile',
    'runtime-images/python-gpu/requirements.lock',
    'runtime-images/python-gpu/scientific-requirements.lock',
    'runtime-images/python-gpu/hepta-dataset-access-supervisor',
  ],
  r: AUTOMATION_RUNTIME_IMAGE_BUILD_DEFINITIONS.r.definitionPaths
    .map((entry) => `runtime-images/r-scientific/${entry}`),
});

function definitionHash(paths) {
  const records = paths.map((path) => ({
    path,
    sha256: `sha256:${crypto.createHash('sha256').update(fs.readFileSync(path)).digest('hex')}`,
  }));
  return hashRecord('RuntimeImageBuildDefinitionManifest', records);
}

const H = (value) => `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;

function setFixtureTreeModes(root, { directoryMode, fileMode }) {
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      assert.equal(entry.isSymbolicLink(), false);
      const selected = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(selected);
      else fs.chmodSync(selected, fileMode);
    }
    fs.chmodSync(current, directoryMode);
  }
}

test('self-authored dual-build hashes remain an untrusted rootfs diagnostic', () => {
  const imageDigest = H('same-image');
  const definitionManifestHash = H('definition');
  const base = {
    buildInputClosureHash: definitionManifestHash,
    cacheDisabled: true,
    imageDigest,
    rootfsChainHash: H('same-rootfs'),
  };
  const evidence = buildRuntimeImageBitwiseRebuildEvidence({
    image: 'hepta/fixture:1',
    definitionManifestHash,
    firstBuild: {
      ...base,
      invocationId: 'build:first',
      isolatedBuildRootIdentityHash: H('root:first'),
    },
    secondBuild: {
      ...base,
      invocationId: 'build:second',
      isolatedBuildRootIdentityHash: H('root:second'),
    },
    observedAt: '2026-07-16T08:00:00.000Z',
  });
  assert.equal(evidence.status, 'local_rootfs_repeatability_observed_untrusted');
  assert.equal(verifyRuntimeImageBitwiseRebuildEvidence(evidence), false);
  const assessment = buildRuntimeImageReproducibilityAssessment({
    image: evidence.image,
    imageDigest,
    definitionManifestHash,
    baseImageDigestPinned: true,
    osPackageSnapshotPinned: true,
    dependencyVersionsPinned: true,
    dependencyArtifactsContentHashed: true,
    sourceArchivesContentHashed: true,
    bitwiseRebuildEvidence: evidence,
  });
  assert.equal(assessment.bitwiseRebuildVerified, false);
  assert.equal(assessment.bitwiseRebuildEvidenceHash, null);
  assert.equal(verifyRuntimeImageReproducibilityAssessment(assessment), true);

  const aliasedRoot = buildRuntimeImageBitwiseRebuildEvidence({
    image: evidence.image,
    definitionManifestHash,
    firstBuild: evidence.builds[0],
    secondBuild: { ...evidence.builds[1], isolatedBuildRootIdentityHash: evidence.builds[0].isolatedBuildRootIdentityHash },
    observedAt: evidence.observedAt,
  });
  assert.equal(aliasedRoot.status, 'local_rootfs_repeatability_not_observed');
  assert.ok(aliasedRoot.blockers.includes('runtime_rebuild_roots_not_isolated'));
  const digestMismatch = buildRuntimeImageBitwiseRebuildEvidence({
    image: evidence.image,
    definitionManifestHash,
    firstBuild: evidence.builds[0],
    secondBuild: { ...evidence.builds[1], imageDigest: H('different-image') },
    observedAt: evidence.observedAt,
  });
  assert.ok(digestMismatch.blockers.includes('runtime_rebuild_image_digest_mismatch'));
  const forged = structuredClone(evidence);
  forged.builds[1].cacheDisabled = false;
  assert.equal(verifyRuntimeImageBitwiseRebuildEvidence(forged), false);
});

test('local Docker verifier performs a non-authoritative rootfs repeatability diagnostic', (t) => {
  const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hepta-sealed-runtime-source-'));
  const sealedContext = path.join(repositoryRoot, 'runtime-images', 'python-scientific');
  fs.mkdirSync(path.dirname(sealedContext), { recursive: true });
  fs.cpSync(path.resolve('runtime-images/python-scientific'), sealedContext, { recursive: true });
  setFixtureTreeModes(sealedContext, { directoryMode: 0o555, fileMode: 0o444 });
  t.after(() => {
    setFixtureTreeModes(sealedContext, { directoryMode: 0o700, fileMode: 0o444 });
    fs.rmSync(repositoryRoot, { recursive: true, force: true });
  });
  const commands = [];
  let inspectionCount = 0;
  const imageDigest = H('docker-image');
  const rootfsLayer = H('docker-rootfs-layer');
  const spawnSyncImpl = (_executable, args) => {
    commands.push(args);
    if (args[0] === 'image' && args[1] === 'inspect') {
      inspectionCount += 1;
      return {
        status: 0,
        stdout: JSON.stringify([{
          Id: imageDigest,
          RootFS: { Type: 'layers', Layers: [rootfsLayer] },
        }]),
        stderr: '',
      };
    }
    return { status: 0, stdout: '', stderr: '' };
  };
  let nonce = 0;
  const evidence = verifyDockerRuntimeImageBitwiseRebuild({
    image: 'hepta/python-scientific:fixture',
    contextPath: 'runtime-images/python-scientific',
    definitionPaths: ['Dockerfile', 'requirements.lock', 'hepta-dataset-access-supervisor'],
    definitionManifestHash: RUNTIME_IMAGE_BUILD_REPRODUCIBILITY.python.definitionManifestHash,
    repositoryRoot,
    spawnSyncImpl,
    randomUUID: () => `fixture-${++nonce}`,
    clock: () => new Date('2026-07-16T08:00:00.000Z'),
  });
  assert.equal(evidence.status, 'local_rootfs_repeatability_observed_untrusted');
  assert.ok(evidence.blockers.includes('external_ed25519_verifier_attestation_required'));
  assert.equal(inspectionCount, 2);
  const builds = commands.filter((args) => args[0] === 'build');
  assert.equal(builds.length, 2);
  assert.equal(builds.every((args) => args.includes('--no-cache') && args.includes('--pull=false')), true);
  assert.notEqual(builds[0].at(-1), builds[1].at(-1));
  assert.equal(builds.every((args) => !fs.existsSync(path.dirname(args.at(-1)))), true);
  assert.equal(commands.filter((args) => args[0] === 'image' && args[1] === 'rm').length, 2);

  let mismatchInspection = 0;
  nonce = 0;
  const mismatch = verifyDockerRuntimeImageBitwiseRebuild({
    image: 'hepta/python-scientific:fixture',
    contextPath: 'runtime-images/python-scientific',
    definitionPaths: ['Dockerfile', 'requirements.lock', 'hepta-dataset-access-supervisor'],
    definitionManifestHash: RUNTIME_IMAGE_BUILD_REPRODUCIBILITY.python.definitionManifestHash,
    repositoryRoot,
    spawnSyncImpl: (_executable, args) => {
      if (args[0] === 'image' && args[1] === 'inspect') {
        mismatchInspection += 1;
        return {
          status: 0,
          stdout: JSON.stringify([{
            Id: mismatchInspection === 1 ? imageDigest : H('different-docker-image'),
            RootFS: { Type: 'layers', Layers: [rootfsLayer] },
          }]),
          stderr: '',
        };
      }
      return { status: 0, stdout: '', stderr: '' };
    },
    randomUUID: () => `mismatch-${++nonce}`,
    clock: () => new Date('2026-07-16T08:00:00.000Z'),
  });
  assert.equal(mismatch.status, 'local_rootfs_repeatability_not_observed');
  assert.ok(mismatch.blockers.includes('runtime_rebuild_image_digest_mismatch'));
});

test('a matching local Docker digest cannot make a build assessment production-bitwise-ready', () => {
  const assessment = buildRuntimeImageReproducibilityAssessment({
    image: AUTOMATION_RUNTIME_IMAGES.python.image,
    imageDigest: AUTOMATION_RUNTIME_IMAGES.python.imageDigest,
    definitionManifestHash: RUNTIME_IMAGE_BUILD_REPRODUCIBILITY.python.definitionManifestHash,
    baseImageDigestPinned: true,
    osPackageSnapshotPinned: true,
    dependencyVersionsPinned: true,
    dependencyArtifactsContentHashed: true,
    sourceArchivesContentHashed: true,
    bitwiseRebuildEvidence: { status: 'bitwise_rebuild_verified' },
  });
  assert.equal(assessment.bitwiseRebuildVerified, false);
  assert.ok(assessment.blockers.includes('bitwise_rebuild_not_verified'));
});

test('runtime build assessments bind current definitions and only claim verified source closure properties', () => {
  for (const [name, assessment] of Object.entries(RUNTIME_IMAGE_BUILD_REPRODUCIBILITY)) {
    assert.equal(verifyRuntimeImageReproducibilityAssessment(assessment), true, name);
    assert.equal(assessment.definitionManifestHash, definitionHash(definitions[name]), name);
    assert.equal(assessment.runtimeContentIdentityPinned, true, name);
    assert.equal(assessment.bitwiseRebuildVerified, false, name);
    assert.equal(assessment.status, 'runtime_content_identity_pinned_rebuild_not_verified', name);
    assert.ok(assessment.blockers.includes('bitwise_rebuild_not_verified'), name);
  }
  for (const name of ['python', 'pythonGpu', 'r']) {
    const assessment = RUNTIME_IMAGE_BUILD_REPRODUCIBILITY[name];
    assert.equal(assessment.osPackageSnapshotPinned, true, name);
    assert.equal(assessment.dependencyVersionsPinned, true, name);
    assert.equal(assessment.dependencyArtifactsContentHashed, true, name);
    assert.equal(assessment.sourceArchivesContentHashed, true, name);
    assert.deepEqual(assessment.blockers, ['bitwise_rebuild_not_verified'], name);
  }
  assert.equal(RUNTIME_IMAGE_BUILD_REPRODUCIBILITY.r.osPackageSnapshotPinned, true);
  assert.equal(R_RUNTIME_SOURCE_CAS.ready, true, JSON.stringify(R_RUNTIME_SOURCE_CAS.blockers));
  assert.equal(R_RUNTIME_SOURCE_CAS.packageCount, 104);
  assert.deepEqual(RUNTIME_IMAGE_BUILD_REPRODUCIBILITY.r.blockers, ['bitwise_rebuild_not_verified']);
});

test('Python images require a complete hashed wheel closure and immutable OS snapshots', () => {
  const cpuDockerfile = fs.readFileSync('runtime-images/python-scientific/Dockerfile', 'utf8');
  const gpuDockerfile = fs.readFileSync('runtime-images/python-gpu/Dockerfile', 'utf8');
  const cpuLock = fs.readFileSync('runtime-images/python-scientific/requirements.lock', 'utf8');
  const gpuScientificLock = fs.readFileSync(
    'runtime-images/python-gpu/scientific-requirements.lock',
    'utf8',
  );
  const gpuLock = fs.readFileSync('runtime-images/python-gpu/requirements.lock', 'utf8');
  const cpuSupervisor = fs.readFileSync(
    'runtime-images/python-scientific/hepta-dataset-access-supervisor',
  );
  const gpuSupervisor = fs.readFileSync(
    'runtime-images/python-gpu/hepta-dataset-access-supervisor',
  );
  assert.equal(gpuScientificLock, cpuLock);
  assert.equal(gpuSupervisor.equals(cpuSupervisor), true);
  for (const dockerfile of [cpuDockerfile, gpuDockerfile]) {
    assert.match(dockerfile, /^# syntax=docker\/dockerfile:1\.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e$/m);
    assert.match(dockerfile, /^FROM python:3\.12\.7-slim-bookworm@sha256:60d9996b6a8a3689d36db740b49f4327be3be09a21122bd02fb8895abb38b50d$/m);
    assert.match(dockerfile, /snapshot\.debian\.org\/archive\/debian\/20241202T000000Z/);
    assert.match(dockerfile, /ARG TARGETPLATFORM/);
    assert.match(dockerfile, /ARG SOURCE_DATE_EPOCH=1733097600/);
    assert.match(dockerfile, /test "\$TARGETPLATFORM" = "linux\/amd64"/);
    assert.match(dockerfile, /test "\$SOURCE_DATE_EPOCH" = "1733097600"/);
    assert.match(dockerfile, /strace=6\.1-0\.1/);
    assert.match(dockerfile, /--only-binary=:all:/);
    assert.match(dockerfile, /--require-hashes/);
    assert.match(dockerfile, /\/var\/log\/dpkg\.log/);
    assert.match(dockerfile, /\/var\/cache\/ldconfig\/aux-cache/);
  }
  for (const [name, lock] of [
    ['python', cpuLock],
    ['pythonGpuScientific', gpuScientificLock],
    ['pythonGpu', gpuLock],
  ]) {
    const requirements = lock.split('\n').filter((line) => /^[a-zA-Z0-9_-]+==/.test(line));
    assert.ok(requirements.length > 0, name);
    assert.equal(requirements.every((line) => line.includes('==') && line.endsWith(' \\')), true, name);
    assert.equal((lock.match(/--hash=sha256:[0-9a-f]{64}/g) || []).length >= requirements.length, true, name);
  }
});

test('R system packages use an immutable Ubuntu snapshot and exact requested versions', () => {
  const dockerfile = fs.readFileSync('runtime-images/r-scientific/Dockerfile', 'utf8');
  const restore = fs.readFileSync('runtime-images/r-scientific/restore-locked.R', 'utf8');
  assert.equal(AUTOMATION_RUNTIME_IMAGES.r.imageDigest,
    'sha256:5216785588a8b78476b62ec26488232c248ecd58b2ac3bdff58ffa4cdac2f6cd');
  assert.match(dockerfile, /snapshot\.ubuntu\.com\/ubuntu\/20260715T000000Z/);
  assert.match(dockerfile, /COPY source-cas \/opt\/hepta-r-source-cas/);
  assert.match(dockerfile, /RUN --network=none Rscript \/tmp\/restore-locked\.R/);
  assert.match(dockerfile, /sh \/tmp\/normalize-installed\.sh/);
  const normalization = fs.readFileSync(
    'runtime-images/r-scientific/normalize-installed.sh',
    'utf8',
  );
  for (const binding of [
    /RENV_CONFIG_INSTALL_KEEP_SOURCE\s*=\s*"FALSE"/,
    /RENV_CONFIG_INSTALL_STAGED\s*=\s*"FALSE"/,
    /RENV_CONFIG_INSTALL_TRANSACTIONAL\s*=\s*"FALSE"/,
    /RENV_CONFIG_INSTALL_JOBS\s*=\s*"1"/,
    /"--no-staged-install"/,
    /"--without-keep\.source"/,
    /"--without-keep\.parse\.data"/,
    /"--no-byte-compile"/,
    /"--no-help"/,
    /"--built-timestamp=1733097600"/,
    /vctrs_0\.7\.3\.tar\.gz/,
    /vctrs_build_root <- "\/opt\/hepta-r-deterministic-build"/,
    /description\[\[keep_source\]\] <- "KeepSource: false"/,
    /!dir\.exists\(vctrs_build_root\)/,
  ]) assert.match(restore, binding);
  assert.match(normalization, /strip --strip-debug/);
  assert.match(normalization, /objcopy --remove-section=\.note\.gnu\.build-id/);
  assert.match(normalization, /find "\$library" -type f -exec sh -c/);
  assert.doesNotMatch(normalization, /-name '\*\.so'/);
  assert.match(normalization, /readelf -S "\$candidate"/);
  assert.match(normalization, /\.note\.gnu\.build-id/);
  assert.match(normalization, /\/tmp\/Rtmp\|\/tmp\/renv\|00LOCK/);
  assert.match(normalization, /touch -h -d "@\$SOURCE_DATE_EPOCH"/);
  const verification = fs.readFileSync('runtime-images/r-scientific/verify-locked.R', 'utf8');
  assert.match(verification,
    /base::package_version\(observed\) == base::package_version\(expected\)/);
  assert.match(verification, /identical\(metadata\$Built\$Date, fixed_built_date\)/);
  assert.match(verification, /metadata\$DESCRIPTION\[\["Built"\]\]/);
  assert.match(verification, /!dir\.exists\(file\.path\(package_root, "help"\)\)/);
  assert.match(verification,
    /source_metadata_names <- c\("srcref", "srcfile", "wholeSrcref", "parseData"\)/);
  assert.match(verification, /assert_no_source_metadata <- function\(value, location\)/);
  assert.match(verification, /assert_no_source_metadata\(attrs\[\[name\]\],/);
  assert.match(verification, /assert_no_source_metadata\(value\[\[index\]\],/);
  assert.match(verification, /is\.null\(utils::getSrcref\(value\)\)/);
  const rSourceManifest = JSON.parse(fs.readFileSync(
    'runtime-images/r-scientific/source-cas/manifest.json',
    'utf8',
  ));
  const hyphenatedVersion = rSourceManifest.packages.find(
    (entry) => entry.package === 'base64enc',
  );
  assert.equal(hyphenatedVersion.version, '0.1-6');
  assert.equal(hyphenatedVersion.file, 'base64enc_0.1-6.tar.gz');
  for (const pin of [
    'strace=6.8-0ubuntu2',
    'libcurl4-openssl-dev=8.5.0-2ubuntu10.11',
    'libssl-dev=3.0.13-0ubuntu3.11',
    'libxml2-dev=2.9.14+dfsg-1.3ubuntu3.8',
    'libpcre2-dev=10.42-4ubuntu2.1',
    'libicu-dev=74.2-1ubuntu3.1',
  ]) assert.ok(dockerfile.includes(pin), pin);
});

test('GPU image is self-contained on a public immutable base and registry binds the rebuilt OCI manifest digest', () => {
  const dockerfile = fs.readFileSync('runtime-images/python-gpu/Dockerfile', 'utf8');
  assert.match(dockerfile, /^FROM python:3\.12\.7-slim-bookworm@sha256:60d9996b6a8a3689d36db740b49f4327be3be09a21122bd02fb8895abb38b50d$/m);
  assert.doesNotMatch(dockerfile, /^FROM hepta\//m);
  assert.equal(AUTOMATION_RUNTIME_IMAGES.pythonGpu.image, 'hepta/python-gpu:0.15.0');
  assert.equal(AUTOMATION_RUNTIME_IMAGES.pythonGpu.imageDigest, 'sha256:21acb5fb016d9fd17131215d16e1834fcfeb081e047718d49b6d58d8afa97e2b');
  assert.deepEqual(AUTOMATION_RUNTIME_IMAGE_BUILD_DEFINITIONS.pythonGpu.definitionPaths, [
    'Dockerfile',
    'requirements.lock',
    'scientific-requirements.lock',
    'hepta-dataset-access-supervisor',
  ]);
  const packageDocument = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  assert.match(packageDocument.scripts['automation:runtime-build'],
    /automation:runtime-bootstrap:python -- --profile python --build/);
  assert.match(packageDocument.scripts['automation:runtime-build'],
    /automation:runtime-bootstrap:python -- --profile pythonGpu --build/);
  assert.match(packageDocument.scripts['automation:runtime-build'], /npm run automation:runtime-bootstrap:r -- --build/);
  assert.doesNotMatch(packageDocument.scripts['automation:runtime-build'],
    /docker build -t hepta\/python/);
  assert.doesNotMatch(packageDocument.scripts['automation:runtime-build'],
    /docker build -t hepta\/r-scientific/);
  assert.equal(packageDocument.scripts['automation:runtime-bootstrap:python'],
    'node paper-core/bin/automation-python-runtime-bootstrap.mjs');
  assert.equal(packageDocument.scripts['automation:runtime-bootstrap:r'],
    'node paper-core/bin/automation-r-runtime-bootstrap.mjs');
  assert.doesNotMatch(packageDocument.scripts['automation:runtime-build'], /python-gpu:0\.13\.0/);
});

test('GPU and trusted-dataset capabilities are independent and compose into the supervised GPU image', () => {
  const capability = runtimeCapabilityForCampaign({ gpu: true, requireTrustedDatasetAccess: true });
  assert.deepEqual(capability.matrix, {
    cpu: true,
    gpu: true,
    trustedDataset: true,
    gpuTrustedDataset: true,
  });
  assert.equal(capability.requestedCapability, 'gpuTrustedDataset');
  assert.equal(capability.ready, true);
  assert.deepEqual(capability.blockers, []);
  const images = runtimeImagesForCampaign({ gpu: true, requireTrustedDatasetAccess: true });
  assert.equal(images.python.image, AUTOMATION_RUNTIME_IMAGES.pythonGpu.image);
  assert.deepEqual(images.python.datasetAccessSupervisor, AUTOMATION_RUNTIME_IMAGES.python.datasetAccessSupervisor);
});
