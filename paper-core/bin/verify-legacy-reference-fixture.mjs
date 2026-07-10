#!/usr/bin/env node
import { verifyLegacyDifferentialReference } from '../../migration/legacy-reference-fixture.mjs';

const verification = verifyLegacyDifferentialReference();
process.stdout.write(`${JSON.stringify(verification, null, 2)}\n`);
if (verification.status !== 'legacy_differential_reference_verified') process.exitCode = 1;
