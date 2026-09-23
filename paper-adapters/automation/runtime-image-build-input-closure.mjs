import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  runtimeImageReproducibilityCanonicalContextTarMetadataPolicy,
  matchesRuntimeImageReproducibilityDockerfileFrontend,
  matchesRuntimeImageReproducibilityCanonicalBuild,
} from '../../paper-domain/automation/runtime-image-reproducibility-build-policy.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const BUILD_ARG = /^[A-Z_][A-Z0-9_]{0,127}$/;
const PLATFORM = /^linux\/(?:amd64|arm64)$/;

function contentHash(candidate) {
  return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(candidate)).digest('hex')}`;
}

function normalizedRelative(root, candidate) {
  const relative = path.relative(root, candidate).split(path.sep).join('/');
  if (!relative || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) {
    throw new Error('runtime_reproducibility_context_entry_outside_root');
  }
  return relative;
}

function visitContext(root, directory = root, records = [], excludedPaths = new Set()) {
  for (const name of fs.readdirSync(directory).sort()) {
    const absolute = path.join(directory, name);
    const relative = normalizedRelative(root, absolute);
    if (excludedPaths.has(relative)) continue;
    const stat = fs.lstatSync(absolute);
    const mode = Number(stat.mode & 0o777);
    if (stat.isDirectory()) {
      records.push(Object.freeze({ path: `${relative}/`, type: 'directory', mode }));
      visitContext(root, absolute, records, excludedPaths);
    } else if (stat.isFile()) {
      records.push(Object.freeze({
        path: relative,
        type: 'file',
        mode,
        bytes: stat.size,
        contentHash: contentHash(absolute),
      }));
    } else if (stat.isSymbolicLink()) {
      const target = fs.readlinkSync(absolute);
      const resolvedTarget = path.resolve(path.dirname(absolute), target);
      normalizedRelative(root, resolvedTarget);
      records.push(Object.freeze({ path: relative, type: 'symlink', mode, target }));
    } else {
      throw new Error(`runtime_reproducibility_context_entry_type_invalid:${relative}`);
    }
  }
  if (directory === root) {
    records.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  }
  return records;
}

function canonicalContextTransportMetadataPaths(context, definition) {
  const paths = definition.contextTransportMetadataPaths || [];
  if (!Array.isArray(paths)
    || paths.some((entry) => typeof entry !== 'string')
    || new Set(paths).size !== paths.length
    || JSON.stringify(paths) !== JSON.stringify([...paths].sort())
    || paths.some((entry) => {
      const normalized = entry.replaceAll('\\', '/');
      return normalized !== entry || !normalized || path.posix.isAbsolute(normalized)
        || normalized === '..' || normalized.startsWith('../')
        || !/(?:^|\/)\.(?:git|gitattributes)$/.test(normalized);
    })) {
    throw new Error('runtime_reproducibility_context_transport_metadata_invalid');
  }
  const dockerignore = path.join(context, '.dockerignore');
  if (!paths.length) {
    if (fs.existsSync(dockerignore)) {
      throw new Error('runtime_reproducibility_canonical_context_required');
    }
    return new Set();
  }
  const stat = fs.lstatSync(dockerignore, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.isSymbolicLink()
    || !definition.definitionPaths.includes('.dockerignore')
    || paths.some((entry) => definition.definitionPaths.includes(entry))
    || fs.readFileSync(dockerignore, 'utf8') !== `${paths.join('\n')}\n`) {
    throw new Error('runtime_reproducibility_canonical_context_required');
  }
  return new Set(paths);
}

function exactDeclaredContext(records, definitionPaths) {
  const actual = records.filter((entry) => entry.type !== 'directory').map((entry) => entry.path).sort();
  const declared = [...new Set((definitionPaths || []).map((entry) => String(entry).replaceAll('\\', '/')))].sort();
  if (declared.length !== (definitionPaths || []).length
    || JSON.stringify(actual) !== JSON.stringify(declared)) {
    throw new Error('runtime_reproducibility_context_definition_not_exhaustive');
  }
}

function legacyDefinitionHash(context, contextPrefix, definitionPaths) {
  const records = definitionPaths.map((relativePath) => {
    const absolute = path.resolve(context, relativePath);
    const relative = normalizedRelative(context, absolute);
    const stat = fs.lstatSync(absolute);
    if (!stat.isFile()) throw new Error('runtime_reproducibility_definition_file_invalid');
    return Object.freeze({
      path: [contextPrefix, relative].filter(Boolean).join('/'),
      sha256: contentHash(absolute),
    });
  });
  return hashRecord('RuntimeImageBuildDefinitionManifest', records);
}

function dockerfileInputs(context, dockerfile) {
  const candidate = path.resolve(context, dockerfile);
  const relative = normalizedRelative(context, candidate);
  const stat = fs.lstatSync(candidate);
  if (!stat.isFile()) throw new Error('runtime_reproducibility_dockerfile_invalid');
  const text = fs.readFileSync(candidate, 'utf8');
  const frontend = text.match(/^\s*#\s*syntax\s*=\s*([^\s]+)\s*$/m)?.[1] || null;
  const frontendDigest = frontend?.match(/@(sha256:[0-9a-f]{64})$/i)?.[1]?.toLowerCase() || null;
  if (!frontend || !frontendDigest) {
    throw new Error('runtime_reproducibility_dockerfile_frontend_digest_required');
  }
  if (!matchesRuntimeImageReproducibilityDockerfileFrontend(frontend)) {
    throw new Error('runtime_reproducibility_dockerfile_frontend_policy_drift');
  }
  const baseImageReferences = [...text.matchAll(/^\s*FROM\s+(?:--[^\s]+\s+)*([^\s]+)(?:\s+AS\s+[^\s]+)?\s*$/gmi)]
    .map((match) => match[1])
    .filter((reference) => !reference.startsWith('$'));
  if (!baseImageReferences.length
    || baseImageReferences.some((reference) => !/@sha256:[0-9a-f]{64}$/i.test(reference))) {
    throw new Error('runtime_reproducibility_base_image_digest_required');
  }
  return Object.freeze({
    dockerfile: relative,
    dockerfileContentHash: contentHash(candidate),
    dockerfileFrontend: frontend,
    dockerfileFrontendDigest: frontendDigest,
    baseImageReferences: Object.freeze(baseImageReferences),
  });
}

function canonicalBuildArgs(buildArgs = {}) {
  if (!buildArgs || typeof buildArgs !== 'object' || Array.isArray(buildArgs)
    || Object.getPrototypeOf(buildArgs) !== Object.prototype) {
    throw new Error('runtime_reproducibility_build_args_invalid');
  }
  const entries = Object.entries(buildArgs).sort(([left], [right]) => left.localeCompare(right));
  if (entries.some(([key, value]) => !BUILD_ARG.test(key)
    || typeof value !== 'string' || value.length > 4096)) {
    throw new Error('runtime_reproducibility_build_args_invalid');
  }
  return Object.freeze(Object.fromEntries(entries));
}

export function inspectRuntimeImageBuildInputClosure({
  repositoryRoot = process.cwd(),
  definition,
  platform,
  buildArgs = {},
  sourceDateEpoch,
} = {}) {
  if (!definition || !definition.profile || !definition.contextPath
    || !Array.isArray(definition.definitionPaths) || !definition.definitionPaths.length
    || !SHA256.test(String(definition.imageDigest || ''))
    || !SHA256.test(String(definition.definitionManifestHash || ''))
    || !PLATFORM.test(String(platform || ''))
    || !Number.isSafeInteger(Number(sourceDateEpoch)) || Number(sourceDateEpoch) < 1) {
    throw new Error('runtime_reproducibility_input_configuration_invalid');
  }
  if (!matchesRuntimeImageReproducibilityCanonicalBuild({
    platform,
    sourceDateEpoch: Number(sourceDateEpoch),
    buildArgs,
  })) throw new Error('runtime_reproducibility_canonical_build_configuration_drift');
  const root = fs.realpathSync(path.resolve(repositoryRoot));
  const context = fs.realpathSync(path.resolve(root, definition.contextPath));
  const contextPrefix = normalizedRelative(root, context);
  const contextStat = fs.lstatSync(context);
  if (!contextStat.isDirectory()) {
    throw new Error('runtime_reproducibility_canonical_context_required');
  }
  const excludedPaths = canonicalContextTransportMetadataPaths(context, definition);
  const contextManifest = Object.freeze(visitContext(context, context, [], excludedPaths));
  exactDeclaredContext(contextManifest, definition.definitionPaths);
  const observedDefinitionHash = legacyDefinitionHash(
    context,
    contextPrefix,
    definition.definitionPaths,
  );
  if (observedDefinitionHash !== definition.definitionManifestHash) {
    throw new Error('runtime_reproducibility_definition_manifest_drift');
  }
  const docker = dockerfileInputs(context, definition.dockerfile || 'Dockerfile');
  const contextTarMetadataPolicy =
    runtimeImageReproducibilityCanonicalContextTarMetadataPolicy({
      sourceDateEpoch: Number(sourceDateEpoch),
    });
  const payload = Object.freeze({
    version: 1,
    kind: 'RuntimeImageCanonicalBuildInputClosure',
    profile: definition.profile,
    image: definition.image,
    registeredImageDigest: definition.imageDigest,
    contextPath: contextPrefix,
    contextManifest,
    contextManifestHash: hashRecord('RuntimeImageCanonicalDockerContextManifest', contextManifest),
    contextTarMetadataPolicy,
    contextTarMetadataPolicyHash: hashRecord(
      'RuntimeImageCanonicalContextTarMetadataPolicy',
      contextTarMetadataPolicy,
    ),
    definitionManifestHash: observedDefinitionHash,
    ...docker,
    platform: String(platform),
    buildArgs: canonicalBuildArgs(buildArgs),
    sourceDateEpoch: Number(sourceDateEpoch),
    cachePolicy: 'cache-disabled',
    networkPolicy: 'externally-declared-build-network-only',
    outputFormat: 'oci-layout-v1',
    ociExporter: Object.freeze({
      type: 'oci',
      rewriteTimestamp: true,
      provenance: false,
      sbom: false,
    }),
    reproducibleOciMetadataRequired: true,
  });
  return Object.freeze({
    ...payload,
    runtimeImageCanonicalBuildInputClosureHash: hashRecord(
      'RuntimeImageCanonicalBuildInputClosure',
      payload,
    ),
  });
}

export function inspectRuntimeImageBuildInputClosures({
  definitions,
  profiles,
  ...options
} = {}) {
  if (!definitions || !Array.isArray(profiles) || !profiles.length
    || new Set(profiles).size !== profiles.length) {
    throw new Error('runtime_reproducibility_profiles_invalid');
  }
  return Object.freeze(profiles.map((profile) => {
    const definition = definitions[profile];
    if (!definition || definition.profile !== profile) {
      throw new Error(`runtime_reproducibility_profile_invalid:${profile}`);
    }
    return inspectRuntimeImageBuildInputClosure({ ...options, definition });
  }));
}
