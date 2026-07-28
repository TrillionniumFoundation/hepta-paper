import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  inspectAdvancedNumericalReferenceCandidateQualifications,
} from '../../paper-composition/automation/advanced-numerical-reference-qualification-composition.mjs';
import { hashBytes } from '../../workflow-kernel/record-hash.mjs';

const H = (character) => `sha256:${character.repeat(64)}`;

function fixture(t) {
  const root = fs.mkdtempSync(path.join(
    os.tmpdir(),
    'hepta-numerical-qualification-registry-',
  ));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const entrypoint = Buffer.from('print("reference")\n');
  fs.writeFileSync(path.join(root, 'worker.py'), entrypoint);
  return {
    root,
    entrypoint,
    manifest: {
      version: 1,
      kind: 'AdvancedNumericalReferenceCandidateManifest',
      entrypoint: 'worker.py',
      analysisFamilies: ['linear-algebra', 'monte-carlo', 'optimization'],
    },
    snapshot: {
      merkleHash: H('1'),
      manifestHash: H('2'),
    },
  };
}

test('missing or forged numerical qualification registry stays fail-closed', (t) => {
  const value = fixture(t);
  const unconfigured = inspectAdvancedNumericalReferenceCandidateQualifications({
    candidateRoot: value.root,
    candidateManifest: value.manifest,
    candidateSnapshot: value.snapshot,
    entrypointHash: hashBytes(value.entrypoint),
  });
  assert.equal(unconfigured.every((candidate) => (
    candidate.productionQualified === false
    && candidate.status === 'reference_candidate_unqualified'
  )), true);

  const registryPath = path.join(value.root, 'registry.json');
  fs.writeFileSync(registryPath, JSON.stringify({
    version: 1,
    kind: 'AdvancedNumericalReferenceCandidateQualificationRegistry',
    entries: value.manifest.analysisFamilies.map((analysisFamily) => ({
      analysisFamily,
      runtimeConfigurationPath: `${analysisFamily}.json`,
      runtimeConfigurationHash: H('3'),
      productionQualified: true,
    })),
  }));
  const forged = inspectAdvancedNumericalReferenceCandidateQualifications({
    candidateRoot: value.root,
    candidateManifest: value.manifest,
    candidateSnapshot: value.snapshot,
    entrypointHash: hashBytes(value.entrypoint),
    registryPath,
    runtimeComposer() {
      throw new Error('forged registry must fail before runtime composition');
    },
  });
  assert.equal(forged.every((candidate) => candidate.productionQualified === false), true);
  assert.equal(forged.every((candidate) => (
    candidate.qualificationBlockers.includes(
      'advanced_numerical_reference_qualification_registry_entry_invalid',
    )
  )), true);
});

test('registry integration promotes only identity-matched externally verified runtimes', (t) => {
  const value = fixture(t);
  const entrypointHash = hashBytes(value.entrypoint);
  const registryPath = path.join(value.root, 'registry.json');
  const configurations = value.manifest.analysisFamilies.map((analysisFamily) => {
    const configurationPath = path.join(value.root, `${analysisFamily}.json`);
    const configuration = {
      version: 1,
      kind: 'AdvancedNumericalPluginRuntimeConfiguration',
      signedBundlePath: `${analysisFamily}.bundle.json`,
      trustStorePath: `${analysisFamily}.trust.json`,
      qualificationPath: `${analysisFamily}.qualification.json`,
      qualificationTrustStorePath: `${analysisFamily}.qualification-trust.json`,
      pluginRoot: '.',
      outputRoot: 'output',
    };
    fs.writeFileSync(configurationPath, JSON.stringify(configuration));
    for (const suffix of [
      'bundle.json',
      'trust.json',
      'qualification.json',
      'qualification-trust.json',
    ]) {
      fs.writeFileSync(
        path.join(value.root, `${analysisFamily}.${suffix}`),
        JSON.stringify({
          version: 1,
          kind: 'Fixture',
          fixtureAnalysisFamily: analysisFamily,
        }),
      );
    }
    return {
      analysisFamily,
      runtimeConfigurationPath: path.basename(configurationPath),
      runtimeConfigurationHash: hashBytes(fs.readFileSync(configurationPath)),
    };
  });
  fs.mkdirSync(path.join(value.root, 'output'));
  fs.writeFileSync(registryPath, JSON.stringify({
    version: 1,
    kind: 'AdvancedNumericalReferenceCandidateQualificationRegistry',
    entries: configurations,
  }));
  const qualified = inspectAdvancedNumericalReferenceCandidateQualifications({
    candidateRoot: value.root,
    candidateManifest: value.manifest,
    candidateSnapshot: value.snapshot,
    entrypointHash,
    registryPath,
    runtimeComposer({ bundle, pluginRoot }) {
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
            productionQualified: path.resolve(pluginRoot) === path.resolve(value.root),
            qualificationStatementHash: H('7'),
          }),
        },
      };
    },
  });
  assert.equal(qualified.every((candidate) => (
    candidate.productionQualified === true
    && candidate.status === 'reference_candidate_production_qualified'
    && candidate.qualificationBlockers.length === 0
  )), true);
});
