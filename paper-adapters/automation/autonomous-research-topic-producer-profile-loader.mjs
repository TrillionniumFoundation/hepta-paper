import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  inspectStrictDatasetManifest,
} from '../runtime/execution-snapshot.mjs';
import {
  verifyAutonomousResearchTopicProducerProfile,
} from '../../paper-domain/automation/autonomous-research-topic-producer-contract.mjs';

const MAXIMUM_FILE_BYTES = 1024 * 1024;
const IMPLEMENTATION_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'autonomous-research-topic-producer-implementation.mjs',
);

function secureDocument(candidate) {
  const absolute = path.resolve(String(candidate || ''));
  let stat;
  try { stat = fs.lstatSync(absolute); }
  catch { throw new Error('autonomous_research_topic_producer_profile_file_invalid'); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2
    || stat.size > MAXIMUM_FILE_BYTES || (stat.mode & 0o022) !== 0) {
    throw new Error('autonomous_research_topic_producer_profile_file_invalid');
  }
  let document;
  try { document = JSON.parse(fs.readFileSync(absolute, 'utf8')); }
  catch { throw new Error('autonomous_research_topic_producer_profile_json_invalid'); }
  return Object.freeze({ absolute, document });
}

function inspectDatasetSources(producerProfile, datasetRoot) {
  if (!path.isAbsolute(String(datasetRoot || ''))) {
    throw new Error('autonomous_research_topic_producer_dataset_root_required');
  }
  const resolvedRoot = path.resolve(datasetRoot);
  let rootStat;
  let realRoot;
  try {
    rootStat = fs.lstatSync(resolvedRoot);
    realRoot = fs.realpathSync(resolvedRoot);
  } catch { throw new Error('autonomous_research_topic_producer_dataset_root_invalid'); }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || realRoot !== resolvedRoot) {
    throw new Error('autonomous_research_topic_producer_dataset_root_invalid');
  }
  const mounts = [];
  for (const profile of producerProfile.registeredResearchProfiles) {
    for (const mount of profile.datasetMounts) {
      if (!path.isAbsolute(mount.source)) {
        throw new Error('autonomous_research_topic_producer_dataset_source_invalid');
      }
      let stat;
      let realSource;
      const resolvedSource = path.resolve(mount.source);
      try {
        stat = fs.lstatSync(resolvedSource);
        realSource = fs.realpathSync(resolvedSource);
      }
      catch { throw new Error('autonomous_research_topic_producer_dataset_source_invalid'); }
      if (stat.isSymbolicLink() || realSource !== resolvedSource
        || !realSource.startsWith(`${realRoot}${path.sep}`)
        || (!stat.isFile() && !stat.isDirectory())) {
        throw new Error('autonomous_research_topic_producer_dataset_source_invalid');
      }
      const manifest = inspectStrictDatasetManifest(realSource, realRoot);
      if (manifest.blockers.length || manifest.hash !== mount.manifestHash) {
        throw new Error(
          'autonomous_research_topic_producer_dataset_manifest_invalid_or_mismatched',
        );
      }
      mounts.push(Object.freeze({
        profileId: profile.profileId,
        name: mount.name,
        source: realSource,
        sourceType: manifest.sourceType,
        declaredManifestHash: mount.manifestHash,
        observedManifestHash: manifest.hash,
      }));
    }
  }
  const payload = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchTopicProducerDatasetSnapshot',
    datasetRoot: realRoot,
    mounts: Object.freeze(mounts),
  });
  return Object.freeze({
    ...payload,
    datasetSnapshotHash: hashRecord(
      'AutonomousResearchTopicProducerDatasetSnapshot',
      payload,
    ),
  });
}

export function inspectAutonomousResearchTopicProducerImplementationIdentity({
  producerProfile = null,
} = {}) {
  const implementationSha256 = hashBytes(fs.readFileSync(IMPLEMENTATION_PATH));
  const ready = verifyAutonomousResearchTopicProducerProfile(producerProfile)
    && producerProfile.implementationSha256 === implementationSha256;
  return Object.freeze({
    ready,
    implementationId: 'hepta-registered-bounded-topic-producer-v1',
    implementationPath: IMPLEMENTATION_PATH,
    implementationSha256,
    expectedImplementationSha256: producerProfile?.implementationSha256 || null,
    blocker: ready ? null : 'autonomous_research_topic_producer_implementation_identity_mismatch',
  });
}

export function readAutonomousResearchTopicProducerProfile({
  profilePath = null,
  environment = process.env,
  expectedProfileHash = null,
  expectedProviderConfigurationHash = null,
  datasetRoot = null,
} = {}) {
  const requested = profilePath
    || environment.HEPTA_AUTONOMOUS_RESEARCH_TOPIC_PRODUCER_PROFILE;
  if (!requested) throw new Error('autonomous_research_topic_producer_profile_required');
  const loaded = secureDocument(requested);
  if (!verifyAutonomousResearchTopicProducerProfile(loaded.document)
    || (expectedProfileHash && loaded.document.producerProfileHash !== expectedProfileHash)
    || (expectedProviderConfigurationHash
      && loaded.document.providerConfigurationHash !== expectedProviderConfigurationHash)) {
    throw new Error('autonomous_research_topic_producer_profile_invalid_or_mismatched');
  }
  const datasetSnapshot = inspectDatasetSources(
    loaded.document,
    datasetRoot || environment.HEPTA_AUTONOMOUS_RESEARCH_DATASET_ROOT,
  );
  const implementationIdentity = inspectAutonomousResearchTopicProducerImplementationIdentity({
    producerProfile: loaded.document,
  });
  if (!implementationIdentity.ready) {
    throw new Error(implementationIdentity.blocker);
  }
  return Object.freeze({
    profilePath: loaded.absolute,
    producerProfile: loaded.document,
    implementationIdentity,
    datasetSnapshot,
  });
}
