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

function duplicateValues(values) {
  const seen = new Set();
  const duplicates = new Set();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates].sort();
}

function exactLineCount(document, expectedLine) {
  return String(document || '').split(/\r?\n/u)
    .filter((line) => line === expectedLine).length;
}

function documentationProfiles(version) {
  return Object.freeze([
    Object.freeze({
      name: 'development',
      markers: Object.freeze({
        currentStatus: `This is the normative status for the unreleased v${version} development candidate.`,
        releaseDocument: `Version ${version} is an unreleased automation-first research-production candidate.`,
        changelog: `## Unreleased (${version} development)`,
      }),
    }),
    Object.freeze({
      name: 'finalized',
      markers: Object.freeze({
        currentStatus: `Release state: finalized v${version} source.`,
        releaseDocument: `Version ${version} is finalized from this exact source commit.`,
        changelog: `## ${version} (finalized source)`,
      }),
    }),
    Object.freeze({
      name: 'legacy_released',
      markers: Object.freeze({
        currentStatus: `This is the normative status for the v${version} architecture release.`,
        releaseDocument: `Version ${version} is the current release.`,
        changelog: `## ${version}`,
      }),
    }),
  ]);
}

function inspectDocumentationProfile({
  version,
  currentStatus,
  releaseDocument,
  changelog,
}) {
  const documents = { currentStatus, releaseDocument, changelog };
  const candidates = documentationProfiles(version).map((profile) => {
    const counts = Object.fromEntries(Object.entries(profile.markers)
      .map(([name, marker]) => [name, exactLineCount(documents[name], marker)]));
    return Object.freeze({
      name: profile.name,
      counts: Object.freeze(counts),
      matchedDocuments: Object.values(counts).filter((count) => count > 0).length,
      duplicateMarker: Object.values(counts).some((count) => count > 1),
      complete: Object.values(counts).every((count) => count === 1),
    });
  });
  const active = candidates.filter((candidate) => candidate.matchedDocuments > 0);
  if (active.length === 0) {
    return Object.freeze({ profile: null, errors: Object.freeze([
      'release_documentation_state_unrecognized',
    ]) });
  }
  if (active.length > 1) {
    return Object.freeze({ profile: null, errors: Object.freeze([
      'release_documentation_state_mixed',
    ]) });
  }
  const [candidate] = active;
  if (candidate.duplicateMarker) {
    return Object.freeze({ profile: null, errors: Object.freeze([
      `release_documentation_marker_duplicate:${candidate.name}`,
    ]) });
  }
  if (!candidate.complete) {
    return Object.freeze({ profile: null, errors: Object.freeze([
      `release_documentation_state_partial:${candidate.name}`,
    ]) });
  }
  return Object.freeze({ profile: candidate.name, errors: Object.freeze([]) });
}

function inspectTagSnapshot({ version, parsedVersion, headTags, allTags }) {
  const errors = [];
  if (!Array.isArray(headTags) || !headTags.every((tag) => typeof tag === 'string')) {
    errors.push('head_tag_snapshot_invalid');
  }
  if (!Array.isArray(allTags) || !allTags.every((tag) => typeof tag === 'string')) {
    errors.push('repository_tag_snapshot_invalid');
  }
  if (errors.length > 0) {
    return Object.freeze({
      currentTag: `v${version}`,
      isTaggedRelease: false,
      currentTagExists: false,
      errors: Object.freeze(errors),
    });
  }

  for (const tag of duplicateValues(headTags)) errors.push(`head_tag_snapshot_duplicate:${tag}`);
  for (const tag of duplicateValues(allTags)) errors.push(`repository_tag_snapshot_duplicate:${tag}`);
  const allTagSet = new Set(allTags);
  for (const tag of new Set(headTags)) {
    if (!allTagSet.has(tag)) errors.push(`head_tag_missing_from_repository_snapshot:${tag}`);
  }

  const currentTag = `v${version}`;
  const headReleaseTags = taggedVersions([...new Set(headTags)]);
  for (const entry of headReleaseTags) {
    if (entry.tag !== currentTag) errors.push(`head_release_tag_version_mismatch:${entry.tag}`);
  }
  if (parsedVersion) {
    for (const entry of taggedVersions([...new Set(allTags)])) {
      if (compareVersions(entry.version, parsedVersion) > 0) {
        errors.push(`repository_tag_newer_than_package:${entry.tag}`);
      }
    }
  }

  return Object.freeze({
    currentTag,
    isTaggedRelease: headTags.includes(currentTag),
    currentTagExists: allTags.includes(currentTag),
    errors: Object.freeze(errors),
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

  let state = null;
  let documentationProfile = null;
  if (parsedVersion) {
    const documentation = inspectDocumentationProfile({
      version,
      currentStatus,
      releaseDocument,
      changelog,
    });
    errors.push(...documentation.errors);
    documentationProfile = documentation.profile;

    const tagSnapshot = inspectTagSnapshot({
      version,
      parsedVersion,
      headTags,
      allTags,
    });
    errors.push(...tagSnapshot.errors);

    if (documentationProfile === 'development') {
      state = 'development';
      if (tagSnapshot.isTaggedRelease) errors.push('development_documentation_cannot_be_tagged');
      else if (tagSnapshot.currentTagExists) errors.push('development_version_tag_already_exists');
    } else if (documentationProfile === 'finalized') {
      state = tagSnapshot.isTaggedRelease ? 'released' : 'release_ready';
      if (!tagSnapshot.isTaggedRelease && tagSnapshot.currentTagExists) {
        errors.push('release_ready_version_tag_already_exists');
      }
    } else if (documentationProfile === 'legacy_released') {
      if (tagSnapshot.isTaggedRelease) state = 'released';
      else {
        errors.push('legacy_released_documentation_requires_head_tag');
        if (tagSnapshot.currentTagExists) errors.push('legacy_release_tag_not_at_head');
      }
    }
  }

  return Object.freeze({
    ok: errors.length === 0,
    kind: 'ReleaseStateConsistency',
    contractVersion: 2,
    version: version || null,
    state,
    documentationProfile,
    errors: Object.freeze(errors),
  });
}
