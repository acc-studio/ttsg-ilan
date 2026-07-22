#!/usr/bin/env node
/**
 * MCP launcher for ttsg-ilan.
 *
 * The plugin cache dir (${CLAUDE_PLUGIN_ROOT}) is read-only, so the runnable
 * server + its node_modules are provisioned into a writable per-user home
 * (~/.claude/ttsg-ilan/server) by scripts/provision.mjs. This launcher — which
 * uses only Node built-ins and therefore always starts — hands off to that
 * provisioned server, or exits with a clear message if setup hasn't run yet.
 */

import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const TTSG_HOME = path.join(os.homedir(), ".claude", "ttsg-ilan");
const SERVER_ENTRY = path.join(TTSG_HOME, "server", "dist", "index.js");

if (!fs.existsSync(SERVER_ENTRY)) {
  process.stderr.write(
    "[ttsg-ilan] Not set up yet. Run the one-time setup:  /ttsg-ilan:setup\n" +
      "(A background setup may already be running — restart Claude in a minute.)\n"
  );
  process.exit(1);
}

// Ensure the provisioned server writes session/PDF data to the same home.
process.env.TTSG_DATA_DIR = process.env.TTSG_DATA_DIR || path.join(TTSG_HOME, "data");

// Importing the server module starts it (it connects stdio transport on load).
await import(pathToFileURL(SERVER_ENTRY).href);
