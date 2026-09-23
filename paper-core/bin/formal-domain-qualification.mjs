#!/usr/bin/env node
import {
  runConfiguredFormalDomainQualification,
} from '../../paper-composition/automation/formal-domain-qualification-composition.mjs';

async function main() {
  if (process.argv.slice(2).includes('--help')) {
    process.stdout.write([
      'Usage: node paper-core/bin/formal-domain-qualification.mjs',
      '',
      'Discovers the configured production Mathlib execution authority, executes every',
      'required formal-domain diagnostic through kernel verification and fresh replay,',
      'then writes the verified aggregate coverage receipt to stdout.',
      '',
      'The command has no authority override and fails before worker execution when the',
      'configured closure, sandbox, toolchain, or external authority is absent or drifts.',
    ].join('\n').concat('\n'));
    return;
  }
  if (process.argv.length !== 2) {
    throw new Error('formal_domain_qualification_arguments_not_supported');
  }
  const receipt = await runConfiguredFormalDomainQualification({
    environment: process.env,
  });
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${String(error?.stack || error)}\n`);
  process.exitCode = 1;
});
