#!/usr/bin/env node
import { defaultPaperAssetRoot, defaultPaperRuntimeRoot } from '../src/workspace-layout.mjs';
import { runRealPaperPilot } from '../../paper-application/pilots/real-paper-pilot.mjs';

const paperArg = process.argv.indexOf('--paper');
const paperId = paperArg >= 0 ? process.argv[paperArg + 1] : null;
const receipt = await runRealPaperPilot({ root: defaultPaperAssetRoot(), runtimeRoot: defaultPaperRuntimeRoot(), paperId });
process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
