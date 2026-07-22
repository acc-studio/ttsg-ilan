#!/usr/bin/env node
/**
 * SessionStart hook: ensure ttsg-ilan is provisioned for this machine/version.
 *
 * Fast and side-effect-light — it never downloads anything itself. If the server
 * isn't provisioned (fresh install) or the plugin version changed (update), it
 * launches provision.mjs detached and prints a one-line notice. Otherwise silent.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TTSG_HOME = path.join(os.homedir(), ".claude", "ttsg-ilan");
const guardFile = path.join(TTSG_HOME, ".provisioned");
const lockFile = path.join(TTSG_HOME, ".provisioning");
const provision = path.join(pluginRoot, "scripts", "provision.mjs");

function pluginVersion() {
  try {
    const p = JSON.parse(fs.readFileSync(path.join(pluginRoot, ".claude-plugin", "plugin.json"), "utf8"));
    return String(p.version ?? "0");
  } catch {
    return "0";
  }
}

function provisioned() {
  try {
    const g = JSON.parse(fs.readFileSync(guardFile, "utf8"));
    return g.version === pluginVersion();
  } catch {
    return false;
  }
}

function inProgress() {
  try {
    return Date.now() - fs.statSync(lockFile).mtimeMs < 15 * 60 * 1000;
  } catch {
    return false;
  }
}

if (provisioned()) {
  process.exit(0);
}

if (inProgress()) {
  process.stdout.write("⏳ ttsg-ilan setup is still running in the background. Restart Claude shortly to use TTSG tools.\n");
  process.exit(0);
}

const child = spawn(process.execPath, [provision], { detached: true, stdio: "ignore" });
child.unref();
process.stdout.write(
  "⏳ ttsg-ilan is finishing a one-time setup in the background (~1–2 min: dependencies + a browser). " +
    "Restart Claude when it's done to use TTSG tools. You can also run /ttsg-ilan:setup.\n"
);
process.exit(0);
