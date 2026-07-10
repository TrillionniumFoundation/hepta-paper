#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { currentCodeProvenance, reportPointerIsCurrent } from '../src/code-provenance.mjs';
import { defaultPaperRuntimeRoot } from '../src/workspace-layout.mjs';
import { hashRecord } from '../../workflow-kernel/record-hash.mjs';

const runtimeRoot = defaultPaperRuntimeRoot();
const reportRoot = path.join(runtimeRoot, 'reports');
const staleRoot = path.join(reportRoot, 'stale');
fs.mkdirSync(staleRoot, { recursive: true });
const provenance = currentCodeProvenance();
const quarantined = [];
for (const name of fs.existsSync(reportRoot) ? fs.readdirSync(reportRoot) : []) {
  if (!/-latest\.(json|md)$/.test(name)) continue;
  const file = path.join(reportRoot, name);
  let current = false;
  if (name.endsWith('.json')) {
    try { current = reportPointerIsCurrent(JSON.parse(fs.readFileSync(file, 'utf8')), provenance); } catch { current = false; }
  }
  if (name.endsWith('.md')) {
    const jsonName = name.replace(/\.md$/, '.json');
    try { current = reportPointerIsCurrent(JSON.parse(fs.readFileSync(path.join(reportRoot, jsonName), 'utf8')), provenance); } catch { current = false; }
  }
  if (current) continue;
  const destination = path.join(staleRoot, `${new Date().toISOString().replace(/[-:.]/g, '')}-${name}`);
  fs.renameSync(file, destination);
  quarantined.push({ source: name, destination: path.relative(runtimeRoot, destination).replace(/\\/g, '/') });
}
const payload = {
  version: 1,
  kind: 'StaleLatestReportQuarantineReceipt',
  status: 'stale_latest_reports_quarantined',
  codeProvenance: provenance,
  quarantined,
  quarantinedCount: quarantined.length,
  createdAt: new Date().toISOString(),
};
const receipt = { ...payload, staleLatestReportQuarantineReceiptHash: hashRecord('StaleLatestReportQuarantineReceipt', payload) };
const output = path.join(reportRoot, 'STALE_LATEST_REPORT_QUARANTINE_RECEIPT.json');
fs.writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
