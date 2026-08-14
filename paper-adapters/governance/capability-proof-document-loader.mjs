import fs from 'node:fs';
import path from 'node:path';
import {
  assertBoundRegularJsonSnapshot,
  readBoundRegularJsonSnapshot,
} from './capability-proof-verifier-support.mjs';

export function loadCapabilityProofDocuments({
  runtimeRoot,
  capabilityCatalog,
  releaseCommit,
  directoryName,
  targetBindings,
  verify,
  verifiedStatus,
  hashField,
  listField,
}) {
  const verified = new Map();
  let trustStoreRead = null;
  try {
    trustStoreRead = readBoundRegularJsonSnapshot(
      runtimeRoot,
      path.join(runtimeRoot, 'owner-acceptance', 'OWNER_TRUST_STORE.json'),
    );
  } catch {
    return verified;
  }
  const trustStore = trustStoreRead.document;
  const acceptedReceiptReads = [];
  const root = path.join(runtimeRoot, directoryName, 'capabilities');
  for (const capabilityId of Object.keys(capabilityCatalog).sort()) {
    const directory = path.join(root, capabilityId);
    let files = [];
    try {
      files = fs.readdirSync(directory).filter((name) => name.endsWith('.json')).sort();
    } catch {
      continue;
    }
    const receipts = [];
    const assurances = new Set();
    for (const name of files) {
      try {
        const receiptRead = readBoundRegularJsonSnapshot(
          runtimeRoot,
          path.join(directory, name),
        );
        const result = verify({
          document: receiptRead.document,
          trustStore,
          capabilityId,
          targetBindings: targetBindings[capabilityId],
          releaseCommit,
        });
        if (result.status === verifiedStatus) {
          receipts.push(result[hashField]);
          assurances.add(result.issuerAssurance);
          acceptedReceiptReads.push(receiptRead);
        }
      } catch {
        // Malformed external intake stays unverified.
      }
    }
    if (receipts.length) {
      verified.set(capabilityId, Object.freeze({
        capabilityId,
        [listField]: [...new Set(receipts)].sort(),
        issuerAssurances: [...assurances].sort(),
      }));
    }
  }
  try {
    assertBoundRegularJsonSnapshot(trustStoreRead);
    for (const receiptRead of acceptedReceiptReads) {
      assertBoundRegularJsonSnapshot(receiptRead);
    }
  } catch {
    return new Map();
  }
  return verified;
}
