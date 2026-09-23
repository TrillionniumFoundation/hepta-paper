import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function sha256Bytes(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function parseJsonBytes(bytes, label) {
  try { return JSON.parse(Buffer.from(bytes).toString('utf8')); }
  catch { throw new Error(`cyclonedx_${label}_json_invalid`); }
}

function packageName(packagePath, descriptor) {
  if (typeof descriptor?.name === 'string' && descriptor.name) return descriptor.name;
  const marker = 'node_modules/';
  const index = packagePath.lastIndexOf(marker);
  if (index < 0) throw new Error(`cyclonedx_lockfile_package_name_missing:${packagePath}`);
  return packagePath.slice(index + marker.length);
}

function packageUrl(name, version) {
  const segments = name.startsWith('@') ? name.split('/') : [name];
  const encodedName = segments.map((segment) => encodeURIComponent(segment)).join('/');
  return `pkg:npm/${encodedName}@${encodeURIComponent(version)}`;
}

function componentReference(packagePath, name, version) {
  return `urn:hepta:npm-lock-component:${sha256Bytes(
    `${packagePath}\0${name}\0${version}`,
  ).slice('sha256:'.length)}`;
}

function integrityHashes(integrity) {
  if (typeof integrity !== 'string') return [];
  return integrity.split(/\s+/u).flatMap((candidate) => {
    const match = /^(sha(?:256|384|512))-([A-Za-z0-9+/]+={0,2})$/u.exec(candidate);
    if (!match) return [];
    const bytes = Buffer.from(match[2], 'base64');
    if (bytes.toString('base64') !== match[2]) return [];
    return [{ alg: match[1].toUpperCase().replace('SHA', 'SHA-'), content: bytes.toString('hex') }];
  });
}

function componentLicenses(license) {
  if (typeof license === 'string' && license.trim()) return [{ expression: license.trim() }];
  if (Array.isArray(license) && license.length) {
    return license.filter((item) => typeof item === 'string' && item.trim())
      .map((item) => ({ expression: item.trim() }));
  }
  return [];
}

function dependencyPath(packagePaths, fromPath, dependencyName) {
  let cursor = fromPath;
  while (true) {
    const candidate = cursor
      ? `${cursor}/node_modules/${dependencyName}`
      : `node_modules/${dependencyName}`;
    if (packagePaths.has(candidate)) return candidate;
    const marker = cursor.lastIndexOf('node_modules/');
    if (marker < 0) return null;
    cursor = cursor.slice(0, marker).replace(/\/$/u, '');
  }
}

function dependencyNames(descriptor, root = false) {
  const fields = root
    ? ['dependencies', 'devDependencies', 'optionalDependencies']
    : ['dependencies', 'optionalDependencies'];
  return [...new Set(fields.flatMap((field) => Object.keys(descriptor?.[field] || {})))].sort();
}

export function buildCycloneDxLockfileSbom({ packageJsonBytes, packageLockBytes }) {
  const packageJson = parseJsonBytes(packageJsonBytes, 'package');
  const packageLock = parseJsonBytes(packageLockBytes, 'package_lock');
  if (packageLock.lockfileVersion !== 3 || !packageLock.packages || Array.isArray(packageLock.packages)) {
    throw new Error('cyclonedx_package_lock_v3_required');
  }
  const rootDescriptor = packageLock.packages[''];
  if (!rootDescriptor
    || rootDescriptor.name !== packageJson.name
    || rootDescriptor.version !== packageJson.version) {
    throw new Error('cyclonedx_package_identity_mismatch');
  }
  const packageRows = Object.entries(packageLock.packages)
    .filter(([packagePath]) => packagePath !== '')
    .sort(([left], [right]) => left.localeCompare(right));
  const packagePaths = new Set(packageRows.map(([packagePath]) => packagePath));
  const rows = packageRows.map(([packagePath, descriptor]) => {
    const name = packageName(packagePath, descriptor);
    const version = String(descriptor.version || '');
    if (!version) throw new Error(`cyclonedx_lockfile_package_version_missing:${packagePath}`);
    return Object.freeze({
      packagePath,
      descriptor,
      name,
      version,
      ref: componentReference(packagePath, name, version),
    });
  });
  const byPath = new Map(rows.map((row) => [row.packagePath, row]));
  const rootRef = componentReference('', packageJson.name, packageJson.version);
  const rootComponent = {
    type: 'application',
    'bom-ref': rootRef,
    name: packageJson.name,
    version: packageJson.version,
    purl: packageUrl(packageJson.name, packageJson.version),
    properties: [
      { name: 'hepta:npm:package-lock-path', value: '' },
      { name: 'hepta:npm:private-package', value: String(packageJson.private === true) },
    ],
  };
  const components = rows.map(({ packagePath, descriptor, name, version, ref }) => {
    const component = {
      type: 'library',
      'bom-ref': ref,
      name: name.startsWith('@') ? name.split('/').slice(1).join('/') : name,
      version,
      purl: packageUrl(name, version),
      properties: [
        { name: 'hepta:npm:package-lock-path', value: packagePath },
        { name: 'hepta:npm:development-dependency', value: String(descriptor.dev === true) },
        { name: 'hepta:npm:optional-dependency', value: String(descriptor.optional === true) },
      ],
    };
    if (name.startsWith('@')) component.group = name.split('/')[0];
    const hashes = integrityHashes(descriptor.integrity);
    if (hashes.length) component.hashes = hashes;
    const licenses = componentLicenses(descriptor.license);
    if (licenses.length) component.licenses = licenses;
    if (typeof descriptor.resolved === 'string' && descriptor.resolved) {
      component.externalReferences = [{ type: 'distribution', url: descriptor.resolved }];
    }
    return component;
  });
  const dependencyRows = [
    {
      ref: rootRef,
      descriptor: rootDescriptor,
      packagePath: '',
      root: true,
    },
    ...rows.map((row) => ({ ...row, root: false })),
  ].map(({ ref, descriptor, packagePath, root }) => {
    const dependsOn = dependencyNames(descriptor, root).flatMap((dependencyName) => {
      const resolved = dependencyPath(packagePaths, packagePath, dependencyName);
      if (resolved) return [byPath.get(resolved).ref];
      if (descriptor.optionalDependencies?.[dependencyName] !== undefined) return [];
      throw new Error(`cyclonedx_lockfile_dependency_unresolved:${packagePath}:${dependencyName}`);
    });
    return { ref, dependsOn: [...new Set(dependsOn)].sort() };
  }).sort((left, right) => left.ref.localeCompare(right.ref));
  const packageJsonHash = sha256Bytes(packageJsonBytes);
  const packageLockHash = sha256Bytes(packageLockBytes);
  return Object.freeze({
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    version: 1,
    metadata: {
      tools: {
        components: [{
          type: 'application',
          name: 'hepta-source-supply-chain-security',
          version: '1',
        }],
      },
      component: rootComponent,
      properties: [
        { name: 'hepta:sbom:evidence-class', value: 'local_package_lock_inventory' },
        { name: 'hepta:sbom:external-attestation', value: 'false' },
        { name: 'hepta:sbom:installed-environment-observed', value: 'false' },
        { name: 'hepta:sbom:package-json-sha256', value: packageJsonHash },
        { name: 'hepta:sbom:package-lock-sha256', value: packageLockHash },
      ],
    },
    components,
    dependencies: dependencyRows,
  });
}

export function cycloneDxSbomBytes(sbom) {
  return Buffer.from(`${JSON.stringify(sbom, null, 2)}\n`, 'utf8');
}

export function buildCycloneDxLockfileSbomFromFiles({
  workspaceRoot,
  packageJsonPath = 'package.json',
  packageLockPath = 'package-lock.json',
} = {}) {
  const packageJsonBytes = fs.readFileSync(path.join(workspaceRoot, packageJsonPath));
  const packageLockBytes = fs.readFileSync(path.join(workspaceRoot, packageLockPath));
  const sbom = buildCycloneDxLockfileSbom({ packageJsonBytes, packageLockBytes });
  return Object.freeze({
    sbom,
    bytes: cycloneDxSbomBytes(sbom),
    sbomHash: sha256Bytes(cycloneDxSbomBytes(sbom)),
    packageJsonHash: sha256Bytes(packageJsonBytes),
    packageLockHash: sha256Bytes(packageLockBytes),
  });
}
