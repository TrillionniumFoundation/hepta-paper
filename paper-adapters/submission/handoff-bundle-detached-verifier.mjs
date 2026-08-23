import path from 'node:path';

import { hashRecord } from '../../workflow-kernel/record-hash.mjs';
import {
  readScopedFileSync,
} from '../../workflow-kernel/runtime/scoped-file-identity.mjs';
import {
  inspectSubmissionHandoffDetachedRecordGraph,
  readSubmissionHandoffDetachedRecordMap,
} from './handoff-bundle-detached-records.mjs';
import {
  inspectSubmissionHandoffBundleExactTreeSync,
} from './handoff-bundle-integrity.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const TRUSTED_ANCHOR_KEYS = Object.freeze([
  'campaignReleaseBundleHash',
  'dispatchAuthorizationHash',
  'kind',
  'submissionHandoffBundleManifestHash',
  'submissionHandoffExportAuthorityHash',
  'submissionHandoffExportRequestHash',
  'version',
]);

function hasExactKeys(value, expected) {
  return value && typeof value === 'object'
    && Object.keys(value).sort().join('\0') === [...expected].sort().join('\0');
}

function trustedAnchorValid(anchor) {
  return hasExactKeys(anchor, TRUSTED_ANCHOR_KEYS)
    && anchor.version === 1
    && anchor.kind === 'SubmissionHandoffDetachedTrustedAnchor'
    && [
      anchor.submissionHandoffBundleManifestHash,
      anchor.submissionHandoffExportRequestHash,
      anchor.submissionHandoffExportAuthorityHash,
      anchor.campaignReleaseBundleHash,
      anchor.dispatchAuthorizationHash,
    ].every((value) => SHA256.test(String(value || '')));
}

function inspectTrustedRootBindings(manifest, trustedAnchor) {
  return [
    [manifest.submissionHandoffBundleManifestHash,
      trustedAnchor.submissionHandoffBundleManifestHash,
      'handoff_bundle_detached_manifest_anchor_mismatch'],
    [manifest.submissionHandoffExportRequestHash,
      trustedAnchor.submissionHandoffExportRequestHash,
      'handoff_bundle_detached_request_anchor_mismatch'],
    [manifest.submissionHandoffExportAuthorityHash,
      trustedAnchor.submissionHandoffExportAuthorityHash,
      'handoff_bundle_detached_authority_anchor_mismatch'],
    [manifest.campaignReleaseBundleHash,
      trustedAnchor.campaignReleaseBundleHash,
      'handoff_bundle_detached_release_anchor_mismatch'],
    [manifest.dispatchAuthorizationHash,
      trustedAnchor.dispatchAuthorizationHash,
      'handoff_bundle_detached_dispatch_anchor_mismatch'],
  ].filter(([actual, expected]) => actual !== expected)
    .map(([, , blocker]) => blocker);
}

function externalVerification({
  authorityVerifiers,
  manifest,
  records,
  trustedAnchor,
}) {
  const externalAuthorityBlockers = [];
  const providerActionBlockers = [];
  let externalAuthorityVerified = false;
  let providerActionAuthorized = false;
  if (typeof authorityVerifiers?.verifyExternalAuthority !== 'function') {
    externalAuthorityBlockers.push(
      'handoff_bundle_external_authority_verifier_required',
    );
  } else {
    try {
      const result = authorityVerifiers.verifyExternalAuthority(Object.freeze({
        manifest,
        records,
        trustedAnchor,
      }));
      externalAuthorityVerified = result?.verified === true
        && (!Array.isArray(result.blockers) || result.blockers.length === 0);
      if (!externalAuthorityVerified) {
        externalAuthorityBlockers.push(...(
          Array.isArray(result?.blockers) && result.blockers.length
            ? result.blockers
            : ['handoff_bundle_external_authority_not_verified']
        ));
      }
    } catch (error) {
      externalAuthorityBlockers.push(
        `handoff_bundle_external_authority_verification_failed:${String(
          error?.message || 'verification_failed',
        )}`,
      );
    }
  }
  if (typeof authorityVerifiers?.verifyProviderActionAuthority !== 'function') {
    providerActionBlockers.push(
      'handoff_bundle_provider_action_authority_verifier_required',
    );
  } else if (!externalAuthorityVerified) {
    providerActionBlockers.push(
      'handoff_bundle_external_authority_required_for_provider_action',
    );
  } else {
    try {
      const result = authorityVerifiers.verifyProviderActionAuthority(
        Object.freeze({ manifest, records, trustedAnchor }),
      );
      providerActionAuthorized = result?.authorized === true
        && (!Array.isArray(result.blockers) || result.blockers.length === 0);
      if (!providerActionAuthorized) {
        providerActionBlockers.push(...(
          Array.isArray(result?.blockers) && result.blockers.length
            ? result.blockers
            : ['handoff_bundle_provider_action_not_authorized']
        ));
      }
    } catch (error) {
      providerActionBlockers.push(
        `handoff_bundle_provider_action_verification_failed:${String(
          error?.message || 'verification_failed',
        )}`,
      );
    }
  }
  return Object.freeze({
    externalAuthorityVerified,
    providerActionAuthorized,
    externalAuthorityBlockers: Object.freeze([
      ...new Set(externalAuthorityBlockers),
    ]),
    providerActionBlockers: Object.freeze([
      ...new Set(providerActionBlockers),
    ]),
  });
}

function unavailableExternalVerification() {
  return Object.freeze({
    externalAuthorityVerified: false,
    providerActionAuthorized: false,
    externalAuthorityBlockers: Object.freeze([
      'handoff_bundle_internal_lineage_required_for_external_authority',
    ]),
    providerActionBlockers: Object.freeze([
      'handoff_bundle_internal_lineage_required_for_provider_action',
    ]),
  });
}

export function verifyDetachedSubmissionHandoffBundle({
  authorityVerifiers = null,
  bundleRoot,
  trustedAnchor,
} = {}) {
  const blockers = [];
  let manifest = null;
  let integrityVerified = false;
  let internalLineageVerified = false;
  let records = new Map();
  if (!trustedAnchorValid(trustedAnchor)) {
    blockers.push('handoff_bundle_detached_trusted_anchor_required');
  } else {
    try {
      const root = path.resolve(bundleRoot || '.');
      const read = readScopedFileSync({
        scopeRoot: root,
        candidate: path.join(root, 'SUBMISSION_HANDOFF_MANIFEST.json'),
      });
      if (read.status !== 'scoped_file_read_verified') {
        throw new Error('handoff_bundle_manifest_unreadable');
      }
      manifest = JSON.parse(read.content.toString('utf8'));
      const inspected = inspectSubmissionHandoffBundleExactTreeSync({
        bundleRoot: root,
        manifestDocument: manifest,
        requireReadOnly: true,
      });
      integrityVerified = true;
      const anchorBlockers = inspectTrustedRootBindings(
        manifest,
        trustedAnchor,
      );
      if (anchorBlockers.length) {
        blockers.push(...anchorBlockers);
      } else {
        records = readSubmissionHandoffDetachedRecordMap({
          root,
          descriptors: inspected.detachedRecords,
        });
        blockers.push(...inspectSubmissionHandoffDetachedRecordGraph(records, {
          manifest,
        }));
        internalLineageVerified = blockers.length === 0;
      }
    } catch (error) {
      blockers.push(`handoff_bundle_detached_verification_failed:${String(
        error?.message || 'verification_failed',
      )}`);
    }
  }
  const external = internalLineageVerified
    ? externalVerification({
      authorityVerifiers,
      manifest,
      records,
      trustedAnchor,
    })
    : unavailableExternalVerification();
  const uniqueBlockers = Object.freeze([...new Set(blockers)]);
  const payload = {
    version: 1,
    kind: 'DetachedSubmissionHandoffBundleVerificationReceipt',
    status: internalLineageVerified
      ? 'submission_handoff_detached_internal_lineage_verified'
      : 'submission_handoff_detached_verification_blocked',
    bundleRoot: bundleRoot ? path.resolve(bundleRoot) : null,
    trustedAnchorHash: trustedAnchorValid(trustedAnchor)
      ? hashRecord('SubmissionHandoffDetachedTrustedAnchor', trustedAnchor)
      : null,
    submissionHandoffBundleManifestHash:
      trustedAnchor?.submissionHandoffBundleManifestHash || null,
    integrity: integrityVerified,
    internalLineage: internalLineageVerified,
    externalAuthority: external.externalAuthorityVerified,
    integrityVerified,
    internalLineageVerified,
    externalAuthorityVerified: external.externalAuthorityVerified,
    providerActionAuthorized: external.providerActionAuthorized,
    grantsExternalExecutionPermission: false,
    requiresCurrentAuthorityRevalidation: true,
    blockers: uniqueBlockers,
    externalAuthorityBlockers: external.externalAuthorityBlockers,
    providerActionBlockers: external.providerActionBlockers,
    externalActionPerformed: false,
  };
  return Object.freeze({
    ...payload,
    detachedSubmissionHandoffBundleVerificationReceiptHash: hashRecord(
      'DetachedSubmissionHandoffBundleVerificationReceipt',
      payload,
    ),
    manifest: internalLineageVerified ? Object.freeze(manifest) : null,
  });
}
