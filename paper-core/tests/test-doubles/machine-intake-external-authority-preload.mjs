import fs from 'node:fs';
import { registerHooks } from 'node:module';

import {
  installAutonomousResearchMachineIntakeExternalAuthorityTestDouble,
} from './autonomous-research-machine-intake-authority-rotation-authorization.mjs';

const authorityStateModule = new URL(
  '../../../paper-adapters/automation/autonomous-research-machine-intake-authority.mjs',
  import.meta.url,
);
const authorizationModule = new URL(
  '../../../paper-adapters/automation/autonomous-research-machine-intake-authority-rotation-authorization.mjs',
  import.meta.url,
);
const authorizationDouble = new URL(
  './autonomous-research-machine-intake-authority-rotation-authorization.mjs',
  import.meta.url,
);

registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    if (context.parentURL === authorityStateModule.href
      && resolved.url === authorizationModule.href) {
      return { shortCircuit: true, url: authorizationDouble.href };
    }
    return resolved;
  },
});

const fixturePath = process.env.HEPTA_TEST_MACHINE_INTAKE_EXTERNAL_AUTHORITY;
if (!fixturePath) throw new Error('external authority fixture path required');
const documents = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
installAutonomousResearchMachineIntakeExternalAuthorityTestDouble(() => documents);
