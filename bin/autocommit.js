#!/usr/bin/env node
import { runCli } from "../src/cli.js";

runCli(process.argv.slice(2)).catch((error) => {
  console.error(`[autocommit] ${error?.message ?? error}`);
  process.exit(1);
});
