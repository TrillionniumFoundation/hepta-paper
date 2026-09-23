#!/usr/bin/env node
import {
  inspectExternalResearchQualificationPublicDeploymentIdentity,
  inspectResearchExecutionReleaseAttestorPublicDeploymentIdentity,
  inspectRuntimeImageReproducibilityPublicDeploymentIdentity,
} from '../../paper-adapters/automation/autonomous-research-public-deployment-identity-readers.mjs';
import {
  inspectAutonomousResearchResidentDeploymentIdentity,
} from '../../paper-composition/automation/autonomous-research-resident-deployment-identity.mjs';
import { parseStrictCliArguments } from '../src/strict-cli-arguments.mjs';

const arguments_ = parseStrictCliArguments(process.argv.slice(2), {
  booleanFlags: ['help'],
  valueFlags: [
    'external-qualification-config',
    'release-attestor-config',
    'runtime-reproducibility-config',
  ],
});

function usage() {
  return Object.freeze({
    command: 'inspect-autonomous-research-public-deployment-identity',
    classification: 'experimental-passive-not-admission',
    flags: Object.freeze({
      '--external-qualification-config': 'public process configuration path',
      '--release-attestor-config': 'public release-attestor configuration path',
      '--runtime-reproducibility-config': 'public reproducibility configuration path',
    }),
    guarantees: Object.freeze([
      'never reads environment values',
      'never opens credential roots or private keys',
      'never performs an external action',
      'never changes canonical resident admission',
    ]),
  });
}

if (arguments_.help) {
  process.stdout.write(`${JSON.stringify(usage(), null, 2)}\n`);
} else {
  const components = Object.freeze([
    inspectExternalResearchQualificationPublicDeploymentIdentity({
      configPath: arguments_['external-qualification-config'] || null,
    }),
    inspectRuntimeImageReproducibilityPublicDeploymentIdentity({
      configPath: arguments_['runtime-reproducibility-config'] || null,
    }),
    inspectResearchExecutionReleaseAttestorPublicDeploymentIdentity({
      configPath: arguments_['release-attestor-config'] || null,
    }),
  ]);
  const inspection = inspectAutonomousResearchResidentDeploymentIdentity({ components });
  const report = Object.freeze({
    version: 1,
    kind: 'AutonomousResearchExperimentalPublicDeploymentIdentityReport',
    classification: 'experimental-passive-not-admission',
    canonicalAdmissionAffected: false,
    inspection,
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
