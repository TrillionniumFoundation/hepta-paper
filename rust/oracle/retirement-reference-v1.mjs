import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

function sha256File(file) {
  return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
}

function run(root) {
  const blockers = [];
  let receipt = null;
  let immutableReceipt = null;
  try { receipt = JSON.parse(fs.readFileSync(path.join(root, 'RETIREMENT_SOURCE_SNAPSHOT_RECEIPT.json'), 'utf8')); }
  catch { blockers.push('retirement_snapshot_receipt_missing_or_invalid'); }
  try { immutableReceipt = JSON.parse(fs.readFileSync(path.join(root, 'IMMUTABILITY_RECEIPT.json'), 'utf8')); }
  catch { blockers.push('immutability_receipt_missing_or_invalid'); }
  for (const archive of receipt?.archives || []) {
    const file = path.join(root, archive.name);
    if (!fs.existsSync(file)) blockers.push(`archive_missing:${archive.name}`);
    else {
      if (fs.statSync(file).size !== archive.bytes) blockers.push(`archive_size_mismatch:${archive.name}`);
      if (sha256File(file) !== archive.sha256) blockers.push(`archive_hash_mismatch:${archive.name}`);
    }
  }
  for (const item of immutableReceipt?.files || []) {
    const file = path.join(root, item.name);
    if (!fs.existsSync(file)) continue;
    try {
      const attributes = execFileSync('lsattr', ['-d', file], { encoding: 'utf8' }).trim().split(/\s+/)[0] || '';
      if (!attributes.includes('i')) blockers.push(`archive_not_immutable:${item.name}`);
    } catch { blockers.push(`archive_immutability_unverifiable:${item.name}`); }
  }
  return {
    version: 1,
    kind: 'LegacyRetirementReferenceVerification',
    status: blockers.length ? 'retirement_reference_blocked' : 'retirement_reference_verified',
    referenceRoot: root,
    runtimeDependencyAllowed: false,
    liveLegacyRootExists: fs.existsSync('/data/home-data/paper_factory'),
    archiveCount: receipt?.archives?.length || 0,
    blockers,
  };
}

const requests = JSON.parse(fs.readFileSync(0, 'utf8'));
process.stdout.write(JSON.stringify({
  profile: { node: process.version },
  results: requests.map((request) => {
    try { return { ok: true, value: run(request.root) }; }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
  }),
}));

