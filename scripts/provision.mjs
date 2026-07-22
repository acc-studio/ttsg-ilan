#!/usr/bin/env node
/**
 * Per-machine provisioning for ttsg-ilan.
 *
 * The plugin cache (${CLAUDE_PLUGIN_ROOT}) is read-only, so we copy the compiled
 * server into a writable per-user home (~/.claude/ttsg-ilan/server), install its
 * runtime dependencies there, and download Chromium for Playwright.
 *
 * Idempotent and version-aware: re-running after a plugin update refreshes the
 * server. Runs automatically (detached) via the SessionStart hook, or manually
 * via the /ttsg-ilan:setup command.
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TTSG_HOME = path.join(os.homedir(), ".claude", "ttsg-ilan");
const serverDir = path.join(TTSG_HOME, "server");
const lockFile = path.join(TTSG_HOME, ".provisioning");
const guardFile = path.join(TTSG_HOME, ".provisioned");
const logFile = path.join(TTSG_HOME, "provision.log");

fs.mkdirSync(TTSG_HOME, { recursive: true });

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  fs.appendFileSync(logFile, line);
  process.stdout.write(line);
}

function pluginVersion() {
  try {
    const p = JSON.parse(fs.readFileSync(path.join(pluginRoot, ".claude-plugin", "plugin.json"), "utf8"));
    return String(p.version ?? "0");
  } catch {
    return "0";
  }
}

function run(cmd, args, cwd, label) {
  log(`▶ ${label}: ${cmd} ${args.join(" ")}`);
  const res = spawnSync(cmd, args, { cwd, stdio: "inherit", shell: true });
  if (res.status !== 0) throw new Error(`${label} failed (exit ${res.status})`);
}

function main() {
  // Guard against concurrent runs (the hook may fire on several startups).
  if (fs.existsSync(lockFile)) {
    const age = Date.now() - fs.statSync(lockFile).mtimeMs;
    if (age < 15 * 60 * 1000) {
      log("Another provisioning run is in progress; exiting.");
      return;
    }
    log("Stale lock found; continuing.");
  }
  fs.writeFileSync(lockFile, String(process.pid));

  try {
    const version = pluginVersion();
    log(`Provisioning ttsg-ilan v${version} into ${serverDir}`);

    const srcMcp = path.join(pluginRoot, "mcp");
    if (!fs.existsSync(path.join(srcMcp, "dist", "index.js"))) {
      throw new Error(`Compiled server missing at ${srcMcp}/dist (dist is committed to the repo).`);
    }

    fs.mkdirSync(serverDir, { recursive: true });
    fs.cpSync(path.join(srcMcp, "dist"), path.join(serverDir, "dist"), { recursive: true });
    fs.copyFileSync(path.join(srcMcp, "package.json"), path.join(serverDir, "package.json"));
    const lock = path.join(srcMcp, "package-lock.json");
    if (fs.existsSync(lock)) fs.copyFileSync(lock, path.join(serverDir, "package-lock.json"));

    const hasLock = fs.existsSync(path.join(serverDir, "package-lock.json"));
    run("npm", hasLock ? ["ci", "--omit=dev"] : ["install", "--omit=dev"], serverDir, "Installing runtime deps");
    run("npx", ["--yes", "playwright", "install", "chromium"], serverDir, "Installing Chromium");

    fs.writeFileSync(guardFile, JSON.stringify({ version, at: new Date().toISOString() }));
    log(`✅ Provisioned ttsg-ilan v${version}. Restart Claude to use it.`);
  } finally {
    try {
      fs.unlinkSync(lockFile);
    } catch {}
  }
}

try {
  main();
} catch (err) {
  log(`❌ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
