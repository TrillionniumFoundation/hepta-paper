#!/usr/bin/env node
import { immutableLegacyMatrixReferenceStatus } from '../../migration/legacy-matrix-reference.mjs';

process.stdout.write(`${JSON.stringify(immutableLegacyMatrixReferenceStatus(), null, 2)}\n`);
