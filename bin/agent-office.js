#!/usr/bin/env node

import { AdapterError } from "../src/errors.js";
import { runCli } from "../src/cli.js";

try {
  const exitCode = await runCli(process.argv.slice(2));
  process.exitCode = exitCode;
} catch (error) {
  console.error(`Error: ${error.message}`);
  if (error instanceof AdapterError && error.details?.stderr) {
    console.error(error.details.stderr);
  }
  process.exitCode = 1;
}
