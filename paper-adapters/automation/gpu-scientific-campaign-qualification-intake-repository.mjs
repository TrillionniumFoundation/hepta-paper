import fs from 'node:fs';
import path from 'node:path';

import {
  verifyGpuScientificCampaignQualificationEvidence,
  verifyGpuScientificCampaignQualificationRequest,
} from '../../paper-domain/automation/gpu-scientific-campaign-promotion-contract.mjs';
import { readScopedFileSync } from '../../workflow-kernel/runtime/scoped-file-identity.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const MAXIMUM_INTAKE_BYTES = 4 * 1024 * 1024;
const INTAKE_FILE_NAME =
  'GPU_SCIENTIFIC_CAMPAIGN_QUALIFICATION_AUTHORITY.json';

function assertOwnedPrivateDirectory(candidate, code) {
  let identity;
  try { identity = fs.lstatSync(candidate); }
  catch { throw new Error(code); }
  if (!identity.isDirectory() || identity.isSymbolicLink()
    || fs.realpathSync.native(candidate) !== path.resolve(candidate)
    || (typeof process.geteuid === 'function'
      && identity.uid !== process.geteuid())
    || (identity.mode & 0o077) !== 0) {
    throw new Error(code);
  }
}

function assertOwnedPrivateFile(candidate) {
  const identity = fs.lstatSync(candidate);
  if (!identity.isFile() || identity.isSymbolicLink()
    || identity.nlink !== 1
    || (typeof process.geteuid === 'function'
      && identity.uid !== process.geteuid())
    || (identity.mode & 0o077) !== 0) {
    throw new Error('gpu_scientific_campaign_qualification_intake_file_unsafe');
  }
}

export function gpuScientificCampaignQualificationIntakePath({
  runtimeRoot,
  qualificationRequestHash,
} = {}) {
  const root = path.resolve(String(runtimeRoot || ''));
  const selectedHash = String(qualificationRequestHash || '').toLowerCase();
  if (!path.isAbsolute(String(runtimeRoot || ''))
    || root === path.parse(root).root
    || !SHA256.test(selectedHash)) {
    throw new Error('gpu_scientific_campaign_qualification_intake_scope_invalid');
  }
  return path.join(
    root,
    'external-qualification-intake',
    'gpu-scientific',
    selectedHash.slice('sha256:'.length),
    INTAKE_FILE_NAME,
  );
}

export function createGpuScientificCampaignQualificationIntakeRepository({
  runtimeRoot,
} = {}) {
  const root = path.resolve(String(runtimeRoot || ''));
  if (!path.isAbsolute(String(runtimeRoot || ''))
    || root === path.parse(root).root) {
    throw new Error('gpu_scientific_campaign_qualification_intake_scope_invalid');
  }
  return Object.freeze({
    version: 1,
    kind: 'GpuScientificCampaignQualificationIntakeRepository',
    resolve({ request } = {}) {
      if (!verifyGpuScientificCampaignQualificationRequest(request)) {
        throw new Error(
          'gpu_scientific_campaign_qualification_intake_request_invalid',
        );
      }
      const candidate = gpuScientificCampaignQualificationIntakePath({
        runtimeRoot: root,
        qualificationRequestHash:
          request.gpuScientificCampaignQualificationRequestHash,
      });
      if (!fs.existsSync(candidate)) return null;
      assertOwnedPrivateDirectory(
        path.dirname(candidate),
        'gpu_scientific_campaign_qualification_intake_directory_unsafe',
      );
      assertOwnedPrivateFile(candidate);
      const read = readScopedFileSync({
        scopeRoot: root,
        candidate,
        maximumBytes: MAXIMUM_INTAKE_BYTES,
      });
      if (read.status !== 'scoped_file_read_verified') {
        throw new Error(
          'gpu_scientific_campaign_qualification_intake_read_invalid',
        );
      }
      let evidence;
      try { evidence = JSON.parse(read.content.toString('utf8')); }
      catch {
        throw new Error(
          'gpu_scientific_campaign_qualification_intake_json_invalid',
        );
      }
      if (!verifyGpuScientificCampaignQualificationEvidence(evidence)
        || evidence.gpuScientificCampaignQualificationRequestHash
          !== request.gpuScientificCampaignQualificationRequestHash
        || JSON.stringify(evidence.gpuScientificCampaignQualificationRequest)
          !== JSON.stringify(request)) {
        throw new Error(
          'gpu_scientific_campaign_qualification_intake_binding_invalid',
        );
      }
      return Object.freeze({
        evidence,
        path: candidate,
        fileHash: read.hash,
        fileBytes: read.bytes,
        readReceiptHash: read.scopedFileReadReceiptHash,
      });
    },
  });
}
