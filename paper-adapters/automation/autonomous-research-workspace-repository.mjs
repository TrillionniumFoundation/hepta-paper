import fs from 'node:fs';
import path from 'node:path';
import { hashBytes } from '../../workflow-kernel/record-hash.mjs';
import { writeDurableJsonSync } from '../runtime/durable-json-repository.mjs';
import {
  verifyAutonomousVenueTemplateAssetRecord,
} from '../../paper-domain/automation/autonomous-venue-template-asset-contract.mjs';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const ALLOWED_FILES = new Set([
  'AUTONOMOUS_RESEARCH_SEED_CONTRACTS.json',
  'AUTONOMOUS_RESEARCH_PROPOSAL.json',
  'AUTONOMOUS_RESEARCH_POLICY_AUTHORIZATION.json',
  'AUTONOMOUS_HYPOTHESIS_GENERATION_RECEIPT.json',
  'AUTONOMOUS_PRIOR_ART_EVIDENCE.json',
  'AUTONOMOUS_RESEARCH_AGENDA_IR.json',
  'AUTONOMOUS_RESEARCH_AGENDA_CLAIM_BINDING.json',
  'AUTONOMOUS_VENUE_PROFILE_SELECTION.json',
  'AUTONOMOUS_VENUE_REQUIREMENT_IR.json',
  'AUTONOMOUS_SUBMISSION_METADATA.json',
  'AUTONOMOUS_MANUSCRIPT_IR_DRAFT.json',
  'AUTONOMOUS_EMPIRICAL_CLAIM_LINEAGE.json',
  'main.tex',
  'README.md',
]);

function textHash(value) {
  return hashBytes(Buffer.from(value, 'utf8'));
}

function venueTemplateAssetTarget(sourceWorkspace, record) {
  if (!verifyAutonomousVenueTemplateAssetRecord(record)) {
    throw new Error('autonomous_research_workspace_venue_template_asset_invalid');
  }
  const segments = record.relativePath.split('/');
  let parent = sourceWorkspace;
  for (const segment of segments.slice(0, -1)) {
    const directory = path.join(parent, segment);
    let identity = null;
    try { identity = fs.lstatSync(directory); } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      fs.mkdirSync(directory, { mode: 0o700 });
      identity = fs.lstatSync(directory);
    }
    if (!identity.isDirectory() || identity.isSymbolicLink()) {
      throw new Error('autonomous_research_workspace_venue_template_path_unsafe');
    }
    parent = directory;
  }
  return path.join(parent, segments.at(-1));
}

export function createAutonomousResearchWorkspaceRepository({ runtimeRoot, paperId, create = true } = {}) {
  if (!runtimeRoot || !SAFE_ID.test(String(paperId || ''))) {
    throw new Error('autonomous_research_workspace_repository_scope_invalid');
  }
  const sourceWorkspace = path.join(path.resolve(runtimeRoot), 'autonomous-research', paperId, 'source');
  if (create) fs.mkdirSync(sourceWorkspace, { recursive: true, mode: 0o700 });
  const candidate = (name) => {
    if (!ALLOWED_FILES.has(name)) throw new Error('autonomous_research_workspace_file_not_allowed');
    return path.join(sourceWorkspace, name);
  };
  return Object.freeze({
    version: 1,
    kind: 'AutonomousResearchWorkspaceRepository',
    sourceWorkspace,
    writeJsonOnce(name, value) {
      if (!create) throw new Error('autonomous_research_workspace_repository_read_only');
      const target = candidate(name);
      const encoded = `${JSON.stringify(value, null, 2)}\n`;
      if (fs.existsSync(target)) {
        const existing = fs.readFileSync(target, 'utf8');
        if (existing !== encoded) throw new Error(`autonomous_research_workspace_record_conflict:${name}`);
        return textHash(existing);
      }
      writeDurableJsonSync(target, value);
      return textHash(encoded);
    },
    writeTextOnce(name, value) {
      if (!create) throw new Error('autonomous_research_workspace_repository_read_only');
      const target = candidate(name);
      if (fs.existsSync(target)) {
        const existing = fs.readFileSync(target, 'utf8');
        if (existing !== value) throw new Error(`autonomous_research_workspace_record_conflict:${name}`);
        return textHash(existing);
      }
      fs.writeFileSync(target, value, { flag: 'wx', mode: 0o600 });
      return textHash(value);
    },
    writeVenueTemplateAssetOnce(record) {
      if (!create) throw new Error('autonomous_research_workspace_repository_read_only');
      const target = venueTemplateAssetTarget(sourceWorkspace, record);
      const bytes = Buffer.from(record.bytesBase64, 'base64');
      if (fs.existsSync(target)) {
        const identity = fs.lstatSync(target);
        if (!identity.isFile() || identity.isSymbolicLink()) {
          throw new Error('autonomous_research_workspace_venue_template_path_unsafe');
        }
        const existing = fs.readFileSync(target);
        if (!existing.equals(bytes)) {
          throw new Error(
            `autonomous_research_workspace_venue_template_conflict:${record.relativePath}`,
          );
        }
        return hashBytes(existing);
      }
      fs.writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 });
      return hashBytes(bytes);
    },
  });
}
