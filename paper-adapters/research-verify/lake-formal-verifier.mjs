import fsp from 'node:fs/promises';
import path from 'node:path';
import { assertFormalVerifierPort } from '../../paper-ports/formal-verifier-port.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';

async function fileReceipt(root, relative) {
  const absolute = path.join(root, relative);
  const bytes = await fsp.readFile(absolute);
  return { path: relative, hash: hashBytes(bytes), bytes: bytes.length };
}

export function createLakeFormalVerifier({ projectRoot, commandRunner, executable = 'lake' } = {}) {
  return assertFormalVerifierPort({
    version: 1,
    kind: 'LakeFormalVerifierAdapter',
    verifierId: 'lean-lake-certificate-v1',
    async verify({ expectedInputs = [], timeoutMs = 120000 } = {}) {
      const blockers = [];
      const required = ['lakefile.lean', 'lean-toolchain', 'lake-manifest.json'];
      const projectFiles = [];
      for (const relative of required) {
        try { projectFiles.push(await fileReceipt(projectRoot, relative)); }
        catch { blockers.push(`formal_project_file_missing:${relative}`); }
      }
      for (const expected of expectedInputs) {
        try {
          const actual = await fileReceipt(projectRoot, expected.path);
          if (actual.hash !== expected.hash) blockers.push(`formal_input_hash_mismatch:${expected.path}`);
          projectFiles.push(actual);
        } catch { blockers.push(`formal_input_missing:${expected.path}`); }
      }
      if (blockers.length) return { status: 'formal_verifier_blocked', blockers };
      const execution = await commandRunner.run({
        executable,
        args: ['build'],
        cwd: projectRoot,
        timeoutMs,
        outputPaths: ['.lake'],
        env: {
          ELAN_HOME: process.env.ELAN_HOME || `${process.env.HOME || ''}/.elan`,
          ELAN_TOOLCHAIN: process.env.ELAN_TOOLCHAIN || 'leanprover/lean4:v4.30.0',
        },
      });
      const bundle = {
        version: 1,
        kind: 'FormalCertificateBundle',
        verifierId: 'lean-lake-certificate-v1',
        status: execution.ok ? 'formal_certificate_verified' : 'formal_certificate_blocked',
        projectFiles: projectFiles.sort((a, b) => a.path.localeCompare(b.path)),
        toolchainHash: projectFiles.find((file) => file.path === 'lean-toolchain')?.hash || null,
        manifestHash: projectFiles.find((file) => file.path === 'lake-manifest.json')?.hash || null,
        executionReceiptHash: execution.receiptHash || null,
        isolation: execution.isolation || null,
        blockers: execution.ok ? [] : ['lake_build_failed', ...(execution.blockers || [])],
        externalActionPerformed: false,
      };
      return { ...bundle, certificateBundleHash: hashRecord('FormalCertificateBundle', bundle) };
    },
    async replay({ certificateBundle } = {}) {
      if (certificateBundle?.status !== 'formal_certificate_verified') return { status: 'formal_certificate_replay_blocked', blockers: ['certificate_bundle_not_verified'] };
      const current = [];
      for (const expected of certificateBundle.projectFiles || []) {
        try { current.push(await fileReceipt(projectRoot, expected.path)); }
        catch { return { status: 'formal_certificate_replay_blocked', blockers: [`formal_input_missing:${expected.path}`] }; }
      }
      const mismatches = current.filter((actual) => certificateBundle.projectFiles.find((expected) => expected.path === actual.path)?.hash !== actual.hash);
      return { status: mismatches.length ? 'formal_certificate_replay_blocked' : 'formal_certificate_replay_verified', blockers: mismatches.map((item) => `formal_input_hash_mismatch:${item.path}`) };
    },
  });
}
