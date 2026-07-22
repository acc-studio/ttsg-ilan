# TTSG İlan — Claude Code plugin

Search and summarize **Türkiye Ticaret Sicili Gazetesi** (Turkish Trade Registry
Gazette) announcements by company name + registry office, then fetch and
summarize individual ilans — all from Claude.

---

## Install


In Claude Code, run these three commands:

```
/plugin marketplace add acc-studio/ttsg-ilan
```
```
/plugin install ttsg-ilan@anka-law
```

Then **restart Claude once**. On first launch the plugin sets itself up in the
background (installs its dependencies and a browser, ~1–2 minutes, one time). If
TTSG tools say they aren't ready yet, wait a minute and restart — or run:

```
/ttsg-ilan:setup
```

That's it. To use it, just ask — e.g. *"Ant Systems'in Gebze'deki ilanlarını
getir"*. The **first search opens a browser window for you to log in to TTSG
yourself** (the plugin never types your credentials or solves the CAPTCHA). Your
login is saved, so you rarely repeat it.

### Getting updates

```
/plugin marketplace update anka-law
```
```
/plugin update ttsg-ilan@anka-law
```
After an update, restart Claude once (it re-provisions automatically).

---

## What you can do

- **List a company's ilans**: give a company name + registry office (e.g. Gebze,
  İstanbul). The office is required — TTSG can't search by name alone.
- **Fetch & summarize** any ilan: kimlik, ilan künyesi, ne değişti, and a plain
  Turkish summary with points that matter to a lawyer.

Tools: `ttsg_login`, `ttsg_offices`, `ttsg_search`, `ttsg_get_ilan`. The `ilan`
skill wraps them into the search → list → fetch → summarize workflow.

---

## How it works (for maintainers)

`ticaretsicil.gov.tr` has no public API and locks İlan Görüntüleme behind an
e-Devlet / member login (CAPTCHA at login and on the public unvan search). The
**logged-in** ilan search has no CAPTCHA — it rides the session cookie. So the
plugin runs an MCP server that drives a **persistent Playwright browser profile**:
the user logs in once, the session is saved, and subsequent searches just work.

Because the plugin cache dir is read-only, the runnable server + its
`node_modules` are provisioned into `~/.claude/ttsg-ilan/server` on each machine
(see `scripts/provision.mjs`, run automatically by the `SessionStart` hook or via
`/ttsg-ilan:setup`). `launcher.mjs` (built-ins only) is the MCP entry point and
hands off to that provisioned server.

Session + downloaded PDFs live under `~/.claude/ttsg-ilan/data/`.

### Building from source

The compiled server (`mcp/dist/`) is **committed** so end users need no build
step. If you change `mcp/src/`, rebuild and commit `dist/`:

```bash
cd mcp
npm install
npm run build      # tsc -> dist/
npx tsc --noEmit   # type check
```

### Layout

```
.claude-plugin/
  plugin.json          # plugin manifest
  marketplace.json     # marketplace manifest (this repo is its own marketplace)
.mcp.json              # MCP server = node launcher.mjs
launcher.mjs           # MCP entry point (no deps)
commands/setup.md      # /ttsg-ilan:setup
hooks/hooks.json       # SessionStart auto-provision
scripts/
  provision.mjs        # copy server -> ~/.claude/ttsg-ilan/server, install deps + Chromium
  check.mjs            # SessionStart check + background provision
mcp/
  src/ …               # TypeScript source
  dist/ …              # committed compiled server
skills/ilan/SKILL.md   # search → summarize workflow
```

## Notes / limits

- The **registry office is mandatory** — TTSG cannot search by company name alone.
- Zero-login automation is impossible against this site; a periodic manual
  re-login is the only recurring step.
- Node.js is required, but it's already present (Claude Code needs it).
- Automating a `.gov.tr` portal via a captured session is a ToS gray area — use
  responsibly.
