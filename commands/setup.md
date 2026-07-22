---
description: One-time (or post-update) setup for the TTSG İlan plugin — installs the MCP server's dependencies and the Chromium browser it uses. Run this after installing or updating the plugin if TTSG tools report they aren't set up.
disable-model-invocation: true
allowed-tools: Bash
---

# TTSG İlan — setup

Provision the TTSG İlan MCP server on this machine by running its provisioning
script with the **Bash tool**.

Run this command:

```
node "$CLAUDE_PLUGIN_ROOT/scripts/provision.mjs"
```

If `$CLAUDE_PLUGIN_ROOT` is not set in the shell, locate the installed `ttsg-ilan`
plugin directory (under the Claude Code plugins cache, e.g. a path containing
`plugins/.../ttsg-ilan/`) and run `scripts/provision.mjs` from there with `node`.

This installs runtime dependencies and downloads a Chromium browser (~150 MB), so
it may take a minute or two. It is safe to re-run.

When it finishes it prints `✅ Provisioned ttsg-ilan`. Tell the user to **restart
Claude** once, after which the TTSG tools (`ttsg_login`, `ttsg_search`,
`ttsg_get_ilan`, `ttsg_offices`) become available. The first search will open a
browser window for them to log in to e-Devlet themselves.
