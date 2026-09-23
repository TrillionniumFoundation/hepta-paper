import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  inspectAdvancedNumericalReferenceCandidateQualifications,
} from '../../paper-composition/automation/advanced-numerical-reference-qualification-composition.mjs';
import {
  ADVANCED_NUMERICAL_PLUGIN_QUALIFICATION_ROLES,
} from '../../paper-domain/research/advanced-numerical-plugin-qualification-contract.mjs';
import { hashBytes, hashRecord } from '../../workflow-kernel/record-hash.mjs';

const H = (character) => `sha256:${character.repeat(64)}`;
const NOW = new Date('2026-07-28T14:00:00.000Z');

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value), { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
  return hashBytes(fs.readFileSync(filePath));
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(
    os.tmpdir(),
    'hepta-numerical-qualification-registry-',
  ));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const entrypoint = Buffer.from('print("reference")\n');
  fs.writeFileSync(path.join(root, 'worker.py'), entrypoint);
  const manifest = {
    version: 1,
    kind: 'AdvancedNumericalReferenceCandidateManifest',
    entrypoint: 'worker.py',
    analysisFamilies: ['linear-algebra', 'monte-carlo', 'optimization'],
  };
  const snapshot = {
    merkleHash: H('1'),
    manifestHash: H('2'),
  };
  return {
    root,
    entrypoint,
    manifest,
    snapshot,
    manifestHash: hashRecord(
      'AdvancedNumericalReferenceCandidateManifest',
      manifest,
    ),
  };
}

function writeQualifiedRegistry(value) {
  const configurations = value.manifest.analysisFamilies.map((analysisFamily) => {
    const prefix = path.join(value.root, analysisFamily);
    const bundlePath = `${prefix}.bundle.json`;
    const trustStorePath = `${prefix}.trust.json`;
    const qualificationPath = `${prefix}.qualification.json`;
    const evidencePath = `${prefix}.qualification-evidence.json`;
    const qualificationTrustStorePath = `${prefix}.qualification-trust.json`;
    const signedBundleFileHash = writeJson(bundlePath, {
      version: 1,
      kind: 'Fixture',
      fixtureAnalysisFamily: analysisFamily,
    });
    const trustStoreFileHash = writeJson(trustStorePath, {
      version: 1,
      kind: 'FixturePluginTrustStore',
      fixtureAnalysisFamily: analysisFamily,
    });
    const qualificationFileHash = writeJson(qualificationPath, {
      version: 1,
      kind: 'FixtureQualification',
      fixtureAnalysisFamily: analysisFamily,
      advancedNumericalPluginQualificationStatementHash: H('7'),
    });
    const qualificationEvidenceFileHash = writeJson(evidencePath, {
      version: 1,
      kind: 'FixtureQualificationEvidence',
      fixtureAnalysisFamily: analysisFamily,
      advancedNumericalPluginQualificationEvidenceBundleHash: H('8'),
    });
    const qualificationTrustStoreFileHash = writeJson(
      qualificationTrustStorePath,
      {
        version: 1,
        kind: 'FixtureQualificationTrustStore',
        fixtureAnalysisFamily: analysisFamily,
      },
    );
    const configurationPath = `${prefix}.json`;
    const configuration = {
      version: 2,
      kind: 'AdvancedNumericalPluginRuntimeConfiguration',
      signedBundlePath: path.basename(bundlePath),
      signedBundleFileHash,
      trustStorePath: path.basename(trustStorePath),
      trustStoreFileHash,
      qualificationPath: path.basename(qualificationPath),
      qualificationFileHash,
      qualificationEvidencePath: path.basename(evidencePath),
      qualificationEvidenceFileHash,
      qualificationTrustStorePath: path.basename(qualificationTrustStorePath),
      qualificationTrustStoreFileHash,
      pluginRoot: '.',
      outputRoot: 'output',
    };
    const runtimeConfigurationHash = writeJson(
      configurationPath,
      configuration,
    );
    return {
      analysisFamily,
      runtimeConfigurationPath: path.basename(configurationPath),
      runtimeConfigurationHash,
    };
  });
  fs.mkdirSync(path.join(value.root, 'output'));
  const registryPath = path.join(value.root, 'registry.json');
  const registryHash = writeJson(registryPath, {
    version: 2,
    kind: 'AdvancedNumericalReferenceCandidateQualificationRegistry',
    candidateManifestHash: value.manifestHash,
    candidateSourceMerkleHash: value.snapshot.merkleHash,
    candidateSourceWorkspaceManifestHash: value.snapshot.manifestHash,
    entries: configurations,
  });
  return {
    registryPath,
    registryHash,
    configurations,
  };
}

function qualifiedRuntimeComposer(value, entrypointHash) {
  return ({ bundle, qualification, qualificationEvidence, pluginRoot }) => {
    const { fixtureAnalysisFamily: analysisFamily } = bundle;
    return {
      descriptor: {
        pluginId: `hepta.reference.${analysisFamily}`,
        pluginVersion: '1.0.0',
        analysisFamily,
        runtime: {
          executableHash: H('4'),
          packageClosureHash: H('5'),
        },
        entrypoint: { relativePath: 'worker.py', sha256: entrypointHash },
        sourceIdentity: {
          merkleHash: value.snapshot.merkleHash,
          workspaceManifestHash: value.snapshot.manifestHash,
        },
      },
      verifiedBundle: { signedBundleHash: H('6') },
      runner: {
        capabilities: () => ({
          productionQualified:
            path.resolve(pluginRoot) === path.resolve(value.root),
          qualificationStatementHash:
            qualification.advancedNumericalPluginQualificationStatementHash,
          qualificationEvidenceBundleHash:
            qualificationEvidence
              .advancedNumericalPluginQualificationEvidenceBundleHash,
          qualificationInspectionHash: H('c'),
          pluginAuthoritySubjectIds: [
            `plugin-authority-${analysisFamily}`,
          ],
          pluginAuthorityOrganizations: [
            `plugin-organization-${analysisFamily}`,
          ],
          pluginAuthorityPublicKeySpkiHashes: [H('e')],
          qualificationAuthoritySubjectIds:
            ADVANCED_NUMERICAL_PLUGIN_QUALIFICATION_ROLES.map((role) => (
              `${role}-${analysisFamily}`
            )),
          qualificationAuthorityOrganizations:
            ADVANCED_NUMERICAL_PLUGIN_QUALIFICATION_ROLES.map((role) => (
              `${role}-organization-${analysisFamily}`
            )).sort(),
          qualificationAuthorityPublicKeySpkiHashes:
            ['0', '1', '2', '3'].map((character) => H(character)),
          qualificationAuthorityRoles:
            [...ADVANCED_NUMERICAL_PLUGIN_QUALIFICATION_ROLES].sort(),
          evidenceReceiptHashes: {
            independentNumericOracleReceiptHash: H('a'),
            referenceExecutionReceiptHash: H('b'),
            replayExecutionReceiptHash: H('c'),
            scientificReviewReceiptHash: H('d'),
            typedUncertaintyReviewReceiptHash: H('e'),
          },
          qualificationExpiresAt:
            new Date(NOW.getTime() + 60_000).toISOString(),
          referenceExecutionProcessIdentityHash: H('a'),
          replayExecutionProcessIdentityHash: H('b'),
          qualificationResultHash: H('d'),
        }),
      },
    };
  };
}

test('missing, unpinned, forged, or drifted numerical registries stay fail-closed', (t) => {
  const value = fixture(t);
  const entrypointHash = hashBytes(value.entrypoint);
  const unconfigured = inspectAdvancedNumericalReferenceCandidateQualifications({
    candidateRoot: value.root,
    candidateManifest: value.manifest,
    candidateSnapshot: value.snapshot,
    entrypointHash,
  });
  assert.equal(unconfigured.every((candidate) => (
    candidate.productionQualified === false
    && candidate.fullProductionReady === false
    && candidate.registryConfigured === false
    && candidate.qualificationBlockers.includes(
      'advanced_numerical_reference_qualification_registry_path_required',
    )
  )), true);

  const registryPath = path.join(value.root, 'registry.json');
  writeJson(registryPath, {
    version: 1,
    kind: 'AdvancedNumericalReferenceCandidateQualificationRegistry',
    entries: value.manifest.analysisFamilies.map((analysisFamily) => ({
      analysisFamily,
      runtimeConfigurationPath: `${analysisFamily}.json`,
      runtimeConfigurationHash: H('3'),
      productionQualified: true,
    })),
  });
  const unpinned = inspectAdvancedNumericalReferenceCandidateQualifications({
    candidateRoot: value.root,
    candidateManifest: value.manifest,
    candidateSnapshot: value.snapshot,
    entrypointHash,
    registryPath,
    runtimeComposer() {
      throw new Error('unpinned registry must fail before runtime composition');
    },
  });
  assert.equal(unpinned.every((candidate) => (
    candidate.registryConfigured === true
    && candidate.registryPinned === false
    && candidate.qualificationBlockers.includes(
      'advanced_numerical_reference_qualification_registry_pin_required',
    )
  )), true);

  const forged = inspectAdvancedNumericalReferenceCandidateQualifications({
    candidateRoot: value.root,
    candidateManifest: value.manifest,
    candidateSnapshot: value.snapshot,
    entrypointHash,
    registryPath,
    registryHash: hashBytes(fs.readFileSync(registryPath)),
    runtimeComposer() {
      throw new Error('forged registry must fail before runtime composition');
    },
  });
  assert.equal(forged.every((candidate) => (
    candidate.productionQualified === false
    && candidate.qualificationBlockers.includes(
      'advanced_numerical_reference_qualification_registry_invalid',
    )
  )), true, JSON.stringify(forged));

  const drifted = inspectAdvancedNumericalReferenceCandidateQualifications({
    candidateRoot: value.root,
    candidateManifest: value.manifest,
    candidateSnapshot: value.snapshot,
    entrypointHash,
    registryPath,
    registryHash: H('0'),
  });
  assert.equal(drifted.every((candidate) => (
    candidate.qualificationBlockers.includes(
      'advanced_numerical_plugin_document_hash_mismatch',
    )
  )), true);
});

test('registry integration promotes all three identity-matched pinned runtimes', (t) => {
  const value = fixture(t);
  const entrypointHash = hashBytes(value.entrypoint);
  const registry = writeQualifiedRegistry(value);
  const qualified = inspectAdvancedNumericalReferenceCandidateQualifications({
    candidateRoot: value.root,
    candidateManifest: value.manifest,
    candidateSnapshot: value.snapshot,
    entrypointHash,
    registryPath: registry.registryPath,
    registryHash: registry.registryHash,
    now: NOW,
    runtimeComposer: qualifiedRuntimeComposer(value, entrypointHash),
  });
  assert.equal(qualified.length, 3);
  assert.equal(qualified.every((candidate) => (
    candidate.productionQualified === true
    && candidate.fullProductionReady === true
    && candidate.status === 'reference_candidate_full_production_qualified'
    && candidate.registryPinned === true
    && candidate.runtimeConfigurationPinned === true
    && candidate.dependentDocumentsPinned === true
    && candidate.qualificationAuthoritySubjectIds.length === 4
    && candidate.qualificationBlockers.length === 0
  )), true, JSON.stringify(qualified));
});

test('dependency hash drift and hardlinks block individual numerical candidates', (t) => {
  const value = fixture(t);
  const entrypointHash = hashBytes(value.entrypoint);
  const registry = writeQualifiedRegistry(value);
  const driftedEvidencePath = path.join(
    value.root,
    'linear-algebra.qualification-evidence.json',
  );
  fs.appendFileSync(driftedEvidencePath, '\n');
  const hardlinkedTrustPath = path.join(value.root, 'monte-carlo.trust.json');
  fs.linkSync(
    hardlinkedTrustPath,
    path.join(value.root, 'monte-carlo.trust.hardlink.json'),
  );
  const inspected = inspectAdvancedNumericalReferenceCandidateQualifications({
    candidateRoot: value.root,
    candidateManifest: value.manifest,
    candidateSnapshot: value.snapshot,
    entrypointHash,
    registryPath: registry.registryPath,
    registryHash: registry.registryHash,
    now: NOW,
    runtimeComposer: qualifiedRuntimeComposer(value, entrypointHash),
  });
  const linearAlgebra = inspected.find((candidate) => (
    candidate.analysisFamily === 'linear-algebra'
  ));
  const monteCarlo = inspected.find((candidate) => (
    candidate.analysisFamily === 'monte-carlo'
  ));
  const optimization = inspected.find((candidate) => (
    candidate.analysisFamily === 'optimization'
  ));
  assert.equal(linearAlgebra.fullProductionReady, false);
  assert.ok(linearAlgebra.qualificationBlockers.includes(
    'advanced_numerical_plugin_document_hash_mismatch',
  ), JSON.stringify(linearAlgebra));
  assert.equal(monteCarlo.fullProductionReady, false);
  assert.ok(monteCarlo.qualificationBlockers.includes(
    'advanced_numerical_plugin_document_integrity_invalid',
  ));
  assert.equal(optimization.fullProductionReady, true);
});
