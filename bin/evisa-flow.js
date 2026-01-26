#!/usr/bin/env node
import { runCli } from "../dist/cli.js";

runCli().catch((error) => {
  console.error(error);
  process.exit(1);
});
