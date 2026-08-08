import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/i;

export function verifyExperimentRawArtifactWriteReceipt(receipt, { contentHash, bytes } = {}) {
  if (!receipt || receipt.version !== 2 || receipt.kind !== 'ArtifactWriteReceipt') return false;
  const { writeReceiptHash, ledgerReceiptId, ...payload } = receipt;
  return Boolean(
    SHA256.test(String(writeReceiptHash || ''))
    && String(ledgerReceiptId || '').startsWith('artifact-writes:')
    && hashRecord('ArtifactWriteReceipt', payload) === writeReceiptHash
    && receipt.role?.startsWith('campaign-experiment-raw-events:')
    && /^raw-events-[0-9a-f]{64}\.ndjson$/i.test(String(receipt.path || ''))
    && receipt.hash === contentHash
    && receipt.contentAddress === contentHash
    && Number.isSafeInteger(receipt.bytes) && Number.isSafeInteger(bytes)
    && receipt.bytes === bytes
    && receipt.contentType === 'application/octet-stream'
    && receipt.immutableObject === true
    && receipt.atomic === true
  );
}

function parseCsvLine(line) {
  const fields = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"' && quoted && line[index + 1] === '"') {
      field += '"';
      index += 1;
    } else if (character === '"') quoted = !quoted;
    else if (character === ',' && !quoted) {
      fields.push(field.trim());
      field = '';
    } else field += character;
  }
  if (quoted) throw new Error('empirical_results_csv_unterminated_quote');
  fields.push(field.trim());
  return fields;
}

export function parseExperimentObservationCsv(document) {
  const lines = String(document || '').split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) throw new Error('empirical_results_csv_invalid');
  const header = parseCsvLine(lines[0]);
  if (new Set(header).size !== header.length || header.some((name) => !/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(name))) {
    throw new Error('empirical_results_csv_header_invalid');
  }
  return lines.slice(1).map((line, index) => {
    const fields = parseCsvLine(line);
    if (fields.length !== header.length) throw new Error(`empirical_results_csv_row_invalid:${index + 2}`);
    return Object.fromEntries(header.map((name, column) => [name, fields[column]]));
  });
}

export function buildDatasetAuthorizationSet(datasetMounts = []) {
  const datasets = datasetMounts.map((mount) => ({
    name: String(mount?.name || ''),
    manifestHash: mount?.manifestHash || null,
    licenseId: mount?.licenseId || null,
    operatorAuthorizationHash: mount?.operatorAuthorizationHash || null,
    operatorDatasetAuthorityDocumentHash: mount?.operatorDatasetAuthorityDocumentHash || null,
    operatorDatasetAuthority: mount?.operatorDatasetAuthority || null,
    ...(mount?.operatorDatasetResearchSemantics ? {
      operatorDatasetResearchSemantics: mount.operatorDatasetResearchSemantics,
      operatorDatasetResearchSemanticsHash:
        mount.operatorDatasetResearchSemanticsHash || null,
    } : {}),
    ...(mount?.authorityScope ? {
      authorityScope: mount.authorityScope,
      evidenceClass: mount.evidenceClass || null,
      academicPromotionEligible: mount.academicPromotionEligible === true,
      externalTrustClaimed: mount.externalTrustClaimed === true,
      localGoldenRuntimeScope: mount.localGoldenRuntimeScope || null,
    } : {}),
    splitManifestHash: mount?.splitManifestHash || null,
    readOnly: mount?.readOnly === true,
    benchmarkHarnessDocumentHash: mount?.benchmarkHarnessDocumentHash || null,
    benchmarkHarnessDefinitionHash: mount?.benchmarkHarnessDefinitionHash || null,
    analysisProtocol: mount?.analysisProtocol || null,
    analysisProtocolHash: mount?.analysisProtocolHash || null,
    benchmarkFamily: mount?.benchmarkFamily || null,
    benchmarkSeedSchedule: Array.isArray(mount?.benchmarkSeedSchedule) ? mount.benchmarkSeedSchedule.map(Number) : [],
    benchmarkMinimumRepetitions: Number(mount?.benchmarkMinimumRepetitions || 0),
  })).sort((left, right) => left.name.localeCompare(right.name));
  const payload = { version: 1, kind: 'DatasetAuthorizationSet', datasets };
  return Object.freeze({ ...payload, datasetAuthorizationSetHash: hashRecord('DatasetAuthorizationSet', payload) });
}
