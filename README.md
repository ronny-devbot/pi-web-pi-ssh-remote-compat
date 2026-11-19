# pi-web-pi-ssh-remote-compat

Compatibility layer between **pi-web** and **@99percentpeople/pi-ssh-remote**: keeps
SSH (remote-work) sessions locked down from local file access.

## Layout

- `tool-shadow-guard/` — the core fix. A small Node preload (wired via
  `~/.profile` `NODE_OPTIONS`) that stops pi-web's local `edit` wrapper from
  shadowing ssh-remote's remote `edit`. Fails closed: if it cannot be applied
  (pi-web drift), the daemon refuses to start. See its README for bug, design,
  self-test and rollback.
- `lockdown-checker/` — `check-lockdown.mjs`, a read-only audit of the whole
  lockdown using the settings current on execution (guard wiring, pi-web config,
  agent settings, packages, MCP). Exit 0/1/2 = clean / problems / warnings.
  `known-packages.json` holds per-package verdicts; unlisted packages are flagged
  unreviewed. See its README.
- `pi-ssh-remote-inherit/` — the glue. Mirrors `pi-ssh-remote`'s session state into
  pi-web's inheritable session state so sessions spawned from a connected session inherit
  the remote (children of local sessions stay local). Must be listed BEFORE
  `@99percentpeople/pi-ssh-remote` in `packages` to win the `session_start` race, and it
  reports loudly (fail-closed) when a seeded remote session ends up local.

## Status

**This is the live deployment.** The clone at `~/.pi-web-pi-ssh-remote-compat` is used
directly — nothing is installed elsewhere:

- `tool-shadow-guard/index.mjs` — preloaded via the `NODE_OPTIONS` line in `~/.profile`
  (the pi-web services start through a login shell)
- `pi-ssh-remote-inherit/` — referenced by local path in `~/.pi/agent/settings.json`
  `packages` (before `pi-ssh-remote`)
- `lockdown-checker/check-lockdown.mjs` — run from its folder; keep `known-packages.json`
  current as packages come and go

Updates: `git pull` in the deployment clone. The guard takes effect at the next
`pi-web-sessiond` restart; the glue at the next pi process start.

Layout principle: **each top-level folder is a self-contained mini-repo** — own README,
own `.gitignore` where the component produces local artifacts (the checker produces none),
so any folder can be copied or cloned on its own. The root deliberately has no
`.gitignore` (nothing lives at the root except this README).
