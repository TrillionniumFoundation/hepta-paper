import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createLakeFormalVerifier } from '../../paper-adapters/research-verify/lake-formal-verifier.mjs';
import { createLeanToolchainIdentityProvider } from '../../paper-adapters/research-verify/lean-toolchain-identity.mjs';
import { resolvePinnedLakeExecutable } from '../../paper-adapters/research-verify/pinned-lake-executable-resolver.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';

export function createFormalCapabilityReplayRunners({ workspaceRoot }) {
  async function replayFormalVerifier(root) {
    const projectRoot = path.join(root, 'formal-project');
    fs.cpSync(path.join(workspaceRoot, 'migration', 'fixtures', 'lean-adversarial'), projectRoot, { recursive: true });
    const commandRunner = {
      async run({ executable, args = [], cwd, timeoutMs = 120000 } = {}) {
        const result = spawnSync(executable, args, { cwd, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, NO_PROXY: '*', no_proxy: '*' } });
        const payload = { version: 1, kind: 'ProductionFormalCommandReceipt', executable: path.basename(String(executable)), args: args.map(String), exitCode: result.status, stdoutHash: hashBytes(String(result.stdout || '')), stderrHash: hashBytes(String(result.stderr || result.error?.message || '')), externalActionPerformed: false };
        return { ok: result.status === 0 && !result.error, status: result.status === 0 && !result.error ? 'production_formal_command_passed' : 'production_formal_command_failed', stdout: String(result.stdout || ''), stderr: String(result.stderr || result.error?.message || ''), exitCode: result.status, receiptHash: hashRecord('ProductionFormalCommandReceipt', payload), isolation: { networkPolicy: 'none_by_operational_contract', sourceMutationPerformed: false, externalActionPerformed: false } };
      },
    };
    const pinnedRuntime = resolvePinnedLakeExecutable();
    if (pinnedRuntime.status !== 'formal_pinned_lake_resolved') throw new Error(pinnedRuntime.blockers.join(','));
    const verifier = createLakeFormalVerifier({
      projectRoot,
      commandRunner,
      executable: pinnedRuntime.lakeExecutable,
      toolchainIdentityProvider: createLeanToolchainIdentityProvider({
        toolchain: pinnedRuntime.toolchain,
        toolchainRoot: pinnedRuntime.toolchainRoot,
        leanExecutable: pinnedRuntime.leanExecutable,
        lakeExecutable: pinnedRuntime.lakeExecutable,
        expectedToolchainRootMerkleHash: pinnedRuntime.expectedToolchainRootMerkleHash,
        requiredOwnerUid: 0,
        requiredOwnerGid: 0,
        forbidGroupOrOtherWrite: true,
      }),
    });
    const certificate = await verifier.verify({ timeoutMs: 120000 });
    const replay = await verifier.replay({ certificateBundle: certificate });
    return { certificateStatus: certificate.status, replayStatus: replay.status, projectFiles: certificate.projectFiles?.map((item) => ({ path: item.path, hash: item.hash })).sort((a, b) => a.path.localeCompare(b.path)), toolchainHash: certificate.toolchainHash, manifestHash: certificate.manifestHash, externalActionPerformed: certificate.externalActionPerformed };
  }

  return Object.freeze({
    'research.formal-verifier': replayFormalVerifier,
  });
}
