const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function parseVersion(value) {
  const match = VERSION_PATTERN.exec(value || '');
  if (!match) return null;
  return match.slice(1).map(Number);
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function taggedVersions(tags) {
  return tags.flatMap((tag) => {
    const parsed = /^v(.+)$/.exec(tag)?.[1];
    const version = parseVersion(parsed);
    return version ? [{ tag, parsed, version }] : [];
  });
}

export function inspectReleaseState({
  packageJson,
  packageLock,
  currentStatus,
  releaseDocument,
  changelog,
  headTags = [],
  allTags = [],
}) {
  const errors = [];
  const version = packageJson?.version;
  const parsedVersion = parseVersion(version);
  if (!parsedVersion) errors.push('package_version_must_be_plain_semver');
  if (packageLock?.version !== version) errors.push('package_lock_version_mismatch');
  if (packageLock?.packages?.['']?.version !== version) errors.push('package_lock_root_version_mismatch');
  if (packageLock?.name !== packageJson?.name) errors.push('package_lock_name_mismatch');
  if (packageLock?.packages?.['']?.name !== packageJson?.name) errors.push('package_lock_root_name_mismatch');
  if (packageJson?.engines?.node !== '>=22.23.1 <23') errors.push('node_engine_policy_mismatch');
  if (packageJson?.packageManager !== 'npm@10.9.8') errors.push('package_manager_policy_mismatch');

  if (parsedVersion) {
    const currentTag = `v${version}`;
    const isTaggedRelease = headTags.includes(currentTag);
    const developmentMarkers = [
      currentStatus.includes(`unreleased v${version} development candidate`),
      releaseDocument.includes(`Version ${version} is an unreleased`),
      changelog.includes(`## Unreleased (${version} development)`),
    ];
    const releaseMarkers = [
      currentStatus.includes(`v${version} architecture release`),
      releaseDocument.includes(`Version ${version} is the current release`),
      changelog.includes(`## ${version}`),
    ];

    if (isTaggedRelease) {
      if (!releaseMarkers.every(Boolean)) errors.push('tagged_release_documentation_mismatch');
      if (developmentMarkers.some(Boolean)) errors.push('tagged_release_still_marked_unreleased');
    } else {
      if (!developmentMarkers.every(Boolean)) errors.push('development_release_documentation_mismatch');
      if (allTags.includes(currentTag)) errors.push('development_version_tag_already_exists');
    }

    for (const entry of taggedVersions(allTags)) {
      if (compareVersions(entry.version, parsedVersion) > 0) {
        errors.push(`repository_tag_newer_than_package:${entry.tag}`);
      }
    }
  }

  return Object.freeze({
    ok: errors.length === 0,
    kind: 'ReleaseStateConsistency',
    version: version || null,
    state: parsedVersion && headTags.includes(`v${version}`) ? 'released' : 'development',
    errors: Object.freeze(errors),
  });
}
