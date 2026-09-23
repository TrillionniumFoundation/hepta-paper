import { uniqueStrings } from '../../workflow-kernel/runtime/text-utils.mjs';
import { hashPaperRecord } from '../../paper-domain/contracts/primitives.mjs';

export function buildEmpiricalEvidenceGate({
  paperTask,
  plan,
  datasetContract,
  datasetLicenseProvenanceGate,
  tableFigureSpec,
  runReceipt,
  resultPackage,
  createdAt,
}) {
  const validationBlockers = [];
  if (plan.status !== 'empirical_analysis_plan_ready') validationBlockers.push('empirical_analysis_plan_not_ready');
  if (datasetContract.status !== 'dataset_access_contract_ready') validationBlockers.push('dataset_access_contract_not_ready');
  if (datasetLicenseProvenanceGate?.status !== 'dataset_license_provenance_gate_ready') {
    validationBlockers.push('dataset_license_provenance_gate_not_ready');
  }
  if (tableFigureSpec?.status !== 'table_figure_spec_ready') {
    validationBlockers.push('table_figure_spec_not_ready');
  }
  if (runReceipt.status !== 'experiment_run_receipt_recorded') validationBlockers.push('experiment_run_receipt_not_recorded');
  if (resultPackage.status !== 'result_artifact_package_ready') validationBlockers.push('result_artifact_package_not_ready');
  const academicBlockers = [
    'generated_simulator_outcomes_preprogrammed',
    'independent_empirical_method_implementation_missing',
    'academic_evidence_attestation_missing',
  ];
  const blockers = [...validationBlockers, ...academicBlockers];
  const gate = {
    version: 1,
    kind: 'EmpiricalEvidenceGate',
    paperId: paperTask?.paperId || null,
    taskKey: paperTask?.taskKey || null,
    status: 'empirical_evidence_gate_blocked',
    smokeValidationStatus: validationBlockers.length
      ? 'empirical_smoke_validation_blocked'
      : 'empirical_smoke_validation_ready',
    empiricalAnalysisPlanHash: plan.empiricalAnalysisPlanHash,
    datasetAccessContractHash: datasetContract.datasetAccessContractHash,
    datasetLicenseProvenanceGateHash: datasetLicenseProvenanceGate?.datasetLicenseProvenanceGateHash || null,
    tableFigureSpecHash: tableFigureSpec?.tableFigureSpecHash || null,
    experimentRunReceiptHash: runReceipt.experimentRunReceiptHash,
    resultArtifactPackageHash: resultPackage.resultArtifactPackageHash,
    evidenceMode: 'pipeline_smoke_only',
    academicEvidenceEligible: false,
    academicPromotionEligible: false,
    evidenceClass: 'compatibility-smoke-evidence',
    promotionScope: 'compatibility_only',
    validationBlockers: uniqueStrings(validationBlockers, 32),
    academicBlockers,
    blockers: uniqueStrings(blockers, 32),
    safety: {
      localOnly: true,
      generatedDataDeclared: datasetContract.datasetMode !== 'authorized_local_dataset',
      authorizedLocalData: datasetContract.datasetMode === 'authorized_local_dataset',
      outcomesPreprogrammed: true,
      academicEvidenceEligible: false,
      externalDataAccess: false,
      sourceMutation: false,
      externalActionPerformed: false,
    },
    createdAt,
  };
  return {
    ...gate,
    empiricalEvidenceGateHash: hashPaperRecord('EmpiricalEvidenceGate', gate),
  };
}
