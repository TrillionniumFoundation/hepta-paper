import { hasExactObjectKeys } from '../../workflow-kernel/exact-object-keys.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$/;
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAXIMUM_ASSET_BYTES = 512 * 1024;
const MAXIMUM_TOTAL_ASSET_BYTES = 2 * 1024 * 1024;
const ASSET_KEYS = Object.freeze([
  'applicationMode', 'bytesBase64', 'contentEncoding', 'kind', 'relativePath',
  'sizeBytes', 'templateAssetHash', 'venueId', 'version',
]);
const BUNDLE_KEYS = Object.freeze([
  'assetCount', 'assets', 'autonomousVenueTemplateAssetBundleHash', 'kind',
  'registryHash', 'status', 'totalSizeBytes', 'version',
]);

function safeRelativePath(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 240
    || value.includes('\\') || value.includes('\0') || value.startsWith('/')
    || value.endsWith('/') || value.includes('//')
    || !value.startsWith('venue-assets/') || !value.endsWith('.tex')) return null;
  const segments = value.split('/');
  return segments.length <= 16 && segments.every((segment) => (
    segment !== '.' && segment !== '..' && SAFE_PATH_SEGMENT.test(segment)
  )) ? value : null;
}

function canonicalBase64(value) {
  if (typeof value !== 'string' || value.length < 4
    || value.length > Math.ceil(MAXIMUM_ASSET_BYTES / 3) * 4) return null;
  const bytes = Buffer.from(value, 'base64');
  return bytes.length > 0 && bytes.length <= MAXIMUM_ASSET_BYTES
    && bytes.toString('base64') === value ? bytes : null;
}

function safeLatexPreamble(bytes) {
  const source = bytes.toString('utf8');
  const unsafeControlCharacter = [...source].some((character) => {
    const codePoint = character.codePointAt(0);
    return (codePoint >= 0 && codePoint <= 8)
      || codePoint === 11 || codePoint === 12
      || (codePoint >= 14 && codePoint <= 31) || codePoint === 127;
  });
  if (!source.trim() || !Buffer.from(source, 'utf8').equals(bytes)
    || unsafeControlCharacter
    || /\\(?:documentclass|input|include|includeonly|openin|openout|read|write\d*|immediate|catcode|everyjob|special)\b/iu.test(source)
    || /\\(?:begin|end)\s*\{\s*document\s*\}/iu.test(source)) return false;
  return true;
}

function registrySurface(registry) {
  if (registry?.version !== 3 || registry?.kind !== 'AutonomousVenueProfileRegistry'
    || registry?.status !== 'autonomous_venue_profile_registry_ready'
    || !SHA256.test(String(registry?.autonomousVenueProfileRegistryHash || ''))
    || !Array.isArray(registry?.profiles) || registry.profiles.length < 1
    || registry.profiles.length > 128) return null;
  const { autonomousVenueProfileRegistryHash: claimedHash, ...payload } = registry;
  if (hashRecord('AutonomousVenueProfileRegistry', payload) !== claimedHash) return null;
  const profiles = registry.profiles.map((profile) => Object.freeze({
    venueId: String(profile?.venueId || ''),
    templateAssetHash: String(
      profile?.requirementSpecification?.templateAssetHash || '',
    ),
  }));
  return profiles.every((profile) => SAFE_ID.test(profile.venueId)
    && SHA256.test(profile.templateAssetHash))
    && new Set(profiles.map((profile) => profile.venueId)).size === profiles.length
    ? Object.freeze(profiles) : null;
}

export function buildAutonomousVenueTemplateAssetRecord({
  venueId,
  relativePath,
  bytesBase64,
  sizeBytes,
  templateAssetHash,
  applicationMode = 'latex-preamble-input-v1',
} = {}) {
  const selectedVenueId = String(venueId || '');
  const selectedPath = safeRelativePath(relativePath);
  const bytes = canonicalBase64(bytesBase64);
  const selectedSize = Number(sizeBytes);
  const selectedHash = String(templateAssetHash || '').toLowerCase();
  if (!SAFE_ID.test(selectedVenueId) || !selectedPath || !bytes
    || applicationMode !== 'latex-preamble-input-v1' || !safeLatexPreamble(bytes)
    || !Number.isSafeInteger(selectedSize) || selectedSize !== bytes.length
    || !SHA256.test(selectedHash) || hashBytes(bytes) !== selectedHash) {
    throw new Error('autonomous_venue_template_asset_invalid');
  }
  return Object.freeze({
    version: 1,
    kind: 'AutonomousVenueTemplateAssetRecord',
    venueId: selectedVenueId,
    relativePath: selectedPath,
    applicationMode,
    contentEncoding: 'base64',
    bytesBase64,
    sizeBytes: selectedSize,
    templateAssetHash: selectedHash,
  });
}

export function verifyAutonomousVenueTemplateAssetRecord(record) {
  if (!hasExactObjectKeys(record, ASSET_KEYS)
    || record?.version !== 1
    || record?.kind !== 'AutonomousVenueTemplateAssetRecord'
    || record?.contentEncoding !== 'base64') return false;
  try {
    return JSON.stringify(buildAutonomousVenueTemplateAssetRecord(record))
      === JSON.stringify(record);
  } catch { return false; }
}

export function buildAutonomousVenueTemplateAssetBundle({
  registry,
  assets,
} = {}) {
  const profiles = registrySurface(registry);
  if (!profiles || !Array.isArray(assets) || assets.length !== profiles.length
    || assets.some((asset) => !verifyAutonomousVenueTemplateAssetRecord(asset))) {
    throw new Error('autonomous_venue_template_asset_bundle_invalid');
  }
  const selected = Object.freeze(assets.map((asset) => (
    buildAutonomousVenueTemplateAssetRecord(asset)
  )).sort((left, right) => (
    left.venueId.localeCompare(right.venueId)
  )));
  const byVenue = new Map(selected.map((asset) => [asset.venueId, asset]));
  if (byVenue.size !== selected.length || profiles.some((profile) => (
    byVenue.get(profile.venueId)?.templateAssetHash !== profile.templateAssetHash
  ))) {
    throw new Error('autonomous_venue_template_asset_profile_binding_invalid');
  }
  const totalSizeBytes = selected.reduce((total, asset) => total + asset.sizeBytes, 0);
  if (totalSizeBytes > MAXIMUM_TOTAL_ASSET_BYTES) {
    throw new Error('autonomous_venue_template_asset_bundle_size_invalid');
  }
  const payload = {
    version: 1,
    kind: 'AutonomousVenueTemplateAssetBundle',
    status: 'autonomous_venue_template_assets_ready',
    registryHash: registry.autonomousVenueProfileRegistryHash,
    assets: selected,
    assetCount: selected.length,
    totalSizeBytes,
  };
  return Object.freeze({
    ...payload,
    autonomousVenueTemplateAssetBundleHash:
      hashRecord('AutonomousVenueTemplateAssetBundle', payload),
  });
}

export function verifyAutonomousVenueTemplateAssetBundle(bundle, { registry } = {}) {
  if (!hasExactObjectKeys(bundle, BUNDLE_KEYS)
    || bundle?.version !== 1
    || bundle?.kind !== 'AutonomousVenueTemplateAssetBundle'
    || bundle?.status !== 'autonomous_venue_template_assets_ready') return false;
  try {
    return JSON.stringify(buildAutonomousVenueTemplateAssetBundle({
      registry,
      assets: bundle.assets,
    })) === JSON.stringify(bundle);
  } catch { return false; }
}

export function selectAutonomousVenueTemplateAsset(bundle, { registry, venueId } = {}) {
  if (!verifyAutonomousVenueTemplateAssetBundle(bundle, { registry })) {
    throw new Error('autonomous_venue_template_asset_bundle_invalid');
  }
  const selected = bundle.assets.find((asset) => asset.venueId === venueId);
  if (!selected) throw new Error('autonomous_venue_template_asset_missing');
  return selected;
}
