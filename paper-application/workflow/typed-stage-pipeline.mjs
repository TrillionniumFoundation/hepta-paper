// Shared application orchestration for stages that must use the same trust and
// persistence services in batch and local-diagnostic flows.
export function createTypedStagePipeline({ root, runtimeRoot, row, services } = {}) {
  if (!root || !runtimeRoot || !row || !services?.paperStageAdapters) throw new Error('typed stage pipeline requires execution context');
  const { runEmpiricalAnalysisAdapter, runLatexBuildAdapter, runPackageAdapter, runResearchVerifyAdapter } = services.paperStageAdapters;
  if (!runEmpiricalAnalysisAdapter || !runLatexBuildAdapter || !runPackageAdapter || !runResearchVerifyAdapter) throw new Error('typed stage pipeline adapters missing');
  return Object.freeze({
    build({ execute = false } = {}) {
      return runLatexBuildAdapter({ root, row, runtimeRoot, execute });
    },
    package({ buildResult, researchReport = null, execute = false } = {}) {
      return runPackageAdapter({ root, row, buildResult, researchReport, runtimeRoot, execute, store: services.store });
    },
    research({ executeWorkers = false, requireNativeWorkers = false } = {}) {
      return runResearchVerifyAdapter({
        root, row, runtimeRoot, executeResearchWorkers: executeWorkers, requireNativeWorkers,
        authorityVerifier: services.authorityVerifier, jobReceiptStore: services.jobReceiptStore,
        artifactRepositoryFactory: services.artifactRepositoryFactory, receiptLedger: services.receiptLedger,
        trustedResearchReceiptWriters: services.trustedResearchReceiptWriters,
        clock: services.clock, store: services.store,
      });
    },
    empirical({ targetProfile = null, targetSelectionPolicy = null, datasetRoot = null, benchmarkId = null, applyManuscript = false, execute = false } = {}) {
      return runEmpiricalAnalysisAdapter({ root, runtimeRoot, row, targetProfile, targetSelectionPolicy, datasetRoot, benchmarkId, applyManuscript, execute, artifactRepositoryFactory: services.artifactRepositoryFactory, trustedResearchReceiptWriters: services.trustedResearchReceiptWriters, clock: services.clock });
    },
    async buildAndPackage({ researchReport = null, executeBuild = false, executePackage = false } = {}) {
      const buildResult = await this.build({ execute: executeBuild });
      const packageResult = await this.package({ buildResult, researchReport, execute: executePackage });
      return Object.freeze({ buildResult, packageResult });
    },
  });
}
