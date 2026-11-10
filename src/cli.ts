#!/usr/bin/env node
import { run } from './run.ts';
import { getProcessIo } from './terminal/io.ts';

process.exitCode = await run(process.argv.slice(2), getProcessIo());
