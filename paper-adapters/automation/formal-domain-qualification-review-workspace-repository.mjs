import fs from 'node:fs';
import path from 'node:path';

export function materializeFormalDomainQualificationReviewWorkspace({
  runtimeRoot,
  coverageReceipt,
} = {}) {
  if (!runtimeRoot || !coverageReceipt?.formalDomainCoverageReceiptHash) {
    throw new Error('formal_domain_qualification_review_workspace_inputs_required');
  }
  const workspacePath = fs.mkdtempSync(
    path.join(path.resolve(runtimeRoot), 'formal-domain-review-'),
  );
  try {
    fs.chmodSync(workspacePath, 0o700);
    fs.writeFileSync(
      path.join(workspacePath, 'formal-domain-coverage.json'),
      `${JSON.stringify(coverageReceipt, null, 2)}\n`,
      { mode: 0o600 },
    );
  } catch (error) {
    fs.rmSync(workspacePath, { recursive: true, force: true });
    throw error;
  }
  let disposed = false;
  return Object.freeze({
    workspacePath,
    dispose() {
      if (disposed) return;
      disposed = true;
      fs.rmSync(workspacePath, { recursive: true, force: true });
    },
  });
}
