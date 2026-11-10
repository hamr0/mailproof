#!/usr/bin/env node
// mailproof: the command line (SPEC B11). A thin entry: everything is in src/cli/.
import { main } from '../src/cli/main.js';

process.exitCode = await main(process);
