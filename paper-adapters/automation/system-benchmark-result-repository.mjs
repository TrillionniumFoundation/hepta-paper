import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { hashBytes } from '../../workflow-kernel/record-hash.mjs';
import { writeDurableJsonSync } from '../runtime/durable-json-repository.mjs';

function writeDurableTextSync(candidate, content) {
  const destination = path.resolve(candidate);
  const parent = path.dirname(destination);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const temporary = path.join(parent, `.${path.basename(destination)}.tmp-${process.pid}-${crypto.randomUUID()}`);
  let descriptor = null;
  try {
    descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
    fs.writeFileSync(descriptor, content, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(temporary, destination);
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
    fs.rmSync(temporary, { force: true });
  }
}

export function writeSystemBenchmarkResults({ outputDirectory, resultDocument, csvDocument, rawEventDocument } = {}) {
  const jsonPath = path.join(outputDirectory, 'results.json');
  const csvPath = path.join(outputDirectory, 'results.csv');
  const rawEventPath = path.join(outputDirectory, 'raw-events.ndjson');
  writeDurableJsonSync(jsonPath, resultDocument);
  writeDurableTextSync(csvPath, csvDocument);
  writeDurableTextSync(rawEventPath, rawEventDocument);
  const resultJson = fs.readFileSync(jsonPath);
  const resultCsv = fs.readFileSync(csvPath);
  const rawEvents = fs.readFileSync(rawEventPath);
  const resultJsonHash = hashBytes(resultJson);
  const resultCsvHash = hashBytes(resultCsv);
  const rawEventArtifactHash = hashBytes(rawEvents);
  return Object.freeze({
    resultJsonHash,
    resultCsvHash,
    rawEventArtifactHash,
    rawEventArtifactBytes: rawEvents.length,
    artifacts: Object.freeze([
      { path: 'results.json', sha256: resultJsonHash, bytes: resultJson.length },
      { path: 'results.csv', sha256: resultCsvHash, bytes: resultCsv.length },
      { path: 'raw-events.ndjson', sha256: rawEventArtifactHash, bytes: rawEvents.length },
    ]),
  });
}
